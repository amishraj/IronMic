/**
 * MeetingRecorder — orchestrates the 30-second audio chunk loop for Granola-style
 * meeting recording.
 *
 * Reuses the existing CaptureEngine (startRecording / stopRecording N-API calls).
 * Each chunk is extracted by calling stopRecording() → startRecording() immediately,
 * creating a minimal (~50ms) gap while the previous chunk is transcribed.
 *
 * Segments are kept in memory during the session so this works with the current
 * compiled Rust addon. When the Rust is rebuilt with the transcript_segments table,
 * the storage can be upgraded to SQLite without changing the renderer logic.
 *
 * Runs in the main process so it can:
 *  - Hold a setInterval across the full meeting duration
 *  - Call native.addon directly without IPC round-trips
 *  - Push segment-ready events to the renderer via webContents.send
 */

import { BrowserWindow } from 'electron';
import { native } from './native-bridge';
import { llmSubprocess } from './ai/LlmSubprocess';
import { resolveActiveChatModel } from './ai/LocalLLMAdapter';
import { IPC_CHANNELS } from '../shared/constants';
import {
  isAudioSilent,
  sanitizeTranscribedText,
  transcribeWithTimeout,
} from './transcribe-clean';

/** Upper bound on how long we wait for a single Whisper transcribe call to
 *  return before moving on. If the native call hangs (happens occasionally
 *  with large models + GPU init), we drop the chunk rather than letting the
 *  whole chunk loop freeze. Picked at 35s: legitimate 15s-chunk + turbo-v3
 *  Whisper transcribe is <10s on CPU, ~2s on GPU — 35s is very generous. */
const TRANSCRIBE_TIMEOUT_MS = 35_000;

export interface TranscriptSegment {
  id: string;
  session_id: string;
  speaker_label: string | null;
  start_ms: number;
  end_ms: number;
  text: string;
  source: string;
  participant_id: string | null;
  confidence: number | null;
  created_at: string;
}

export interface MeetingRecordingState {
  status: 'idle' | 'recording' | 'stopping';
  sessionId: string | null;
  startedAt: number | null;
  segmentCount: number;
  deviceName: string | null;
}

const DIARIZATION_PROMPT = `You are a meeting transcript analyzer. Given the following raw transcript from a single audio stream, identify speaker changes and label each paragraph with [Speaker 1], [Speaker 2], etc. based on conversational context, topic shifts, and speaking style.

Rules:
- Label each paragraph or speaker turn with [Speaker N] at the start
- Keep the original text exactly — do not add, remove, or rephrase anything
- Use consistent speaker labels across the full transcript
- If you cannot distinguish speakers, use a single [Speaker 1] label throughout
- Output ONLY the labeled transcript with no preamble or explanation

Transcript:
`;

class MeetingRecorderManager {
  // Default — overridden by the startMeetingRecording IPC which reads
  // `meeting_chunk_interval_s` from settings (default 15s, clamped 10–60s).
  private chunkIntervalMs = 15_000;
  private chunkTimer: ReturnType<typeof setInterval> | null = null;
  private isProcessingChunk = false;

  // In-memory segment store — persisted to SQLite when Rust is rebuilt with
  // transcript_segments table. Using in-memory for now so everything works
  // with the existing compiled addon.
  private segments: TranscriptSegment[] = [];

  private state: MeetingRecordingState = {
    status: 'idle',
    sessionId: null,
    startedAt: null,
    segmentCount: 0,
    deviceName: null,
  };

  isActive(): boolean {
    return this.state.status !== 'idle';
  }

  getState(): MeetingRecordingState {
    return { ...this.state };
  }

  /**
   * Return in-memory segments for the current/last session.
   * Used by the IPC LIST_TRANSCRIPT_SEGMENTS handler as a fallback
   * when the transcript_segments table doesn't exist yet.
   */
  getSegments(): TranscriptSegment[] {
    return [...this.segments];
  }

