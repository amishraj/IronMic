import { create } from 'zustand';

export type AIProvider = 'copilot' | 'claude' | 'local';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  provider?: AIProvider;
  timestamp: number;
}

export interface AiSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  provider: AIProvider | null;
  createdAt: number;
  updatedAt: number;
  // Persistence-aware fields (v1.8.x)
  messagesLoaded: boolean;
  lastMessagePreview: string | null;
  isPinned: boolean;
  isArchived: boolean;
}

export interface AiSessionSearchHit {
  session: AiSession;
  snippet: string;
  matchedMessageId: string;
}

interface AiChatStore {
  sessions: AiSession[];
  activeSessionId: string | null;
  hydrated: boolean;
  hydrationError: string | null;
  /** Sessions for which a delete tombstone has been enqueued — further writes
   *  against this id are rejected at the API boundary so a late append can't
   *  resurrect the row. */
  closedForWrites: Set<string>;

  // Getters
  activeSession: () => AiSession | null;

  // Actions (sync where existing callers depend on it; async for read paths)
  hydrate: () => Promise<void>;
  createSession: (provider: AIProvider | null) => string;
  setActiveSession: (id: string) => void;
  ensureMessagesLoaded: (id: string) => Promise<void>;
  addMessage: (sessionId: string, message: ChatMessage) => void;
  deleteSession: (id: string) => void;
  updateSessionTitle: (id: string, title: string) => void;
  pinSession: (id: string, pinned: boolean) => void;
  archiveSession: (id: string, archived: boolean) => void;
  searchSessions: (query: string, limit?: number) => Promise<AiSessionSearchHit[]>;
}

function generateId(): string {
  // crypto.randomUUID is the same shape Rust uses; renderer + Rust agree on id.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function deriveTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return 'New Chat';
  const text = first.content.slice(0, 60);
  return text.length < first.content.length ? text + '...' : text;
}

const MIGRATED_FLAG = 'ironmic-ai-sessions-migrated';
const LEGACY_KEY = 'ironmic-ai-sessions';
const PROVIDERS: ReadonlySet<string> = new Set(['copilot', 'claude', 'local']);

function isoToMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Date.now();
}

interface RustSession {
  id: string;
  title: string;
  provider: string | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
  last_message_preview: string | null;
  is_pinned: boolean;
  is_archived: boolean;
}

interface RustMessage {
  id: string;
  session_id: string;
  role: string;
  content: string;
  provider: string | null;
  created_at: string;
}

function rustToSession(s: RustSession, messages: ChatMessage[] = [], messagesLoaded = false): AiSession {
  return {
    id: s.id,
    title: s.title || 'New Chat',
    provider: s.provider && PROVIDERS.has(s.provider) ? (s.provider as AIProvider) : null,
    messages,
    createdAt: isoToMs(s.created_at),
    updatedAt: isoToMs(s.updated_at),
    messagesLoaded,
    lastMessagePreview: s.last_message_preview,
    isPinned: !!s.is_pinned,
    isArchived: !!s.is_archived,
  };
}

function rustToMessage(m: RustMessage): ChatMessage {
  const role = (m.role === 'user' || m.role === 'assistant' || m.role === 'system' ? m.role : 'assistant') as ChatMessage['role'];
  return {
    id: m.id,
    role,
    content: m.content,
    provider: m.provider && PROVIDERS.has(m.provider) ? (m.provider as AIProvider) : undefined,
    timestamp: isoToMs(m.created_at),
  };
}

// ── Per-session serialized write queue ──────────────────────────────────────
// Every persistence call for a given session is awaited in order. This solves
// the FK race: appendMessage cannot run before aiChatCreateSession finishes
// because it sits behind it in the same queue. Failures are surfaced via
// console + (future) toast hook; the in-memory store stays optimistic.

const queues = new Map<string, Promise<unknown>>();
function enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(sessionId) ?? Promise.resolve();
  const next = prev.then(task, task); // run task even if previous failed
  queues.set(
    sessionId,
    next.catch(() => {}),
  );
  return next;
}

function api() {
  return (window as any).ironmic;
}

