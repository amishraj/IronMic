/**
 * QAOrchestrator — the brain behind the Ask page.
 *
 * Pipeline:
 *   1. Resolve the user's chosen provider/model from settings (or caller).
 *   2. Classify the query's intent via the Rust `ragClassifyIntent` N-API.
 *   3. Run hybrid retrieval (`ragRetrieveHybrid`) to get top-k chunks.
 *   4. Build the LLM prompt via `promptBuilder.ts` — single source of truth
 *      for the citation contract.
 *   5. Dispatch to `aiManager.sendMessage` with the system prompt override.
 *      Existing `ai:output` / `ai:turn-end` events stream tokens back.
 *   6. Emit `knowledge:ask-event` notifications at each phase so the Ask UI
 *      can show "Searching… → Found N sources → streaming" status.
 *
 * Designed to fail gracefully. A bad embedding, missing local LLM, empty
 * retrieval — each degrades visibly (error event with actionable message)
 * instead of crashing the renderer.
 */

import type { BrowserWindow } from 'electron';
import { aiManager } from '../ai/AIManager';
import { buildPrompt, postProcessCitations } from './promptBuilder';
import { native } from '../native-bridge';
import type { AIProvider } from '../ai/types';

export interface KnowledgeAskOptions {
  /** Chat session to attach this turn to. Required — orchestrator does not
   *  create sessions; the caller (IPC handler) does. */
  sessionId: string;
  /** Provider preference. Falls back to user's `ai_provider` setting. */
  provider?: AIProvider;
  /** Model id override. Falls back to `ai_model` setting. */
  model?: string;
  /** Cap on retrieved chunks. Defaults from `rag_topic_k_local` /
   *  `rag_topic_k_cloud` settings based on provider. */
  k?: number;
  /** Pre-computed query embedding from BgeEmbedder (renderer-side). Empty
   *  Buffer = FTS5-only retrieval. */
  queryEmbedding?: Buffer;
}

export interface KnowledgeAskSource {
  chunkId: string;
  sourceType: string;
  sourceId: string;
  label: string;
  snippet: string;
  deeplink: string;
  startMs: number | null;
  score: number;
}

interface RetrievalResultFromRust {
  hits: Array<{
    chunk_id: string;
    source_type: string;
    source_id: string;
    text: string;
    score: number;
    label: string;
    snippet: string;
    deeplink: string;
    start_ms: number | null;
  }>;
  fts_count: number;
  vector_count: number;
  vector_used: boolean;
}

interface IntentResultFromRust {
  intent: 'Temporal' | 'SingleDoc' | 'CrossDoc' | 'Topic';
  filters: {
    date_from?: string;
    date_to?: string;
    speaker?: string;
    title_glob?: string;
    source_types?: string[];
  };
  scope_label: string;
}

/** Per-route retrieval-k defaults, used when the caller doesn't pass `k`. */
const DEFAULT_K_LOCAL = 8;
const DEFAULT_K_CLOUD = 30;

/** Single-active-request guard. The Ask UI is single-threaded by design —
 *  a new query cancels any pending one. */
let activeRequestId: string | null = null;

