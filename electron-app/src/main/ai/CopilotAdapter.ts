import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import type { ICLIAdapter, AIProvider, AIModel, ParsedOutput } from './types';
import { getScopedSpawnEnv, getSpawnEnv, resolveInShell } from '../utils/shell-env';
import { execFilePortable } from '../utils/spawn-portable';

type CopilotBackend = 'copilot-cli' | 'gh-models';

interface ResolvedBackend {
  backend: CopilotBackend;
  binaryPath: string;
}

interface CachedCatalog {
  models: AIModel[];
  backend: CopilotBackend | 'fallback';
  fetchedAt: number;
}

const ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-9;]*[ -/]*[@-~])/g;
const PROBE_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * GitHub Copilot adapter.
 *
 * Enterprise-safe order of operations:
 * 1. Use the supported `copilot` CLI when it is installed/authenticated.
 * 2. Fall back to the public `gh models run` extension.
 * 3. Never call Copilot private/internal HTTP token endpoints.
 *
 * Catalog (model list) discipline:
 * - listAvailableModels() is cache-only and never probes child processes.
 * - refreshModels() is the only path that shells out to enumerate models.
 *   It is invoked exclusively by user action via the Settings "Refresh models"
 *   button (see AIManager / IPC).
 */
export class CopilotAdapter implements ICLIAdapter {
  name: AIProvider = 'copilot';
  private cachedCatalog: CachedCatalog | null = null;

