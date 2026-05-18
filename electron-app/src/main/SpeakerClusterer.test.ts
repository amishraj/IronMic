import { describe, it, expect } from 'vitest';
import {
  SpeakerClusterer,
  DEFAULT_CLUSTERER_CONFIG,
  type SegmentEmbeddingRow,
} from './SpeakerClusterer';

// ── Synthetic embedding generator ───────────────────────────────────────────
//
// To validate clustering logic without loading the actual WeSpeaker model
// (which doesn't ship until M2), we use a small deterministic LCG to draw
// 256-d "embeddings" from Gaussian-blob clusters scattered on the unit
// sphere. Same-cluster cosine similarity ends up well above 0.55 and
// cross-cluster well below — i.e., we synthesize the property the real
// model has, then verify the clusterer recovers it.

function lcg(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function gauss(rng: () => number, mean = 0, std = 1): number {
  // Box–Muller. Two uniforms in, one normal out.
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * std;
}

function l2Normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

function makeClusterCenters(k: number, dim: number, seed: number): Float32Array[] {
  const rng = lcg(seed);
  const out: Float32Array[] = [];
  // Pick widely-separated unit-sphere directions by rejection-sampling
  // against the running set: each new center must have cosine sim
  // ≤ 0.20 with every prior, so blobs don't bleed into each other.
  while (out.length < k) {
    const cand = new Float32Array(dim);
    for (let i = 0; i < dim; i++) cand[i] = gauss(rng);
    l2Normalize(cand);
    let ok = true;
    for (const prior of out) {
      let dot = 0;
      for (let i = 0; i < dim; i++) dot += prior[i] * cand[i];
      if (dot > 0.2) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(cand);
  }
  return out;
}

function sampleFromCluster(
  center: Float32Array,
  rng: () => number,
  spread = 0.02,
): Float32Array {
  // Per-dim Gaussian noise scales as sqrt(dim) once summed; for 256-d
  // embeddings, spread=0.02 → total noise magnitude ≈ 0.32 while the
  // center has unit norm. After L2-normalize that lands intra-cluster
  // cosine sim around 0.95, well separated from the < 0.2 inter-cluster
  // ceiling enforced by makeClusterCenters.
  const dim = center.length;
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = center[i] + gauss(rng, 0, spread);
  l2Normalize(v);
  return v;
}

// ── V-measure ───────────────────────────────────────────────────────────────
// Standard clustering quality metric: harmonic mean of homogeneity
// (each cluster contains only members of one class) and completeness
// (all members of a class end up in the same cluster).

function vMeasure(trueLabels: number[], predLabels: string[]): number {
  if (trueLabels.length !== predLabels.length) {
    throw new Error('label arrays must be the same length');
  }
  const n = trueLabels.length;
  if (n === 0) return 1;

  const cMap = new Map<string, number>();
  const predIds = predLabels.map((l) => {
    if (!cMap.has(l)) cMap.set(l, cMap.size);
    return cMap.get(l)!;
  });
  const classCount = Math.max(...trueLabels) + 1;
  const clusterCount = cMap.size;
  const contingency: number[][] = Array.from({ length: classCount }, () =>
    new Array(clusterCount).fill(0),
  );
  for (let i = 0; i < n; i++) contingency[trueLabels[i]][predIds[i]]++;

  const classTotals = new Array(classCount).fill(0);
  const clusterTotals = new Array(clusterCount).fill(0);
  for (let c = 0; c < classCount; c++) {
    for (let k = 0; k < clusterCount; k++) {
      classTotals[c] += contingency[c][k];
      clusterTotals[k] += contingency[c][k];
    }
  }

  const entropy = (counts: number[]): number => {
    let h = 0;
    for (const c of counts) {
      if (c > 0) {
        const p = c / n;
        h -= p * Math.log(p);
      }
    }
    return h;
  };

  const hC = entropy(classTotals);
  const hK = entropy(clusterTotals);

  let hCgivenK = 0;
  for (let k = 0; k < clusterCount; k++) {
    if (clusterTotals[k] === 0) continue;
    for (let c = 0; c < classCount; c++) {
      const v = contingency[c][k];
      if (v > 0) {
        hCgivenK -= (v / n) * Math.log(v / clusterTotals[k]);
      }
    }
  }
  let hKgivenC = 0;
  for (let c = 0; c < classCount; c++) {
    if (classTotals[c] === 0) continue;
    for (let k = 0; k < clusterCount; k++) {
      const v = contingency[c][k];
      if (v > 0) {
        hKgivenC -= (v / n) * Math.log(v / classTotals[c]);
      }
    }
  }

  const homogeneity = hC === 0 ? 1 : 1 - hCgivenK / hC;
  const completeness = hK === 0 ? 1 : 1 - hKgivenC / hK;
  if (homogeneity + completeness === 0) return 0;
  return (2 * homogeneity * completeness) / (homogeneity + completeness);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('SpeakerClusterer.assign', () => {
  it('seeds [Speaker 1] from an empty state without invoking the unknown floor', () => {
    const c = new SpeakerClusterer();
    const v = l2Normalize(new Float32Array(256).fill(0).map((_, i) => (i === 0 ? 1 : 0)));
    const r = c.assign(v);
    expect(r.label).toBe('[Speaker 1]');
    expect(r.isNew).toBe(true);
    expect(c.clusterCount).toBe(1);
  });

  it('routes weak embeddings to [Speaker ?] without mutating centroids', () => {
    const c = new SpeakerClusterer();
    // Seed cluster 1 with a stable embedding.
    const seed = new Float32Array(256);
    seed[0] = 1;
    c.assign(seed);

    // Construct an orthogonal embedding — cosine sim with seed = 0,
    // well below the 0.40 unknownThreshold.
    const weak = new Float32Array(256);
    weak[1] = 1;
    const r = c.assign(weak);
    expect(r.label).toBe('[Speaker ?]');
    expect(r.isNew).toBe(false);
    // Centroid count must stay at 1 — weak evidence does not create
    // a cluster from the floor.
    expect(c.clusterCount).toBe(1);
  });

  it('returns [Speaker ?] on overflow once maxSpeakers is reached', () => {
    const c = new SpeakerClusterer({
      ...DEFAULT_CLUSTERER_CONFIG,
      maxSpeakers: 2,
      // Force "new cluster" branch by ensuring each embedding sits between
      // the floor and the attach threshold relative to every prior.
      assignThreshold: 0.95,
      unknownThreshold: 0.0,
    });
    const a = new Float32Array(256); a[0] = 1;
    const b = new Float32Array(256); b[1] = 1;
    const cc = new Float32Array(256); cc[2] = 1;
    c.assign(a);
    c.assign(b);
    const overflow = c.assign(cc);
    expect(overflow.label).toBe('[Speaker ?]');
    expect(c.clusterCount).toBe(2);
  });
});

describe('SpeakerClusterer.refine — synthetic 10-cluster blob', () => {
  it('reaches V-measure ≥ 0.9 over 10 speakers × 50 samples', () => {
    const K = 10;
    const PER_CLUSTER = 50;
    const DIM = 256;
    const SPREAD = 0.02; // see sampleFromCluster — per-dim std × √dim ≈ 0.32, intra-sim ≈ 0.95

    const centers = makeClusterCenters(K, DIM, /* seed */ 42);
    const rng = lcg(123);
    const rows: SegmentEmbeddingRow[] = [];
    const trueLabels: number[] = [];
    for (let k = 0; k < K; k++) {
      for (let i = 0; i < PER_CLUSTER; i++) {
        rows.push({
          segmentId: `seg-${k}-${i}`,
          oldLabel: null,
          // Interleave start_ms across clusters so first-occurrence
          // ordering is meaningful; ensures the refine path isn't
          // accidentally tested in a trivial "all-of-cluster-0-first" case.
          startMs: i * K + k,
          embedding: sampleFromCluster(centers[k], rng, SPREAD),
        });
      }
    }

    const c = new SpeakerClusterer();
    const diff = c.refine(rows);
    expect(diff).toHaveLength(rows.length);

    // Map diff back to (segmentId → newLabel), then align with trueLabels
    // by sorting rows the same way refine() does (by startMs).
    const byId = new Map(diff.map((d) => [d.segmentId, d.newLabel]));
    const sortedRows = [...rows].sort((a, b) => a.startMs - b.startMs);
    // Recompute trueLabels in the same order.
    const sortedTrue: number[] = sortedRows.map((r) => {
      // segmentId encodes "seg-<cluster>-<i>"; pull cluster index back out.
      const m = /^seg-(\d+)-/.exec(r.segmentId);
      return m ? Number(m[1]) : -1;
    });
    const predLabels = sortedRows.map((r) => byId.get(r.segmentId)!);
    const v = vMeasure(sortedTrue, predLabels);
    expect(v).toBeGreaterThanOrEqual(0.9);
  });
});

describe('SpeakerClusterer.refine — empty + single', () => {
  it('returns [] on empty input', () => {
    const c = new SpeakerClusterer();
    expect(c.refine([])).toEqual([]);
  });

  it('assigns [Speaker 1] to a single row', () => {
    const c = new SpeakerClusterer();
    const v = new Float32Array(256); v[0] = 1;
    l2Normalize(v);
    const diff = c.refine([
      { segmentId: 's1', oldLabel: null, startMs: 0, embedding: v },
    ]);
    expect(diff).toEqual([
      { segmentId: 's1', oldLabel: null, newLabel: '[Speaker 1]' },
    ]);
  });
});
