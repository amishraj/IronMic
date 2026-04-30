/**
 * LiveSummarizer — incremental, debounced, cancellable LLM summarization
 * for the active meeting. Subscribes to MeetingRecorder segments, batches
 * them, and emits a running "AI notes" summary back to the renderer.
 *
 * The summary integrates TWO streams of input:
 *   1. Spoken transcript (from MeetingRecorder chunks)
 *   2. The user's own typed notes (read from structured_output.userNotes
 *      before each run — the renderer persists them there via YourNotesPanel)
 *
 * Design constraints:
 *  - Only ONE live summary runs at a time. New content arriving mid-run
 *    sets `pendingRefresh=true` rather than aborting — aborting would kill
 *    the LLM subprocess mid-model-load on first invocation.
 *  - Minimum content gate: the LLM is NOT called until we have enough real
 *    spoken content (MIN_TRANSCRIPT_WORDS) OR the user has typed notes.
 *    Prevents hallucinated generic filler on near-silent sessions.
 *  - Incremental prompt: previous summary + new segments → new summary.
 *    Keeps token cost roughly bounded regardless of meeting length.
 */

import { BrowserWindow } from 'electron';
import { meetingRecorder, type TranscriptSegment } from './meeting-recorder';
import { llmSubprocess } from './ai/LlmSubprocess';
import { resolveActiveChatModel } from './ai/LocalLLMAdapter';
import { native } from './native-bridge';
import { IPC_CHANNELS } from '../shared/constants';

/**
 * Minimum spoken-word count required before the LLM is invoked for the
 * first summary. 15 words ≈ 6-10 seconds of substantive speech.
 *
 * Below this we assume the mic caught silence / keyboard clicks / a single
 * stray utterance — running the LLM on that reliably produces hallucinated
 * generic meeting bullets ("The team discussed project goals…") that aren't
 * grounded in the actual content. Better to show "waiting for more content"
 * until the user has actually said something.
 */
const MIN_TRANSCRIPT_WORDS = 15;

/**
 * Sentinel the LLM is instructed to emit when the combined transcript +
 * user-notes input has no substantive content. We detect this in the
 * response and treat it like the "insufficient" state.
 */
const INSUFFICIENT_MARKER = '[INSUFFICIENT_CONTENT]';

const LIVE_SUMMARY_PROMPT = `You are a meeting notes assistant producing concise, factual running notes.

You receive:
1. The spoken transcript (what was said in the meeting).
2. OPTIONALLY: notes the user is typing live during the meeting. These are the user's own words capturing what matters most to them.

USER NOTES ARE MANDATORY INPUT — not optional context:
- If a USER'S LIVE NOTES section is present, you MUST reflect its content in your bullets. Every distinct point, question, or action item the user wrote down needs a corresponding bullet in your output.
- Treat user notes as higher-priority than transcript facts when deciding what to emphasize: the user is signaling what they care about.
- If the user wrote something not spoken in the transcript (e.g., a reminder to themselves, a question for later), include it as a bullet clearly derived from their notes (you may prefix such bullets with "Note:" to distinguish them).
- If the transcript contradicts the user's notes, include both and note the discrepancy.
- Do NOT summarize user notes into oblivion — specific names, numbers, and questions the user typed must appear verbatim or nearly so.

HARD RULES — violating any of these is a failure:
- NEVER invent facts, topics, participants, decisions, or action items that are not explicitly present in the transcript or the user's typed notes.
- NEVER use generic filler like "The team discussed project goals", "Key topics were reviewed", "Several points were raised", or any phrasing that could apply to any meeting. Every bullet must reference specific content from the input.
- If the transcript is near-empty, mostly silence, or has no substantive content AND the user has typed nothing meaningful, output EXACTLY this single line and nothing else:
  ${INSUFFICIENT_MARKER}
- Do NOT add preamble, headers ("Meeting Notes:"), or closing remarks.

OUTPUT FORMAT:
- 3 to 8 markdown bullet points prefixed with "- ".
- Each bullet is one concise sentence.
- Keep existing bullets stable across updates — refine and extend rather than rewriting from scratch.
`;

interface LiveSummaryEvent {
  sessionId: string;
  summary: string;
  segmentCount: number;
  generatedAt: number;
  /** True when we decided the input was too thin to summarize. */
  insufficient: boolean;
}

