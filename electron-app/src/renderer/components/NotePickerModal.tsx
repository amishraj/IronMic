import { useState, useMemo, useEffect } from 'react';
import { Search, StickyNote, BookOpen, Pin, Check, Mic, Users } from 'lucide-react';
import { useNotesStore, type Note, type Notebook } from '../stores/useNotesStore';
import { useEntryStore } from '../stores/useEntryStore';
import { useMeetingStore } from '../stores/useMeetingStore';
import type { Entry } from '../types';
import { Modal } from './ui';

interface NotePickerModalProps {
  open: boolean;
  onClose: () => void;
  /** Receives a Note-shaped object regardless of which source the user picked.
   *  Dictation entries and meeting summaries are adapted to this shape so the
   *  AIChat attached-context flow stays uniform — the LLM prompt block format
   *  (`[Note: <title>]\n<content>`) is just as legible whether the body came
   *  from a manual note, a Whisper transcript, or a meeting summary. */
  onSelect: (note: Note) => void;
  selectedIds?: Set<string>;
}

/** Source type for an attachable item. Used internally by the picker to
 *  render a small badge and to choose a tab; the `Note` shape handed back
 *  to AIChat doesn't carry this. */
type Kind = 'note' | 'dictation' | 'meeting';

interface PickerItem {
  id: string;
  kind: Kind;
  title: string;
  /** Short preview (≤ 60 chars) shown under the title in the list. */
  preview: string;
  /** Full body that becomes the prompt context when attached. */
  body: string;
  /** Unix ms — drives Recent sort. */
  updatedAt: number;
  /** For notes: parent notebook id (Notebooks tab grouping). */
  notebookId?: string | null;
  isPinned?: boolean;
  tags?: string[];
}

// ── Adapters: source store row → uniform PickerItem ────────────────────────

function noteToItem(n: Note): PickerItem {
  return {
    id: n.id,
    kind: 'note',
    title: n.title || 'Untitled',
    preview: (n.content || '').slice(0, 80).replace(/\n/g, ' '),
    body: (n.polishedContent && n.displayMode === 'polished') ? n.polishedContent : n.content,
    updatedAt: n.updatedAt,
    notebookId: n.notebookId,
    isPinned: n.isPinned,
    tags: n.tags,
  };
}

/** A title-less dictation entry needs SOMETHING the user recognizes. Use the
 *  first ~40 chars of the polished text (or raw if no polish), trimmed at a
 *  word boundary where possible. */
function entryTitle(e: Entry): string {
  const body = (e.polishedText && e.displayMode === 'polished' ? e.polishedText : e.rawTranscript) || '';
  if (!body.trim()) return 'Empty dictation';
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= 50) return flat;
  // Cut at last space before 50 chars to avoid mid-word.
  const slice = flat.slice(0, 50);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 20 ? slice.slice(0, lastSpace) : slice) + '…';
}

function entryToItem(e: Entry): PickerItem {
  const body = (e.polishedText && e.displayMode === 'polished' ? e.polishedText : e.rawTranscript) || '';
  return {
    id: e.id,
    kind: 'dictation',
    title: entryTitle(e),
    preview: body.slice(0, 80).replace(/\n/g, ' '),
    body,
    updatedAt: Date.parse(e.updatedAt) || Date.parse(e.createdAt) || Date.now(),
    isPinned: e.isPinned,
  };
}

interface MeetingSessionLike {
  id: string;
  started_at?: string;
  ended_at?: string;
  summary?: string;
  action_items?: string;
  structured_output?: string;
}

