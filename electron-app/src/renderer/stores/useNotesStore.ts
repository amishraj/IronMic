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
  /** True once the SQLite hydration completes. UI surfaces (note picker,
   *  create button, AIChat attach) gate themselves on this so attach-by-id
   *  flows can't race the initial load. */
  hydrated: boolean;
  /** Per-note save indicator. Ephemeral UI flag — never persisted. */
  noteSaveStatus: Record<string, NoteSaveStatus>;
  /** Notes currently being polished — drives the loading pill in the header. */
  polishingIds: Set<string>;

  // Hydration
  /** Hydrate from SQLite on mount. Runs the one-shot localStorage→SQLite
   *  migration first if needed. Idempotent. Resolves when the in-memory
   *  cache is populated and the store is safe to read from. */
  hydrate: () => Promise<void>;

  // Note actions (sync from caller's POV — see optimistic-cache docs below)
  createNote: (notebookId?: string | null) => string;
  updateNote: (id: string, updates: Partial<Pick<Note, 'title' | 'content' | 'polishedContent' | 'displayMode' | 'notebookId' | 'tags' | 'isPinned'>>) => void;
  deleteNote: (id: string) => void;
  setActiveNote: (id: string | null) => void;
  /** Run the local LLM over `note.content` and store the result in
   *  `polishedContent`. Mirrors `useEntryStore.polishEntry` — same min-words
   *  guard, same `{ requireModel: true }` invocation so a missing cleanup
   *  model surfaces a red toast with "Go to Settings". */
  polishNote: (id: string) => Promise<void>;
  /** Block until every pending write for the listed note IDs (or all notes,
   *  if `ids` is undefined) has either committed to SQLite or rejected.
   *  Callers that need to read canonical persisted state must await this
   *  first — most notably AIChat before invoking `knowledgeAskStart` with
   *  attached notes, so the orchestrator never reads stale content. */
  flushPendingWrites: (ids?: string[]) => Promise<void>;

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

// ─── Persistence layer ──────────────────────────────
//
// The store keeps an optimistic in-memory cache (Zustand state) that's the
// canonical view UI components render from. Reads stay synchronous. Mutations
// (create / update / delete) update the cache immediately and enqueue an
// async write-through to SQLite on a per-id serial queue.
//
// Per-id serial queues guarantee that rapid edits (typing, debounced saves)
// land in the right order even though they overlap in flight: each scheduled
// write awaits the previous one for its note before posting. The wave-front
// is the *last enqueued* promise per id; `flushPendingWrites` simply awaits
// those wave-fronts.

const NOTES_KEY_LEGACY = 'ironmic-notes';
const NOTEBOOKS_KEY_LEGACY = 'ironmic-notebooks';
const MIN_POLISH_WORDS = 4;
const SAVE_STATUS_DEBOUNCE_MS = 600;
const MIGRATED_FLAG = 'notes_migrated_to_sqlite';

const saveStatusTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Per-id wave-front of in-flight persistence work. The value is the most
 * recently scheduled promise for that id — chaining `lastFor.get(id).then(...)`
 * is what serializes writes per id. `flushPendingWrites` resolves by awaiting
 * the current wave-front (which itself awaits everything before it).
 */
const pendingByNote = new Map<string, Promise<void>>();
const pendingByNotebook = new Map<string, Promise<void>>();

function api(): any {
  return (window as any).ironmic;
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Schedule an async operation on the per-id serial queue. The returned
 *  promise resolves/rejects with the operation; rejection toasts and
 *  re-throws so `flushPendingWrites` sees the failure too. */
function enqueue<T>(
  queue: Map<string, Promise<void>>,
  id: string,
  op: () => Promise<T>,
  onError?: (err: unknown) => void,
): Promise<T> {
  const prev = queue.get(id) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined) // a failed prior write should not block subsequent writes
    .then(op);

  // Track the wave-front as a Promise<void> so flushPendingWrites can await
  // it without caring about the operation's return type. Clear from the map
  // once it settles so the queue map doesn't grow unbounded.
  const tracking: Promise<void> = next.then(
    () => undefined,
    (err) => {
      if (onError) onError(err);
      // Re-throw so the caller's `then` chain still rejects, but only after
      // `tracking` has captured the rejection for queue ordering.
      throw err;
    },
  );

  queue.set(id, tracking.catch(() => undefined));
  // Best-effort cleanup: when this op is the most-recent, drop the entry on
  // resolve. If a newer op was enqueued in the meantime, leave its entry
  // alone.
  tracking.finally(() => {
    if (queue.get(id) === tracking.catch(() => undefined)) {
      queue.delete(id);
    }
  });
  return next as Promise<T>;
}

