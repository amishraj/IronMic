/**
 * transcribe-clean — shared audio + text hygiene helpers for the Whisper
 * transcription path (dictation streamer AND meeting recorder).
 *
 * Two problems to solve before Whisper's output is "usable":
 *
 * 1. Silent / low-energy chunks. When the user isn't speaking, Whisper is
 *    FAMOUSLY prone to hallucinating filler text — "Thank you.", "Thanks
 *    for watching.", "[BLANK_AUDIO]", repeated "you you you", etc. These
 *    pollute the transcript and, downstream, the AI notes summary.
 *    Solution: compute RMS energy on the raw audio buffer BEFORE calling
 *    Whisper. If it's below the noise floor, skip transcription entirely.
 *
 * 2. Near-silent but non-empty chunks still pass the RMS gate but produce
 *    hallucinations. For those, we filter/sanitize the TEXT output via a
 *    layered cleaner: exact hallucination matches, bracket-marker
 *    stripping, and repetition collapsing (Whisper loops on "yeah yeah
 *    yeah yeah..." when it gets stuck).
 *
 * Both layers are CHEAP (no model, no IPC) so they can run on every chunk
 * without impacting latency.
 */

/**
 * RMS threshold below which we treat a chunk as silence and skip Whisper.
 *
 * Interpretation: RMS is computed on normalized [-1.0, +1.0] samples, so
 * 0.005 ≈ -46 dBFS. Typical room noise in a quiet office is -50 to -40 dBFS;
 * soft speech is around -30 to -20 dBFS. 0.005 is conservative — it passes
 * anything a human would call "audible speech" while rejecting pure room
 * tone and HVAC hum. Tuned manually; if users report missed quiet speech,
 * bump down to 0.003.
 */
const RMS_SILENCE_THRESHOLD = 0.005;

/**
 * Compute RMS energy of a PCM16 audio buffer. Buffer format assumption:
 * little-endian signed 16-bit integer samples (what cpal+whisper-rs produce
 * via the existing `stopRecording()` N-API export).
 *
 * Returns a value in [0, 1]. We don't need super-precise dB — just a
 * relative measure to compare against a threshold.
 */
export function computeRmsPcm16(buf: Buffer): number {
  if (!buf || buf.length < 2) return 0;
  // Process a stride so very long buffers don't take too long. 15s @ 16kHz
  // is 480KB (240k samples); stride of 4 means we sample 60k values, still
  // statistically representative of loudness, takes <5ms.
  const stride = buf.length > 200_000 ? 4 : 1;
  let sumSquares = 0;
  let count = 0;
  for (let i = 0; i + 1 < buf.length; i += 2 * stride) {
    // Little-endian Int16 → signed value in [-32768, 32767]
    const s = buf.readInt16LE(i);
    const norm = s / 32768;
    sumSquares += norm * norm;
    count++;
  }
  if (count === 0) return 0;
  return Math.sqrt(sumSquares / count);
}

/** Returns true if the audio buffer is below the silence floor. */
export function isAudioSilent(buf: Buffer): boolean {
  if (!buf || buf.length < 500) return true;
  return computeRmsPcm16(buf) < RMS_SILENCE_THRESHOLD;
}

// ── Text sanitization ─────────────────────────────────────────────────────

/**
 * Whisper silence hallucinations — case-insensitive exact matches after
 * normalization. Expanded from the original dictation-streamer list to
 * cover patterns seen in meeting recordings where background noise or a
 * pause gets mistranscribed as filler.
 *
 * IMPORTANT: these must be EXACT matches on the full trimmed output, not
 * substring matches. "Thanks for watching." as a whole chunk → drop. But
 * "I said thanks for watching the demo" → keep — real content.
 */
