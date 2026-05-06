/**
 * Process-singleton cache of the user's custom dictionary words for use by
 * post-correction passes in dictation-streamer.ts and meeting-recorder.ts.
 *
 * The Rust addon already keeps the *active engine's* in-memory Dictionary
 * in sync (Whisper biases initial_prompt). This cache is JS-side only —
 * it exists so finalize-time fuzzy correction (Part D2) doesn't N-API
 * round-trip per segment.
 *
 * Invalidation: ipc-handlers.ts calls `notifyDictionaryChanged()` after
 * every `addWord` / `removeWord` invocation. We re-fetch lazily on the
 * next `getWords()` rather than eagerly to absorb bursts.
 */

import { native } from './native-bridge';

let cached: string[] | null = null;

/**
 * Return the current word list. Re-fetches from Rust on first call after
 * `notifyDictionaryChanged()` (or first call ever). Empty list on errors
 * — never throws, never blocks the hot path.
 */
export function getWords(): string[] {
  if (cached !== null) return cached;
  try {
    cached = native.listDictionary() ?? [];
  } catch (err) {
    console.warn('[dictionary-cache] listDictionary failed:', err);
    cached = [];
  }
  return cached;
}

/**
 * Mark the cache as stale. Cheap. Called by the dictionary IPC handlers
 * after a successful add/remove so the next finalize uses fresh terms.
 */
export function notifyDictionaryChanged(): void {
  cached = null;
}