  /**
   * Start meeting recording.
   * @param sessionId  The meeting_sessions.id to associate segments with.
   * @param deviceName Optional named audio device (e.g. "BlackHole 2ch").
   *                   Falls back to startRecording() until Rust is rebuilt with
   *                   startRecordingFromDevice().
   * @param chunkIntervalS  Chunk interval in seconds (default 15).
   */
  async startMeetingRecording(
    sessionId: string,
    deviceName?: string | null,
    chunkIntervalS = 15,
  ): Promise<void> {
    if (this.state.status !== 'idle') {
      throw new Error('Meeting recording is already active');
    }

    this.chunkIntervalMs = chunkIntervalS * 1000;
    this.segments = [];

    // Start audio capture — use named device if available in compiled addon
    if (deviceName && typeof native.addon.startRecordingFromDevice === 'function') {
      await native.addon.startRecordingFromDevice(deviceName);
    } else {
      // Works with default mic and BlackHole (via OS aggregate device)
      native.addon.startRecording();
    }

    const now = Date.now();
    this.state = {
      status: 'recording',
      sessionId,
      startedAt: now,
      segmentCount: 0,
      deviceName: deviceName ?? null,
    };

    this.pushStateToRenderer();

    // Kick off the periodic chunk loop
    this.chunkTimer = setInterval(() => {
      void this.processChunk();
    }, this.chunkIntervalMs);
  }

  /**
   * Stop meeting recording, flush the last chunk, run LLM diarization,
   * and return the assembled full transcript + segments.
   */
  async stopMeetingRecording(): Promise<{ fullTranscript: string; segments: TranscriptSegment[] }> {
    if (this.state.status === 'idle') {
      throw new Error('Meeting recording is not active');
    }

    this.state = { ...this.state, status: 'stopping' };
    this.pushStateToRenderer();

    // Stop the chunk timer so no new chunks start
    if (this.chunkTimer) {
      clearInterval(this.chunkTimer);
      this.chunkTimer = null;
    }

    // Wrap the rest in try/finally so state ALWAYS returns to 'idle', even
    // if the final chunk transcription, diarization, or LLM call throws.
    // Otherwise the recorder would be stuck in 'stopping' and block future
    // recordings with "already active".
    try {
      // Wait for any in-flight chunk to complete before processing the final one
      let waited = 0;
      while (this.isProcessingChunk && waited < 10_000) {
        await new Promise(r => setTimeout(r, 100));
        waited += 100;
      }

      // Process the final partial chunk (whatever accumulated since last drain)
      try { await this.processChunk(true /* isFinal */); }
      catch (err) { console.error('[MeetingRecorder] Final chunk failed:', err); }

      // Assemble the full transcript from in-memory segments
      const fullTranscript = this.segments
        .sort((a, b) => a.start_ms - b.start_ms)
        .map(s => s.text)
        .join('\n\n');

      const finalSegments = [...this.segments];

      // Decide whether to run diarization at all. Skip when:
      //   - there's only one distinct participant (solo recording — speaker
      //     labels are meaningless and the LLM call just burns 10-30s)
      //   - the transcript is short (< 400 chars — not enough for the model
      //     to reliably discriminate speakers anyway)
      // When we DO run diarization, we run it in the BACKGROUND — the stop
      // handler returns immediately, so the user isn't blocked on it. The
      // labels show up on the next detail-page load once the update finishes.
      const uniqueParticipants = new Set(
        finalSegments.map(s => s.participant_id || 'local'),
      );
      const shouldDiarize = fullTranscript.length >= 400
        && finalSegments.length > 1
        && uniqueParticipants.size > 1;

      if (shouldDiarize) {
        // Fire and forget. Capture the segments array explicitly so we
        // label the RIGHT session's segments even if a new meeting starts
        // before this completes.
        const segmentsSnapshot = finalSegments;
        void (async () => {
          try {
            const labeled = await this.runDiarization(fullTranscript);
            if (labeled) this.applyDiarizationLabels(labeled, segmentsSnapshot);
          } catch (err) {
            console.error('[MeetingRecorder] Background diarization failed:', err);
          }
        })();
      }

      return { fullTranscript, segments: finalSegments };
    } finally {
      // Belt-and-braces: make sure the native recorder is stopped even if we
      // never reached the restart branch in processChunk. Ignore errors —
      // stopRecording throws if no stream is active.
      try { native.addon.stopRecording(); } catch { /* expected if already stopped */ }
      this.state = {
        status: 'idle',
        sessionId: null,
        startedAt: null,
        segmentCount: 0,
        deviceName: null,
      };
      this.pushStateToRenderer();
    }
  }