async function migrateLocalStorageOnce(): Promise<void> {
  if (typeof localStorage === 'undefined') return;
  if (localStorage.getItem(MIGRATED_FLAG) === '1') return;
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) {
    localStorage.setItem(MIGRATED_FLAG, '1');
    return;
  }
  let legacy: any[];
  try {
    legacy = JSON.parse(raw);
  } catch {
    localStorage.setItem(MIGRATED_FLAG, '1');
    return;
  }
  if (!Array.isArray(legacy) || legacy.length === 0) {
    localStorage.removeItem(LEGACY_KEY);
    localStorage.setItem(MIGRATED_FLAG, '1');
    return;
  }

  const a = api();
  if (!a?.aiChatCreateSession || !a.aiChatAppendMessage) {
    // Native bridge not ready (stub mode). Don't drop the legacy data.
    return;
  }
  try {
    for (const sess of legacy) {
      if (!sess?.id) continue;
      const createdIso = sess.createdAt ? new Date(sess.createdAt).toISOString() : undefined;
      const updatedIso = sess.updatedAt ? new Date(sess.updatedAt).toISOString() : undefined;
      await a.aiChatCreateSession(
        String(sess.id),
        String(sess.title ?? 'New Chat'),
        sess.provider && PROVIDERS.has(sess.provider) ? sess.provider : null,
        createdIso,
        updatedIso,
      );
      const messages: any[] = Array.isArray(sess.messages) ? sess.messages : [];
      for (const m of messages) {
        if (!m?.id || !m?.content) continue;
        const tsIso = m.timestamp ? new Date(m.timestamp).toISOString() : undefined;
        await a.aiChatAppendMessage(
          String(sess.id),
          String(m.role ?? 'user'),
          String(m.content),
          m.provider && PROVIDERS.has(m.provider) ? m.provider : null,
          String(m.id),
          tsIso,
        );
      }
    }
    localStorage.removeItem(LEGACY_KEY);
    localStorage.setItem(MIGRATED_FLAG, '1');
    console.info('[ai-chat] Migrated', legacy.length, 'sessions from localStorage to SQLite.');
  } catch (err) {
    // Keep legacy data so the user can retry on next launch.
    console.error('[ai-chat] localStorage migration failed:', err);
  }
}

