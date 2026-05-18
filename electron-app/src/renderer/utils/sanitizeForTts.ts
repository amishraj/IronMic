/**
 * Sanitize arbitrary user text for the Kokoro TTS phonemizer.
 *
 * Two behaviors that matter for prosody:
 *   1. We strip markdown / list / heading clutter so the engine sees clean
 *      sentences. Without this, a markdown bullet line ("- foo") phonemizes
 *      to nothing and trips Rust's "Text produced no tokens" error.
 *   2. espeak's --ipa mode strips raw punctuation from the phoneme stream,
 *      which means the TTS engine cannot insert pauses on its own. Pauses
 *      come from the engine splitting input on sentence-terminal punctuation
 *      and inserting silence between chunks. So we MUST upgrade ambiguous
 *      separators (inline " - ", em-dashes, blank lines between bullets)
 *      into real sentence breaks here, or those passages read as one
 *      unbroken stream.
 */

/** Absolute upper bound on characters sent to the engine. The Rust side
 *  splits long text into model-safe chunks (see split_for_synthesis in
 *  rust-core/src/tts/kokoro.rs), so this is just a sanity guard against
 *  pathologically large pastes. A 50 KB note is roughly 8000 spoken words /
 *  1 hour of audio at typical rates — well above any reasonable read-aloud
 *  session. */
export const TTS_MAX_INPUT_CHARS = 50_000;

export interface SanitizedTts {
  /** Cleaned text, ready to send to synthesizeText. Empty string means
   *  "nothing readable in the input". */
  text: string;
  /** True when the cleaned text was truncated to fit the absolute char cap. */
  truncated: boolean;
  /** Best-effort reason when text is empty — surfaced to the user as a toast. */
  emptyReason?: 'no-input' | 'symbols-only';
}

/** Strip a single line of common Markdown / list / heading clutter. Returns
 *  the cleaned line (may be empty). Only touches the start of line and inline
 *  formatting marks; does not touch ordinary punctuation, which the phonemizer
 *  uses for prosody. */
function stripLine(raw: string): string {
  let line = raw;

  // Leading list markers — bullets, dashes, numbered, em/en dashes.
  line = line.replace(/^\s*([-*•·–—+]|\d+[.)])\s+/, '');
  // Markdown headers (#, ##, ### ...).
  line = line.replace(/^\s*#{1,6}\s+/, '');
  // Blockquote markers.
  line = line.replace(/^\s*>+\s*/, '');
  // Task-list checkboxes: `- [ ]` already had its dash stripped above; clean up
  // the brackets.
  line = line.replace(/^\s*\[[ xX]\]\s+/, '');

  // Inline emphasis. Use non-greedy and anchored variants so we don't eat
  // legitimate `*` or `_` adjacent to words.
  line = line.replace(/\*\*([^*]+)\*\*/g, '$1');     // **bold**
  line = line.replace(/__([^_]+)__/g, '$1');         // __bold__
  line = line.replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, '$1');  // *italic*
  line = line.replace(/(?<![_\w])_([^_\n]+)_(?!\w)/g, '$1');    // _italic_
  line = line.replace(/~~([^~]+)~~/g, '$1');         // ~~strike~~
  line = line.replace(/`([^`]+)`/g, '$1');           // `code`

  // Markdown links / images: keep the visible text only.
  line = line.replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Bare angle-bracketed URLs (<https://...>) — drop the brackets, keep the URL
  // for any letters the phonemizer can sound out, but it will mostly be silent.
  line = line.replace(/<([^>]+)>/g, '$1');

  // A line that is ONLY a horizontal rule (---, ***, ___, etc.) becomes empty.
  if (/^\s*([-*_])\1{2,}\s*$/.test(line)) return '';

  return line.trim();
}

/** Drop a line that contains no characters the phonemizer can render. */
function hasReadableContent(line: string): boolean {
  return /[A-Za-z0-9]/.test(line);
}

/** Truncate `text` at the latest sentence boundary at-or-before `limit`.
 *  Falls back to the latest whitespace, then to a hard cut. */
function truncateAtBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const sentenceEnd = Math.max(
    head.lastIndexOf('. '),
    head.lastIndexOf('! '),
    head.lastIndexOf('? '),
    head.lastIndexOf('.\n'),
  );
  if (sentenceEnd > limit * 0.6) return head.slice(0, sentenceEnd + 1).trim();
  const wsEnd = head.lastIndexOf(' ');
  if (wsEnd > limit * 0.6) return head.slice(0, wsEnd).trim();
  return head.trim();
}

/**
 * Sanitize text for TTS. See module doc for rules. Always safe to call; never
 * throws. Returns `{ text: '' }` when the input has nothing to say.
 */
export function sanitizeForTts(input: string | null | undefined, maxChars: number = TTS_MAX_INPUT_CHARS): SanitizedTts {
  if (!input || !input.trim()) return { text: '', truncated: false, emptyReason: 'no-input' };

  // Normalize Unicode oddities + dash-as-separator patterns BEFORE
  // line-splitting so an inline " - Concern about ..." that the user pasted
  // mid-paragraph becomes its own sentence ". Concern about ...". Order
  // matters: spaced-dash rules first, then bare-dash to comma-pause.
  const normalized = input
    .replace(/ /g, ' ')
    .replace(/[​-‏‪-‮﻿]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    // Inline " - " / " – " / " — " between words → sentence break.
    .replace(/\s+[–—]\s+/g, '. ')
    .replace(/\s+-\s+/g, '. ')
    // Lone em/en dash adjacent to text → comma pause.
    .replace(/[–—]/g, ', ');

  const cleanedLines: string[] = [];
  for (const raw of normalized.split('\n')) {
    const line = stripLine(raw);
    if (!line) continue;
    if (!hasReadableContent(line)) continue;
    cleanedLines.push(line);
  }

  if (cleanedLines.length === 0) {
    return { text: '', truncated: false, emptyReason: 'symbols-only' };
  }

  // Join non-empty lines with `. ` so each line becomes its own sentence.
  // The Rust splitter then breaks on `.` and inserts a 200 ms silence between
  // chunks for natural prosody. If a line already ends with sentence-ending
  // punctuation, don't double-punctuate.
  const joined = cleanedLines
    .map((l, i) => {
      if (i === cleanedLines.length - 1) return l;
      return /[.!?:;,]$/.test(l) ? l : l + '.';
    })
    .join(' ');

  const truncated = joined.length > maxChars;
  const text = truncated ? truncateAtBoundary(joined, maxChars) : joined;
  return { text, truncated };
}
