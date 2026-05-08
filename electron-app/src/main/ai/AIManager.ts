/**
 * AIManager — orchestrates CLI adapters, local LLM, auth status, and chat sessions.
 * CLI providers spawn headless subprocesses per turn (ClearPath pattern).
 * The local provider calls Rust N-API directly for on-device inference.
 */

import { ChildProcess } from 'child_process';
import { BrowserWindow } from 'electron';
import { CopilotAdapter } from './CopilotAdapter';
import { ClaudeAdapter } from './ClaudeAdapter';
import { LocalLLMAdapter, getChatModelPath, resolveActiveChatModel } from './LocalLLMAdapter';
import { llmSubprocess } from './LlmSubprocess';
import { CHAT_LLM_MODELS } from '../../shared/constants';
import { native } from '../native-bridge';
import { getScopedSpawnEnv } from '../utils/shell-env';
import { spawnPortable } from '../utils/spawn-portable';
import type { AIProvider, AuthStatus, AIAuthState, ICLIAdapter, IAIAdapter, AIModel } from './types';

/** Narrowed to CLI-only providers so per-provider state can't accidentally include local. */
type CLIProvider = 'copilot' | 'claude';

/**
 * Translate raw CLI stderr into a user-facing message when it looks like
 * the selected model is not available on the user's plan / policy. Returns
 * null if stderr doesn't match a known entitlement-error pattern, so callers
 * fall back to the verbatim error.
 */
function friendlyEntitlementError(stderr: string, model?: string): string | null {
  const s = stderr.toLowerCase();
  const entitlementPatterns = [
    /not\s+(?:available|allowed|entitled|authorized)/,
    /not\s+enabled\s+for\s+(?:your|this)\s+(?:plan|account|organization)/,
    /access\s+denied/,
    /forbidden/,
    /403/,
    /upgrade\s+(?:to|your)/,
    /premium\s+request/,
    /no\s+access\s+to\s+(?:model|the\s+model)/,
    /model\s+not\s+(?:found|supported|available)/,
    /unsupported\s+model/,
    /quota\s+exceeded/,
    /rate\s+limit/,
  ];
  if (!entitlementPatterns.some((re) => re.test(s))) return null;
  const which = model ? ` "${model}"` : '';
  return (
    `The selected model${which} isn't available on your current GitHub Copilot plan or policy. ` +
    `Pick a different model in Settings → AI Assist (try "Refresh models" to see what your plan supports).`
  );
}

const AUTH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** Maximum number of conversation history messages to keep for local LLM context. */
const MAX_HISTORY_MESSAGES = 20;

/** Hard timeout for any single polish call (CLI or local). */
const POLISH_TIMEOUT_MS = 5 * 60 * 1000;

/** System prompt for the polish pass. Kept verbatim from CLAUDE.md so the
 *  behavior is consistent across local and CLI providers. */
const CLEANUP_PROMPT = `You are a text cleanup assistant. You receive raw speech-to-text transcriptions and produce clean, polished text.

Rules:
- Fix grammar, punctuation, and spelling errors
- Remove filler words (um, uh, like, you know, so, basically)
- Remove false starts and repeated phrases
- Preserve the speaker's original meaning, tone, and intent exactly
- Maintain the speaker's vocabulary level — do not make it sound more formal or less formal than intended
- Keep technical terms, proper nouns, and jargon exactly as spoken
- Format lists, paragraphs, and structure naturally based on content
- Do NOT add information that wasn't spoken
- Do NOT summarize or shorten — keep the full content
- Output ONLY the cleaned text, nothing else — no preamble, no explanation`;

export class AIManager {
  private copilot = new CopilotAdapter();
  private claude = new ClaudeAdapter();
  private local = new LocalLLMAdapter();
  private authCache: Partial<Record<AIProvider, AuthStatus>> = {};
  /**
   * Per-CLI-provider turn counts. Incremented only on code === 0 so a failed
   * turn can't poison the next one. Isolated per-provider so switching tabs
   * doesn't carry a Claude session into a fresh Copilot turn. Local chat uses
   * localHistories instead and is intentionally excluded from this map.
   */
  private cliTurnCounts: Partial<Record<CLIProvider, number>> = {};
  private activeProcess: ChildProcess | null = null;

