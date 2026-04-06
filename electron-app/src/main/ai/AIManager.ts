/**
 * AIManager — orchestrates CLI adapters, auth status, and chat sessions.
 * Spawns headless CLI subprocesses per turn (ClearPath pattern).
 */

import { spawn, ChildProcess } from 'child_process';
import { BrowserWindow } from 'electron';
import { CopilotAdapter } from './CopilotAdapter';
import { ClaudeAdapter } from './ClaudeAdapter';
import type { AIProvider, AuthStatus, AIAuthState, ChatMessage, ICLIAdapter } from './types';

const AUTH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export class AIManager {
  private copilot = new CopilotAdapter();
  private claude = new ClaudeAdapter();
  private authCache: Partial<Record<AIProvider, AuthStatus>> = {};
  private turnCount = 0;
  private activeProcess: ChildProcess | null = null;

  private getAdapter(provider: AIProvider): ICLIAdapter {
    return provider === 'copilot' ? this.copilot : this.claude;
  }

  /** Check auth status for both providers. Uses cache. */
  async getAuthState(): Promise<AIAuthState> {
    const [copilot, claude] = await Promise.all([
      this.checkAuth('copilot'),
      this.checkAuth('claude'),
    ]);
    return { copilot, claude };
  }

  /** Force re-check auth for a provider. */
  async refreshAuth(provider?: AIProvider): Promise<AIAuthState> {
    if (provider) {
      delete this.authCache[provider];
      await this.checkAuth(provider);
    } else {
      this.authCache = {};
      return this.getAuthState();
    }
    return this.getAuthState();
  }

  private async checkAuth(provider: AIProvider): Promise<AuthStatus> {
    const cached = this.authCache[provider];
    if (cached && Date.now() - cached.checkedAt < AUTH_CACHE_TTL) {
      return cached;
    }

    const adapter = this.getAdapter(provider);
    const [installed, authenticated, version, binaryPath] = await Promise.all([
      adapter.isInstalled(),
      adapter.isAuthenticated(),
      adapter.getVersion(),
      adapter.getBinaryPath(),
    ]);

    const status: AuthStatus = {
      installed,
      authenticated: installed && authenticated,
      binaryPath,
      version,
      checkedAt: Date.now(),
    };

    this.authCache[provider] = status;
    return status;
  }

  /** Pick the best available provider. Prefers Claude, falls back to Copilot. */
  async pickProvider(): Promise<AIProvider | null> {
    const state = await this.getAuthState();
    if (state.claude.authenticated) return 'claude';
    if (state.copilot.authenticated) return 'copilot';
    return null;
  }

  /**
   * Send a message to the AI and stream the response.
   * Spawns a headless CLI process per turn.
   */
  async sendMessage(
    prompt: string,
    provider: AIProvider,
    window: BrowserWindow | null,
  ): Promise<string> {
    const adapter = this.getAdapter(provider);
    const auth = await this.checkAuth(provider);

    if (!auth.installed) {
      throw new Error(`${provider} CLI is not installed`);
    }
    if (!auth.authenticated) {
      throw new Error(`${provider} CLI is not authenticated. Please log in.`);
    }

    const binary = auth.binaryPath!;
    const continueSession = this.turnCount > 0;
    const args = adapter.buildArgs(prompt, continueSession);

    if (process.env.NODE_ENV === 'development') {
      console.log(`[ai] Sending to ${provider}: ${binary} [${args.length} args, prompt_length=${prompt.length}]`);
    }

    return new Promise((resolve, reject) => {
      // Notify UI that turn started
      if (window && !window.isDestroyed()) {
        window.webContents.send('ai:turn-start', { provider });
      }

      // Scoped environment — only pass what the CLIs need, not the full process.env
      const scopedEnv: Record<string, string> = {
        TERM: 'dumb',
      };
      // System essentials
      for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TMPDIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME']) {
        if (process.env[key]) scopedEnv[key] = process.env[key]!;
      }
      // Auth tokens needed by CLIs
      if (provider === 'claude' && process.env.ANTHROPIC_API_KEY) {
        scopedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
      }
      if (provider === 'copilot') {
        if (process.env.GH_TOKEN) scopedEnv.GH_TOKEN = process.env.GH_TOKEN;
        if (process.env.GITHUB_TOKEN) scopedEnv.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
      }

      const proc = spawn(binary, args, {
        env: scopedEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.activeProcess = proc;
      let fullOutput = '';

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        fullOutput += text;

        // Stream chunks to renderer
        if (window && !window.isDestroyed()) {
          const parsed = adapter.parseOutput(text);
          window.webContents.send('ai:output', {
            provider,
            ...parsed,
          });
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        if (process.env.NODE_ENV === 'development') {
          console.error(`[ai] ${provider} stderr:`, chunk.toString());
        }
      });

      proc.on('error', (err) => {
        this.activeProcess = null;
        reject(new Error(`Failed to start ${provider}: ${err.message}`));
      });

      proc.on('close', (code) => {
        this.activeProcess = null;
        this.turnCount++;

        if (window && !window.isDestroyed()) {
          window.webContents.send('ai:turn-end', { provider });
        }

        if (code !== 0 && !fullOutput.trim()) {
          reject(new Error(`${provider} exited with code ${code}`));
        } else {
          resolve(fullOutput.trim());
        }
      });
    });
  }

  /** Cancel the active process. */
  cancel(): void {
    if (this.activeProcess) {
      this.activeProcess.kill('SIGTERM');
      this.activeProcess = null;
    }
  }

  /** Reset turn count (new conversation). */
  resetSession(): void {
    this.cancel();
    this.turnCount = 0;
  }
}

// Singleton
export const aiManager = new AIManager();