/** Translate the SQLite row shape (snake_case strings, JSON-encoded tags) to
 *  the renderer's Note shape (camelCase, parsed tags, numeric timestamps). */
function dbToNote(row: any): Note {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags ?? '[]');
    if (Array.isArray(parsed)) tags = parsed;
  } catch {
    /* malformed tags — start fresh */
  }
  return {
    id: row.id,
    title: row.title ?? '',
    content: row.content ?? '',
    polishedContent: row.polishedContent ?? null,
    displayMode: (row.displayMode === 'polished' ? 'polished' : 'raw'),
    notebookId: row.notebookId ?? null,
    tags,
    isPinned: !!row.isPinned,
    createdAt: row.createdAt ? Date.parse(row.createdAt) : Date.now(),
    updatedAt: row.updatedAt ? Date.parse(row.updatedAt) : Date.now(),
  };
}

function dbToNotebook(row: any): Notebook {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    createdAt: row.createdAt ? Date.parse(row.createdAt) : Date.now(),
  };
}

function noteToDbCreate(n: Note): any {
  return {
    id: n.id,
    title: n.title,
    content: n.content,
    polishedContent: n.polishedContent ?? null,
    displayMode: n.displayMode,
    notebookId: n.notebookId,
    tags: JSON.stringify(n.tags ?? []),
    isPinned: n.isPinned,
    createdAt: new Date(n.createdAt).toISOString(),
    updatedAt: new Date(n.updatedAt).toISOString(),
  };
}

function buildUpdatePayload(updates: Partial<Pick<Note, 'title' | 'content' | 'polishedContent' | 'displayMode' | 'notebookId' | 'tags' | 'isPinned'>>): any {
  const out: any = {};
  if ('title' in updates) out.title = updates.title;
  if ('content' in updates) out.content = updates.content;
  if ('polishedContent' in updates) {
    // Rust treats empty string as "clear" (see JsUserNoteUpdate doc); pass
    // empty string when the renderer wants to null out the polish.
    out.polishedContent = updates.polishedContent ?? '';
  }
  if ('displayMode' in updates) out.displayMode = updates.displayMode;
  if ('notebookId' in updates) out.notebookId = updates.notebookId ?? '';
  if ('tags' in updates) out.tags = JSON.stringify(updates.tags ?? []);
  if ('isPinned' in updates) out.isPinned = updates.isPinned;
  return out;
}

/**
 * One-shot localStorage → SQLite migration. Reads the legacy keys, shapes
 * them into the bulk-import payload the Rust side expects, calls
 * `userNotesBulkImport`, sets the migrated flag, and clears the legacy
 * keys. Idempotent (returns immediately when the flag is already set or
 * when no legacy data exists).
 */
