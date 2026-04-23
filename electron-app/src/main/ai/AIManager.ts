/**
 * AIManager — orchestrates CLI adapters, local LLM, auth status, and chat sessions.
 * CLI providers spawn headless subprocesses per turn (ClearPath pattern).
 * The local provider calls Rust N-API directly for on-device inference.
 */

import { spawn, ChildProcess } from 'child_process';
import { BrowserWindow } from 'electron';
import { CopilotAdapter } from './CopilotAdapter';
import { ClaudeAdapter } from './ClaudeAdapter';
import { LocalLLMAdapter, getChatModelPath, resolveActiveChatModel } from './LocalLLMAdapter';
import { llmSubprocess } from './LlmSubprocess';
import { CHAT_LLM_MODELS } from '../../shared/constants';
import { native } from '../native-bridge';
import type { AIProvider, AuthStatus, AIAuthState, ChatMessage, ICLIAdapter, IAIAdapter, AIModel } from './types';

const AUTH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** Maximum number of conversation history messages to keep for local LLM context. */
const MAX_HISTORY_MESSAGES = 20;

export class AIManager {
  private copilot = new CopilotAdapter();
  private claude = new ClaudeAdapter();
  private local = new LocalLLMAdapter();
  private authCache: Partial<Record<AIProvider, AuthStatus>> = {};
  private turnCount = 0;
  private activeProcess: ChildProcess | null = null;

  /** Conversation history for the local LLM (managed in-app since there's no CLI session). */
  private localHistory: Array<{ role: string; content: string }> = [];

  private getAdapter(provider: AIProvider): IAIAdapter {
    if (provider === 'local') return this.local;
    return provider === 'copilot' ? this.copilot : this.claude;
  }

  private getCLIAdapter(provider: AIProvider): ICLIAdapter {
    if (provider === 'copilot') return this.copilot;
    return this.claude;
  }

