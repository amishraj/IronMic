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

/**
 * Pretty-print a raw model id for UI display. Mirrors the renderer-side
 * helper at src/renderer/utils/prettify-model-id.ts and CopilotAdapter's
 * private prettifyId — duplicated rather than cross-imported because main
 * and renderer can't share a module cleanly.
 *   'openai/gpt-4o-mini'   -> 'gpt-4o-mini (openai)'
 *   'claude-haiku-4.5'     -> 'Claude Haiku 4.5'
 */
function prettifyModelId(id: string): string {
  if (!id) return '';
  if (id.includes('/')) {
    const [vendor, name] = id.split('/');
    return `${name} (${vendor})`;
  }
  return id
    .split(/[-_]/)
    .map((p) => (p.length === 0 ? p : p[0].toUpperCase() + p.slice(1)))
    .join(' ');
}

/** Narrowed to CLI-only providers so per-provider state can't accidentally include local. */
type CLIProvider = 'copilot' | 'claude';

/**
 * Map known-bogus model ids (typically left over in user settings from a
 * past version where ClaudeAdapter listed wrong ids) to their correct
 * canonical form. Cheap O(1) table — used in the hot resolveModel path.
 *
 * Today's only entry: the mis-ordered Haiku 3.5 dated id. Anthropic's
 * dated id pattern is `claude-{version}-{family}-{YYYYMMDD}`, so Haiku
 * 3.5 is `claude-3-5-haiku-20241022` — the previous list had
 * `claude-haiku-3-5-20241022` which the Claude CLI rejects.
 */
function normalizeKnownBadModelId(id: string): string {
  if (id === 'claude-haiku-3-5-20241022') return 'claude-3-5-haiku-20241022';
  return id;
}

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

/**
 * Plain-mode polish prompt — used when `polish_format_mode === 'plain'`.
 *
 * Historical CLEANUP_SYSTEM_PROMPT, preserved verbatim so users who turn
 * off "Smart formatting" get exactly today's behavior. Plain mode keeps
 * the original "no structure" instruction.
 */
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

/**
 * Local-mode polish prompt — for the small Phi-3-mini-Q2_K running via
 * llmSubprocess. Tightly scoped: long instructions over-constrain a small
 * model. Granola-style adaptive formatting: every note gets *some*
 * structure (bold for key terms always; inline code for identifiers;
 * bullets for enumerations) but the heading hierarchy scales with length
 * — short notes get bold + bullets only, medium notes get H3, long notes
 * get H2. No flat-paragraph-only fallback; even a 20-word capture
 * deserves bolded subjects.
 */
const LOCAL_POLISH_PROMPT = `You are a professional formatter. Convert raw speech-to-text into clean, well-structured markdown. Every note gets some structure — even short ones.

CLEANUP:
- Fix grammar, spelling, punctuation
- Remove fillers (um, uh, like, you know, basically, so, right)
- Remove false starts and stutters
- Preserve meaning, tone, vocabulary level, and technical terms exactly

ALWAYS (regardless of length):
- **Bold** key subjects: names, decisions, deadlines, owners, totals, deliverables
- Use \`inline code\` for file names, function names, PR refs, commands
- Use professional vocabulary: "blockers", "action items", "deliverables"

ADAPT BY LENGTH:
- Very short (<30 words, single thought) → one paragraph with **bold** key terms; no headings, no bullets unless explicitly enumerated
- Short (30–80 words, single topic) → one or two paragraphs; bold key terms; bullets if items were listed
- Medium (80–200 words, possibly multi-topic) → ### H3 sub-sections per topic + bullets where natural
- Long (>200 words or many topics) → ## H2 per major section, with ### H3 sub-headings if needed

LISTS: enumerated items ("first… second… also…") always become bullets, regardless of total length.

NEVER:
- Add information not in the transcript
- Summarize or shorten — produce roughly the same length as the input
- Add preamble or trailing commentary

Output ONLY markdown. Examples:

Input (short): "need to fix the bug in user.ts on line 42 then deploy by Friday"
Output:
Need to fix the bug in \`user.ts\` on line 42, then **deploy by Friday**.

Input (enumerated): "first finish the auth flow second add tests third deploy by Friday"
Output:
- Finish the auth flow
- Add tests
- **Deploy by Friday**`;

