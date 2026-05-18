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
  computeRmsPcm16,
} from './transcribe-clean';
import { audioStream } from './audio-stream-manager';
import { debugLog } from './debug-log';
import { correctTranscript } from '../shared/transcript-correction';
import { getWords as getDictionaryWords } from './dictionary-cache';
import { SpeakerClusterer, type SegmentEmbeddingRow as SegmentEmbeddingRowJs } from './SpeakerClusterer';

/**
 * Zero every PCM16 Buffer in a drained dual-stream tick. Module-level so it
 * is reachable from the `processChunkDual` `finally` and unit tests without
 * punching through the manager's private surface.
 *
 * Privacy invariant: every audio buffer that crossed the N-API boundary
 * must be wiped before its JS reference is released. `CapturedAudio::drop`
 * in Rust already zeros the underlying f32 vec at conversion time, but the
 * resulting JS Buffer survives until GC unless we explicitly fill it. This
 * helper closes that gap on every early-return path of `processChunkDual`:
 * mute gate, silent buffer, empty buffer, Whisper error, empty sanitized
 * text, and the M2 embed-failure path.
 */
export function zeroDrainedBuffersFinally(
  drained: { mic: Buffer; loopback: Buffer | null } | null,
): void {
  if (!drained) return;
  try {
    drained.mic?.fill(0);
  } catch {
    /* defensive — Buffer may have been transferred / detached */
  }
  try {
    drained.loopback?.fill(0);
  } catch {
    /* defensive */
  }
}

/**
 * Read the current diarization mode setting. 'off' means Simple mode
 * (one segment per chunk, labeled "Remote", no embedding work). 'embedding'
 * means Advanced mode (per-utterance rows with WeSpeaker embeddings and
 * post-meeting AHC refinement). Defaults to 'off' if the setting is
 * missing or the read fails.
 */
function readDiarizationMode(): 'off' | 'embedding' {
  try {
    const v = native.getSetting('meeting_diarization_mode') ?? 'off';
    return v === 'embedding' ? 'embedding' : 'off';
  } catch {
    return 'off';
  }
}

/** Upper bound on how long we wait for a single transcribe call to return
 *  before moving on. If the native call hangs (rare under Moonshine ONNX,
 *  more common with Whisper on CPU-bound VDIs), we drop the chunk rather
 *  than letting the whole chunk loop freeze. The orphan native call may
 *  still complete in C++; we just discard its result.
 *
 *  20s comfortably covers Moonshine Base on a 15s meeting chunk (~300 ms)
 *  and Whisper Small on the same chunk (~5–15s on VDI). Whisper Medium /
 *  Large v3 Turbo users on a slow CPU may want to lower the meeting
 *  chunk_interval_s to 8–10s instead of bumping this back up.
 *
 *  Note: Moonshine is trained for ≤30s utterances. We clamp the renderer-side
 *  meeting_chunk_interval_s to 25s when Moonshine is the active engine,
 *  in startMeetingRecording below. */
const TRANSCRIBE_TIMEOUT_MS = 20_000;

// Streaming-session constants — mirror dictation-streamer.ts but with a
// slightly more forgiving silence threshold for natural meeting pacing.
const SESSION_DRAIN_INTERVAL_MS = 200;
const SESSION_SILENCE_COMMIT_MS = 1500;
const SESSION_CAP_MS = 25_000; // Moonshine is trained on ≤30s utterances; commit at 25s to stay safe.

/** Dimensionality of the WeSpeaker ResNet34 speaker embedding. Mirrors
 *  `SPEAKER_EMBEDDING_DIM` in `rust-core/src/speaker/mod.rs`. Used by the
 *  meeting recorder to sanity-check `embedSpeaker` return values before
 *  feeding them to the clusterer or packing them into the DB. */
const SPEAKER_EMBED_FLOATS = 256;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

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
  /**
   * True when this session is using the Moonshine streaming session API
   * (live grey-typing draft + silence-driven commits). False when using the
   * legacy fixed-interval chunked path. Renderer reads this to choose between
   * "live transcription" copy and the "segments every ~15s" copy.
   */
  streamingMode: boolean;
  /**
   * True when this session is using the dual-stream remote-meeting capture
   * pipeline (mic + WASAPI loopback). When true, segments carry
   * `source: 'mic'` ("You") or `source: 'loopback'` ("Remote"); diarization
   * runs only on loopback segments. Mutually exclusive with `streamingMode`
   * — v1 forces the chunked path when remote capture is on.
   */
  remoteCaptureMode: boolean;
  /**
   * True when the dual-stream engine successfully opened a loopback stream
   * at start. False when the user enabled remote capture but the native
   * loopback was unavailable (non-Windows, exclusive-mode endpoint, etc.).
   * Renderer reads this to surface the "loopback unavailable" toast.
   */
  remoteCaptureLoopbackActive: boolean;
  /**
   * Self-mute flag during a live meeting. When true: drained audio is
   * discarded before STT, no segments emitted locally, and outbound segment
   * broadcast on the room server/client is suppressed. Reset to `false` on
   * every recording start and stop — never carries across sessions.
   */
  isMicMuted: boolean;
  /**
   * True ONLY during a mid-meeting engine swap. The renderer reads this to
   * show a spinner / "Switching engine…" indicator without unmounting the
   * live meeting UI.
   *
   * Why this is a separate flag (NOT a status transition through 'stopping'):
   * the renderer keys its layout off `status === 'recording'` — the moment
   * status flips to anything else, `isGranolaRecording` mirrors to false
   * and the meeting page reverts to the meetings-list view. Flickering to
   * the list view and back for every engine swap was the bug fixed here.
   *
   * The streaming loop reads this in its `while (...)` gate so a true
   * value triggers a clean exit + final drain + commit — same behavior as
   * an end-of-meeting stop, but the swap then restores `engineSwapping`
   * to false and the recorder transitions to the next mode without ever
   * leaving status='recording'.
   */
  engineSwapping: boolean;
}

const DIARIZATION_PROMPT_BASE = `You are a meeting transcript analyzer. Given the following raw transcript from a single audio stream, identify speaker changes and label each paragraph with [Speaker 1], [Speaker 2], etc. based on conversational context, topic shifts, and speaking style.

Rules:
- Label each paragraph or speaker turn with [Speaker N] at the start
- Keep the original text exactly — do not add, remove, or rephrase anything
- Use consistent speaker labels across the full transcript
- If you cannot distinguish speakers, use a single [Speaker 1] label throughout
- Output ONLY the labeled transcript with no preamble or explanation

Transcript:
`;

/**
 * Build the diarization prompt, optionally prepending a "Known participants"
 * hint so the LLM can use real names ([Alice], [Bob]) instead of generic
 * [Speaker N] labels when conversational context fits.
 *
 * The renderer parser already accepts arbitrary `[Name]` tags, so the LLM
 * is free to mix named and generic labels (e.g. when an unrecognized
 * speaker shows up alongside known participants).
 */
