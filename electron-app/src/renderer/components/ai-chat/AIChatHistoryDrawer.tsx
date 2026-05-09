import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Search, Plus, Pin, PinOff, Archive, Trash2, MessageSquare,
  ChevronRight, ChevronLeft, X,
} from 'lucide-react';
import { useAiChatStore, type AiSession, type AiSessionSearchHit } from '../../stores/useAiChatStore';

const DRAWER_OPEN_KEY = 'ironmic-ai-history-drawer-open';
const RAIL_BREAKPOINT = 880;

interface DrawerProps {
  /** Container width drives the auto-rail hint (under RAIL_BREAKPOINT we
   *  auto-collapse to a rail so the composer doesn't get squeezed). The user
   *  can still click the rail to expand — narrow just means the default. */
  containerWidth: number | null;
  onNewChat: () => void;
}

interface SectionedSessions {
  pinned: AiSession[];
  today: AiSession[];
  yesterday: AiSession[];
  earlier: AiSession[];
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function bucketSessions(sessions: AiSession[]): SectionedSessions {
  const visible = sessions.filter((s) => !s.isArchived);
  const pinned = visible.filter((s) => s.isPinned).sort((a, b) => b.updatedAt - a.updatedAt);
  const unpinned = visible.filter((s) => !s.isPinned);
  const today = startOfDay(Date.now());
  const yesterday = today - 86_400_000;

  const buckets: SectionedSessions = { pinned, today: [], yesterday: [], earlier: [] };
  for (const s of unpinned) {
    if (s.updatedAt >= today) buckets.today.push(s);
    else if (s.updatedAt >= yesterday) buckets.yesterday.push(s);
    else buckets.earlier.push(s);
  }
  for (const k of ['today', 'yesterday', 'earlier'] as const) {
    buckets[k].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return buckets;
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d`;
  return new Date(ts).toLocaleDateString();
}

interface SessionRowProps {
  session: AiSession;
  active: boolean;
  snippetHtml?: string;
  onActivate: () => void;
  onPin: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}

function SessionRow({ session, active, snippetHtml, onActivate, onPin, onArchive, onDelete, onRename }: SessionRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== session.title) onRename(trimmed);
    else setDraft(session.title);
    setEditing(false);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate();
        }
      }}
      onDoubleClick={() => {
        setDraft(session.title);
        setEditing(true);
      }}
      className={`group cursor-pointer rounded-md px-2 py-2 text-left transition-colors ${
        active
          ? 'bg-iron-accent/15 text-iron-text'
          : 'text-iron-text-secondary hover:bg-iron-surface-hover'
      }`}
    >
      <div className="flex items-start gap-2">
        <MessageSquare className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 opacity-60" />
        <div className="flex-1 min-w-0">
          {editing ? (
            <input
              autoFocus
              value={draft}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') { setDraft(session.title); setEditing(false); }
              }}
              className="w-full text-xs font-medium bg-iron-surface border border-iron-border rounded px-1.5 py-0.5 text-iron-text focus:outline-none focus:border-iron-accent/60"
            />
          ) : (
            <p className="text-xs font-medium truncate" title={session.title}>{session.title}</p>
          )}
          {snippetHtml ? (
            <p
              className="text-[10px] text-iron-text-muted mt-0.5 line-clamp-2"
              dangerouslySetInnerHTML={{ __html: snippetHtml }}
            />
          ) : session.lastMessagePreview ? (
            <p className="text-[10px] text-iron-text-muted mt-0.5 truncate">
              {session.lastMessagePreview}
            </p>
          ) : null}
          <div className="flex items-center gap-1.5 mt-1">
            {session.provider && (
              <span className="text-[9px] uppercase tracking-wider text-iron-text-muted opacity-70">
                {session.provider}
              </span>
            )}
            <span className="text-[10px] text-iron-text-muted">{formatRelativeTime(session.updatedAt)}</span>
          </div>
        </div>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={(e) => { e.stopPropagation(); onPin(); }}
            className="p-1 rounded text-iron-text-muted hover:text-iron-accent-light"
            title={session.isPinned ? 'Unpin' : 'Pin'}
          >
            {session.isPinned ? <PinOff className="w-3 h-3" /> : <Pin className="w-3 h-3" />}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onArchive(); }}
            className="p-1 rounded text-iron-text-muted hover:text-iron-accent-light"
            title="Archive"
          >
            <Archive className="w-3 h-3" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="p-1 rounded text-iron-text-muted hover:text-iron-danger"
            title="Delete"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2 pt-3 pb-1 text-[10px] font-semibold text-iron-text-muted uppercase tracking-wider">
      {children}
    </p>
  );
}

export function AIChatHistoryDrawer({ containerWidth, onNewChat }: DrawerProps) {
  const sessions = useAiChatStore((s) => s.sessions);
  const activeSessionId = useAiChatStore((s) => s.activeSessionId);
  const setActiveSession = useAiChatStore((s) => s.setActiveSession);
  const deleteSession = useAiChatStore((s) => s.deleteSession);
  const updateSessionTitle = useAiChatStore((s) => s.updateSessionTitle);
  const pinSession = useAiChatStore((s) => s.pinSession);
  const archiveSession = useAiChatStore((s) => s.archiveSession);
  const searchSessions = useAiChatStore((s) => s.searchSessions);

  const [open, setOpen] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return true;
    const saved = localStorage.getItem(DRAWER_OPEN_KEY);
    return saved === null ? true : saved === '1';
  });
  const [query, setQuery] = useState('');
  const [searchHits, setSearchHits] = useState<AiSessionSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Auto-collapse hint: when the container is narrow we suggest the rail by
  // overriding to closed UNLESS the user has explicitly opened it during
  // this narrow phase. `userOverride` lets a click expand even when narrow.
  const narrow = containerWidth !== null && containerWidth < RAIL_BREAKPOINT;
  const [userOverride, setUserOverride] = useState(false);
  useEffect(() => {
    // Reset override when widening past the breakpoint — preference takes over.
    if (!narrow) setUserOverride(false);
  }, [narrow]);
  const effectiveOpen = narrow ? userOverride : open;

  // Persist user preference (only when not under the auto-rail hint).
  useEffect(() => {
    if (!narrow && typeof localStorage !== 'undefined') {
      localStorage.setItem(DRAWER_OPEN_KEY, open ? '1' : '0');
    }
  }, [open, narrow]);

  // Debounced FTS search.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      const hits = await searchSessions(q, 50);
      setSearchHits(hits);
      setSearching(false);
    }, 200);
    return () => clearTimeout(handle);
  }, [query, searchSessions]);

  // Page-scoped keyboard shortcuts: Cmd/Ctrl+K → focus search, Cmd/Ctrl+Shift+O → new chat.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key.toLowerCase() === 'k' && !e.shiftKey) {
        e.preventDefault();
        if (!effectiveOpen) setOpen(true);
        // Wait one frame for the input to mount when we just opened.
        requestAnimationFrame(() => searchInputRef.current?.focus());
      } else if (e.key.toLowerCase() === 'o' && e.shiftKey) {
        e.preventDefault();
        onNewChat();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [effectiveOpen, onNewChat]);

  const buckets = useMemo(() => bucketSessions(sessions), [sessions]);
  const showingSearch = query.trim().length > 0;

  // Map session id → snippet html for inline render.
  const snippetById = useMemo(() => {
    const m = new Map<string, string>();
    for (const hit of searchHits) m.set(hit.session.id, hit.snippet);
    return m;
  }, [searchHits]);

  // Sessions rendered in search mode: union of search hits + visible store
  // rows that match by id (the FTS row may carry stale denormalized fields).
  const searchSessionsList = useMemo(() => {
    const sessionsById = new Map(sessions.map((s) => [s.id, s] as const));
    const result: AiSession[] = [];
    for (const hit of searchHits) {
      const fresh = sessionsById.get(hit.session.id) ?? hit.session;
      if (!fresh.isArchived) result.push(fresh);
    }
    return result;
  }, [searchHits, sessions]);

  const handleActivate = useCallback((id: string) => {
    setActiveSession(id);
  }, [setActiveSession]);

  const handleDelete = useCallback((id: string) => {
    if (window.confirm('Delete this chat? This cannot be undone.')) {
      deleteSession(id);
    }
  }, [deleteSession]);

  // Collapsed rail
  if (!effectiveOpen) {
    return (
      <div className="w-9 flex-shrink-0 flex flex-col items-center border-l border-iron-border bg-iron-surface py-2 gap-1.5">
        <button
          onClick={() => {
            if (narrow) setUserOverride(true);
            else setOpen(true);
          }}
          className="w-7 h-7 rounded-md flex items-center justify-center text-iron-text-muted hover:text-iron-text hover:bg-iron-surface-hover transition-colors"
          title="Show chat history (⌘K to search)"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <button
          onClick={onNewChat}
          className="w-7 h-7 rounded-md flex items-center justify-center text-iron-text-muted hover:text-iron-accent-light hover:bg-iron-surface-hover transition-colors"
          title="New chat (Cmd/Ctrl+Shift+O)"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="w-72 flex-shrink-0 flex flex-col border-l border-iron-border bg-iron-surface">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-iron-border">
        <span className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">
          Chat history
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={onNewChat}
            className="p-1 rounded-md text-iron-text-muted hover:text-iron-accent-light hover:bg-iron-surface-hover transition-colors"
            title="New chat (Cmd/Ctrl+Shift+O)"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => {
              if (narrow) setUserOverride(false);
              else setOpen(false);
            }}
            className="p-1 rounded-md text-iron-text-muted hover:text-iron-text hover:bg-iron-surface-hover transition-colors"
            title="Collapse"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-iron-border">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-iron-text-muted pointer-events-none" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats… (⌘K)"
            className="w-full text-xs bg-iron-bg border border-iron-border rounded-md pl-7 pr-7 py-1.5 text-iron-text placeholder:text-iron-text-muted focus:outline-none focus:border-iron-accent/60"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-iron-text-muted hover:text-iron-text"
              title="Clear search"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-2">
        {showingSearch ? (
          <>
            {searching && (
              <p className="px-3 py-4 text-[11px] text-iron-text-muted">Searching…</p>
            )}
            {!searching && searchSessionsList.length === 0 && (
              <p className="px-3 py-4 text-[11px] text-iron-text-muted">No matches.</p>
            )}
            {!searching && searchSessionsList.length > 0 && (
              <div className="px-1.5">
                {searchSessionsList.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    active={activeSessionId === s.id}
                    snippetHtml={snippetById.get(s.id)}
                    onActivate={() => handleActivate(s.id)}
                    onPin={() => pinSession(s.id, !s.isPinned)}
                    onArchive={() => archiveSession(s.id, !s.isArchived)}
                    onDelete={() => handleDelete(s.id)}
                    onRename={(t) => updateSessionTitle(s.id, t)}
                  />
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            {sessions.length === 0 && (
              <p className="px-3 py-6 text-[11px] text-iron-text-muted text-center">
                No chats yet. Start a new conversation.
              </p>
            )}
            {buckets.pinned.length > 0 && <SectionLabel>Pinned</SectionLabel>}
            <div className="px-1.5">
              {buckets.pinned.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  active={activeSessionId === s.id}
                  onActivate={() => handleActivate(s.id)}
                  onPin={() => pinSession(s.id, false)}
                  onArchive={() => archiveSession(s.id, true)}
                  onDelete={() => handleDelete(s.id)}
                  onRename={(t) => updateSessionTitle(s.id, t)}
                />
              ))}
            </div>
            {buckets.today.length > 0 && <SectionLabel>Today</SectionLabel>}
            <div className="px-1.5">
              {buckets.today.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  active={activeSessionId === s.id}
                  onActivate={() => handleActivate(s.id)}
                  onPin={() => pinSession(s.id, true)}
                  onArchive={() => archiveSession(s.id, true)}
                  onDelete={() => handleDelete(s.id)}
                  onRename={(t) => updateSessionTitle(s.id, t)}
                />
              ))}
            </div>
            {buckets.yesterday.length > 0 && <SectionLabel>Yesterday</SectionLabel>}
            <div className="px-1.5">
              {buckets.yesterday.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  active={activeSessionId === s.id}
                  onActivate={() => handleActivate(s.id)}
                  onPin={() => pinSession(s.id, true)}
                  onArchive={() => archiveSession(s.id, true)}
                  onDelete={() => handleDelete(s.id)}
                  onRename={(t) => updateSessionTitle(s.id, t)}
                />
              ))}
            </div>
            {buckets.earlier.length > 0 && <SectionLabel>Earlier</SectionLabel>}
            <div className="px-1.5">
              {buckets.earlier.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  active={activeSessionId === s.id}
                  onActivate={() => handleActivate(s.id)}
                  onPin={() => pinSession(s.id, true)}
                  onArchive={() => archiveSession(s.id, true)}
                  onDelete={() => handleDelete(s.id)}
                  onRename={(t) => updateSessionTitle(s.id, t)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
