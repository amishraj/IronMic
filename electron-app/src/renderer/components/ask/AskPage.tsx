/**
 * AskPage — "Ask anything about your IronMic" surface.
 *
 * Single-shot Q&A over the user's full corpus (entries + meetings + notes)
 * via the QAOrchestrator + retrieval pipeline. Distinct from AIChat (which
 * is a conversational chat with manually-attached context).
 *
 * Lifecycle for one query:
 *   1. User types → presses Enter or clicks Send
 *   2. We call `knowledgeAskStart(query, options)`
 *   3. Orchestrator emits phase events (retrieving / retrieved / route-resolved
 *      / streaming / done / error) on `knowledge:ask-event`; streamed
 *      tokens ride the existing `ai:output` channel reused from AIChat
 *   4. AnswerPanel renders status + sources + streaming answer + citations
 *
 * Cancellation: starting a new query cancels the prior in-flight one
 * (single-active-request, enforced in QAOrchestrator).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Send, Sparkles, X, RefreshCw, Mic, Users, StickyNote, FileText, ChevronDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Source {
  chunkId: string;
  sourceType: string;
  sourceId: string;
  label: string;
  snippet: string;
  deeplink: string;
  startMs: number | null;
  score: number;
}

type Phase = 'idle' | 'retrieving' | 'retrieved' | 'streaming' | 'done' | 'error';

interface AskState {
  phase: Phase;
  /** Synthetic id passed to AIManager so the renderer can filter ai:output
   *  events. Different from `requestId` (which scopes the knowledge:ask-event
   *  stream). The same value is what gets stamped on every `ai:output`
   *  payload for this turn — we drop tokens whose sessionId doesn't match. */
  askSessionId: string | null;
  /** What the user asked — frozen at send time so the input box is free
   *  to be re-typed mid-stream. */
  query: string;
  /** Streamed answer text accumulator. */
  answer: string;
  /** Sources surfaced by retrieval, in fused-rank order. */
  sources: Source[];
  /** Human-readable scope ("Last 7 days (May 3 - May 9)") from intent. */
  scopeLabel: string;
  /** Intent class from the classifier. */
  intent: string;
  /** Which provider this turn used. */
  providerUsed: string | null;
  /** Error code + message + actions when phase === 'error'. */
  errorCode: string | null;
  errorMessage: string | null;
  errorActions: Array<{ label: string; deeplink: string }>;
  /** Active request id for event correlation. */
  requestId: string | null;
}

const initialState: AskState = {
  phase: 'idle',
  askSessionId: null,
  query: '',
  answer: '',
  sources: [],
  scopeLabel: '',
  intent: '',
  providerUsed: null,
  errorCode: null,
  errorMessage: null,
  errorActions: [],
  requestId: null,
};

const RECENT_KEY = 'ironmic-ask-recent';
const MAX_RECENT = 6;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT) : [];
  } catch { return []; }
}
function saveRecent(list: string[]) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT))); } catch {}
}