function buildDiarizationPrompt(participantNames: string[]): string {
  if (participantNames.length === 0) return DIARIZATION_PROMPT_BASE;
  const names = participantNames.join(', ');
  const hint = `Known participants: ${names}. When conversational context fits a known participant (their name is mentioned, they are addressed, or speaking style matches), label that paragraph with their name in brackets, e.g. [${participantNames[0]}]. For speakers you cannot match, fall back to [Speaker 1], [Speaker 2], etc.\n\n`;
  return hint + DIARIZATION_PROMPT_BASE;
}

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

  // Streaming-session state. Only used when streamingMode is true.
  private streamLoopPromise: Promise<void> | null = null;
  private totalDrainedAudioMs = 0;
  private currentSegmentStartMs = 0;
  private lastSpeechEndMs = 0;

  /**
   * Monotonic counter bumped on every mic-mute toggle. Private to the recorder
   * (not part of MeetingRecordingState — the renderer only sees `isMicMuted`).
   * The streaming loop reads it to detect mute transitions and drop any
   * in-flight Moonshine draft so post-unmute speech can never bond with
   * pre-mute content.
   */
  private muteGeneration = 0;

  /**
   * Total chunk windows that have elapsed in the legacy chunked path —
   * advances on every drain, including silent and muted chunks. Used as the
   * timing basis for segment start_ms so post-mute (or post-silence) segments
   * land at the correct point on the meeting timeline. `segmentCount` only
   * tracks emitted segments and is used for IDs.
   */
  private chunkIndex = 0;

  /**
   * Per-session online speaker clusterer. Allocated in startMeetingRecording
   * for `remoteCaptureMode` sessions only — mic-only meetings always label
   * the local user `'You'` and don't need diarization. `assign()` is NOT
   * called yet in M1 (no WeSpeaker model bundled); the lifecycle exists so
   * M2 can drop in the embedding model without restructuring the recorder.
   */
  private speakerClusterer: SpeakerClusterer | null = null;

  /**
   * In-memory copy of participant display names for the active meeting.
   * Updated by addContextParticipant / markContextParticipantLeft when the
   * room server processes joins and disconnects, plus seeded with the host
   * name at startMeetingRecording. Used per-chunk:
   *   • Whisper transcription: passed as `context_terms` so initial_prompt
   *     biases recognition toward attendee names.
   *   • Moonshine: passed to fuzzy post-correction so near-misses
   *     ("Aarrav" → "Aarav") are caught at finalize time.
   * Names are NOT removed when participants leave — they may have spoken
   * earlier in the same chunk window.
   */
  private contextTerms: string[] = [];

  private state: MeetingRecordingState = {
    status: 'idle',
    sessionId: null,
    startedAt: null,
    segmentCount: 0,
    deviceName: null,
    streamingMode: false,
    isMicMuted: false,
    engineSwapping: false,
    remoteCaptureMode: false,
    remoteCaptureLoopbackActive: false,
  };

  /**
   * Returns the term set used by transcript post-correction in this
   * meeting: dictionary words ∪ participant names. Reads the dictionary
   * cache lazily so live edits mid-meeting take effect on the next
   * finalized segment automatically.
   */
  private correctionTerms(): string[] {
    const dict = getDictionaryWords();
    if (dict.length === 0 && this.contextTerms.length === 0) return [];
    return [...this.contextTerms, ...dict];
  }

  /**
   * Add a participant's display name to the in-memory contextTerms. Called
   * by meeting-room-server.ts on `participant_joined`. Persisted-roster
   * write is the room server's responsibility, not the recorder's.
   */
  addContextParticipant(displayName: string): void {
    const trimmed = (displayName ?? '').trim();
    if (!trimmed) return;
    if (this.contextTerms.some(t => t.toLowerCase() === trimmed.toLowerCase())) return;
    this.contextTerms.push(trimmed);
  }

  /**
   * Symmetric to addContextParticipant. Intentionally does NOT remove the
   * name from contextTerms — a participant who left mid-meeting may still
   * appear in the next chunk if they spoke earlier in the buffer. Kept as
   * a hook in case future logic needs to react to disconnects.
   */
  markContextParticipantLeft(_participantId: string, _leftAt: number): void {
    /* intentionally no-op for biasing — see comment above */
  }

  isActive(): boolean {
    return this.state.status !== 'idle';
  }

  getState(): MeetingRecordingState {
    return { ...this.state };
  }

  /**
   * Handle a mid-meeting engine swap initiated by the renderer's
   * `swapMeetingEngineLive()`. The settings IPC has already called
   * `native.setTranscriptionEngine(newEngineKind)` BEFORE calling this, so
   * the active engine in the Rust addon is already the new one when we run.
   *
   * What this method does:
   *   1. Decides whether the NEW engine wants the streaming-session path
   *      (Moonshine + addon supports it) or the legacy chunked path
   *      (everything else — including all Whisper variants).
   *   2. If the mode is the SAME as the current one → no transition needed.
   *      Just push a fresh state event so the renderer's `streamingMode`
   *      mirror stays in sync (and the engine label is fresh).
   *   3. If the mode CHANGES:
   *        streaming → chunked  (Moonshine → Whisper):
   *          • Flip status flag so the streaming loop exits cleanly on its
   *            next tick. The loop's exit branch handles final drain +
   *            commit + native.stopRecording(), so we wait for that to
   *            finish before starting the chunk timer.
   *          • Reset Moonshine session state so any half-buffered audio is
   *            zeroed (privacy + no stale-content commit at meeting end).
   *          • Restart capture and start the fixed-interval chunk timer.
   *          • Reset chunkIndex bookkeeping so the first Whisper chunk
   *            lands at "now" rather than "0" — totalDrainedAudioMs already
   *            reflects the meeting's true elapsed time and we use it to
   *            initialize chunkIndex.
   *        chunked → streaming  (Whisper → Moonshine):
   *          • Cancel the chunk timer and wait for any in-flight
   *            processChunk() to settle.
   *          • Drain whatever is buffered (so partial Whisper-chunk audio
   *            doesn't leak into the Moonshine session as the first
   *            append) and discard.
   *          • Reset the Moonshine session, then start runStreamingSession
   *            in the background.
   *
   * Hard contract: never throws. Errors are logged + the recorder is left
   * in whatever consistent state is reachable; the worst case is the
   * meeting falls back to the chunked path (always-safe, always-works).
   *
   * Note on `state.streamingMode`: this is the SINGLE source of truth the
   * renderer uses for UI-mode branching (live grey-typing vs. chunk timer).
   * It must be updated atomically with the mode transition + immediately
   * pushed to renderer. Doing it after the transition completes (rather
   * than at the very start) means renderer briefly sees "old mode" during
   * the ~50 ms transition — that's fine and avoids a false "live" hint
   * before Moonshine is actually ready.
   */
  async handleEngineSwap(newEngineKind: string): Promise<void> {
    if (this.state.status !== 'recording') {
      // Not in a meeting (or already stopping) — nothing to do. The next
      // meeting start will read the active engine fresh.
      debugLog('meeting.engine-swap.noop', {
        status: this.state.status,
        engine: newEngineKind,
      });
      return;
    }

    // Remote-meeting capture forces the dual-stream chunked path; the
    // streaming session API can't drive two independent streams. The new
    // engine still gets activated for transcribe() calls inside
    // processChunkDual(), but we never transition to streamingMode. Push
    // a fresh state event so the renderer's engine label refreshes.
    if (this.state.remoteCaptureMode) {
      debugLog('meeting.engine-swap.dual-mode-noop', { engine: newEngineKind });
      this.pushStateToRenderer();
      return;
    }

    // Decide what mode the NEW engine should run in. Identical gate to
    // startMeetingRecording so behavior is consistent.
    const isMoonshine = newEngineKind.startsWith('moonshine');
    const canStream = isMoonshine
      && typeof native.addon.moonshineSessionAppend === 'function'
      && typeof native.addon.drainRecordingBuffer === 'function'
      && (native.addon.moonshineSessionSupports?.() ?? false);

    const wasStreaming = this.state.streamingMode;
    debugLog('meeting.engine-swap.begin', {
      from: wasStreaming ? 'streaming' : 'chunked',
      to: canStream ? 'streaming' : 'chunked',
      engine: newEngineKind,
    });

    if (wasStreaming === canStream) {
      // Same path; nothing structural to change. Push state so the
      // renderer can refresh anything keyed to the engine (e.g. a label).
      this.pushStateToRenderer();
      return;
    }

    // Mark swap in progress. status stays 'recording' so the renderer
    // keeps the live meeting UI mounted (no flicker back to meetings list).
    // The renderer reads engineSwapping to show a "Switching engine…"
    // spinner without unmounting.
    this.state = { ...this.state, engineSwapping: true };
    this.pushStateToRenderer();

    try {
      if (wasStreaming && !canStream) {
        // STREAMING → CHUNKED  (e.g. Moonshine → Whisper)
        // The streaming loop's `while (status==='recording' && !engineSwapping)`
        // gate trips on the next tick; its exit branch then runs final
        // drain + commit + stopRecording. So we just await it.
        if (this.streamLoopPromise) {
          try { await this.streamLoopPromise; } catch (err) {
            console.warn('[MeetingRecorder] streaming loop drain on swap failed:', err);
          }
          this.streamLoopPromise = null;
        }
        // Defensive: zero the Moonshine session so nothing leaks across.
        try { native.addon.moonshineSessionReset?.(); } catch { /* ignore */ }

        // The streaming-loop's exit branch already called stopRecording().
        // Restart capture for the new chunked path.
        try {
          if (this.state.deviceName && typeof native.addon.startRecordingFromDevice === 'function') {
            await native.addon.startRecordingFromDevice(this.state.deviceName);
          } else {
            native.addon.startRecording();
          }
        } catch (err) {
          console.error('[MeetingRecorder] failed to restart capture after engine swap:', err);
          // Fall through to status=idle so the user gets a clear "stopped"
          // state rather than a frozen recording UI.
          this.state = {
            ...this.state,
            status: 'idle',
            streamingMode: false,
            engineSwapping: false,
          };
          this.pushStateToRenderer();
          return;
        }

        // Align chunkIndex so the FIRST post-swap chunk lands at a sensible
        // start_ms (now), not at 0. totalDrainedAudioMs holds the cumulative
        // wall-clock-equivalent up to the swap; divide by the new chunk
        // interval and round up so the next chunk is "next slot".
        this.chunkIndex = Math.ceil(this.totalDrainedAudioMs / this.chunkIntervalMs);

        this.state = {
          ...this.state,
          streamingMode: false,
          engineSwapping: false,
        };
        this.pushStateToRenderer();

        // Start the chunk timer.
        this.chunkTimer = setInterval(() => {
          void this.processChunk();
        }, this.chunkIntervalMs);

        debugLog('meeting.engine-swap.done', { mode: 'chunked', engine: newEngineKind });
        return;
      }

      // CHUNKED → STREAMING  (e.g. Whisper → Moonshine)
      // Stop the chunk timer first so no new processChunk() fires.
      if (this.chunkTimer) {
        clearInterval(this.chunkTimer);
        this.chunkTimer = null;
      }
      // Wait for any in-flight chunk to settle. Up to 5 s — typical Whisper
      // chunk transcription is 1–3 s. We don't want to race with it.
      let waited = 0;
      while (this.isProcessingChunk && waited < 5_000) {
        await new Promise((r) => setTimeout(r, 100));
        waited += 100;
      }

      // Capture any buffered partial audio as a final Whisper segment
      // BEFORE swapping engines — otherwise text spoken between chunk
      // boundaries is lost. processChunk(true) drains via stopRecording()
      // and does NOT restart capture (we restart explicitly below).
      try {
        await this.processChunk(true /* isFinal */);
      } catch (err) {
        console.warn('[MeetingRecorder] partial-chunk flush on swap failed:', err);
        // Fall back to drain-discard so we don't leak audio into the
        // Moonshine session below.
        try { native.addon.stopRecording(); } catch { /* expected if already stopped */ }
      }

      try {
        if (this.state.deviceName && typeof native.addon.startRecordingFromDevice === 'function') {
          await native.addon.startRecordingFromDevice(this.state.deviceName);
        } else {
          native.addon.startRecording();
        }
      } catch (err) {
        console.error('[MeetingRecorder] failed to restart capture for streaming swap:', err);
        this.state = {
          ...this.state,
          status: 'idle',
          streamingMode: false,
          engineSwapping: false,
        };
        this.pushStateToRenderer();
        return;
      }

      try { native.addon.moonshineSessionReset?.(); } catch { /* defensive */ }

      this.state = {
        ...this.state,
        streamingMode: true,
        engineSwapping: false,
      };
      this.pushStateToRenderer();

      this.streamLoopPromise = this.runStreamingSession().catch((err) => {
        console.error('[MeetingRecorder] streaming loop crashed after swap:', err);
        this.pushDraftToRenderer('');
        try { native.addon.moonshineSessionReset?.(); } catch { /* ignore */ }
      });

      debugLog('meeting.engine-swap.done', { mode: 'streaming', engine: newEngineKind });
    } catch (err) {
      // Anything that escaped the inner branches — make sure we don't
      // leave engineSwapping=true forever, which would freeze the renderer
      // spinner.
      console.error('[MeetingRecorder] handleEngineSwap unexpected failure:', err);
      this.state = { ...this.state, engineSwapping: false };
      this.pushStateToRenderer();
    }
  }

  /**
   * Read-only accessor used by meeting-room-server / meeting-room-client to
   * gate outbound segment broadcast on self-mute (defense-in-depth — the
   * audio gate inside the recorder already prevents most muted segments
   * from being produced in the first place).
   */
  isMicMuted(): boolean {
    return this.state.isMicMuted;
  }

  /**
   * Toggle mic mute during an active meeting. Sourced from the renderer via
   * MEETING_SET_MIC_MUTED. Validated against the active session id so a
   * stale renderer event from a previous meeting can't flip the wrong run.
   *
   * Mute is a hard privacy boundary:
   *   • Discards drained audio at the recorder level (no STT, no segment).
   *   • Resets any in-flight Moonshine session/draft so post-unmute speech
   *     cannot bond with pre-mute content (drop, never commit).
   *   • Skips the final-drain commit on stop while muted.
   *   • Suppresses outbound segment broadcast on the room layer (gated by
   *     room-server / room-client reading isMicMuted()).
   */
  setMicMuted(sessionId: string, muted: boolean): void {
    if (this.state.status === 'idle') {
      throw new Error('Cannot set mic mute — meeting not active');
    }
    if (sessionId !== this.state.sessionId) {
      throw new Error('Mic mute session mismatch — refusing stale toggle');
    }
    if (this.state.isMicMuted === muted) return;
    this.state = { ...this.state, isMicMuted: muted };
    // Bumping the generation is what tells the streaming loop to drop any
    // in-flight draft on the next tick. Bump on every transition (both
    // mute-on and mute-off) so a quick toggle still triggers a clean reset.
    this.muteGeneration++;
    debugLog('meeting.mute', { sessionId, muted, generation: this.muteGeneration });
    this.pushStateToRenderer();
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
   * @param hostDisplayName Optional host display name. Seeds the persisted
   *                   roster and contextTerms (Whisper bias + fuzzy
   *                   correction). Read from `roomDisplayName` in Zustand
   *                   at the call site since the recorder lives in main.
   */
  async startMeetingRecording(
    sessionId: string,
    deviceName?: string | null,
    chunkIntervalS = 15,
    hostDisplayName?: string | null,
    /**
     * Remote-meeting capture options. When present, the recorder runs the
     * dual-stream pipeline (mic + WASAPI loopback) and forces the chunked
     * path. `loopbackDevice` is forwarded to the native engine — typically
     * 'system_default' so loopback follows the user's default speakers.
     * Pass `null` (or omit) for the legacy single-stream behavior.
     */
    remoteCaptureOpts?: { loopbackDevice: string } | null,
  ): Promise<void> {
    if (this.state.status !== 'idle') {
      throw new Error('Meeting recording is already active');
    }

    // Moonshine cap: the model is trained for ≤30 s utterances and produces
    // truncated transcripts on longer chunks. If the active engine is a
    // Moonshine variant, clamp the chunk interval to 25 s so the user gets
    // a clear behavior (rather than mysteriously cut-off transcripts) and
    // log a warning when the cap kicks in. Whisper engines have no such
    // limit and use the user's full configured interval.
    let effectiveChunkIntervalS = chunkIntervalS;
    try {
      const activeEngine = native.getTranscriptionEngine?.() ?? '';
      if (activeEngine.startsWith('moonshine-') && chunkIntervalS > 25) {
        debugLog('engine.chunk-clamp', {
          requestedSec: chunkIntervalS,
          clampedSec: 25,
          engine: activeEngine,
          reason: 'moonshine-30s-training-window',
        });
        console.warn(
          `[MeetingRecorder] Moonshine engine active — clamping chunk_interval_s ` +
            `from ${chunkIntervalS}s to 25s. Switch to a Whisper engine in ` +
            `Settings → Audio → Transcription Engine for longer chunks.`,
        );
        effectiveChunkIntervalS = 25;
      }
    } catch {
      // getTranscriptionEngine missing on older Rust addon — skip the clamp.
    }
    // Remote-meeting capture: STT cost roughly doubles (mic + loopback both
    // hit Whisper). Floor the interval at 30 s so two-way conversation stays
    // ahead of the chunk loop on CPU-bound Windows boxes. Users can still
    // raise it; we only push it up.
    if (remoteCaptureOpts && effectiveChunkIntervalS < 30) {
      debugLog('remote-capture.chunk-clamp', {
        requestedSec: effectiveChunkIntervalS,
        clampedSec: 30,
        reason: 'dual-stream-stt-cost',
      });
      console.info(
        `[MeetingRecorder] Remote-meeting capture: clamping chunk_interval_s ` +
          `from ${effectiveChunkIntervalS}s to 30s (dual-stream STT cost).`,
      );
      effectiveChunkIntervalS = 30;
    }
    this.chunkIntervalMs = effectiveChunkIntervalS * 1000;
    this.segments = [];

    // Reset streaming-session state so a previous meeting's leftover values
    // can't leak into this one (the manager is a singleton).
    this.streamLoopPromise = null;
    this.totalDrainedAudioMs = 0;
    this.currentSegmentStartMs = 0;
    this.lastSpeechEndMs = 0;
    this.muteGeneration = 0;
    this.chunkIndex = 0;

    // Seed the participant context with the host's display name (if set)
    // and persist an initial roster row. Joiners are appended later by
    // meeting-room-server.ts; the recorder owns only the in-memory cache.
    this.contextTerms = [];
    const trimmedHost = (hostDisplayName ?? '').trim();
    if (trimmedHost) {
      this.contextTerms.push(trimmedHost);
      try {
        const roster = [{
          id: 'host',
          displayName: trimmedHost,
          isHost: true,
          joinedAt: Date.now(),
        }];
        native.setMeetingParticipants(sessionId, JSON.stringify(roster));
      } catch (err) {
        console.warn('[MeetingRecorder] failed to seed participant roster:', err);
      }
    }

    // Drift safety net: re-push the persisted dictionary into the active
    // engine so words added mid-app-session take effect for this meeting.
    // The Rust addon already syncs on every addWord/removeWord, so this is
    // belt-and-suspenders. Cheap.
    try { native.refreshTranscriptionDictionary(); } catch { /* ignore */ }

    // ── Decide path: streaming session vs. fixed-interval chunks ──
    // Mirrors the full 4-check gate in dictation-streamer.ts: engine must be
    // a Moonshine variant AND the addon must expose session_append, drain
    // buffer, and session_supports() must return true. Anything else falls
    // back to the legacy chunked path (Whisper has no session API).
    const engineKind = (() => {
      try { return native.getTranscriptionEngine?.() ?? ''; }
      catch { return ''; }
    })();
    const isMoonshine = engineKind.startsWith('moonshine');
    const wantsRemoteCapture = !!remoteCaptureOpts;
    // Remote-meeting capture forces the chunked dual-stream path. Streaming
    // would require two independent Moonshine sessions; defer to v1.1.
    const canStream = !wantsRemoteCapture
      && isMoonshine
      && typeof native.addon.moonshineSessionAppend === 'function'
      && typeof native.addon.drainRecordingBuffer === 'function'
      && (native.addon.moonshineSessionSupports?.() ?? false);

    debugLog('meeting.start', { engine: engineKind, isMoonshine, canStream, remoteCapture: wantsRemoteCapture });

    // Claim the audio stream before starting capture.
    audioStream.acquire('meeting');
    let loopbackActive = false;
    try {
      if (wantsRemoteCapture && native.meetingDualSupported()) {
        // Dual-stream path: mic + WASAPI loopback, drained by processChunkDual().
        const mode = remoteCaptureOpts!.loopbackDevice || 'system_default';
        native.startMeetingRecordingDual(deviceName ?? null, mode);
        // The dual engine may have failed to open loopback (non-Windows,
        // exclusive-mode endpoint, etc.) and silently continued with mic only.
        // Probe the engine to know which way the recorder should behave.
        loopbackActive = native.meetingHasLoopback();
        debugLog('capture.start.dual', {
          owner: 'meeting',
          deviceName: deviceName ?? null,
          loopbackMode: mode,
          loopbackActive,
        });
      } else if (deviceName && typeof native.addon.startRecordingFromDevice === 'function') {
        await native.addon.startRecordingFromDevice(deviceName);
        debugLog('capture.start', { owner: 'meeting', deviceName, success: true });
      } else {
        // Works with default mic and BlackHole (via OS aggregate device)
        native.addon.startRecording();
        debugLog('capture.start', { owner: 'meeting', deviceName: null, success: true });
      }
    } catch (err: any) {
      debugLog('capture.start', { owner: 'meeting', deviceName: deviceName ?? null, success: false, error: err?.message ?? String(err), remoteCapture: wantsRemoteCapture });
      audioStream.release('meeting');
      throw err;
    }

    const now = Date.now();
    this.state = {
      status: 'recording',
      sessionId,
      startedAt: now,
      segmentCount: 0,
      deviceName: deviceName ?? null,
      streamingMode: canStream,
      isMicMuted: false,
      engineSwapping: false,
      remoteCaptureMode: wantsRemoteCapture,
      remoteCaptureLoopbackActive: loopbackActive,
    };

    this.pushStateToRenderer();

    // Allocate the per-session speaker clusterer for remote-capture meetings.
    // M1 only confirms lifecycle (created here, dropped in stop's finally);
    // M2.3 will start calling assign() inline in processChunkDual once the
    // WeSpeaker embedder is wired up.
    if (wantsRemoteCapture) {
      this.speakerClusterer = new SpeakerClusterer();
    } else {
      this.speakerClusterer = null;
    }

    if (canStream) {
      // Streaming path — the loop owns audio drain, session append, draft
      // emission, silence/cap commits, and final drain on stop.
      try { native.addon.moonshineSessionReset?.(); } catch { /* defensive */ }
      this.streamLoopPromise = this.runStreamingSession().catch(err => {
        console.error('[MeetingRecorder] streaming loop crashed:', err);
        debugLog('meeting.stream.error', { error: String(err) });
        // Clear the grey line so it doesn't get stuck on screen.
        this.pushDraftToRenderer('');
        // Zero the Moonshine session buffer so the next session starts clean.
        try { native.addon.moonshineSessionReset?.(); } catch { /* ignore */ }
        // Resolve, never re-throw — stopMeetingRecording awaits this promise.
      });
    } else {
      // Chunked path — fixed-interval setInterval. The dual-stream path uses
      // processChunkDual() (drain mic + loopback, no stop/restart gap); the
      // single-stream legacy path uses processChunk() with the stop/restart
      // pattern.
      this.chunkTimer = setInterval(() => {
        if (this.state.remoteCaptureMode) {
          void this.processChunkDual();
        } else {
          void this.processChunk();
        }
      }, this.chunkIntervalMs);
    }
  }

  /**
   * Stop meeting recording, flush the last chunk, run LLM diarization,
   * and return the assembled full transcript + segments.
   */
  async stopMeetingRecording(): Promise<{ fullTranscript: string; segments: TranscriptSegment[] }> {
    if (this.state.status === 'idle') {
      throw new Error('Meeting recording is not active');
    }

    const wasStreaming = this.state.streamingMode;
    this.state = { ...this.state, status: 'stopping' };
    this.pushStateToRenderer();

    // Stop the chunk timer so no new chunks start (legacy path only)
    if (this.chunkTimer) {
      clearInterval(this.chunkTimer);
      this.chunkTimer = null;
    }

    // Wrap the rest in try/finally so state ALWAYS returns to 'idle', even
    // if the final chunk transcription, diarization, or LLM call throws.
    // Otherwise the recorder would be stuck in 'stopping' and block future
    // recordings with "already active".
    try {
      if (wasStreaming) {
        // Streaming path: the loop watches `state.status` and will perform
        // its own final drain + commit when it sees 'stopping'. Just await
        // its promise — do NOT call processChunk(true), it would race the
        // loop and double-call stopRecording mid-Moonshine-commit.
        if (this.streamLoopPromise) {
          try {
            await this.streamLoopPromise;
          } catch (err) {
            console.error('[MeetingRecorder] streaming loop final await failed:', err);
          }
          this.streamLoopPromise = null;
        }
        // Defensive: zero the session buffer in case the loop's own reset
        // didn't run (e.g. if it threw before the final commit).
        try { native.addon.moonshineSessionReset?.(); } catch { /* ignore */ }
      } else {
        // Chunked path (single-stream legacy or dual-stream remote capture).
        // Wait for any in-flight chunk to complete before processing the final one.
        let waited = 0;
        while (this.isProcessingChunk && waited < 10_000) {
          await new Promise(r => setTimeout(r, 100));
          waited += 100;
        }

        try {
          if (this.state.remoteCaptureMode) {
            await this.processChunkDual(true /* isFinal */);
          } else {
            await this.processChunk(true /* isFinal */);
          }
        } catch (err) {
          console.error('[MeetingRecorder] Final chunk failed:', err);
        }
      }

      // Assemble the full transcript from in-memory segments
      const fullTranscript = this.segments
        .sort((a, b) => a.start_ms - b.start_ms)
        .map(s => s.text)
        .join('\n\n');

      const finalSegments = [...this.segments];

      // ── Stop-of-meeting diarization pipeline ────────────────────────────
      //
      // Strict order (M2.4):
      //   1. Final chunk drain (already done above via processChunkDual(true))
      //   2. AHC refinement on the persisted loopback embeddings
      //      (DB-canonical — survives drift)
      //   3. Optional LLM roster-rename pass (gated by
      //      `meeting_llm_name_pass_enabled`, default off)
      //   4. Single `MEETING_SEGMENTS_RELABELED` emission covering both
      //
      // Two legacy diarization triggers are preserved for paths that
      // don't go through the embedding pipeline (multi-user rooms, or
      // remote-capture meetings where the model is unavailable so
      // segments came out unlabeled):
      //   • participant_id > 1 — multi-user room mode.
      //   • loopback segments with `speaker_label = null` — embedding
      //     was skipped (no model, Moonshine engine, low confidence,
      //     under min_slice_ms duration). Fall back to legacy text-LLM
      //     diarization which is better than nothing.
      const sessionIdForDiarize = this.state.sessionId;
      const segmentsSnapshot = finalSegments;

      // Pipeline step 2 + 3 + 4. Fire-and-forget so the caller of
      // stopMeetingRecording isn't blocked on LLM latency. The async
      // closure captures `segmentsSnapshot` explicitly so a follow-up
      // session can't corrupt the in-flight refinement.
      if (sessionIdForDiarize) {
        const hasEmbedding = segmentsSnapshot.some(
          s => s.source === 'loopback' && s.speaker_label, // M2.3 labeled
        );
        const hasUnlabeledLoopback = segmentsSnapshot.some(
          s => s.source === 'loopback' && !s.speaker_label,
        );
        const uniqueParticipants = new Set(
          segmentsSnapshot.map(s => s.participant_id || 'local'),
        );

        void (async () => {
          try {
            // Step 2: AHC refinement (no-op if no embeddings exist).
            const ahcPatches = await this.refineLoopbackSpeakers(
              sessionIdForDiarize,
              segmentsSnapshot,
            );

            // Step 3: optional LLM roster-rename.
            const llmPatches = await this.runLlmRosterRename(
              sessionIdForDiarize,
              segmentsSnapshot,
            );

            // Step 3-fallback: legacy text-LLM diarization for paths
            // where the embedding pipeline never ran. Triggered when
            // no AHC patches landed AND we have unlabeled loopback or
            // multi-user data that still needs speaker discrimination.
            //
            // v1.9.1: Simple-mode (`meeting_diarization_mode === 'off'`)
            // remote-capture meetings explicitly opt out of all speaker
            // labeling — keep loopback rows as "Remote" through the end.
            // The legacy fallback is reserved for Advanced-mode meetings
            // where some embedding rows failed, and for multi-user room
            // meetings (which don't touch the diarization mode setting).
            const ranEmbeddingPath = hasEmbedding || ahcPatches.length > 0;
            const simpleModeLoopbackOnly =
              readDiarizationMode() === 'off'
              && uniqueParticipants.size <= 1
              && hasUnlabeledLoopback;
            const needsLegacy =
              !ranEmbeddingPath
              && !simpleModeLoopbackOnly
              && fullTranscript.length >= 400
              && segmentsSnapshot.length > 1
              && (uniqueParticipants.size > 1 || hasUnlabeledLoopback);
            if (needsLegacy) {
              try {
                const labeled = await this.runDiarization(fullTranscript);
                if (labeled) {
                  this.applyDiarizationLabels(labeled, segmentsSnapshot);
                }
              } catch (err) {
                console.error('[MeetingRecorder] Legacy LLM diarization failed:', err);
              }
            }

            // Step 4: single emission. Merge patches by segmentId,
            // last-write-wins, so LLM-rename overrides AHC when both
            // touched the same segment.
            const byId = new Map<string, string>();
            for (const p of ahcPatches) byId.set(p.segmentId, p.newLabel);
            for (const p of llmPatches) byId.set(p.segmentId, p.newLabel);
            const merged = Array.from(byId, ([segmentId, newLabel]) => ({
              segmentId,
              newLabel,
            }));
            this.pushSegmentsRelabeledToRenderer(sessionIdForDiarize, merged);
          } catch (err) {
            console.error('[MeetingRecorder] Stop-of-meeting diarization pipeline failed:', err);
          }
        })();
      }

      return { fullTranscript, segments: finalSegments };
    } finally {
      // Belt-and-braces: make sure the native recorder is stopped even if we
      // never reached the restart branch in processChunk. Ignore errors —
      // both stop calls throw if no stream is active.
      if (this.state.remoteCaptureMode) {
        try { native.stopMeetingRecordingDual(); } catch { /* expected if final chunk already stopped */ }
        try { native.resetMeetingRecordingDual(); } catch { /* ignore */ }
      } else {
        try { native.addon.stopRecording(); } catch { /* expected if already stopped */ }
      }
      audioStream.release('meeting');
      this.state = {
        status: 'idle',
        sessionId: null,
        startedAt: null,
        segmentCount: 0,
        deviceName: null,
        streamingMode: false,
        isMicMuted: false,
        engineSwapping: false,
        remoteCaptureMode: false,
        remoteCaptureLoopbackActive: false,
      };
      // Reset streaming-session bookkeeping so a stop-without-start path or
      // an exception still leaves the manager in a clean state.
      this.streamLoopPromise = null;
      this.totalDrainedAudioMs = 0;
      this.currentSegmentStartMs = 0;
      this.lastSpeechEndMs = 0;
      this.muteGeneration = 0;
      this.chunkIndex = 0;
      // Drop the per-session speaker clusterer — its in-memory centroids
      // are session-local and never persist across meetings.
      this.speakerClusterer = null;
      // Make sure the grey line is cleared on stop, in case the streaming
      // loop's catch handler didn't run.
      this.pushDraftToRenderer('');
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
      // Use a wall-clock chunk index that advances on EVERY chunk window —
      // including silent and muted chunks — so segment.start_ms reflects when
      // speech actually happened relative to meeting start. Segment IDs and
      // the emitted-segments count remain on `segmentCount`, untouched here.
      const currentChunkIndex = this.chunkIndex;
      this.chunkIndex++;
      const chunkStartMs = currentChunkIndex * this.chunkIntervalMs;
      const chunkEndMs = isFinal
        ? Date.now() - startedAt
        : chunkStartMs + this.chunkIntervalMs;

      // Drain the buffer by stopping the stream
      let audioBuffer: Buffer;
      try {
        audioBuffer = native.addon.stopRecording();
        debugLog('capture.drained', {
          owner: 'meeting',
          chunkIndex: currentChunkIndex,
          byteLength: audioBuffer.length,
          rms: computeRmsPcm16(audioBuffer),
          isFinal,
        });
      } catch (err: any) {
        console.warn('[MeetingRecorder] Failed to stop for chunk drain:', err);
        debugLog('capture.drained', { owner: 'meeting', chunkIndex: currentChunkIndex, isFinal, error: err?.message ?? String(err) });
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

      // ── Mic-muted gate (privacy: no STT, no segment, no broadcast) ──
      // Drained audio is dropped on the floor. We've already restarted
      // capture above, so the next chunk window will be ready as normal.
      // chunkIndex has already advanced, so post-unmute segments will land
      // at the correct meeting timestamp.
      if (this.state.isMicMuted) {
        debugLog('meeting.chunk.muted', { chunkIndex: currentChunkIndex, byteLength: audioBuffer.length, isFinal });
        return;
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
      const whisperStart = Date.now();
      const engineKind = (() => {
        try { return native.getTranscriptionEngine?.() ?? 'unknown'; }
        catch { return 'unknown'; }
      })();
      debugLog('whisper.in', { engine: engineKind, owner: 'meeting', chunkIndex: currentChunkIndex, byteLength: audioBuffer.length, durationSec: audioBuffer.length / 2 / 16000 });
      let rawText: string | null = null;
      try {
        // Pass participant names + dictionary words as per-call context.
        // Whisper layers them onto initial_prompt; Moonshine ignores them
        // (the fuzzy correction below catches near-misses for Moonshine).
        rawText = await transcribeWithTimeout(
          native.transcribeWithContext(audioBuffer, this.contextTerms),
          TRANSCRIBE_TIMEOUT_MS,
          'MeetingRecorder.transcribe',
        );
        debugLog('whisper.raw', { engine: engineKind, owner: 'meeting', chunkIndex: currentChunkIndex, rawText: rawText ?? '<null/timeout>', length: rawText?.length ?? 0, latencyMs: Date.now() - whisperStart, contextTerms: this.contextTerms.length });
      } catch (err: any) {
        debugLog('whisper.error', { engine: engineKind, owner: 'meeting', chunkIndex: currentChunkIndex, message: err?.message ?? String(err), latencyMs: Date.now() - whisperStart });
        throw err;
      }
      if (rawText == null) return;

      // ── Text hygiene ──
      // Strip bracket markers, collapse repetition loops, drop exact-match
      // hallucinations. Keeps junk out of the transcript AND the AI notes.
      let text = sanitizeTranscribedText(rawText);
      if (!text) return;

      // Fuzzy post-correction. Catches near-misses for participant names
      // and custom dictionary words — especially important for Moonshine,
      // which has no vocabulary API. Whisper's initial_prompt already
      // biases sampling but isn't 100% so we run this for both engines.
      // Empty term set = early return inside the helper, no overhead.
      const terms = this.correctionTerms();
      if (terms.length > 0) {
        text = correctTranscript(text, terms);
      }

      // Build the segment object and store in memory. New local recordings
      // always write source = 'mic' (never the legacy 'meeting' value); the
      // diarization gate downstream checks source/speaker_label, not the
      // legacy value. See CLAUDE.md "Source semantics".
      const segment: TranscriptSegment = {
        id: `seg-${Date.now()}-${segmentCount}`,
        session_id: sessionId,
        speaker_label: null, // assigned post-meeting by LLM diarization
        start_ms: chunkStartMs,
        end_ms: chunkEndMs,
        text,
        source: 'mic',
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
            'mic',
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
   * Dual-stream chunk: drain mic + loopback in one no-gap call, transcribe
   * each independently, and emit two source-tagged segments.
   *
   * Backpressure rules (worst-case STT cost ~doubles):
   *  • Serialized through `isProcessingChunk` — never run two passes of
   *    this method (or processChunk) concurrently.
   *  • RMS-gated per stream so a silent half doesn't pay the Whisper cost.
   *  • Each stream's transcribe call is awaited sequentially against the
   *    SAME Whisper engine — running them in parallel would race on the
   *    model lock.
   *  • Chunk interval is clamped to >= 30 s for remote-capture meetings
   *    in startMeetingRecording (callers pass interval directly; we
   *    re-clamp here as a safety net).
   */
  private async processChunkDual(isFinal = false): Promise<void> {
    if (this.isProcessingChunk && !isFinal) {
      console.warn('[MeetingRecorder] Dual chunk still processing, skipping tick');
      return;
    }

    const { sessionId, startedAt, segmentCount } = this.state;
    if (!sessionId || !startedAt) return;

    this.isProcessingChunk = true;

    // Drained dual-stream buffers are zeroed in the outer finally regardless
    // of how the chunk exits — mute, silent, Whisper error, empty text, or
    // an exception bubbling up. CapturedAudio::drop in Rust already zeros
    // the f32 vec at conversion time, but the resulting JS Buffer survives
    // until GC; this finally closes that gap.
    let drained: { mic: Buffer; loopback: Buffer | null; loopbackActive: boolean } | null = null;

    try {
      const currentChunkIndex = this.chunkIndex;
      this.chunkIndex++;
      const chunkStartMs = currentChunkIndex * this.chunkIntervalMs;
      const chunkEndMs = isFinal
        ? Date.now() - startedAt
        : chunkStartMs + this.chunkIntervalMs;

      try {
        drained = isFinal
          ? native.stopMeetingRecordingDual()
          : native.drainMeetingBuffers();
      } catch (err: any) {
        console.warn('[MeetingRecorder] Failed to drain dual buffers:', err);
        debugLog('capture.drained.dual', {
          owner: 'meeting',
          chunkIndex: currentChunkIndex,
          isFinal,
          error: err?.message ?? String(err),
        });
        return;
      }

      debugLog('capture.drained.dual', {
        owner: 'meeting',
        chunkIndex: currentChunkIndex,
        micBytes: drained.mic.length,
        loopbackBytes: drained.loopback?.length ?? 0,
        loopbackActive: drained.loopbackActive,
        isFinal,
      });

      // Mute gate: drop both buffers entirely (no STT, no segment, no broadcast).
      if (this.state.isMicMuted) {
        debugLog('meeting.chunk.muted', { chunkIndex: currentChunkIndex, isFinal });
        return;
      }

      const engineKind = (() => {
        try { return native.getTranscriptionEngine?.() ?? 'unknown'; }
        catch { return 'unknown'; }
      })();

      // Mic side stays one row per chunk — local user is always labeled
      // "You", no diarization concern.
      await this.transcribeAndPersistDual(
        sessionId, segmentCount, currentChunkIndex, chunkStartMs, chunkEndMs,
        drained.mic, 'mic', 'You', engineKind,
      );

      // Loopback path: two modes, gated by `meeting_diarization_mode`.
      //
      //   • Simple ('off', the default): one segment per chunk, identical to
      //     the mic path. `speaker_label = null` → renderer shows "Remote".
      //     No embedding, no clustering, no AHC refinement. Latency matches
      //     the mic side.
      //
      //   • Advanced ('embedding'): per-Whisper-segment rows with inline
      //     speaker embedding + clustering, AHC refinement at stop. Slower
      //     (multi-segment Whisper + N×WeSpeaker per chunk) but produces
      //     [Speaker N] labels for distinguishing remote voices.
      //
      // The diarization-mode read is intentionally per-tick so a user toggle
      // mid-meeting takes effect on the next chunk without restart.
      if (drained.loopback && drained.loopback.length > 0) {
        const useEmbeddingDiarization =
          this.speakerClusterer !== null
          && readDiarizationMode() === 'embedding'
          && engineKind.startsWith('whisper-');

        if (useEmbeddingDiarization) {
          await this.transcribeAndPersistLoopbackSegments(
            sessionId, currentChunkIndex, chunkStartMs, chunkEndMs,
            drained.loopback, engineKind,
          );
        } else {
          // Simple-mode fast path: same shape as the mic call above.
          await this.transcribeAndPersistDual(
            sessionId, segmentCount, currentChunkIndex, chunkStartMs, chunkEndMs,
            drained.loopback, 'loopback', null, engineKind,
          );
        }
      }
    } finally {
      this.isProcessingChunk = false;
      // Last thing in the chunk lifecycle: wipe both drained buffers
      // unconditionally. Tested directly via the exported
      // `zeroDrainedBuffersFinally` helper.
      zeroDrainedBuffersFinally(drained);
    }
  }

  /**
   * Loopback-only variant of transcribeAndPersistDual: runs
   * `transcribeWithSegments` so each Whisper-detected utterance lands as
   * its own `transcript_segments` row. `start_ms` / `end_ms` are offsets
   * into the chunk window plus the chunk's start; the M2 speaker-embedding
   * pass uses these to slice the chunk PCM per utterance for embedding.
   *
   * In M1 every persisted segment still has `speaker_label = null` (UI
   * shows "Remote") — M2.3 fills it inline before `pushSegmentToRenderer`.
   */
  private async transcribeAndPersistLoopbackSegments(
    sessionId: string,
    chunkIndex: number,
    chunkStartMs: number,
    chunkEndMs: number,
    audioBuffer: Buffer,
    engineKind: string,
  ): Promise<void> {
    if (audioBuffer.length === 0) return;
    if (isAudioSilent(audioBuffer)) return;

    const whisperStart = Date.now();
    debugLog('whisper.in', {
      engine: engineKind, owner: 'meeting', source: 'loopback', chunkIndex,
      byteLength: audioBuffer.length, durationSec: audioBuffer.length / 2 / 16000,
      mode: 'segments',
    });

    let dtos: Awaited<ReturnType<typeof native.transcribeWithSegments>> = [];
    try {
      dtos = await transcribeWithTimeout(
        native.transcribeWithSegments(audioBuffer, this.contextTerms),
        TRANSCRIBE_TIMEOUT_MS,
        'MeetingRecorder.transcribe.loopback',
      ) ?? [];
      debugLog('whisper.raw', {
        engine: engineKind, owner: 'meeting', source: 'loopback', chunkIndex,
        segmentCount: dtos.length,
        latencyMs: Date.now() - whisperStart,
      });
    } catch (err: any) {
      debugLog('whisper.error', {
        engine: engineKind, owner: 'meeting', source: 'loopback', chunkIndex,
        message: err?.message ?? String(err),
        latencyMs: Date.now() - whisperStart,
      });
      return;
    }

    if (dtos.length === 0) return;

    const terms = this.correctionTerms();
    const chunkSpan = Math.max(1, chunkEndMs - chunkStartMs);

    // ── Diarization gates (read once per chunk) ─────────────────────────────
    //
    // Embedding-based diarization is gated by THREE conditions:
    //   1. The `speakerClusterer` instance exists (set on remote-capture start)
    //   2. `meeting_diarization_mode === 'embedding'`
    //   3. The active transcription engine is Whisper-family — Moonshine's
    //      `transcribe_with_segments` falls back to one segment spanning the
    //      whole chunk, which would give chunk-level diarization (useless).
    // Any miss → segments persist with `speaker_label = null`, UI shows
    // "Remote", and AHC at stop has nothing to refine.
    const diarizeMode = (() => {
      try { return native.getSetting('meeting_diarization_mode') ?? 'off'; }
      catch { return 'off'; }
    })();
    const isWhisperEngine = engineKind.startsWith('whisper-');
    const diarizationEnabled =
      this.speakerClusterer !== null
      && diarizeMode === 'embedding'
      && isWhisperEngine;

    // Slice-length guardrails (in milliseconds). Reading once keeps per-tick
    // cost down; the defaults match `migrate_v15` seeds.
    const minSliceMs = diarizationEnabled
      ? Math.max(100, Number(native.getSetting('meeting_diarization_min_slice_ms') ?? '800') || 800)
      : 0;
    const maxSliceMs = diarizationEnabled
      ? Math.max(minSliceMs, Number(native.getSetting('meeting_diarization_max_slice_ms') ?? '6000') || 6000)
      : 0;

    // Process segments in start_ms order so any Buffer.subarray slice
    // zeroing we do can't clobber a later un-embedded segment. dtos are
    // already in time order from whisper-rs's segment iterator; sort
    // defensively in case a future engine breaks that contract.
    const sortedDtos = [...dtos].sort((a, b) => a.start_ms - b.start_ms);

    for (const dto of sortedDtos) {
      const raw = (dto.text ?? '').toString();
      if (!raw) continue;
      let text = sanitizeTranscribedText(raw);
      if (!text) continue;
      if (terms.length > 0) text = correctTranscript(text, terms);

      // Clamp the DTO's per-clip offsets into the chunk's absolute window.
      const segStart = chunkStartMs + Math.max(0, Math.min(chunkSpan, dto.start_ms));
      const segEnd = chunkStartMs + Math.max(segStart - chunkStartMs, Math.min(chunkSpan, dto.end_ms));

      // ── Diarization: embed → cluster → final label ─────────────────────
      //
      // Discipline: compute the final label (or `null`) BEFORE the first
      // renderer push. The renderer's segment list appends blindly — if we
      // pushed an unlabeled segment first and a labeled one later, the UI
      // would render two rows. `MEETING_SEGMENTS_RELABELED` is reserved for
      // post-stop AHC patches only.
      let finalLabel: string | null = null;
      let embeddingBytes: Buffer | null = null;
      let diarConfidence: number | null = null;

      if (diarizationEnabled && text.split(/\s+/).filter(Boolean).length >= 2) {
        // Reject segments with high `no_speech_prob` when available
        // (whisper-rs 0.13 currently returns null, so this is a forward-
        // compat guard for when the API surfaces it).
        const passesNoSpeechGate =
          dto.no_speech_prob == null || dto.no_speech_prob < 0.6;

        if (passesNoSpeechGate) {
          // Convert ms → PCM16-byte offsets. PCM16 mono at 16 kHz =
          // 32 bytes/ms (16000 samples × 2 bytes ÷ 1000 ms).
          const BYTES_PER_MS = 32;
          let sliceStartMs = Math.max(0, dto.start_ms);
          let sliceEndMs = Math.max(sliceStartMs, Math.min(chunkSpan, dto.end_ms));
          const durMs = sliceEndMs - sliceStartMs;

          if (durMs < minSliceMs) {
            // Too short to embed reliably — skip diarization, keep transcript.
          } else {
            // Long-segment guardrail: use the middle 3 s. Anything beyond
            // ~6 s on a single speaker is rare; longer windows risk
            // straddling speaker boundaries.
            if (durMs > maxSliceMs) {
              const center = (sliceStartMs + sliceEndMs) / 2;
              sliceStartMs = Math.max(0, Math.round(center - 1500));
              sliceEndMs = Math.min(chunkSpan, Math.round(center + 1500));
            }

            const byteStart = Math.min(audioBuffer.length, sliceStartMs * BYTES_PER_MS);
            const byteEnd = Math.min(audioBuffer.length, sliceEndMs * BYTES_PER_MS);
            // Buffer.subarray shares memory with the parent — zeroing the
            // slice mutates the parent's range. That's safe here because
            // dtos are processed in start_ms order with no overlap.
            const slice = audioBuffer.subarray(byteStart, byteEnd);

            if (slice.length > 0 && !isAudioSilent(slice)) {
              try {
                const emb = await native.embedSpeaker(slice);
                if (emb.length === SPEAKER_EMBED_FLOATS) {
                  const result = this.speakerClusterer!.assign(emb);
                  finalLabel = result.label;
                  diarConfidence = result.confidence;
                  // Pack the embedding back to LE bytes for DB persistence.
                  const buf = Buffer.alloc(emb.length * 4);
                  for (let i = 0; i < emb.length; i++) {
                    buf.writeFloatLE(emb[i], i * 4);
                  }
                  embeddingBytes = buf;
                } else if (emb.length === 0) {
                  // Speaker module unavailable (model missing / feature
                  // not compiled). Fall through with null label.
                  debugLog('diarize.unavailable', { chunkIndex, segStart, segEnd });
                } else {
                  console.warn(
                    `[MeetingRecorder] Unexpected embedding length ${emb.length}, expected ${SPEAKER_EMBED_FLOATS}`,
                  );
                }
              } catch (err: any) {
                // Diarization is best-effort — log and continue with a
                // null label. The user always sees the transcript.
                debugLog('diarize.error', {
                  chunkIndex, segStart, segEnd,
                  message: err?.message ?? String(err),
                });
              } finally {
                // Zero the PCM16 slice as soon as we're done with it.
                // Because it's a Buffer.subarray view, this also wipes
                // that range of the parent chunk buffer — the outer
                // try/finally in processChunkDual zeroes the rest.
                try { slice.fill(0); } catch { /* defensive */ }
              }
            }
          }
        }
      }

      const seg: TranscriptSegment = {
        id: `seg-${Date.now()}-${this.state.segmentCount}`,
        session_id: sessionId,
        speaker_label: finalLabel,
        start_ms: segStart,
        end_ms: segEnd,
        text,
        source: 'loopback',
        participant_id: null,
        confidence: null,
        created_at: new Date().toISOString(),
      };

      let persisted: TranscriptSegment = seg;
      if (typeof native.addon.addTranscriptSegment === 'function') {
        try {
          const json = native.addon.addTranscriptSegment(
            sessionId, finalLabel, segStart, segEnd, text, 'loopback',
          );
          const parsed = JSON.parse(json);
          if (parsed && parsed.id) persisted = parsed as TranscriptSegment;
        } catch (err) {
          console.warn('[MeetingRecorder] Failed to persist loopback segment:', err);
        }
      }

      // Attach the embedding AFTER the segment write succeeds. Failure
      // here is non-fatal — the segment is still valid, it just won't
      // participate in AHC refinement at stop.
      if (
        embeddingBytes
        && !persisted.id.startsWith('seg-')
        && typeof native.addon.updateSegmentEmbedding === 'function'
      ) {
        try {
          native.addon.updateSegmentEmbedding(
            persisted.id,
            embeddingBytes,
            'wespeaker-resnet34-LM-v1',
            diarConfidence ?? 0.0,
          );
        } catch (err) {
          console.warn('[MeetingRecorder] Failed to persist embedding:', err);
        }
      }

      this.segments.push(persisted);
      this.state = { ...this.state, segmentCount: this.state.segmentCount + 1 };
      // Push once, after the segment + (optional) embedding writes settle.
      this.pushSegmentToRenderer(persisted);
    }
  }

  /**
   * Shared helper for processChunkDual: transcribe one PCM16 buffer,
   * sanitize, fuzzy-correct, persist with the given source + speaker label,
   * and push to the renderer.
   */
  private async transcribeAndPersistDual(
    sessionId: string,
    segmentCount: number,
    chunkIndex: number,
    chunkStartMs: number,
    chunkEndMs: number,
    audioBuffer: Buffer,
    source: 'mic' | 'loopback',
    speakerLabel: string | null,
    engineKind: string,
  ): Promise<void> {
    if (audioBuffer.length === 0) return;
    if (isAudioSilent(audioBuffer)) return;

    const whisperStart = Date.now();
    debugLog('whisper.in', {
      engine: engineKind, owner: 'meeting', source, chunkIndex,
      byteLength: audioBuffer.length, durationSec: audioBuffer.length / 2 / 16000,
    });
    let rawText: string | null = null;
    try {
      rawText = await transcribeWithTimeout(
        native.transcribeWithContext(audioBuffer, this.contextTerms),
        TRANSCRIBE_TIMEOUT_MS,
        `MeetingRecorder.transcribe.${source}`,
      );
      debugLog('whisper.raw', {
        engine: engineKind, owner: 'meeting', source, chunkIndex,
        rawText: rawText ?? '<null/timeout>',
        length: rawText?.length ?? 0,
        latencyMs: Date.now() - whisperStart,
      });
    } catch (err: any) {
      debugLog('whisper.error', {
        engine: engineKind, owner: 'meeting', source, chunkIndex,
        message: err?.message ?? String(err),
        latencyMs: Date.now() - whisperStart,
      });
      return;
    }
    if (!rawText) return;

    let text = sanitizeTranscribedText(rawText);
    if (!text) return;
    const terms = this.correctionTerms();
    if (terms.length > 0) text = correctTranscript(text, terms);

    const segment: TranscriptSegment = {
      id: `seg-${Date.now()}-${segmentCount}`,
      session_id: sessionId,
      speaker_label: speakerLabel,
      start_ms: chunkStartMs,
      end_ms: chunkEndMs,
      text,
      source,
      participant_id: null,
      confidence: null,
      created_at: new Date().toISOString(),
    };

    let persisted: TranscriptSegment = segment;
    if (typeof native.addon.addTranscriptSegment === 'function') {
      try {
        const json = native.addon.addTranscriptSegment(
          sessionId, speakerLabel, chunkStartMs, chunkEndMs, text, source,
        );
        const parsed = JSON.parse(json);
        if (parsed && parsed.id) persisted = parsed as TranscriptSegment;
      } catch (err) {
        console.warn('[MeetingRecorder] Failed to persist dual segment:', err);
      }
    }

    this.segments.push(persisted);
    this.state = { ...this.state, segmentCount: this.state.segmentCount + 1 };
    this.pushSegmentToRenderer(persisted);
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

    // Pull the persisted roster (if any) so the diarization prompt can hint
    // the LLM toward real names. Falls back to a generic prompt when no
    // session id is available or the roster fetch fails.
    let participantNames: string[] = [];
    if (this.state.sessionId) {
      try {
        const json = native.getMeetingParticipants(this.state.sessionId);
        const roster = JSON.parse(json) as Array<{ displayName?: string }>;
        participantNames = (Array.isArray(roster) ? roster : [])
          .map(p => (p?.displayName ?? '').trim())
          .filter(name => name.length > 0);
      } catch (err) {
        console.warn('[MeetingRecorder] failed to read roster for diarization prompt:', err);
      }
    }
    const prompt = buildDiarizationPrompt(participantNames);

    try {
      const labeled = await llmSubprocess.chatComplete({
        modelPath: resolved.modelPath,
        modelType: resolved.modelType,
        messages: [
          { role: 'user', content: prompt + fullTranscript },
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
    // Accept either a numeric Speaker label ("[Speaker 1]") or an arbitrary
    // bracketed name ("[Alice]") so the LLM can use real participant names
    // when the prompt gives it the roster. The capture group is the label
    // contents; the label itself is the verbatim bracket text.
    const speakerPattern = /\[([^\]]+)\][:：]?\s*([\s\S]*?)(?=\[[^\]]+\]|$)/g;
    const labeledChunks: Array<{ label: string; text: string }> = [];
    let match: RegExpExecArray | null;
    while ((match = speakerPattern.exec(labeledTranscript)) !== null) {
      const rawLabel = match[1].trim();
      const text = match[2].trim();
      // Defensive: ignore obviously-noise brackets like timestamps "[00:01:23]"
      // or sound-effect markers "[laughter]" so they don't become speaker
      // labels. Real speaker labels are either "Speaker N" or a name.
      if (!rawLabel || /^\d+$/.test(rawLabel) || /\d{1,2}:\d{2}/.test(rawLabel)) continue;
      labeledChunks.push({ label: rawLabel, text });
    }

    if (labeledChunks.length === 0) return;

    const targets = segmentsToLabel ?? this.segments;
    for (const segment of targets) {
      // Don't overwrite labels already assigned upstream:
      //  • room-peer segments arrive with displayName already on speaker_label
      //    (see meeting-room-server.ts handleMessage),
      //  • dual-stream mic segments are pre-labeled "You" at capture time.
      if (segment.speaker_label) continue;
      // Remote-meeting capture: when both mic and loopback streams were
      // running, diarization is intended ONLY for the loopback side. Mic
      // segments are already "You". Skip anything else (e.g. legacy
      // 'meeting' rows in a mixed session) to avoid relabeling the local
      // user as a generic [Speaker N].
      if (segment.source !== 'loopback' && segment.source !== 'meeting') continue;

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

  /**
   * AHC refinement pass at stop-of-meeting. Pulls every persisted
   * loopback embedding out of SQLite (DB is canonical at stop —
   * survives crashes, drift, missed pushes from the live state), runs
   * `SpeakerClusterer.refine(rows)`, and writes the diff back to the
   * `transcript_segments` table + the in-memory `segmentsSnapshot`.
   *
   * Returns the patch list so the caller can:
   *   1. Run the optional LLM roster-rename pass on top, and
   *   2. Emit a single `MEETING_SEGMENTS_RELABELED` event covering both.
   */
  private async refineLoopbackSpeakers(
    sessionId: string,
    segmentsSnapshot: TranscriptSegment[],
  ): Promise<Array<{ segmentId: string; newLabel: string }>> {
    if (typeof native.addon.listSegmentEmbeddings !== 'function') {
      return [];
    }

    let rows: Array<{ id: string; speaker_label: string | null; start_ms: number; embedding_b64: string }>;
    try {
      const json = native.addon.listSegmentEmbeddings(sessionId, 'loopback');
      rows = JSON.parse(json);
      if (!Array.isArray(rows)) return [];
    } catch (err) {
      console.warn('[MeetingRecorder] AHC: failed to load embeddings:', err);
      return [];
    }
    if (rows.length === 0) return [];

    // Decode base64 embedding bytes → Float32Array. The Rust side
    // packed 256 × f32 little-endian; host endianness is LE on every
    // platform IronMic targets.
    const decoded: SegmentEmbeddingRowJs[] = [];
    for (const r of rows) {
      try {
        const bytes = Buffer.from(r.embedding_b64, 'base64');
        if (bytes.length !== SPEAKER_EMBED_FLOATS * 4) {
          console.warn(
            `[MeetingRecorder] AHC: skipping row ${r.id} with wrong embedding size ${bytes.length}`,
          );
          continue;
        }
        const f32 = new Float32Array(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength / 4,
        );
        // Defensive copy — `bytes` is a Node Buffer that may be GC'd
        // while the clusterer holds the embedding reference.
        decoded.push({
          segmentId: r.id,
          oldLabel: r.speaker_label,
          startMs: r.start_ms,
          embedding: new Float32Array(f32),
        });
      } catch (err) {
        console.warn(`[MeetingRecorder] AHC: decode failed for row ${r.id}:`, err);
      }
    }
    if (decoded.length === 0) return [];

    // DB is canonical — build a FRESH clusterer rather than reading the
    // live (potentially-drifted) `this.speakerClusterer`. This makes
    // refinement robust against crashes / mid-session restarts.
    const refiner = new SpeakerClusterer();
    const diff = refiner.refine(decoded);

    const out: Array<{ segmentId: string; newLabel: string }> = [];
    for (const d of diff) {
      if (d.oldLabel === d.newLabel) continue;
      // Persist
      if (typeof native.addon.updateSegmentSpeaker === 'function') {
        try {
          native.addon.updateSegmentSpeaker(d.segmentId, d.newLabel);
        } catch (err) {
          console.warn(
            `[MeetingRecorder] AHC: failed to persist label for ${d.segmentId}:`,
            err,
          );
          continue;
        }
      }
      // Mirror into in-memory snapshot so the caller's view matches DB.
      const seg = segmentsSnapshot.find(s => s.id === d.segmentId);
      if (seg) seg.speaker_label = d.newLabel;
      out.push({ segmentId: d.segmentId, newLabel: d.newLabel });
    }
    return out;
  }

  /**
   * Optional LLM roster-rename pass (M2.5). Gated by
   * `meeting_llm_name_pass_enabled` (default `'false'`). When on AND a
   * participant roster is present, asks the LLM to map cluster labels
   * ([Speaker 1], …) to roster names ([Alice], …) and applies the
   * mapping uniformly across every segment that carries the same cluster
   * label. Per-segment word-overlap matching is intentionally NOT used
   * here — cluster labels are already stable after AHC, so a uniform
   * cluster→name remap is sufficient and avoids relabeling individual
   * utterances based on transcript content.
   *
   * Returns the patches actually applied, so the caller can fold them
   * into the single `MEETING_SEGMENTS_RELABELED` emission.
   */
  private async runLlmRosterRename(
    sessionId: string,
    segmentsSnapshot: TranscriptSegment[],
  ): Promise<Array<{ segmentId: string; newLabel: string }>> {
    const enabled = (() => {
      try { return native.getSetting('meeting_llm_name_pass_enabled') === 'true'; }
      catch { return false; }
    })();
    if (!enabled) return [];

    // Need a roster to map to — without it the LLM has nothing to do.
    let participantNames: string[] = [];
    try {
      const json = native.getMeetingParticipants(sessionId);
      const roster = JSON.parse(json) as Array<{ displayName?: string }>;
      participantNames = (Array.isArray(roster) ? roster : [])
        .map(p => (p?.displayName ?? '').trim())
        .filter(name => name.length > 0);
    } catch (err) {
      console.warn('[MeetingRecorder] LLM rename: roster fetch failed:', err);
      return [];
    }
    if (participantNames.length === 0) return [];

    // Build the labeled transcript from the AHC-refined snapshot.
    const labeledLoopback = segmentsSnapshot
      .filter(s => s.source === 'loopback' && s.speaker_label)
      .map(s => `${s.speaker_label}: ${s.text}`)
      .join('\n');
    if (!labeledLoopback) return [];

    // Distinct cluster labels in the transcript — what we ask the LLM
    // to map. Anything not in this set is left alone.
    const clusterLabels = Array.from(
      new Set(
        segmentsSnapshot
          .filter(s => s.source === 'loopback' && s.speaker_label)
          .map(s => s.speaker_label!),
      ),
    );
    if (clusterLabels.length === 0) return [];

    const resolved = resolveActiveChatModel(native);
    if (!resolved) return [];

    const prompt = [
      'You are a speaker-attribution assistant. Given a transcript with',
      'placeholder speaker labels (like [Speaker 1], [Speaker 2]) and a',
      'roster of meeting participants, decide which roster name (if any)',
      'each placeholder most likely refers to. If you cannot tell, keep',
      'the placeholder.',
      '',
      'Output JSON only — an object mapping each placeholder label to',
      'either a roster name (without brackets) or null. Example output:',
      '{"[Speaker 1]": "Alice", "[Speaker 2]": null}',
      '',
      `Roster: ${participantNames.join(', ')}`,
      `Placeholders to resolve: ${clusterLabels.join(', ')}`,
      '',
      'Transcript:',
      labeledLoopback,
    ].join('\n');

    let raw: string | null = null;
    try {
      raw = await llmSubprocess.chatComplete({
        modelPath: resolved.modelPath,
        modelType: resolved.modelType,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 512,
        temperature: 0.1,
      });
    } catch (err) {
      console.warn('[MeetingRecorder] LLM rename: chat failed:', err);
      return [];
    }
    if (!raw) return [];

    // Best-effort JSON extraction — LLMs sometimes wrap in prose.
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return [];
    let mapping: Record<string, string | null>;
    try {
      mapping = JSON.parse(m[0]);
    } catch {
      return [];
    }

    const out: Array<{ segmentId: string; newLabel: string }> = [];
    for (const seg of segmentsSnapshot) {
      if (seg.source !== 'loopback' || !seg.speaker_label) continue;
      const target = mapping[seg.speaker_label];
      if (!target || typeof target !== 'string') continue;
      const newLabel = `[${target.trim()}]`;
      if (newLabel === seg.speaker_label) continue;
      if (typeof native.addon.updateSegmentSpeaker === 'function') {
        try {
          native.addon.updateSegmentSpeaker(seg.id, newLabel);
        } catch (err) {
          console.warn(
            `[MeetingRecorder] LLM rename: persist failed for ${seg.id}:`,
            err,
          );
          continue;
        }
      }
      seg.speaker_label = newLabel;
      out.push({ segmentId: seg.id, newLabel });
    }
    return out;
  }

  /**
   * Emit a single `MEETING_SEGMENTS_RELABELED` event so the renderer
   * can patch its in-memory segment list in place after AHC + LLM
   * rename. Empty `patches` is allowed and signals to the renderer
   * that refinement ran but produced no changes (clear any pending UI).
   */
  private pushSegmentsRelabeledToRenderer(
    sessionId: string,
    patches: Array<{ segmentId: string; newLabel: string }>,
  ): void {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      windows[0].webContents.send(
        IPC_CHANNELS.MEETING_SEGMENTS_RELABELED,
        { sessionId, patches },
      );
    }
  }

  // ── Moonshine streaming session path ──────────────────────────────────────
  // Mirrors dictation-streamer.ts:runStreamingSession with meeting-specific
  // tweaks: emits MEETING_DRAFT_READY for the grey-typing UI, builds full
  // TranscriptSegments on commit, and tracks totalDrainedAudioMs so segment
  // start/end timestamps stay monotonic across the whole meeting.
  private async runStreamingSession(): Promise<void> {
    let silentAudioMs = 0;
    let sessionHasContent = false;
    let sessionAudioMs = 0;
    // Snapshot the mute generation so we detect transitions inside the loop.
    // setMicMuted() only flips the boolean and bumps this counter; it never
    // reaches into the loop's locals — we observe it here on the next tick.
    let observedMuteGen = this.muteGeneration;

    // Gate: exit on either end-of-meeting (status !== 'recording') OR on
    // an in-progress engine swap (engineSwapping). Both paths fall through
    // to the same final-drain + commit + stopRecording block below — so a
    // streaming → chunked swap preserves any partial Moonshine session
    // content (it gets committed as a final segment) before the chunked
    // path takes over. This is what prevents text loss during a live swap.
    while (this.state.status === 'recording' && !this.state.engineSwapping) {
      await sleep(SESSION_DRAIN_INTERVAL_MS);
      if (this.state.status !== 'recording' || this.state.engineSwapping) break;

      // ── Mute transition: drop any in-flight draft to keep mute as a hard
      //    privacy boundary. We do this BEFORE the drain so an unmute
      //    transition also lands on a clean slate (no stale grey line).
      if (this.muteGeneration !== observedMuteGen) {
        observedMuteGen = this.muteGeneration;
        if (this.state.isMicMuted) {
          this.pushDraftToRenderer('');
          try { native.addon.moonshineSessionReset?.(); } catch { /* ignore */ }
          sessionHasContent = false;
          sessionAudioMs = 0;
          silentAudioMs = 0;
          debugLog('meeting.mute.draft-drop', { generation: observedMuteGen });
        }
      }

      let audioBuffer: Buffer;
      try {
        audioBuffer = native.addon.drainRecordingBuffer!();
      } catch (err) {
        debugLog('meeting.session.drain.error', { error: String(err) });
        continue;
      }
      if (!audioBuffer || audioBuffer.length < 500) continue;

      // ── Mic-muted gate (audio is drained but discarded) ──
      // We still advance totalDrainedAudioMs so the meeting-wide timeline
      // stays accurate; post-unmute segments will then have correct start_ms
      // relative to meeting start. The buffer itself is dropped on the floor.
      if (this.state.isMicMuted) {
        const bufferAudioMs = (audioBuffer.length / 2 / 16_000) * 1_000;
        this.totalDrainedAudioMs += bufferAudioMs;
        continue;
      }

      const silent = isAudioSilent(audioBuffer);
      const bufferAudioMs = (audioBuffer.length / 2 / 16_000) * 1_000;
      // Always advance the meeting-wide clock so timestamps reflect real
      // elapsed audio, including silences.
      this.totalDrainedAudioMs += bufferAudioMs;

      debugLog('meeting.session.drain', {
        byteLength: audioBuffer.length,
        rms: computeRmsPcm16(audioBuffer),
        silent,
        sessionAudioMs,
        silentAudioMs,
        totalDrainedAudioMs: this.totalDrainedAudioMs,
      });

      if (silent) {
        silentAudioMs += bufferAudioMs;
        if (sessionHasContent && silentAudioMs >= SESSION_SILENCE_COMMIT_MS) {
          // Last actual speech ended at totalDrainedAudioMs - silentAudioMs.
          // Use that as the segment's end_ms so trailing silence is excluded.
          this.lastSpeechEndMs = this.totalDrainedAudioMs - silentAudioMs;
          await this.commitSegmentAndClearDraft(false);
          sessionHasContent = false;
          sessionAudioMs = 0;
          silentAudioMs = 0;
        }
        // Do NOT append silent audio to the Moonshine session.
        continue;
      }

      // Speech detected.
      silentAudioMs = 0;
      if (!sessionHasContent) {
        // First speech of a new segment — anchor its start time at the
        // beginning of THIS buffer (before we counted it into total above).
        this.currentSegmentStartMs = this.totalDrainedAudioMs - bufferAudioMs;
      }
      sessionHasContent = true;
      sessionAudioMs += bufferAudioMs;

      let hypothesis: string;
      try {
        // No JS-side timeout — moonshineSessionAppend is strictly serialized
        // on the Rust session mutex. A timeout here wouldn't cancel in-flight
        // inference; it would just corrupt session ordering.
        hypothesis = await native.addon.moonshineSessionAppend!(audioBuffer);
        debugLog('meeting.session.append', { hypothesis: hypothesis.slice(0, 80), sessionAudioMs });
      } catch (err) {
        console.error('[MeetingRecorder] session_append failed, resetting session:', err);
        debugLog('meeting.session.append.error', { error: String(err) });
        this.pushDraftToRenderer('');
        try { native.addon.moonshineSessionReset?.(); } catch { /* ignore */ }
        sessionHasContent = false;
        sessionAudioMs = 0;
        silentAudioMs = 0;
        continue;
      }

      // We just appended speech — extend the candidate end time to here.
      this.lastSpeechEndMs = this.totalDrainedAudioMs;

      const cleaned = sanitizeTranscribedText(hypothesis);
      this.pushDraftToRenderer(cleaned);

      // 25s session cap — Moonshine is trained for ≤30s utterances. Commit
      // proactively so we don't run past the training window.
      if (sessionAudioMs >= SESSION_CAP_MS) {
        debugLog('meeting.session.cap', { sessionAudioMs });
        await this.commitSegmentAndClearDraft(false);
        sessionHasContent = false;
        sessionAudioMs = 0;
        silentAudioMs = 0;
      }
    }

    // ── Final drain after status flipped to 'stopping' ─────────────────────
    // Privacy gate: if the user is currently muted at stop time, the final
    // buffer (whatever happened in the last ~200ms while we were muted) must
    // not be transcribed or committed. This closes the "mute → immediately
    // stop" leak path. We still drain to release the native buffer, but the
    // contents are discarded.
    //
    // Race fix: if the user clicked Mute and Stop in the same tick (faster
    // than the loop's 200ms heartbeat), the loop never observed the mute
    // transition — but the in-flight Moonshine session may still hold
    // pre-mute content. Reset the session here too so the privacy invariant
    // holds even under that race.
    if (this.state.isMicMuted) {
      try { native.addon.moonshineSessionReset?.(); } catch { /* ignore */ }
      sessionHasContent = false;
      sessionAudioMs = 0;
      silentAudioMs = 0;
      this.pushDraftToRenderer('');
      debugLog('meeting.mute.stop-race-drop', { generation: this.muteGeneration });
    }
    let appendedFinalAudio = false;
    try {
      const finalBuffer = native.addon.drainRecordingBuffer!();
      if (
        !this.state.isMicMuted
        && finalBuffer && finalBuffer.length >= 500
        && !isAudioSilent(finalBuffer)
      ) {
        const bufferAudioMs = (finalBuffer.length / 2 / 16_000) * 1_000;
        this.totalDrainedAudioMs += bufferAudioMs;
        if (!sessionHasContent) {
          this.currentSegmentStartMs = this.totalDrainedAudioMs - bufferAudioMs;
        }
        try {
          const hyp = await native.addon.moonshineSessionAppend!(finalBuffer);
          const cleaned = sanitizeTranscribedText(hyp);
          if (cleaned) this.pushDraftToRenderer(cleaned);
          appendedFinalAudio = true;
          this.lastSpeechEndMs = this.totalDrainedAudioMs;
          sessionHasContent = true;
          debugLog('meeting.session.final-drain', {
            byteLength: finalBuffer.length,
            hypothesis: hyp.slice(0, 80),
          });
        } catch { /* best effort — commit whatever's already in the session */ }
      }
    } catch { /* ignore drain errors on stop */ }

    // Stop capture AFTER final drain so no audio is lost.
    try { native.addon.stopRecording(); } catch { /* already stopped */ }

    if (sessionHasContent || appendedFinalAudio) {
      await this.commitSegmentAndClearDraft(true);
    } else {
      this.pushDraftToRenderer('');
    }
    try { native.addon.moonshineSessionReset?.(); } catch { /* ignore */ }
  }

  /**
   * Commit the current Moonshine session into a TranscriptSegment.
   * Called from the streaming loop on silence boundary, on cap, and on stop.
   * Does the same post-transcription work as processChunk() — persistence,
   * in-memory push, segmentCount bump, renderer push, listener fan-out.
   */
  private async commitSegmentAndClearDraft(isFinalStop: boolean): Promise<void> {
    // Clear the grey line first so the user sees the handoff.
    this.pushDraftToRenderer('');

    let finalText: string;
    try {
      finalText = await native.addon.moonshineSessionCommit!();
    } catch (err) {
      console.error('[MeetingRecorder] session_commit failed:', err);
      debugLog('meeting.session.commit.error', { error: String(err), isFinalStop });
      try { native.addon.moonshineSessionReset?.(); } catch { /* ignore */ }
      return;
    }

    let text = sanitizeTranscribedText(finalText);
    debugLog('meeting.session.commit', { textLength: text.length, isFinalStop });
    if (!text) return;

    // Fuzzy post-correction at the streaming-COMMIT boundary only — never on
    // draft hypotheses (would cause grey-typing flicker). Catches Moonshine
    // misses on participant names + dictionary words. Empty term set short-
    // circuits inside the helper.
    const correctionTerms = this.correctionTerms();
    if (correctionTerms.length > 0) {
      text = correctTranscript(text, correctionTerms);
    }

    const { sessionId } = this.state;
    if (!sessionId) return;

    const segmentCount = this.state.segmentCount;
    const startMs = this.currentSegmentStartMs;
    const endMs = Math.max(this.lastSpeechEndMs, startMs);

    const segment: TranscriptSegment = {
      id: `seg-${Date.now()}-${segmentCount}`,
      session_id: sessionId,
      speaker_label: null, // assigned post-meeting by LLM diarization
      start_ms: startMs,
      end_ms: endMs,
      text,
      source: 'meeting',
      participant_id: null,
      confidence: null,
      created_at: new Date().toISOString(),
    };

    let persisted: TranscriptSegment = segment;
    if (typeof native.addon.addTranscriptSegment === 'function') {
      try {
        const json = native.addon.addTranscriptSegment(
          sessionId,
          null,
          startMs,
          endMs,
          segment.text,
          'meeting',
        );
        const parsed = JSON.parse(json);
        if (parsed && parsed.id) persisted = parsed as TranscriptSegment;
      } catch (err) {
        console.warn('[MeetingRecorder] Failed to persist streamed segment (keeping in-memory):', err);
      }
    }

    // CRITICAL: push into in-memory list and bump counter so
    // stopMeetingRecording's fullTranscript assembly sees this segment.
    // (The renderer already saw it via pushSegmentToRenderer; this is for
    // the stop-time return value, not for live UI.)
    this.segments.push(persisted);
    this.state = { ...this.state, segmentCount: segmentCount + 1 };
    this.pushStateToRenderer();

    this.pushSegmentToRenderer(persisted);
  }

  private pushDraftToRenderer(hypothesis: string): void {
    const { sessionId } = this.state;
    const windows = BrowserWindow.getAllWindows();
    if (windows.length === 0) return;
    windows[0].webContents.send(IPC_CHANNELS.MEETING_DRAFT_READY, {
      sessionId,
      hypothesis,
      startMs: this.currentSegmentStartMs,
    });
  }

  private pushSegmentToRenderer(segment: TranscriptSegment): void {
    debugLog('chunk.emit', { owner: 'meeting', segmentId: segment.id, textLength: segment.text.length, start_ms: segment.start_ms, end_ms: segment.end_ms });
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
