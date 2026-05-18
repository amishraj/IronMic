import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, X, Mic, Sparkles, StickyNote, Users, ArrowRight } from 'lucide-react';
import { useEntryStore } from '../stores/useEntryStore';
import { useAiChatStore, type AiSessionSearchHit } from '../stores/useAiChatStore';
import { useNotesStore } from '../stores/useNotesStore';
import { useMeetingStore } from '../stores/useMeetingStore';
import { resolveMeetingTitle } from '../services/meetingTitle';
import { parseTags, parseTitleTag } from '../types';
import { tokenizeQuery, matchesNormalized, normalizeForSearch } from '../utils/searchNormalize';

/**
 * Top-bar quick search.
 *
 * Behavior parity with SearchPage:
 *  - Searches Notes (dictation entries, minus AI-routed ones), Meetings,
 *    AI Chats (FTS5 via store), and Notebook notes.
 *  - Clicking a row navigates to the right page and emits a
 *    `ironmic:open-<X>` event so the target page focuses the specific item.
 *  - Caps at 5 rows; a "See all results" footer button routes to the
 *    full Search page so power users still have the long-list experience.
 *
 * UX:
 *  - Collapsed: small icon-only button in the top bar.
 *  - Expanded: a 384px input slides out; results appear in a popover below.
 *  - Esc, click-outside, or pick-a-result all collapse it.
 *  - Arrow keys / Enter navigate the popover.
 */
