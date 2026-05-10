/**
 * SummaryGenerator — single source of truth for turning a meeting transcript
 * into a structured summary.
 *
 * Two problems this module solves:
 *
 * 1. **LLM echo on long transcripts.**  When the raw transcript is large, local
 *    models (Mistral-7B-Q4 and similar) frequently regurgitate the input instead
 *    of summarising it.  We avoid this with:
 *      • A map/reduce pass: long transcripts are broken into chunks, each chunk
 *        is compressed into bullet points, then the template prompt runs against
 *        the *condensed* bullets — the model never sees the full raw blob.
 *      • Echo detection on every LLM call: output length ratio, verbatim-span
 *        detection, and instruction-leakage checks.  A failed call is retried
 *        once with a harsher prompt; a second failure falls back to a graceful
 *        "could not be generated" message (NOT the raw transcript).
 *
 * 2. **One implementation, two call sites.**  Both the initial post-meeting
 *    generation (MeetingPage) and the "Regenerate" action (MeetingDetailPage)
 *    call `generateMeetingSummary()` so behaviour is guaranteed identical.
 */

import {
  generateStructuredNotes as runTemplate,
  type MeetingTemplate,
  type StructuredSection,
} from '../tfjs/MeetingTemplateEngine';

// ── Tuning knobs ──────────────────────────────────────────────────────────
/** Transcripts shorter than this feed straight into the final prompt. */
const SINGLE_PASS_CHAR_LIMIT = 4_000;
/** Chunk size for the map step of map/reduce (chars). */
const CHUNK_CHAR_SIZE = 3_500;
/** Guard: transcripts below this word count aren't worth summarising. */
const MIN_WORDS_FOR_SUMMARY = 30;
/** Echo rejection threshold — if output/input length > this, it's an echo. */
// Bumped from 0.8 → 1.6 because a well-structured summary (TL;DR +
// Decisions + Discussion + Action Items + Open Questions table) can
// easily exceed the input length for short or condensed meetings.
// Genuine transcript-echo failures sit at ~1.0x or higher *and* fail
// the long-verbatim-span guard — both checks together still catch them
// reliably without rejecting legitimate structured output.
const MAX_OUTPUT_TO_INPUT_RATIO = 1.6;
/** Longest verbatim span we'll tolerate from the input (words). */
const MAX_VERBATIM_SPAN_WORDS = 20;

export type ProcessingState = 'generating' | 'done' | 'empty';

export interface StructuredOutput {
  sections: StructuredSection[];
  plainSummary?: string;
  title?: string;
  /**
   * Provenance for `title`. `'user'` means the user typed it (live edit,
   * detail-page header, host override). `'ai'` means it was generated from
   * the content. Absent means no title has ever been set — `Meeting #N`
   * fallback is shown. Used by regenerate to decide whether to overwrite
   * or preserve the existing title. Do NOT overload `hasUserEdits` for
   * this — that field tracks body edits and would either clobber user
   * titles on regen or block AI titles after a body-only edit.
   */
  titleSource?: 'user' | 'ai';
  processingState: ProcessingState;
  templateId?: string;
  templateName?: string;
  generatedAt?: string;
  /** True when the user has edited the output since last generation. */
  hasUserEdits?: boolean;
  /** Prior versions saved when user chose "Save to history" on regenerate. */
  versions?: VersionEntry[];
  /** Set by the meeting-room-client when the host's notes are synced in. */
  syncedFromHostSessionId?: string;
  /** TipTap-formatted HTML written by the rich-text meeting editor. When
   *  set, it is the source of truth for body display and regenerate must
   *  null it out so an AI body refresh doesn't keep showing stale formatting. */
  htmlContent?: string | null;
  /** Linked entry id in the Notes "Meeting Notes" notebook. Persisted so
   *  upserts on regenerate / save update in place instead of stacking. */
  notebookEntryId?: string;
}

export interface VersionEntry {
  id: string;
  savedAt: string;
  reason: 'user-edit-before-regenerate' | 'template-switch' | 'manual';
  templateId?: string;
  templateName?: string;
  snapshot: {
    sections: StructuredSection[];
    plainSummary?: string;
    title?: string;
    titleSource?: 'user' | 'ai';
  };
}

