import { create } from 'zustand';
import type { Entry, ListOptions } from '../types';

interface EntryStore {
  entries: Entry[];
  loading: boolean;
  hasMore: boolean;
  selectedTag: string | null;

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

const PAGE_SIZE = 20;

export const useEntryStore = create<EntryStore>((set, get) => ({
  entries: [],
  loading: false,
  hasMore: true,
  selectedTag: null,

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

    try {
      const polished = await window.ironmic.polishText(entry.rawTranscript);
      await window.ironmic.updateEntry(id, { polishedText: polished });
      set({
        entries: get().entries.map((e) =>
          e.id === id ? { ...e, polishedText: polished } : e
        ),
      });
    } catch (err) {
      console.error('Failed to polish entry:', err);
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