export function AskPage() {
  const [input, setInput] = useState('');
  const [state, setState] = useState<AskState>(initialState);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  // Index freshness shown in the corner. Refresh on mount + every time a
  // query completes, so users see the index growing in real time.
  const [indexStats, setIndexStats] = useState<{ total: number; indexed: number; activeModel: string } | null>(null);

  const stateRef = useRef(state);
  stateRef.current = state;

  const refreshStats = useCallback(async () => {
    try {
      const json = await (window as any).ironmic.ragGetIndexStats?.();
      if (!json) return;
      const parsed = JSON.parse(json);
      setIndexStats({
        total: parsed.total_chunks ?? 0,
        indexed: parsed.indexed_chunks ?? 0,
        activeModel: parsed.active_model ?? 'bge-small-en-v1.5',
      });
    } catch { /* stats are best-effort */ }
  }, []);

  useEffect(() => { void refreshStats(); }, [refreshStats]);

  // Kick the backfill indexer on first visit to the Ask page. Deferred from
  // app boot so cold-start time stays unchanged for users who never visit
  // here. Idempotent — the service tracks its own `kicked` flag and won't
  // re-run within one app session.
  useEffect(() => {
    void (async () => {
      try {
        const { indexerService } = await import('../../services/rag/IndexerService');
        await indexerService.kickOnce();
        // Refresh stats after the backfill completes so the pill reflects
        // the new chunk count.
        await refreshStats();
      } catch (err) {
        console.warn('[AskPage] indexer kick failed:', err);
      }
    })();
  }, [refreshStats]);

  // Subscribe to phase events from the orchestrator.
  useEffect(() => {
    const off = (window as any).ironmic.onKnowledgeAskEvent?.((evt: any) => {
      const cur = stateRef.current;
      if (!cur.requestId || evt.requestId !== cur.requestId) return;
      setState((s) => {
        switch (evt.phase) {
          case 'retrieving':
            return { ...s, phase: 'retrieving' };
          case 'retrieved':
            return {
              ...s,
              phase: 'retrieved',
              sources: evt.sources ?? [],
              scopeLabel: evt.scopeLabel ?? s.scopeLabel,
              intent: evt.intent ?? s.intent,
            };
          case 'route-resolved':
            return { ...s, providerUsed: evt.providerUsed ?? s.providerUsed };
          case 'streaming':
            // The streaming phase fires once at the start; actual token
            // text comes through the `ai:output` channel below.
            return { ...s, phase: 'streaming' };
          case 'done':
            return {
              ...s,
              phase: 'done',
              answer: evt.cleanedText ?? s.answer,
              sources: evt.finalSources ?? s.sources,
            };
          case 'error':
            return {
              ...s,
              phase: 'error',
              errorCode: evt.code ?? 'unknown',
              errorMessage: evt.message ?? 'Unknown error',
              errorActions: evt.actions ?? [],
            };
          default:
            return s;
        }
      });
    });

    // Token text from AIManager streams on the existing `ai:output` channel.
    // We filter on `askSessionId` so a stream from a stale request (or from
    // AIChat if it ever co-rendered) can't bleed into the current answer.
    const offTokens = (window as any).ironmic.onAiOutput?.((data: any) => {
      const cur = stateRef.current;
      if (cur.phase !== 'streaming' && cur.phase !== 'retrieved') return;
      if (data?.type !== 'text' || typeof data.content !== 'string') return;
      if (data.sessionId && cur.askSessionId && data.sessionId !== cur.askSessionId) return;
      setState((s) => ({ ...s, answer: s.answer + data.content }));
    });

    return () => {
      try { off?.(); } catch {}
      try { offTokens?.(); } catch {}
    };
  }, []);

  // Refresh stats after each successful or errored turn.
  useEffect(() => {
    if (state.phase === 'done' || state.phase === 'error') {
      void refreshStats();
    }
  }, [state.phase, refreshStats]);

  const handleSubmit = useCallback(async () => {
    const query = input.trim();
    if (!query) return;
    if (state.phase === 'retrieving' || state.phase === 'streaming' || state.phase === 'retrieved') {
      // Cancel the active request before starting a new one.
      try { await (window as any).ironmic.knowledgeAskCancel?.(); } catch {}
    }

    setInput('');
    const askSessionId = `ask-${Date.now()}`;
    setState({
      ...initialState,
      query,
      askSessionId,
      phase: 'retrieving',
    });

    // Update recent queries (dedupe + most-recent-first).
    const updated = [query, ...recent.filter((q) => q !== query)].slice(0, MAX_RECENT);
    setRecent(updated);
    saveRecent(updated);

    try {
      const result = await (window as any).ironmic.knowledgeAskStart(query, {
        // Ask is single-shot — each submission is its own ephemeral
        // interaction. We pass `askSessionId` so AIManager stamps every
        // ai:output / ai:turn-* event with it; the onAiOutput handler
        // filters on this value to discard tokens from stale or
        // cross-page requests.
        sessionId: askSessionId,
        // Empty embedding ⇒ FTS5-only retrieval. When Slice B lands
        // (BGE embedder via ONNX Runtime Web), pass the embedder output
        // here — the orchestrator handles either shape.
        queryEmbedding: new Uint8Array(),
      });
      // Persist the active requestId for event correlation.
      if (result?.requestId) {
        setState((s) => ({ ...s, requestId: result.requestId }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState((s) => ({
        ...s,
        phase: 'error',
        errorCode: 'unknown',
        errorMessage: msg,
        errorActions: [],
      }));
    }
  }, [input, state.phase, recent]);

  const handleKey = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  }, [handleSubmit]);

  return (
    <div className="h-full flex flex-col bg-iron-bg">
      {/* Header */}
      <div className="border-b border-iron-border px-6 py-4 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <Sparkles className="w-5 h-5 text-iron-accent-light" />
          <div>
            <h1 className="text-base font-semibold text-iron-text">Ask your knowledge</h1>
            <p className="text-[11px] text-iron-text-muted mt-0.5">
              Search across your notes, dictations, and meetings.
            </p>
          </div>
        </div>
        <IndexFreshness stats={indexStats} onRefresh={refreshStats} />
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {state.phase === 'idle' ? (
          <EmptyState recent={recent} onPick={(q) => { setInput(q); }} />
        ) : (
          <AnswerPanel state={state} />
        )}
      </div>

      {/* Footer / input */}
      <div className="border-t border-iron-border px-6 py-3 flex-shrink-0">
        <div className="flex items-end gap-2">
          <div className="flex-1 relative">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKey}
              rows={1}
              placeholder='Ask anything — e.g. "what did we decide about auth?"'
              className="w-full text-sm leading-5 bg-iron-surface border border-iron-border rounded-xl placeholder:text-iron-text-muted px-4 py-2.5 resize-none transition-all focus:outline-none focus:border-iron-accent/50 focus:shadow-glow text-iron-text"
              style={{ maxHeight: '120px', minHeight: '40px' }}
            />
          </div>
          <button
            onClick={handleSubmit}
            disabled={!input.trim() || state.phase === 'retrieving' || state.phase === 'streaming'}
            className="w-10 h-10 rounded-xl bg-iron-accent text-white flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed hover:bg-iron-accent/90 transition-colors flex-shrink-0"
            title="Send"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
        <p className="text-[10px] text-iron-text-muted mt-1.5 px-1">
          Press Enter to send · Shift+Enter for newline · Each query searches your full corpus.
        </p>
      </div>
    </div>
  );
}

