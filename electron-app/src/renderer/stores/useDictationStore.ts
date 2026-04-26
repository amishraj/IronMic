/**
 * useDictationStore — owns streaming dictation state at the app level so it
 * survives navigation away from the Dictate page.
 *
 * Why: previously the streaming status + current entry id lived in
 * DictatePage's local useState. Navigating away unmounted the component
 * and the UI elsewhere (sidebar mic shield, status badges) had no way to
 * know dictation was still running in main. Chunks kept flowing but the
 * app looked idle — confusing and scary.
 *
 * Design:
 *  - Subscribe ONCE at module load to the main-process streaming events
 *    (chunk + state). These listeners outlive any component.
 *  - Accumulate the full transcribed text in the store so we can:
 *      a) rehydrate the editor if the user navigates back
 *      b) persist to the current entry even when the editor isn't mounted
 *  - Expose start/stop actions that own the entry-creation + notebook-tag
 *    lifecycle so DictatePage (and any future caller) doesn't duplicate
 *    logic.
 *
 * DictatePage still owns the TipTap editor itself; this store just keeps
 * the editor in sync by publishing each arriving chunk's text.
 */

import { create } from 'zustand';
import { TITLE_TAG_PREFIX, NOTEBOOK_TAG_PREFIX, STATUS_TAG_PREFIX, type NoteStatus } from '../types';
import { getDefaultNotebookId } from '../services/notebooks';

export type DictationStatus = 'idle' | 'recording' | 'stopping';

interface DictationState {
  status: DictationStatus;
  entryId: string | null;
  title: string | null;
  /** Notebook the next/current dictation will be saved into. Defaults to the
   *  seeded "My Notes" notebook but can be changed mid-session via the header
   *  picker in DictatePage; that flips the current entry's notebook tag live. */
  notebookId: string;
  /** Accumulated transcribed text across all chunks (space-joined). */
  fullText: string;
  chunkCount: number;
  /** Monotonically increments per chunk so UI can subscribe to a primitive
   *  rather than diffing fullText. */
  chunkSeq: number;
  /** Text of the most recent chunk — the bit to append to the editor. */
  lastChunkText: string;

  /** Set by Layout when the user clicks the mic shield from another page.
   *  DictatePage reads + clears this on mount to auto-start recording. */
  pendingQuickStart: boolean;

  /** Set by Layout so NoteEditor starts a blank note instead of loading the
   *  most-recent entry. Consumed (cleared) by NoteEditor on mount. */
  newNoteRequested: boolean;

  setNotebook: (id: string) => void;
  setTitle: (title: string) => void;
  /** Reset everything (used by the "Done" button after the note is filed). */
  resetSession: () => void;

  /** Ensure an entry exists (with a "Note #N" title if none) tagged with the
   *  current notebookId, then kick off the main-process streamer. */
  start: (opts: { computedTitle: string; defaultPlainText?: string }) => Promise<string>;
  /** Stop the main-process streamer; final chunk arrives via the subscribed event. */
  stop: () => Promise<void>;
  /** Reassign the current entry's notebook tag without restarting dictation. */
  moveCurrentToNotebook: (notebookId: string) => Promise<void>;
  /** Stamp a given entry's lifecycle status tag (draft | done). */
  setEntryStatus: (entryId: string, status: NoteStatus) => Promise<void>;
}

/** Merge a title into a tags JSON array, replacing any existing title tag. */
function tagsWithTitle(existingTagsJson: string | null | undefined, title: string): string[] {
  let arr: string[] = [];
  if (existingTagsJson) {
    try {
      const parsed = JSON.parse(existingTagsJson);
      if (Array.isArray(parsed)) arr = parsed.filter((s) => typeof s === 'string');
    } catch { /* ignore */ }
  }
  arr = arr.filter((s) => !s.startsWith(TITLE_TAG_PREFIX));
  arr.push(TITLE_TAG_PREFIX + title);
  return arr;
}

/** Merge a notebook id into a tags array, replacing any existing notebook tag. */
function tagsWithNotebook(arr: string[], notebookId: string): string[] {
  const filtered = arr.filter((s) => !s.startsWith(NOTEBOOK_TAG_PREFIX));
  filtered.push(NOTEBOOK_TAG_PREFIX + notebookId);
  return filtered;
}

/** Merge a lifecycle status into a tags array, replacing any prior status. */
function tagsWithStatus(arr: string[], status: NoteStatus): string[] {
  const filtered = arr.filter((s) => !s.startsWith(STATUS_TAG_PREFIX));
  filtered.push(STATUS_TAG_PREFIX + status);
  return filtered;
}

