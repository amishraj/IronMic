import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import type { ICLIAdapter, AIProvider, AIModel, ParsedOutput } from './types';
import { getScopedSpawnEnv, getSpawnEnv, resolveInShell } from '../utils/shell-env';

type CopilotBackend = 'copilot-cli' | 'gh-models';

interface ResolvedBackend {
  backend: CopilotBackend;
  binaryPath: string;
}

const ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-9;]*[ -/]*[@-~])/g;

/**
 * GitHub Copilot adapter.
 *
 * Enterprise-safe order of operations:
 * 1. Use the supported `copilot` CLI when it is installed/authenticated.
 * 2. Fall back to the public `gh models run` extension.
 * 3. Never call Copilot private/internal HTTP token endpoints.
 */
export class CopilotAdapter implements ICLIAdapter {
  name: AIProvider = 'copilot';

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
      const out = execFileSync(resolved.binaryPath, ['--version'], {
        encoding: 'utf-8',
        timeout: 5000,
        env: getScopedSpawnEnv('copilot'),
      });
      const match = out.match(/(\d+\.\d+\.\d+)/);
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

  availableModels(): AIModel[] {
    return [
      { id: 'openai/gpt-4.1', label: 'GPT-4.1', provider: 'copilot', free: false, description: 'GitHub Copilot / GitHub Models' },
      { id: 'openai/gpt-4o-mini', label: 'GPT-4o Mini', provider: 'copilot', free: true, description: 'Fast GitHub Copilot / GitHub Models option' },
    ];
  }

  buildArgs(prompt: string, _continueSession: boolean, model?: string): string[] {
    return ['models', 'run', this.normalizeGhModelId(model), prompt];
  }

  buildArgsForBinary(binaryPath: string, prompt: string, _continueSession: boolean, model?: string): string[] {
    if (this.looksLikeCopilotBinary(binaryPath)) {
      const args = ['--prompt', prompt];
      const normalizedModel = this.normalizeCopilotModelId(model);
      if (normalizedModel) args.push('--model', normalizedModel);
      return args;
    }
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

  private async resolveBackend(requireAuthenticated: boolean): Promise<ResolvedBackend | null> {
    const copilot = await this.findCopilotBinary();
    if (copilot && (!requireAuthenticated || this.isCopilotCliAuthenticated())) {
      return { backend: 'copilot-cli', binaryPath: copilot };
    }

    const gh = await this.findGhBinary();
    if (gh && this.hasModelsExtension(gh) && (!requireAuthenticated || this.isGhAuthenticated(gh))) {
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

    const npmPrefix = this.npmGlobalPrefix();
    const candidates =
      process.platform === 'win32'
        ? [
            join(process.env.APPDATA || '', 'npm', 'copilot.cmd'),
            join(process.env.APPDATA || '', 'npm', 'copilot.exe'),
            // npm v9+ scoped binstub layout
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
  private npmGlobalPrefix(): string | null {
    if (this.cachedNpmPrefix !== undefined) return this.cachedNpmPrefix;
    try {
      const out = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['prefix', '-g'], {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: getSpawnEnv(),
      }).trim();
      this.cachedNpmPrefix = out || null;
    } catch {
      this.cachedNpmPrefix = null;
    }
    return this.cachedNpmPrefix;
  }

  private isCopilotCliAuthenticated(): boolean {
    const env = getSpawnEnv();
    if (env.GH_TOKEN || env.GITHUB_TOKEN) return true;

    try {
      const configPath = join(homedir(), '.copilot', 'config.json');
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      const users = parsed.logged_in_users;
      return Array.isArray(users) && users.length > 0;
    } catch {
      return false;
    }
  }

  private isGhAuthenticated(binaryPath: string): boolean {
    try {
      execFileSync(binaryPath, ['auth', 'status'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: getSpawnEnv(),
      });
      return true;
    } catch {
      return false;
    }
  }

  private hasModelsExtension(binaryPath: string): boolean {
    try {
      execFileSync(binaryPath, ['models', '--help'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
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

  private normalizeGhModelId(model?: string): string {
    const aliases: Record<string, string> = {
      'gpt-4o': 'openai/gpt-4o',
      'gpt-4o-mini': 'openai/gpt-4o-mini',
      'gpt-4.1-mini': 'openai/gpt-4o-mini',
      'gpt-4.1': 'openai/gpt-4.1',
      'o3-mini': 'openai/o3-mini',
      'claude-3.5-sonnet': 'anthropic/claude-3.5-sonnet',
    };
    return aliases[model || ''] || model || 'openai/gpt-4o-mini';
  }

  private normalizeCopilotModelId(model?: string): string | null {
    if (!model) return null;
    const normalized = this.normalizeGhModelId(model);
    return normalized.includes('/') ? normalized.split('/').pop() || null : normalized;
  }
}
