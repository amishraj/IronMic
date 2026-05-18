import { useState, useMemo, useEffect } from 'react';
import { Search, Mic, Sparkles, StickyNote, Users, ArrowRight } from 'lucide-react';
import { useEntryStore } from '../stores/useEntryStore';
import { useAiChatStore, type AiSessionSearchHit } from '../stores/useAiChatStore';
import { useNotesStore } from '../stores/useNotesStore';
import { useMeetingStore } from '../stores/useMeetingStore';
import { resolveMeetingTitle } from '../services/meetingTitle';
import { parseTags, parseTitleTag } from '../types';
import { tokenizeQuery, matchesNormalized, normalizeForSearch } from '../utils/searchNormalize';
import { Card } from './ui';

type ResultType = 'dictation' | 'ai-session' | 'note' | 'meeting';

interface SearchResult {
  type: ResultType;
  id: string;
  title: string;
  preview: string;
  time: number;
  sessionId?: string;
  tags?: string[];
}

export function SearchPage() {
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<ResultType | 'all'>('all');

  // Accept a seed query from the top-bar QuickSearch popover so "See all
  // results" lands on the full page with the query already populated.
  // QuickSearch dispatches the seed *just before* navigating, and SearchPage
  // mounts immediately after — both happen inside the same tick. Reading a
  // one-shot value from sessionStorage avoids the ordering race that
  // event-only delivery would introduce.
  useEffect(() => {
    try {
      const seed = window.sessionStorage.getItem('ironmic:search-seed');
      if (seed) {
        setQuery(seed);
        window.sessionStorage.removeItem('ironmic:search-seed');
      }
    } catch { /* ignore (private mode etc.) */ }
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail === 'string') setQuery(detail);
    };
    window.addEventListener('ironmic:search-seed', handler);
    return () => window.removeEventListener('ironmic:search-seed', handler);
  }, []);

  const entries = useEntryStore((s) => s.entries);
  const sessions = useAiChatStore((s) => s.sessions);
  const searchSessions = useAiChatStore((s) => s.searchSessions);
  const notes = useNotesStore((s) => s.notes);
  const meetingSessions = useMeetingStore((s) => s.sessions);
  const loadMeetingSessions = useMeetingStore((s) => s.loadSessions);

  // Make sure the meeting list is loaded once when the user lands on the
  // search page — otherwise users who never opened Meetings this session
  // would see zero meeting results.
  useEffect(() => {
    if (meetingSessions.length === 0) {
      void loadMeetingSessions().catch(() => { /* ignore */ });
    }
  }, [meetingSessions.length, loadMeetingSessions]);

  // AI session search runs against SQLite FTS5 (aiChatSearchSessions IPC) so
  // sessions whose messages haven't been lazy-loaded into the renderer still
  // turn up in results. Iterating session.messages here would silently miss
  // most history once persistence is enabled.
  const [aiHits, setAiHits] = useState<AiSessionSearchHit[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (!q) { setAiHits([]); return; }
    let cancelled = false;
    const handle = setTimeout(async () => {
      const hits = await searchSessions(q, 50);
      if (!cancelled) setAiHits(hits);
    }, 200);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [query, searchSessions]);

  const results = useMemo(() => {
    // tokens === [] when the box is empty; bail out cheap.
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) return [];

    // Section-body sub-matcher for meeting previews: returns the first
    // section whose normalized body contains every token, so the preview
    // is a snippet from the matching section instead of the first one.
    const sectionMatchesAllTokens = (body: string) => {
      const n = normalizeForSearch(body);
      for (const t of tokens) if (!n.includes(t)) return false;
      return true;
    };

    const all: SearchResult[] = [];

    // Search dictation/note entries (non-AI ones). We label these as "Note"
    // in the UI now — the user-facing language is consolidated post-Slice 0.
    // entry.tags is a JSON-encoded string that mixes user-visible chips with
    // internal __title__: / __notebook__: / __status__: / __emoji__: rows.
    // parseTags() strips the internal prefixes so we never (a) match on them
    // when the user types e.g. "status" and (b) render them as visible chips.
    for (const entry of entries) {
      const isAi = entry.sourceApp?.startsWith('ai-chat');
      if (isAi) continue; // AI entries are covered by session search

      const text = entry.polishedText || entry.rawTranscript;
      const visibleTags = parseTags(entry.tags);
      const titleFromTag = parseTitleTag(entry.tags);
      const haystack = normalizeForSearch(
        `${titleFromTag ?? ''} ${text} ${entry.rawTranscript} ${visibleTags.join(' ')}`,
      );
      if (matchesNormalized(haystack, tokens)) {
        const title = (titleFromTag && titleFromTag.trim())
          || text.split(/\n/).find((l) => l.trim().length > 0)?.slice(0, 60)
          || 'Untitled note';
        all.push({
          type: 'dictation',
          id: entry.id,
          title,
          preview: text.slice(0, 160).replace(/\n+/g, ' '),
          time: new Date(entry.updatedAt || entry.createdAt).getTime(),
          tags: visibleTags,
        });
      }
    }

    // AI sessions: prefer FTS hits (which include sessions whose messages
    // aren't yet lazy-loaded), augmented by a title match against the
    // currently-loaded session list so renaming feels instant before the
    // next FTS index sync. The FTS engine ALREADY tokenizes/normalizes its
    // way, so we don't double-filter aiHits — we trust the backend hit.
    const seenSessionIds = new Set<string>();
    const sessionsById = new Map(sessions.map((s) => [s.id, s] as const));
    for (const hit of aiHits) {
      if (seenSessionIds.has(hit.session.id)) continue;
      seenSessionIds.add(hit.session.id);
      const fresh = sessionsById.get(hit.session.id) ?? hit.session;
      if (fresh.isArchived) continue;
      // Strip FTS5 mark tags for a plain-text preview.
      const plainSnippet = hit.snippet.replace(/<\/?mark>/g, '').replace(/…/g, '...');
      all.push({
        type: 'ai-session',
        id: fresh.id,
        sessionId: fresh.id,
        title: fresh.title,
        preview: plainSnippet || fresh.lastMessagePreview || 'AI conversation',
        time: fresh.updatedAt,
      });
    }
    for (const session of sessions) {
      if (seenSessionIds.has(session.id)) continue;
      if (session.isArchived) continue;
      if (matchesNormalized(normalizeForSearch(session.title), tokens)) {
        seenSessionIds.add(session.id);
        all.push({
          type: 'ai-session',
          id: session.id,
          sessionId: session.id,
          title: session.title,
          preview: session.lastMessagePreview || 'AI conversation',
          time: session.updatedAt,
        });
      }
    }

    // Search notebook notes
    for (const note of notes) {
      const haystack = normalizeForSearch(
        `${note.title} ${note.content} ${note.tags.join(' ')}`,
      );
      if (matchesNormalized(haystack, tokens)) {
        all.push({
          type: 'note',
          id: note.id,
          title: note.title || 'Untitled',
          preview: note.content.slice(0, 160).replace(/\n/g, ' ') || 'Empty note',
          time: note.updatedAt,
          tags: note.tags,
        });
      }
    }

    // Search meetings: title (resolved from structured_output), summary,
    // action items, and detected app all become haystack.
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
          preview: previewSource.slice(0, 160).replace(/\n+/g, ' '),
          time: new Date(session.ended_at || session.started_at).getTime(),
        });
      }
    }

    // Sort by recency (descending)
    all.sort((a, b) => b.time - a.time);
    return all;
  }, [query, entries, sessions, notes, meetingSessions, aiHits]);

  const filtered = activeFilter === 'all' ? results : results.filter((r) => r.type === activeFilter);

  const counts = useMemo(() => ({
    all: results.length,
    dictation: results.filter((r) => r.type === 'dictation').length,
    'ai-session': results.filter((r) => r.type === 'ai-session').length,
    note: results.filter((r) => r.type === 'note').length,
    meeting: results.filter((r) => r.type === 'meeting').length,
  }), [results]);

  const handleNavigate = (result: SearchResult) => {
    // For each result type we (1) flip the app to the right page and then
    // (2) tell that page to open the specific item. Reverse order matters:
    // if we dispatch open-X before navigate, the target page might not be
    // mounted yet to receive the event. setTimeout(0) lets the page mount
    // before we ask it to focus a specific row.
    if (result.type === 'ai-session' && result.sessionId) {
      window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'ai' }));
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('ironmic:open-ai-session', { detail: result.sessionId }));
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
  };

  const typeIcons: Record<ResultType, typeof Mic> = {
    dictation: Mic,
    'ai-session': Sparkles,
    note: StickyNote,
    meeting: Users,
  };

  const typeColors: Record<ResultType, string> = {
    dictation: 'text-iron-accent-light bg-iron-accent/10',
    'ai-session': 'text-purple-400 bg-purple-500/10',
    note: 'text-emerald-400 bg-emerald-500/10',
    meeting: 'text-sky-400 bg-sky-500/10',
  };

  const typeLabels: Record<ResultType, string> = {
    dictation: 'Note',
    'ai-session': 'AI Chat',
    note: 'Notebook',
    meeting: 'Meeting',
  };

  return (
    <div className="flex flex-col h-full">
      {/* Search header */}
      <div className="px-6 pt-6 pb-4">
        <div className="max-w-2xl mx-auto">
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-iron-text-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search across notes, meetings, AI conversations, and notebooks..."
              className="w-full text-base bg-iron-surface border border-iron-border rounded-2xl pl-12 pr-4 py-3.5 text-iron-text placeholder:text-iron-text-muted focus:outline-none focus:border-iron-accent/50 focus:shadow-glow transition-all"
              autoFocus
            />
          </div>

          {/* Filter tabs */}
          {query.trim() && (
            <div className="flex items-center gap-1.5 mt-3">
              {(['all', 'dictation', 'meeting', 'ai-session', 'note'] as const).map((filter) => (
                <button
                  key={filter}
                  onClick={() => setActiveFilter(filter)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    activeFilter === filter
                      ? 'bg-iron-accent/15 text-iron-accent-light border border-iron-accent/20'
                      : 'text-iron-text-muted hover:bg-iron-surface-hover'
                  }`}
                >
                  {filter === 'all' ? 'All' : typeLabels[filter]}
                  {' '}
                  <span className="text-iron-text-muted/70">{counts[filter]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto px-6 pb-6">
        <div className="max-w-2xl mx-auto space-y-2">
          {!query.trim() && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="w-14 h-14 rounded-2xl bg-iron-accent/10 flex items-center justify-center mb-4">
                <Search className="w-7 h-7 text-iron-accent-light" />
              </div>
              <p className="text-sm font-medium text-iron-text">Search Everything</p>
              <p className="text-xs text-iron-text-muted mt-1 max-w-[280px]">
                Search across your notes, meetings, AI conversations, and notebooks in one place.
              </p>
            </div>
          )}

          {query.trim() && filtered.length === 0 && (
            <div className="text-center py-16">
              <p className="text-sm text-iron-text-muted">No results for &ldquo;{query}&rdquo;</p>
            </div>
          )}

          {filtered.map((result) => {
            const Icon = typeIcons[result.type];
            return (
              <button
                key={`${result.type}-${result.id}`}
                onClick={() => handleNavigate(result)}
                className="w-full text-left group"
              >
                <Card variant="default" padding="md" className="hover:border-iron-border-hover transition-colors">
                  <div className="flex items-start gap-3">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${typeColors[result.type]}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-iron-text-muted">
                          {typeLabels[result.type]}
                        </span>
                        <span className="text-[10px] text-iron-text-muted">
                          {new Date(result.time).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                        </span>
                      </div>
                      <p className="text-sm font-medium text-iron-text mt-0.5 truncate">{result.title}</p>
                      <p className="text-xs text-iron-text-muted mt-0.5 line-clamp-2">{highlightMatch(result.preview, query)}</p>
                      {result.tags && result.tags.length > 0 && (
                        <div className="flex gap-1 mt-1.5">
                          {result.tags.slice(0, 4).map((t) => (
                            <span key={t} className="text-[10px] px-1.5 py-0 rounded-full bg-iron-accent/10 text-iron-accent-light">#{t}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <ArrowRight className="w-4 h-4 text-iron-text-muted/0 group-hover:text-iron-text-muted transition-colors flex-shrink-0 mt-2" />
                  </div>
                </Card>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Simple highlight — wraps matching substring in a bold span (returns JSX string for now) */
function highlightMatch(text: string, query: string): string {
  // For simplicity, just return the text — CSS line-clamp handles overflow
  return text;
}