function genRequestId(): string {
  return `ka-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeSend(window: BrowserWindow | null, channel: string, payload: unknown) {
  try {
    if (window && !window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  } catch (err) {
    console.warn('[QAOrchestrator] event send failed:', err);
  }
}

/**
 * Resolve the user's effective AI provider for this turn. Reads `ai_provider`
 * + the `knowledge_qa_default_provider` setting (the latter takes precedence
 * when set to anything other than `'auto'`). Defaults to local when nothing
 * else applies — most privacy-conservative default.
 */
async function resolveProvider(override?: AIProvider): Promise<AIProvider> {
  if (override) return override;
  try {
    const qaPref = await getSetting('knowledge_qa_default_provider');
    if (qaPref && qaPref !== 'auto') {
      if (qaPref === 'local' || qaPref === 'claude' || qaPref === 'copilot') {
        return qaPref;
      }
    }
    const aiPref = await getSetting('ai_provider');
    if (aiPref === 'local' || aiPref === 'claude' || aiPref === 'copilot') {
      return aiPref;
    }
  } catch {
    /* fall through */
  }
  return 'local';
}

async function getSetting(key: string): Promise<string | null> {
  try {
    return native.addon.getSetting?.(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * Entry point. Runs the full orchestration for one knowledge query.
 * Returns the requestId so the caller (IPC handler) can correlate events
 * + cancel in flight. Resolves when the LLM has finished streaming
 * (or errored, or been cancelled).
 */
export async function knowledgeAsk(
  query: string,
  options: KnowledgeAskOptions,
  window: BrowserWindow | null,
): Promise<{ requestId: string; finalSources: KnowledgeAskSource[] }> {
  const requestId = genRequestId();
  activeRequestId = requestId;

  const emit = (phase: string, extra: Record<string, unknown> = {}) => {
    if (activeRequestId !== requestId) return; // Cancelled mid-flight.
    safeSend(window, 'knowledge:ask-event', { requestId, phase, ...extra });
  };

  try {
    emit('retrieving');

    // ── 1. Classify intent ────────────────────────────────────────────────
    let intent: IntentResultFromRust = {
      intent: 'Topic',
      filters: {},
      scope_label: 'All time',
    };
    try {
      const json = native.addon.ragClassifyIntent?.(query);
      if (json) intent = JSON.parse(json);
    } catch (err) {
      console.warn('[QAOrchestrator] intent classification failed (defaulting to Topic):', err);
    }

    // ── 2. Resolve provider + model ───────────────────────────────────────
    const provider = await resolveProvider(options.provider);
    const model = options.model ?? (await getSetting('ai_model')) ?? undefined;
    const isCloud = provider !== 'local';
    const k = options.k ?? (isCloud ? DEFAULT_K_CLOUD : DEFAULT_K_LOCAL);
    const modelVersion = (await getSetting('embedding_active_model')) || 'bge-small-en-v1.5';

    // ── 3. Run retrieval ──────────────────────────────────────────────────
    let retrieval: RetrievalResultFromRust = { hits: [], fts_count: 0, vector_count: 0, vector_used: false };
    try {
      const retrieveOpts = {
        model_version: modelVersion,
        k,
        filters: intent.filters,
        skip_archived: true,
      };
      const buf = options.queryEmbedding ?? Buffer.alloc(0);
      const json = native.addon.ragRetrieveHybrid?.(query, buf, JSON.stringify(retrieveOpts));
      if (json) retrieval = JSON.parse(json);
    } catch (err) {
      console.warn('[QAOrchestrator] retrieval failed (continuing with empty context):', err);
    }

    const sources: KnowledgeAskSource[] = retrieval.hits.map((h) => ({
      chunkId: h.chunk_id,
      sourceType: h.source_type,
      sourceId: h.source_id,
      label: h.label,
      snippet: h.snippet,
      deeplink: h.deeplink,
      startMs: h.start_ms,
      score: h.score,
    }));

    emit('retrieved', {
      sources,
      intent: intent.intent,
      scopeLabel: intent.scope_label,
      ftsCount: retrieval.fts_count,
      vectorCount: retrieval.vector_count,
      vectorUsed: retrieval.vector_used,
    });

    emit('route-resolved', {
      providerUsed: provider,
    });

    // ── 4. Build prompt ───────────────────────────────────────────────────
    const today = new Date().toISOString().slice(0, 10);
    const promptCtx = {
      today,
      scopeLabel: intent.scope_label,
      attachedNotes: [],
      retrievedChunks: retrieval.hits.map((h) => ({
        id: h.chunk_id,
        label: h.label,
        text: h.text,
      })),
    };

    const route: 'local' | 'claude' | 'copilot' = provider;
    // Claude-supports-append is a CLI-version-dependent capability. We don't
    // probe today; the prepended-delimiter shape works on all Claude CLI
    // versions. Future enhancement: probe and cache.
    const shaped = buildPrompt(promptCtx, query, {
      route,
      claudeSupportsAppendSystemPrompt: false,
    });

    // ── 5. Dispatch to AIManager ──────────────────────────────────────────
    // Local route: pass the system prompt as override + the user prompt
    // (the messages array's "user" entry). The orchestrator-built system
    // prompt replaces the generic chat one. Cloud route: the shaped prompt
    // already carries everything — system block is prepended into the user
    // prompt with the IRONMIC SYSTEM delimiter. AIManager.sendMessage gets
    // the full string.
    let llmPrompt: string;
    let systemOverride: string | undefined;
    if (shaped.route === 'local') {
      const sysMsg = shaped.messages.find((m) => m.role === 'system');
      const userMsg = [...shaped.messages].reverse().find((m) => m.role === 'user');
      systemOverride = sysMsg?.content;
      llmPrompt = userMsg?.content ?? query;
    } else {
      llmPrompt = (shaped as any).userPrompt ?? query;
    }

    emit('streaming');

    let raw = '';
    try {
      raw = await aiManager.sendMessage(
        llmPrompt,
        provider,
        window,
        model,
        /* contextKey */ 'knowledge',
        options.sessionId,
        /* priorMessages */ undefined,
        systemOverride,
      );
    } catch (err) {
      // Map a few known failure shapes to actionable error codes.
      const msg = err instanceof Error ? err.message : String(err);
      let code: 'no_provider_available' | 'local_model_missing' | 'retrieval_failed' | 'unknown' = 'unknown';
      if (msg.includes('No local chat model') || msg.includes('not installed') || msg.includes('not found')) {
        code = 'local_model_missing';
      } else if (msg.includes('not installed') || msg.includes('not authenticated')) {
        code = 'no_provider_available';
      }
      emit('error', {
        code,
        message: msg,
        actions: [{ label: 'Open AI Assist settings', deeplink: 'ironmic://settings/ai-assist' }],
      });
      activeRequestId = null;
      return { requestId, finalSources: sources };
    }

    // ── 6. Citation post-processing ───────────────────────────────────────
    const validKeys = new Set(retrieval.hits.map((_, i) => String(i + 1)));
    const { cleanedText, usedCitations, orphanMarkers } = postProcessCitations(raw, validKeys);
    if (orphanMarkers.length > 0) {
      console.warn(`[QAOrchestrator] stripped ${orphanMarkers.length} orphan citation markers:`, orphanMarkers);
    }
    const usedSources = sources.filter((_, i) => usedCitations.has(String(i + 1)));

    emit('done', {
      finalSources: usedSources,
      cleanedText,
    });

    activeRequestId = null;
    return { requestId, finalSources: usedSources };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit('error', { code: 'unknown', message: msg });
    activeRequestId = null;
    throw err;
  }
}

/** Cancel any in-flight request. The active request stops emitting events
 *  but the AIManager subprocess continues until natural completion — this
 *  is consistent with how `aiManager.cancel()` already works in this codebase
 *  (process is allowed to finish; renderer just ignores late output). */
export function cancelKnowledgeAsk(): void {
  activeRequestId = null;
}
