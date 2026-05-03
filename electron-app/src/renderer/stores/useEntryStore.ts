import { create } from 'zustand';
import type { Entry, ListOptions } from '../types';
import { useToastStore } from './useToastStore';

export type PolishProvider = 'claude' | 'copilot' | 'local';

interface EntryStore {
  entries: Entry[];
  loading: boolean;
  hasMore: boolean;
  selectedTag: string | null;
  /** IDs of entries currently being polished by the LLM. UI reads this to
   *  show a spinner on the toggle + disable clicks. Using a Set keeps
   *  membership checks cheap and handles concurrent polish requests across
   *  multiple entries. */
  polishingIds: Set<string>;
  /** Cache of entries fetched ad-hoc by id (e.g. older notes opened from the
   *  sidebar that fall outside the timeline's first page). DictatePage and
   *  EntryCard both read through `getEntryById`, which consults `entries`
   *  first then this cache then falls through to a Rust round-trip.
   *  IMPORTANT: every write replaces the Map reference (`new Map(prev)`) so
   *  Zustand selector equality re-renders. Mutating in place would not. */
  entryCache: Map<string, Entry>;
  /** Which provider polished each entry, keyed by entry id. Drives the
   *  "via Claude/Copilot/local" badge next to the toggle. NOT persisted to
   *  SQLite (would drift on refresh) and NOT a field on Entry (would invite
   *  TypeScript drift on DB-fresh entries). Same Map-replacement discipline. */
  polishProviderByEntryId: Map<string, PolishProvider>;

  loadEntries: (opts?: Partial<ListOptions>) => Promise<void>;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  deleteEntry: (id: string) => Promise<void>;
  pinEntry: (id: string, pinned: boolean) => Promise<void>;
  archiveEntry: (id: string, archived: boolean) => Promise<void>;
  /** Polish an entry. `rawOverride` lets DictatePage pass the freshly-typed
   *  editor text (which may not have hit auto-save yet). When set and
   *  different from the stored raw transcript, the override is persisted
   *  before polish runs so a reload mid-polish never sees stale raw. */
  polishEntry: (id: string, opts?: { rawOverride?: string; force?: boolean }) => Promise<void>;
  /** Persist a display-mode flip (raw ↔ polished) and broadcast to other
   *  pages via the existing 'ironmic:entries-changed' bus. */
  setEntryDisplayMode: (id: string, mode: 'raw' | 'polished') => Promise<void>;
  /** Canonical entry lookup. Tries `entries`, then `entryCache`, then a Rust
   *  round-trip. Caches the result so subsequent reads are sync. */
  getEntryById: (id: string) => Promise<Entry | null>;
  updateEntryTags: (id: string, tags: string[]) => Promise<void>;
  setSelectedTag: (tag: string | null) => void;
}

/** Minimum input length (in words) before Polish is even attempted.
 *  Below this, the LLM has too little to work with and tends to either
 *  parrot the input back unchanged or fabricate filler. */
const MIN_POLISH_WORDS = 4;

const PAGE_SIZE = 20;

/** Replace an entry in the timeline list immutably. Returns the previous
 *  array unchanged if the id isn't present (older notes only live in the
 *  cache). */
function patchEntries(prev: Entry[], next: Entry): Entry[] {
  const idx = prev.findIndex((e) => e.id === next.id);
  if (idx === -1) return prev;
  const out = prev.slice();
  out[idx] = next;
  return out;
}

function patchCache(prev: Map<string, Entry>, next: Entry): Map<string, Entry> {
  const out = new Map(prev);
  out.set(next.id, next);
  return out;
}

function setProvider(
  prev: Map<string, PolishProvider>,
  id: string,
  provider: PolishProvider,
): Map<string, PolishProvider> {
  const out = new Map(prev);
  out.set(id, provider);
  return out;
}