const EXACT_HALLUCINATIONS = new Set<string>([
  'thanks for watching.',
  'thanks for watching',
  'thank you for watching.',
  'thank you for watching',
  'thanks for listening.',
  'thanks for listening',
  'thank you.',
  'thank you',
  'thanks.',
  'thanks',
  'you',
  '.',
  '..',
  '...',
  'bye.',
  'bye!',
  'bye',
  'ok.',
  'okay.',
  'ok',
  'okay',
  'mm-hmm.',
  'mm hmm.',
  'uh-huh.',
  'um.',
  'uh.',
  'hmm.',
  'hmm',
  'so.',
  'so',
  'yeah.',
  'yeah',
  'right.',
  'right',
  // Whisper's synthetic markers — usually on silent clips
  '[blank_audio]',
  '[silence]',
  '[music]',
  '[applause]',
  '[laughter]',
  '[background noise]',
  '[no audio]',
  '[inaudible]',
  // Common mistranscriptions of ambient noise as narration
  'the end.',
  'the end',
  'you know.',
  'you know',
]);

/**
 * Strip bracketed markers like `[MUSIC]`, `[BLANK_AUDIO]`, `(music playing)`
 * from the middle of otherwise-real text. Whisper sprinkles these into
 * real transcripts when it hears incidental noise, and they look ugly in
 * the final notes. We also handle the parenthetical variant some models emit.
 */
function stripBracketedMarkers(s: string): string {
  return s
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\(\s*(music|applause|laughter|silence|inaudible|noise|no audio|background noise)[^\)]*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detect and collapse Whisper's repetition loop — the model sometimes gets
 * stuck outputting the same phrase N times ("thank you thank you thank you
 * thank you..."). Heuristic: if > 60% of the output is the same short phrase
 * repeated, trim to one occurrence (or drop entirely if it was already on
 * the hallucination list).
 *
 * We only look for repetitions of 1-3 word phrases because that's where
 * Whisper actually loops; longer exact repetitions are rare and sometimes
 * legitimate (a speaker emphasizing).
 */
function collapseRepetitions(s: string): string {
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 6) return s;
  for (let phraseLen = 1; phraseLen <= 3; phraseLen++) {
    if (words.length < phraseLen * 3) continue;
    const head = words.slice(0, phraseLen).join(' ').toLowerCase();
    let matches = 1;
    for (let i = phraseLen; i + phraseLen <= words.length; i += phraseLen) {
      const slice = words.slice(i, i + phraseLen).join(' ').toLowerCase();
      if (slice === head) matches++;
      else break;
    }
    if (matches >= 3 && matches * phraseLen >= words.length * 0.6) {
      // Loop detected — return one clean occurrence.
      return words.slice(0, phraseLen).join(' ');
    }
  }
  return s;
}

/**
 * Sanitize a raw Whisper output string. Returns '' if the text is a known
 * hallucination / garbage; otherwise returns the cleaned text.
 *
 * Order of operations matters: bracket-strip FIRST so "[MUSIC] hello" →
 * "hello" survives, THEN collapse repetitions, THEN check hallucination
 * set (by which point we've normalized away the noise markers).
 */
export function sanitizeTranscribedText(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';

  // Strip bracketed markers in the middle of text.
  let cleaned = stripBracketedMarkers(trimmed);
  if (!cleaned) return '';

  // Collapse Whisper repetition loops.
  cleaned = collapseRepetitions(cleaned);
  if (!cleaned) return '';

  // Exact-match hallucination filter.
  const key = cleaned.toLowerCase();
  if (EXACT_HALLUCINATIONS.has(key)) return '';

  // Very short output (< 2 word characters) on any non-trivial chunk is
  // almost certainly a mistranscription of noise. Drop.
  if (cleaned.replace(/[^a-z0-9]/gi, '').length < 2) return '';

  return cleaned;
}

/**
 * Race a promise against a timeout. Used to guard `native.addon.transcribe()`
 * so a hung Whisper call can't stall the whole chunk loop. The native call
 * may still be running in C++ — we can't cancel it from JS — but at least
 * the JS side is unblocked.
 *
 * On timeout, resolves with null (caller treats as "skip this chunk").
 */
export function transcribeWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label = 'transcribe',
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.warn(`[${label}] Timed out after ${timeoutMs}ms — dropping chunk`);
      resolve(null);
    }, timeoutMs);
    promise.then(
      (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        console.error(`[${label}] Failed:`, err);
        resolve(null);
      },
    );
  });
}