  /**
   * Per-context conversation history for local LLM sessions.
   * Keyed by contextKey (default: 'chat'). Isolating by context prevents chat
   * history from bleeding into polish, summarize, or diarize calls.
   */
  private localHistories = new Map<string, Array<{ role: string; content: string }>>();

  /**
   * Per-provider lookup: id → AIModel. Updated whenever a list is returned
   * from any path (cache-only, fallback, or fresh probe). Used by sendMessage
   * and polish to translate the saved string id into the full AIModel that
   * carries `runIds.copilotCli` / `runIds.ghModels`.
   */
  private modelLookup: Partial<Record<AIProvider, Map<string, AIModel>>> = {};

  private getLocalHistory(ctx: string): Array<{ role: string; content: string }> {
    if (!this.localHistories.has(ctx)) this.localHistories.set(ctx, []);
    return this.localHistories.get(ctx)!;
  }

  private rememberModels(provider: AIProvider, models: AIModel[]): AIModel[] {
    const map = new Map<string, AIModel>();
    for (const m of models) map.set(m.id, m);
    this.modelLookup[provider] = map;
    return models;
  }

  /**
   * Resolve a saved model id to the cached AIModel. If the cache doesn't
   * contain it (e.g. post-restart before any refresh, or a model the user
   * typed manually), synthesize a minimal AIModel from the raw id so
   * buildArgs paths still work.
   */
  resolveModel(provider: AIProvider, id: string | undefined | null): AIModel | undefined {
    if (!id) return undefined;
    const cached = this.modelLookup[provider]?.get(id);
    if (cached) return cached;
    return this.synthesizeModel(provider, id);
  }

  private synthesizeModel(provider: AIProvider, id: string): AIModel {
    if (provider === 'copilot') {
      // For Copilot we use the raw id as the backend run-id directly.
      // Slash-prefixed ids are gh-models style; bare ids are copilot-cli style.
      return {
        id,
        label: id,
        provider: 'copilot',
        billing: 'unknown',
        runIds: id.includes('/') ? { ghModels: id } : { copilotCli: id },
      };
    }
    return { id, label: id, provider };
  }

  private getAdapter(provider: AIProvider): IAIAdapter {
    if (provider === 'local') return this.local;
    return provider === 'copilot' ? this.copilot : this.claude;
  }