function meetingTitle(m: MeetingSessionLike): string {
  // structured_output sometimes carries a generated title; otherwise fall
  // back to a date stamp ("Meeting — May 8 14:30").
  try {
    if (m.structured_output) {
      const so = JSON.parse(m.structured_output);
      if (typeof so?.plainSummary === 'string' && so.plainSummary.trim()) {
        return so.plainSummary.split(/[.\n]/)[0].slice(0, 60).trim() || 'Meeting';
      }
      if (typeof so?.title === 'string' && so.title.trim()) return so.title.trim();
    }
  } catch { /* fall through */ }
  if (m.started_at) {
    const d = new Date(m.started_at);
    if (!isNaN(d.getTime())) {
      return `Meeting — ${d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    }
  }
  return 'Meeting';
}

function meetingToItem(m: MeetingSessionLike): PickerItem {
  // Body = best-available textual representation in priority order:
  //   structured_output.plainSummary > summary > action_items > "".
  // We deliberately skip full_transcript here — meetings can run an hour
  // and stuffing the entire transcript into a chat prompt blows the
  // context window. When the real RAG retrieval layer lands (Slice E)
  // it'll surface the relevant chunks instead.
  let body = '';
  try {
    if (m.structured_output) {
      const so = JSON.parse(m.structured_output);
      if (typeof so?.plainSummary === 'string') body = so.plainSummary;
      else if (typeof so?.markdown === 'string') body = so.markdown;
    }
  } catch { /* fall through */ }
  if (!body && m.summary) body = m.summary;
  if (!body && m.action_items) body = `Action items:\n${m.action_items}`;

  return {
    id: m.id,
    kind: 'meeting',
    title: meetingTitle(m),
    preview: body.slice(0, 80).replace(/\n/g, ' ') || 'No summary yet',
    body: body || meetingTitle(m),
    updatedAt: Date.parse(m.ended_at ?? m.started_at ?? '') || Date.now(),
  };
}

/** Synthesize a Note-shaped object from a PickerItem so AIChat's existing
 *  `attachedNotes: Note[]` state (and the prompt block builder around it)
 *  works without any consumer-side changes. The synthetic note's id is
 *  prefixed by kind so dedupe across the three sources never collides
 *  (e.g. an entry and a note sharing a UUID — unlikely but possible). */
function itemToNote(item: PickerItem): Note {
  const now = Date.now();
  const prefixedId = item.kind === 'note' ? item.id : `${item.kind}:${item.id}`;
  return {
    id: prefixedId,
    title: item.title,
    content: item.body,
    polishedContent: null,
    displayMode: 'raw',
    notebookId: item.notebookId ?? null,
    tags: item.tags ?? [],
    isPinned: !!item.isPinned,
    createdAt: item.updatedAt || now,
    updatedAt: item.updatedAt || now,
  };
}

export function NotePickerModal({ open, onClose, onSelect, selectedIds }: NotePickerModalProps) {
  const [query, setQuery] = useState('');
  type Tab = 'recent' | 'notes' | 'dictations' | 'meetings';
  const [activeTab, setActiveTab] = useState<Tab>('recent');

  const notes = useNotesStore((s) => s.notes);
  const notebooks = useNotesStore((s) => s.notebooks);
  const entries = useEntryStore((s) => s.entries);
  const loadEntries = useEntryStore((s) => s.loadEntries);
  const meetingSessions = useMeetingStore((s) => s.sessions);
  const loadMeetings = useMeetingStore((s) => s.loadSessions);

  // Lazy-load entries and meetings the first time the picker opens. If the
  // user came straight to AIChat without visiting Timeline / Meetings, these
  // stores start empty and the relevant tabs would look misleadingly bare.
  useEffect(() => {
    if (!open) return;
    if (entries.length === 0) void loadEntries({ limit: 50, offset: 0 } as any);
    if (meetingSessions.length === 0) void loadMeetings();
    // Intentionally NOT depending on `entries.length` / `meetingSessions.length`
    // here — we only want one fire on open, not re-fires while results stream in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Map each source to PickerItems once per source change.
  const noteItems = useMemo(() => notes.map(noteToItem), [notes]);
  const entryItems = useMemo(() => entries.map(entryToItem), [entries]);
  const meetingItems = useMemo(
    () => (meetingSessions as MeetingSessionLike[]).map(meetingToItem),
    [meetingSessions],
  );

  const allItems = useMemo(
    () => [...noteItems, ...entryItems, ...meetingItems],
    [noteItems, entryItems, meetingItems],
  );

  // What feeds the current tab BEFORE search filtering. Recent mixes all
  // three and sorts by updatedAt; the dedicated tabs are kind-filtered.
  const baseItems: PickerItem[] = useMemo(() => {
    if (activeTab === 'recent') {
      return [...allItems].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30);
    }
    if (activeTab === 'notes') return noteItems;
    if (activeTab === 'dictations') return entryItems;
    if (activeTab === 'meetings') return meetingItems;
    return [];
  }, [activeTab, allItems, noteItems, entryItems, meetingItems]);

  const searchResults = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    // Search ALL items regardless of tab so the user gets a unified
    // result set when they type — matches Mem / Reflect behavior.
    return allItems.filter((it) =>
      it.title.toLowerCase().includes(q) ||
      it.body.toLowerCase().includes(q) ||
      (it.tags ?? []).some((t) => t.toLowerCase().includes(q))
    ).slice(0, 30);
  }, [query, allItems]);

  if (!open) return null;

  return (
    <Modal open onClose={onClose} title="Add Context">
      <div className="w-[480px] max-h-[60vh] flex flex-col">
        {/* Search */}
        <div className="px-4 pt-3 pb-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-iron-text-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search notes, dictations, and meetings..."
              className="w-full text-xs bg-iron-bg border border-iron-border rounded-lg pl-8 pr-3 py-2 text-iron-text placeholder:text-iron-text-muted focus:outline-none focus:border-iron-accent/50"
              autoFocus
            />
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-4 pb-2">
          {([
            { id: 'recent', label: 'Recent', count: allItems.length },
            { id: 'notes', label: 'Notes', count: noteItems.length },
            { id: 'dictations', label: 'Dictations', count: entryItems.length },
            { id: 'meetings', label: 'Meetings', count: meetingItems.length },
          ] as const).map(({ id, label, count }) => (
            <button
              key={id}
              onClick={() => { setActiveTab(id); setQuery(''); }}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                activeTab === id && !query
                  ? 'bg-iron-accent/15 text-iron-accent-light'
                  : 'text-iron-text-muted hover:bg-iron-surface-hover'
              }`}
              title={`${count} ${label.toLowerCase()}`}
            >
              {label}
              {count > 0 && (
                <span className="ml-1 text-[9px] opacity-60">{count}</span>
              )}
            </button>
          ))}
          {query && (
            <span className="text-[11px] text-iron-text-muted ml-auto">
              {searchResults.length} result{searchResults.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {query ? (
            searchResults.length === 0 ? (
              <EmptyState message={`No matches for "${query}". Try a different keyword.`} />
            ) : (
              <ItemList items={searchResults} notebooks={notebooks} selectedIds={selectedIds} onSelect={(it) => onSelect(itemToNote(it))} />
            )
          ) : baseItems.length === 0 ? (
            <EmptyState message={emptyMessage(activeTab)} />
          ) : (
            <ItemList items={baseItems} notebooks={notebooks} selectedIds={selectedIds} onSelect={(it) => onSelect(itemToNote(it))} />
          )}
        </div>
      </div>
    </Modal>
  );
}

function emptyMessage(tab: 'recent' | 'notes' | 'dictations' | 'meetings'): string {
  switch (tab) {
    case 'notes':
      return 'No notes yet. Create one from the Notes page to attach it as context.';
    case 'dictations':
      return 'No dictations yet. Open the Dictate page and record something to attach it.';
    case 'meetings':
      return 'No meetings yet. Start a Granola-mode recording from the Meetings page.';
    default:
      return 'Nothing to attach yet. Dictate, take a note, or record a meeting first.';
  }
}

function KindBadge({ kind }: { kind: Kind }) {
  if (kind === 'dictation') {
    return (
      <span className="inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded bg-iron-accent/10 text-iron-accent-light">
        <Mic className="w-2.5 h-2.5" />
        Dictation
      </span>
    );
  }
  if (kind === 'meeting') {
    return (
      <span className="inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400">
        <Users className="w-2.5 h-2.5" />
        Meeting
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400">
      <StickyNote className="w-2.5 h-2.5" />
      Note
    </span>
  );
}

function ItemList({ items, notebooks, selectedIds, onSelect }: {
  items: PickerItem[];
  notebooks: Notebook[];
  selectedIds?: Set<string>;
  onSelect: (item: PickerItem) => void;
}) {
  return (
    <div className="space-y-0.5">
      {items.map((it) => {
        // The selectedIds set holds the *prefixed* synthetic id that AIChat
        // received, so we recompute the same prefix here to test membership.
        const synthId = it.kind === 'note' ? it.id : `${it.kind}:${it.id}`;
        const isSelected = selectedIds?.has(synthId);
        const nb = it.kind === 'note' && it.notebookId ? notebooks.find((n) => n.id === it.notebookId) : undefined;
        return (
          <button
            key={`${it.kind}:${it.id}`}
            onClick={() => onSelect(it)}
            className={`w-full text-left px-3 py-2 rounded-lg transition-colors flex items-start gap-2.5 ${
              isSelected
                ? 'bg-iron-accent/10 border border-iron-accent/20'
                : 'hover:bg-iron-surface-hover border border-transparent'
            }`}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                {it.isPinned && <Pin className="w-2.5 h-2.5 text-iron-accent-light flex-shrink-0" />}
                <span className="text-xs font-medium text-iron-text truncate">{it.title || 'Untitled'}</span>
              </div>
              <p className="text-[11px] text-iron-text-muted truncate mt-0.5">
                {it.preview || 'No content'}
              </p>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <KindBadge kind={it.kind} />
                {nb && (
                  <span className="text-[10px] px-1.5 rounded" style={{ color: nb.color, backgroundColor: nb.color + '15' }}>
                    {nb.name}
                  </span>
                )}
                {(it.tags ?? []).slice(0, 3).map((t) => (
                  <span key={t} className="text-[10px] text-iron-text-muted">#{t}</span>
                ))}
              </div>
            </div>
            {isSelected && (
              <Check className="w-4 h-4 text-iron-accent-light flex-shrink-0 mt-0.5" />
            )}
          </button>
        );
      })}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-center py-8">
      <BookOpen className="w-6 h-6 text-iron-text-muted/30 mx-auto mb-2" />
      <p className="text-xs text-iron-text-muted">{message}</p>
    </div>
  );
}