/** Graceful fallback message used whenever generation cannot produce real notes. */
export const SUMMARY_UNAVAILABLE_MESSAGE =
  'A meeting summary could not be generated at this time. The raw transcript is preserved below.';

// ──────────────────────────────────────────────────────────────────────────
// Public entry point
// ──────────────────────────────────────────────────────────────────────────

/**
 * Generate a structured summary from a raw transcript.  Always returns a
 * well-formed StructuredOutput — callers can persist the result directly
 * into `meeting_sessions.structured_output`.
 */
export async function generateMeetingSummary(
  transcript: string,
  template: MeetingTemplate | null,
): Promise<StructuredOutput> {
  const generatedAt = new Date().toISOString();
  const trimmed = (transcript ?? '').trim();

  // Guard 1 — nothing to summarise.
  if (wordCount(trimmed) < MIN_WORDS_FOR_SUMMARY) {
    return {
      sections: [],
      plainSummary: '',
      processingState: 'empty',
      templateId: template?.id,
      templateName: template?.name,
      generatedAt,
    };
  }

  // Guard 2 — for long transcripts, condense first so the final prompt sees a
  // compact bullet list instead of a 38-minute wall of speech.
  let inputForFinalPass = trimmed;
  if (trimmed.length > SINGLE_PASS_CHAR_LIMIT) {
    try {
      inputForFinalPass = await condenseTranscript(trimmed);
    } catch (err) {
      console.error('[SummaryGenerator] condense step failed:', err);
      // Fall back to a hard-truncated head-of-transcript so we at least try.
      inputForFinalPass = trimmed.slice(0, SINGLE_PASS_CHAR_LIMIT);
    }
  }

  // Final pass — template or plain summary.
  try {
    if (template) {
      const structured = await runTemplateWithGuardrails(template, inputForFinalPass);
      if (structured) {
        return {
          ...structured,
          templateId: template.id,
          templateName: template.name,
          processingState: 'done',
          generatedAt,
          // Populate plainSummary from the LLM's raw markdown so the
          // notebook auto-file path uses the actual produced text (with
          // correct heading casing like "## TL;DR") instead of falling
          // through to MeetingPage's section-reconstruction fallback,
          // which lowercases section keys whose titles weren't in
          // SECTION_TITLES. The fallback is still there as a safety net
          // — this is the happy-path source of truth.
          plainSummary: (structured as any).rawOutput ?? (structured as any).plainSummary,
        };
      }
    } else {
      const summary = await plainSummarize(inputForFinalPass);
      if (summary) {
        // Plain path doesn't go through MeetingTemplateEngine, so we
        // convert the markdown ourselves here for the htmlContent slot
        // (gated by polish_format_mode — same gate as rich vs plain
        // for templates). MeetingNotesPanel prefers htmlContent over
        // sections when present.
        const htmlContent = await maybeConvertMarkdown(summary);
        return {
          sections: [{ key: 'summary', title: 'Summary', content: summary }],
          plainSummary: summary,
          htmlContent,
          processingState: 'done',
          generatedAt,
        };
      }
    }
  } catch (err) {
    console.error('[SummaryGenerator] final pass failed:', err);
  }

  // Fallback — never echo the transcript.
  return {
    sections: [],
    plainSummary: SUMMARY_UNAVAILABLE_MESSAGE,
    processingState: 'empty',
    templateId: template?.id,
    templateName: template?.name,
    generatedAt,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Map/reduce condensation
// ──────────────────────────────────────────────────────────────────────────

/**
 * Split the transcript into chunks, compress each chunk into bullets, and
 * concatenate.  The output is a much shorter factual digest that the final
 * summarisation pass can safely ingest without echoing.
 */
async function condenseTranscript(transcript: string): Promise<string> {
  const chunks = splitIntoChunks(transcript, CHUNK_CHAR_SIZE);
  const bullets: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const tag = `Part ${i + 1} of ${chunks.length}`;
    const prompt =
      `You are compressing a long meeting transcript into factual bullet points.\n` +
      `Rules — follow them strictly:\n` +
      `- Output 3 to 8 concise bullets (one line each, starting with "- ").\n` +
      `- Capture what was said, decided, or agreed; skip filler and side-chatter.\n` +
      `- Do NOT copy sentences verbatim. Paraphrase in your own words.\n` +
      `- Do NOT repeat these instructions. Output ONLY the bullets.\n\n` +
      `Segment (${tag}) is wrapped in <segment> tags:\n\n` +
      `<segment>\n${chunk}\n</segment>`;

    try {
      const raw = await callPolish(prompt);
      const cleaned = cleanBulletList(raw, chunk);
      if (cleaned) bullets.push(`## ${tag}\n${cleaned}`);
    } catch (err) {
      console.warn(`[SummaryGenerator] chunk ${i + 1} compression failed:`, err);
      // Skip this chunk; other chunks still contribute.
    }
  }

  if (bullets.length === 0) {
    // All chunks failed — hard-truncate the transcript as a last resort.
    return transcript.slice(0, SINGLE_PASS_CHAR_LIMIT);
  }

  return bullets.join('\n\n');
}

/**
 * Split on sentence boundaries when possible so chunks don't start mid-word.
 * Falls back to a hard char cut if no boundary is found.
 */
function splitIntoChunks(text: string, targetSize: number): string[] {
  if (text.length <= targetSize) return [text];

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const end = Math.min(cursor + targetSize, text.length);
    if (end === text.length) {
      chunks.push(text.slice(cursor));
      break;
    }
    // Prefer a sentence break within the last 500 chars of the window.
    const searchFrom = Math.max(end - 500, cursor + 1);
    const slice = text.slice(searchFrom, end);
    const lastBoundary = Math.max(
      slice.lastIndexOf('. '),
      slice.lastIndexOf('! '),
      slice.lastIndexOf('? '),
      slice.lastIndexOf('\n'),
    );
    const cut = lastBoundary >= 0 ? searchFrom + lastBoundary + 1 : end;
    chunks.push(text.slice(cursor, cut).trim());
    cursor = cut;
  }
  return chunks.filter(c => c.length > 0);
}

