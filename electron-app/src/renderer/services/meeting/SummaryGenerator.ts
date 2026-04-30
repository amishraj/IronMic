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
const MAX_OUTPUT_TO_INPUT_RATIO = 0.8;
/** Longest verbatim span we'll tolerate from the input (words). */
const MAX_VERBATIM_SPAN_WORDS = 20;

export type ProcessingState = 'generating' | 'done' | 'empty';

export interface StructuredOutput {
  sections: StructuredSection[];
  plainSummary?: string;
  title?: string;
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
        };
      }
    } else {
      const summary = await plainSummarize(inputForFinalPass);
      if (summary) {
        return {
          sections: [{ key: 'summary', title: 'Summary', content: summary }],
          plainSummary: summary,
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
  // First attempt — honour the template's own prompt.
  try {
    const structured = await runTemplate(template, input);
    if (structured && !isStructuredEcho(structured.rawOutput, input)) {
      return structured;
    }
  } catch (err) {
    console.warn('[SummaryGenerator] template pass #1 failed:', err);
  }

  // Retry with a harsher prefix instructing the model to compress and not echo.
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
    if (structured && !isStructuredEcho(structured.rawOutput, input)) {
      return structured;
    }
  } catch (err) {
    console.warn('[SummaryGenerator] template pass #2 failed:', err);
  }

  return null;
}

async function plainSummarize(input: string): Promise<string | null> {
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
  if (!ironmic?.polishText) {
    throw new Error('polishText IPC not available');
  }
  return await ironmic.polishText(prompt);
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
    hasUserEdits: false,
    // Keep the versions array intact so history doesn't disappear after restore.
  };
}