export const useAiChatStore = create<AiChatStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  hydrated: false,
  hydrationError: null,
  closedForWrites: new Set(),

  activeSession: () => {
    const { sessions, activeSessionId } = get();
    return sessions.find((s) => s.id === activeSessionId) || null;
  },

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      await migrateLocalStorageOnce();
      const a = api();
      if (!a?.aiChatListSessions) {
        // Bridge unavailable — leave sessions empty but mark hydrated so the
        // UI doesn't spin forever in dev/stub mode.
        set({ hydrated: true });
        return;
      }
      const json: string = await a.aiChatListSessions(500, 0, false);
      const rows: RustSession[] = JSON.parse(json);
      const sessions = rows.map((r) => rustToSession(r));
      set({ sessions, hydrated: true, hydrationError: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[ai-chat] hydrate failed:', err);
      set({ hydrated: true, hydrationError: msg });
    }
  },

  createSession: (provider) => {
    const id = generateId();
    const now = Date.now();
    const session: AiSession = {
      id,
      title: 'New Chat',
      messages: [],
      provider,
      createdAt: now,
      updatedAt: now,
      messagesLoaded: true, // brand new — nothing to load
      lastMessagePreview: null,
      isPinned: false,
      isArchived: false,
    };
    const sessions = [session, ...get().sessions];
    set({ sessions, activeSessionId: id });

    // Persist asynchronously through the per-session queue.
    //
    // Used to enqueue a defensive `aiResetSession(id)` here too
    // ("impossible in practice but cheap"). It wasn't cheap — it was the
    // root cause of "claude exited with code null" on the first message
    // of every new chat. The reset fires `aiManager.cancel()` on whatever
    // CLI process is currently active, and there's a window where the
    // user's first send has already spawned the Claude/Copilot process
    // but the reset hasn't run yet. The queue then runs the reset and
    // SIGTERMs the spawn before any output arrives. A brand-new session
    // id has no context to clear by definition, so the enqueue was pure
    // overhead with a sharp edge — removed.
    enqueue(id, async () => {
      const a = api();
      if (!a?.aiChatCreateSession) return;
      try {
        await a.aiChatCreateSession(id, session.title, provider, null, null);
      } catch (err) {
        console.error('[ai-chat] createSession persist failed:', err);
      }
    });
    return id;
  },

  setActiveSession: (id) => {
    set({ activeSessionId: id });
    // Lazy-load messages for resumed sessions. Fire-and-forget — the
    // ensureMessagesLoaded action handles deduping.
    void get().ensureMessagesLoaded(id);
  },

  ensureMessagesLoaded: async (id) => {
    const sess = get().sessions.find((s) => s.id === id);
    if (!sess || sess.messagesLoaded) return;
    const a = api();
    if (!a?.aiChatGetSession) return;
    try {
      const json: string = await a.aiChatGetSession(id);
      if (!json || json === 'null') {
        // Row gone (deleted underneath us). Mark loaded so we don't loop.
        set({
          sessions: get().sessions.map((s) =>
            s.id === id ? { ...s, messagesLoaded: true } : s,
          ),
        });
        return;
      }
      const parsed: RustSession & { messages: RustMessage[] } = JSON.parse(json);
      const messages = (parsed.messages ?? []).map(rustToMessage);
      set({
        sessions: get().sessions.map((s) =>
          s.id === id
            ? { ...rustToSession(parsed, messages, true) }
            : s,
        ),
      });
    } catch (err) {
      console.error('[ai-chat] ensureMessagesLoaded failed:', err);
    }
  },

  addMessage: (sessionId, message) => {
    if (get().closedForWrites.has(sessionId)) {
      console.warn('[ai-chat] addMessage rejected — session is closed for writes:', sessionId);
      return;
    }
    const sessions = get().sessions.map((s) => {
      if (s.id !== sessionId) return s;
      const messages = [...s.messages, message];
      const isFirstUserMsg = !s.messages.some((m) => m.role === 'user') && message.role === 'user';
      const title = isFirstUserMsg ? deriveTitle(messages) : s.title;
      return {
        ...s,
        messages,
        title,
        updatedAt: Date.now(),
        lastMessagePreview: message.content.slice(0, 120),
      };
    });
    set({ sessions });

    enqueue(sessionId, async () => {
      const a = api();
      if (!a?.aiChatAppendMessage) return;
      try {
        const tsIso = new Date(message.timestamp).toISOString();
        await a.aiChatAppendMessage(
          sessionId,
          message.role,
          message.content,
          message.provider ?? null,
          message.id,
          tsIso,
        );
        // If we just used the first user message to derive a title, persist it.
        const updated = get().sessions.find((s) => s.id === sessionId);
        if (updated && updated.messages.length === 1 && message.role === 'user') {
          await a.aiChatRenameSession?.(sessionId, updated.title);
        }
      } catch (err) {
        console.error('[ai-chat] addMessage persist failed:', err);
      }
    });
  },

  deleteSession: (id) => {
    const sessions = get().sessions.filter((s) => s.id !== id);
    const activeSessionId = get().activeSessionId === id ? null : get().activeSessionId;
    const closedForWrites = new Set(get().closedForWrites);
    closedForWrites.add(id);
    set({ sessions, activeSessionId, closedForWrites });

    // Tombstone runs at the tail of the queue — prior writes drain in order.
    enqueue(id, async () => {
      const a = api();
      try { await a?.aiResetSession?.(id); } catch { /* ignore */ }
      try { await a?.aiChatDeleteSession?.(id); } catch (err) {
        console.error('[ai-chat] deleteSession persist failed:', err);
      }
      // Drop the queue entry so we don't leak.
      queues.delete(id);
    });
  },

  updateSessionTitle: (id, title) => {
    if (get().closedForWrites.has(id)) return;
    const sessions = get().sessions.map((s) =>
      s.id === id ? { ...s, title } : s,
    );
    set({ sessions });
    enqueue(id, async () => {
      const a = api();
      try { await a?.aiChatRenameSession?.(id, title); } catch (err) {
        console.error('[ai-chat] rename persist failed:', err);
      }
    });
  },

  pinSession: (id, pinned) => {
    if (get().closedForWrites.has(id)) return;
    const sessions = get().sessions.map((s) =>
      s.id === id ? { ...s, isPinned: pinned } : s,
    );
    set({ sessions });
    enqueue(id, async () => {
      const a = api();
      try { await a?.aiChatPinSession?.(id, pinned); } catch (err) {
        console.error('[ai-chat] pin persist failed:', err);
      }
    });
  },

  archiveSession: (id, archived) => {
    if (get().closedForWrites.has(id)) return;
    const sessions = get().sessions.map((s) =>
      s.id === id ? { ...s, isArchived: archived } : s,
    );
    set({ sessions });
    enqueue(id, async () => {
      const a = api();
      try { await a?.aiChatArchiveSession?.(id, archived); } catch (err) {
        console.error('[ai-chat] archive persist failed:', err);
      }
    });
  },

  searchSessions: async (query, limit = 50) => {
    const a = api();
    if (!a?.aiChatSearchSessions) return [];
    try {
      const json: string = await a.aiChatSearchSessions(query, limit);
      const rows: Array<RustSession & { snippet: string; matched_message_id: string }> = JSON.parse(json);
      return rows.map((r) => ({
        session: rustToSession(r),
        snippet: r.snippet,
        matchedMessageId: r.matched_message_id,
      }));
    } catch (err) {
      console.error('[ai-chat] search failed:', err);
      return [];
    }
  },
}));

// Kick off hydration once the bridge is presumed available. The store
// re-checks `hydrated` so callers can also call `hydrate()` themselves.
if (typeof window !== 'undefined') {
  void useAiChatStore.getState().hydrate();
}