/**
 * Cloud-mode polish prompt — for Claude / Copilot CLI. Larger models
 * reward thoroughness and worked examples. Granola-style: every note
 * gets *some* structure (bold + inline code at minimum); heading
 * hierarchy scales with length. Allows tables and code fences
 * (capabilities the local model handles less reliably).
 */
const CLOUD_POLISH_PROMPT = `You are a professional document formatter for technical and business contexts. You receive raw speech-to-text transcriptions and produce clean, well-structured markdown. Every note gets some structure — even short ones (Granola-style).

# Cleanup
- Fix grammar, spelling, punctuation
- Remove fillers (um, uh, like, you know, basically, so, right)
- Remove false starts, stutters, and repeated phrases
- Preserve the speaker's meaning, tone, vocabulary level, and technical terms verbatim

# Always — regardless of length
- \`**bold**\` key subjects: names, decisions, deadlines, owners, totals, deliverables, action items
- \`\\\`inline code\\\`\` for file names, function names, commands, package names, PR / ticket / JIRA refs
- Use corporate/technical vocabulary when natural: "blockers" not "stuck stuff", "action items" not "todos", "deliverables", "stakeholders", "scope", "timeline"
- Direct quotes → \`> blockquote\`
- Code dictated → fenced \`\\\`\\\`\\\`code blocks\\\`\\\`\\\`\`

# Heading hierarchy scales with length
- **Very short (<30 words, single thought)** → one paragraph with bolded key terms; no headings
- **Short (30–80 words, single topic)** → one or two paragraphs with bolded key terms; bullets ONLY if explicitly enumerated
- **Medium (80–200 words, possibly multi-topic)** → \`### H3\` sub-sections per topic; paragraphs / bullets where natural
- **Long (>200 words, multi-topic)** → \`## H2\` per major section, \`### H3\` for sub-sections inside

Enumerated items ("first… second… also… and finally…") always become bullets, regardless of total length. Genuinely tabular data (rows of owner/item/date triples) → markdown table.

# Hard rules
- Do NOT add information not in the transcript
- Do NOT summarize or shorten — produce roughly the same length as the input
- Do NOT add preamble like "Here is the cleaned text:" or trailing commentary
- Output ONLY markdown — no explanations, no notes about what you did

# Examples

Input (very short): "um so basically I need to fix the bug in user dot ts on line 42 then deploy by Friday"
Output: I need to fix the bug in \`user.ts\` on line 42, then **deploy by Friday**.

Input (short): "okay quick standup update finished the auth refactor today next up is the rate limiter for the API and I'm blocked on the staging credentials Alice still needs to send"
Output:
Finished the **auth refactor** today. Next up is the **rate limiter** for the API. **Blocked on staging credentials** — Alice still needs to send.

Input (enumerated short): "first finish the auth flow second add tests third deploy by Friday"
Output:
- Finish the auth flow
- Add tests
- **Deploy by Friday**

Input (medium, multi-topic): "okay so the plan is the migration we decided to use the staged rollout approach Alice owns the auth piece Bob owns the data piece both due Friday and we agreed not to touch billing this week also separately I want to mention the on-call rotation needs an extra person Carol volunteered for next month"
Output:
### Migration plan

We decided to use the **staged rollout** approach.

**Owners:**
- **Alice** — auth piece, due **Friday**
- **Bob** — data piece, due **Friday**

**Decided:** no billing changes this week.

### On-call rotation

Need an extra person. **Carol** volunteered for next month.

Input (technical): "the auth bug in login dot ts is using the old token format so we need to add the new validator and update the test in auth dot test dot ts"
Output: The **auth bug** in \`login.ts\` is using the old token format. We need to add the new validator and update the test in \`auth.test.ts\`.`;

