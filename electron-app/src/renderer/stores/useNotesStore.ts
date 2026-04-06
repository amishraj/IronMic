import { create } from 'zustand';

// ─── Types ──────────────────────────────────────────

export interface Note {
  id: string;
  title: string;
  content: string;
  notebookId: string | null;
  tags: string[];
  isPinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Notebook {
  id: string;
  name: string;
  color: string;
  createdAt: number;
}

interface NotesStore {
  notes: Note[];
  notebooks: Notebook[];
  activeNoteId: string | null;
  activeNotebookId: string | null; // null = "All Notes"
  searchQuery: string;

  // Note actions
  createNote: (notebookId?: string | null) => string;
  updateNote: (id: string, updates: Partial<Pick<Note, 'title' | 'content' | 'notebookId' | 'tags' | 'isPinned'>>) => void;
  deleteNote: (id: string) => void;
  setActiveNote: (id: string | null) => void;

  // Notebook actions
  createNotebook: (name: string, color?: string) => string;
  renameNotebook: (id: string, name: string) => void;
  deleteNotebook: (id: string) => void;
  setActiveNotebook: (id: string | null) => void;

  // Search
  setSearchQuery: (q: string) => void;

  // Derived
  filteredNotes: () => Note[];
  getNote: (id: string) => Note | undefined;
}

// ─── Persistence ────────────────────────────────────

const NOTES_KEY = 'ironmic-notes';
const NOTEBOOKS_KEY = 'ironmic-notebooks';

function loadNotes(): Note[] {
  try { return JSON.parse(localStorage.getItem(NOTES_KEY) || '[]'); }
  catch { return []; }
}

function loadNotebooks(): Notebook[] {
  try { return JSON.parse(localStorage.getItem(NOTEBOOKS_KEY) || '[]'); }
  catch { return []; }
}

function saveNotes(notes: Note[]) {
  localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
}

function saveNotebooks(notebooks: Notebook[]) {
  localStorage.setItem(NOTEBOOKS_KEY, JSON.stringify(notebooks));
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const NOTEBOOK_COLORS = [
  '#6366F1', '#8B5CF6', '#EC4899', '#F43F5E', '#F97316',
  '#EAB308', '#22C55E', '#14B8A6', '#0EA5E9', '#6B7280',
];

// ─── Store ──────────────────────────────────────────

export const useNotesStore = create<NotesStore>((set, get) => ({
  notes: loadNotes(),
  notebooks: loadNotebooks(),
  activeNoteId: null,
  activeNotebookId: null,
  searchQuery: '',

  // ── Note actions ──

  createNote: (notebookId) => {
    const id = genId();
    const note: Note = {
      id,
      title: '',
      content: '',
      notebookId: notebookId ?? get().activeNotebookId,
      tags: [],
      isPinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const notes = [note, ...get().notes];
    saveNotes(notes);
    set({ notes, activeNoteId: id });
    return id;
  },

  updateNote: (id, updates) => {
    const notes = get().notes.map((n) =>
      n.id === id ? { ...n, ...updates, updatedAt: Date.now() } : n
    );
    saveNotes(notes);
    set({ notes });
  },

  deleteNote: (id) => {
    const notes = get().notes.filter((n) => n.id !== id);
    saveNotes(notes);
    const activeNoteId = get().activeNoteId === id ? null : get().activeNoteId;
    set({ notes, activeNoteId });
  },

  setActiveNote: (id) => set({ activeNoteId: id }),

  // ── Notebook actions ──

  createNotebook: (name, color) => {
    const id = genId();
    const notebook: Notebook = {
      id,
      name,
      color: color || NOTEBOOK_COLORS[get().notebooks.length % NOTEBOOK_COLORS.length],
      createdAt: Date.now(),
    };
    const notebooks = [...get().notebooks, notebook];
    saveNotebooks(notebooks);
    set({ notebooks });
    return id;
  },

  renameNotebook: (id, name) => {
    const notebooks = get().notebooks.map((nb) =>
      nb.id === id ? { ...nb, name } : nb
    );
    saveNotebooks(notebooks);
    set({ notebooks });
  },

  deleteNotebook: (id) => {
    const notebooks = get().notebooks.filter((nb) => nb.id !== id);
    saveNotebooks(notebooks);
    // Move notes from deleted notebook to uncategorized
    const notes = get().notes.map((n) =>
      n.notebookId === id ? { ...n, notebookId: null, updatedAt: Date.now() } : n
    );
    saveNotes(notes);
    const activeNotebookId = get().activeNotebookId === id ? null : get().activeNotebookId;
    set({ notebooks, notes, activeNotebookId });
  },

  setActiveNotebook: (id) => set({ activeNotebookId: id, activeNoteId: null }),

  // ── Search ──

  setSearchQuery: (q) => set({ searchQuery: q }),

  // ── Derived ──

  filteredNotes: () => {
    const { notes, activeNotebookId, searchQuery } = get();
    let filtered = notes;

    // Filter by notebook
    if (activeNotebookId) {
      filtered = filtered.filter((n) => n.notebookId === activeNotebookId);
    }

    // Filter by search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter((n) =>
        n.title.toLowerCase().includes(q) ||
        n.content.toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q))
      );
    }

    // Pinned first, then by updated date
    return filtered.sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  },

  getNote: (id) => get().notes.find((n) => n.id === id),
}));
