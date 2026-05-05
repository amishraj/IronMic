/**
 * Renderer-side cache of the user's custom dictionary words.
 *
 * Used by single-shot dictation finalize (useRecordingStore) to apply
 * fuzzy post-correction without an N-API round-trip per dictation. The
 * main process keeps its own parallel cache (`main/dictionary-cache.ts`)
 * for streaming dictation + meeting recorder; both are invalidated by
 * the same `dictionary-changed` IPC event.
 *
 * Lazy-fetched on first read, refreshed on the next read after a
 * mutation. We do not eagerly refetch so add/remove bursts collapse.
 */

let cached: string[] | null = null;
let subscribed = false;

function ensureSubscribed(): void {
  if (subscribed) return;
  // window.ironmic is exposed by the preload; guard for SSR / test environments.
  const api = (window as any)?.ironmic;
  if (!api?.onDictionaryChanged) return;
  api.onDictionaryChanged(() => {
    cached = null;
  });
  subscribed = true;
}

export async function getCachedDictionary(): Promise<string[]> {
  ensureSubscribed();
  if (cached !== null) return cached;
  try {
    const list = await (window as any).ironmic.listDictionary();
    cached = Array.isArray(list) ? list : [];
  } catch (err) {
    console.warn('[dictionaryCache] listDictionary failed:', err);
    cached = [];
  }
  return cached;
}

export function invalidateDictionaryCache(): void {
  cached = null;
}
