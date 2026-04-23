import { create } from 'zustand';
import type { Entry, ListOptions } from '../types';
import { useToastStore } from './useToastStore';

interface EntryStore {
  entries: Entry[];
  loading: boolean;
  hasMore: boolean;
  selectedTag: string | null;
  /** IDs of entries currently being polished by the LLM. UI reads this to
   *  show a spinner on the "Polish now" button + disable clicks. Using a
   *  Set keeps membership checks cheap and handles concurrent polish requests
   *  across multiple entries. */
  polishingIds: Set<string>;

  loadEntries: (opts?: Partial<ListOptions>) => Promise<void>;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  deleteEntry: (id: string) => Promise<void>;
  pinEntry: (id: string, pinned: boolean) => Promise<void>;
  archiveEntry: (id: string, archived: boolean) => Promise<void>;
  polishEntry: (id: string) => Promise<void>;
  updateEntryTags: (id: string, tags: string[]) => Promise<void>;
  setSelectedTag: (tag: string | null) => void;
}

/** Minimum input length (in words) before Polish is even attempted.
 *  Below this, the LLM has too little to work with and tends to either
 *  parrot the input back unchanged or fabricate filler. We'd rather show
 *  a toast explaining why than ship bad output. */
const MIN_POLISH_WORDS = 4;

const PAGE_SIZE = 20;

export const useEntryStore = create<EntryStore>((set, get) => ({
  entries: [],
  loading: false,
  hasMore: true,
  selectedTag: null,
  polishingIds: new Set<string>(),

  loadEntries: async (opts = {}) => {
    set({ loading: true });
    try {
      const entries = await window.ironmic.listEntries({
        limit: PAGE_SIZE,
        offset: 0,
        search: opts.search,
        archived: opts.archived ?? false,
      });
      console.log('[entryStore] loadEntries returned:', entries?.length, 'entries');
      set({
        entries: entries || [],
        hasMore: (entries || []).length === PAGE_SIZE,
        loading: false,
      });
    } catch (err) {
      console.error('[entryStore] loadEntries error:', err);
      set({ loading: false });
    }
  },

  loadMore: async () => {
    const { entries, hasMore, loading } = get();
    if (!hasMore || loading) return;

    set({ loading: true });
    try {
      const more = await window.ironmic.listEntries({
        limit: PAGE_SIZE,
        offset: entries.length,
        archived: false,
      });
      set({
        entries: [...entries, ...more],
        hasMore: more.length === PAGE_SIZE,
        loading: false,
      });
    } catch {
      set({ loading: false });
    }
  },

  refresh: async () => {
    await get().loadEntries();
  },

  deleteEntry: async (id) => {
    await window.ironmic.deleteEntry(id);
    set({ entries: get().entries.filter((e) => e.id !== id) });
  },

  pinEntry: async (id, pinned) => {
    await window.ironmic.pinEntry(id, pinned);
    set({
      entries: get().entries.map((e) =>
        e.id === id ? { ...e, isPinned: pinned } : e
      ),
    });
  },

  archiveEntry: async (id, archived) => {
    await window.ironmic.archiveEntry(id, archived);
    set({ entries: get().entries.filter((e) => e.id !== id) });
  },

  polishEntry: async (id) => {
    const entry = get().entries.find((e) => e.id === id);
    if (!entry || entry.polishedText) return;
    // Guard against concurrent polish requests for the same entry.
    if (get().polishingIds.has(id)) return;

    // ── Pre-polish guardrail ──
    // Running the LLM on a near-empty transcript is the reliable way to get
    // a fabricated or parroted result back. Refuse politely instead; the
    // user hasn't dictated enough yet for polish to add value.
    const raw = (entry.rawTranscript || '').trim();
    const words = raw ? raw.split(/\s+/).filter(Boolean).length : 0;
    if (words < MIN_POLISH_WORDS) {
      useToastStore.getState().show({
        type: 'info',
        message: `Not enough content to polish — this note only has ${words} word${words === 1 ? '' : 's'}. Add more text and try again.`,
        durationMs: 5000,
      });
      return;
    }

    // Mark in-flight so the UI can show a spinner.
    const next = new Set(get().polishingIds);
    next.add(id);
    set({ polishingIds: next });

    try {
      const polished = await window.ironmic.polishText(raw);
      // Defensive post-polish check: if the LLM returned empty, identical,
      // or only-whitespace output, treat it as failure rather than saving
      // a useless polished copy. Same spirit as the meeting summarizer's
      // [INSUFFICIENT_CONTENT] sentinel — we'd rather the user see "Polish
      // now" again than a "polished" note that's indistinguishable from raw.
      const polishedTrim = (polished || '').trim();
      if (!polishedTrim || polishedTrim === raw) {
        useToastStore.getState().show({
          type: 'info',
          message: 'Polish didn\'t produce a meaningful change — the raw transcript is already clean.',
          durationMs: 5000,
        });
        return;
      }
      await window.ironmic.updateEntry(id, { polishedText: polishedTrim });
      set({
        entries: get().entries.map((e) =>
          e.id === id ? { ...e, polishedText: polishedTrim } : e
        ),
      });
    } catch (err: any) {
      console.error('Failed to polish entry:', err);
      useToastStore.getState().show({
        type: 'error',
        message: `Polish failed: ${err?.message ?? 'unknown error'}`,
        durationMs: 6000,
      });
    } finally {
      const after = new Set(get().polishingIds);
      after.delete(id);
      set({ polishingIds: after });
    }
  },

  updateEntryTags: async (id, tags) => {
    const tagsJson = JSON.stringify(tags);
    await window.ironmic.updateEntry(id, { tags: tagsJson });
    set({
      entries: get().entries.map((e) =>
        e.id === id ? { ...e, tags: tagsJson } : e
      ),
    });
  },

  setSelectedTag: (tag) => set({ selectedTag: tag }),
}));

// ── Cross-module refresh bus ──
// Any code path that mutates entries (meeting finalization, DictatePage
// Done/Save-draft, notebook changes) dispatches 'ironmic:entries-changed'
// on the window. Listening here keeps the Timeline + any other consumers
// in sync without manually threading refresh() calls through every path.
if (typeof window !== 'undefined') {
  window.addEventListener('ironmic:entries-changed', () => {
    // Fire-and-forget; if we're already loading, the call is cheap and the
    // results get overwritten atomically.
    void useEntryStore.getState().refresh();
  });
}
