/**
 * Online + offline acoustic speaker clustering for the dual-stream meeting
 * recorder.
 *
 * Used only on `source === 'loopback'` transcript segments. Each segment's
 * speaker embedding (256-d float32, L2-normalized — produced by WeSpeaker
 * ResNet34 in M2) is fed to `assign()`, which returns a stable label
 * (`[Speaker 1]`, `[Speaker 2]`, …, or `[Speaker ?]` for weak / overflow
 * embeddings) so the renderer can show live speaker badges as audio comes
 * in. At end-of-meeting the recorder pulls every persisted embedding back
 * from SQLite and feeds the rows to `refine()`, which runs agglomerative
 * hierarchical clustering (AHC) over the whole set so drift like
 * "Speaker 1 = Speaker 5 = Speaker 8" gets collapsed and labels are
 * re-assigned by first-occurrence time.
 *
 * Why M1 ships this without the embedding model: the clusterer is
 * deterministic and ML-free, so we can land + test it (10 synthetic
 * Gaussian blobs → V-measure ≥ 0.9) before the WeSpeaker artifact arrives
 * in M2. The recorder constructs an instance per session and confirms
 * lifecycle in M1.4; live calls land in M2.3.
 */

const UNKNOWN_LABEL = '[Speaker ?]';

export interface ClustererConfig {
  /** Cosine-similarity floor below which an embedding is "too weak" and is
   *  routed to `[Speaker ?]` without mutating centroids. Default 0.40 —
   *  caller-side gates (RMS, duration, text length) should already reject
   *  most of these. */
  unknownThreshold: number;
  /** Cosine-similarity threshold above which an embedding attaches to an
   *  existing centroid (running-mean update). Below this but above the
   *  unknown floor, a new cluster is created. Default 0.55 — tuned for
   *  L2-normalized WeSpeaker ResNet34 256-d outputs. */
  assignThreshold: number;
  /** Hard cap on number of clusters per session. POC target is 10–20
   *  speakers; default 20. Overflow embeddings get `[Speaker ?]`. */
  maxSpeakers: number;
  /** AHC cutoff (1 - cosine_similarity → distance). Lower = more
   *  aggressive merging. Default 0.48 — empirically separates ~20
   *  WeSpeaker speakers without over-merging similar voices. */
  refineCutoff: number;
}

export const DEFAULT_CLUSTERER_CONFIG: ClustererConfig = {
  unknownThreshold: 0.4,
  assignThreshold: 0.55,
  maxSpeakers: 20,
  refineCutoff: 0.48,
};

export interface AssignResult {
  label: string;
  confidence: number;
  isNew: boolean;
}

export interface SegmentEmbeddingRow {
  segmentId: string;
  /** Existing label on the row (so the refine diff can avoid emitting
   *  no-op updates). NULL means the segment was persisted before
   *  diarization or skipped by a guardrail. */
  oldLabel: string | null;
  startMs: number;
  /** L2-normalized 256-d float32 speaker embedding. */
  embedding: Float32Array;
}

export interface RefineDiffEntry {
  segmentId: string;
  oldLabel: string | null;
  newLabel: string;
}

interface Centroid {
  label: string;
  /** Running-mean vector, kept L2-normalized so cosine sim = dot product. */
  vec: Float32Array;
  /** Number of embeddings absorbed — used as the running-mean weight. */
  count: number;
}

/**
 * Online clustering state for a single meeting session.
 *
 * Online mode: callers feed embeddings via `assign()` as Whisper segments
 * land. Centroids accumulate; labels are stable once assigned.
 *
 * Offline mode: callers ignore the online state and call `refine(rows)`
 * with the full set of persisted embeddings from the DB at stop-of-meeting.
 * `refine` is a pure function over its argument and does NOT read the
 * online state — that keeps refinement robust against drift (crashes,
 * mid-session restarts, missed pushes).
 */