async function migrateLocalStorageIfNeeded(): Promise<void> {
  const ipc = api();
  if (!ipc) return;

  try {
    const flag = await ipc.getSetting?.(MIGRATED_FLAG);
    if (flag === 'true') return;
  } catch {
    /* fall through — better to attempt the import than skip silently */
  }

  let legacyNotesRaw: string | null = null;
  let legacyBooksRaw: string | null = null;
  try {
    legacyNotesRaw = localStorage.getItem(NOTES_KEY_LEGACY);
    legacyBooksRaw = localStorage.getItem(NOTEBOOKS_KEY_LEGACY);
  } catch {
    /* localStorage disabled — nothing to migrate */
  }

  if (!legacyNotesRaw && !legacyBooksRaw) {
    // Nothing to import — set the flag so we don't re-check forever.
    try { await ipc.setSetting?.(MIGRATED_FLAG, 'true'); } catch { /* noop */ }
    return;
  }

  // Shape into the bulk-import payload. Tags get re-stringified because the
  // legacy store kept them as arrays inside the JSON blob.
  let legacyNotes: any[] = [];
  let legacyBooks: any[] = [];
  try { legacyNotes = legacyNotesRaw ? JSON.parse(legacyNotesRaw) : []; } catch { legacyNotes = []; }
  try { legacyBooks = legacyBooksRaw ? JSON.parse(legacyBooksRaw) : []; } catch { legacyBooks = []; }

  const notes = legacyNotes.map((n: any) => ({
    id: n.id,
    title: n.title ?? '',
    content: n.content ?? '',
    polishedContent: n.polishedContent ?? null,
    displayMode: n.displayMode === 'polished' ? 'polished' : 'raw',
    notebookId: n.notebookId ?? null,
    tags: JSON.stringify(Array.isArray(n.tags) ? n.tags : []),
    isPinned: !!n.isPinned,
    createdAt: n.createdAt ? new Date(n.createdAt).toISOString() : new Date().toISOString(),
    updatedAt: n.updatedAt ? new Date(n.updatedAt).toISOString() : new Date().toISOString(),
  }));
  const notebooks = legacyBooks.map((nb: any) => ({
    id: nb.id,
    name: nb.name,
    color: nb.color ?? '#6366F1',
    createdAt: nb.createdAt ? new Date(nb.createdAt).toISOString() : new Date().toISOString(),
  }));

  // Defense in depth: if any of the addon hooks we depend on are missing
  // (e.g. the user is running with an older Rust binary that pre-dates v13),
  // we must NOT clear localStorage or set the migrated flag. A stub or absent
  // function returning 0 / undefined would otherwise look like "successful
  // import of zero rows" and silently wipe the user's data on the way out.
  if (
    typeof ipc.userNotesBulkImport !== 'function' ||
    typeof ipc.userNotesList !== 'function'
  ) {
    console.warn('[useNotesStore] Native addon lacks user_notes API — skipping migration; legacy data preserved.');
    return;
  }

  try {
    await ipc.userNotesBulkImport(JSON.stringify({ notes, notebooks }));

    // Round-trip verification: read back the SQLite note count and make sure
    // it covers what we attempted to import. The bulk_import N-API returns the
    // attempt count (not the insert count, since it uses INSERT OR IGNORE), so
    // we can't trust its return value alone — we have to query.
    let persistedCount = 0;
    try {
      const rows = await ipc.userNotesList({ limit: 99999, offset: 0 });
      persistedCount = Array.isArray(rows) ? rows.length : 0;
    } catch (verifyErr) {
      console.error('[useNotesStore] Post-import verification failed:', verifyErr);
      useToastStore.getState().show({
        type: 'error',
        message: 'Note migration could not be verified — keeping your localStorage copy and will retry on next launch.',
        durationMs: 8000,
      });
      return;
    }

    if (notes.length > 0 && persistedCount < notes.length) {
      console.error(`[useNotesStore] Post-import note count (${persistedCount}) is below expected (${notes.length}) — refusing to clear localStorage.`);
      useToastStore.getState().show({
        type: 'error',
        message: `Note migration looks incomplete (${persistedCount} of ${notes.length} found in SQLite). Keeping your localStorage copy and will retry on next launch.`,
        durationMs: 10000,
      });
      return;
    }

    await ipc.setSetting?.(MIGRATED_FLAG, 'true');
    // Only clear localStorage after the flag flip lands AND we've verified the
    // SQLite copy is at least as large as the source.
    try {
      localStorage.removeItem(NOTES_KEY_LEGACY);
      localStorage.removeItem(NOTEBOOKS_KEY_LEGACY);
    } catch { /* noop */ }
    if (notes.length > 0 || notebooks.length > 0) {
      useToastStore.getState().show({
        type: 'info',
        message: `Migrated ${notes.length} note${notes.length === 1 ? '' : 's'} and ${notebooks.length} notebook${notebooks.length === 1 ? '' : 's'} to local storage.`,
        durationMs: 4000,
      });
    }
  } catch (err) {
    console.error('[useNotesStore] localStorage migration failed:', err);
    // Don't set the flag — we'll retry next boot. Surface a toast so the user
    // knows their notes haven't been imported yet (they're still readable from
    // localStorage on next launch).
    useToastStore.getState().show({
      type: 'error',
      message: 'Failed to migrate notes to local storage — will retry on next launch.',
      durationMs: 6000,
    });
  }
}

