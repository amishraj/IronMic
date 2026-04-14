import { create } from 'zustand';
import type {
  AnalyticsPeriod,
  OverviewStats,
  DailySnapshot,
  TopicStat,
  TopicTrend,
  StreakInfo,
  ProductivityComparison,
  VocabularyRichness,
} from '../types';

interface AnalyticsStore {
  // Data
  overview: OverviewStats | null;
  dailyTrend: DailySnapshot[];
  topWords: [string, number][];
  sourceBreakdown: Record<string, number>;
  topicBreakdown: TopicStat[];
  topicTrends: TopicTrend[];
  streaks: StreakInfo | null;
  productivity: ProductivityComparison | null;
  vocabularyRichness: VocabularyRichness | null;

  // UI state
  period: AnalyticsPeriod;
  loading: boolean;
  topicClassificationRunning: boolean;
  unclassifiedCount: number;
  backfillDone: boolean;

  // Actions
  setPeriod: (period: AnalyticsPeriod) => void;
  loadAll: () => Promise<void>;
  runTopicClassification: () => Promise<void>;
  ensureBackfill: () => Promise<void>;
}

function periodToRange(period: AnalyticsPeriod): { from: string; to: string } {
  const today = new Date();
  const to = today.toISOString().slice(0, 10);

  let from: string;
  switch (period) {
    case 'today':
      from = to;
      break;
    case 'week': {
      const day = today.getDay();
      const diff = day === 0 ? 6 : day - 1; // Monday = 0
      const monday = new Date(today);
      monday.setDate(today.getDate() - diff);
      from = monday.toISOString().slice(0, 10);
      break;
    }
    case 'month':
      from = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
      break;
    default:
      from = '2020-01-01';
  }

  return { from, to };
}

export const useAnalyticsStore = create<AnalyticsStore>((set, get) => ({
  overview: null,
  dailyTrend: [],
  topWords: [],
  sourceBreakdown: {},
  topicBreakdown: [],
  topicTrends: [],
  streaks: null,
  productivity: null,
  vocabularyRichness: null,

  period: 'week',
  loading: false,
  topicClassificationRunning: false,
  unclassifiedCount: 0,
  backfillDone: false,

  setPeriod: (period) => {
    set({ period });
    get().loadAll();
  },

  loadAll: async () => {
    set({ loading: true });
    const { period } = get();
    const { from, to } = periodToRange(period);

    // Safe JSON parse — returns fallback on any failure
    function safeParse<T>(json: unknown, fallback: T): T {
      if (json == null || json === '' || json === 'null') return fallback;
      try {
        return typeof json === 'string' ? JSON.parse(json) : (json as T);
      } catch {
        return fallback;
      }
    }

    // Load each independently so one failure doesn't blank the whole page
    const api = (window as any).ironmic;
    if (!api) { set({ loading: false }); return; }

    const safeCall = async <T>(fn: () => Promise<unknown>, fallback: T): Promise<T> => {
      try { return safeParse(await fn(), fallback); } catch { return fallback; }
    };

    const emptyOverview: OverviewStats = {
      total_words: 0, total_sentences: 0, total_entries: 0,
      total_duration_seconds: 0, avg_words_per_minute: 0,
      unique_words: 0, avg_sentence_length: 0, period,
    };

    const [
      overview, dailyTrend, topWords, sourceBreakdown,
      vocabularyRichness, streaks, productivity,
      topicBreakdown, topicTrends, unclassifiedCount,
    ] = await Promise.all([
      safeCall(() => api.analyticsGetOverview(period), emptyOverview),
      safeCall(() => api.analyticsGetDailyTrend(from, to), [] as DailySnapshot[]),
      safeCall(() => api.analyticsGetTopWords(from, to, 20), [] as [string, number][]),
      safeCall(() => api.analyticsGetSourceBreakdown(from, to), {} as Record<string, number>),
      safeCall(() => api.analyticsGetVocabularyRichness(from, to), { ttr: 0, unique_count: 0, total_count: 0 } as VocabularyRichness),
      safeCall(() => api.analyticsGetStreaks(), { current_streak: 0, longest_streak: 0, last_active_date: '' } as StreakInfo),
      safeCall(() => api.analyticsGetProductivityComparison(), { this_period_words: 0, prev_period_words: 0, change_percent: 0, period_label: 'week' } as ProductivityComparison),
      safeCall(() => api.analyticsGetTopicBreakdown(from, to), [] as TopicStat[]),
      safeCall(() => api.analyticsGetTopicTrends(from, to), [] as TopicTrend[]),
      safeCall(async () => { const v = await api.analyticsGetUnclassifiedCount(); return typeof v === 'number' ? v : 0; }, 0),
    ]);

    set({
      overview, dailyTrend, topWords, sourceBreakdown,
      vocabularyRichness, streaks, productivity,
      topicBreakdown, topicTrends, unclassifiedCount,
      loading: false,
    });
  },

  runTopicClassification: async () => {
    set({ topicClassificationRunning: true });
    try {
      const api = (window as any).ironmic;
      if (!api) { set({ topicClassificationRunning: false }); return; }
      await api.analyticsClassifyTopicsBatch(10);
      // Reload topics after classification
      const { period } = get();
      const { from, to } = periodToRange(period);

      let topicBreakdown: TopicStat[] = [];
      let topicTrends: TopicTrend[] = [];
      let unclassifiedCount = 0;
      try {
        const raw = await api.analyticsGetTopicBreakdown(from, to);
        topicBreakdown = raw ? JSON.parse(raw) : [];
      } catch { /* use empty */ }
      try {
        const raw = await api.analyticsGetTopicTrends(from, to);
        topicTrends = raw ? JSON.parse(raw) : [];
      } catch { /* use empty */ }
      try {
        const v = await api.analyticsGetUnclassifiedCount();
        unclassifiedCount = typeof v === 'number' ? v : 0;
      } catch { /* use 0 */ }

      set({ topicBreakdown, topicTrends, unclassifiedCount, topicClassificationRunning: false });
    } catch (err) {
      console.error('[analytics] Topic classification failed:', err);
      set({ topicClassificationRunning: false });
    }
  },

  ensureBackfill: async () => {
    if (get().backfillDone) return;
    try {
      const api = (window as any).ironmic;
      const done = await api.getSetting('analytics_backfill_done');
      if (done === 'true') {
        set({ backfillDone: true });
        return;
      }
      await api.analyticsBackfill();
      await api.setSetting('analytics_backfill_done', 'true');
      set({ backfillDone: true });
    } catch (err) {
      console.error('[analytics] Backfill failed:', err);
      set({ backfillDone: true }); // Don't block the UI
    }
  },
}));
