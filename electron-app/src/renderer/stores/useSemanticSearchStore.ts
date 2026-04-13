/**
 * useSemanticSearchStore — Manages semantic search state and indexing.
 */

import { create } from 'zustand';
import { semanticSearch, type SemanticSearchResult, type IndexingProgress } from '../services/tfjs/SemanticSearch';

interface SemanticSearchStore {
  enabled: boolean;
  modelLoaded: boolean;
  results: SemanticSearchResult[];
  searching: boolean;
  /** Indexing progress (null if not indexing) */
  indexingProgress: IndexingProgress | null;
  totalIndexed: number;
  query: string;

  setEnabled: (enabled: boolean) => void;
  /** Load the USE model */
  loadModel: () => Promise<void>;
  /** Search for semantically similar content */
  search: (query: string, topK?: number) => Promise<void>;
  /** Index all unembedded content */
  reindexAll: () => Promise<void>;
  /** Embed a single piece of content (called after entry creation) */
  embedContent: (contentId: string, contentType: string, text: string) => Promise<void>;
  /** Get stats */
  refreshStats: () => Promise<void>;
  /** Load settings */
  loadFromSettings: () => Promise<void>;
  /** Clear results */
  clearResults: () => void;
}

export const useSemanticSearchStore = create<SemanticSearchStore>((set, get) => ({
  enabled: false,
  modelLoaded: false,
  results: [],
  searching: false,
  indexingProgress: null,
  totalIndexed: 0,
  query: '',

  setEnabled: (enabled) => set({ enabled }),

  loadModel: async () => {
    try {
      await semanticSearch.loadModel();
      set({ modelLoaded: semanticSearch.isModelLoaded() });
    } catch (err) {
      console.warn('[SemanticSearchStore] Model load failed:', err);
    }
  },

  search: async (query, topK = 10) => {
    if (!get().enabled || !get().modelLoaded) return;

    set({ searching: true, query });
    try {
      const results = await semanticSearch.search(query, topK);
      set({ results, searching: false });
    } catch {
      set({ results: [], searching: false });
    }
  },

  reindexAll: async () => {
    if (!get().modelLoaded) return;

    // First, clear existing embeddings
    await semanticSearch.resetIndex();
    set({ totalIndexed: 0 });

    // Then re-index
    const indexed = await semanticSearch.indexUnembeddedContent((progress) => {
      set({ indexingProgress: progress });
    });
    set({ totalIndexed: indexed, indexingProgress: null });
  },

  embedContent: async (contentId, contentType, text) => {
    if (!get().enabled || !get().modelLoaded) return;
    await semanticSearch.embedAndStore(contentId, contentType, text);
  },

  refreshStats: async () => {
    const stats = await semanticSearch.getStats();
    set({ totalIndexed: stats.total });
  },

  loadFromSettings: async () => {
    const ironmic = (window as any).ironmic;
    if (!ironmic) return;

    const enabled = (await ironmic.getSetting('ml_semantic_search_enabled')) === 'true';
    set({ enabled });

    if (enabled) {
      await get().loadModel();
      await get().refreshStats();
    }
  },

  clearResults: () => set({ results: [], query: '' }),
}));
