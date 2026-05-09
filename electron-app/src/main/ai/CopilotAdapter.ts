import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import type { ICLIAdapter, AIProvider, AIModel, ParsedOutput } from './types';
import { getScopedSpawnEnv, getSpawnEnv, resolveInShell } from '../utils/shell-env';
import { execFilePortable } from '../utils/spawn-portable';
import { logCopilotProbe } from '../utils/copilot-probe-log';
import {
  getCuratedCopilotModels,
  mergeProbedIntoCurated,
  type ProbeResult,
} from './copilot-catalog';

type CopilotBackend = 'copilot-cli' | 'gh-models';

interface ResolvedBackend {
  backend: CopilotBackend;
  binaryPath: string;
}

interface CachedCatalog {
  models: AIModel[];
  /**
   * Backend whose probe produced these models. 'fallback' = no backend
   * resolved, 'curated' = built-in baseline (probe empty / failed). Both
   * are excluded from the TTL fast path so a fresh Refresh always probes.
   */
  backend: CopilotBackend | 'fallback' | 'curated';
  fetchedAt: number;
}

const ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-9;]*[ -/]*[@-~])/g;
const PROBE_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 10 * 60 * 1000;

const VENDOR_PREFIXES = [
  'gpt-',
  'claude-',
  'o3-',
  'o4-',
  'gemini-',
  'mistral-',
  'llama-',
  'phi-',
];

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
   * curated baseline if no refresh has occurred. Does not spawn.
   */
  async listAvailableModels(): Promise<AIModel[]> {
    if (this.cachedCatalog) return this.cachedCatalog.models;
    const curated = getCuratedCopilotModels();
    this.cachedCatalog = {
      models: curated,
      backend: 'curated',
      fetchedAt: Date.now(),
    };
    return curated;
  }

  /**
   * Probe the active backend for the user's actual model catalog.
   * @param opts.force - bypass TTL and always probe.
   *
   * TTL fast path applies only when we have *real probe data* — both
   * 'fallback' and 'curated' are excluded so the Refresh button always
   * triggers a fresh probe.
   */
  async refreshModels(opts: { force?: boolean } = {}): Promise<AIModel[]> {
    const force = opts.force === true;
    if (
      !force &&
      this.cachedCatalog &&
      this.cachedCatalog.backend !== 'fallback' &&
      this.cachedCatalog.backend !== 'curated' &&
      Date.now() - this.cachedCatalog.fetchedAt < CACHE_TTL_MS
    ) {
      return this.cachedCatalog.models;
    }

    const resolved = await this.resolveBackend(true);
    if (!resolved) {
      const curated = getCuratedCopilotModels();
      this.cachedCatalog = {
        models: curated,
        backend: 'fallback',
        fetchedAt: Date.now(),
      };
      return curated;
    }

    let probed: ProbeResult = { models: [], confidence: 'low' };
    try {
      if (resolved.backend === 'copilot-cli') {
        probed = await this.fetchCopilotCliModels(resolved.binaryPath);
      } else {
        probed = await this.fetchGhModelsList(resolved.binaryPath);
      }
    } catch {
      probed = { models: [], confidence: 'low' };
    }

    const curated = getCuratedCopilotModels();
    const merged = mergeProbedIntoCurated(probed, curated);

    if (probed.models.length === 0) {
      this.cachedCatalog = {
        models: merged,
        backend: 'curated',
        fetchedAt: Date.now(),
      };
      return merged;
    }

    this.cachedCatalog = {
      models: merged,
      backend: resolved.backend,
      fetchedAt: Date.now(),
    };
    return merged;
  }

  clearModelCache(): void {
    this.cachedCatalog = null;
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

  private async fetchCopilotCliModels(binaryPath: string): Promise<ProbeResult> {
    // Try a structured `--list-models` flag first (some CLI builds expose it).
    // Cheap, harmless probe-fail if not supported.
    const listOut = await this.runProbe(binaryPath, ['--list-models']);
    if (listOut) {
      const ids = listOut
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => this.looksLikeCopilotModelId(l));
      if (ids.length > 0) {
        return {
          models: Array.from(new Set(ids)).map((id) => this.copilotCliModel(id)),
          confidence: 'high',
        };
      }
    }

    // Fall through to help-text scrape — heuristic, often partial.
    const helpText = await this.runProbe(binaryPath, ['help']);
    if (!helpText) return { models: [], confidence: 'low' };
    return {
      models: this.parseCopilotHelpModels(helpText),
      confidence: 'low',
    };
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
   * model list, return [] so the caller falls back to the curated list.
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

  /**
   * Tightened heuristic: candidate must either contain '/' (provider/model
   * form) or start with a known vendor prefix. This rejects prose tokens
   * like 'available', 'default', 'none' that the loose char regex would
   * otherwise admit.
   */
  private looksLikeCopilotModelId(id: string): boolean {
    if (!id) return false;
    if (id.length < 3 || id.length > 80) return false;
    if (!/^[a-z0-9][a-z0-9._/-]+$/i.test(id)) return false;
    if (id.includes('/')) return true;
    const lower = id.toLowerCase();
    return VENDOR_PREFIXES.some((p) => lower.startsWith(p));
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

  private async fetchGhModelsList(binaryPath: string): Promise<ProbeResult> {
    // Detect whether `gh models list` supports --json. Docs only show --json
    // for `gh models eval`, so the most reliable test is parsing the help.
    let supportsJson = false;
    const helpOut = await this.runProbe(binaryPath, ['models', 'list', '--help']);
    if (helpOut && /--json/i.test(helpOut)) supportsJson = true;

    if (supportsJson) {
      const jsonOut = await this.runProbe(binaryPath, ['models', 'list', '--json']);
      if (jsonOut) {
        const parsed = this.parseGhModelsJson(jsonOut);
        if (parsed.length > 0) return { models: parsed, confidence: 'high' };
      }
    }

    const tableOut = await this.runProbe(binaryPath, ['models', 'list']);
    if (!tableOut) return { models: [], confidence: 'high' };
    return { models: this.parseGhModelsTable(tableOut), confidence: 'high' };
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
    // 'openai/gpt-4o-mini' -> 'gpt-4o-mini (openai)'
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

  /**
   * Probe a Copilot/gh binary, log raw stdout/stderr/exitCode to the
   * file-only probe log, and return stdout on success or null on failure.
   *
   * Return shape preserved (`string | null`) so callers don't need to
   * know about the logging side-effect.
   */
  private async runProbe(binaryPath: string, args: string[]): Promise<string | null> {
    try {
      const { stdout, stderr } = await execFilePortable(binaryPath, args, {
        timeout: PROBE_TIMEOUT_MS,
        env: getScopedSpawnEnv('copilot'),
        maxBuffer: 1024 * 1024,
      });
      void logCopilotProbe({
        args: [basename(binaryPath), ...args],
        exitCode: 0,
        stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
        stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
      });
      return stdout;
    } catch (err) {
      const e = err as { stdout?: unknown; stderr?: unknown; code?: number | string; signal?: string };
      void logCopilotProbe({
        args: [basename(binaryPath), ...args],
        exitCode: e?.code ?? e?.signal ?? null,
        stdout: coerce(e?.stdout),
        stderr: coerce(e?.stderr),
      });
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

function coerce(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return v.toString('utf-8');
  return String(v);
}