  private getCLIAdapter(provider: AIProvider): ICLIAdapter {
    return provider === 'copilot' ? this.copilot : this.claude;
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

  /**
   * Force re-check auth for a provider. Also clears any cached model catalog
   * so the next user-initiated `refreshModels` re-probes against the new auth
   * state. Note: refreshAuth does NOT auto-trigger refreshModels — catalog
   * probes remain a separate explicit user action.
   */
  async refreshAuth(provider?: AIProvider): Promise<AIAuthState> {
    if (provider) {
      delete this.authCache[provider];
      this.getAdapter(provider).clearModelCache?.();
      await this.checkAuth(provider);
    } else {
      this.authCache = {};
      (this.copilot as IAIAdapter).clearModelCache?.();
      (this.claude as IAIAdapter).clearModelCache?.();
      (this.local as IAIAdapter).clearModelCache?.();
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

  /**
   * Get cached models for a provider. **Cache-only** — never spawns a child
   * process. Use refreshModels() to trigger a fresh probe.
   */
  async getModels(provider: AIProvider): Promise<AIModel[]> {
    const list = await this.getAdapter(provider).listAvailableModels();
    return this.rememberModels(provider, list);
  }

  /** Get all available models across all providers (cache-only). */
  async getAllModels(): Promise<AIModel[]> {
    const [c, cl, lo] = await Promise.all([
      this.copilot.listAvailableModels(),
      this.claude.listAvailableModels(),
      this.local.listAvailableModels(),
    ]);
    this.rememberModels('copilot', c);
    this.rememberModels('claude', cl);
    this.rememberModels('local', lo);
    return [...c, ...cl, ...lo];
  }

  /**
   * Probe-and-refresh path. Only entry point that spawns child processes
   * to enumerate models. Invoked via the explicit "Refresh models" UI.
   * @param provider - target provider; omit to refresh all.
   * @param opts.force - bypass adapter TTL.
   */
  async refreshModels(provider?: AIProvider, opts: { force?: boolean } = {}): Promise<AIModel[]> {
    if (provider) {
      const adapter = this.getAdapter(provider);
      const fresh = adapter.refreshModels
        ? await adapter.refreshModels(opts)
        : await adapter.listAvailableModels();
      return this.rememberModels(provider, fresh);
    }
    const refreshOne = (a: IAIAdapter) =>
      a.refreshModels ? a.refreshModels(opts) : a.listAvailableModels();
    const [c, cl, lo] = await Promise.all([
      refreshOne(this.copilot),
      refreshOne(this.claude),
      refreshOne(this.local),
    ]);
    this.rememberModels('copilot', c);
    this.rememberModels('claude', cl);
    this.rememberModels('local', lo);
    return [...c, ...cl, ...lo];
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
   * @param contextKey Isolates conversation history — use different keys for
   *   chat vs. summarize vs. polish so contexts don't bleed into each other.
   *   Defaults to 'chat' (the interactive user-facing conversation).
   */
  async sendMessage(
    prompt: string,
    provider: AIProvider,
    window: BrowserWindow | null,
    model?: string,
    contextKey = 'chat',
  ): Promise<string> {
    if (provider === 'local') {
      return this.sendLocalMessage(prompt, window, model, contextKey);
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
    contextKey = 'chat',
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

    const localHistory = this.getLocalHistory(contextKey);
    localHistory.push({ role: 'user', content: prompt });
    if (localHistory.length > MAX_HISTORY_MESSAGES) {
      localHistory.splice(0, localHistory.length - MAX_HISTORY_MESSAGES);
    }

    const messages = [
      { role: 'system', content: 'You are a helpful AI assistant running locally on the user\'s device. Be concise and helpful.' },
      ...localHistory,
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

      this.getLocalHistory(contextKey).push({ role: 'assistant', content: result });
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

      this.getLocalHistory(contextKey).pop();
      throw new Error(`Local LLM error: ${errorMsg}`);
    }
  }

  /**
   * Send a message via a provider-owned CLI subprocess.
   */
  private async sendCLIMessage(
    prompt: string,
    provider: CLIProvider,
    window: BrowserWindow | null,
    model?: string,
  ): Promise<string> {
    const adapter = this.getCLIAdapter(provider);
    const auth = await this.checkAuth(provider);

    if (!auth.installed) {
      if (provider === 'copilot') {
        throw new Error(
          'GitHub Copilot is not available.\n\n' +
          'Install and authenticate either:\n' +
          '  copilot\n\n' +
          'or the GitHub Models CLI extension:\n' +
          '  gh extension install https://github.com/github/gh-models'
        );
      }
      throw new Error(`${provider} CLI is not installed`);
    }
    if (!auth.authenticated) {
      if (provider === 'copilot') {
        throw new Error(
          'GitHub Copilot is not authenticated.\n\n' +
          'Verify one of these works in a terminal, then refresh IronMic:\n' +
          '  copilot --prompt "hello"\n' +
          '  gh models run openai/gpt-4o-mini "hello"'
        );
      }
      throw new Error(`${provider} CLI is not authenticated. Please log in.`);
    }

    const binary = auth.binaryPath!;
    const continueSession = (this.cliTurnCounts[provider] ?? 0) > 0;
    const resolvedModel = this.resolveModel(provider, model);
    const args = provider === 'copilot'
      ? this.copilot.buildArgsForBinary(binary, prompt, continueSession, resolvedModel ?? model)
      : adapter.buildArgs(prompt, continueSession, resolvedModel ?? model);

    if (process.env.NODE_ENV === 'development') {
      console.log(`[ai] Sending to ${provider}: ${binary} [${args.length} args, prompt_length=${prompt.length}]`);
    }

    return new Promise((resolve, reject) => {
      // Notify UI that turn started
      if (window && !window.isDestroyed()) {
        window.webContents.send('ai:turn-start', { provider });
      }

      const scopedEnv = getScopedSpawnEnv(provider);

      // spawnPortable wraps Windows .cmd shims via cmd.exe /c. We never use
      // shell:true because that would require escaping user prompts against
      // cmd.exe metacharacter injection.
      const proc = spawnPortable(binary, args, {
        env: scopedEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      // Close stdin immediately. gh-models otherwise waits on EOF before
      // streaming the response when run with a positional prompt arg.
      try { proc.stdin?.end(); } catch { /* ignore */ }

      this.activeProcess = proc;
      let fullOutput = '';
      let stderrBuf = '';

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
        const text = chunk.toString();
        stderrBuf += text;
        if (process.env.NODE_ENV === 'development') {
          console.error(`[ai] ${provider} stderr:`, text);
        }
      });

      proc.on('error', (err) => {
        this.activeProcess = null;
        reject(new Error(`Failed to start ${provider}: ${err.message}`));
      });

      proc.on('close', (code) => {
        this.activeProcess = null;

        if (window && !window.isDestroyed()) {
          window.webContents.send('ai:turn-end', { provider });
        }

        if (code === 0) {
          // Only count a clean exit as a successful turn. A non-zero exit
          // (even with partial stdout) means we shouldn't --continue from
          // a half-finished session on the next turn.
          this.cliTurnCounts[provider] = (this.cliTurnCounts[provider] ?? 0) + 1;
          resolve(fullOutput.trim());
        } else if (fullOutput.trim()) {
          // Non-zero exit but we got stdout — surface it, don't increment.
          resolve(fullOutput.trim());
        } else {
          // Surface stderr so the user can see why it failed.
          const detail = stderrBuf.trim().slice(0, 800) || '(no stderr)';
          const friendly = friendlyEntitlementError(detail, model);
          reject(new Error(friendly || `${provider} exited with code ${code}: ${detail}`));
        }
      });
    });
  }

  /**
   * Run a polish (text cleanup) pass with provider preference.
   *
   * Provider order:
   *   - allowCloud && Claude authenticated → Claude
   *   - allowCloud && Copilot authenticated → Copilot
   *   - local chat model installed → local
   *   - otherwise → throw (renderer pattern-matches for "Cleanup model not downloaded")
   *
   * Crucially separate from `sendMessage` / `sendCLIMessage`:
   *   - never touches `this.cliTurnCounts`
   *   - never assigns `this.activeProcess` (chat cancel won't kill polish)
   *   - never emits `ai:turn-*` events (no chat UI bleed)
   *   - always one-shot (continueSession=false) — polish has no conversation
   */
  async polish(
    rawText: string,
    opts: { allowCloud: boolean },
  ): Promise<{ text: string; providerUsed: AIProvider }> {
    // Read the user's selected model so polish honors it. Previously the
    // model was silently dropped — every polish ran against the CLI default.
    let savedModelId: string | null = null;
    let savedProvider: string | null = null;
    try {
      savedModelId = native.getSetting('ai_model');
      savedProvider = native.getSetting('ai_provider');
    } catch { /* ignore — settings unavailable */ }

    const claude = opts.allowCloud ? await this.checkAuth('claude') : null;
    if (claude?.authenticated) {
      const claudeModel = savedProvider === 'claude' ? savedModelId : null;
      const text = await this.runCliOneShot('claude', rawText, claudeModel || undefined);
      return { text, providerUsed: 'claude' };
    }
    const copilot = opts.allowCloud ? await this.checkAuth('copilot') : null;
    if (copilot?.authenticated) {
      const copilotModel = savedProvider === 'copilot' ? savedModelId : null;
      const text = await this.runCliOneShot('copilot', rawText, copilotModel || undefined);
      return { text, providerUsed: 'copilot' };
    }
    const resolvedLocal = resolveActiveChatModel(native);
    if (resolvedLocal) {
      if (!llmSubprocess.isAvailable()) {
        throw new Error(
          'Local LLM binary (ironmic-llm) is missing. Rebuild with: ' +
            'cargo build --release --bin ironmic-llm --features llm-bin',
        );
      }
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Polish timed out after ${POLISH_TIMEOUT_MS / 1000}s`)),
          POLISH_TIMEOUT_MS,
        ),
      );
      const text = await Promise.race([
        llmSubprocess.chatComplete({
          modelPath: resolvedLocal.modelPath,
          modelType: resolvedLocal.modelType,
          messages: [
            { role: 'system', content: CLEANUP_PROMPT },
            { role: 'user', content: rawText },
          ],
          maxTokens: 2048,
          temperature: 0.3,
        }),
        timeout,
      ]);
      return { text, providerUsed: 'local' };
    }
    throw new Error(
      'Cleanup model not downloaded. Import or download one in Settings to enable text polishing.',
    );
  }

  /**
   * Spawn a CLI provider for a single polish turn. Isolated from the chat
   * pipeline — no shared state, no event emissions, no continueSession.
   */
  private async runCliOneShot(
    provider: 'claude' | 'copilot',
    rawText: string,
    model?: string,
  ): Promise<string> {
    const adapter = this.getCLIAdapter(provider);
    const auth = await this.checkAuth(provider);
    if (!auth.installed) {
      throw new Error(`${provider} CLI is not installed`);
    }
    if (!auth.authenticated) {
      throw new Error(`${provider} CLI is not authenticated`);
    }
    const binary = auth.binaryPath!;
    // The cleanup prompt is prepended to the raw transcript inline because
    // the CLI binaries take a single positional/argument prompt — there's no
    // separate system-message channel like chatComplete has.
    const prompt = `${CLEANUP_PROMPT}\n\nInput transcript:\n${rawText}`;
    const resolvedModel = this.resolveModel(provider, model);
    const args = provider === 'copilot'
      ? this.copilot.buildArgsForBinary(binary, prompt, false, resolvedModel ?? model)
      : adapter.buildArgs(prompt, false, resolvedModel ?? model);

    return new Promise<string>((resolve, reject) => {
      const proc = spawnPortable(binary, args, {
        env: getScopedSpawnEnv(provider),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      try { proc.stdin?.end(); } catch { /* ignore */ }

      let fullOutput = '';
      let stderrBuf = '';
      const timer = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        reject(new Error(`Polish via ${provider} timed out after ${POLISH_TIMEOUT_MS / 1000}s`));
      }, POLISH_TIMEOUT_MS);

      proc.stdout?.on('data', (chunk: Buffer) => { fullOutput += chunk.toString(); });
      proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to start ${provider}: ${err.message}`));
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && !fullOutput.trim()) {
          const detail = stderrBuf.trim().slice(0, 800) || '(no stderr)';
          const friendly = friendlyEntitlementError(detail, model);
          reject(new Error(friendly || `${provider} exited with code ${code}: ${detail}`));
          return;
        }
        // Strip ANSI for Copilot which can emit color codes; Claude doesn't.
        const cleaned = provider === 'copilot'
          ? this.copilot.parseOutput(fullOutput).content
          : fullOutput;
        resolve(cleaned.trim());
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

  /** Reset turn counts and all conversation history contexts (new conversation). */
  resetSession(): void {
    this.cancel();
    this.cliTurnCounts = {};
    this.localHistories.clear();
  }
}

// Singleton
export const aiManager = new AIManager();
