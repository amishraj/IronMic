import { useState, useMemo } from 'react';
import { Search, Mic, Sparkles, StickyNote, Clock, MessageSquare, ArrowRight } from 'lucide-react';
import { useEntryStore } from '../stores/useEntryStore';
import { useAiChatStore, type AiSession } from '../stores/useAiChatStore';
import { useNotesStore, type Note } from '../stores/useNotesStore';
import { Card } from './ui';

type ResultType = 'dictation' | 'ai-session' | 'note';

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

  const entries = useEntryStore((s) => s.entries);
  const sessions = useAiChatStore((s) => s.sessions);
  const notes = useNotesStore((s) => s.notes);

  const results = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return [];

    const all: SearchResult[] = [];

    // Search dictation entries (non-AI ones)
    for (const entry of entries) {
      const isAi = entry.sourceApp?.startsWith('ai-chat');
      if (isAi) continue; // AI entries are covered by session search

      const text = entry.polishedText || entry.rawTranscript;
      if (text.toLowerCase().includes(q) || entry.rawTranscript.toLowerCase().includes(q)) {
        all.push({
          type: 'dictation',
          id: entry.id,
          title: 'Dictation',
          preview: text.slice(0, 120),
          time: new Date(entry.createdAt).getTime(),
        });
      }
    }

    // Search AI sessions
    for (const session of sessions) {
      const allText = session.messages.map((m) => m.content).join(' ').toLowerCase();
      if (allText.includes(q) || session.title.toLowerCase().includes(q)) {
        const lastUserMsg = [...session.messages].reverse().find((m) => m.role === 'user');
        all.push({
          type: 'ai-session',
          id: session.id,
          sessionId: session.id,
          title: session.title,
          preview: lastUserMsg?.content.slice(0, 120) || 'AI conversation',
          time: session.updatedAt,
        });
      }
    }

    // Search notes
    for (const note of notes) {
      if (
        note.title.toLowerCase().includes(q) ||
        note.content.toLowerCase().includes(q) ||
        note.tags.some((t) => t.toLowerCase().includes(q))
      ) {
        all.push({
          type: 'note',
          id: note.id,
          title: note.title || 'Untitled',
          preview: note.content.slice(0, 120).replace(/\n/g, ' ') || 'Empty note',
          time: note.updatedAt,
          tags: note.tags,
        });
      }
    }

    // Sort by relevance (time descending)
    all.sort((a, b) => b.time - a.time);
    return all;
  }, [query, entries, sessions, notes]);

  const filtered = activeFilter === 'all' ? results : results.filter((r) => r.type === activeFilter);

  const counts = useMemo(() => ({
    all: results.length,
    dictation: results.filter((r) => r.type === 'dictation').length,
    'ai-session': results.filter((r) => r.type === 'ai-session').length,
    note: results.filter((r) => r.type === 'note').length,
  }), [results]);

  const handleNavigate = (result: SearchResult) => {
    if (result.type === 'ai-session' && result.sessionId) {
      window.dispatchEvent(new CustomEvent('ironmic:open-ai-session', { detail: result.sessionId }));
      window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'ai' }));
    } else if (result.type === 'note') {
      useNotesStore.getState().setActiveNote(result.id);
      window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'notes' }));
    } else if (result.type === 'dictation') {
      window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'main' }));
    }
  };

  const typeIcons: Record<ResultType, typeof Mic> = {
    dictation: Mic,
    'ai-session': Sparkles,
    note: StickyNote,
  };

  const typeColors: Record<ResultType, string> = {
    dictation: 'text-iron-accent-light bg-iron-accent/10',
    'ai-session': 'text-purple-400 bg-purple-500/10',
    note: 'text-emerald-400 bg-emerald-500/10',
  };

  const typeLabels: Record<ResultType, string> = {
    dictation: 'Dictation',
    'ai-session': 'AI Chat',
    note: 'Note',
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
              placeholder="Search across dictations, AI conversations, and notes..."
              className="w-full text-base bg-iron-surface border border-iron-border rounded-2xl pl-12 pr-4 py-3.5 text-iron-text placeholder:text-iron-text-muted focus:outline-none focus:border-iron-accent/50 focus:shadow-glow transition-all"
              autoFocus
            />
          </div>

          {/* Filter tabs */}
          {query.trim() && (
            <div className="flex items-center gap-1.5 mt-3">
              {(['all', 'dictation', 'ai-session', 'note'] as const).map((filter) => (
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
                Search across all your dictations, AI conversations, and notes in one place.
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