// ──────────────────────────────────────────────────────────────────────────
// Template + plain-summary passes (with echo guardrails)
// ──────────────────────────────────────────────────────────────────────────

async function runTemplateWithGuardrails(
  template: MeetingTemplate,
  input: string,
) {
  // Pass #1 — honour the template's own prompt with the strict echo guard.
  let lastAttempt: Awaited<ReturnType<typeof runTemplate>> | null = null;
  try {
    const structured = await runTemplate(template, input);
    lastAttempt = structured;
    if (structured && !isStructuredEcho(structured.rawOutput, input)) {
      return structured;
    }
  } catch (err) {
    console.warn('[SummaryGenerator] template pass #1 failed:', err);
  }

  // Pass #2 — retry with a harsher anti-echo prefix.
  const hardenedTemplate: MeetingTemplate = {
    ...template,
    llm_prompt:
      `IMPORTANT: The previous attempt failed because the output was too long or ` +
      `copied the input verbatim. You MUST output ONLY the requested section ` +
      `headings (## Title) with short bullets underneath. Do NOT repeat the ` +
      `transcript. Do NOT include these instructions.\n\n` +
      template.llm_prompt,
  };
  try {
    const structured = await runTemplate(hardenedTemplate, input);
    if (structured) lastAttempt = structured;
    if (structured && !isStructuredEcho(structured.rawOutput, input)) {
      return structured;
    }
  } catch (err) {
    console.warn('[SummaryGenerator] template pass #2 failed:', err);
  }

  // Pass #3 — last resort. The strict echo guard rejected both attempts,
  // but they may still be VALID structured output that just happens to be
  // longer than MAX_OUTPUT_TO_INPUT_RATIO would allow (common for short
  // meetings where headings + bullets exceed transcript length). Accept
  // the output if it has at least one ## heading or - bullet AND doesn't
  // contain prompt leakage. Without this, users get "Summary unavailable"
  // for perfectly good summaries.
  if (lastAttempt && hasStructureWithoutPromptLeak(lastAttempt.rawOutput)) {
    return lastAttempt;
  }

  return null;
}