/** Strip HTML tags from TipTap getHTML() output to get plain text for the LLM. */
function htmlToPlainText(html: string): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Count whitespace-separated tokens of length ≥ 1. */
function wordCount(text: string): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}

/** Read the user's live notes (plain text) from the session's structured_output. */
function readUserNotes(sessionId: string): string {
  try {
    const raw = native.addon.getMeetingSession(sessionId);
    if (!raw || raw === 'null') return '';
    const session = JSON.parse(raw);
    if (!session?.structured_output) return '';
    const structured = JSON.parse(session.structured_output);
    const html = structured?.userNotes;
    if (typeof html !== 'string' || !html.trim()) return '';
    return htmlToPlainText(html);
  } catch {
    return '';
  }
}

class LiveSummarizerManager {
  private enabled = true;
  private sessionId: string | null = null;
  private segmentsBuffer: TranscriptSegment[] = [];
  private currentSummary = '';
  private lastSummarizedCount = 0;
  /** Hash of the user-notes text covered by currentSummary — used to
   *  detect when user notes changed enough to warrant a re-run even if
   *  no new transcript segments arrived. */
  private lastUserNotesSnapshot = '';
  /** True once the LLM has produced its first substantive (non-insufficient)
   *  summary. We never roll back from this — a later run that returns
   *  insufficient is ignored, because the earlier one was grounded. */
  private hasSubstantiveSummary = false;
  private currentInsufficient = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private activeController: AbortController | null = null;
  private activeRunPromise: Promise<void> | null = null;
  private pendingRefresh = false;
  private unsubscribeSegments: (() => void) | null = null;
  /** Debounce between a new segment arriving and the next LLM run kicking
   *  off. Shorter = faster live summary updates but more LLM cost; longer
   *  = more stable summaries but user waits longer to see new content
   *  reflected. 1000ms is a good middle ground; the summarizer batches
   *  multiple segments into one call anyway. */
  private debounceMs = 1000;
  private minSegmentsBeforeSummary = 1;

  /** Begin tracking a new meeting. Clears prior state. */
  start(sessionId: string): void {
    this.stop();
    this.sessionId = sessionId;
    this.segmentsBuffer = [];
    this.currentSummary = '';
    this.lastSummarizedCount = 0;
    this.lastUserNotesSnapshot = '';
    this.hasSubstantiveSummary = false;
    this.currentInsufficient = false;
    this.pendingRefresh = false;

    this.unsubscribeSegments = meetingRecorder.onSegment((seg) => {
      if (!this.sessionId || seg.session_id !== this.sessionId) return;
      this.segmentsBuffer.push(seg);
      this.scheduleSummary();
    });
  }

  /** Called by the renderer (via IPC) when the user's typed notes change.
   *  Triggers a debounced re-summary so the user's emphasis shows up in
   *  the AI notes without them having to wait for the next spoken chunk. */
  notifyUserNotesChanged(sessionId: string): void {
    if (this.sessionId !== sessionId) return;
    this.scheduleSummary();
  }

  /** Stop tracking. Aborts any in-flight run (use flush() first to preserve it). */
  stop(): void {
    if (this.unsubscribeSegments) {
      try { this.unsubscribeSegments(); } catch { /* noop */ }
      this.unsubscribeSegments = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.activeController) {
      try { this.activeController.abort(); } catch { /* noop */ }
      this.activeController = null;
    }
    this.sessionId = null;
    this.segmentsBuffer = [];
    this.currentSummary = '';
    this.lastSummarizedCount = 0;
    this.lastUserNotesSnapshot = '';
    this.hasSubstantiveSummary = false;
    this.currentInsufficient = false;
    this.pendingRefresh = false;
    this.activeRunPromise = null;
  }

