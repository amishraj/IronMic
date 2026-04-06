import { useEffect, useMemo } from 'react';
import { useEntryStore } from '../stores/useEntryStore';
import { useSearch } from '../hooks/useSearch';
import { EntryCard } from './EntryCard';
import { AiSessionCard } from './AiSessionCard';
import { SearchBar } from './SearchBar';
import { Loader2 } from 'lucide-react';
import type { Entry } from '../types';

/** Parse sourceApp to extract session ID if it's an AI entry */
function getSessionId(entry: Entry): string | null {
  if (!entry.sourceApp) return null;
  if (entry.sourceApp.startsWith('ai-chat:')) return entry.sourceApp.slice(8);
  if (entry.sourceApp === 'ai-chat') return null; // legacy, no session ID
  return null;
}

interface TimelineItem {
  type: 'entry';
  entry: Entry;
  sortTime: number;
}

interface SessionGroup {
  type: 'ai-session';
  sessionId: string;
  entries: Entry[];
  sortTime: number; // latest entry time for sorting
}

type TimelineRow = TimelineItem | SessionGroup;

export function Timeline() {
  const {
    entries, loading, hasMore, selectedTag,
    loadEntries, loadMore, deleteEntry, pinEntry,
    archiveEntry, polishEntry, setSelectedTag,
  } = useEntryStore();

  const { query, setQuery, debouncedQuery } = useSearch();

  useEffect(() => {
    loadEntries({ search: debouncedQuery || undefined });
  }, [debouncedQuery, loadEntries]);

  const filteredEntries = selectedTag
    ? entries.filter((e) => {
        try { return JSON.parse(e.tags || '[]').includes(selectedTag); }
        catch { return false; }
      })
    : entries;

  // Group AI entries by session, keep regular entries as-is
  const rows: TimelineRow[] = useMemo(() => {
    const sessionMap = new Map<string, Entry[]>();
    const standalone: TimelineItem[] = [];

    for (const entry of filteredEntries) {
      const sid = getSessionId(entry);
      if (sid) {
        const list = sessionMap.get(sid) || [];
        list.push(entry);
        sessionMap.set(sid, list);
      } else {
        standalone.push({
          type: 'entry',
          entry,
          sortTime: new Date(entry.createdAt).getTime(),
        });
      }
    }

    const sessionGroups: SessionGroup[] = [];
    for (const [sessionId, sessionEntries] of sessionMap) {
      // Sort within the group by creation time ascending
      sessionEntries.sort((a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      // Use the latest entry time for timeline placement
      const latest = sessionEntries[sessionEntries.length - 1];
      sessionGroups.push({
        type: 'ai-session',
        sessionId,
        entries: sessionEntries,
        sortTime: new Date(latest.createdAt).getTime(),
      });
    }

    // Merge and sort by time, newest first
    const all: TimelineRow[] = [...standalone, ...sessionGroups];
    all.sort((a, b) => b.sortTime - a.sortTime);
    return all;
  }, [filteredEntries]);

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 pb-2">
        <SearchBar query={query} onQueryChange={setQuery} />
        {selectedTag && (
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span className="text-iron-text-muted">Filtered by:</span>
            <button
              onClick={() => setSelectedTag(null)}
              className="px-2 py-0.5 bg-iron-accent/10 text-iron-accent-light rounded-full text-[11px] border border-iron-accent/15 flex items-center gap-1 hover:bg-iron-accent/20 transition-colors"
            >
              {selectedTag}
              <span>×</span>
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-3">
        {rows.length === 0 && !loading && (
          <div className="text-center text-iron-text-muted py-16">
            <p className="text-sm">
              {debouncedQuery
                ? 'No results found'
                : 'No dictations yet. Press the mic button to start recording.'}
            </p>
          </div>
        )}

        {rows.map((row) => {
          if (row.type === 'ai-session') {
            return (
              <AiSessionCard
                key={`session-${row.sessionId}`}
                entries={row.entries}
                sessionId={row.sessionId}
                onDelete={deleteEntry}
                onPin={pinEntry}
              />
            );
          }
          return (
            <EntryCard
              key={row.entry.id}
              entry={row.entry}
              onDelete={deleteEntry}
              onPin={pinEntry}
              onArchive={archiveEntry}
              onPolish={polishEntry}
              onTagClick={setSelectedTag}
            />
          );
        })}

        {hasMore && !loading && (
          <button
            onClick={loadMore}
            className="w-full py-2 text-xs text-iron-text-muted hover:text-iron-text-secondary transition-colors"
          >
            Load more
          </button>
        )}

        {loading && (
          <div className="flex justify-center py-6">
            <Loader2 className="w-5 h-5 animate-spin text-iron-accent" />
          </div>
        )}
      </div>
    </div>
  );
}