  /**
   * Extract the current buffer via stopRecording() → startRecording() (stop-restart pattern).
   * Creates a minimal ~50ms gap while keeping the same capture device.
   * When the Rust is rebuilt, this will be replaced by drainRecordingBuffer().
   */
  private async processChunk(isFinal = false): Promise<void> {
    if (this.isProcessingChunk && !isFinal) {
      // Previous chunk still transcribing — skip this tick to avoid overlap
      console.warn('[MeetingRecorder] Chunk still processing, skipping tick');
      return;
    }

    const { sessionId, startedAt, segmentCount } = this.state;
    if (!sessionId || !startedAt) return;

    this.isProcessingChunk = true;

    try {
      const chunkStartMs = segmentCount * this.chunkIntervalMs;
      const chunkEndMs = isFinal
        ? Date.now() - startedAt
        : chunkStartMs + this.chunkIntervalMs;

      // Drain the buffer by stopping the stream
      let audioBuffer: Buffer;
      try {
        audioBuffer = native.addon.stopRecording();
      } catch (err) {
        console.warn('[MeetingRecorder] Failed to stop for chunk drain:', err);
        return;
      }

      // Immediately restart (unless this is the final chunk)
      if (!isFinal) {
        try {
          if (this.state.deviceName && typeof native.addon.startRecordingFromDevice === 'function') {
            await native.addon.startRecordingFromDevice(this.state.deviceName);
          } else {
            native.addon.startRecording();
          }
        } catch (err) {
          console.error('[MeetingRecorder] Failed to restart recording after chunk:', err);
          this.state = { ...this.state, status: 'idle' };
          this.pushStateToRenderer();
          return;
        }
      }

      // ── Silence / low-energy gate ──
      // Compute RMS on the raw PCM buffer. If it's below the noise floor we
      // skip Whisper entirely — running the model on silence is expensive
      // AND dangerous (Whisper hallucinates "thank you", "[BLANK_AUDIO]",
      // etc. which would then pollute the AI notes summary).
      if (isAudioSilent(audioBuffer)) {
        return;
      }

      // ── Transcribe with a timeout guard ──
      // If Whisper hangs (rare but observed on GPU init/model reload), we
      // drop this chunk and keep recording rather than stalling the whole
      // session. The orphan native call will eventually complete and its
      // output is simply discarded.
      const rawText = await transcribeWithTimeout(
        Promise.resolve(native.addon.transcribe(audioBuffer)),
        TRANSCRIBE_TIMEOUT_MS,
        'MeetingRecorder.transcribe',
      );
      if (rawText == null) return;

      // ── Text hygiene ──
      // Strip bracket markers, collapse repetition loops, drop exact-match
      // hallucinations. Keeps junk out of the transcript AND the AI notes.
      const text = sanitizeTranscribedText(rawText);
      if (!text) return;

      // Build the segment object and store in memory
      const segment: TranscriptSegment = {
        id: `seg-${Date.now()}-${segmentCount}`,
        session_id: sessionId,
        speaker_label: null, // assigned post-meeting by LLM diarization
        start_ms: chunkStartMs,
        end_ms: chunkEndMs,
        text,
        source: 'meeting',
        participant_id: null,
        confidence: null,
        created_at: new Date().toISOString(),
      };

      // Persist to SQLite transcript_segments table if the N-API export exists.
      // This guarantees segments survive past app restart / across detail-page loads.
      let persisted: TranscriptSegment = segment;
      if (typeof native.addon.addTranscriptSegment === 'function') {
        try {
          const json = native.addon.addTranscriptSegment(
            sessionId,
            null,
            chunkStartMs,
            chunkEndMs,
            segment.text,
            'meeting',
          );
          const parsed = JSON.parse(json);
          if (parsed && parsed.id) persisted = parsed as TranscriptSegment;
        } catch (err) {
          console.warn('[MeetingRecorder] Failed to persist segment to DB (keeping in-memory):', err);
        }
      }

      this.segments.push(persisted);
      this.state = { ...this.state, segmentCount: segmentCount + 1 };

      // Push to renderer for live transcript display
      this.pushSegmentToRenderer(persisted);
    } finally {
      this.isProcessingChunk = false;
    }
  }