export function QuickSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Popover is portaled to document.body so it escapes the top-bar's
  // backdrop-blur stacking context (which was painting the dropdown UNDER
  // the page content below the bar). We compute its position from the
  // expanded-input container's bounding rect.
  const [anchorRect, setAnchorRect] = useState<{ top: number; right: number; width: number } | null>(null);
  const measureAnchor = () => {
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAnchorRect({ top: r.bottom, right: window.innerWidth - r.right, width: r.width });
  };
  useLayoutEffect(() => {
    if (!open) { setAnchorRect(null); return; }
    measureAnchor();
    const onResize = () => measureAnchor();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [open]);

  const entries = useEntryStore((s) => s.entries);
  const sessions = useAiChatStore((s) => s.sessions);
  const searchSessions = useAiChatStore((s) => s.searchSessions);
  const notes = useNotesStore((s) => s.notes);
  const meetingSessions = useMeetingStore((s) => s.sessions);
  const loadMeetingSessions = useMeetingStore((s) => s.loadSessions);

  // Ensure meeting list is in memory the first time the user opens the
  // quick-search popover. Cheap no-op once loaded.
  useEffect(() => {
    if (open && meetingSessions.length === 0) {
      void loadMeetingSessions().catch(() => { /* ignore */ });
    }
  }, [open, meetingSessions.length, loadMeetingSessions]);

  // FTS5 AI session search (debounced) — same pattern as SearchPage.
  const [aiHits, setAiHits] = useState<AiSessionSearchHit[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (!q || !open) { setAiHits([]); return; }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const hits = await searchSessions(q, 10);
        if (!cancelled) setAiHits(hits);
      } catch { /* ignore */ }
    }, 150);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [query, open, searchSessions]);

  // Build a small ranked result list. Capped at MAX_ROWS so the popover stays
  // compact; the "See all results" footer pushes the user to SearchPage for
  // the full list.
  const MAX_ROWS = 5;
  const results = useMemo(() => {
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) return [] as QuickResult[];

    const sectionMatchesAllTokens = (body: string) => {
      const n = normalizeForSearch(body);
      for (const t of tokens) if (!n.includes(t)) return false;
      return true;
    };

    const all: QuickResult[] = [];

    for (const entry of entries) {
      const isAi = entry.sourceApp?.startsWith('ai-chat');
      if (isAi) continue;
      const text = entry.polishedText || entry.rawTranscript;
      const visibleTags = parseTags(entry.tags);
      const titleFromTag = parseTitleTag(entry.tags);
      const haystack = normalizeForSearch(
        `${titleFromTag ?? ''} ${text} ${entry.rawTranscript} ${visibleTags.join(' ')}`,
      );
      if (!matchesNormalized(haystack, tokens)) continue;
      const title = (titleFromTag && titleFromTag.trim())
        || text.split(/\n/).find((l) => l.trim().length > 0)?.slice(0, 60)
        || 'Untitled note';
      all.push({
        type: 'dictation',
        id: entry.id,
        title,
        preview: text.slice(0, 100).replace(/\n+/g, ' '),
        time: new Date(entry.updatedAt || entry.createdAt).getTime(),
      });
    }

    const seenAi = new Set<string>();
    const sessionsById = new Map(sessions.map((s) => [s.id, s] as const));
    for (const hit of aiHits) {
      if (seenAi.has(hit.session.id)) continue;
      seenAi.add(hit.session.id);
      const fresh = sessionsById.get(hit.session.id) ?? hit.session;
      if (fresh.isArchived) continue;
      const plainSnippet = hit.snippet.replace(/<\/?mark>/g, '').replace(/…/g, '...');
      all.push({
        type: 'ai-session',
        id: fresh.id,
        title: fresh.title,
        preview: plainSnippet || fresh.lastMessagePreview || 'AI conversation',
        time: fresh.updatedAt,
      });
    }
    for (const session of sessions) {
      if (seenAi.has(session.id)) continue;
      if (session.isArchived) continue;
      if (matchesNormalized(normalizeForSearch(session.title), tokens)) {
        seenAi.add(session.id);
        all.push({
          type: 'ai-session',
          id: session.id,
          title: session.title,
          preview: session.lastMessagePreview || 'AI conversation',
          time: session.updatedAt,
        });
      }
    }

    for (const note of notes) {
      const haystack = normalizeForSearch(
        `${note.title} ${note.content} ${note.tags.join(' ')}`,
      );
      if (matchesNormalized(haystack, tokens)) {
        all.push({
          type: 'note',
          id: note.id,
          title: note.title || 'Untitled',
          preview: note.content.slice(0, 100).replace(/\n/g, ' ') || 'Empty note',
          time: note.updatedAt,
        });
      }
    }

    for (const session of meetingSessions) {
      let parsed: any = null;
      if (session.structured_output) {
        try { parsed = JSON.parse(session.structured_output); } catch { /* ignore */ }
      }
      const title = resolveMeetingTitle(session as any, parsed);
      const summary = session.summary || '';
      const actions = session.action_items || '';
      const detected = session.detected_app || '';
      const sectionBodies: string[] = [];
      if (parsed?.sections && Array.isArray(parsed.sections)) {
        for (const sec of parsed.sections) {
          if (sec && typeof sec.content === 'string') sectionBodies.push(sec.content);
        }
      }
      const haystack = normalizeForSearch(
        `${title} ${summary} ${actions} ${detected} ${sectionBodies.join(' ')}`,
      );
      if (matchesNormalized(haystack, tokens)) {
        const previewSource = sectionBodies.find(sectionMatchesAllTokens)
          || summary
          || sectionBodies[0]
          || 'Meeting';
        all.push({
          type: 'meeting',
          id: session.id,
          title,
          preview: previewSource.slice(0, 100).replace(/\n+/g, ' '),
          time: new Date(session.ended_at || session.started_at).getTime(),
        });
      }
    }

    all.sort((a, b) => b.time - a.time);
    return all.slice(0, MAX_ROWS);
  }, [query, entries, sessions, notes, meetingSessions, aiHits]);

  // Clamp the keyboard cursor when the result list shrinks.
  useEffect(() => {
    if (activeIdx >= results.length) setActiveIdx(0);
  }, [results.length, activeIdx]);

  // Click-outside collapse. The popover is portaled to body — we tag its
  // root with a data attribute and treat clicks inside it as "inside".
  const popoverRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (containerRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
      setQuery('');
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Focus the input as soon as it appears.
  useEffect(() => {
    if (open) {
      // setTimeout to give the input time to mount + transition in.
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  const navigateToResult = (result: QuickResult) => {
    // Same dispatch shape as SearchPage.handleNavigate — keep them in sync.
    if (result.type === 'ai-session') {
      window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'ai' }));
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('ironmic:open-ai-session', { detail: result.id }));
      }, 0);
    } else if (result.type === 'note') {
      useNotesStore.getState().setActiveNote(result.id);
      window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'notes' }));
    } else if (result.type === 'dictation') {
      window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'dictate' }));
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('ironmic:open-entry', { detail: result.id }));
      }, 0);
    } else if (result.type === 'meeting') {
      window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'meetings' }));
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('ironmic:open-meeting', { detail: result.id }));
      }, 0);
    }
    setOpen(false);
    setQuery('');
  };

  const goToFullSearch = () => {
    // Stash the current query so SearchPage can pre-populate it. We use BOTH
    // a sessionStorage handoff (synchronous, race-free on mount) AND a
    // CustomEvent (lets an already-mounted SearchPage react instantly without
    // a remount) so the seed survives whichever order navigate→mount happens.
    const seed = query.trim();
    if (seed) {
      try { window.sessionStorage.setItem('ironmic:search-seed', seed); } catch { /* ignore */ }
      window.dispatchEvent(new CustomEvent('ironmic:search-seed', { detail: seed }));
    }
    window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'search' }));
    setOpen(false);
    setQuery('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      setQuery('');
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (results.length === 0) return;
      setActiveIdx((idx) => Math.min(idx + 1, results.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length === 0) return;
      setActiveIdx((idx) => Math.max(idx - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (results.length === 0) {
        if (query.trim()) goToFullSearch();
        return;
      }
      navigateToResult(results[Math.min(activeIdx, results.length - 1)]);
    }
  };

  return (
    <div
      ref={containerRef}
      className="relative"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="w-9 h-9 flex items-center justify-center rounded-lg text-iron-text-muted hover:text-iron-text hover:bg-iron-surface-hover transition-colors"
          title="Quick search"
          aria-label="Quick search"
        >
          <Search className="w-4 h-4" />
        </button>
      ) : (
        <div className="flex items-center w-[320px] bg-iron-surface border border-iron-border rounded-lg focus-within:border-iron-accent/50 focus-within:shadow-glow transition-all">
          <Search className="w-4 h-4 text-iron-text-muted ml-2.5 flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
            onKeyDown={onKeyDown}
            placeholder="Search notes, meetings, chats..."
            className="flex-1 bg-transparent text-sm px-2 py-1.5 text-iron-text placeholder:text-iron-text-muted focus:outline-none"
          />
          <button
            onClick={() => { setOpen(false); setQuery(''); }}
            className="mr-1.5 w-6 h-6 flex items-center justify-center text-iron-text-muted hover:text-iron-text transition-colors"
            title="Close"
            aria-label="Close search"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Popover — portaled to <body> so it lives outside the top bar's
          backdrop-blur stacking context and paints above all page content. */}
      {open && query.trim() && anchorRect && createPortal(
        <div
          ref={popoverRef}
          // position: fixed against the viewport. `right` is computed as
          // distance from the right edge so the popover stays right-anchored
          // when the window resizes or the user scrolls within content.
          style={{
            position: 'fixed',
            top: anchorRect.top + 6,
            right: anchorRect.right,
            width: 420,
            zIndex: 9999,
          }}
          className="bg-iron-surface border border-iron-border rounded-xl shadow-xl overflow-hidden"
        >
          {results.length === 0 ? (
            <div className="px-4 py-3 text-xs text-iron-text-muted">
              No results for &ldquo;{query}&rdquo;
            </div>
          ) : (
            <div className="py-1 max-h-[420px] overflow-y-auto">
              {results.map((result, idx) => {
                const Icon = TYPE_ICONS[result.type];
                const active = idx === activeIdx;
                return (
                  <button
                    key={`${result.type}-${result.id}`}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => navigateToResult(result)}
                    className={`w-full text-left px-3 py-2 flex items-start gap-2.5 transition-colors ${
                      active ? 'bg-iron-surface-hover' : 'hover:bg-iron-surface-hover'
                    }`}
                  >
                    <div className={`w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 ${TYPE_COLORS[result.type]}`}>
                      <Icon className="w-3.5 h-3.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[9px] font-semibold uppercase tracking-wider text-iron-text-muted">
                          {TYPE_LABELS[result.type]}
                        </span>
                        <span className="text-[9px] text-iron-text-muted">
                          {formatRelative(result.time)}
                        </span>
                      </div>
                      <p className="text-xs font-medium text-iron-text mt-0.5 truncate">{result.title}</p>
                      <p className="text-[11px] text-iron-text-muted mt-0.5 truncate">{result.preview}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          <button
            onClick={goToFullSearch}
            className="w-full text-left px-3 py-2 border-t border-iron-border text-xs text-iron-text-muted hover:bg-iron-surface-hover hover:text-iron-text transition-colors flex items-center justify-between"
          >
            <span>See all results in Search</span>
            <ArrowRight className="w-3 h-3" />
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

type QuickResultType = 'dictation' | 'ai-session' | 'note' | 'meeting';

interface QuickResult {
  type: QuickResultType;
  id: string;
  title: string;
  preview: string;
  time: number;
}

const TYPE_ICONS: Record<QuickResultType, typeof Mic> = {
  dictation: Mic,
  'ai-session': Sparkles,
  note: StickyNote,
  meeting: Users,
};

const TYPE_COLORS: Record<QuickResultType, string> = {
  dictation: 'text-iron-accent-light bg-iron-accent/10',
  'ai-session': 'text-purple-400 bg-purple-500/10',
  note: 'text-emerald-400 bg-emerald-500/10',
  meeting: 'text-sky-400 bg-sky-500/10',
};

const TYPE_LABELS: Record<QuickResultType, string> = {
  dictation: 'Note',
  'ai-session': 'AI Chat',
  note: 'Notebook',
  meeting: 'Meeting',
};

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
