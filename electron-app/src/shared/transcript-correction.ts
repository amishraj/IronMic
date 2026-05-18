/**
 * Pure-JS transcript correction helper. Imported from both the main
 * (meeting-recorder, dictation-streamer) and renderer (useRecordingStore)
 * processes — no Electron, fs, or Node-only imports.
 *
 * Scope: single-word terms. Multi-word names are split on whitespace by the
 * caller; tokens of length ≤ 3 (e.g. "Ann") are intentionally never
 * triggered to avoid false rewrites.
 *
 * Algorithm (intentionally conservative — guardrails > recall):
 *   1. Stop-set of common English words is never replaced.
 *   2. Token candidates must share first-letter equivalence with a term
 *      (same letter, or the same hard-consonant class: c↔k↔q, s↔z, f↔ph,
 *      i↔y). This makes "coobernetes"→"Kubernetes" reachable.
 *   3. Damerau–Levenshtein distance must be ≤ a length-tiered cap.
 *   4. Distance must be strictly less than the next-best term.
 *   5. Candidate length must be within ±max(2, ⌊len/4⌋).
 *   6. Original casing pattern (UPPER, Title, lower) is preserved.
 */

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was',
  'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'man', 'new',
  'now', 'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'its', 'let', 'put',
  'say', 'she', 'too', 'use', 'are', 'with', 'have', 'this', 'that', 'from',
  'they', 'will', 'would', 'there', 'their', 'what', 'about', 'which', 'when',
  'make', 'like', 'time', 'just', 'know', 'take', 'into', 'year', 'your',
  'good', 'some', 'them', 'than', 'then', 'look', 'only', 'come', 'over',
  'think', 'also', 'back', 'after', 'work', 'first', 'well', 'even', 'want',
  'give', 'most', 'find', 'tell', 'because', 'should', 'where', 'much',
  'still', 'these', 'those', 'while', 'being', 'before', 'going', 'every',
  'really', 'right', 'need', 'thing', 'made', 'said', 'does', 'done', 'each',
  'such', 'very', 'here', 'than', 'them', 'into', 'down', 'were', 'been',
  'more', 'many', 'said', 'long', 'last', 'must', 'against', 'between',
  'never', 'always', 'another', 'something', 'nothing', 'anyone', 'someone',
  'around', 'through', 'during', 'without', 'maybe', 'sure', 'okay', 'yeah',
]);

/**
 * First-letter equivalence classes — small set of common phonetic substitutes
 * Whisper/Moonshine produce. Both letters must be lowercase.
 */
const FIRST_LETTER_CLASSES: ReadonlyArray<ReadonlyArray<string>> = [
  ['c', 'k', 'q'],
  ['s', 'z'],
  ['i', 'y'],
];

function firstLetterEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  for (const cls of FIRST_LETTER_CLASSES) {
    if (cls.includes(a) && cls.includes(b)) return true;
  }
  // f ↔ ph: handle as 1-char vs 2-char prefix.
  if ((a === 'f' && b === 'p') || (a === 'p' && b === 'f')) return true;
  return false;
}

/** Damerau-Levenshtein distance, OSA variant (sufficient for our use). */
function damerauLevenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const prevPrev: number[] = new Array(n + 1).fill(0);
  const prev: number[] = new Array(n + 1).fill(0);
  const curr: number[] = new Array(n + 1).fill(0);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
      if (
        i > 1 && j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        curr[j] = Math.min(curr[j], prevPrev[j - 2] + cost);
      }
    }
    for (let j = 0; j <= n; j++) {
      prevPrev[j] = prev[j];
      prev[j] = curr[j];
    }
  }
  return prev[n];
}

function maxDistanceFor(len: number): number {
  if (len <= 3) return -1; // never trigger
  if (len <= 6) return 1;
  if (len <= 10) return 2;
  return 3;
}

function lengthBoundFor(len: number): number {
  return Math.max(2, Math.floor(len / 4));
}

