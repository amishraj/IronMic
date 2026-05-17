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

const LIVE_SUMMARY_PROMPT = `You are a meeting notes assistant producing concise, factual running notes for ONE specific meeting.

You receive a MEETING CONTEXT block containing what was said in the meeting and any annotations participants typed alongside it. Treat all of this as a single, unified source of truth about what the meeting is about. Do NOT label content as coming from "the transcript" vs "user notes" vs "annotations" — weave it together so the result reads as one coherent picture of the meeting. Never prefix a bullet with "Note:", "User:", "Annotation:", or any similar source tag.

You may also receive a MEETING MEMORY block — a running tally of participants, topics, decisions, and action items distilled from earlier passes. Use it as additional grounding so important details that have scrolled out of the latest bullets aren't lost. Cross-reference it against the MEETING CONTEXT; if memory says something contradicted by the latest context, trust the context.

HARD RULES — violating any of these is a failure:
- STAY ON SCOPE. Every bullet must reference specific content present in the MEETING CONTEXT or MEETING MEMORY. Do not extrapolate, generalize, or pull in outside knowledge. If a topic is mentioned briefly, the bullet about it must be brief.
- NEVER invent facts, topics, participants, decisions, action items, dates, numbers, or names not explicitly present in the input.
- NEVER use generic filler like "The team discussed project goals", "Key topics were reviewed", "Several points were raised", or anything that could apply to any meeting.
- The participants' typed annotations signal what they find important — emphasize those topics — but always keep them in the meeting's scope. A typed annotation reminding someone to do something later is in scope; a typed annotation about an unrelated subject is not.
- If the PREVIOUS BULLETS section diverges from what the MEETING CONTEXT actually supports, FIX IT in this pass — do not perpetuate drift.
- If the input is near-empty, mostly silence, or has no substantive content, output EXACTLY this single line and nothing else:
  ${INSUFFICIENT_MARKER}
- Do NOT add preamble, headers ("Meeting Notes:"), or closing remarks.

OUTPUT FORMAT:
- 3 to 8 markdown bullet points prefixed with "- ".
- Each bullet is one concise sentence about the meeting itself.
- Keep existing bullets stable across updates — refine and extend rather than rewriting from scratch, unless a bullet is now inaccurate or off-scope.
`;

/**
 * Compact prompt for distilling a running MEETING MEMORY from the full
 * meeting context. The memory is a small structured block that carries
 * forward facts even after bullets get refined — so e.g. a decision made
 * 20 minutes ago doesn't get lost when the bullets re-focus on the
 * current discussion.
 *
 * Kept deliberately short (max ~400 tokens) so it can be included in
 * subsequent prompts without ballooning cost.
 */