export class SpeakerClusterer {
  private centroids: Centroid[] = [];
  private nextSpeakerNumber = 1;

  constructor(public readonly config: ClustererConfig = DEFAULT_CLUSTERER_CONFIG) {}

  /** Number of clusters currently held in online state. Test/debug helper. */
  get clusterCount(): number {
    return this.centroids.length;
  }

  /**
   * Assign an embedding to a cluster, possibly creating a new one.
   *
   * The "empty state" branch is deliberate: with no centroids, every
   * sim comparison would return -Infinity and the floor rule would
   * permanently send the first speaker to `[Speaker ?]`. Callers are
   * responsible for gating slices that are too weak/short/silent BEFORE
   * calling assign (see M2.3 guardrails: min/max duration, RMS, text
   * length, no_speech_prob).
   */
  assign(embedding: Float32Array): AssignResult {
    if (this.centroids.length === 0) {
      const label = this.allocSpeakerLabel();
      this.centroids.push({ label, vec: cloneAndNormalize(embedding), count: 1 });
      return { label, confidence: 1.0, isNew: true };
    }

    let bestSim = -Infinity;
    let bestIdx = -1;
    for (let i = 0; i < this.centroids.length; i++) {
      const sim = dot(this.centroids[i].vec, embedding);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }

    if (bestSim < this.config.unknownThreshold) {
      // Weak evidence — never mutate centroids from this. AHC at stop may
      // still absorb this segment into the nearest cluster if it turns
      // out to be cohesive in the full-session view.
      return { label: UNKNOWN_LABEL, confidence: bestSim, isNew: false };
    }

    if (bestSim >= this.config.assignThreshold) {
      // Attach: update running mean, return existing label.
      const c = this.centroids[bestIdx];
      this.updateCentroid(c, embedding);
      return { label: c.label, confidence: bestSim, isNew: false };
    }

    // Between floor and attach: confident enough to be its own speaker
    // (not noise) but not similar enough to merge. Allocate a new cluster
    // unless we're at the cap, in which case fall back to `[Speaker ?]`.
    if (this.centroids.length >= this.config.maxSpeakers) {
      return { label: UNKNOWN_LABEL, confidence: bestSim, isNew: false };
    }
    const label = this.allocSpeakerLabel();
    this.centroids.push({ label, vec: cloneAndNormalize(embedding), count: 1 });
    return { label, confidence: bestSim, isNew: true };
  }

