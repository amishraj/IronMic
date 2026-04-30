import { create } from 'zustand';
import { useToastStore } from './useToastStore';

// ─── Types ──────────────────────────────────────────

export interface Note {
  id: string;
  title: string;
  content: string;                    // Raw text — the source of truth, edited by the user.
  polishedContent: string | null;     // LLM-polished body, or null if never polished / invalidated by edit.
  displayMode: 'raw' | 'polished';    // Which version the editor is currently rendering.
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

export type NoteSaveStatus = 'draft' | 'saved';

interface NotesStore {
  notes: Note[];
  notebooks: Notebook[];
  activeNoteId: string | null;
  activeNotebookId: string | null; // null = "All Notes"
  searchQuery: string;
  /** Per-note save indicator. Ephemeral UI flag — never persisted. */
  noteSaveStatus: Record<string, NoteSaveStatus>;
  /** Notes currently being polished — drives the loading pill in the header. */
  polishingIds: Set<string>;

  // Note actions
  createNote: (notebookId?: string | null) => string;
  updateNote: (id: string, updates: Partial<Pick<Note, 'title' | 'content' | 'polishedContent' | 'displayMode' | 'notebookId' | 'tags' | 'isPinned'>>) => void;
  deleteNote: (id: string) => void;
  setActiveNote: (id: string | null) => void;
  /** Run the local LLM over `note.content` and store the result in
   *  `polishedContent`. Mirrors `useEntryStore.polishEntry` — same min-words
   *  guard, same `{ requireModel: true }` invocation so a missing cleanup
   *  model surfaces a red toast with "Go to Settings". */
  polishNote: (id: string) => Promise<void>;

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
const MIN_POLISH_WORDS = 4;
const SAVE_STATUS_DEBOUNCE_MS = 600;

// Debounce timer handles for the saved-pill UX. Module-scoped so they never
// leak into the persisted notes payload — the timer itself isn't relevant
// state, only the resulting `noteSaveStatus` flip is.
const saveStatusTimers = new Map<string, ReturnType<typeof setTimeout>>();

function loadNotes(): Note[] {
  try {
    const raw = JSON.parse(localStorage.getItem(NOTES_KEY) || '[]') as any[];
    // Backward-compat: pre-existing notes won't have polishedContent or
    // displayMode. Default them at load time so the rest of the app can
    // assume the fields exist.
    return raw.map((n) => ({
      polishedContent: null as string | null,
      displayMode: 'raw' as const,
      ...n,
    })) as Note[];
  } catch { return []; }
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
  noteSaveStatus: {},
  polishingIds: new Set<string>(),

  // ── Note actions ──

  createNote: (notebookId) => {
    const id = genId();
    const note: Note = {
      id,
      title: '',
      content: '',
      polishedContent: null,
      displayMode: 'raw',
      notebookId: notebookId ?? get().activeNotebookId,
      tags: [],
      isPinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const notes = [note, ...get().notes];
    saveNotes(notes);
    set({
      notes,
      activeNoteId: id,
      // Fresh note hasn't been edited; show "Saved" not "Draft" until the
      // user actually types something.
      noteSaveStatus: { ...get().noteSaveStatus, [id]: 'saved' },
    });
    return id;
  },

  updateNote: (id, updates) => {
    const current = get().notes.find((n) => n.id === id);
    if (!current) return;

    // Editing the body invalidates the polished version: the user has
    // diverged from what the LLM saw, so showing "polished" would be
    // misleading. Title / tags / notebook / pinned changes don't affect
    // body content and should NOT clear polishedContent.
    let polishReset: Partial<Note> = {};
    if (
      Object.prototype.hasOwnProperty.call(updates, 'content') &&
      updates.content !== undefined &&
      updates.content !== current.content
    ) {
      polishReset = { polishedContent: null, displayMode: 'raw' };
    }

    const notes = get().notes.map((n) =>
      n.id === id ? { ...n, ...updates, ...polishReset, updatedAt: Date.now() } : n
    );
    saveNotes(notes);

    // Flip pill to "Draft" immediately, then schedule a flip back to "Saved"
    // after the user pauses typing. The localStorage write above is already
    // synchronous; this is purely UX feedback.
    const nextStatus: Record<string, NoteSaveStatus> = {
      ...get().noteSaveStatus,
      [id]: 'draft',
    };

    const existingTimer = saveStatusTimers.get(id);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      saveStatusTimers.delete(id);
      set({
        noteSaveStatus: { ...get().noteSaveStatus, [id]: 'saved' },
      });
    }, SAVE_STATUS_DEBOUNCE_MS);
    saveStatusTimers.set(id, timer);

    set({ notes, noteSaveStatus: nextStatus });
  },