const MEMORY_DISTILL_PROMPT = `You are extracting durable meeting facts from a transcript and user notes. Produce ONE compact block in this exact shape:

participants: <comma-separated names mentioned or speaking; "unknown" if none>
topics: <comma-separated topics actually discussed; ≤ 8 items>
decisions: <bulleted list ("- ") of explicit decisions made; "(none yet)" if none>
action_items: <bulleted list ("- ") of explicit action items / owners / due dates; "(none yet)" if none>
open_questions: <bulleted list ("- ") of unresolved questions raised; "(none yet)" if none>

RULES:
- Only include facts EXPLICITLY present in the MEETING CONTEXT or PREVIOUS MEMORY.
- Never invent participants, topics, decisions, action items, or dates.
- When the PREVIOUS MEMORY contradicts new context, trust the new context.
- Never output preamble, code fences, headers, or commentary — just the five labeled lines/blocks in the exact order above.
- If a section has nothing yet, output "(none yet)".
- Keep the whole block under 350 words.`;

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

  /**
   * Durable structured memory of the meeting (participants, topics,
   * decisions, action items, open questions). Distilled by a separate
   * LLM pass that runs less frequently than the bullets. Carries forward
   * facts that might otherwise scroll out of the active bullet list when
   * the LLM refines them.
   *
   * Treated as a STRING (the LLM's raw block output) rather than a parsed
   * structure — we don't act on it programmatically; we just feed it back
   * to the next bullets-pass as additional context. Keeping it as text
   * means parsing drift can't break the renderer.
   */
  private currentMemory = '';

  /** Last segment count + last user notes covered by `currentMemory`. The
   *  memory is regenerated only when there's enough new content to make
   *  the LLM call worth its 5–10 s cost. */
  private lastMemorizedCount = 0;
  private lastMemorizedUserNotes = '';

  /**
   * Periodic-refresh tick. Fires on a fixed interval during an active
   * meeting and forces a `scheduleSummary()` call even if no new segments
   * have arrived. This catches two cases the segment-driven trigger misses:
   *
   *   1. Quiet stretches — silence/inaudible audio doesn't commit segments,
   *      but the user-typed annotations panel may have grown meaningfully.
   *      The user-notes IPC trigger handles SOME of this, but mid-tab
   *      remounts and live-summary post-recovery can both leave the
   *      summarizer with "no new content" when content actually exists.
   *   2. Memory refresh — durable memory benefits from a steady-cadence
   *      revisit (every ~60 s) so it can incorporate facts that just
   *      arrived without waiting for many segment-driven updates to
   *      stabilize the bullets.
   *
   * 60 s is the sweet spot: long enough that we're not burning LLM cycles
   * on near-silent stretches, short enough that a user typing notes
   * silently still sees the AI panel keep up.
   */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatMs = 60_000;

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
    this.currentMemory = '';
    this.lastMemorizedCount = 0;
    this.lastMemorizedUserNotes = '';

    this.unsubscribeSegments = meetingRecorder.onSegment((seg) => {
      if (!this.sessionId || seg.session_id !== this.sessionId) return;
      this.segmentsBuffer.push(seg);
      this.scheduleSummary();
    });

    // Heartbeat — see comment on `heartbeatTimer`. Cleared in stop().
    this.heartbeatTimer = setInterval(() => {
      if (!this.sessionId) return;
      // Only kick a refresh if there's actual reason to: either new
      // unsummarized segments OR potentially-new user notes (we don't
      // diff here; scheduleSummary's eventual runSummary() guards on
      // material change).
      const hasNewSegments = this.segmentsBuffer.length > this.lastSummarizedCount;
      const userNotes = readUserNotes(this.sessionId);
      const userNotesChanged = userNotes !== this.lastUserNotesSnapshot;
      if (hasNewSegments || userNotesChanged) {
        this.scheduleSummary();
      }
    }, this.heartbeatMs);
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
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
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
    this.currentMemory = '';
    this.lastMemorizedCount = 0;
    this.lastMemorizedUserNotes = '';
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

    // Build a single unified MEETING CONTEXT block. The transcript and the
    // typed annotations are both first-class meeting content; the LLM weaves
    // them together rather than calling out where each line came from.
    const transcriptBody = fullTranscript.trim() || '(no substantive spoken content yet)';
    const contextBody = userNotes.trim()
      ? `${transcriptBody}\n\n${userNotes.trim()}`
      : transcriptBody;
    const contextSection = `MEETING CONTEXT:\n${contextBody}`;

    const previousSection = this.currentSummary && this.hasSubstantiveSummary
      ? `\n\nPREVIOUS BULLETS (extend and refine; correct any that drift off-scope):\n${this.currentSummary}`
      : '';

    // MEETING MEMORY block — only injected once we've built one. The first
    // bullets-pass runs WITHOUT memory (we don't have any yet); from the
    // second pass on, the prior memory grounds the bullets even after they
    // get refined and topics scroll out of the active list.
    const memorySection = this.currentMemory
      ? `\n\nMEETING MEMORY (durable facts distilled from earlier passes — use as grounding):\n${this.currentMemory}`
      : '';

    const userContent =
      `${contextSection}${memorySection}${previousSection}\n\n` +
      `Produce the updated bullet-point notes now. Stay strictly within what the MEETING CONTEXT supports. If nothing substantive is present, output ONLY ${INSUFFICIENT_MARKER}.`;

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

      // Empty/junk-output guard. If the LLM returned nothing or just
      // punctuation/whitespace, do NOT overwrite a previously good summary —
      // that's how the panel can suddenly go blank mid-meeting after working
      // fine. Treat it like a transient error and keep the existing bullets.
      const hasSubstance = trimmed.replace(/[\s\-•*\.]/g, '').length >= 4;
      if (!hasSubstance) {
        if (!this.hasSubstantiveSummary) {
          // No good summary yet — fall back to the insufficient state so the
          // UI shows the "waiting for content" copy instead of a blank panel.
          this.currentSummary = '';
          this.currentInsufficient = true;
          this.lastSummarizedCount = snapshotCount;
          this.lastUserNotesSnapshot = snapshotUserNotes;
          this.emitSummary();
        } else {
          console.warn('[LiveSummarizer] LLM returned empty output; keeping previous summary');
          this.lastSummarizedCount = snapshotCount;
          this.lastUserNotesSnapshot = snapshotUserNotes;
        }
        return;
      }

      this.currentSummary = trimmed;
      this.currentInsufficient = false;
      this.hasSubstantiveSummary = true;
      this.lastSummarizedCount = snapshotCount;
      this.lastUserNotesSnapshot = snapshotUserNotes;
      this.emitSummary();
      // Mid-meeting persistence: write the running summary into the host
      // session's structured_output so a renderer remount (tab switch,
      // window reopen) re-hydrates the AI Notes panel instead of going
      // blank until the next LLM pass lands.
      this.persistRunningSummaryToHostSession(sessionId, trimmed);

      // Opportunistically refresh durable memory if enough new content has
      // arrived since the last memory pass. Runs in the background so we
      // don't block the next bullets-pass on it. Gated to avoid burning
      // LLM cycles when the meeting is just incrementing one chunk at a time.
      void this.maybeRefreshMemory(sessionId, fullTranscript, userNotes, snapshotCount, snapshotUserNotes);
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

  /**
   * Refresh the durable MEETING MEMORY block. Runs OPPORTUNISTICALLY:
   *
   *   - Skipped on the first bullets pass entirely (no prior memory to
   *     refine; the first bullets serve as the seed).
   *   - After that, runs only if at least 25 new words OR meaningful
   *     user-notes changes have accumulated since the last memory pass.
   *     This bounds cost — the memory call is ~5–10 s on local LLM and
   *     we don't want to run it on every chunk.
   *   - Runs in the background (no await on the caller side) so the
   *     bullets-pass response latency isn't impacted.
   *
   * On success, updates `this.currentMemory` and the snapshot counters.
   * On failure, leaves the previous memory in place (better than blanking
   * it on a transient model error).
   *
   * Hard contract: never throws. The memory is best-effort grounding;
   * losing a memory refresh is acceptable, blocking on it is not.
   */
  private async maybeRefreshMemory(
    sessionId: string,
    fullTranscript: string,
    userNotes: string,
    snapshotCount: number,
    snapshotUserNotes: string,
  ): Promise<void> {
    if (this.sessionId !== sessionId) return;

    // Gate 1: skip on the very first bullets-pass. We need at least one
    // round of grounded bullets before extracting durable facts.
    if (!this.hasSubstantiveSummary || this.currentSummary === '') return;

    // Gate 2: only refresh if enough new content has arrived since the
    // last memory pass. lastMemorizedCount==0 means we've never done one
    // — always do the first one once we have substantive bullets.
    const isFirstMemoryPass = this.lastMemorizedCount === 0 && !this.currentMemory;
    const newSegmentsSinceMemory = Math.max(0, snapshotCount - this.lastMemorizedCount);
    const newWordsSinceMemory = this.segmentsBuffer
      .slice(this.lastMemorizedCount, snapshotCount)
      .reduce((sum, s) => sum + wordCount(s.text), 0);
    const userNotesChangedSinceMemory = snapshotUserNotes !== this.lastMemorizedUserNotes;

    if (!isFirstMemoryPass && newWordsSinceMemory < 25 && !userNotesChangedSinceMemory) {
      return;
    }

    const resolved = resolveActiveChatModel(native);
    if (!resolved) return;

    const transcriptBody = fullTranscript.trim() || '(no substantive spoken content yet)';
    const contextBody = userNotes.trim()
      ? `${transcriptBody}\n\n${userNotes.trim()}`
      : transcriptBody;
    const contextSection = `MEETING CONTEXT:\n${contextBody}`;
    const previousMemorySection = this.currentMemory
      ? `\n\nPREVIOUS MEMORY (carry forward unless contradicted):\n${this.currentMemory}`
      : '';
    const memoryPrompt =
      `${contextSection}${previousMemorySection}\n\n` +
      `Produce the updated MEETING MEMORY block now, using EXACTLY the five labeled lines/blocks specified in the system prompt.`;

    const controller = new AbortController();
    try {
      const out = await llmSubprocess.chatComplete({
        modelPath: resolved.modelPath,
        modelType: resolved.modelType,
        messages: [
          { role: 'system', content: MEMORY_DISTILL_PROMPT },
          { role: 'user', content: memoryPrompt },
        ],
        maxTokens: 512,
        temperature: 0.1,
        signal: controller.signal,
      });

      if (controller.signal.aborted) return;
      if (this.sessionId !== sessionId) return;

      const trimmed = out.trim();
      // Sanity-check the output looks like a memory block. We're not
      // strict — the model may format it slightly differently — but if
      // we don't see at least 3 of the expected labels we treat it as
      // garbage and keep the previous memory.
      const labelHits = [
        /participants\s*:/i,
        /topics\s*:/i,
        /decisions\s*:/i,
        /action_items\s*:/i,
        /open_questions\s*:/i,
      ].filter((re) => re.test(trimmed)).length;
      if (labelHits < 3) {
        console.warn('[LiveSummarizer] memory refresh returned unparseable output; keeping previous memory');
        return;
      }

      this.currentMemory = trimmed;
      this.lastMemorizedCount = snapshotCount;
      this.lastMemorizedUserNotes = snapshotUserNotes;
      this.persistRunningMemoryToHostSession(sessionId, trimmed);
    } catch (err: any) {
      if (err?.message?.includes('aborted')) return;
      console.warn('[LiveSummarizer] memory refresh failed:', err?.message || err);
    }
  }

  /** Mirror of `persistRunningSummaryToHostSession` for the memory block.
   *  Persisted under a separate key so a renderer remount can hydrate
   *  both panels independently. */
  private persistRunningMemoryToHostSession(sessionId: string, memory: string): void {
    try {
      let merged: Record<string, unknown> = {};
      try {
        const raw = native.addon.getMeetingSession(sessionId);
        if (raw && raw !== 'null') {
          const session = JSON.parse(raw);
          const structuredRaw = session?.structured_output;
          if (typeof structuredRaw === 'string') {
            const parsed = JSON.parse(structuredRaw);
            if (parsed && typeof parsed === 'object') merged = parsed as Record<string, unknown>;
          }
        }
      } catch { /* fall through with empty merged */ }
      merged.liveAiMemory = memory;
      merged.liveAiMemoryAt = Date.now();
      native.setMeetingStructuredOutput(sessionId, JSON.stringify(merged));
    } catch (err) {
      console.warn('[LiveSummarizer] persistRunningMemory failed:', (err as Error)?.message);
    }
  }

  /** Best-effort write of the running summary into the host session's
   *  structured_output JSON under the `liveAiSummary` key, alongside a
   *  timestamp. The post-meeting finalize path overwrites these with the
   *  final flushed summary; this is purely so a remount during recording
   *  can re-hydrate the panel rather than wait for the next LLM pass. */
  private persistRunningSummaryToHostSession(sessionId: string, summary: string): void {
    try {
      let merged: Record<string, unknown> = {};
      try {
        const raw = native.addon.getMeetingSession(sessionId);
        if (raw && raw !== 'null') {
          const session = JSON.parse(raw);
          const structuredRaw = session?.structured_output;
          if (typeof structuredRaw === 'string') {
            const parsed = JSON.parse(structuredRaw);
            if (parsed && typeof parsed === 'object') merged = parsed as Record<string, unknown>;
          }
        }
      } catch { /* fall through with empty merged */ }
      merged.liveAiSummary = summary;
      merged.liveAiSummaryAt = Date.now();
      native.setMeetingStructuredOutput(sessionId, JSON.stringify(merged));
    } catch (err) {
      // Persistence is best-effort. The in-memory + IPC path is authoritative.
      console.warn('[LiveSummarizer] persistRunningSummary failed:', (err as Error)?.message);
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
    // Fan out to participants if a meeting room is currently hosted. Lazy
    // require to break the import cycle (meeting-room-server lazy-loads
    // this module on participant notes_update).
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { meetingRoomServer } = require('./meeting-room-server') as typeof import('./meeting-room-server');
      meetingRoomServer.broadcastLiveSummary(payload);
    } catch (err) {
      console.warn('[LiveSummarizer] room broadcast failed:', (err as Error)?.message);
    }
  }
}

export const liveSummarizer = new LiveSummarizerManager();