type CasePattern = 'upper' | 'title' | 'lower' | 'mixed';

function detectCase(token: string): CasePattern {
  if (!token) return 'lower';
  if (token === token.toUpperCase() && /[A-Z]/.test(token)) return 'upper';
  if (
    token.length > 1 &&
    token[0] === token[0].toUpperCase() &&
    token.slice(1) === token.slice(1).toLowerCase()
  ) return 'title';
  if (token === token.toLowerCase()) return 'lower';
  return 'mixed';
}

function applyCase(target: string, pattern: CasePattern): string {
  switch (pattern) {
    case 'upper': return target.toUpperCase();
    case 'title':
      return target.length === 0
        ? target
        : target[0].toUpperCase() + target.slice(1).toLowerCase();
    case 'lower':
      // If the dictionary term itself contains uppercase letters (e.g. a
      // proper noun like "Kubernetes"), preserve that casing rather than
      // lowercasing the substitution. The user's lowercase input usually
      // reflects sloppy dictation, not an intentional override.
      if (/[A-Z]/.test(target)) return target;
      return target.toLowerCase();
    case 'mixed':
    default:
      return target;
  }
}

/**
 * Expand a term list: any term containing whitespace is split into single
 * tokens (e.g. "Mary Ann Smith" → ["Mary", "Ann", "Smith"]). Empty entries
 * and stop words are dropped. Result is deduped case-insensitively.
 */
function expandTerms(terms: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    if (!raw) continue;
    for (const part of raw.split(/\s+/)) {
      const t = part.trim();
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      if (STOP_WORDS.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

/**
 * Run fuzzy correction over `text` using `terms` as the replacement
 * vocabulary. Empty terms array short-circuits and returns the original.
 *
 * This pass is safe to run on the same text multiple times — exact matches
 * are passed through (distance 0 returns the term itself, casing preserved).
 */
export function correctTranscript(
  text: string,
  terms: ReadonlyArray<string>,
): string {
  if (!text || terms.length === 0) return text;

  const expanded = expandTerms(terms);
  if (expanded.length === 0) return text;

  // Pre-bucket terms by lowercase first letter for fast candidate filtering.
  const termsLower = expanded.map(t => ({ orig: t, lower: t.toLowerCase() }));

  // Walk tokens, replacing where appropriate. Use a single regex that
  // captures word characters plus a Unicode-letter fallback; non-word
  // sequences (whitespace, punctuation) pass through untouched.
  return text.replace(/[A-Za-z]+/g, (token) => {
    const lower = token.toLowerCase();
    if (STOP_WORDS.has(lower)) return token;
    const len = token.length;
    const maxDist = maxDistanceFor(len);
    if (maxDist < 0) return token;
    const lenBound = lengthBoundFor(len);
    const firstChar = lower[0];

    let bestDist = Infinity;
    let bestTerm: string | null = null;
    let secondBestDist = Infinity;

    for (const { orig, lower: termLower } of termsLower) {
      // Length filter first (cheap).
      if (Math.abs(termLower.length - len) > lenBound) continue;
      if (!firstLetterEquivalent(firstChar, termLower[0])) continue;

      const d = damerauLevenshtein(lower, termLower);
      if (d < bestDist) {
        secondBestDist = bestDist;
        bestDist = d;
        bestTerm = orig;
      } else if (d < secondBestDist) {
        secondBestDist = d;
      }
    }

    if (bestTerm === null) return token;
    if (bestDist > maxDist) return token;
    // Strict-better-than tie rule prevents ambiguous swaps.
    if (bestDist >= secondBestDist) return token;

    const pattern = detectCase(token);
    return applyCase(bestTerm, pattern);
  });
}

// Exposed only for tests; not part of the public API surface.
export const __test__ = {
  damerauLevenshtein,
  expandTerms,
  detectCase,
  applyCase,
  firstLetterEquivalent,
};