async function plainSummarize(input: string): Promise<string | null> {
  // The "Free-form bullets (no template)" path. Produces flat bullets
  // only — no headings, no tables. Users who want structured output pick
  // the "Default" template instead (or any of the meeting-type-specific
  // templates), which runs through MeetingTemplateEngine and produces
  // the proper sectioned layout.
  const basePrompt =
    `You are a meeting-notes assistant. Produce clear, concise bullet points ` +
    `capturing key decisions, action items, and discussion topics from the ` +
    `transcript below.\n\n` +
    `Rules — follow strictly:\n` +
    `- Output 5 to 15 short bullets (one line each, starting with "- ").\n` +
    `- Paraphrase; do NOT copy sentences verbatim from the transcript.\n` +
    `- Do NOT repeat these instructions or the transcript.\n` +
    `- Output ONLY the bullets, no preamble.\n\n` +
    `Transcript is wrapped in <transcript> tags:\n\n` +
    `<transcript>\n${input}\n</transcript>`;

  // Attempt 1.
  try {
    const raw = await callPolish(basePrompt);
    const cleaned = cleanBulletList(raw, input);
    if (cleaned) return cleaned;
  } catch (err) {
    console.warn('[SummaryGenerator] plain pass #1 failed:', err);
  }

  // Attempt 2 — tighter.
  try {
    const raw = await callPolish(
      `RETRY: previous output was rejected as too long or repetitive. ` +
      `Output AT MOST 10 short bullets. Paraphrase only. Nothing else.\n\n` +
      basePrompt,
    );
    const cleaned = cleanBulletList(raw, input);
    if (cleaned) return cleaned;
  } catch (err) {
    console.warn('[SummaryGenerator] plain pass #2 failed:', err);
  }

  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Echo detection
// ──────────────────────────────────────────────────────────────────────────

/**
 * Looser fallback validator used by runTemplateWithGuardrails's pass #3.
 * Only rejects the obvious failure modes: empty output, prompt leakage,
 * the transcript wrapper tags. Does NOT reject on length ratio — that's
 * what isStructuredEcho is for, and the whole point of pass #3 is to
 * accept output the strict guard rejected.
 */
function hasStructureWithoutPromptLeak(rawOutput: string): boolean {
  const out = rawOutput.trim();
  if (!out) return false;
  if (out.includes('<transcript>') || out.includes('<segment>')) return false;
  if (/IMPORTANT: The previous attempt failed/i.test(out)) return false;
  if (/you are a (?:professional |meeting )?(?:meeting[- ])?notes?\s+(?:assistant|formatter)/i.test(out)) return false;
  // Must have at least one heading (## ) or bullet (- ) so we know it's
  // SOMETHING resembling structured notes, not a raw paragraph echo.
  return /^##\s/m.test(out) || /^-\s/m.test(out);
}

function isStructuredEcho(rawOutput: string, input: string): boolean {
  const out = rawOutput.trim();
  if (!out) return true;
  if (out.length > input.length * MAX_OUTPUT_TO_INPUT_RATIO) return true;
  if (out.includes('<transcript>') || out.includes('<segment>')) return true;
  if (/you are a meeting-notes assistant/i.test(out)) return true;
  if (/IMPORTANT: The previous attempt failed/i.test(out)) return true;
  if (hasLongVerbatimSpan(out, input)) return true;
  return false;
}

/**
 * Returns true if the output contains any verbatim span of
 * MAX_VERBATIM_SPAN_WORDS consecutive words from the input.
 */
function hasLongVerbatimSpan(output: string, input: string): boolean {
  const outWords = output.toLowerCase().split(/\s+/).filter(Boolean);
  if (outWords.length < MAX_VERBATIM_SPAN_WORDS) return false;
  const normalisedInput = ' ' + input.toLowerCase().replace(/\s+/g, ' ') + ' ';
  for (let i = 0; i <= outWords.length - MAX_VERBATIM_SPAN_WORDS; i++) {
    const span = ' ' + outWords.slice(i, i + MAX_VERBATIM_SPAN_WORDS).join(' ') + ' ';
    if (normalisedInput.includes(span)) return true;
  }
  return false;
}

/**
 * Clean LLM output that should be a bullet list.
 *  - Strips our XML tags if the model echoed them.
 *  - Strips the instruction preamble if it was copied in.
 *  - Returns null if the cleaned output looks like an echo or is empty.
 */
function cleanBulletList(raw: string, input: string): string | null {
  if (!raw) return null;
  let out = raw
    .replace(/<\/?(?:transcript|segment)>/gi, '')
    .replace(/^\s*(?:here (?:are|is)[^\n]*\n)/i, '')
    .trim();

  if (!out) return null;
  if (isStructuredEcho(out, input)) return null;

  // Normalise bullets — ensure each line starts with "- " if it looks like a bullet.
  const lines = out
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => (/^[-*•]\s+/.test(l) ? l.replace(/^[*•]\s+/, '- ') : l));

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────
// LLM plumbing
// ──────────────────────────────────────────────────────────────────────────

async function callPolish(prompt: string): Promise<string> {
  const ironmic = (window as any).ironmic;
  // Migrated from polishText (which layered the cleanup prompt on top of
  // the caller's system prompt — the wrong contract for summarization).
  // generateText is the dedicated transport for non-polish completions.
  // Pass empty system + full prompt as user; Phase 5 splits the prompt
  // properly into system/user when the new Auto-template prompt lands.
  if (!ironmic?.generateText) {
    throw new Error('generateText IPC not available');
  }
  const { text } = await ironmic.generateText('', prompt, { maxTokens: 1024, temperature: 0.2 });
  return text;
}

/**
 * Convert markdown into sanitized HTML for `structured_output.htmlContent`,
 * but only when `polish_format_mode === 'rich'`. Plain mode skips this so
 * MeetingNotesPanel falls through to the section-block UI (today's behavior).
 *
 * Returns undefined on any error or in plain mode — caller should treat
 * undefined as "no rich rendering available, use sections fallback".
 */
async function maybeConvertMarkdown(md: string): Promise<string | undefined> {
  if (!md.trim()) return undefined;
  const ironmic = (window as any).ironmic;
  if (!ironmic?.convertMarkdown) return undefined;
  try {
    const mode = await ironmic.getSetting?.('polish_format_mode');
    if (mode === 'plain') return undefined;
    const projections = await ironmic.convertMarkdown(md);
    return projections.html || undefined;
  } catch {
    return undefined;
  }
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

// ──────────────────────────────────────────────────────────────────────────
// Version history helpers — used by the "Save to history" flow
// ──────────────────────────────────────────────────────────────────────────

/** Maximum number of retained versions per meeting. */
const MAX_VERSIONS = 20;

/** Append a snapshot to the versions array (LRU-capped). */
export function appendVersion(
  current: StructuredOutput,
  reason: VersionEntry['reason'],
): StructuredOutput {
  const snapshot = {
    sections: current.sections ?? [],
    plainSummary: current.plainSummary,
    title: current.title,
    titleSource: current.titleSource,
  };
  const entry: VersionEntry = {
    id: `v-${Date.now().toString(36)}`,
    savedAt: new Date().toISOString(),
    reason,
    templateId: current.templateId,
    templateName: current.templateName,
    snapshot,
  };
  const versions = [entry, ...(current.versions ?? [])].slice(0, MAX_VERSIONS);
  return { ...current, versions };
}

/** Restore a version back into the live structured output. */
export function restoreVersion(
  current: StructuredOutput,
  versionId: string,
): StructuredOutput | null {
  const version = current.versions?.find(v => v.id === versionId);
  if (!version) return null;
  return {
    ...current,
    sections: version.snapshot.sections,
    plainSummary: version.snapshot.plainSummary,
    title: version.snapshot.title,
    titleSource: version.snapshot.titleSource,
    hasUserEdits: false,
    // Keep the versions array intact so history doesn't disappear after restore.
  };
}

// ──────────────────────────────────────────────────────────────────────────
// AI title generation
// ──────────────────────────────────────────────────────────────────────────

/** Below this many plain-text chars we don't bother — the model has nothing
 *  to title against, and `Meeting #N` is the better fallback. */
const MIN_CHARS_FOR_AI_TITLE = 40;

/** Hard char clamp — meeting cards and the detail header truncate at
 *  ~40-45 chars on a normal viewport, so anything beyond that gets
 *  clipped with an ellipsis. Tightened from 80 to keep titles glanceable. */
const MAX_TITLE_CHARS = 45;

/** Hard word clamp — even when the model produces something under 45
 *  chars, we want it under N words for at-a-glance scanning. Phi-3 and
 *  cloud models both ignore "3-5 words" instructions reliably enough
 *  that a post-processing truncate is the right enforcement layer. */
const MAX_TITLE_WORDS = 5;

/**
 * Generate a short title from meeting content. Always runs through the
 * **strictly local** polish IPC — never routes to a cloud provider regardless
 * of `polish_allow_cloud`. Returns `null` whenever generation can't produce a
 * faithful title (content too thin, model missing, error, model said NONE);
 * callers should fall back to the sequence-based `Meeting #N` title.
 *
 * Never throws. Never blocks finalize.
 */
export async function generateMeetingTitle(
  content: string,
): Promise<string | null> {
  const text = (content ?? '').trim();
  if (text.length < MIN_CHARS_FOR_AI_TITLE) return null;

  const ironmic = (window as any).ironmic;
  if (!ironmic?.generateTextLocal) return null;

  // Title generation runs through the strictly-local generateText channel.
  // Caller owns the system prompt; no cleanup-prompt layering.
  //
  // Word count: the prompt asks for 2-4 words but post-processing clamps
  // to MAX_TITLE_WORDS regardless. Models routinely overshoot prose-style
  // word-count instructions, so the clamp is the actual enforcement.
  const systemPrompt =
    'Produce a SHORT 2-4 word title (max 5 words) for the meeting content ' +
    'the user provides. Sentence case. The title should be glanceable — ' +
    'a noun phrase, not a sentence. Examples of GOOD titles: "Sprint planning", ' +
    '"Q4 budget review", "Backend architecture sync". BAD (too long): "Speaker ' +
    'praises Granola for fast meeting notes". Output the title only — no ' +
    'quotes, no trailing period, no preamble. If content is too thin to title ' +
    'meaningfully, output the single token NONE.';

  let raw: string;
  try {
    const result = await ironmic.generateTextLocal(systemPrompt, `Content: ${text}`, {
      maxTokens: 32,
      temperature: 0.2,
    });
    raw = result.text;
  } catch {
    return null;
  }

  return sanitizeTitle(raw);
}

function sanitizeTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let t = String(raw).trim();
  if (!t) return null;
  // Take first non-empty line — models occasionally emit a preamble.
  t = t.split('\n').map(s => s.trim()).find(Boolean) ?? '';
  if (!t) return null;
  // Strip surrounding quotes (curly + straight).
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  // Strip trailing punctuation that titles shouldn't carry.
  t = t.replace(/[.!?,;:\-–—]+$/g, '').trim();
  if (!t) return null;
  if (t.toUpperCase() === 'NONE') return null;
  // Word clamp first — keeps the truncation on a word boundary instead of
  // mid-word. Splits on whitespace; punctuation stays attached to the
  // preceding word so "Q4 budget review" stays 3 words, not 4.
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > MAX_TITLE_WORDS) {
    t = words.slice(0, MAX_TITLE_WORDS).join(' ');
    // After truncating, drop any trailing punctuation again (if the cut
    // word ended with a comma, etc.).
    t = t.replace(/[.!?,;:\-–—]+$/g, '').trim();
  }
  // Char clamp as a defense-in-depth backstop for pathologically long
  // single words (URLs, hashes). Word clamp handles 99% of cases.
  if (t.length > MAX_TITLE_CHARS) t = t.slice(0, MAX_TITLE_CHARS).trim();
  return t || null;
}