// ── Empty state ─────────────────────────────────────────────────────────────

function EmptyState({ recent, onPick }: { recent: string[]; onPick: (q: string) => void }) {
  const samples = [
    'Summarize my meetings from the past week',
    'What did we decide about the auth migration?',
    'Help me prep for the next sprint planning',
    'What did I dictate yesterday?',
  ];
  return (
    <div className="max-w-xl mx-auto pt-8">
      <div className="text-center mb-8">
        <Search className="w-8 h-8 text-iron-text-muted/30 mx-auto mb-3" />
        <p className="text-sm text-iron-text-secondary">
          Ask a question — I'll search your notes, dictations, and meetings and answer with citations.
        </p>
      </div>

      {recent.length > 0 && (
        <div className="mb-6">
          <p className="text-[10px] uppercase tracking-wide text-iron-text-muted mb-2 px-1">Recent</p>
          <div className="space-y-1">
            {recent.map((q) => (
              <button
                key={q}
                onClick={() => onPick(q)}
                className="w-full text-left px-3 py-2 rounded-lg text-xs text-iron-text-secondary hover:bg-iron-surface-hover hover:text-iron-text transition-colors flex items-center gap-2"
              >
                <RefreshCw className="w-3 h-3 text-iron-text-muted flex-shrink-0" />
                <span className="truncate">{q}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div>
        <p className="text-[10px] uppercase tracking-wide text-iron-text-muted mb-2 px-1">Try asking</p>
        <div className="space-y-1">
          {samples.map((s) => (
            <button
              key={s}
              onClick={() => onPick(s)}
              className="w-full text-left px-3 py-2 rounded-lg text-xs text-iron-text-secondary hover:bg-iron-surface-hover hover:text-iron-text transition-colors"
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Answer panel ────────────────────────────────────────────────────────────

function AnswerPanel({ state }: { state: AskState }) {
  return (
    <div className="max-w-3xl mx-auto">
      {/* User question echo */}
      <div className="mb-4 flex items-start gap-3">
        <div className="w-7 h-7 rounded-full bg-iron-accent/15 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Search className="w-3.5 h-3.5 text-iron-accent-light" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-iron-text">{state.query}</p>
        </div>
      </div>

      {/* Phase status */}
      <PhaseStatus state={state} />

      {/* Sources — surfaced eagerly during streaming for a sense of progress */}
      {state.sources.length > 0 && (
        <SourcesPanel sources={state.sources} />
      )}

      {/* Answer body */}
      {state.answer && (
        <div className="mt-4 rounded-xl bg-iron-surface border border-iron-border px-4 py-3">
          <div className="text-sm text-iron-text leading-6 prose-iron">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{state.answer}</ReactMarkdown>
          </div>
          {state.providerUsed && (
            <p className="text-[10px] text-iron-text-muted mt-3 pt-2 border-t border-iron-border">
              via {state.providerUsed === 'local' ? 'local' : state.providerUsed}
            </p>
          )}
        </div>
      )}

      {/* Error state */}
      {state.phase === 'error' && (
        <div className="mt-4 rounded-xl bg-iron-danger/10 border border-iron-danger/30 px-4 py-3">
          <p className="text-sm text-iron-danger font-medium">{state.errorMessage}</p>
          {state.errorActions.length > 0 && (
            <div className="flex gap-2 mt-2">
              {state.errorActions.map((a) => (
                <button
                  key={a.label}
                  onClick={() => {
                    // Naive deeplink dispatch — the main process can handle a
                    // full URL handler later; for now we just route by suffix.
                    if (a.deeplink.includes('settings')) {
                      window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'settings' }));
                    }
                  }}
                  className="text-xs text-iron-danger underline hover:no-underline"
                >
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PhaseStatus({ state }: { state: AskState }) {
  if (state.phase === 'retrieving') {
    return (
      <div className="flex items-center gap-2 text-xs text-iron-text-muted mb-3">
        <div className="w-1.5 h-1.5 rounded-full bg-iron-accent-light animate-pulse" />
        Searching your knowledge…
      </div>
    );
  }
  if (state.phase === 'retrieved' || state.phase === 'streaming') {
    return (
      <div className="flex items-center gap-2 text-xs text-iron-text-muted mb-3 flex-wrap">
        <span>Found {state.sources.length} source{state.sources.length === 1 ? '' : 's'}</span>
        {state.scopeLabel && state.scopeLabel !== 'All time' && (
          <>
            <span className="text-iron-text-muted/50">·</span>
            <span>{state.scopeLabel}</span>
          </>
        )}
        {state.phase === 'streaming' && (
          <>
            <span className="text-iron-text-muted/50">·</span>
            <span className="flex items-center gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-iron-accent-light animate-pulse" />
              Composing answer…
            </span>
          </>
        )}
      </div>
    );
  }
  if (state.phase === 'done') {
    return (
      <div className="flex items-center gap-2 text-xs text-iron-text-muted mb-3 flex-wrap">
        <span>{state.sources.length} source{state.sources.length === 1 ? '' : 's'} used</span>
        {state.scopeLabel && state.scopeLabel !== 'All time' && (
          <>
            <span className="text-iron-text-muted/50">·</span>
            <span>{state.scopeLabel}</span>
          </>
        )}
      </div>
    );
  }
  return null;
}

// ── Sources ─────────────────────────────────────────────────────────────────

function SourcesPanel({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mt-3 rounded-xl bg-iron-surface border border-iron-border overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-iron-surface-hover transition-colors"
      >
        <span className="text-[11px] uppercase tracking-wide text-iron-text-muted font-medium">
          Sources · {sources.length}
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-iron-text-muted transition-transform ${open ? '' : '-rotate-90'}`}
        />
      </button>
      {open && (
        <div className="border-t border-iron-border divide-y divide-iron-border/50">
          {sources.map((s, i) => (
            <SourceRow key={s.chunkId} source={s} index={i + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function SourceRow({ source, index }: { source: Source; index: number }) {
  const Icon = source.sourceType.startsWith('meeting')
    ? Users
    : source.sourceType === 'user_note'
      ? StickyNote
      : source.sourceType === 'entry'
        ? Mic
        : FileText;
  return (
    <button
      onClick={() => {
        // Dispatch the deeplink to whatever handler is registered. For now
        // we route the common cases here; a full main-process URL handler
        // would replace this with a single `window.open(s.deeplink)`-style
        // call once `ironmic://` is registered as a protocol.
        const url = source.deeplink;
        if (url.startsWith('ironmic://meeting/')) {
          const id = url.replace('ironmic://meeting/', '').split('?')[0];
          window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'meetings' }));
          window.dispatchEvent(new CustomEvent('ironmic:open-meeting', { detail: { id } }));
        } else if (url.startsWith('ironmic://note/')) {
          const id = url.replace('ironmic://note/', '');
          window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'dictate' }));
          window.dispatchEvent(new CustomEvent('ironmic:open-note', { detail: { id } }));
        } else if (url.startsWith('ironmic://entry/')) {
          const id = url.replace('ironmic://entry/', '');
          window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'main' }));
          window.dispatchEvent(new CustomEvent('ironmic:open-entry', { detail: { id } }));
        }
      }}
      className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-iron-surface-hover transition-colors group"
    >
      <span className="text-[10px] font-mono text-iron-accent-light bg-iron-accent/10 rounded px-1.5 py-0.5 flex-shrink-0 mt-0.5">
        [{index}]
      </span>
      <Icon className="w-3.5 h-3.5 text-iron-text-muted flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-iron-text truncate">{source.label}</p>
        <p className="text-[11px] text-iron-text-muted truncate mt-0.5">{source.snippet}</p>
      </div>
    </button>
  );
}

// ── Index freshness pill ────────────────────────────────────────────────────

function IndexFreshness({
  stats,
  onRefresh,
}: {
  stats: { total: number; indexed: number; activeModel: string } | null;
  onRefresh: () => void;
}) {
  if (!stats) return null;
  const pct = stats.total > 0 ? Math.round((stats.indexed / stats.total) * 100) : 100;
  // Keyword-only retrieval doesn't need embeddings; we surface the count
  // honestly even though FTS5 search works regardless of embedded count.
  return (
    <button
      onClick={onRefresh}
      title={`${stats.indexed} of ${stats.total} chunks embedded · model: ${stats.activeModel}`}
      className="flex items-center gap-1.5 text-[10px] text-iron-text-muted hover:text-iron-text-secondary transition-colors px-2 py-1 rounded-md hover:bg-iron-surface-hover"
    >
      <div className={`w-1.5 h-1.5 rounded-full ${pct === 100 ? 'bg-iron-success' : 'bg-iron-accent-light'}`} />
      <span>{stats.total} chunks indexed</span>
    </button>
  );
}