  async isInstalled(): Promise<boolean> {
    return (await this.resolveBackend(false)) !== null;
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.resolveBackend(true)) !== null;
  }

  async getVersion(): Promise<string | null> {
    const resolved = await this.resolveBackend(false);
    if (!resolved) return null;

    try {
      const { stdout } = await execFilePortable(resolved.binaryPath, ['--version'], {
        timeout: PROBE_TIMEOUT_MS,
        env: getScopedSpawnEnv('copilot'),
      });
      const match = stdout.match(/(\d+\.\d+\.\d+)/);
      return match ? `${resolved.backend} ${match[1]}` : resolved.backend;
    } catch {
      return resolved.backend;
    }
  }

  async getBinaryPath(): Promise<string | null> {
    const authenticated = await this.resolveBackend(true);
    if (authenticated) return authenticated.binaryPath;

    const installed = await this.resolveBackend(false);
    return installed?.binaryPath ?? null;
  }

  /**
   * Cache-only catalog read. Returns the last refreshed list, or the
   * conservative fallback if no refresh has occurred. Does not spawn.
   */
  async listAvailableModels(): Promise<AIModel[]> {
    if (this.cachedCatalog) return this.cachedCatalog.models;
    const fallback = this.getConservativeFallback();
    this.cachedCatalog = {
      models: fallback,
      backend: 'fallback',
      fetchedAt: Date.now(),
    };
    return fallback;
  }

  /**
   * Probe the active backend for the user's actual model catalog.
   * @param opts.force - bypass TTL and always probe.
   */
  async refreshModels(opts: { force?: boolean } = {}): Promise<AIModel[]> {
    const force = opts.force === true;
    if (
      !force &&
      this.cachedCatalog &&
      this.cachedCatalog.backend !== 'fallback' &&
      Date.now() - this.cachedCatalog.fetchedAt < CACHE_TTL_MS
    ) {
      return this.cachedCatalog.models;
    }

    const resolved = await this.resolveBackend(true);
    if (!resolved) {
      const fallback = this.getConservativeFallback();
      this.cachedCatalog = {
        models: fallback,
        backend: 'fallback',
        fetchedAt: Date.now(),
      };
      return fallback;
    }

    let models: AIModel[] = [];
    try {
      if (resolved.backend === 'copilot-cli') {
        models = await this.fetchCopilotCliModels(resolved.binaryPath);
      } else {
        models = await this.fetchGhModelsList(resolved.binaryPath);
      }
    } catch {
      models = [];
    }

    if (models.length === 0) {
      const fallback = this.getConservativeFallback();
      this.cachedCatalog = {
        models: fallback,
        backend: 'fallback',
        fetchedAt: Date.now(),
      };
      return fallback;
    }

    this.cachedCatalog = {
      models,
      backend: resolved.backend,
      fetchedAt: Date.now(),
    };
    return models;
  }

  clearModelCache(): void {
    this.cachedCatalog = null;
  }

  /** Conservative fallback used when no probe has run, or a probe failed. */
  private getConservativeFallback(): AIModel[] {
    return [
      {
        id: 'openai/gpt-4.1',
        label: 'GPT-4.1',
        provider: 'copilot',
        source: 'fallback',
        billing: 'paid',
        description: 'GitHub Copilot / GitHub Models',
        runIds: { copilotCli: 'gpt-4.1', ghModels: 'openai/gpt-4.1' },
      },
      {
        id: 'openai/gpt-4o-mini',
        label: 'GPT-4o Mini',
        provider: 'copilot',
        source: 'fallback',
        billing: 'free',
        description: 'Fast GitHub Copilot / GitHub Models option',
        runIds: { copilotCli: '4o-mini', ghModels: 'openai/gpt-4o-mini' },
      },
    ];
  }

  /** Build args against a generic gh-models invocation (used outside a resolved backend). */
  buildArgs(prompt: string, _continueSession: boolean, model?: AIModel | string): string[] {
    return ['models', 'run', this.runIdForGhModels(model), prompt];
  }

  buildArgsForBinary(
    binaryPath: string,
    prompt: string,
    continueSession: boolean,
    model?: AIModel | string,
  ): string[] {
    if (this.looksLikeCopilotBinary(binaryPath)) {
      // -s: silent mode — captured stdout is assistant text only.
      // --continue: resume the most recent Copilot session for multi-turn chat.
      const args = ['-s', '--prompt', prompt];
      if (continueSession) args.push('--continue');
      const runId = this.runIdForCopilotCli(model);
      if (runId) args.push('--model', runId);
      return args;
    }
    // gh models run is genuinely stateless — no continuation flag exists.
    return this.buildArgs(prompt, false, model);
  }

  parseOutput(data: string): ParsedOutput {
    const stripped = data.replace(ANSI_RE, '');
    const trimmed = stripped.trim();
    if (!trimmed) return { type: 'text', content: '' };
    if (trimmed.startsWith('Error') || trimmed.startsWith('error:')) {
      return { type: 'error', content: trimmed };
    }
    return { type: 'text', content: stripped };
  }

  // ─── Catalog probes ───────────────────────────────────────────────────────

  private async fetchCopilotCliModels(binaryPath: string): Promise<AIModel[]> {
    const helpText = await this.runProbe(binaryPath, ['help']);
    if (!helpText) return [];
    return this.parseCopilotHelpModels(helpText);
  }

  /**
   * Parse the model list from `copilot help` output.
   *
   * GitHub's docs say the supported `--model` values are listed in the help
   * text. The format we look for is the option block:
   *
   *   --model <model>
   *       Specify the AI model to use. Available: claude-haiku-4.5,
   *       claude-sonnet-4.5, gpt-5, gpt-5-mini, ...
   *
   * The exact phrasing has varied across releases, so we match a few common
   * patterns and de-duplicate. If we can't find anything that looks like a
   * model list, return [] so the caller falls back to the conservative list.
   */
  parseCopilotHelpModels(helpText: string): AIModel[] {
    const ids = new Set<string>();

    // Pattern 1: "Available:" or "Supported:" or "Choices:" prefix followed by a comma list.
    const phraseRe = /(?:available|supported|choices?|options?)[:\s]+([a-z0-9][\w.,\s/-]*)/gi;
    let m: RegExpExecArray | null;
    while ((m = phraseRe.exec(helpText)) !== null) {
      const list = m[1];
      list.split(/[,\n]/).forEach((tok) => {
        const id = tok.trim();
        if (this.looksLikeCopilotModelId(id)) ids.add(id);
      });
    }

    // Pattern 2: lines that look like "  - <id>" or "  * <id>" inside a --model section.
    const sectionMatch = helpText.match(/--model[\s\S]{0,2000}/i);
    if (sectionMatch) {
      const section = sectionMatch[0];
      const bulletRe = /^\s*[-*]\s+([\w.\/-]+)/gm;
      while ((m = bulletRe.exec(section)) !== null) {
        const id = m[1].trim();
        if (this.looksLikeCopilotModelId(id)) ids.add(id);
      }
    }

    if (ids.size === 0) return [];

    return Array.from(ids).map((id) => this.copilotCliModel(id));
  }

  private looksLikeCopilotModelId(id: string): boolean {
    if (!id) return false;
    if (id.length < 3 || id.length > 80) return false;
    // Reasonable chars for a model id: letters, digits, dot, dash, slash, underscore.
    if (!/^[a-z0-9][a-z0-9._/-]+$/i.test(id)) return false;
    // Reject common false-positive words.
    const stopwords = new Set([
      'help', 'available', 'options', 'flag', 'flags', 'usage', 'example',
      'true', 'false', 'string', 'boolean', 'default', 'none',
    ]);
    if (stopwords.has(id.toLowerCase())) return false;
    return true;
  }

  private copilotCliModel(runId: string): AIModel {
    const label = this.prettifyId(runId);
    return {
      id: runId,
      label,
      provider: 'copilot',
      source: 'cli',
      billing: 'unknown',
      description: 'GitHub Copilot CLI',
      runIds: { copilotCli: runId },
    };
  }

  private async fetchGhModelsList(binaryPath: string): Promise<AIModel[]> {
    // Detect whether `gh models list` supports --json. Docs only show --json
    // for `gh models eval`, so the most reliable test is parsing the help.
    let supportsJson = false;
    const helpOut = await this.runProbe(binaryPath, ['models', 'list', '--help']);
    if (helpOut && /--json/i.test(helpOut)) supportsJson = true;

    if (supportsJson) {
      const jsonOut = await this.runProbe(binaryPath, ['models', 'list', '--json']);
      if (jsonOut) {
        const parsed = this.parseGhModelsJson(jsonOut);
        if (parsed.length > 0) return parsed;
      }
    }

    const tableOut = await this.runProbe(binaryPath, ['models', 'list']);
    if (!tableOut) return [];
    return this.parseGhModelsTable(tableOut);
  }

  parseGhModelsJson(jsonText: string): AIModel[] {
    try {
      const parsed = JSON.parse(jsonText);
      const arr: unknown[] = Array.isArray(parsed) ? parsed : [];
      const out: AIModel[] = [];
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const obj = item as Record<string, unknown>;
        const id = (obj.id || obj.name || obj.fullName) as string | undefined;
        if (!id || typeof id !== 'string') continue;
        const friendly = (obj.friendly_name || obj.friendlyName || obj.displayName) as string | undefined;
        out.push(this.ghModel(id, typeof friendly === 'string' ? friendly : undefined));
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Parse `gh models list` table output. The table has at least DISPLAY NAME
   * and ID columns; column count and ordering have varied. Strategy:
   * - find a header line containing "ID" or "NAME"
   * - take any token on subsequent lines that looks like provider/model
   *   (contains exactly one '/'); that's the model id
   * - the rest of the line (excluding the id) becomes the friendly label
   *
   * This is intentionally permissive about whitespace because display names
   * like "GPT 4.1 mini" contain spaces and can't be column-split reliably.
   */
  parseGhModelsTable(tableText: string): AIModel[] {
    const lines = tableText.split(/\r?\n/);
    const out: AIModel[] = [];
    const seen = new Set<string>();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      // Skip headers / separators.
      if (/^(showing|displaying|name\s+id|display.*id|id\s+name|---)/i.test(line)) continue;
      const idMatch = line.match(/\b([a-z0-9][a-z0-9._-]+\/[a-z0-9][a-z0-9._-]+)\b/i);
      if (!idMatch) continue;
      const id = idMatch[1];
      if (seen.has(id)) continue;
      seen.add(id);
      // Friendly label: line minus the id, trimmed.
      const friendly = line.replace(idMatch[0], '').replace(/\s{2,}/g, ' ').trim() || undefined;
      out.push(this.ghModel(id, friendly));
    }
    return out;
  }

  private ghModel(id: string, friendly?: string): AIModel {
    return {
      id,
      label: friendly && friendly.length > 0 ? friendly : this.prettifyId(id),
      provider: 'copilot',
      source: 'cli',
      billing: 'unknown',
      description: 'GitHub Models',
      runIds: { ghModels: id },
    };
  }

  private prettifyId(id: string): string {
    // 'openai/gpt-4o-mini' -> 'GPT-4o-mini (openai)'
    // 'claude-haiku-4.5'   -> 'Claude Haiku 4.5'
    if (id.includes('/')) {
      const [vendor, name] = id.split('/');
      return `${name} (${vendor})`;
    }
    return id
      .split(/[-_]/)
      .map((p) => (p.length === 0 ? p : p[0].toUpperCase() + p.slice(1)))
      .join(' ');
  }

  private async runProbe(binaryPath: string, args: string[]): Promise<string | null> {
    try {
      const { stdout } = await execFilePortable(binaryPath, args, {
        timeout: PROBE_TIMEOUT_MS,
        env: getScopedSpawnEnv('copilot'),
        maxBuffer: 1024 * 1024,
      });
      return stdout;
    } catch {
      return null;
    }
  }

  // ─── ID resolution for buildArgs paths ────────────────────────────────────

  /**
   * Resolve the run-id passed to `copilot --model`.
   * Priority:
   *   1. AIModel.runIds.copilotCli (fresh from refresh)
   *   2. AIModel.id when it's not a slash-prefixed gh-models id
   *   3. Legacy string normalization (handles pre-1.7.3 saved settings)
   */
  private runIdForCopilotCli(model?: AIModel | string): string | null {
    if (!model) return null;
    if (typeof model === 'object') {
      if (model.runIds?.copilotCli) return model.runIds.copilotCli;
      if (model.id && !model.id.includes('/')) return model.id;
      // Fall back to slash-suffix.
      if (model.id.includes('/')) return model.id.split('/').pop() || null;
      return null;
    }
    return this.normalizeCopilotModelId(model);
  }

  /**
   * Resolve the run-id passed to `gh models run <id>`.
   * Always provider-prefixed.
   */
  private runIdForGhModels(model?: AIModel | string): string {
    if (!model) return 'openai/gpt-4o-mini';
    if (typeof model === 'object') {
      if (model.runIds?.ghModels) return model.runIds.ghModels;
      if (model.id && model.id.includes('/')) return model.id;
      return this.normalizeGhModelId(model.id);
    }
    return this.normalizeGhModelId(model);
  }

  /**
   * Legacy alias normalization. Kept for two reasons:
   *   1. Saved `ai_model` settings predating 1.7.3 use these short forms.
   *   2. AIChat allows the user to type a custom model id at the prompt; we
   *      try our best to map it to the right backend form.
   */
  private normalizeGhModelId(model: string): string {
    const aliases: Record<string, string> = {
      'gpt-4o': 'openai/gpt-4o',
      'gpt-4o-mini': 'openai/gpt-4o-mini',
      'gpt-4.1-mini': 'openai/gpt-4o-mini',
      'gpt-4.1': 'openai/gpt-4.1',
      'o3-mini': 'openai/o3-mini',
      'claude-3.5-sonnet': 'anthropic/claude-3.5-sonnet',
    };
    if (aliases[model]) return aliases[model];
    if (model.includes('/')) return model;
    return model || 'openai/gpt-4o-mini';
  }

  private normalizeCopilotModelId(model: string): string | null {
    if (!model) return null;
    if (model.includes('/')) {
      // 'openai/gpt-4o-mini' -> '4o-mini' for older copilot CLI builds.
      const trail = model.split('/').pop() || null;
      if (!trail) return null;
      return trail.replace(/^gpt-/i, '');
    }
    // Strip an optional 'gpt-' prefix only — leave 'claude-haiku-4.5' alone.
    if (/^gpt-\d/i.test(model)) return model.replace(/^gpt-/i, '');
    return model;
  }

  // ─── Backend resolution ───────────────────────────────────────────────────

  private async resolveBackend(requireAuthenticated: boolean): Promise<ResolvedBackend | null> {
    const copilot = await this.findCopilotBinary();
    if (copilot && (!requireAuthenticated || this.isCopilotCliAuthenticated())) {
      return { backend: 'copilot-cli', binaryPath: copilot };
    }

    const gh = await this.findGhBinary();
    if (gh && (await this.hasModelsExtension(gh)) && (!requireAuthenticated || (await this.isGhAuthenticated(gh)))) {
      return { backend: 'gh-models', binaryPath: gh };
    }

    if (!requireAuthenticated && copilot) {
      return { backend: 'copilot-cli', binaryPath: copilot };
    }
    return null;
  }

  private async findCopilotBinary(): Promise<string | null> {
    const resolved = await resolveInShell('copilot');
    if (resolved) return resolved;

    const npmPrefix = await this.npmGlobalPrefix();
    const candidates =
      process.platform === 'win32'
        ? [
            join(process.env.APPDATA || '', 'npm', 'copilot.cmd'),
            join(process.env.APPDATA || '', 'npm', 'copilot.exe'),
            join(process.env.APPDATA || '', 'npm', 'node_modules', '@github', 'copilot', 'bin', 'copilot.cmd'),
            join(process.env.LOCALAPPDATA || '', 'Programs', 'copilot', 'copilot.exe'),
            ...(npmPrefix
              ? [
                  join(npmPrefix, 'copilot.cmd'),
                  join(npmPrefix, 'copilot.exe'),
                  join(npmPrefix, 'node_modules', '@github', 'copilot', 'bin', 'copilot.cmd'),
                ]
              : []),
          ]
        : [
            '/opt/homebrew/bin/copilot',
            '/usr/local/bin/copilot',
            '/usr/bin/copilot',
            join(process.env.HOME || homedir(), '.local', 'bin', 'copilot'),
            join(process.env.HOME || homedir(), 'bin', 'copilot'),
            ...(npmPrefix ? [join(npmPrefix, 'bin', 'copilot')] : []),
          ];

    return candidates.find((candidate) => candidate && existsSync(candidate)) || null;
  }

  private async findGhBinary(): Promise<string | null> {
    const resolved = await resolveInShell('gh');
    if (resolved) return resolved;

    const candidates =
      process.platform === 'win32'
        ? [
            'C:\\Program Files\\GitHub CLI\\gh.exe',
            'C:\\Program Files (x86)\\GitHub CLI\\gh.exe',
            join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'gh.exe'),
          ]
        : [
            '/opt/homebrew/bin/gh',
            '/usr/local/bin/gh',
            '/usr/bin/gh',
            join(process.env.HOME || homedir(), '.local', 'bin', 'gh'),
          ];

    return candidates.find((candidate) => candidate && existsSync(candidate)) || null;
  }

  /** Cache npm's global prefix so we only shell out once per process. */
  private cachedNpmPrefix: string | null | undefined = undefined;
  private async npmGlobalPrefix(): Promise<string | null> {
    if (this.cachedNpmPrefix !== undefined) return this.cachedNpmPrefix;
    try {
      const { stdout } = await execFilePortable(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['prefix', '-g'],
        {
          timeout: 3000,
          env: getSpawnEnv(),
        },
      );
      this.cachedNpmPrefix = stdout.trim() || null;
    } catch {
      this.cachedNpmPrefix = null;
    }
    return this.cachedNpmPrefix;
  }

  private isCopilotCliAuthenticated(): boolean {
    const env = getSpawnEnv();
    if (env.COPILOT_GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN) return true;

    const copilotHome = env.COPILOT_HOME || join(homedir(), '.copilot');

    // Current @github/copilot builds (2026+) store auth in session-store.db.
    try {
      const dbPath = join(copilotHome, 'session-store.db');
      if (existsSync(dbPath) && statSync(dbPath).size > 1024) return true;
    } catch { /* ignore */ }

    // Older builds wrote loggedInUsers to config.json.
    try {
      const configPath = join(copilotHome, 'config.json');
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      const users = parsed.loggedInUsers ?? parsed.logged_in_users;
      if (Array.isArray(users) && users.length > 0) return true;
    } catch { /* ignore */ }

    return false;
  }

  private async isGhAuthenticated(binaryPath: string): Promise<boolean> {
    try {
      await execFilePortable(binaryPath, ['auth', 'status'], {
        timeout: PROBE_TIMEOUT_MS,
        env: getSpawnEnv(),
      });
      return true;
    } catch {
      return false;
    }
  }

  private async hasModelsExtension(binaryPath: string): Promise<boolean> {
    try {
      await execFilePortable(binaryPath, ['models', '--help'], {
        timeout: PROBE_TIMEOUT_MS,
        env: getSpawnEnv(),
      });
      return true;
    } catch {
      return false;
    }
  }

  private looksLikeCopilotBinary(binaryPath: string): boolean {
    const file = basename(binaryPath).toLowerCase();
    return file === 'copilot' || file === 'copilot.exe' || file === 'copilot.cmd';
  }
}
