import { useState, useEffect, useRef, useCallback } from 'react';
import { Bot, Send, Mic, Square, RefreshCw, Sparkles, AlertCircle, Plus, MessageSquare, X, Volume2, Pause, BookOpen, StickyNote, MessageCircle } from 'lucide-react';
import { useAiChatStore, type ChatMessage, type AIProvider, type DispatchSendArgs } from '../stores/useAiChatStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useSettingsIntentStore } from '../stores/useSettingsIntentStore';
import { useTtsStore } from '../stores/useTtsStore';
import { NotePickerModal } from './NotePickerModal';
import { VoiceChatOverlay } from './voice-chat/VoiceChatOverlay';
import { AIChatHistoryDrawer } from './ai-chat/AIChatHistoryDrawer';
import type { Note } from '../stores/useNotesStore';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface AuthStatus {
  installed: boolean;
  authenticated: boolean;
  version: string | null;
}

export function AIChat() {
  const [provider, setProvider] = useState<AIProvider | null>(null);
  const [authState, setAuthState] = useState<{ copilot: AuthStatus; claude: AuthStatus; local: AuthStatus } | null>(null);
  const [showNotePicker, setShowNotePicker] = useState(false);
  const [conversational, setConversational] = useState(false);
  const conversationalRef = useRef(false);
  conversationalRef.current = conversational;

  // `mountedRef` is referenced by the `onAssistantText` callback that
  // `dispatchSend` invokes on the success path. The callback may run AFTER
  // this component has unmounted (the user navigated away mid-send and the
  // request kept running inside the store closure). The callback body MUST
  // short-circuit on `!mountedRef.current` before touching any local-state
  // setter (setMicState, etc.), AND on `!conversationalRef.current` so a
  // user who toggled conversational mode off mid-send doesn't get
  // unexpected TTS playback.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Refs synced each render so the dictation listener (mounted with [] deps)
  // and other long-lived callbacks read fresh values without re-binding.
  // Avoids stale-closure bugs in the end-of-turn auto-send path.
  const providerRef = useRef<AIProvider | null>(null);
  const autoSendingRef = useRef(false);
  // `sendTextRef` is now fire-and-forget (no Promise<string | null> return).
  // The lifecycle owner is `dispatchSend` in the store; this ref only
  // exposes the dispatch entry point to long-lived listeners that need
  // a stable reference across re-renders.
  const sendTextRef = useRef<((text: string) => void) | null>(null);
  const engineRef = useRef<'moonshine-session' | 'moonshine-chunked' | 'whisper-chunked' | 'unknown'>('unknown');
  const micStateRef = useRef<'idle' | 'recording' | 'stopping'>('idle');
  // Engine surfaces in the conversational banner so the user knows when
  // hands-free auto-send is unavailable (Whisper / chunked-Moonshine fallback).
  const [engine, setEngine] = useState<'moonshine-session' | 'moonshine-chunked' | 'whisper-chunked' | 'unknown'>('unknown');

  const { activeSession, createSession, setActiveSession } =
    useAiChatStore();

  // Attached-context pills are now per-session and persisted to localStorage
  // via the store. Reading via a selector keyed off `activeSessionId` means:
  //   - navigating away from AIChat doesn't lose attachments
  //   - reloading the app doesn't lose attachments
  //   - switching between chat sessions in the history drawer shows each
  //     session's own attachments (don't bleed across)
  const attachedNotes = useAiChatStore((s) => {
    const id = s.activeSessionId;
    return id ? (s.attachedContextBySession[id] ?? []) : [];
  });

  // Search-mode toggle ("🔍 Search my IronMic"): when on, every send first
  // runs retrieval over the user's full corpus and injects the top-k chunks
  // as context — same prompt shape as a manual attach, but synthesized from
  // the user's query per-turn. Per-session, persisted to localStorage so
  // toggling once sticks for that conversation.
  const searchModeEnabled = useAiChatStore((s) => {
    const id = s.activeSessionId;
    return id ? !!s.searchModeBySession[id] : false;
  });
  /** Master enable for the entire "Search my IronMic" feature. Drives the
   *  visibility of the toggle button; users can also flip the per-chat
   *  toggle off independently. */
  const knowledgeQaEnabled = useSettingsStore((s) => s.knowledgeQaEnabled);
  /** "What's happening right now" indicator beneath the input. Owned by
   *  `dispatchSend` (store) as it walks through retrieval → LLM dispatch
   *  → streaming. Survives navigation because it's per-session in the
   *  store rather than a component-local useState. */
  const sendPhase = useAiChatStore((s) => {
    const id = s.activeSessionId;
    return id ? (s.sendPhaseBySession[id] ?? 'idle') : 'idle';
  });
  /** Streaming token buffer per active session. Tokens are appended by the
   *  Layout-level `onAiOutput` subscription (so they accumulate while the
   *  user is on another tab), and cleared atomically with the
   *  assistant-message commit inside `dispatchSend`. */
  const streaming = useAiChatStore((s) => {
    const id = s.activeSessionId;
    return id ? (s.streamingBySession[id] ?? '') : '';
  });
  /** Source of truth for the disabled / "Stop" state of the send button
   *  and the early-return guard inside `dispatchSend`. Replaces the
   *  former component-local `loading` useState so a mid-send navigate
   *  doesn't reset it to false on remount. */
  const inFlight = useAiChatStore((s) => {
    const id = s.activeSessionId;
    return id ? !!s.inFlightBySession[id] : false;
  });
  // Keep the old local-name `loading` so existing render code reads the
  // same flag without thousands of touch-ups; same value, different source.
  const loading = inFlight;
  /** Most recent failure for the retry card. Survives navigation. */
  const lastError = useAiChatStore((s) => {
    const id = s.activeSessionId;
    return id ? (s.lastErrorBySession[id] ?? null) : null;
  });
  /** Draft text for the active session, or `pendingDraft` when no session
   *  exists yet. Survives navigation so a half-typed prompt isn't lost. */
  const input = useAiChatStore((s) => {
    const id = s.activeSessionId;
    return id ? (s.draftBySession[id] ?? '') : s.pendingDraft;
  });
  /** Setter mirroring the previous local `setInput`. Writes to
   *  `draftBySession[activeSessionId]` or `pendingDraft` when no session
   *  exists. Accepts either a string or a (prev) => next updater so the
   *  existing dictation-chunk-append callsites work unchanged. */
  const setInput = useCallback((next: string | ((prev: string) => string)) => {
    const store = useAiChatStore.getState();
    const id = store.activeSessionId;
    const prev = id ? (store.draftBySession[id] ?? '') : store.pendingDraft;
    const value = typeof next === 'function' ? next(prev) : next;
    store.setDraft(id, value);
  }, []);

  /** Stable read of "is the active session's request currently in flight?"
   *  for use from long-lived listeners ([]-deps useEffects) that can't
   *  close over the reactive `inFlight` selector value. Reading via
   *  `getState()` at call time is the same pattern already used for
   *  `activeSessionId` elsewhere in this component. */
  const isCurrentSessionInFlight = useCallback((): boolean => {
    const store = useAiChatStore.getState();
    const id = store.activeSessionId;
    return id ? !!store.inFlightBySession[id] : false;
  }, []);

  /** Bridge for the prior component-local `setError(msg)` callsites. Routes
   *  the message into the per-session error card. `null` clears. */
  const setError = useCallback((msg: string | null) => {
    const id = useAiChatStore.getState().activeSessionId;
    if (!id) return; // No active session — nowhere to show the error.
    useAiChatStore.getState().setLastError(
      id,
      msg == null ? null : { message: msg, replay: null },
    );
  }, []);

  /** Bridge for the prior component-local `setStreaming('')` callsites
   *  (cleanup paths during cancel / mode-toggle / new-chat). */
  const setStreaming = useCallback((_text: string) => {
    // Only the empty-string clear path is exercised from outside dispatchSend.
    const id = useAiChatStore.getState().activeSessionId;
    if (id) useAiChatStore.getState().clearStreaming(id);
  }, []);

  /** Bridge for the prior component-local `setLoading(false)` callsites
   *  (cancel-on-toggle, voice-chat tear-down). Only the false branch is
   *  exercised from outside dispatchSend. */
  const setLoading = useCallback((flag: boolean) => {
    const id = useAiChatStore.getState().activeSessionId;
    if (id) useAiChatStore.getState().setInFlight(id, flag);
  }, []);

  /** Make sure we have a session id before recording an attach action.
   *  First-time attach creates the session so attachment intent survives
   *  reloads even if the user never hits send. The created session
   *  appears in the history drawer as a "New Chat" until the title
   *  inference (after the first assistant reply) renames it.
   *
   *  Promotes `pendingDraft` into `draftBySession[newId]` so a half-typed
   *  prompt isn't orphaned when the session is created by an attach /
   *  search-mode side effect. */
  const ensureSession = useCallback((): string => {
    return useAiChatStore.getState().ensureAiSessionForDraft(provider ?? null);
  }, [provider]);

  /** Live read of `voice_chat_allow_cloud`. Always re-fetched at decision
   *  time — Settings can flip it OFF in another tab mid-session and we must
   *  honor the new value on the very next EOT. */
  const readVoiceChatAllowCloud = useCallback(async (): Promise<boolean> => {
    try {
      const v = await window.ironmic.getSetting('voice_chat_allow_cloud');
      return v === 'true';
    } catch {
      return false;
    }
  }, []);

  /** Open Settings → AI Assist with the voice-chat toggle scrolled into view. */
  const openCloudVoiceChatSetting = useCallback(() => {
    useSettingsIntentStore.getState().setIntent({
      pendingTab: 'ai',
      focusKey: 'voice_chat_allow_cloud',
    });
    window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'settings' }));
  }, []);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);

  // Track AI Chat container width for the right-side drawer's auto-rail.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === 'number') setContainerWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // AI Chat mic uses the streaming dictation path directly (same engine as
  // Forge / Notes). It does NOT go through useRecordingStore — that path
  // runs the LLM polish pass and persists an `entries` row, both of which
  // are wrong for chat input. See plan: bug-fix-required-in-abundant-duckling.md.
  const [micState, setMicState] = useState<'idle' | 'recording' | 'stopping'>('idle');
  providerRef.current = provider;
  micStateRef.current = micState;
  engineRef.current = engine;
  const [draftText, setDraftText] = useState('');
  // Track whether some OTHER consumer (Forge / Notes) holds the streamer
  // so we can disable our button instead of letting `start()` reject silently.
  const [foreignStreamActive, setForeignStreamActive] = useState(false);

  const session = activeSession();
  const messages = session?.messages ?? [];

  // No per-session cleanup effect needed: streaming / sendPhase / inFlight
  // are all per-session in the store, so switching `activeSessionId`
  // naturally re-selects the right buffer (or 'idle' / '' for sessions
  // without one). A response that's still streaming for the previous
  // session keeps accumulating in its own slot — when the user navigates
  // back, the partial text is still there.
  const activeSessionId = useAiChatStore((s) => s.activeSessionId);

  // Load auth & auto-create session on mount
  useEffect(() => {
    loadAuth();
  }, []);

  // Preload entries and meetings so the attach-context picker is populated
  // the moment the user opens it, instead of showing an empty list while
  // async stores back-fill. NotePickerModal also lazy-loads as a fallback;
  // this just races ahead so the common case is "already there." Cheap —
  // each load is a single paginated SQLite read.
  //
  // Note: the RAG IndexerService is now kicked from Layout on app boot
  // (gated by `knowledge_qa_enabled`), so we don't need a duplicate kick
  // here — kickOnce is idempotent within a session anyway.
  useEffect(() => {
    void (async () => {
      try {
        const { useEntryStore } = await import('../stores/useEntryStore');
        const { useMeetingStore } = await import('../stores/useMeetingStore');
        if (useEntryStore.getState().entries.length === 0) {
          await useEntryStore.getState().loadEntries({ limit: 50, offset: 0 } as any);
        }
        if (useMeetingStore.getState().sessions.length === 0) {
          await useMeetingStore.getState().loadSessions();
        }
      } catch (err) {
        console.warn('[AIChat] Picker preload failed (non-fatal):', err);
      }
    })();
  }, []);

  // Streaming token subscription moved to Layout (Fix 1 — always-mounted
  // sink so events arrive whether or not AIChat is rendered). The store's
  // per-session `streamingBySession` and `sendPhaseBySession` maps replace
  // the former component-local accumulator + phase state.

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streaming]);

  // Listen for navigate-to-session events (from EntryCard "Continue" button)
  useEffect(() => {
    const handler = (e: Event) => {
      const sessionId = (e as CustomEvent).detail;
      if (sessionId) setActiveSession(sessionId);
    };
    window.addEventListener('ironmic:open-ai-session', handler);
    return () => window.removeEventListener('ironmic:open-ai-session', handler);
  }, [setActiveSession]);

  async function loadAuth() {
    try {
      const state = await window.ironmic.aiGetAuthState();
      setAuthState(state);
      // Use saved provider preference, fall back to auto-pick
      const savedProvider = await window.ironmic.getSetting('ai_provider');
      if (savedProvider && (savedProvider === 'claude' || savedProvider === 'copilot' || savedProvider === 'local')) {
        const auth = savedProvider === 'claude' ? state.claude : savedProvider === 'copilot' ? state.copilot : state.local;
        if (auth?.authenticated) {
          setProvider(savedProvider as AIProvider);
          return;
        }
      }
      const best = await window.ironmic.aiPickProvider();
      setProvider(best as AIProvider | null);
    } catch (err) {
      console.error('Failed to load AI auth:', err);
    }
  }

  // Defined here (above sendText) so sendText's auto-listen-after-TTS branch
  // can reference it without a TDZ. Body kept minimal — UI state is mirrored
  // by the onDictationStreamState subscription.
  const startAiDictation = useCallback(async () => {
    const api = (window as any).ironmic;
    if (!api) return;
    try {
      await api.dictationStreamStart({ source: 'ai-chat' });
      setMicState('recording');
    } catch (err: any) {
      const msg = err?.message || String(err);
      // Surface dictation startup errors through the same lastError channel
      // as send errors. Lifts the message into the (now-shared) error card.
      const id = useAiChatStore.getState().activeSessionId;
      if (id) {
        useAiChatStore.getState().setLastError(id, {
          message: msg.includes('already active')
            ? 'Dictation is already running in another window. Stop it first.'
            : msg,
          // No retry payload — this is a dictation startup failure, not a
          // send failure. Null replay tells the UI to hide the Retry
          // button while still rendering the error message + Dismiss.
          replay: null,
        });
      }
    }
  }, []);

  /** Build the post-success TTS / auto-listen callback used by
   *  conversational mode. Closes over `mountedRef` AND `conversationalRef`
   *  so it short-circuits if either becomes invalid mid-send.
   *
   *  Returned closure runs inside `dispatchSend`'s success branch, which
   *  may execute AFTER the component has unmounted (the user navigated
   *  away mid-send). Touching `setMicState` on an unmounted component
   *  would trigger React's "state update on an unmounted component"
   *  warning, and a TTS playback the user no longer wants would just be
   *  annoying. The two gates handle both cases. */
  const buildAssistantTextCallback = useCallback((): ((text: string) => void) => {
    return (response: string) => {
      if (!mountedRef.current || !conversationalRef.current) return;
      if (!response.trim()) return;
      // Strip markdown for cleaner TTS — same logic as the previous inline branch.
      const plainText = response
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/#{1,6}\s/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[>\-|]/g, '')
        .replace(/\n{2,}/g, '. ')
        .replace(/\n/g, ' ')
        .trim();
      if (!plainText) return;
      // Fire-and-forget: synthesize & play, then re-arm dictation when TTS
      // finishes. All operations check both gates so a mid-flight unmount
      // / conversational-off cleanly aborts the chain.
      void (async () => {
        // Use the last assistant message id from the active session as the
        // TTS entry id — close enough for the playback state to track.
        const active = useAiChatStore.getState().activeSession();
        const lastAssistant = active?.messages
          .slice()
          .reverse()
          .find((m) => m.role === 'assistant');
        const ttsEntryId = lastAssistant?.id ?? `ai-${Date.now()}`;
        try {
          await useTtsStore.getState().synthesizeAndPlay(plainText, ttsEntryId);
          const waitForTtsEnd = () => new Promise<void>((resolve) => {
            const check = setInterval(() => {
              if (useTtsStore.getState().state === 'idle') {
                clearInterval(check);
                resolve();
              }
            }, 300);
            setTimeout(() => { clearInterval(check); resolve(); }, 120000);
          });
          await waitForTtsEnd();
          if (mountedRef.current && conversationalRef.current) {
            void startAiDictation();
          }
        } catch {
          /* TTS is optional — failures are silent. */
        }
      })();
    };
  }, [startAiDictation]);

  /** Thin dispatcher. The full request lifecycle (phase, in-flight, retrieval,
   *  IPC, message commits, error capture) lives in `useAiChatStore.dispatchSend`
   *  — see Fix 1. AIChat collects the sync UI snapshot, ensures a session,
   *  fires the dispatch, and returns immediately. NOT awaited so navigating
   *  away mid-send doesn't leave a dangling component-owned Promise. */
  const sendText = useCallback((text: string): void => {
    if (!text || !provider) return;
    // Resolve / create the session BEFORE the dispatch so `pendingDraft`
    // gets promoted into `draftBySession[newId]` correctly.
    const sessionId = useAiChatStore.getState().ensureAiSessionForDraft(provider);

    // Manually attaching items via the picker IS the user's consent for
    // their content to go to the currently-selected provider. We DON'T gate
    // here — gating belongs on the future automatic-retrieval path (RAG),
    // not on an explicit user action.
    const effectiveProvider: AIProvider = provider;

    // Snapshot the current attached notes + search-mode AT DISPATCH TIME
    // (store reads are reactive; we want the values as they are right now,
    // not whatever they happen to be when dispatchSend's awaits resolve).
    const storeNow = useAiChatStore.getState();
    const snapshotAttached = storeNow.attachedContextBySession[sessionId] ?? [];
    const snapshotSearchMode = !!storeNow.searchModeBySession[sessionId];

    void useAiChatStore.getState().dispatchSend({
      sessionId,
      text,
      attachedNotes: snapshotAttached,
      searchModeEnabled: snapshotSearchMode,
      knowledgeQaEnabled,
      effectiveProvider,
      onAssistantText: buildAssistantTextCallback(),
    });
  }, [provider, knowledgeQaEnabled, buildAssistantTextCallback]);

  // Keep a ref to the latest sendText so the long-lived dictation listener
  // (mounted once with [] deps) can call it without re-binding on every change.
  // Note: sendText is now fire-and-forget (no Promise<string | null>). The
  // dictation listener doesn't use the return value, so the type narrowing
  // is purely cosmetic — `sendTextRef.current?.(finalText)` works either way.
  sendTextRef.current = sendText;

  const handleSend = useCallback(async () => {
    const api = (window as any).ironmic;
    // Manual-send fallback: in chunked / Whisper mode, end-of-turn IPC will
    // never fire. The user must press Enter / click Send. We must stop the
    // active dictation session FIRST so we get the authoritative final text
    // — `setInput` from chunk events may not have flushed yet — and so the
    // stream doesn't keep emitting chunks mid-AI-response.
    if (
      api
      && conversationalRef.current
      && micStateRef.current === 'recording'
      && engineRef.current !== 'moonshine-session'
    ) {
      try {
        const stopResult = await api.dictationStreamStop();
        const stopText = (stopResult?.text ?? '').trim();
        const liveText = (inputRef.current?.value ?? '').trim();
        const finalText = stopText.length >= liveText.length ? stopText : liveText;
        if (finalText) {
          await sendTextRef.current?.(finalText);
        }
      } catch (err: any) {
        console.warn('[ai-chat] manual-send fallback stop failed:', err?.message || err);
      }
      return;
    }
    sendText(input.trim());
  }, [input, sendText]);

  // Programmatic prompt insertions still arrive via this event (e.g.
  // ActionRouter "summarize"). Always review before send — drop the
  // legacy conversational auto-send branch.
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent).detail;
      if (!text || typeof text !== 'string') return;
      const trimmed = text.trim();
      if (!trimmed) return;
      setInput((prev) => prev ? prev + ' ' + trimmed : trimmed);
      inputRef.current?.focus();
    };
    window.addEventListener('ironmic:ai-dictation', handler);
    return () => window.removeEventListener('ironmic:ai-dictation', handler);
  }, []);

  // ── Streaming dictation: subscribe to source-tagged events ──
  // Listeners gate on `payload.source === 'ai-chat'` so Notes / Forge
  // streams cannot leak into the chat textarea. Subscriptions live for the
  // lifetime of the AIChat component. If the user navigates away mid-stream,
  // the next mount re-subscribes; the streamer keeps running and the user
  // can stop it from another surface or via the global owner reset.
  useEffect(() => {
    const api = (window as any).ironmic;
    if (!api) return;
    const offChunk = api.onDictationStreamChunk?.((payload: { text: string; isFinal: boolean; source?: string }) => {
      if (payload.source && payload.source !== 'ai-chat') return;
      const text = (payload.text || '').trim();
      if (!text) return;
      // Append every committed chunk (isFinal flags only the end-of-stream marker,
      // not "this is the full transcript"). Drop the draft as it's now committed.
      setInput((prev) => (prev ? prev + ' ' + text : text));
      setDraftText('');
    });
    const offDraft = api.onDictationStreamDraft?.((payload: { hypothesis: string; source?: string }) => {
      if (payload.source && payload.source !== 'ai-chat') return;
      setDraftText(payload.hypothesis || '');
    });
    const offState = api.onDictationStreamState?.((s: { status: string; source?: string; engine?: 'moonshine-session' | 'moonshine-chunked' | 'whisper-chunked' | 'unknown' }) => {
      // Track foreign streams so we can disable the AI Chat mic when Notes/Forge
      // is recording. Our own state is mirrored only on matching source.
      if (s.source && s.source !== 'ai-chat') {
        setForeignStreamActive(s.status !== 'idle');
        return;
      }
      setForeignStreamActive(false);
      if (s.engine) setEngine(s.engine);
      if (s.status === 'idle') {
        setMicState('idle');
        setDraftText('');
      } else if (s.status === 'recording') {
        setMicState('recording');
      } else if (s.status === 'stopping') {
        setMicState('stopping');
      }
    });
    // Voice Chat hands-free auto-send. Fires only on silence-driven commits
    // for `ai-chat` source — never on cap commits or final-stop. Use the
    // event payload directly; React `setInput` from chunk events is async and
    // may not have flushed by the time this handler runs.
    const offEot = api.onDictationStreamEndOfTurn?.(async (payload: { source: 'ai-chat'; text: string }) => {
      if (!conversationalRef.current) return;
      if (autoSendingRef.current || isCurrentSessionInFlight()) return;
      const eotText = (payload?.text || '').trim();
      if (!eotText) return;
      // Cloud guard — read live so a Settings flip in another tab takes
      // effect on the very next turn. When `voice_chat_allow_cloud` is off,
      // refuse + tear down so we never silently auto-send raw dictated
      // speech to a cloud provider.
      if (providerRef.current !== 'local') {
        const allowed = await readVoiceChatAllowCloud();
        if (!allowed) {
          try { await api.dictationStreamStop?.(); } catch { /* ignore */ }
          setConversational(false);
          conversationalRef.current = false;
          setError('Voice Chat is off for cloud providers. Enable it in Settings → AI Assist, or switch to Local.');
          return;
        }
      }
      autoSendingRef.current = true;
      try {
        // Stop FIRST so the streamer commits any tail and releases audio.
        // `stop()` returns the authoritative full text; if its tail is
        // longer than the EOT payload (final-drain caught extra audio),
        // prefer the stop result.
        let finalText = eotText;
        try {
          const stopResult = await api.dictationStreamStop?.();
          const stopText = (stopResult?.text ?? '').trim();
          if (stopText.length > eotText.length) finalText = stopText;
        } catch { /* best effort — fall through with EOT payload */ }
        await sendTextRef.current?.(finalText);
      } finally {
        autoSendingRef.current = false;
      }
    });
    return () => {
      try { offChunk?.(); } catch { /* noop */ }
      try { offDraft?.(); } catch { /* noop */ }
      try { offState?.(); } catch { /* noop */ }
      try { offEot?.(); } catch { /* noop */ }
    };
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  // Voice Chat toggle. Sequence matters: provider guard → start dictation →
  // flip flag last so a failed start doesn't leave a fake conversational state.
  // OFF must tear down dictation, TTS, and any in-flight AI request.
  const handleVoiceChatToggle = useCallback(async () => {
    const api = (window as any).ironmic;
    if (!api) return;
    if (conversationalRef.current) {
      // Toggle OFF
      try { await api.dictationStreamStop?.(); } catch { /* ignore */ }
      try { useTtsStore.getState().stop(); } catch { /* ignore */ }
      if (isCurrentSessionInFlight()) {
        try { await api.aiCancel?.(); } catch { /* ignore */ }
      }
      setConversational(false);
      conversationalRef.current = false;
      // Clear lingering AI streaming state. A late `ai:output` event can
      // arrive between cancel and resolution; clear once here, the existing
      // ai:turn-end handler will clear again when it fires.
      setStreaming('');
      setLoading(false);
      setDraftText('');
      return;
    }
    // Toggle ON — for cloud providers, require both the opt-in setting and
    // an authenticated provider. Without the auth preflight the user would
    // record a turn only to fail at send time, breaking the conversational
    // flow and wasting the spoken prompt.
    if (provider !== 'local') {
      const allowed = await readVoiceChatAllowCloud();
      if (!allowed) {
        setError('Voice Chat is off for cloud providers. Enable it in Settings → AI Assist, or switch to Local.');
        return;
      }
      const auth = provider === 'claude' ? authState?.claude : authState?.copilot;
      if (!auth?.authenticated) {
        const label = provider === 'claude' ? 'Claude' : 'Copilot';
        setError(`Sign in to ${label} first. Voice Chat needs an authenticated provider.`);
        return;
      }
    }
    if (foreignStreamActive) {
      setError('Dictation is already running in another window. Stop it first.');
      return;
    }
    setError(null);
    try {
      await api.dictationStreamStart({ source: 'ai-chat' });
      setMicState('recording');
    } catch (err: any) {
      const msg = err?.message || String(err);
      setError(msg.includes('already')
        ? 'Dictation is already running in another window. Stop it first.'
        : msg);
      return; // Toggle stays off — failed start must not leave a fake state.
    }
    setConversational(true);
    conversationalRef.current = true;
  }, [provider, foreignStreamActive, authState, readVoiceChatAllowCloud]);

  // Mid-loop provider switch: if the user flips to a cloud provider while
  // Voice Chat is active, only tear down when the cloud opt-in is OFF.
  // When opt-in is ON, the loop keeps running against the new provider —
  // the badge in the overlay tells the user where the next turn is going.
  useEffect(() => {
    if (!conversationalRef.current) return;
    if (provider === 'local') return;
    const api = (window as any).ironmic;
    if (!api) return;
    (async () => {
      const allowed = await readVoiceChatAllowCloud();
      if (allowed) return; // continue loop against the new cloud provider
      try { await api.dictationStreamStop?.(); } catch { /* ignore */ }
      try { useTtsStore.getState().stop(); } catch { /* ignore */ }
      if (isCurrentSessionInFlight()) {
        try { await api.aiCancel?.(); } catch { /* ignore */ }
      }
      setConversational(false);
      conversationalRef.current = false;
      setStreaming('');
      setLoading(false);
      setError('Voice Chat disabled — cloud opt-in is off. Enable it in Settings → AI Assist, or switch back to Local.');
    })();
  }, [provider, readVoiceChatAllowCloud]);

  const handleVoiceInput = useCallback(async () => {
    const api = (window as any).ironmic;
    if (!api) return;
    if (micState === 'idle') {
      if (foreignStreamActive) {
        setError('Dictation is already running in another window. Stop it first.');
        return;
      }
      await startAiDictation();
    } else if (micState === 'recording') {
      setMicState('stopping');
      try { await api.dictationStreamStop(); }
      catch (err: any) {
        // Force-reset local UI; the state event will follow.
        console.warn('[ai-chat] dictationStreamStop failed:', err?.message || err);
        setMicState('idle');
      }
    }
  }, [micState, foreignStreamActive, startAiDictation]);

  const handleNewChat = useCallback(() => {
    const id = createSession(provider);
    setActiveSession(id);
    setStreaming('');
    setError(null);
    // Note: NOT calling aiResetSession(id) here. A brand-new session id
    // has no context in main to clear by definition, and the reset was
    // racing with the user's first send-message — it would SIGTERM the
    // freshly-spawned Claude/Copilot CLI process before any output came
    // back, surfacing as "exited with code null". The aiManager's
    // localHistories / cliTurnCounts are keyed by sessionId, so a new id
    // simply has no entry to wipe.
  }, [createSession, setActiveSession, provider]);

  const noProvider = !provider;

  // Hidden sizer mirror — measures the height the textarea would need to fit
  // input + grey draft text, so the overlay never clips while Moonshine is
  // streaming a long hypothesis. We avoid mutating the textarea's value
  // (would fight React's controlled-component model).
  const sizerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const ta = inputRef.current;
    const sizer = sizerRef.current;
    if (!ta || !sizer) return;
    const h = Math.min(sizer.scrollHeight, 120);
    ta.style.height = Math.max(40, h) + 'px';
  }, [input, draftText]);

  // Last assistant reply (for the Voice Chat overlay caption — gives the user
  // visual context for what's being spoken aloud). Falls back to null on
  // first turn or if only system messages exist.
  const lastAiReply = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return messages[i].content;
    }
    return null;
  })();

  return (
    <div ref={containerRef} className="flex h-full bg-iron-bg">
      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        {/* Voice Chat overlay — focused listening surface, only when active */}
        {conversational && (
          <VoiceChatOverlay
            micState={micState}
            loading={loading}
            streaming={streaming}
            draftText={draftText}
            committedText={input}
            engine={engine}
            lastAiReply={lastAiReply}
            provider={provider}
            onClose={() => void handleVoiceChatToggle()}
            onMicClick={() => void handleVoiceInput()}
          />
        )}
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-iron-border">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-iron-accent/10 text-iron-accent-light">
              <MessageSquare className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-iron-text">
                {session?.title || 'AI Assistant'}
              </h3>
              <div className="flex items-center gap-2 mt-0.5">
                {provider && (
                  <div className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-iron-success" />
                    <span className="text-[10px] text-iron-text-muted capitalize">{provider}</span>
                  </div>
                )}
                {!provider && authState && (
                  <span className="text-[10px] text-iron-text-muted">No AI provider connected</span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {authState && (
              <div className="flex items-center gap-1 mr-2">
                <ProviderPill
                  name="Claude"
                  status={authState.claude}
                  active={provider === 'claude'}
                  onClick={() => authState.claude.authenticated && setProvider('claude')}
                />
                <ProviderPill
                  name="Copilot"
                  status={authState.copilot}
                  active={provider === 'copilot'}
                  onClick={() => authState.copilot.authenticated && setProvider('copilot')}
                />
                <ProviderPill
                  name="Local"
                  status={authState.local}
                  active={provider === 'local'}
                  onClick={() => authState.local?.authenticated && setProvider('local')}
                />
              </div>
            )}
            {/* Voice Chat toggle (hands-free conversational mode) */}
            <button
              onClick={() => void handleVoiceChatToggle()}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all ${
                conversational
                  ? 'bg-iron-success/15 text-iron-success border border-iron-success/20'
                  : 'text-iron-text-muted hover:bg-iron-surface-hover'
              }`}
              title={conversational ? 'Voice Chat ON — click to turn off' : 'Turn on Voice Chat (hands-free voice back-and-forth)'}
            >
              <MessageCircle className="w-3.5 h-3.5" />
              Voice Chat
            </button>
            <button
              onClick={() => loadAuth()}
              className="p-1.5 rounded-lg text-iron-text-muted hover:text-iron-text-secondary hover:bg-iron-surface-hover transition-colors"
              title="Refresh auth status"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleNewChat}
              className="p-1.5 rounded-lg text-iron-text-muted hover:text-iron-text-secondary hover:bg-iron-surface-hover transition-colors"
              title="New chat"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {messages.length === 0 && !loading && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-12 h-12 rounded-2xl bg-iron-accent/10 flex items-center justify-center mb-4">
                <Bot className="w-6 h-6 text-iron-accent-light" />
              </div>
              <p className="text-sm font-medium text-iron-text">AI Assistant</p>
              <p className="text-xs text-iron-text-muted mt-1 max-w-[280px]">
                {noProvider
                  ? 'No AI provider detected. Install and authenticate GitHub Copilot CLI or Claude Code CLI.'
                  : 'Ask anything. You can type or use the mic button to dictate your question.'}
              </p>
            </div>
          )}

          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}

          {loading && streaming && (
            <div className="flex gap-3">
              <div className="w-6 h-6 rounded-md bg-iron-accent/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Bot className="w-3.5 h-3.5 text-iron-accent-light" />
              </div>
              <div className="prose-chat text-sm text-iron-text leading-relaxed">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {streaming}
                </ReactMarkdown>
                <span className="inline-block w-1.5 h-4 bg-iron-accent ml-0.5 animate-pulse" />
              </div>
            </div>
          )}

          {loading && !streaming && (
            <div className="flex items-center gap-2 text-iron-text-muted">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-iron-accent animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-iron-accent animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-iron-accent animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
              {/* Phase-aware status. Cloud CLIs take ~5–10s to cold-start
                  before the first token arrives — without this the user has
                  no signal anything is happening. Reading the active phase
                  here lets us say "Searching your knowledge…" while the
                  retrieval call is in flight and "Sending to {provider}…"
                  while waiting on the LLM. Once streaming, the streaming
                  bubble above takes over and this whole block hides. */}
              <span className="text-xs">
                {sendPhase === 'retrieving'
                  ? 'Searching your knowledge…'
                  : sendPhase === 'sending'
                    ? `Sending to ${provider === 'claude' ? 'Claude' : provider === 'copilot' ? 'Copilot' : 'local model'}…`
                    : 'Thinking…'}
              </span>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="px-4 py-3 border-t border-iron-border">
          {lastError && (
            <div
              className="flex items-start gap-2 mb-2 rounded-lg border border-iron-danger/30 bg-iron-danger/5 px-3 py-2"
              role="alert"
            >
              <AlertCircle className="w-3.5 h-3.5 text-iron-danger flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-iron-danger break-words">
                  {lastError.message}
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  {/* Retry replays the EXACT request that failed — same prompt,
                      same attachments, same provider, same resolved model.
                      Hidden when replay is null (e.g. a dictation-startup
                      failure rather than a send failure). */}
                  {lastError.replay && (
                    <button
                      onClick={() => {
                        const id = useAiChatStore.getState().activeSessionId;
                        if (!id) return;
                        const err = useAiChatStore.getState().lastErrorBySession[id];
                        if (!err?.replay) return;
                        useAiChatStore.getState().setLastError(id, null);
                        void useAiChatStore.getState().dispatchSend(err.replay);
                      }}
                      className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-iron-accent/10 text-iron-accent-light hover:bg-iron-accent/20 transition-colors"
                      title="Retry with the same prompt and provider"
                    >
                      <RefreshCw className="w-3 h-3" />
                      Retry
                    </button>
                  )}
                  <button
                    onClick={() => {
                      const id = useAiChatStore.getState().activeSessionId;
                      if (id) useAiChatStore.getState().setLastError(id, null);
                    }}
                    className="text-[11px] px-2 py-1 rounded-md text-iron-text-muted hover:text-iron-text-secondary hover:bg-iron-surface-hover transition-colors"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Conversational mode indicator */}
          {conversational && (
            <div className="flex items-center gap-2 mb-2 px-1">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-iron-success opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-iron-success" />
              </span>
              <span className="text-[11px] text-iron-success font-medium">
                {micState === 'recording' ? 'Listening...' : loading ? 'AI is thinking...' : 'Voice chat active — speak or type'}
              </span>
            </div>
          )}

          {/* Attached-context pills — persistent across turns until the user
              clears them. Each turn re-sends the full context block as part
              of the current message, so the LLM always has the canonical
              source text in hand. The pill row is meant to read like a
              filter bar in a search UI: "what does the AI know about right
              now?" The kind icon + color makes the source type unmistakable
              at a glance even with many pills attached. */}
          {attachedNotes.length > 0 && (
            <div className="flex items-center gap-1.5 mb-2 flex-wrap rounded-lg bg-iron-bg/40 border border-iron-border px-2 py-1.5">
              <span className="text-[10px] uppercase tracking-wide text-iron-text-muted">
                Context · {attachedNotes.length}
              </span>
              {attachedNotes.map((n) => {
                const kind: 'note' | 'dictation' | 'meeting' = n.id.startsWith('dictation:')
                  ? 'dictation'
                  : n.id.startsWith('meeting:')
                    ? 'meeting'
                    : 'note';
                const palette =
                  kind === 'dictation' ? 'bg-iron-accent/15 text-iron-accent-light border-iron-accent/25'
                  : kind === 'meeting'  ? 'bg-amber-500/15 text-amber-400 border-amber-500/25'
                  : 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25';
                const Icon = kind === 'dictation' ? Mic : kind === 'meeting' ? MessageSquare : StickyNote;
                return (
                  <span
                    key={n.id}
                    className={`group inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border max-w-[200px] ${palette}`}
                    title={`${kind === 'meeting' ? 'Meeting' : 'Note'}: ${n.title || 'Untitled'}`}
                  >
                    <Icon className="w-3 h-3 flex-shrink-0" />
                    <span className="truncate">{n.title || 'Untitled'}</span>
                    <button
                      onClick={() => {
                        const id = useAiChatStore.getState().activeSessionId;
                        if (id) useAiChatStore.getState().removeAttachment(id, n.id);
                      }}
                      className="ml-0.5 opacity-60 hover:opacity-100 hover:text-iron-danger flex-shrink-0"
                      aria-label={`Detach ${n.title || 'item'}`}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                );
              })}
              {attachedNotes.length > 1 && (
                <button
                  onClick={() => {
                    const id = useAiChatStore.getState().activeSessionId;
                    if (id) useAiChatStore.getState().clearAttachments(id);
                  }}
                  className="ml-auto text-[10px] text-iron-text-muted hover:text-iron-danger underline-offset-2 hover:underline"
                >
                  Clear all
                </button>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            {/* Mic button */}
            <button
              onClick={handleVoiceInput}
              disabled={foreignStreamActive || micState === 'stopping'}
              className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed ${
                micState === 'recording'
                  ? 'bg-iron-danger text-white shadow-glow-danger animate-pulse-recording'
                  : 'bg-iron-surface-hover text-iron-text-muted hover:text-iron-text-secondary'
              }`}
              title={
                foreignStreamActive
                  ? 'Dictation is active in another window'
                  : micState === 'recording'
                    ? 'Stop recording'
                    : micState === 'stopping'
                      ? 'Stopping…'
                      : 'Dictate message'
              }
            >
              <Mic className="w-4 h-4" />
            </button>

            {/* Add note/memory button */}
            <button
              onClick={() => setShowNotePicker(true)}
              className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all flex-shrink-0 ${
                attachedNotes.length > 0
                  ? 'bg-emerald-500/15 text-emerald-400'
                  : 'bg-iron-surface-hover text-iron-text-muted hover:text-iron-text-secondary'
              }`}
              title="Attach a note as context"
            >
              <BookOpen className="w-4 h-4" />
            </button>

            {/* Search-my-IronMic toggle. When ON, every send first runs
                retrieval over the user's full corpus (notes + dictations +
                meetings via FTS5) and injects the top-k chunks as context.
                Auto-curation rather than manual attach — same UX intent as
                ChatGPT's "Search the web" button. Per-session, persisted.
                A small indicator next to the icon makes the state visible
                even when toggled idle. Hidden entirely when the user has
                disabled Knowledge Q&A in Settings. */}
            {knowledgeQaEnabled && (
              <button
                onClick={() => {
                  const id = ensureSession();
                  useAiChatStore.getState().setSearchMode(id, !searchModeEnabled);
                }}
                className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all flex-shrink-0 ${
                  searchModeEnabled
                    ? 'bg-iron-accent/15 text-iron-accent-light shadow-glow'
                    : 'bg-iron-surface-hover text-iron-text-muted hover:text-iron-text-secondary'
                }`}
                title={searchModeEnabled
                  ? 'Search my IronMic is ON — each send will retrieve and inject the most relevant chunks from your full corpus before asking the model.'
                  : 'Search my IronMic — turn on to have the AI auto-pull context from your notes, dictations, and meetings on every send.'}
                aria-pressed={searchModeEnabled}
              >
                <Sparkles className="w-4 h-4" />
              </button>
            )}

            {/*
              Text input + inline grey-draft overlay.

              Notes uses TipTap with a ProseMirror widget that paints the live
              Moonshine hypothesis as grey-italic inline text right after the
              cursor. We can't put mixed-style spans inside a real <textarea>,
              so we mimic the same UX with an absolutely-positioned overlay
              that mirrors the textarea's geometry. While the draft is visible,
              we hide the textarea's own glyphs (text-transparent) so only the
              overlay paints — committed text in normal color, draft appended
              inline in grey italic. Caret stays on the real textarea so typing
              and editing keep working.
            */}
            <div className="flex-1 min-w-0 relative">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={draftText ? '' : noProvider ? 'No AI provider connected...' : 'Type a message or use the mic...'}
                disabled={noProvider}
                rows={1}
                className={`w-full text-sm leading-5 bg-iron-surface border border-iron-border rounded-xl placeholder:text-iron-text-muted px-4 py-2.5 resize-none transition-all focus:outline-none focus:border-iron-accent/50 focus:shadow-glow disabled:opacity-40 disabled:cursor-not-allowed ${
                  draftText ? 'text-transparent caret-iron-text' : 'text-iron-text'
                }`}
                style={{ maxHeight: '120px', minHeight: '40px' }}
              />
              {/* Hidden sizing mirror — same width/font/padding as the textarea.
                  Used by the auto-resize effect to measure how tall the textarea
                  needs to be to accommodate input + grey draft without clipping. */}
              <div
                ref={sizerRef}
                aria-hidden="true"
                className="invisible absolute top-0 left-0 right-0 text-sm leading-5 px-4 py-2.5 whitespace-pre-wrap break-words"
                style={{ font: 'inherit', minHeight: '40px' }}
              >
                {input}{input && draftText ? ' ' : ''}{draftText || ' '}
              </div>
              {draftText && (
                <div
                  aria-hidden="true"
                  className="absolute inset-0 pointer-events-none text-sm leading-5 px-4 py-2.5 whitespace-pre-wrap break-words overflow-hidden"
                  style={{ font: 'inherit' }}
                >
                  <span className="ai-chat-dictation-committed">{input}</span>
                  <span className="ai-chat-dictation-draft">
                    {input ? ' ' : ''}{draftText}
                  </span>
                </div>
              )}
            </div>

            {/* Send / Stop button */}
            <button
              onClick={loading ? () => window.ironmic.aiCancel() : () => void handleSend()}
              disabled={noProvider || (!input.trim() && !loading)}
              className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
                loading
                  ? 'bg-iron-danger/15 hover:bg-iron-danger/25'
                  : 'bg-iron-accent/15 hover:bg-iron-accent/25'
              }`}
              title={loading ? 'Stop' : 'Send'}
            >
              {loading ? (
                <Square className="w-4 h-4 text-iron-danger" />
              ) : (
                <Send className="w-4 h-4 text-iron-accent-light" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Right-side chat history drawer (auto-rails on narrow widths) */}
      <AIChatHistoryDrawer
        containerWidth={containerWidth}
        onNewChat={handleNewChat}
      />

      {/* Note picker modal — stays open after each pick so the user can
          keep adding sources in one motion. Closing is explicit (X button,
          ESC, or backdrop click). Selected items render as pills inside
          the modal too, so detaching can happen without dismissing.
          Attaching here auto-creates a session if there isn't one yet so
          the attachment is persisted from the moment of intent. */}
      <NotePickerModal
        open={showNotePicker}
        onClose={() => setShowNotePicker(false)}
        onSelect={(note) => {
          const id = ensureSession();
          useAiChatStore.getState().addAttachment(id, note);
        }}
        selectedNotes={attachedNotes}
        onDeselect={(id) => {
          const sid = useAiChatStore.getState().activeSessionId;
          if (sid) useAiChatStore.getState().removeAttachment(sid, id);
        }}
      />
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const { state: ttsState, activeEntryId, synthesizeAndPlay, stop } = useTtsStore();

  // Use message ID as the "entry ID" for TTS tracking
  const isThisPlaying = activeEntryId === message.id && (ttsState === 'playing' || ttsState === 'synthesizing');

  const handleReadAloud = async () => {
    if (isThisPlaying) {
      await stop();
    } else {
      // Strip markdown for cleaner TTS — remove common syntax
      const plainText = message.content
        .replace(/```[\s\S]*?```/g, '') // remove code blocks
        .replace(/`([^`]+)`/g, '$1')    // inline code → text
        .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
        .replace(/\*([^*]+)\*/g, '$1')     // italic
        .replace(/#{1,6}\s/g, '')          // headings
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
        .replace(/[>\-|]/g, '')            // blockquote, list, table chars
        .replace(/\n{2,}/g, '. ')          // paragraph breaks → pause
        .replace(/\n/g, ' ')
        .trim();
      if (plainText) {
        await synthesizeAndPlay(plainText, message.id);
      }
    }
  };

  if (isSystem) {
    return (
      <div className="flex justify-center">
        <span className="text-[11px] text-iron-danger bg-iron-danger/10 px-3 py-1 rounded-full">
          {message.content}
        </span>
      </div>
    );
  }

  return (
    <div className={`flex gap-3 group ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 mt-0.5 ${
        isUser ? 'bg-iron-accent/20' : 'bg-iron-accent/10'
      }`}>
        {isUser ? (
          <span className="text-[10px] font-bold text-iron-accent-light">U</span>
        ) : (
          <Bot className="w-3.5 h-3.5 text-iron-accent-light" />
        )}
      </div>
      <div className={`max-w-[80%] ${isUser ? 'text-right' : ''}`}>
        <div className={`inline-block text-sm leading-relaxed rounded-xl px-3.5 py-2 ${
          isUser
            ? 'bg-iron-accent/15 text-iron-text whitespace-pre-wrap'
            : 'bg-iron-surface text-iron-text border border-iron-border'
        }`}>
          {isUser ? (
            message.content
          ) : (
            <div className="prose-chat">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {message.content}
              </ReactMarkdown>
            </div>
          )}
        </div>
        {/* Actions row */}
        <div className={`flex items-center gap-2 mt-1 ${isUser ? 'justify-end' : ''}`}>
          {message.provider && !isUser && (
            <span className="text-[10px] text-iron-text-muted capitalize">via {message.provider}</span>
          )}
          <button
            onClick={handleReadAloud}
            className={`p-1 rounded-md transition-all ${
              isThisPlaying
                ? 'text-iron-accent-light bg-iron-accent/10'
                : 'text-iron-text-muted/0 group-hover:text-iron-text-muted hover:!text-iron-accent-light hover:bg-iron-surface-hover'
            }`}
            title={isThisPlaying ? 'Stop reading' : 'Read aloud'}
          >
            {isThisPlaying ? (
              <Pause className="w-3 h-3" />
            ) : (
              <Volume2 className="w-3 h-3" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProviderPill({ name, status, active, onClick }: {
  name: string; status: AuthStatus; active: boolean; onClick: () => void;
}) {
  const connected = status.installed && status.authenticated;

  return (
    <button
      onClick={onClick}
      disabled={!connected}
      className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium transition-all ${
        active
          ? 'bg-iron-accent/15 text-iron-accent-light border border-iron-accent/20'
          : connected
          ? 'text-iron-text-muted hover:bg-iron-surface-hover'
          : 'text-iron-text-muted/40 cursor-not-allowed'
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${
        connected ? 'bg-iron-success' : 'bg-iron-text-muted/30'
      }`} />
      {name}
    </button>
  );
}
