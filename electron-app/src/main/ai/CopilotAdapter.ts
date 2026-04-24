import { execFileSync } from 'child_process';
import type { ICLIAdapter, ParsedOutput, AIProvider, AIModel } from './types';

/**
 * GitHub Copilot via the `gh` CLI. Chat is routed through the gh-models
 * extension (`gh models run <model> <prompt>`) — NOT `gh copilot suggest`,
 * which is a shell-command suggestion tool, not a chat completion endpoint.
 *
 * Requirements on the user's machine:
 *   1. `gh` CLI installed and authenticated (`gh auth login`)
 *   2. `gh-models` extension installed: `gh extension install github/gh-models`
 *
 * Cross-platform notes:
 *   - Binary discovery uses `where` on Windows / `which` elsewhere via
 *     execFileSync with NO shell, so it works on systems without zsh/bash.
 *   - All probes are sync with short timeouts so they don't block the UI.
 */
export class CopilotAdapter implements ICLIAdapter {
  name: AIProvider = 'copilot';

  async isInstalled(): Promise<boolean> {
    return (await this.getBinaryPath()) !== null;
  }

  async isAuthenticated(): Promise<boolean> {
    if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return true;

    const bin = await this.getBinaryPath();
    if (!bin) return false;

    // `gh auth status` exits 0 iff at least one host is logged in.
    // It writes its status report to stderr, but we only care about the
    // exit code here — execFileSync throws on non-zero.
    try {
      execFileSync(bin, ['auth', 'status'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(): Promise<string | null> {
    const bin = await this.getBinaryPath();
    if (!bin) return null;
    try {
      const out = execFileSync(bin, ['--version'], {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const match = out.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  async getBinaryPath(): Promise<string | null> {
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    try {
      const out = execFileSync(lookup, ['gh'], {
        encoding: 'utf-8',
        timeout: 3000,
      });
      // `where` can return multiple paths on Windows (one per line); take the first.
      const first = out.split(/\r?\n/).find((line) => line.trim().length > 0);
      return first ? first.trim() : null;
    } catch {
      return null;
    }
  }

  /**
   * Args for `gh models run <model> <prompt>`. The gh-models extension
   * streams the assistant response on stdout as plain text.
   */
  buildArgs(prompt: string, _continueSession: boolean, model?: string): string[] {
    // Default to the free, fast tier so unconfigured runs still work.
    const modelId = model || 'gpt-4o-mini';
    return ['models', 'run', modelId, prompt];
  }

  /**
   * Models surfaced in IronMic's UI. These are GitHub Models marketplace IDs
   * — the same IDs `gh models list` returns. The `free` flag here only
   * affects the UI label; entitlement is enforced by GitHub.
   */
  availableModels(): AIModel[] {
    return [
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini', provider: 'copilot', free: true, description: 'Fast and free with GitHub Copilot' },
      { id: 'gpt-4o', label: 'GPT-4o', provider: 'copilot', free: false, description: 'Multimodal flagship' },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', provider: 'copilot', free: true, description: 'Free tier — fast and capable' },
      { id: 'gpt-4.1', label: 'GPT-4.1', provider: 'copilot', free: false, description: 'Most capable GPT-4.1' },
      { id: 'o3-mini', label: 'o3-mini', provider: 'copilot', free: false, description: 'Advanced reasoning' },
      { id: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet', provider: 'copilot', free: false, description: 'Anthropic via GitHub Models' },
    ];
  }

  parseOutput(data: string): ParsedOutput {
    const trimmed = data.trim();
    if (!trimmed) return { type: 'text', content: '' };
    // gh-models prints extension-not-installed errors with this exact prefix.
    if (/extension .* not found/i.test(trimmed) || /unknown command "models"/i.test(trimmed)) {
      return {
        type: 'error',
        content: 'GitHub Models extension not installed. Run: gh extension install github/gh-models',
      };
    }
    if (/^error/i.test(trimmed) || /HTTP 4\d\d/.test(trimmed) || /HTTP 5\d\d/.test(trimmed)) {
      return { type: 'error', content: trimmed };
    }
    return { type: 'text', content: trimmed };
  }
}