/**
 * Read `polish_format_mode` and pick the right system prompt for the path
 * (local vs cloud). Missing setting defaults to 'rich' so Phase 4 doesn't
 * depend on Phase 5's migration having materialized the setting yet.
 */
function selectPolishPrompt(target: 'local' | 'cloud'): string {
  let mode: string | null = null;
  try {
    mode = native.getSetting('polish_format_mode');
  } catch { /* setting absent → default to rich */ }
  if (mode === 'plain') return CLEANUP_PROMPT;
  return target === 'cloud' ? CLOUD_POLISH_PROMPT : LOCAL_POLISH_PROMPT;
}

export class AIManager {
  private copilot = new CopilotAdapter();
  private claude = new ClaudeAdapter();
  private local = new LocalLLMAdapter();
  private authCache: Partial<Record<AIProvider, AuthStatus>> = {};
  /**
   * Per-CLI-provider, per-session turn counts. Keyed by `${provider}:${sessionId}`
   * (or `${provider}:_default` when sessionId is absent). Incremented only on
   * code === 0 so a failed turn can't poison the next one. Per-session keys
   * mean switching chat sessions never accidentally `--continue`s an unrelated
   * conversation. Local chat uses localHistories instead.
   */
  private cliTurnCounts: Record<string, number> = {};
  private activeProcess: ChildProcess | null = null;
  /** Session id that owns `activeProcess`. Used by `resetSession` to scope
   *  cancellation — a defensive context-clear on session A must NOT kill
   *  an in-flight CLI request belonging to session B. Null when activeProcess
   *  is from a non-chat path (polish, generate) or when no process is
   *  running. */
  private activeProcessSessionId: string | null = null;

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

  /** Compose the local-history / cli-turn-count key. */
  private contextKeyFor(base: string, sessionId?: string | null): string {
    return sessionId ? `${base}:${sessionId}` : base;
  }
  private cliTurnKey(provider: CLIProvider, sessionId?: string | null): string {
    return sessionId ? `${provider}:${sessionId}` : `${provider}:_default`;
  }

