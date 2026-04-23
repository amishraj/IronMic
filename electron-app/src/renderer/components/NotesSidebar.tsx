/**
 * NotesSidebar — the hierarchy pane that sits to the left of the dictation
 * editor. Shows notebooks (Meeting Notes, My Notes, user-created ones), each
 * expandable to reveal the notes inside, with the currently-open note
 * highlighted so the user always knows where they are.
 *
 * Data model: we don't have a proper `notebooks` table yet — notebooks are
 * tracked in the `settings` row `notebooks`, and entry→notebook association
 * is encoded as a `__notebook__:<id>` tag (see types/index.ts). The sidebar
 * loads the full (recent) entry list and buckets them by that tag.
 *
 * Refresh signal: the parent (DictatePage) passes a number that increments
 * whenever something happened that might have changed the set of notes
 * (dictation finalized, note created, notebook created). That's simpler
 * than wiring an event bus for this one view.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  ChevronDown, ChevronRight, ChevronLeft, FileText, BookOpen,
  Search, Pin, Trash2, MoreHorizontal, Users, StickyNote,
  PanelLeftOpen, Plus, BookPlus,
} from 'lucide-react';
import type { Entry } from '../types';
import { parseTitleTag, parseNotebookTag, parseStatusTag } from '../types';
import {
  listNotebooks, createNotebook, getDefaultNotebookId,
  getMeetingNotesNotebookId, type Notebook,
} from '../services/notebooks';

interface Props {
  /** Currently-open entry id (highlighted in the list). */
  activeEntryId: string | null;
  /** Click handler: user wants to open a different note. Parent decides
   *  whether to honor the click (e.g. ignore + toast if dictating). */
  onSelectEntry: (entry: Entry) => void;
  /** Click handler for creating a brand-new blank note. Parent typically
   *  calls its own "Done" flow then resets. */
  onNewNote: () => void;
  /** Increment to force a reload from DB. */
  refreshSignal: number;
  /** When true, the sidebar renders as a narrow icon rail instead of the full
   *  tree. Used on small viewports so the editor isn't squeezed. */
  collapsed?: boolean;
  /** Called when the user clicks the collapse/expand toggle in the header. */
  onToggleCollapsed?: () => void;
}

interface NotebookWithNotes extends Notebook {
  notes: Entry[];
}

/** Built-in system notebooks get pinned to the top and rendered with a
 *  distinct icon so they're immediately recognizable. */
function notebookIcon(nbId: string) {
  if (nbId === getMeetingNotesNotebookId()) return <Users className="w-3.5 h-3.5" />;
  if (nbId === getDefaultNotebookId()) return <StickyNote className="w-3.5 h-3.5" />;
  return <BookOpen className="w-3.5 h-3.5" />;
}

function entryPreview(e: Entry): string {
  const raw = e.rawTranscript || '';
  const clean = raw.replace(/\s+/g, ' ').trim();
  return clean.length > 60 ? clean.slice(0, 60) + '…' : clean;
}

function shortTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) {
      return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }
    const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays < 7) {
      return d.toLocaleDateString(undefined, { weekday: 'short' });
    }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