  /** Check auth status for all providers. Uses cache. */
  async getAuthState(): Promise<AIAuthState> {
    const [copilot, claude, local] = await Promise.all([
      this.checkAuth('copilot'),
      this.checkAuth('claude'),
      this.checkAuth('local'),
    ]);
    return { copilot, claude, local };
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

  /** Get available models for a provider. */
  getModels(provider: AIProvider): AIModel[] {
    return this.getAdapter(provider).availableModels();
  }

  /** Get all available models across all providers. */
  getAllModels(): AIModel[] {
    return [
      ...this.copilot.availableModels(),
      ...this.claude.availableModels(),
      ...this.local.availableModels(),
    ];
  }

  /** Pick the best available provider. Prefers Claude, then Copilot, then Local. */
  async pickProvider(): Promise<AIProvider | null> {
    const state = await this.getAuthState();
    if (state.claude.authenticated) return 'claude';
    if (state.copilot.authenticated) return 'copilot';
    if (state.local.authenticated) return 'local';
    return null;
  }

  /**
   * Send a message to the AI and stream the response.
   * Routes to CLI subprocess for copilot/claude, or Rust N-API for local.
   */
  async sendMessage(
    prompt: string,
    provider: AIProvider,
    window: BrowserWindow | null,
    model?: string,
  ): Promise<string> {
    if (provider === 'local') {
      return this.sendLocalMessage(prompt, window, model);
    }
    return this.sendCLIMessage(prompt, provider, window, model);
  }

  /**
   * Send a message via local LLM subprocess.
   */
  private async sendLocalMessage(
    prompt: string,
    window: BrowserWindow | null,
    model?: string,
  ): Promise<string> {
    // Resolve the model ID to a LOCAL model. The renderer may pass a stale
    // model ID here — most commonly when the user previously chose a cloud
    // provider (e.g. 'claude-sonnet-4-20250514'), then switched to local,
    // but the persisted `ai_model` setting still holds the cloud id. Before,
    // we threw "Unknown local LLM model"; now we fall back to the best
    // available local model using the same resolver the meeting + dictation
    // pipelines use. Keeps the feature working without forcing the user to
    // manually re-pick a model.
    let modelMeta = model ? CHAT_LLM_MODELS.find((m) => m.id === model) : undefined;
    let modelId = modelMeta?.id;
    if (!modelMeta) {
      const resolved = resolveActiveChatModel(native);
      if (!resolved) {
        throw new Error(
          'No local chat model is available.\n\n' +
          'Import or download a local LLM (Mistral 7B, Llama 3.1, or Phi-3) from Settings → Models, then try again.'
        );
      }
      modelId = resolved.id;
      modelMeta = CHAT_LLM_MODELS.find((m) => m.id === modelId);
      if (model && model !== modelId) {
        console.info(`[AIManager] Requested model "${model}" is not a local model — falling back to "${modelId}".`);
      }
    }
    if (!modelMeta || !modelId) {
      // Should be unreachable after the resolver path above, but keep a
      // belt-and-braces guard so TypeScript is happy.
      throw new Error('Failed to resolve a local LLM model.');
    }

    if (!llmSubprocess.isAvailable()) {
      throw new Error(
        'Local LLM inference engine not found.\n\n' +
        'The model file is imported, but IronMic needs the inference binary (ironmic-llm) to run it.\n\n' +
        'This binary is not yet included in pre-built releases. To use local AI chat, build from source:\n' +
        '  cd rust-core && cargo build --release --bin ironmic-llm --features llm-bin\n\n' +
        'This will be bundled in a future release.'
      );
    }

    const modelPath = getChatModelPath(modelId);
    const modelType = modelMeta.modelType;

    this.localHistory.push({ role: 'user', content: prompt });

    if (this.localHistory.length > MAX_HISTORY_MESSAGES) {
      this.localHistory = this.localHistory.slice(-MAX_HISTORY_MESSAGES);
    }

    const messages = [
      { role: 'system', content: 'You are a helpful AI assistant running locally on the user\'s device. Be concise and helpful.' },
      ...this.localHistory,
    ];

    if (window && !window.isDestroyed()) {
      window.webContents.send('ai:turn-start', { provider: 'local' });
    }

    try {
      const result = await llmSubprocess.chatComplete(
        {
          modelPath,
          modelType,
          messages,
          maxTokens: 2048,
          temperature: 0.3,
        },
        (token) => {
          if (window && !window.isDestroyed()) {
            window.webContents.send('ai:output', {
              provider: 'local',
              type: 'text',
              content: token,
            });
          }
        },
      );

      if (window && !window.isDestroyed()) {
        window.webContents.send('ai:turn-end', { provider: 'local' });
      }

      this.localHistory.push({ role: 'assistant', content: result });
      this.turnCount++;
      return result;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (window && !window.isDestroyed()) {
        window.webContents.send('ai:output', {
          provider: 'local',
          type: 'error',
          content: errorMsg,
        });
        window.webContents.send('ai:turn-end', { provider: 'local' });
      }

      this.localHistory.pop();
      throw new Error(`Local LLM error: ${errorMsg}`);
    }
  }

  /**
   * Send a message via CLI subprocess (Copilot or Claude).
   */
  private async sendCLIMessage(
    prompt: string,
    provider: AIProvider,
    window: BrowserWindow | null,
    model?: string,
  ): Promise<string> {
    const adapter = this.getCLIAdapter(provider);
    const auth = await this.checkAuth(provider);

    if (!auth.installed) {
      throw new Error(`${provider} CLI is not installed`);
    }
    if (!auth.authenticated) {
      throw new Error(`${provider} CLI is not authenticated. Please log in.`);
    }

    const binary = auth.binaryPath!;
    const continueSession = this.turnCount > 0;
    const args = adapter.buildArgs(prompt, continueSession, model);

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

  /** Get download status for all local chat models. */
  getLocalModelStatuses() {
    return this.local.getModelStatuses();
  }

  /** Cancel the active process. */
  cancel(): void {
    if (this.activeProcess) {
      this.activeProcess.kill('SIGTERM');
      this.activeProcess = null;
    }
  }

  /** Reset turn count and conversation history (new conversation). */
  resetSession(): void {
    this.cancel();
    this.turnCount = 0;
    this.localHistory = [];
  }
}

// Singleton
export const aiManager = new AIManager();
