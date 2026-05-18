/**
 * IndexerService — populates `chunks` for existing entries / meetings /
 * user notes so the Ask page has something to search against.
 *
 * Why renderer-side? The chunkers themselves run in Rust (via the N-API
 * `ragChunkEntry` / `ragChunkMeeting` / `ragChunkUserNote` exports). This
 * file is just the scheduler — it picks unchunked sources in small batches
 * and asks main to chunk them, throttled so the UI thread stays responsive
 * during the initial backfill on a user with hundreds of dictations.
 *
 * Lifecycle:
 *   - kickOnce(): single-shot bootstrap on app start. Runs all three source
 *     types in parallel (each in its own batched loop). Emits stats to a
 *     subscribable status so the Ask page's IndexFreshness pill can show
 *     "indexing X of N…" while it runs.
 *   - markDirty(sourceType, id): hot path for new content created at
 *     runtime. Currently a thin wrapper around a single chunk call —
 *     no queue management needed yet because real-time create events are
 *     low-volume.
 *
 * This service is intentionally lazy about embeddings (Slice B). FTS5
 * retrieval works the moment chunks exist; embeddings layer on later as
 * a v1.1 improvement that adds the semantic-similarity path.
 */

type SourceType = 'entry' | 'meeting' | 'user_note';
// Small batch + generous yield to keep the SQLite mutex available for the
// user-facing retrieval path. Earlier values (25 / 50ms) starved the
// "Searching your knowledge…" call when the indexer was mid-meeting-chunk
// on a corpus with hundreds of dictations or long transcripts. Five at a
// time + 200ms yield drops the median latency cost for an interleaved
// retrieval call from "seconds" to "tens of milliseconds" with negligible
// effect on total backfill time (which runs once, on first AI Chat visit).
const BATCH_SIZE = 5;
const BATCH_YIELD_MS = 200;
const SOURCE_TYPES: SourceType[] = ['user_note', 'entry', 'meeting'];

export interface IndexerStatus {
  /** True while a backfill loop is running. */
  running: boolean;
  /** Per-source-type chunk counts written this run. Resets when kickOnce
   *  restarts; cumulative across batches within one run. */
  chunkedThisRun: Record<SourceType, number>;
  /** Last error if any (non-fatal — service keeps trying). */
  lastError: string | null;
}

type Listener = (status: IndexerStatus) => void;

class IndexerServiceImpl {
  private running = false;
  private listeners = new Set<Listener>();
  private status: IndexerStatus = {
    running: false,
    chunkedThisRun: { entry: 0, meeting: 0, user_note: 0 },
    lastError: null,
  };

  /** Has kickOnce been triggered this app session? Prevents the boot path
   *  and any other caller from running multiple concurrent backfills. */
  private kicked = false;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => { this.listeners.delete(fn); };
  }

  private notify() {
    for (const fn of this.listeners) fn(this.status);
  }

  /** Run one bootstrap pass — drain every unchunked source across all three
   *  types. Idempotent; subsequent calls in the same session are no-ops
   *  unless `force` is passed. */
  async kickOnce(opts: { force?: boolean } = {}): Promise<void> {
    if (this.running) return;
    if (this.kicked && !opts.force) return;
    this.kicked = true;
    this.running = true;
    this.status = {
      running: true,
      chunkedThisRun: { entry: 0, meeting: 0, user_note: 0 },
      lastError: null,
    };
    this.notify();

    // Sequential rather than parallel. The Rust addon serializes every
    // SQL call through one mutex, so running all three source types
    // concurrently from JS would just stack three chunkers in front of
    // the user's search query in the lock queue. Sequential lets us
    // finish small/fast types (user_notes, then entries) before chewing
    // through meetings — so a Search query landing mid-backfill has
    // *some* content to work with even on the very first AI Chat visit.
    for (const st of SOURCE_TYPES) {
      await this.drainSourceType(st);
    }

    this.running = false;
    this.status = { ...this.status, running: false };
    this.notify();
  }

  private async drainSourceType(sourceType: SourceType): Promise<void> {
    const api = (window as any).ironmic;
    if (!api?.ragIndexBackfill) {
      console.warn('[IndexerService] ragIndexBackfill not available — skipping');
      return;
    }
    // Loop until the addon reports 0 chunked (no more unchunked rows).
    // Capped at 200 batches per type as a sanity bound (5,000 sources).
    for (let i = 0; i < 200; i++) {
      let chunked = 0;
      try {
        chunked = await api.ragIndexBackfill(sourceType, BATCH_SIZE);
      } catch (err) {
        this.status = {
          ...this.status,
          lastError: err instanceof Error ? err.message : String(err),
        };
        this.notify();
        break;
      }
      if (chunked === 0) break;
      this.status = {
        ...this.status,
        chunkedThisRun: {
          ...this.status.chunkedThisRun,
          [sourceType]: this.status.chunkedThisRun[sourceType] + chunked,
        },
      };
      this.notify();
      // Yield generously between batches. The yield isn't really for the
      // JS event loop — the addon call is sync from JS's POV anyway —
      // it's to give competing N-API calls (notably ragRetrieveHybrid
      // when the user has Search mode on) a window to grab the SQLite
      // mutex between our chunking transactions. Without this delay the
      // indexer can effectively starve the search call for the duration
      // of the backfill.
      await new Promise((resolve) => setTimeout(resolve, BATCH_YIELD_MS));
    }
  }

  /** Hot path: a new entry/meeting/note was created at runtime. Calls the
   *  appropriate chunker. Best-effort — failures log and move on. */
  async markDirty(sourceType: SourceType, sourceId: string): Promise<void> {
    const api = (window as any).ironmic;
    if (!api) return;
    try {
      if (sourceType === 'entry' && api.ragChunkEntry) {
        await api.ragChunkEntry(sourceId);
      } else if (sourceType === 'meeting' && api.ragChunkMeeting) {
        await api.ragChunkMeeting(sourceId);
      } else if (sourceType === 'user_note' && api.ragChunkUserNote) {
        await api.ragChunkUserNote(sourceId);
      }
    } catch (err) {
      console.warn(`[IndexerService] markDirty ${sourceType}/${sourceId} failed:`, err);
    }
  }
}

export const indexerService = new IndexerServiceImpl();