  /**
   * Run LLM diarization on the full transcript and return the labeled version.
   * Uses the existing LlmSubprocess — no new infrastructure.
   */
  private async runDiarization(fullTranscript: string): Promise<string | null> {
    // Honor the user's configured LLM from settings; fall back to first downloaded.
    const resolved = resolveActiveChatModel(native);
    if (!resolved) {
      console.info('[MeetingRecorder] No LLM available for diarization — skipping speaker labels');
      return null;
    }

    try {
      const labeled = await llmSubprocess.chatComplete({
        modelPath: resolved.modelPath,
        modelType: resolved.modelType,
        messages: [
          { role: 'user', content: DIARIZATION_PROMPT + fullTranscript },
        ],
        maxTokens: Math.min(fullTranscript.length * 2, 8192),
        temperature: 0.1,
      });
      return labeled ?? null;
    } catch (err) {
      console.error('[MeetingRecorder] Diarization LLM error:', err);
      return null;
    }
  }

  /**
   * Parse "[Speaker N]" labels from the LLM output and update the given
   * segments. Takes `segments` as an explicit argument (rather than
   * reading `this.segments`) so background diarization work started on
   * session A doesn't corrupt session B if the user starts a new meeting
   * before diarization completes.
   */
  private applyDiarizationLabels(labeledTranscript: string, segmentsToLabel?: TranscriptSegment[]): void {
    const speakerPattern = /\[Speaker (\d+)\][:：]?\s*([\s\S]*?)(?=\[Speaker \d+\]|$)/g;
    const labeledChunks: Array<{ label: string; text: string }> = [];
    let match: RegExpExecArray | null;
    while ((match = speakerPattern.exec(labeledTranscript)) !== null) {
      labeledChunks.push({
        label: `Speaker ${match[1]}`,
        text: match[2].trim(),
      });
    }

    if (labeledChunks.length === 0) return;

    const targets = segmentsToLabel ?? this.segments;
    for (const segment of targets) {
      const segWords = new Set(segment.text.toLowerCase().split(/\s+/).filter(w => w.length > 3));
      let bestLabel = labeledChunks[0].label;
      let bestScore = 0;

      for (const chunk of labeledChunks) {
        const chunkWords = chunk.text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const overlap = chunkWords.filter(w => segWords.has(w)).length;
        const score = segWords.size > 0 ? overlap / segWords.size : 0;
        if (score > bestScore) {
          bestScore = score;
          bestLabel = chunk.label;
        }
      }

      segment.speaker_label = bestLabel;

      // Persist the diarization label if the segment has a real DB id.
      // Fake in-memory IDs start with "seg-" — skip those.
      if (!segment.id.startsWith('seg-') && typeof native.addon.updateSegmentSpeaker === 'function') {
        try {
          native.addon.updateSegmentSpeaker(segment.id, bestLabel);
        } catch (err) {
          console.warn('[MeetingRecorder] Failed to persist speaker label:', err);
        }
      }
    }
  }

  private pushStateToRenderer(state?: MeetingRecordingState): void {
    const s = state ?? this.state;
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      windows[0].webContents.send(IPC_CHANNELS.MEETING_RECORDING_STATE, s);
    }
  }

  private pushSegmentToRenderer(segment: TranscriptSegment): void {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      windows[0].webContents.send(IPC_CHANNELS.MEETING_SEGMENT_READY, segment);
    }
    // Notify external subscribers (e.g. meeting-room-server) so they can
    // rebroadcast the segment to LAN participants.
    for (const cb of this.segmentListeners) {
      try { cb(segment); } catch (err) { console.warn('[MeetingRecorder] segment listener error:', err); }
    }
  }

  // ── External subscription API for the room server ──
  private segmentListeners: Array<(seg: TranscriptSegment) => void> = [];

  onSegment(cb: (seg: TranscriptSegment) => void): () => void {
    this.segmentListeners.push(cb);
    return () => {
      this.segmentListeners = this.segmentListeners.filter(x => x !== cb);
    };
  }

  /**
   * Used by the room server when a remote participant's segment arrives.
   * Adds the segment to the in-memory list and forwards it to the renderer
   * so the host's transcript panel shows everyone's contribution.
   */
  ingestRemoteSegment(segment: TranscriptSegment): void {
    this.segments.push(segment);
    this.pushSegmentToRenderer(segment);
  }

  /** Currently active session id, or null if no meeting is in progress. */
  getActiveSessionId(): string | null {
    return this.state.sessionId;
  }
}

export const meetingRecorder = new MeetingRecorderManager();
