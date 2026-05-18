/**
 * Search normalization for the in-app search surfaces (QuickSearch popover
 * and the full SearchPage).
 *
 * Users typing into a search box don't use punctuation, hyphens, smart
 * quotes, or formatting — but the underlying content does. So "high leverage"
 * should match "High-Leverage", "auth flow" should match "auth_flow" or
 * "auth.flow", and "yourapp" should match "YourApp". We solve this by
 * normalizing both the query and the haystack the same way before comparing.
 *
 * Normalization steps:
 *   1. Lowercase.
 *   2. Unicode-normalize (NFKD) and strip diacritics ("café" → "cafe").
 *   3. Replace anything that isn't a letter or digit with a single space.
 *      This collapses hyphens, slashes, underscores, dots, em-dashes, smart
 *      quotes, etc.
 *   4. Collapse runs of whitespace and trim.
 *
 * Then `matches()` returns true if every token from the normalized query
 * appears as a substring of the normalized haystack. We deliberately use
 * AND-over-tokens (not strict adjacency) so a query like "auth migration"
 * still finds a doc that says "we migrated auth last sprint" — that's the
 * forgiving behavior a casual searcher expects.
 *
 * If the user types the query with punctuation themselves ("auth-flow"),
 * normalization collapses it the same way, so they still get the expected
 * hits — no penalty for typing the way the content reads.
 */

// Range U+0300–U+036F is the Combining Diacritical Marks block. After NFKD
// decomposition, accents on Latin letters become independent combining marks
// in this range, so stripping them leaves the bare letter behind. Built once
// up here so the regex is shared across all calls to normalizeForSearch.
const COMBINING_MARKS = /[̀-ͯ]/g;
const NON_ALPHANUM = /[^\p{L}\p{N}]+/gu;
const WHITESPACE_RUN = /\s+/g;

export function normalizeForSearch(input: string | null | undefined): string {
  if (!input) return '';
  let s = input.toLowerCase();
  try {
    s = s.normalize('NFKD').replace(COMBINING_MARKS, '');
  } catch {
    // NFKD unsupported on very old runtimes; fall through with lowercased.
  }
  s = s.replace(NON_ALPHANUM, ' ');
  return s.replace(WHITESPACE_RUN, ' ').trim();
}

/** Tokenize a normalized query string into non-empty tokens. */
export function tokenizeQuery(query: string): string[] {
  const n = normalizeForSearch(query);
  if (!n) return [];
  return n.split(' ').filter((t) => t.length > 0);
}

/**
 * Returns true if every token in the (normalized) query appears as a
 * substring of the (already-normalized) haystack. Empty query matches
 * everything; empty haystack matches nothing (unless query is also empty).
 *
 * Callers should pre-normalize the haystack ONCE per item per render and
 * reuse it across multiple match checks for that item — normalization is
 * the expensive part.
 */
export function matchesNormalized(normalizedHaystack: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  if (!normalizedHaystack) return false;
  for (const t of tokens) {
    if (!normalizedHaystack.includes(t)) return false;
  }
  return true;
}

/** Convenience: normalize haystack inline. Use the two-step form when you
 *  match the same query against many haystacks (pre-tokenize the query once). */
export function matches(query: string, haystack: string): boolean {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return true;
  return matchesNormalized(normalizeForSearch(haystack), tokens);
}
