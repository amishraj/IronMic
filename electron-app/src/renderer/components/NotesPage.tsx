import { useState, useEffect, useRef } from 'react';
import {
  Plus, Search, StickyNote, FolderOpen, Pin, Trash2, Tag, ChevronRight,
  BookOpen, MoreHorizontal, X, Hash, Pencil, Check,
} from 'lucide-react';
import { Card } from './ui';
import { useNotesStore, type Note, type Notebook } from '../stores/useNotesStore';

export function NotesPage() {
  const {
    notebooks, activeNoteId, activeNotebookId, searchQuery,
    createNote, updateNote, deleteNote, setActiveNote,
    createNotebook, renameNotebook, deleteNotebook, setActiveNotebook,
    setSearchQuery, filteredNotes,
  } = useNotesStore();

  const notes = filteredNotes();
  const activeNote = useNotesStore((s) => s.getNote(activeNoteId || ''));

  const [showNewNotebook, setShowNewNotebook] = useState(false);
  const [newNotebookName, setNewNotebookName] = useState('');
  const [editingNotebookId, setEditingNotebookId] = useState<string | null>(null);
  const [editingNotebookName, setEditingNotebookName] = useState('');
  const [tagInput, setTagInput] = useState('');

  const titleRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);

  // Focus title when creating a new note
  useEffect(() => {
    if (activeNote && !activeNote.title && titleRef.current) {
      titleRef.current.focus();
    }
  }, [activeNoteId]);

  const handleCreateNotebook = () => {
    if (!newNotebookName.trim()) return;
    createNotebook(newNotebookName.trim());
    setNewNotebookName('');
    setShowNewNotebook(false);
  };

  const handleAddTag = () => {
    if (!tagInput.trim() || !activeNote) return;
    const tag = tagInput.trim().toLowerCase();
    if (!activeNote.tags.includes(tag)) {
      updateNote(activeNote.id, { tags: [...activeNote.tags, tag] });
    }
    setTagInput('');
  };

  const handleRemoveTag = (tag: string) => {
    if (!activeNote) return;
    updateNote(activeNote.id, { tags: activeNote.tags.filter((t) => t !== tag) });
  };

  const allNotesCount = useNotesStore((s) => s.notes.length);

  return (
    <div className="flex h-full">
      {/* Left sidebar — notebooks */}
      <div className="w-52 flex-shrink-0 border-r border-iron-border bg-iron-surface flex flex-col">
        <div className="px-3 py-3 border-b border-iron-border">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">Notebooks</span>
            <button
              onClick={() => setShowNewNotebook(true)}
              className="p-1 rounded-md text-iron-text-muted hover:text-iron-accent-light hover:bg-iron-surface-hover transition-colors"
              title="New notebook"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

          {showNewNotebook && (
            <div className="flex items-center gap-1 mb-2">
              <input
                value={newNotebookName}
                onChange={(e) => setNewNotebookName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateNotebook()}
                placeholder="Notebook name..."
                className="flex-1 text-xs bg-iron-bg border border-iron-border rounded-md px-2 py-1 text-iron-text placeholder:text-iron-text-muted focus:outline-none focus:border-iron-accent/50"
                autoFocus
              />
              <button onClick={handleCreateNotebook} className="p-1 text-iron-success"><Check className="w-3 h-3" /></button>
              <button onClick={() => setShowNewNotebook(false)} className="p-1 text-iron-text-muted"><X className="w-3 h-3" /></button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {/* All Notes */}
          <button
            onClick={() => setActiveNotebook(null)}
            className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${
              !activeNotebookId ? 'bg-iron-accent/10 text-iron-text font-medium' : 'text-iron-text-secondary hover:bg-iron-surface-hover'
            }`}
          >
            <StickyNote className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="flex-1 text-left">All Notes</span>
            <span className="text-[10px] text-iron-text-muted">{allNotesCount}</span>
          </button>

          {/* Notebooks */}
          {notebooks.map((nb) => {
            const count = useNotesStore.getState().notes.filter((n) => n.notebookId === nb.id).length;
            const isEditing = editingNotebookId === nb.id;

            return (
              <div key={nb.id} className="group relative">
                {isEditing ? (
                  <div className="flex items-center gap-1 px-3 py-1.5">
                    <input
                      value={editingNotebookName}
                      onChange={(e) => setEditingNotebookName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { renameNotebook(nb.id, editingNotebookName); setEditingNotebookId(null); }
                        if (e.key === 'Escape') setEditingNotebookId(null);
                      }}
                      className="flex-1 text-xs bg-iron-bg border border-iron-border rounded-md px-2 py-0.5 text-iron-text focus:outline-none focus:border-iron-accent/50"
                      autoFocus
                    />
                    <button onClick={() => { renameNotebook(nb.id, editingNotebookName); setEditingNotebookId(null); }} className="p-0.5 text-iron-success"><Check className="w-3 h-3" /></button>
                  </div>
                ) : (
                  <button
                    onClick={() => setActiveNotebook(nb.id)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${
                      activeNotebookId === nb.id ? 'bg-iron-accent/10 text-iron-text font-medium' : 'text-iron-text-secondary hover:bg-iron-surface-hover'
                    }`}
                  >
                    <div className="w-3.5 h-3.5 rounded flex-shrink-0" style={{ backgroundColor: nb.color }} />
                    <span className="flex-1 text-left truncate">{nb.name}</span>
                    <span className="text-[10px] text-iron-text-muted">{count}</span>
                    <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5">
                      <button onClick={(e) => { e.stopPropagation(); setEditingNotebookId(nb.id); setEditingNotebookName(nb.name); }} className="p-0.5 hover:text-iron-accent-light"><Pencil className="w-2.5 h-2.5" /></button>
                      <button onClick={(e) => { e.stopPropagation(); deleteNotebook(nb.id); }} className="p-0.5 hover:text-iron-danger"><Trash2 className="w-2.5 h-2.5" /></button>
                    </div>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Middle — note list */}
      <div className="w-64 flex-shrink-0 border-r border-iron-border flex flex-col">
        <div className="px-3 py-3 border-b border-iron-border space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-iron-text">
              {activeNotebookId
                ? notebooks.find((nb) => nb.id === activeNotebookId)?.name || 'Notes'
                : 'All Notes'}
            </h3>
            <button
              onClick={() => createNote()}
              className="p-1.5 rounded-lg bg-iron-accent/10 text-iron-accent-light hover:bg-iron-accent/20 transition-colors"
              title="New note"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-iron-text-muted" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search notes..."
              className="w-full text-xs bg-iron-bg border border-iron-border rounded-lg pl-7 pr-3 py-1.5 text-iron-text placeholder:text-iron-text-muted focus:outline-none focus:border-iron-accent/50"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {notes.length === 0 && (
            <div className="text-center py-10">
              <BookOpen className="w-8 h-8 text-iron-text-muted/30 mx-auto mb-2" />
              <p className="text-xs text-iron-text-muted">No notes yet</p>
              <button
                onClick={() => createNote()}
                className="mt-2 text-xs text-iron-accent-light hover:underline"
              >
                Create your first note
              </button>
            </div>
          )}
          {notes.map((note) => (
            <NoteListItem
              key={note.id}
              note={note}
              active={activeNoteId === note.id}
              notebook={notebooks.find((nb) => nb.id === note.notebookId)}
              onClick={() => setActiveNote(note.id)}
              onDelete={() => deleteNote(note.id)}
              onPin={() => updateNote(note.id, { isPinned: !note.isPinned })}
            />
          ))}
        </div>
      </div>

      {/* Right — note editor */}
      <div className="flex-1 flex flex-col min-w-0">
        {activeNote ? (
          <>
            {/* Note header */}
            <div className="px-6 pt-5 pb-3 border-b border-iron-border">
              <input
                ref={titleRef}
                value={activeNote.title}
                onChange={(e) => updateNote(activeNote.id, { title: e.target.value })}
                placeholder="Note title..."
                className="w-full text-xl font-bold bg-transparent text-iron-text placeholder:text-iron-text-muted/50 focus:outline-none"
              />
              {/* Notebook selector */}
              <div className="flex items-center gap-3 mt-2">
                <select
                  value={activeNote.notebookId || ''}
                  onChange={(e) => updateNote(activeNote.id, { notebookId: e.target.value || null })}
                  className="text-[11px] bg-iron-surface border border-iron-border rounded-md px-2 py-1 text-iron-text-secondary appearance-none cursor-pointer focus:outline-none focus:border-iron-accent/50"
                >
                  <option value="">No notebook</option>
                  {notebooks.map((nb) => (
                    <option key={nb.id} value={nb.id}>{nb.name}</option>
                  ))}
                </select>
                <span className="text-[10px] text-iron-text-muted">
                  {new Date(activeNote.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                </span>
              </div>
              {/* Tags */}
              <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                {activeNote.tags.map((tag) => (
                  <span key={tag} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-iron-accent/10 text-iron-accent-light border border-iron-accent/15">
                    <Hash className="w-2.5 h-2.5" />
                    {tag}
                    <button onClick={() => handleRemoveTag(tag)} className="ml-0.5 hover:text-iron-danger"><X className="w-2.5 h-2.5" /></button>
                  </span>
                ))}
                <div className="inline-flex items-center">
                  <input
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAddTag(); }}
                    placeholder="+ tag"
                    className="text-[10px] bg-transparent text-iron-text-muted placeholder:text-iron-text-muted/50 w-16 focus:outline-none focus:w-24 transition-all"
                  />
                </div>
              </div>
            </div>

            {/* Note content */}
            <div className="flex-1 overflow-y-auto">
              <textarea
                ref={contentRef}
                value={activeNote.content}
                onChange={(e) => updateNote(activeNote.id, { content: e.target.value })}
                placeholder="Start writing..."
                className="w-full h-full px-6 py-4 text-sm leading-relaxed bg-transparent text-iron-text placeholder:text-iron-text-muted/40 resize-none focus:outline-none"
              />
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center">
            <div className="w-14 h-14 rounded-2xl bg-iron-accent/10 flex items-center justify-center mb-4">
              <StickyNote className="w-7 h-7 text-iron-accent-light" />
            </div>
            <p className="text-sm font-medium text-iron-text">Notes</p>
            <p className="text-xs text-iron-text-muted mt-1 max-w-[240px]">
              Select a note to view it, or create a new one to get started.
            </p>
            <button
              onClick={() => createNote()}
              className="mt-4 px-4 py-2 text-xs font-medium bg-gradient-accent text-white rounded-lg hover:shadow-glow transition-all"
            >
              <Plus className="w-3.5 h-3.5 inline mr-1.5" />
              New Note
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function NoteListItem({ note, active, notebook, onClick, onDelete, onPin }: {
  note: Note; active: boolean; notebook?: Notebook; onClick: () => void; onDelete: () => void; onPin: () => void;
}) {
  const preview = note.content.slice(0, 80).replace(/\n/g, ' ') || 'Empty note';
  const time = new Date(note.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 border-b border-iron-border transition-colors group ${
        active ? 'bg-iron-accent/10' : 'hover:bg-iron-surface-hover'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {note.isPinned && <Pin className="w-2.5 h-2.5 text-iron-accent-light flex-shrink-0" />}
            <p className={`text-xs font-medium truncate ${active ? 'text-iron-text' : 'text-iron-text-secondary'}`}>
              {note.title || 'Untitled'}
            </p>
          </div>
          <p className="text-[11px] text-iron-text-muted truncate mt-0.5">{preview}</p>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[10px] text-iron-text-muted">{time}</span>
            {notebook && (
              <span className="text-[10px] px-1.5 py-0 rounded" style={{ color: notebook.color, backgroundColor: notebook.color + '15' }}>
                {notebook.name}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-0.5">
          <button onClick={(e) => { e.stopPropagation(); onPin(); }} className="p-0.5 rounded hover:bg-iron-surface-active" title="Pin">
            <Pin className="w-2.5 h-2.5 text-iron-text-muted" />
          </button>
          <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="p-0.5 rounded hover:bg-iron-danger/10" title="Delete">
            <Trash2 className="w-2.5 h-2.5 text-iron-text-muted hover:text-iron-danger" />
          </button>
        </div>
      </div>
    </button>
  );
}