  /**
   * Agglomerative hierarchical clustering (average linkage, 1 − cosine
   * distance) over an arbitrary set of `SegmentEmbeddingRow`s. Pure over
   * its input — does NOT read online clusterer state.
   *
   * Post-AHC labels are assigned in **first-occurrence order**: the
   * cluster whose earliest row has the smallest `startMs` becomes
   * `[Speaker 1]`, next `[Speaker 2]`, etc. This keeps UI colors
   * deterministic and intuitive ("Speaker 1 = whoever spoke first").
   *
   * Rows whose existing `oldLabel` already matches the new label are
   * still included in the diff with `newLabel === oldLabel` — callers
   * can filter no-ops at the persistence layer if they prefer.
   *
   * Returns an empty array when given an empty input.
   */
  refine(rows: SegmentEmbeddingRow[]): RefineDiffEntry[] {
    if (rows.length === 0) return [];

    // Deterministic order matters: AHC is order-independent, but
    // first-occurrence label assignment requires sorted rows.
    const sorted = [...rows].sort((a, b) => a.startMs - b.startMs);
    const n = sorted.length;

    // Each row starts in its own cluster. clusters[i] = list of row indices
    // in this cluster. Same-row distance to itself is 0; we never compare it.
    const clusters: number[][] = sorted.map((_, i) => [i]);

    // Precompute pairwise cosine distances. n is bounded by total meeting
    // segments (typically a few hundred), so O(n²) is fine.
    const dist: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = 1 - dot(sorted[i].embedding, sorted[j].embedding);
        dist[i][j] = d;
        dist[j][i] = d;
      }
    }

    // Cluster-level distances. Keyed by sorted (a, b) indices into `clusters`.
    // Recomputed lazily when clusters merge.
    const clusterDistance = (a: number[], b: number[]): number => {
      // Average linkage: mean of all cross-pair distances.
      let sum = 0;
      let pairs = 0;
      for (const i of a) {
        for (const j of b) {
          sum += dist[i][j];
          pairs++;
        }
      }
      return pairs === 0 ? Infinity : sum / pairs;
    };

    // Iteratively merge the closest pair until the next merge would exceed
    // refineCutoff or only one cluster remains. With small n the brute-force
    // O(n³) loop is fine; switch to nearest-neighbor caching if profiling
    // says otherwise.
    while (clusters.length > 1) {
      let bestI = -1;
      let bestJ = -1;
      let bestD = Infinity;
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const d = clusterDistance(clusters[i], clusters[j]);
          if (d < bestD) {
            bestD = d;
            bestI = i;
            bestJ = j;
          }
        }
      }
      if (bestD > this.config.refineCutoff || bestI < 0) break;
      // Merge bestJ into bestI; remove bestJ.
      clusters[bestI] = clusters[bestI].concat(clusters[bestJ]);
      clusters.splice(bestJ, 1);
    }

    // Assign new labels by first-occurrence. clusters are already in
    // arbitrary order; sort by min(startMs) of their members. Earliest row
    // is at sorted[cluster[0]] iff we re-sort each cluster's index list
    // by startMs first — which the input sort already implies, but be
    // explicit.
    const clustersByFirstOccurrence = clusters
      .map((c) => ({
        members: [...c].sort((a, b) => sorted[a].startMs - sorted[b].startMs),
        earliest: c.reduce((min, idx) => Math.min(min, sorted[idx].startMs), Infinity),
      }))
      .sort((a, b) => a.earliest - b.earliest);

    // Hard cap on labels: if AHC somehow produced > maxSpeakers clusters,
    // tail clusters get `[Speaker ?]`. (In practice the cutoff prevents
    // this, but assign() applies the same cap so refine should match.)
    const out: RefineDiffEntry[] = new Array(n);
    clustersByFirstOccurrence.forEach((cluster, clusterIdx) => {
      const newLabel =
        clusterIdx < this.config.maxSpeakers
          ? `[Speaker ${clusterIdx + 1}]`
          : UNKNOWN_LABEL;
      for (const memberIdx of cluster.members) {
        const row = sorted[memberIdx];
        out[memberIdx] = {
          segmentId: row.segmentId,
          oldLabel: row.oldLabel,
          newLabel,
        };
      }
    });

    return out;
  }

  private allocSpeakerLabel(): string {
    const label = `[Speaker ${this.nextSpeakerNumber}]`;
    this.nextSpeakerNumber++;
    return label;
  }

  private updateCentroid(c: Centroid, embedding: Float32Array): void {
    const newCount = c.count + 1;
    for (let i = 0; i < c.vec.length; i++) {
      c.vec[i] = (c.vec[i] * c.count + embedding[i]) / newCount;
    }
    // Re-normalize so subsequent dot products remain cosine sim.
    normalizeInPlace(c.vec);
    c.count = newCount;
  }
}

// ── Vector helpers ──────────────────────────────────────────────────────────

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function cloneAndNormalize(v: Float32Array): Float32Array {
  const out = new Float32Array(v);
  normalizeInPlace(out);
  return out;
}

function normalizeInPlace(v: Float32Array): void {
  let sq = 0;
  for (let i = 0; i < v.length; i++) sq += v[i] * v[i];
  const norm = Math.sqrt(sq);
  if (norm > 1e-9) {
    const inv = 1 / norm;
    for (let i = 0; i < v.length; i++) v[i] *= inv;
  }
}