// ─── Store ──────────────────────────────────────────

export const useNotesStore = create<NotesStore>((set, get) => ({
  notes: [],
  notebooks: [],
  activeNoteId: null,
  activeNotebookId: null,
  searchQuery: '',
  hydrated: false,
  noteSaveStatus: {},
  polishingIds: new Set<string>(),

  // ── Hydration ──

  hydrate: async () => {
    if (get().hydrated) return;

    await migrateLocalStorageIfNeeded();

    const ipc = api();

    // Helper: read the legacy localStorage payload directly. Used as a last-
    // resort fallback whenever the SQLite path is unavailable — typically
    // "user is running with a pre-v13 Rust addon" — so the UI still shows
    // their notes (read-only-effective: edits will still attempt to persist,
    // but the optimistic cache keeps them visible regardless).
    const loadLegacy = (): { notes: Note[]; notebooks: Notebook[] } => {
      try {
        const rawNotes = JSON.parse(localStorage.getItem(NOTES_KEY_LEGACY) || '[]');
        const rawBooks = JSON.parse(localStorage.getItem(NOTEBOOKS_KEY_LEGACY) || '[]');
        const notes: Note[] = (Array.isArray(rawNotes) ? rawNotes : []).map((n: any) => ({
          id: n.id,
          title: n.title ?? '',
          content: n.content ?? '',
          polishedContent: n.polishedContent ?? null,
          displayMode: n.displayMode === 'polished' ? 'polished' : 'raw',
          notebookId: n.notebookId ?? null,
          tags: Array.isArray(n.tags) ? n.tags : [],
          isPinned: !!n.isPinned,
          createdAt: typeof n.createdAt === 'number' ? n.createdAt : Date.parse(n.createdAt) || Date.now(),
          updatedAt: typeof n.updatedAt === 'number' ? n.updatedAt : Date.parse(n.updatedAt) || Date.now(),
        }));
        const notebooks: Notebook[] = (Array.isArray(rawBooks) ? rawBooks : []).map((nb: any) => ({
          id: nb.id,
          name: nb.name,
          color: nb.color ?? '#6366F1',
          createdAt: typeof nb.createdAt === 'number' ? nb.createdAt : Date.parse(nb.createdAt) || Date.now(),
        }));
        return { notes, notebooks };
      } catch {
        return { notes: [], notebooks: [] };
      }
    };

    // No native API at all (test mode / broken bridge) — read legacy directly.
    if (!ipc) {
      const legacy = loadLegacy();
      set({ ...legacy, hydrated: true });
      return;
    }

    // Addon present but lacking the new methods (older binary). Same fallback.
    if (typeof ipc.userNotesList !== 'function') {
      console.warn('[useNotesStore] Native addon lacks userNotesList — falling back to localStorage. Rebuild the Rust addon to enable SQLite-backed notes.');
      const legacy = loadLegacy();
      set({ ...legacy, hydrated: true });
      if (legacy.notes.length > 0) {
        useToastStore.getState().show({
          type: 'info',
          message: 'Reading notes from legacy storage — rebuild the Rust addon to enable the new SQLite-backed Notes layer.',
          durationMs: 8000,
        });
      }
      return;
    }

    try {
      const [rawNotes, rawBooks] = await Promise.all([
        ipc.userNotesList({ limit: 99999, offset: 0 }),
        ipc.userNotebooksList(),
      ]);
      const notes: Note[] = (rawNotes ?? []).map(dbToNote);
      const notebooks: Notebook[] = (rawBooks ?? []).map(dbToNotebook);

      // If SQLite came back empty AND legacy localStorage still has data, fall
      // back to legacy so the user sees their notes. This covers the window
      // where migration was prevented (e.g. by the bulk_import stub guard) but
      // hydrate doesn't know that — without this, the picker would be empty.
      if (notes.length === 0 && notebooks.length === 0) {
        const legacy = loadLegacy();
        if (legacy.notes.length > 0 || legacy.notebooks.length > 0) {
          console.warn('[useNotesStore] SQLite empty but legacy localStorage has data — surfacing legacy until migration completes.');
          set({ ...legacy, hydrated: true });
          return;
        }
      }

      set({ notes, notebooks, hydrated: true });
    } catch (err) {
      console.error('[useNotesStore] hydration failed:', err);
      const legacy = loadLegacy();
      useToastStore.getState().show({
        type: 'error',
        message: 'Failed to load notes from SQLite — showing legacy copy. Edits may not persist until next launch.',
        durationMs: 8000,
      });
      set({ ...legacy, hydrated: true });
    }
  },

  // ── Note actions ──

  createNote: (notebookId) => {
    const id = genId();
    const now = Date.now();
    const note: Note = {
      id,
      title: '',
      content: '',
      polishedContent: null,
      displayMode: 'raw',
      notebookId: notebookId ?? get().activeNotebookId,
      tags: [],
      isPinned: false,
      createdAt: now,
      updatedAt: now,
    };
    const notes = [note, ...get().notes];
    set({
      notes,
      activeNoteId: id,
      noteSaveStatus: { ...get().noteSaveStatus, [id]: 'saved' },
    });

    // Persist async — caller already has the id and a populated cache entry.
    const ipc = api();
    if (ipc?.userNotesCreate) {
      enqueue(
        pendingByNote,
        id,
        () => ipc.userNotesCreate(noteToDbCreate(note)),
        (err) => {
          console.error('[useNotesStore] persist createNote failed:', err);
          useToastStore.getState().show({
            type: 'error',
            message: 'Failed to save new note to local storage.',
            durationMs: 5000,
          });
        },
      );
    }
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

    const merged: Note = {
      ...current,
      ...updates,
      ...polishReset,
      updatedAt: Date.now(),
    };
    const notes = get().notes.map((n) => (n.id === id ? merged : n));

    // Flip pill to "Draft" immediately, then schedule a flip back to "Saved"
    // after the user pauses typing. Persistence is independent of this UX.
    const nextStatus: Record<string, NoteSaveStatus> = {
      ...get().noteSaveStatus,
      [id]: 'draft',
    };
    const existingTimer = saveStatusTimers.get(id);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      saveStatusTimers.delete(id);
      set({ noteSaveStatus: { ...get().noteSaveStatus, [id]: 'saved' } });
    }, SAVE_STATUS_DEBOUNCE_MS);
    saveStatusTimers.set(id, timer);

    set({ notes, noteSaveStatus: nextStatus });

    // Build a single update payload that combines the explicit changes with
    // the polish-reset side effect, so SQLite sees the same state the UI
    // does. Skip persistence if the field changed only ephemeral state.
    const persistUpdates: Partial<Note> = { ...updates, ...polishReset };
    if (Object.keys(persistUpdates).length === 0) return;

    const ipc = api();
    if (ipc?.userNotesUpdate) {
      enqueue(
        pendingByNote,
        id,
        () => ipc.userNotesUpdate(id, buildUpdatePayload(persistUpdates as any)),
        (err) => {
          console.error('[useNotesStore] persist updateNote failed:', err);
          useToastStore.getState().show({
            type: 'error',
            message: 'Failed to save note edit. Try editing again to retry.',
            durationMs: 5000,
          });
        },
      );
    }
  },

  deleteNote: (id) => {
    const notes = get().notes.filter((n) => n.id !== id);
    const activeNoteId = get().activeNoteId === id ? null : get().activeNoteId;
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

    const ipc = api();
    if (ipc?.userNotesDelete) {
      enqueue(
        pendingByNote,
        id,
        () => ipc.userNotesDelete(id),
        (err) => {
          console.error('[useNotesStore] persist deleteNote failed:', err);
          // No toast: the row may be already gone, or the user has moved on.
        },
      );
    }
  },

  setActiveNote: (id) => set({ activeNoteId: id }),

  polishNote: async (id) => {
    const note = get().notes.find((n) => n.id === id);
    if (!note) return;
    if (get().polishingIds.has(id)) return;

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
      const polished = await (window as any).ironmic.polishText(raw, { requireModel: true });
      const polishedTrim = (polished || '').trim();
      if (!polishedTrim || polishedTrim === raw) {
        useToastStore.getState().show({
          type: 'info',
          message: 'Polish didn\'t change the note — it was already clean.',
          durationMs: 5000,
        });
        return;
      }
      // Persist polished + flip displayMode. Use updateNote so it goes through
      // the queued persistence path; we pass polished_content via the regular
      // update API. We deliberately do NOT call updateNote with `content` —
      // touching content would invalidate the polish we just produced.
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
      set({ notes });
      const ipc = api();
      if (ipc?.userNotesUpdate) {
        enqueue(
          pendingByNote,
          id,
          () =>
            ipc.userNotesUpdate(id, {
              polishedContent: polishedTrim,
              displayMode: 'polished',
            }),
          (err) => {
            console.error('[useNotesStore] persist polish failed:', err);
          },
        );
      }
    } catch (err: any) {
      console.error('Failed to polish note:', err);
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

  flushPendingWrites: async (ids) => {
    const targets = ids ?? Array.from(pendingByNote.keys());
    // Snapshot the wave-fronts so adds during the await don't extend the wait.
    const waves = targets
      .map((id) => pendingByNote.get(id))
      .filter((p): p is Promise<void> => !!p);
    if (waves.length === 0) return;
    // We catch on each promise so one failure doesn't short-circuit the rest;
    // individual errors have already toasted from `enqueue`'s onError.
    await Promise.all(waves.map((p) => p.catch(() => undefined)));
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
    set({ notebooks });

    const ipc = api();
    if (ipc?.userNotebooksCreate) {
      enqueue(
        pendingByNotebook,
        id,
        async () => {
          // Rust assigns its own UUID — we send name + color and ignore the
          // returned id. Our local id is what UI references; later list pulls
          // will reconcile if needed.
          await ipc.userNotebooksCreate(notebook.name, notebook.color);
        },
        (err) => console.error('[useNotesStore] persist createNotebook failed:', err),
      );
    }
    return id;
  },

  renameNotebook: (id, name) => {
    const notebooks = get().notebooks.map((nb) => (nb.id === id ? { ...nb, name } : nb));
    set({ notebooks });
    const ipc = api();
    if (ipc?.userNotebooksRename) {
      enqueue(
        pendingByNotebook,
        id,
        () => ipc.userNotebooksRename(id, name),
        (err) => console.error('[useNotesStore] persist renameNotebook failed:', err),
      );
    }
  },

  deleteNotebook: (id) => {
    const notebooks = get().notebooks.filter((nb) => nb.id !== id);
    // Move notes from deleted notebook to uncategorized in the cache. The
    // Rust delete_notebook does the same SQL-side detach in one transaction.
    const notes = get().notes.map((n) =>
      n.notebookId === id ? { ...n, notebookId: null, updatedAt: Date.now() } : n,
    );
    const activeNotebookId = get().activeNotebookId === id ? null : get().activeNotebookId;
    set({ notebooks, notes, activeNotebookId });

    const ipc = api();
    if (ipc?.userNotebooksDelete) {
      enqueue(
        pendingByNotebook,
        id,
        () => ipc.userNotebooksDelete(id),
        (err) => console.error('[useNotesStore] persist deleteNotebook failed:', err),
      );
    }
  },

  setActiveNotebook: (id) => set({ activeNotebookId: id, activeNoteId: null }),

  // ── Search ──

  setSearchQuery: (q) => set({ searchQuery: q }),

  // ── Derived ──

  filteredNotes: () => {
    const { notes, activeNotebookId, searchQuery } = get();
    let filtered = notes;

    if (activeNotebookId) {
      filtered = filtered.filter((n) => n.notebookId === activeNotebookId);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter((n) =>
        n.title.toLowerCase().includes(q) ||
        n.content.toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q))
      );
    }

    return filtered.sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  },

  getNote: (id) => get().notes.find((n) => n.id === id),
}));

const NOTEBOOK_COLORS = [
  '#6366F1', '#8B5CF6', '#EC4899', '#F43F5E', '#F97316',
  '#EAB308', '#22C55E', '#14B8A6', '#0EA5E9', '#6B7280',
];

// Auto-hydrate on first import. The store can be safely read before this
// promise resolves — components that need to wait should subscribe to
// `hydrated`. We don't .catch() at this level because `hydrate()` already
// handles its own errors with a toast + `hydrated:true` fallback.
useNotesStore.getState().hydrate();