export const useEntryStore = create<EntryStore>((set, get) => ({
  entries: [],
  loading: false,
  hasMore: true,
  selectedTag: null,
  polishingIds: new Set<string>(),
  entryCache: new Map<string, Entry>(),
  polishProviderByEntryId: new Map<string, PolishProvider>(),

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
    const nextCache = new Map(get().entryCache);
    nextCache.delete(id);
    const nextProviders = new Map(get().polishProviderByEntryId);
    nextProviders.delete(id);
    set({
      entries: get().entries.filter((e) => e.id !== id),
      entryCache: nextCache,
      polishProviderByEntryId: nextProviders,
    });
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

  getEntryById: async (id) => {
    const fromList = get().entries.find((e) => e.id === id);
    if (fromList) return fromList;
    const fromCache = get().entryCache.get(id);
    if (fromCache) return fromCache;
    try {
      const fetched = await window.ironmic.getEntry(id);
      if (fetched) {
        set({ entryCache: patchCache(get().entryCache, fetched) });
      }
      return fetched ?? null;
    } catch (err) {
      console.warn('[entryStore] getEntryById fallback failed:', err);
      return null;
    }
  },

  setEntryDisplayMode: async (id, mode) => {
    try {
      const updated = await window.ironmic.updateEntry(id, { displayMode: mode });
      if (updated) {
        set({
          entries: patchEntries(get().entries, updated),
          entryCache: patchCache(get().entryCache, updated),
        });
      }
      try { window.dispatchEvent(new CustomEvent('ironmic:entries-changed')); } catch { /* noop */ }
    } catch (err) {
      console.warn('[entryStore] setEntryDisplayMode failed:', err);
      useToastStore.getState().show({
        type: 'error',
        message: 'Failed to switch view. Please try again.',
        durationMs: 4000,
      });
    }
  },

  polishEntry: async (id, opts) => {
    const entry = await get().getEntryById(id);
    if (!entry) {
      console.warn('[entryStore] polishEntry: entry not found:', id);
      useToastStore.getState().show({
        type: 'error',
        message: 'Could not find this note. Try reloading.',
        durationMs: 4000,
      });
      return;
    }
    // Concurrent-call guard.
    if (get().polishingIds.has(id)) return;

    const rawForPolish = (opts?.rawOverride ?? entry.rawTranscript ?? '').trim();
    // Already-polished short-circuit: if there's a polished version that was
    // built against the *current* raw text, the toggle just flips the view —
    // no LLM work needed. setEntryDisplayMode handles that path; this guard
    // only triggers if a caller bypasses the toggle and calls polishEntry
    // directly on already-polished content.
    if (!opts?.force && entry.polishedText && (!opts?.rawOverride || opts.rawOverride === entry.rawTranscript)) {
      return;
    }

    const words = rawForPolish ? rawForPolish.split(/\s+/).filter(Boolean).length : 0;
    if (words < MIN_POLISH_WORDS) {
      useToastStore.getState().show({
        type: 'info',
        message: `Not enough content to polish — only ${words} word${words === 1 ? '' : 's'}. Add more text and try again.`,
        durationMs: 5000,
      });
      return;
    }

    // Mark in-flight before we await — covers the case where the user
    // navigates away mid-polish; subscribers in any page that mounts before
    // completion will still see the spinner.
    set({ polishingIds: new Set(get().polishingIds).add(id) });

    try {
      // Persist the override raw transcript first if it differs from what's
      // stored. This way a mid-polish reload finds the canonical raw the
      // user actually wanted polished, not a stale earlier version.
      if (opts?.rawOverride && opts.rawOverride !== entry.rawTranscript) {
        try {
          const updatedRaw = await window.ironmic.updateEntry(id, { rawTranscript: rawForPolish });
          if (updatedRaw) {
            set({
              entries: patchEntries(get().entries, updatedRaw),
              entryCache: patchCache(get().entryCache, updatedRaw),
            });
          }
        } catch (err) {
          console.warn('[entryStore] failed to persist rawOverride before polish:', err);
        }
      }

      const result = await window.ironmic.polishTextDetailed(rawForPolish, { requireModel: true });
      const polishedTrim = (result?.text || '').trim();
      if (!polishedTrim || polishedTrim === rawForPolish) {
        useToastStore.getState().show({
          type: 'info',
          message: "Polish didn't change the note — it was already clean.",
          durationMs: 5000,
        });
        return;
      }

      // Single round-trip: write polishedText AND displayMode='polished' so
      // Notes/Timeline see a consistent record after one event broadcast.
      // IMPORTANT: do NOT include `polishedTextJson` here. Polish output is
      // plaintext; if the user previously hand-edited the polished side and
      // we wrote a JSON column, that rich state would be silently destroyed
      // every time they re-polished. Omitting the field tells the napi layer
      // to leave the column untouched (Option<String>::None → no SET clause).
      const updated = await window.ironmic.updateEntry(id, {
        polishedText: polishedTrim,
        displayMode: 'polished',
      });
      if (updated) {
        set({
          entries: patchEntries(get().entries, updated),
          entryCache: patchCache(get().entryCache, updated),
          polishProviderByEntryId: setProvider(
            get().polishProviderByEntryId,
            id,
            result.providerUsed,
          ),
        });
      }
      try { window.dispatchEvent(new CustomEvent('ironmic:entries-changed')); } catch { /* noop */ }
    } catch (err: any) {
      console.error('Failed to polish entry:', err);
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
    void useEntryStore.getState().refresh();
  });
}