  /**
   * Hydrate the in-memory local history for a session from persisted messages.
   * Idempotent: only seeds when the in-memory history is empty for the given
   * key. Caps at MAX_HISTORY_MESSAGES to bound prompt size on long resumes.
   */
  private hydrateLocalHistory(
    ctxKey: string,
    priorMessages: ReadonlyArray<{ role: string; content: string }>,
  ): void {
    const existing = this.getLocalHistory(ctxKey);
    if (existing.length > 0 || priorMessages.length === 0) return;
    const tail = priorMessages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-MAX_HISTORY_MESSAGES);
    existing.push(...tail.map((m) => ({ role: m.role, content: m.content })));
  }

  /**
   * Build a self-contained CLI prompt that bakes prior turns into the request.
   * Used on a "cold resume" — when this `provider:sessionId` has no live turn
   * count (e.g. after an app restart) but the session has a persisted history.
   * The CLI sees a single self-contained prompt; it does not need --continue.
   */
  private buildCliReplayPrompt(
    priorMessages: ReadonlyArray<{ role: string; content: string }>,
    currentPrompt: string,
  ): string {
    const tail = priorMessages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-MAX_HISTORY_MESSAGES);
    if (tail.length === 0) return currentPrompt;
    const lines: string[] = ['[Previous conversation in this session:]'];
    for (const m of tail) {
      const speaker = m.role === 'user' ? 'You' : 'Assistant';
      lines.push(`${speaker}: ${m.content}`);
    }
    lines.push('', '[Current message:]', currentPrompt);
    return lines.join('\n');
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
    // Defensive: rewrite known-bogus saved ids to their correct form
    // before lookup. Users who selected the old (mis-ordered) Haiku 3.5
    // entry have `claude-haiku-3-5-20241022` persisted in their `ai_model`
    // setting; the Claude CLI rejects that with "model may not exist or
    // you may not have access to it". Normalize on read so they don't
    // have to re-pick from the dropdown.
    const normalized = normalizeKnownBadModelId(id);
    const cached = this.modelLookup[provider]?.get(normalized);
    if (cached) return cached;
    return this.synthesizeModel(provider, normalized);
  }

  private synthesizeModel(provider: AIProvider, id: string): AIModel {
    if (provider === 'copilot') {
      // For Copilot we use the raw id as the backend run-id directly.
      // Slash-prefixed ids are gh-models style; bare ids are copilot-cli style.
      return {
        id,
        label: prettifyModelId(id),
        provider: 'copilot',
        billing: 'unknown',
        runIds: id.includes('/') ? { ghModels: id } : { copilotCli: id },
      };
    }
    return { id, label: prettifyModelId(id), provider };
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
    sessionId?: string | null,
    priorMessages?: ReadonlyArray<{ role: string; content: string }>,
    // Optional override of the system prompt for the local-LLM path. Cloud
    // CLIs don't have a real "system" channel — the orchestrator bakes any
    // system instructions into the prompt before calling sendMessage, so
    // this parameter is local-only. When unset the local path keeps the
    // hardcoded generic "helpful assistant" system message so existing chat
    // behavior is unchanged.
    systemPromptOverride?: string,
  ): Promise<string> {
    const scopedKey = this.contextKeyFor(contextKey, sessionId);
    if (provider === 'local') {
      return this.sendLocalMessage(prompt, window, model, scopedKey, priorMessages, systemPromptOverride, sessionId);
    }
    return this.sendCLIMessage(prompt, provider, window, model, sessionId, priorMessages);
  }

  /**
   * Send a message via local LLM subprocess.
   */
  private async sendLocalMessage(
    prompt: string,
    window: BrowserWindow | null,
    model?: string,
    contextKey = 'chat',
    priorMessages?: ReadonlyArray<{ role: string; content: string }>,
    systemPromptOverride?: string,
    // Stamped onto every ai:output / ai:turn-* event so the renderer can
    // discard tokens from a request whose owner-session is no longer the
    // visible one (prevents "answer from chat A leaking into chat B"
    // when the user starts a new chat mid-stream).
    sessionId?: string | null,
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

    // Cold-resume: if the in-memory context for this session is empty but we
    // received persisted messages, seed from them so the model gets continuity.
    if (priorMessages && priorMessages.length > 0) {
      this.hydrateLocalHistory(contextKey, priorMessages);
    }

    const localHistory = this.getLocalHistory(contextKey);
    localHistory.push({ role: 'user', content: prompt });
    if (localHistory.length > MAX_HISTORY_MESSAGES) {
      localHistory.splice(0, localHistory.length - MAX_HISTORY_MESSAGES);
    }

    const systemContent = systemPromptOverride
      || 'You are a helpful AI assistant running locally on the user\'s device. Be concise and helpful.';
    const messages = [
      { role: 'system', content: systemContent },
      ...localHistory,
    ];

    if (window && !window.isDestroyed()) {
      window.webContents.send('ai:turn-start', { provider: 'local', sessionId });
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
              sessionId,
            });
          }
        },
      );

      if (window && !window.isDestroyed()) {
        window.webContents.send('ai:turn-end', { provider: 'local', sessionId });
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
          sessionId,
        });
        window.webContents.send('ai:turn-end', { provider: 'local', sessionId });
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
    sessionId?: string | null,
    priorMessages?: ReadonlyArray<{ role: string; content: string }>,
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
    const turnKey = this.cliTurnKey(provider, sessionId);
    const continueSession = (this.cliTurnCounts[turnKey] ?? 0) > 0;
    // Cold-resume: continueSession is false but the session has persisted
    // history. Bake the prior turns into the prompt so the CLI can answer
    // with continuity even though it has no continuation token.
    const effectivePrompt =
      !continueSession && priorMessages && priorMessages.length > 0
        ? this.buildCliReplayPrompt(priorMessages, prompt)
        : prompt;
    const resolvedModel = this.resolveModel(provider, model);
    const args = provider === 'copilot'
      ? this.copilot.buildArgsForBinary(binary, effectivePrompt, continueSession, resolvedModel ?? model)
      : adapter.buildArgs(effectivePrompt, continueSession, resolvedModel ?? model);

    if (process.env.NODE_ENV === 'development') {
      console.log(`[ai] Sending to ${provider}: ${binary} [${args.length} args, prompt_length=${prompt.length}]`);
    }

    return new Promise((resolve, reject) => {
      // Notify UI that turn started. sessionId stamped here lets the
      // renderer filter so a stream that arrives after the user has
      // switched to a different chat doesn't bleed into it.
      if (window && !window.isDestroyed()) {
        window.webContents.send('ai:turn-start', { provider, sessionId });
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
      this.activeProcessSessionId = sessionId ?? null;
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
            sessionId,
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
        this.activeProcessSessionId = null;
        reject(new Error(`Failed to start ${provider}: ${err.message}`));
      });

      proc.on('close', (code) => {
        this.activeProcess = null;
        this.activeProcessSessionId = null;

        if (window && !window.isDestroyed()) {
          window.webContents.send('ai:turn-end', { provider, sessionId });
        }

        if (code === 0) {
          // Only count a clean exit as a successful turn. A non-zero exit
          // (even with partial stdout) means we shouldn't --continue from
          // a half-finished session on the next turn.
          this.cliTurnCounts[turnKey] = (this.cliTurnCounts[turnKey] ?? 0) + 1;
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

    // CLI binaries take a single prompt argument — no separate system-message
    // channel — so we concatenate the system prompt inline before spawning.
    // The system prompt depends on polish_format_mode and the path: cloud
    // gets the richer prompt with worked examples; local gets the terse
    // variant; plain mode falls back to the legacy CLEANUP_PROMPT.
    const cloudPrompt = `${selectPolishPrompt('cloud')}\n\nInput transcript:\n${rawText}`;
    const claude = opts.allowCloud ? await this.checkAuth('claude') : null;
    if (claude?.authenticated) {
      const claudeModel = savedProvider === 'claude' ? savedModelId : null;
      const text = await this.runCliOneShot('claude', cloudPrompt, claudeModel || undefined);
      return { text, providerUsed: 'claude' };
    }
    const copilot = opts.allowCloud ? await this.checkAuth('copilot') : null;
    if (copilot?.authenticated) {
      const copilotModel = savedProvider === 'copilot' ? savedModelId : null;
      const text = await this.runCliOneShot('copilot', cloudPrompt, copilotModel || undefined);
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
            { role: 'system', content: selectPolishPrompt('local') },
            { role: 'user', content: rawText },
          ],
          maxTokens: 2048,
          // Lower temp for the rich-format prompt — small model needs the
          // structure to stick. Plain mode keeps temp 0.3 (today's value).
          temperature: 0.1,
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
   * Generic LLM transport. Caller owns the system prompt — no cleanup prompt
   * is layered on top. Used by SummaryGenerator, MeetingTemplateEngine,
   * IntentClassifier, MeetingDetector, and any other non-polish completion.
   *
   * Provider routing matches `polish()` exactly:
   *   - allowCloud && Claude authenticated → Claude
   *   - allowCloud && Copilot authenticated → Copilot
   *   - local chat model installed → local
   *   - otherwise → throw
   *
   * Crucially separate from `sendMessage` and `polish` — never touches
   * cliTurnCounts, never assigns activeProcess, never emits ai:turn-* events.
   *
   * Caller must clamp maxTokens / temperature before calling. The IPC
   * handler enforces clamps and prompt-length validation; this method
   * trusts its arguments because the IPC boundary is the security gate.
   */
  async generate(
    systemPrompt: string,
    userPrompt: string,
    opts: { allowCloud: boolean; maxTokens: number; temperature: number },
  ): Promise<{ text: string; providerUsed: AIProvider }> {
    let savedModelId: string | null = null;
    let savedProvider: string | null = null;
    try {
      savedModelId = native.getSetting('ai_model');
      savedProvider = native.getSetting('ai_provider');
    } catch { /* ignore */ }

    const claude = opts.allowCloud ? await this.checkAuth('claude') : null;
    if (claude?.authenticated) {
      const claudeModel = savedProvider === 'claude' ? savedModelId : null;
      const text = await this.runCliOneShotWithSystem(
        'claude',
        systemPrompt,
        userPrompt,
        claudeModel || undefined,
      );
      return { text, providerUsed: 'claude' };
    }
    const copilot = opts.allowCloud ? await this.checkAuth('copilot') : null;
    if (copilot?.authenticated) {
      const copilotModel = savedProvider === 'copilot' ? savedModelId : null;
      const text = await this.runCliOneShotWithSystem(
        'copilot',
        systemPrompt,
        userPrompt,
        copilotModel || undefined,
      );
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
          () => reject(new Error(`Generate timed out after ${POLISH_TIMEOUT_MS / 1000}s`)),
          POLISH_TIMEOUT_MS,
        ),
      );
      const text = await Promise.race([
        llmSubprocess.chatComplete({
          modelPath: resolvedLocal.modelPath,
          modelType: resolvedLocal.modelType,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          maxTokens: opts.maxTokens,
          temperature: opts.temperature,
        }),
        timeout,
      ]);
      return { text, providerUsed: 'local' };
    }
    throw new Error(
      'Cleanup model not downloaded. Import or download one in Settings to enable AI generation.',
    );
  }

  /**
   * runCliOneShot variant that takes an explicit system prompt and user input
   * separately. The CLI binaries take a single prompt argument with no
   * separate system-message channel, so we concatenate inline — same
   * approach as the polish path, but without baking in the cleanup prompt.
   */
  private async runCliOneShotWithSystem(
    provider: 'claude' | 'copilot',
    systemPrompt: string,
    userPrompt: string,
    model?: string,
  ): Promise<string> {
    return this.runCliOneShot(
      provider,
      `${systemPrompt}\n\n${userPrompt}`,
      model,
    );
  }

  /**
   * Spawn a CLI provider for a single one-shot turn. Caller passes a
   * fully-built prompt string. Isolated from the chat pipeline — no
   * shared state, no event emissions, no continueSession.
   */
  private async runCliOneShot(
    provider: 'claude' | 'copilot',
    prompt: string,
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

  /**
   * Cancel the active process.
   *
   * If `sessionId` is provided, only kills the process when its sessionId
   * matches — a session-scoped cancel must NOT touch a CLI request that
   * belongs to a different session. (This is the bug behind first-message
   * `claude exited with code null`: the renderer fires a defensive
   * resetSession on every newly-created chat, which used to kill any
   * concurrent in-flight request — most commonly the very first message
   * the user just sent in that new chat.)
   *
   * Without a sessionId (the explicit user-cancel button + the wholesale
   * "Clear all AI history" path), kills whatever's running.
   */
  cancel(sessionId?: string | null): void {
    if (!this.activeProcess) return;
    if (sessionId && this.activeProcessSessionId !== sessionId) return;
    this.activeProcess.kill('SIGTERM');
    this.activeProcess = null;
    this.activeProcessSessionId = null;
  }

  /**
   * Reset conversation context. With no args clears every chat:* context
   * across all providers (used by Settings → "Clear all AI history"). With a
   * `sessionId` clears only that one session's context — used by "New chat"
   * and by switching to a different persisted session.
   *
   * Cancellation is now session-scoped (see `cancel(sessionId)`) so a
   * defensive reset on session A no longer kills an in-flight request on
   * session B.
   */
  resetSession(sessionId?: string | null): void {
    this.cancel(sessionId ?? undefined);
    if (!sessionId) {
      this.cliTurnCounts = {};
      this.localHistories.clear();
      return;
    }
    // Scoped reset: only purge keys mentioning this sessionId.
    for (const key of Object.keys(this.cliTurnCounts)) {
      if (key.endsWith(`:${sessionId}`)) delete this.cliTurnCounts[key];
    }
    const localKeys = Array.from(this.localHistories.keys());
    for (const key of localKeys) {
      if (key.endsWith(`:${sessionId}`)) this.localHistories.delete(key);
    }
  }
}

// Singleton
export const aiManager = new AIManager();