  deleteNote: (id) => {
    const notes = get().notes.filter((n) => n.id !== id);
    saveNotes(notes);
    const activeNoteId = get().activeNoteId === id ? null : get().activeNoteId;
    // Tidy the per-note state so deleted notes don't leak indicators.
    const { [id]: _drop, ...remainingStatus } = get().noteSaveStatus;
    const remainingPolishing = new Set(get().polishingIds);
    remainingPolishing.delete(id);
    const timer = saveStatusTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      saveStatusTimers.delete(id);
    }
    set({
      notes,
      activeNoteId,
      noteSaveStatus: remainingStatus,
      polishingIds: remainingPolishing,
    });
  },

  setActiveNote: (id) => set({ activeNoteId: id }),

  polishNote: async (id) => {
    const note = get().notes.find((n) => n.id === id);
    if (!note) return;
    if (get().polishingIds.has(id)) return;

    // Mirrors the entry-polish guard: the LLM tends to fabricate when given
    // tiny inputs. Refuse politely instead of generating noise.
    const raw = (note.content || '').trim();
    const words = raw ? raw.split(/\s+/).filter(Boolean).length : 0;
    if (words < MIN_POLISH_WORDS) {
      useToastStore.getState().show({
        type: 'info',
        message: `Not enough content to polish — this note only has ${words} word${words === 1 ? '' : 's'}. Add more text and try again.`,
        durationMs: 5000,
      });
      return;
    }

    const next = new Set(get().polishingIds);
    next.add(id);
    set({ polishingIds: next });

    try {
      const polished = await window.ironmic.polishText(raw, { requireModel: true });
      const polishedTrim = (polished || '').trim();
      if (!polishedTrim || polishedTrim === raw) {
        useToastStore.getState().show({
          type: 'info',
          message: 'Polish didn\'t change the note — it was already clean.',
          durationMs: 5000,
        });
        return;
      }
      // Persist polished + flip displayMode without touching content (so the
      // body-edit-resets-polish guard in updateNote doesn't immediately undo
      // what we just set).
      const notes = get().notes.map((n) =>
        n.id === id
          ? {
              ...n,
              polishedContent: polishedTrim,
              displayMode: 'polished' as const,
              updatedAt: Date.now(),
            }
          : n,
      );
      saveNotes(notes);
      set({ notes });
    } catch (err: any) {
      console.error('Failed to polish note:', err);
      // Detect the no-cleanup-model case via message substring; Electron
      // doesn't reliably preserve custom error properties across IPC.
      const msg = err?.message ?? 'unknown error';
      const isModelMissing =
        msg.includes('Cleanup model not downloaded') ||
        msg.includes('not downloaded') ||
        msg.includes('not found');
      useToastStore.getState().show({
        type: 'error',
        message: isModelMissing
          ? 'Text cleanup model not installed. Import or download one in Settings to polish notes.'
          : `Polish failed: ${msg}`,
        action: isModelMissing
          ? { label: 'Go to Settings', onClick: () => window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'settings' })) }
          : undefined,
        durationMs: 8000,
      });
    } finally {
      const after = new Set(get().polishingIds);
      after.delete(id);
      set({ polishingIds: after });
    }
  },

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
