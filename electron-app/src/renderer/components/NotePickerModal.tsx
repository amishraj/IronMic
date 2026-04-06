import { useState, useMemo } from 'react';
import { Search, StickyNote, BookOpen, Pin, Hash, Check, X } from 'lucide-react';
import { useNotesStore, type Note, type Notebook } from '../stores/useNotesStore';
import { Modal } from './ui';

interface NotePickerModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (note: Note) => void;
  selectedIds?: Set<string>;
}

export function NotePickerModal({ open, onClose, onSelect, selectedIds }: NotePickerModalProps) {
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'recent' | 'notebooks' | 'search'>('recent');

  const notes = useNotesStore((s) => s.notes);
  const notebooks = useNotesStore((s) => s.notebooks);

  const recentNotes = useMemo(() =>
    [...notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10),
    [notes]
  );

  const searchResults = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return notes.filter((n) =>
      n.title.toLowerCase().includes(q) ||
      n.content.toLowerCase().includes(q) ||
      n.tags.some((t) => t.toLowerCase().includes(q))
    ).slice(0, 20);
  }, [query, notes]);

  const notebookNotes = useMemo(() => {
    const map: Record<string, Note[]> = { uncategorized: [] };
    for (const nb of notebooks) map[nb.id] = [];
    for (const note of notes) {
      const key = note.notebookId || 'uncategorized';
      if (!map[key]) map[key] = [];
      map[key].push(note);
    }
    return map;
  }, [notes, notebooks]);

  if (!open) return null;

  return (
    <Modal onClose={onClose} title="Add Note as Context">
      <div className="w-[480px] max-h-[60vh] flex flex-col">
        {/* Search */}
        <div className="px-4 pt-3 pb-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-iron-text-muted" />
            <input
              value={query}
              onChange={(e) => { setQuery(e.target.value); if (e.target.value) setActiveTab('search'); else setActiveTab('recent'); }}
              placeholder="Search notes by title, content, or tag..."
              className="w-full text-xs bg-iron-bg border border-iron-border rounded-lg pl-8 pr-3 py-2 text-iron-text placeholder:text-iron-text-muted focus:outline-none focus:border-iron-accent/50"
              autoFocus
            />
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-4 pb-2">
          {([
            { id: 'recent', label: 'Recent' },
            { id: 'notebooks', label: 'Notebooks' },
          ] as const).map(({ id, label }) => (
            <button
              key={id}
              onClick={() => { setActiveTab(id); setQuery(''); }}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                activeTab === id && !query
                  ? 'bg-iron-accent/15 text-iron-accent-light'
                  : 'text-iron-text-muted hover:bg-iron-surface-hover'
              }`}
            >
              {label}
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
          {activeTab === 'search' && query && (
            <NoteList notes={searchResults} notebooks={notebooks} selectedIds={selectedIds} onSelect={onSelect} />
          )}

          {activeTab === 'recent' && !query && (
            <>
              {recentNotes.length === 0 ? (
                <EmptyState message="No notes yet. Create one from the Notes page." />
              ) : (
                <NoteList notes={recentNotes} notebooks={notebooks} selectedIds={selectedIds} onSelect={onSelect} />
              )}
            </>
          )}

          {activeTab === 'notebooks' && !query && (
            <div className="space-y-3">
              {notebooks.length === 0 && (
                <EmptyState message="No notebooks yet. Create one from the Notes page." />
              )}
              {notebooks.map((nb) => {
                const nbNotes = notebookNotes[nb.id] || [];
                return (
                  <div key={nb.id}>
                    <div className="flex items-center gap-2 px-2 py-1.5">
                      <div className="w-3 h-3 rounded" style={{ backgroundColor: nb.color }} />
                      <span className="text-[11px] font-semibold text-iron-text-secondary">{nb.name}</span>
                      <span className="text-[10px] text-iron-text-muted">{nbNotes.length}</span>
                    </div>
                    {nbNotes.length > 0 ? (
                      <NoteList notes={nbNotes} notebooks={notebooks} selectedIds={selectedIds} onSelect={onSelect} />
                    ) : (
                      <p className="text-[11px] text-iron-text-muted px-2 py-1">No notes in this notebook</p>
                    )}
                  </div>
                );
              })}
              {/* Uncategorized */}
              {(notebookNotes['uncategorized'] || []).length > 0 && (
                <div>
                  <div className="flex items-center gap-2 px-2 py-1.5">
                    <StickyNote className="w-3 h-3 text-iron-text-muted" />
                    <span className="text-[11px] font-semibold text-iron-text-secondary">Uncategorized</span>
                  </div>
                  <NoteList notes={notebookNotes['uncategorized']} notebooks={notebooks} selectedIds={selectedIds} onSelect={onSelect} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function NoteList({ notes, notebooks, selectedIds, onSelect }: {
  notes: Note[]; notebooks: Notebook[]; selectedIds?: Set<string>; onSelect: (note: Note) => void;
}) {
  return (
    <div className="space-y-0.5">
      {notes.map((note) => {
        const isSelected = selectedIds?.has(note.id);
        const nb = notebooks.find((n) => n.id === note.notebookId);
        return (
          <button
            key={note.id}
            onClick={() => onSelect(note)}
            className={`w-full text-left px-3 py-2 rounded-lg transition-colors flex items-start gap-2.5 ${
              isSelected
                ? 'bg-iron-accent/10 border border-iron-accent/20'
                : 'hover:bg-iron-surface-hover border border-transparent'
            }`}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                {note.isPinned && <Pin className="w-2.5 h-2.5 text-iron-accent-light flex-shrink-0" />}
                <span className="text-xs font-medium text-iron-text truncate">{note.title || 'Untitled'}</span>
              </div>
              <p className="text-[11px] text-iron-text-muted truncate mt-0.5">
                {note.content.slice(0, 60).replace(/\n/g, ' ') || 'Empty note'}
              </p>
              <div className="flex items-center gap-2 mt-1">
                {nb && (
                  <span className="text-[10px] px-1.5 rounded" style={{ color: nb.color, backgroundColor: nb.color + '15' }}>
                    {nb.name}
                  </span>
                )}
                {note.tags.slice(0, 3).map((t) => (
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
