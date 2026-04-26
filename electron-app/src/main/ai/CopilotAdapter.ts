import { execFileSync } from 'child_process';
import { net } from 'electron';
import type { IAIAdapter, AIProvider, AIModel } from './types';

/**
 * GitHub Copilot adapter.
 *
 * Authentication uses the `gh` CLI (GitHub CLI) to retrieve the stored OAuth
 * token, which is then exchanged for a short-lived Copilot API token via the
 * same endpoint VS Code's Copilot extension uses. Chat completions are streamed
 * directly over HTTPS — no `gh` subcommands are spawned for inference.
 *
 * Uses Electron's `net` module (not Node's `https`) so the OS/system certificate
 * store is respected. This fixes "self-signed certificate in the chain" errors on
 * enterprise networks with TLS-intercepting proxies.
 *
 * Works with any active GitHub Copilot plan (Individual, Business, Enterprise).
 * Does NOT require the `gh-models` extension.
 *
 * Cross-platform:
 *   - Binary discovery uses `where` on Windows / `which` elsewhere with an
 *     augmented PATH so Electron finds `gh` even when launched from the Finder.
 */
export class CopilotAdapter implements IAIAdapter {
  name: AIProvider = 'copilot';

  /** Copilot token cache (GitHub issues tokens with ~30-min TTL; we refresh at 25). */
  private tokenCache: { token: string; expiresAt: number } | null = null;

  async isInstalled(): Promise<boolean> {
    return (await this.getBinaryPath()) !== null;
  }

  async isAuthenticated(): Promise<boolean> {
    if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return true;

    const bin = await this.getBinaryPath();
    if (!bin) return false;

    try {
      execFileSync(bin, ['auth', 'status'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this.augmentedEnv(),
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
        env: this.augmentedEnv(),
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
        env: this.augmentedEnv(),
      });
      const first = out.split(/\r?\n/).find((line) => line.trim().length > 0);
      if (first) return first.trim();
    } catch { /* fall through to direct path probes */ }

    const { existsSync } = require('fs') as typeof import('fs');
    const candidates =
      process.platform === 'win32'
        ? [
            'C:\\Program Files\\GitHub CLI\\gh.exe',
            `${process.env.LOCALAPPDATA}\\Programs\\GitHub CLI\\gh.exe`,
          ]
        : [
            '/opt/homebrew/bin/gh',
            '/usr/local/bin/gh',
            '/usr/bin/gh',
            `${process.env.HOME || ''}/.local/bin/gh`,
          ];
    for (const p of candidates) {
      if (p && existsSync(p)) return p;
    }
    return null;
  }

  availableModels(): AIModel[] {
    return [
      { id: 'gpt-4o', label: 'GPT-4o', provider: 'copilot', free: false, description: 'Flagship GPT-4o via GitHub Copilot' },
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini', provider: 'copilot', free: true, description: 'Fast and efficient' },
      { id: 'o3-mini', label: 'o3-mini', provider: 'copilot', free: false, description: 'Advanced reasoning' },
      { id: 'claude-3.5-sonnet', label: 'Claude 3.5 Sonnet', provider: 'copilot', free: false, description: 'Anthropic model via Copilot' },
    ];
  }

  /** Retrieve the GitHub OAuth token stored by `gh auth login`. */
  async getGithubToken(): Promise<string | null> {
    const envToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (envToken) return envToken;

    const bin = await this.getBinaryPath();
    if (!bin) return null;

    try {
      const out = execFileSync(bin, ['auth', 'token'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this.augmentedEnv(),
      });
      return out.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Exchange a GitHub OAuth token for a short-lived Copilot API token.
   * Uses Electron net module so corporate TLS proxies are handled correctly.
   */
  async getCopilotToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.token;
    }

    const githubToken = await this.getGithubToken();
    if (!githubToken) {
      throw new Error(
        'No GitHub token found.\n\nRun `gh auth login` in your terminal, then refresh.'
      );
    }

    const token = await new Promise<string>((resolve, reject) => {
      const req = net.request({
        method: 'GET',
        url: 'https://api.github.com/copilot_internal/v2/token',
        headers: {
          Authorization: `token ${githubToken}`,
          'User-Agent': 'IronMic/1.0',
          'Editor-Version': 'vscode/1.94.0',
          'Editor-Plugin-Version': 'copilot-chat/0.22.0',
        },
      });

      req.on('response', (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new Error(
              'GitHub Copilot subscription required.\n\n' +
              'Make sure your GitHub account has an active Copilot plan ' +
              '(Individual, Business, or Enterprise).'
            ));
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Copilot token request failed (HTTP ${res.statusCode}): ${body.slice(0, 200)}`));
            return;
          }
          try {
            const data = JSON.parse(body) as { token: string };
            resolve(data.token);
          } catch {
            reject(new Error('Unexpected response from GitHub Copilot API'));
          }
        });
        res.on('error', reject);
      });

      req.on('error', reject);
      req.end();
    });

    this.tokenCache = { token, expiresAt: Date.now() + 25 * 60 * 1000 };
    return token;
  }

  /**
   * Send a chat completion request and stream tokens via `onToken`.
   * Uses Electron net module so corporate TLS proxies are handled correctly.
   */
  async sendMessageHTTP(
    messages: Array<{ role: string; content: string }>,
    model: string | undefined,
    onToken: (token: string) => void,
  ): Promise<string> {
    let copilotToken: string;
    try {
      copilotToken = await this.getCopilotToken();
    } catch (err) {
      throw err;
    }

    const modelId = model || 'gpt-4o';
    const body = JSON.stringify({
      model: modelId,
      messages,
      stream: true,
      max_tokens: 4096,
    });

    return new Promise((resolve, reject) => {
      let fullText = '';

      const req = net.request({
        method: 'POST',
        url: 'https://api.githubcopilot.com/chat/completions',
        headers: {
          Authorization: `Bearer ${copilotToken}`,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          'User-Agent': 'IronMic/1.0',
          'Editor-Version': 'vscode/1.94.0',
          'Editor-Plugin-Version': 'copilot-chat/0.22.0',
          'Copilot-Integration-Id': 'vscode-chat',
          'OpenAI-Intent': 'conversation-panel',
        },
      });

      req.on('response', (res) => {
        if (res.statusCode === 401) {
          this.tokenCache = null;
          reject(new Error('Copilot token expired. Please send your message again.'));
          return;
        }
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (chunk: Buffer) => { errBody += chunk.toString(); });
          res.on('end', () =>
            reject(new Error(`Copilot API error ${res.statusCode}: ${errBody.slice(0, 300)}`))
          );
          return;
        }

        // Parse Server-Sent Events stream
        let sseBuffer = '';
        res.on('data', (chunk: Buffer) => {
          sseBuffer += chunk.toString();
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (payload === '[DONE]') continue;
            try {
              const json = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
              const token = json.choices?.[0]?.delta?.content;
              if (token) {
                fullText += token;
                onToken(token);
              }
            } catch { /* skip malformed SSE frames */ }
          }
        });

        res.on('end', () => resolve(fullText));
        res.on('error', reject);
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /** Build a process env with common binary directories prepended to PATH. */
  private augmentedEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (process.platform !== 'win32') {
      const home = process.env.HOME || '';
      const extra = [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        `${home}/.local/bin`,
        `${home}/bin`,
      ].filter(Boolean);
      const current = (process.env.PATH || '').split(':');
      env.PATH = [...new Set([...extra, ...current])].join(':');
    }
    return env;
  }
}