async function readTagsArray(entryId: string): Promise<string[]> {
  try {
    const fresh = await window.ironmic.getEntry(entryId);
    const raw = (fresh as any)?.tags;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export const useDictationStore = create<DictationState>((set, get) => ({
  status: 'idle',
  entryId: null,
  title: null,
  notebookId: getDefaultNotebookId(),
  fullText: '',
  chunkCount: 0,
  chunkSeq: 0,
  lastChunkText: '',
  pendingQuickStart: false,
  newNoteRequested: false,

  setNotebook: (id) => set({ notebookId: id }),
  setTitle: (title) => set({ title }),
  resetSession: () => set({
    entryId: null,
    title: null,
    fullText: '',
    chunkCount: 0,
    chunkSeq: 0,
    lastChunkText: '',
  }),

  start: async ({ computedTitle, defaultPlainText }) => {
    const api = window.ironmic;
    const state = get();
    // Create the entry up-front so arriving chunks have a target to persist into.
    let entryId = state.entryId;
    if (!entryId) {
      const entry = await api.createEntry({
        rawTranscript: defaultPlainText || ' ',
        polishedText: undefined,
        durationSeconds: undefined,
        sourceApp: 'dictate',
      } as any);
      entryId = (entry as any).id as string;
    }
    // Write title + notebook + status tags.
    // The previous logic was `state.title ? existing : tagsWithTitle(...)` — a
    // backwards ternary that caused the title tag to be SKIPPED on the first
    // dictation, because DictatePage sets `state.title` to `computedTitle`
    // BEFORE calling start(). Result: entry got saved with no title tag, and
    // when the user nav'd away + back the UI couldn't read the title → showed
    // the generic "Note" fallback. Fix: always write the title tag.
    // `tagsWithTitle` is idempotent (filters existing title tags first), so
    // the unconditional call is safe and correct.
    const existing = await readTagsArray(entryId);
    const effectiveTitle = state.title || computedTitle;
    const withTitle = tagsWithTitle(JSON.stringify(existing), effectiveTitle);
    const withNotebook = tagsWithNotebook(withTitle, state.notebookId);
    // A freshly-started dictation is a DRAFT until the user hits Done.
    const withStatus = tagsWithStatus(withNotebook, 'draft');
    try { await api.updateEntry(entryId, { tags: JSON.stringify(withStatus) } as any); }
    catch (err) { console.warn('[dictation-store] Failed to persist tags:', err); }

    set({
      entryId,
      title: state.title || computedTitle,
      // Optimistic — real state arrives via the subscribed event listener.
      status: 'recording',
    });

    // Notify any listeners (e.g. NotesSidebar) that entries changed.
    try { window.dispatchEvent(new CustomEvent('ironmic:entries-changed')); }
    catch { /* noop */ }

    try { await api.dictationStreamStart(); }
    catch (err) {
      set({ status: 'idle' });
      throw err;
    }
    return entryId;
  },

  stop: async () => {
    const api = window.ironmic;
    set({ status: 'stopping' });
    try { await api.dictationStreamStop(); }
    catch (err) {
      console.error('[dictation-store] stop failed:', err);
    }
    // Belt-and-braces — main also emits 'idle' via the state event, but make
    // sure we recover if that's dropped.
    setTimeout(() => {
      if (get().status === 'stopping') set({ status: 'idle' });
    }, 800);
  },

  moveCurrentToNotebook: async (notebookId) => {
    set({ notebookId });
    const { entryId } = get();
    if (!entryId) return;
    const existing = await readTagsArray(entryId);
    const next = tagsWithNotebook(existing, notebookId);
    try { await window.ironmic.updateEntry(entryId, { tags: JSON.stringify(next) } as any); }
    catch (err) { console.warn('[dictation-store] Failed to move notebook:', err); }
    try { window.dispatchEvent(new CustomEvent('ironmic:entries-changed')); } catch { /* noop */ }
  },

  setEntryStatus: async (entryId, status) => {
    const existing = await readTagsArray(entryId);
    const next = tagsWithStatus(existing, status);
    try { await window.ironmic.updateEntry(entryId, { tags: JSON.stringify(next) } as any); }
    catch (err) { console.warn('[dictation-store] Failed to set status:', err); }
    try { window.dispatchEvent(new CustomEvent('ironmic:entries-changed')); } catch { /* noop */ }
  },
}));

// ── Subscribe to main-process events ONCE at module load ───────────────────
// These listeners live for the lifetime of the window, independent of any
// component. That's what makes the state survive nav-away.

if (typeof window !== 'undefined' && (window as any).ironmic) {
  const api = (window as any).ironmic;

  // Debounce DB persistence: fire at most once per 10 s during streaming, and
  // always immediately on the final chunk. This reduces SQLite write load from
  // ~1,440 writes/hour (every 2.5 s chunk) to ~360 writes/hour.
  let dbWriteTimer: ReturnType<typeof setTimeout> | null = null;

  function schedulePersist(entryId: string, text: string, immediate: boolean): void {
    if (dbWriteTimer) {
      clearTimeout(dbWriteTimer);
      dbWriteTimer = null;
    }
    const flush = () => {
      void api.updateEntry(entryId, { rawTranscript: text }).catch(() => { /* best-effort */ });
    };
    if (immediate) {
      flush();
    } else {
      dbWriteTimer = setTimeout(flush, 10_000);
    }
  }

  api.onDictationStreamState?.((s: { status: string; chunkCount: number }) => {
    if (s.status === 'idle' || s.status === 'recording' || s.status === 'stopping') {
      useDictationStore.setState({ status: s.status });
      // When main flips to idle, it means the final chunk has flushed.
      // We keep entryId/fullText populated so UI can show "just finished".
    }
  });
  api.onDictationStreamChunk?.((payload: { index: number; text: string; isFinal: boolean }) => {
    if (!payload.text) return;
    const prev = useDictationStore.getState();
    const appended = (prev.fullText + ' ' + payload.text).replace(/\s+/g, ' ').trim();
    useDictationStore.setState({
      fullText: appended,
      chunkCount: prev.chunkCount + 1,
      chunkSeq: prev.chunkSeq + 1,
      lastChunkText: payload.text,
    });
    // Persist accumulated plain text to the entry even if the editor isn't
    // mounted. If the user is on the page, DictatePage's debounced save will
    // overwrite with the richer HTML-derived text anyway.
    const { entryId } = useDictationStore.getState();
    if (entryId && appended) {
      schedulePersist(entryId, appended, payload.isFinal);
    }
  });
}