  /**
   * End-of-meeting finalization. The goal is to return the freshest-possible
   * summary to the caller as quickly as possible, because the user is
   * staring at "Processing…" until this resolves.
   *
   * Strategy (much cheaper than the previous always-force-a-run approach):
   *   1. Cancel the debounce timer so no new run starts after our decision.
   *   2. Drain any in-flight LLM call + any pendingRefresh chained after it.
   *   3. Check whether there's genuinely NEW content to summarize:
   *        - unsummarized segments whose combined word count is > 10, OR
   *        - user notes that changed since the last run
   *      If neither, the current summary is already fresh → return it
   *      immediately (0 extra LLM calls).
   *   4. Otherwise run ONE final pass with the natural content gates. If
   *      the gates reject (very thin content), that's the final state.
   *
   * Timeout shrunk from 90s → 25s so a slow/hung LLM can't keep the user
   * waiting forever. On timeout we fall back to whatever summary we have.
   */
  async flush(timeoutMs = 25_000): Promise<{ summary: string; insufficient: boolean }> {
    const sessionId = this.sessionId;
    if (!sessionId) {
      return { summary: this.currentSummary, insufficient: this.currentInsufficient };
    }

    // Step 1: kill the debounce.
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    // pendingRefresh stays intact — we let the natural drain below honor
    // any queued follow-up from the finally-block in runSummary.

    const deadline = Date.now() + timeoutMs;

    // Step 2: drain in-flight and any pendingRefresh-chained runs.
    // Each iteration awaits the current activeRunPromise; runSummary's
    // finally block may chain another run (if pendingRefresh was set
    // during an in-flight call), in which case activeRunPromise gets
    // reassigned and we loop to await that too.
    while (this.activeRunPromise && Date.now() < deadline) {
      const current = this.activeRunPromise;
      try {
        await Promise.race([
          current,
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('flush: drain timeout')), Math.max(0, deadline - Date.now()))),
        ]);
      } catch (err) {
        console.warn('[LiveSummarizer] flush drain aborted:', (err as Error)?.message);
        break;
      }
      // If the same promise is still the active one after settling, we're done.
      if (this.activeRunPromise === current) break;
    }

    // Step 3: decide whether a final pass is actually needed.
    const userNotes = readUserNotes(sessionId);
    const userNotesChanged = userNotes !== this.lastUserNotesSnapshot;
    const unsummarized = this.segmentsBuffer.slice(this.lastSummarizedCount);
    const newWords = unsummarized.reduce((sum, seg) => sum + wordCount(seg.text), 0);

    // Threshold: < 10 new spoken words AND no user-notes change → the live
    // summary already captures the meeting. Running the LLM again would
    // cost 10–20 s and produce an almost-identical result. Skip.
    const materialChange = userNotesChanged || newWords >= 10;
    const remaining = Math.max(0, deadline - Date.now());
    if (!materialChange || remaining < 1500) {
      return { summary: this.currentSummary, insufficient: this.currentInsufficient };
    }

    // Step 4: one final pass. Not `force` — we want the content-quality gate
    // (MIN_TRANSCRIPT_WORDS) to decide if we emit insufficient.
    try {
      await Promise.race([
        this.runSummary(false),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('flush: final-pass timeout')), remaining)),
      ]);
    } catch (err) {
      console.warn('[LiveSummarizer] flush final-pass failed:', (err as Error)?.message);
    }

    return { summary: this.currentSummary, insufficient: this.currentInsufficient };
  }

  getCurrentSummary(): string { return this.currentSummary; }
  isInsufficient(): boolean { return this.currentInsufficient; }

  private scheduleSummary(): void {
    if (!this.enabled) return;
    // For transcript-triggered runs, wait until we have at least one segment.
    // (notifyUserNotesChanged can also trigger us with zero segments — that's fine;
    // runSummary() will gate on content.)
    if (this.segmentsBuffer.length < this.minSegmentsBeforeSummary &&
        this.lastUserNotesSnapshot === '' && readUserNotes(this.sessionId!) === '') {
      return;
    }

    if (this.activeController) {
      this.pendingRefresh = true;
      return;
    }

    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.activeRunPromise = this.runSummary();
    }, this.debounceMs);
  }

  /**
   * Run the LLM summary pass.
   * @param force  If true, run even when no new content appears to have
   *               arrived since the last run (used by flush()).
   */
  private async runSummary(force = false): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) return;

    const userNotes = readUserNotes(sessionId);
    const userNotesChanged = userNotes !== this.lastUserNotesSnapshot;
    const newSegments = this.segmentsBuffer.slice(this.lastSummarizedCount);
    const hasNewTranscript = newSegments.length > 0;

    if (!force && !hasNewTranscript && !userNotesChanged) {
      // Nothing new to summarize.
      return;
    }

    // ── Content-quality gate ──
    // Require either enough transcribed words OR substantive user notes.
    // Without this, near-empty sessions get plausible-sounding-but-fabricated bullets.
    const fullTranscript = this.segmentsBuffer.map(s => s.text).join(' ');
    const transcriptWords = wordCount(fullTranscript);
    const userNotesWords = wordCount(userNotes);

    if (transcriptWords < MIN_TRANSCRIPT_WORDS && userNotesWords < 5 && !this.hasSubstantiveSummary) {
      // Not enough to summarize faithfully — emit an "insufficient" state
      // and wait for more input. Don't spend an LLM call on this.
      this.currentInsufficient = true;
      this.currentSummary = '';
      this.emitSummary();
      return;
    }

    const resolved = resolveActiveChatModel(native);
    if (!resolved) {
      if (!this.currentSummary) {
        this.currentSummary = '- (Live summary unavailable — no local LLM configured)';
        this.currentInsufficient = false;
        this.emitSummary();
      }
      return;
    }

    // Build the prompt body.
    const transcriptSection = fullTranscript.trim()
      ? `TRANSCRIPT:\n${fullTranscript.trim()}`
      : 'TRANSCRIPT:\n(no substantive spoken content yet)';

    const userNotesSection = userNotes.trim()
      ? `\n\nUSER'S LIVE NOTES (authoritative emphasis — integrate these):\n${userNotes.trim()}`
      : '';

    const previousSection = this.currentSummary && this.hasSubstantiveSummary
      ? `\n\nPREVIOUS BULLETS (extend and refine; do not rewrite from scratch):\n${this.currentSummary}`
      : '';

    const userContent =
      `${transcriptSection}${userNotesSection}${previousSection}\n\n` +
      `Produce the updated bullet-point notes now. Remember: if nothing substantive is present, output ONLY ${INSUFFICIENT_MARKER}.`;

    const controller = new AbortController();
    this.activeController = controller;
    const snapshotCount = this.segmentsBuffer.length;
    const snapshotUserNotes = userNotes;

    try {
      const summary = await llmSubprocess.chatComplete({
        modelPath: resolved.modelPath,
        modelType: resolved.modelType,
        messages: [
          { role: 'system', content: LIVE_SUMMARY_PROMPT },
          { role: 'user', content: userContent },
        ],
        maxTokens: 512,
        temperature: 0.1,
        signal: controller.signal,
      });

      if (controller.signal.aborted) return;
      if (this.sessionId !== sessionId) return;

      const trimmed = summary.trim();
      // Detect the sentinel (tolerate whitespace and slight formatting drift).
      const isInsufficient =
        trimmed === INSUFFICIENT_MARKER ||
        trimmed.toUpperCase().includes(INSUFFICIENT_MARKER);

      if (isInsufficient) {
        // If we already have a substantive summary from an earlier run with
        // more input, don't roll it back — the model may be momentarily
        // confused by a thin incremental update. Keep the previous bullets.
        if (!this.hasSubstantiveSummary) {
          this.currentSummary = '';
          this.currentInsufficient = true;
          this.lastSummarizedCount = snapshotCount;
          this.lastUserNotesSnapshot = snapshotUserNotes;
          this.emitSummary();
        }
        return;
      }

      this.currentSummary = trimmed;
      this.currentInsufficient = false;
      this.hasSubstantiveSummary = true;
      this.lastSummarizedCount = snapshotCount;
      this.lastUserNotesSnapshot = snapshotUserNotes;
      this.emitSummary();
    } catch (err: any) {
      if (err?.message?.includes('aborted')) return;
      console.warn('[LiveSummarizer] Summary generation failed:', err?.message || err);
    } finally {
      if (this.activeController === controller) {
        this.activeController = null;
      }
      this.activeRunPromise = null;
      if (this.pendingRefresh && this.sessionId === sessionId) {
        this.pendingRefresh = false;
        // Catch-up run, no debounce.
        this.activeRunPromise = this.runSummary();
      }
    }
  }

  private emitSummary(): void {
    if (!this.sessionId) return;
    const payload: LiveSummaryEvent = {
      sessionId: this.sessionId,
      summary: this.currentSummary,
      segmentCount: this.lastSummarizedCount,
      generatedAt: Date.now(),
      insufficient: this.currentInsufficient,
    };
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      windows[0].webContents.send(IPC_CHANNELS.MEETING_LIVE_SUMMARY, payload);
    }
  }
}

export const liveSummarizer = new LiveSummarizerManager();