export function NotesSidebar({ activeEntryId, onSelectEntry, onNewNote, refreshSignal, collapsed, onToggleCollapsed }: Props) {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    // Default both system notebooks expanded on first load.
    [getDefaultNotebookId()]: true,
    [getMeetingNotesNotebookId()]: true,
  });
  const [search, setSearch] = useState('');
  const [creatingNotebook, setCreatingNotebook] = useState(false);
  const [newNotebookName, setNewNotebookName] = useState('');

  /** Refresh both notebook metadata and the entry list. */
  const reload = useCallback(async () => {
    try {
      const [nbs, es] = await Promise.all([
        listNotebooks(),
        window.ironmic.listEntries({ limit: 500, offset: 0, archived: false }),
      ]);
      setNotebooks(nbs);
      setEntries(es || []);
    } catch (err) {
      console.warn('[NotesSidebar] reload failed:', err);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload, refreshSignal]);

  // Global bus: any code path that mutates entries (meeting finalization,
  // notebook changes, status flips) dispatches 'ironmic:entries-changed' on
  // window. Listening here means the sidebar stays in sync even when the
  // mutation happened outside DictatePage (e.g. a meeting finished while the
  // user was sitting on the Notes page).
  useEffect(() => {
    const handler = () => { void reload(); };
    window.addEventListener('ironmic:entries-changed', handler);
    return () => window.removeEventListener('ironmic:entries-changed', handler);
  }, [reload]);

  // Bucket entries by their notebook tag. Also maintain an "Unfiled" bucket
  // for anything that somehow ended up without a notebook tag (legacy
  // entries, pre-notebook entries, etc.) so the user can still find them.
  const { grouped, unfiled } = useMemo(() => {
    const g = new Map<string, Entry[]>();
    const u: Entry[] = [];
    const filter = search.trim().toLowerCase();

    const matchesSearch = (e: Entry): boolean => {
      if (!filter) return true;
      const title = parseTitleTag(e.tags) ?? '';
      const body = e.rawTranscript || '';
      return (
        title.toLowerCase().includes(filter) ||
        body.toLowerCase().includes(filter)
      );
    };

    for (const e of entries) {
      if (!matchesSearch(e)) continue;
      const nbId = parseNotebookTag(e.tags);
      if (!nbId) { u.push(e); continue; }
      const bucket = g.get(nbId) ?? [];
      bucket.push(e);
      g.set(nbId, bucket);
    }
    // Sort each bucket by updatedAt desc so the most recently touched note
    // of each notebook is at the top (matches how any notes app behaves).
    for (const [, arr] of g) {
      arr.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    }
    u.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return { grouped: g, unfiled: u };
  }, [entries, search]);

  // Order: Meeting Notes first (most used for review), then My Notes, then
  // user-created notebooks in creation order.
  const orderedNotebooks = useMemo<NotebookWithNotes[]>(() => {
    const priority = (id: string) => {
      if (id === getMeetingNotesNotebookId()) return 0;
      if (id === getDefaultNotebookId()) return 1;
      return 2;
    };
    return [...notebooks]
      .sort((a, b) => {
        const p = priority(a.id) - priority(b.id);
        if (p !== 0) return p;
        return a.createdAt.localeCompare(b.createdAt);
      })
      .map(nb => ({ ...nb, notes: grouped.get(nb.id) ?? [] }));
  }, [notebooks, grouped]);

  const toggle = useCallback((id: string) => {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const handleCreateNotebook = useCallback(async () => {
    const name = newNotebookName.trim();
    if (!name) { setCreatingNotebook(false); return; }
    try {
      const nb = await createNotebook(name);
      setNewNotebookName('');
      setCreatingNotebook(false);
      setExpanded(prev => ({ ...prev, [nb.id]: true }));
      await reload();
    } catch (err) {
      console.warn('[NotesSidebar] Failed to create notebook:', err);
    }
  }, [newNotebookName, reload]);

  const handleDeleteEntry = useCallback(async (id: string) => {
    try {
      await window.ironmic.archiveEntry(id, true);
      await reload();
    } catch { /* noop */ }
  }, [reload]);

  // Collapsed rail: a thin icon-only strip so users can still expand/create
  // notes on narrow viewports without the 240px sidebar stealing editor width.
  if (collapsed) {
    return (
      <div className="w-9 flex-shrink-0 border-r border-iron-border bg-iron-surface/60 flex flex-col items-center py-2">
        {/* Top: action icons */}
        <div className="flex flex-col items-center gap-1">
          <button
            onClick={onNewNote}
            className="p-1.5 rounded text-iron-text-muted hover:text-iron-accent-light hover:bg-iron-surface-hover transition-colors"
            title="New note"
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            onClick={() => { onToggleCollapsed?.(); setCreatingNotebook(true); }}
            className="p-1.5 rounded text-iron-text-muted hover:text-iron-accent-light hover:bg-iron-surface-hover transition-colors"
            title="New notebook"
          >
            <BookPlus className="w-4 h-4" />
          </button>
        </div>
        {/* Bottom: expand button */}
        <div className="mt-auto">
          <button
            onClick={onToggleCollapsed}
            className="p-1.5 rounded text-iron-text-muted hover:text-iron-accent-light hover:bg-iron-surface-hover transition-colors"
            title="Expand notebooks"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-60 flex-shrink-0 border-r border-iron-border bg-iron-surface/60 flex flex-col">
      {/* Header */}
      <div className="px-3 pt-3 pb-2 border-b border-iron-border/60 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-iron-text-muted">
            Notebooks
          </h3>
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setCreatingNotebook(true)}
              className="p-1 rounded text-iron-text-muted hover:text-iron-accent-light hover:bg-iron-surface-hover transition-colors"
              title="New notebook"
            >
              <BookPlus className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onNewNote}
              className="p-1 rounded text-iron-text-muted hover:text-iron-accent-light hover:bg-iron-surface-hover transition-colors"
              title="New note"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-iron-text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search notes…"
            className="w-full text-[11px] bg-iron-bg/80 border border-iron-border rounded-md pl-6 pr-2 py-1 text-iron-text placeholder:text-iron-text-muted focus:outline-none focus:border-iron-accent/50"
          />
        </div>
        {creatingNotebook && (
          <div className="flex items-center gap-1">
            <input
              value={newNotebookName}
              onChange={(e) => setNewNotebookName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreateNotebook();
                if (e.key === 'Escape') { setCreatingNotebook(false); setNewNotebookName(''); }
              }}
              placeholder="Notebook name…"
              autoFocus
              className="flex-1 text-xs bg-iron-bg border border-iron-border rounded px-2 py-1 text-iron-text placeholder:text-iron-text-muted focus:outline-none focus:border-iron-accent/50"
            />
          </div>
        )}
      </div>

      {/* Scrollable tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {orderedNotebooks.map((nb) => {
          const isOpen = !!expanded[nb.id];
          return (
            <div key={nb.id} className="mb-0.5">
              <button
                onClick={() => toggle(nb.id)}
                className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-iron-text-secondary hover:bg-iron-surface-hover transition-colors group"
              >
                {isOpen
                  ? <ChevronDown className="w-3 h-3 flex-shrink-0 text-iron-text-muted" />
                  : <ChevronRight className="w-3 h-3 flex-shrink-0 text-iron-text-muted" />}
                <span className="flex-shrink-0 text-iron-accent-light/80">{notebookIcon(nb.id)}</span>
                <span className="flex-1 text-left font-medium truncate">{nb.name}</span>
                <span className="text-[10px] text-iron-text-muted tabular-nums">{nb.notes.length}</span>
              </button>

              {isOpen && nb.notes.length > 0 && (
                <div className="pl-2">
                  {nb.notes.map((e) => (
                    <NoteRow
                      key={e.id}
                      entry={e}
                      active={activeEntryId === e.id}
                      onClick={() => onSelectEntry(e)}
                      onDelete={() => void handleDeleteEntry(e.id)}
                    />
                  ))}
                </div>
              )}
              {isOpen && nb.notes.length === 0 && (
                <div className="pl-7 pr-3 py-1 text-[10px] text-iron-text-muted/60 italic">
                  No notes yet
                </div>
              )}
            </div>
          );
        })}

        {unfiled.length > 0 && (
          <div className="mt-2 mb-1">
            <button
              onClick={() => toggle('__unfiled__')}
              className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-iron-text-secondary hover:bg-iron-surface-hover"
            >
              {expanded['__unfiled__']
                ? <ChevronDown className="w-3 h-3 flex-shrink-0 text-iron-text-muted" />
                : <ChevronRight className="w-3 h-3 flex-shrink-0 text-iron-text-muted" />}
              <FileText className="w-3.5 h-3.5 flex-shrink-0 text-iron-text-muted" />
              <span className="flex-1 text-left font-medium truncate">Unfiled</span>
              <span className="text-[10px] text-iron-text-muted tabular-nums">{unfiled.length}</span>
            </button>
            {expanded['__unfiled__'] && (
              <div className="pl-2">
                {unfiled.map((e) => (
                  <NoteRow
                    key={e.id}
                    entry={e}
                    active={activeEntryId === e.id}
                    onClick={() => onSelectEntry(e)}
                    onDelete={() => void handleDeleteEntry(e.id)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom: collapse button — centered, no border */}
      {onToggleCollapsed && (
        <div className="py-1.5 flex justify-center">
          <button
            onClick={onToggleCollapsed}
            className="p-1 rounded text-iron-text-muted hover:text-iron-accent-light hover:bg-iron-surface-hover transition-colors"
            title="Collapse notebooks"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function NoteRow({ entry, active, onClick, onDelete }: {
  entry: Entry; active: boolean; onClick: () => void; onDelete: () => void;
}) {
  const title = parseTitleTag(entry.tags) || 'Untitled';
  const status = parseStatusTag(entry.tags);
  const isDraft = status === 'draft';
  const [hovered, setHovered] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <div
      className={`group relative pl-5 pr-2 py-1.5 cursor-pointer border-l-2 transition-colors ${
        active
          ? 'bg-iron-accent/10 border-iron-accent-light'
          : isDraft
            ? 'border-transparent hover:bg-amber-500/5'
            : 'border-transparent hover:bg-iron-surface-hover/60'
      }`}
      onClick={confirmingDelete ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setConfirmingDelete(false); }}
    >
      <div className="flex items-center justify-between gap-1">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            {isDraft && (
              <span
                className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0"
                title="Draft — not yet marked Done"
              />
            )}
            {entry.isPinned && <Pin className="w-2.5 h-2.5 text-iron-accent-light flex-shrink-0" />}
            <p className={`text-[11px] truncate ${
              active
                ? 'text-iron-text font-medium'
                : isDraft
                  ? 'text-amber-200/90'
                  : 'text-iron-text-secondary'
            }`}>
              {title}
            </p>
          </div>
          <p className="text-[10px] text-iron-text-muted/70 truncate mt-0.5">
            {entryPreview(entry) || 'Empty note'}
          </p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {confirmingDelete ? (
            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <span className="text-[9px] text-iron-text-muted">Delete?</span>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="text-[9px] font-medium px-1 py-0.5 rounded bg-iron-danger/15 text-iron-danger hover:bg-iron-danger/25 transition-colors"
              >
                Yes
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setConfirmingDelete(false); }}
                className="text-[9px] font-medium px-1 py-0.5 rounded bg-iron-surface-hover text-iron-text-muted hover:text-iron-text transition-colors"
              >
                No
              </button>
            </div>
          ) : hovered ? (
            <button
              onClick={(e) => { e.stopPropagation(); setConfirmingDelete(true); }}
              className="p-0.5 rounded text-iron-text-muted hover:text-iron-danger hover:bg-iron-danger/10 transition-colors"
              title="Delete note"
            >
              <Trash2 className="w-2.5 h-2.5" />
            </button>
          ) : (
            <span className="text-[9px] text-iron-text-muted/60 tabular-nums">
              {shortTime(entry.updatedAt)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// MoreHorizontal re-export — unused import guard for bundlers that mark unused
// lucide imports as warnings. (Keeps the import block scannable when we later
// add per-note context menu.)
void MoreHorizontal;
