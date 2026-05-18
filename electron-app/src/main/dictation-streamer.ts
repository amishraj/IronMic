/**
 * DictationStreamer — near-real-time dictation with engine-aware transcription.
 *
 * Two transcription paths are selected at start() based on the active engine:
 *
 * 1. runStreamingSession() — Moonshine + session API available
 *    Drains audio every 200ms into a growing Rust session buffer. Moonshine
 *    re-transcribes the full accumulated utterance on each append and returns
 *    a live hypothesis. On 1.0s of silence (or 20s cap), the utterance is
 *    committed as permanent text and the session resets for the next utterance.
 *    Silence is measured from actual drained audio duration, not tick count.
 *    No chunk boundaries → no mid-word cuts.
 *
 * 2. runChunkedMode(intervalMs) — Whisper or Moonshine without session API
 *    Self-scheduling drain loop (not setInterval) to prevent overlapping calls.
 *    Moonshine: 5000ms chunks + 800ms audio overlap with conservative dedup.
 *    Whisper:   8000ms chunks + transcribeShort single_segment hint.
 *
 * Meetings use a completely separate MeetingRecorderManager — this file is
 * dictation-only.
 */

import { BrowserWindow } from 'electron';
import { native } from './native-bridge';
import { IPC_CHANNELS } from '../shared/constants';
import {
  isAudioSilent,
  sanitizeTranscribedText,
  transcribeWithTimeout,
  computeRmsPcm16,
  stripOverlapPrefix,
} from './transcribe-clean';
import { audioStream } from './audio-stream-manager';
import { debugLog } from './debug-log';
import { correctTranscript } from '../shared/transcript-correction';
import { getWords as getDictionaryWords } from './dictionary-cache';

const TRANSCRIBE_TIMEOUT_MS = 8_000;
const FIRST_TRANSCRIBE_TIMEOUT_MS = 20_000;

// Session streaming constants
const SESSION_DRAIN_INTERVAL_MS = 200;
const SESSION_CAP_MS = 20_000;
const SESSION_SILENCE_COMMIT_MS = 1_000;
// AI Chat (Voice Chat) uses a slightly longer silence window so a natural
// mid-sentence pause doesn't auto-send. Range-clamped here to avoid drift.
const AI_CHAT_SILENCE_COMMIT_MS = 1_200;
const SILENCE_COMMIT_MIN_MS = 700;
const SILENCE_COMMIT_MAX_MS = 2_500;

function clampSilenceMs(ms: number): number {
  return Math.max(SILENCE_COMMIT_MIN_MS, Math.min(SILENCE_COMMIT_MAX_MS, ms));
}

// Chunked mode constants (engine-aware intervals chosen at start())
const MOONSHINE_CHUNK_INTERVAL_MS = 5_000;
const WHISPER_CHUNK_INTERVAL_MS = 8_000;
// 800ms overlap at 16kHz PCM16 (2 bytes/sample)
const MOONSHINE_OVERLAP_BYTES = 16_000 * 2 * 0.8;

export type DictationSource = 'notes' | 'forge' | 'ai-chat';
export type DictationEngine = 'moonshine-session' | 'moonshine-chunked' | 'whisper-chunked' | 'unknown';
type CommitReason = 'silence' | 'cap' | 'final-stop';

export interface DictationEndOfTurnEvent {
  source: DictationSource;
  text: string;
}

export interface DictationChunkEvent {
  index: number;
  text: string;
  isFinal: boolean;
  source: DictationSource;
}

export interface DictationDraftEvent {
  hypothesis: string;
  source: DictationSource;
}

export interface DictationStreamState {
  status: 'idle' | 'recording' | 'stopping';
  startedAt: number | null;
  chunkCount: number;
  source: DictationSource;
  /**
   * Resolved transcription path for this session. Set before the first
   * `pushState()` after start() so renderers never see `'unknown'` while
   * a session is active. Only `'moonshine-session'` supports hands-free
   * end-of-turn (silence-driven auto-send for Voice Chat).
   */
  engine: DictationEngine;
}

export interface DictationStreamStartOpts {
  source?: DictationSource;
}

/** Resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

class DictationStreamer {
  private streamLoopPromise: Promise<void> | null = null;
  private chunkIndex = 0;
  private activeSource: DictationSource = 'notes';
  private activeEngine: DictationEngine = 'unknown';
  private state: DictationStreamState = {
    status: 'idle',
    startedAt: null,
    chunkCount: 0,
    source: 'notes',
    engine: 'unknown',
  };
  private fullText = '';
  private cleanupDone = false;

  isActive(): boolean {
    return this.state.status !== 'idle';
  }

  getActiveSource(): DictationSource | null {
    return this.state.status === 'idle' ? null : this.activeSource;
  }

  getFullText(): string {
    return this.fullText.trim();
  }

  async start(opts?: DictationStreamStartOpts): Promise<void> {
    if (this.state.status !== 'idle') {
      throw new Error('Dictation is already active');
    }

    this.activeSource = opts?.source ?? 'notes';
    this.cleanupDone = false;
    this.chunkIndex = 0;
    this.fullText = '';

    audioStream.acquire('streaming');
    try {
      if (typeof native.addon.loadWhisperModel === 'function') {
        native.addon.loadWhisperModel();
      }
      native.addon.startRecording();
      debugLog('capture.start', { owner: 'streaming', success: true });
    } catch (err: any) {
      debugLog('capture.start', { owner: 'streaming', success: false, error: err?.message ?? String(err) });
      audioStream.release('streaming');
      if (err?.message?.includes('already')) {
        try { native.addon.resetPipelineState?.(); } catch { /* ignore */ }
        try { native.addon.startRecording(); } catch (retryErr) { throw retryErr; }
      } else {
        throw err;
      }
    }

    // Determine which path to use for this session BEFORE the first pushState
    // so renderers never see `engine: 'unknown'` while a session is active.
    const engineKind = (() => {
      try { return native.getTranscriptionEngine?.() ?? 'moonshine-base'; }
      catch { return 'moonshine-base'; }
    })();
    const isMoonshine = engineKind.startsWith('moonshine');
    const canStream = isMoonshine
      && typeof native.addon.moonshineSessionAppend === 'function'
      && typeof native.addon.drainRecordingBuffer === 'function'
      && (native.addon.moonshineSessionSupports?.() ?? false);

    this.activeEngine = canStream
      ? 'moonshine-session'
      : isMoonshine ? 'moonshine-chunked' : 'whisper-chunked';

    debugLog('dictation.start', { engineKind, isMoonshine, canStream, engine: this.activeEngine });

    this.state = {
      status: 'recording',
      startedAt: Date.now(),
      chunkCount: 0,
      source: this.activeSource,
      engine: this.activeEngine,
    };
    this.pushState();

    const intervalMs = isMoonshine ? MOONSHINE_CHUNK_INTERVAL_MS : WHISPER_CHUNK_INTERVAL_MS;

    this.streamLoopPromise = (
      canStream
        ? this.runStreamingSession()
        : this.runChunkedMode(intervalMs, isMoonshine)
    ).catch((err) => {
      console.error('[DictationStreamer] loop exited with error:', err);
      this.finalizeNativeState();
    });
  }

  async stop(): Promise<{ text: string; chunkCount: number }> {
    if (this.state.status === 'idle') {
      return { text: this.fullText.trim(), chunkCount: this.chunkIndex };
    }

    this.state = { ...this.state, status: 'stopping' };
    this.pushState();

    // Wait for the loop to process the final drain and commit, then clean up.
    await this.streamLoopPromise;
    this.streamLoopPromise = null;
    this.finalizeNativeState();

    return { text: this.fullText.trim(), chunkCount: this.chunkIndex };
  }

  // ── Moonshine streaming session path ──────────────────────────────────────

  private async runStreamingSession(): Promise<void> {
    let silentAudioMs = 0;
    let sessionHasContent = false;
    let sessionAudioMs = 0;

    // Per-source silence threshold. Voice Chat (ai-chat) gets a slightly
    // longer window so a natural mid-sentence pause doesn't auto-send.
    const silenceCommitMs = clampSilenceMs(
      this.activeSource === 'ai-chat' ? AI_CHAT_SILENCE_COMMIT_MS : SESSION_SILENCE_COMMIT_MS,
    );

    // Reset any leftover state from a previous session.
    native.addon.moonshineSessionReset?.();

    while (this.state.status === 'recording') {
      await sleep(SESSION_DRAIN_INTERVAL_MS);
      if (this.state.status !== 'recording') break;

      let audioBuffer: Buffer;
      try {
        audioBuffer = native.addon.drainRecordingBuffer!();
      } catch (err) {
        debugLog('session.drain.error', { error: String(err) });
        continue;
      }
      if (!audioBuffer || audioBuffer.length < 500) continue;

      const silent = isAudioSilent(audioBuffer);
      const bufferAudioMs = (audioBuffer.length / 2 / 16_000) * 1_000;
      debugLog('session.drain', {
        byteLength: audioBuffer.length,
        rms: computeRmsPcm16(audioBuffer),
        silent,
        sessionAudioMs,
        silentAudioMs,
      });

      if (silent) {
        silentAudioMs += bufferAudioMs;
        if (sessionHasContent && silentAudioMs >= silenceCommitMs) {
          await this.commitSessionAndClearDraft('silence');
          sessionHasContent = false;
          sessionAudioMs = 0;
          silentAudioMs = 0;
        }
        // Do NOT append silent audio to the session.
        continue;
      }

      // Speech detected — reset silence accumulator, track audio duration.
      silentAudioMs = 0;
      sessionHasContent = true;
      sessionAudioMs += (audioBuffer.length / 2 / 16_000) * 1_000;

      let hypothesis: string;
      try {
        // No timeout wrapper — this call is strictly serialized. A JS timeout
        // would not cancel the in-flight Rust inference, corrupting session state.
        hypothesis = await native.addon.moonshineSessionAppend!(audioBuffer);
        debugLog('session.append', { hypothesis: hypothesis.slice(0, 80), sessionAudioMs });
      } catch (err) {
        console.error('[DictationStreamer] session_append failed, aborting session:', err);
        debugLog('session.append.error', { error: String(err) });
        this.emitDraft('');
        native.addon.moonshineSessionReset?.();
        sessionHasContent = false;
        sessionAudioMs = 0;
        break;
      }

      // ai-chat: emit raw hypothesis. Notes/Forge get artifact-stripping.
      const cleaned = this.activeSource === 'ai-chat'
        ? (hypothesis || '').trim()
        : sanitizeTranscribedText(hypothesis);
      this.emitDraft(cleaned);

      // 20s session cap — commit proactively to keep latency bounded.
      // NOTE: cap commits intentionally do NOT trigger end-of-turn for ai-chat;
      // the user is still mid-utterance, and auto-sending here would split a
      // long answer mid-sentence.
      if (sessionAudioMs >= SESSION_CAP_MS) {
        debugLog('session.cap', { sessionAudioMs });
        await this.commitSessionAndClearDraft('cap');
        sessionHasContent = false;
        sessionAudioMs = 0;
        silentAudioMs = 0;
      }
    }

    // ── Final drain after loop exits (status = stopping) ──────────────────
    // Capture any audio accumulated since the last 400ms tick.
    let appendedFinalAudio = false;
    try {
      const finalBuffer = native.addon.drainRecordingBuffer!();
      if (finalBuffer && finalBuffer.length >= 500 && !isAudioSilent(finalBuffer)) {
        try {
          const hyp = await native.addon.moonshineSessionAppend!(finalBuffer);
          const cleaned = this.activeSource === 'ai-chat'
            ? (hyp || '').trim()
            : sanitizeTranscribedText(hyp);
          if (cleaned) this.emitDraft(cleaned);
          appendedFinalAudio = true;
          debugLog('session.final-drain', { byteLength: finalBuffer.length, hypothesis: hyp.slice(0, 80) });
        } catch { /* best effort — commit whatever is in session */ }
      }
    } catch { /* ignore drain errors on stop */ }

    // Stop capture AFTER final drain so no audio is lost.
    try { native.addon.stopRecording(); } catch { /* already stopped */ }

    if (sessionHasContent || appendedFinalAudio) {
      await this.commitSessionAndClearDraft('final-stop');
    } else {
      this.emitDraft('');
    }
    native.addon.moonshineSessionReset?.();
  }

  private async commitSessionAndClearDraft(reason: CommitReason): Promise<void> {
    this.emitDraft('');
    const isFinalStop = reason === 'final-stop';
    try {
      const finalText = await native.addon.moonshineSessionCommit!();
      // AI Chat wants raw Moonshine output — no artifact-stripping, no
      // dictionary fuzzy-correction. Both behave like silent rewrites
      // ("polish") from the user's POV. Notes / Forge keep the cleanups.
      let cleaned: string;
      if (this.activeSource === 'ai-chat') {
        cleaned = (finalText || '').trim();
      } else {
        cleaned = sanitizeTranscribedText(finalText);
        const dict = getDictionaryWords();
        if (cleaned && dict.length > 0) {
          cleaned = correctTranscript(cleaned, dict);
        }
      }
      debugLog('session.commit', { cleaned: cleaned.slice(0, 80), reason, source: this.activeSource });
      if (cleaned) {
        this.fullText = (this.fullText + ' ' + cleaned).replace(/\s+/g, ' ').trim();
        this.chunkIndex += 1;
        this.state = { ...this.state, chunkCount: this.chunkIndex };
        this.emitChunk(cleaned, isFinalStop);
      }
      // Voice Chat hands-free: a silence-driven commit with non-empty
      // accumulated text is the user's turn end. Cap commits and final-stop
      // commits never fire end-of-turn — cap is mid-utterance, final-stop
      // means the toggle was already turned off.
      if (
        reason === 'silence'
        && this.activeSource === 'ai-chat'
        && this.fullText.trim().length > 0
      ) {
        this.emitEndOfTurn(this.fullText.trim());
      }
    } catch (err) {
      console.error('[DictationStreamer] session_commit failed:', err);
      debugLog('session.commit.error', { error: String(err) });
      native.addon.moonshineSessionReset?.();
    }
  }

  // ── Chunked mode (Whisper or Moonshine fallback) ───────────────────────────

  private async runChunkedMode(intervalMs: number, isMoonshine: boolean): Promise<void> {
    let overlapBuffer: Buffer = Buffer.alloc(0);
    let previousChunkText = '';
    let isFirstChunk = true;

    while (this.state.status === 'recording') {
      await sleep(intervalMs);
      if (this.state.status !== 'recording') break;

      await this.processChunkBatch(false, isMoonshine, isFirstChunk, overlapBuffer, previousChunkText,
        (newOverlap, newPrevText) => {
          overlapBuffer = newOverlap;
          previousChunkText = newPrevText;
        });
      isFirstChunk = false;
    }

    // Final chunk on stop.
    await this.processChunkBatch(true, isMoonshine, false, overlapBuffer, previousChunkText, () => {});
  }

  private async processChunkBatch(
    isFinal: boolean,
    isMoonshine: boolean,
    isFirst: boolean,
    overlapBuffer: Buffer,
    previousChunkText: string,
    updateOverlap: (newOverlap: Buffer, newPrevText: string) => void,
  ): Promise<void> {
    let audioBuffer: Buffer;
    try {
      audioBuffer = isFinal || typeof native.addon.drainRecordingBuffer !== 'function'
        ? native.addon.stopRecording()
        : native.addon.drainRecordingBuffer();
      debugLog('capture.drained', {
        chunkIndex: this.chunkIndex,
        byteLength: audioBuffer.length,
        rms: computeRmsPcm16(audioBuffer),
        isFinal,
      });
    } catch (err: any) {
      debugLog('capture.drained', { chunkIndex: this.chunkIndex, isFinal, error: err?.message ?? String(err) });
      return;
    }

    if (!isFinal && typeof native.addon.drainRecordingBuffer !== 'function') {
      try { native.addon.startRecording(); } catch { /* ignore */ }
    }

    if (isAudioSilent(audioBuffer)) {
      if (isFinal) this.emitChunk('', true);
      return;
    }

    // Moonshine chunked: prepend overlap from previous chunk for context.
    let transcribeBuffer = audioBuffer;
    if (isMoonshine && overlapBuffer.length > 0) {
      transcribeBuffer = Buffer.concat([overlapBuffer, audioBuffer]);
    }

    const engineKind = (() => {
      try { return native.getTranscriptionEngine?.() ?? 'unknown'; } catch { return 'unknown'; }
    })();
    const useShort = !isFinal && !isMoonshine && typeof native.addon.transcribeShort === 'function';
    const transcribeFn = useShort ? native.addon.transcribeShort : native.addon.transcribe;

    debugLog('whisper.in', {
      engine: engineKind,
      chunkIndex: this.chunkIndex,
      byteLength: transcribeBuffer.length,
      durationSec: transcribeBuffer.length / 2 / 16_000,
      short: useShort,
      isFinal,
      hasOverlap: isMoonshine && overlapBuffer.length > 0,
    });

    const timeoutMs = isFirst ? FIRST_TRANSCRIBE_TIMEOUT_MS : TRANSCRIBE_TIMEOUT_MS;
    const rawText = await transcribeWithTimeout(
      Promise.resolve(transcribeFn(transcribeBuffer)),
      timeoutMs,
      'DictationStreamer.transcribeChunk',
    );
    debugLog('whisper.raw', { engine: engineKind, chunkIndex: this.chunkIndex, rawText: rawText ?? '<null/timeout>' });

    if (rawText == null) {
      if (isFinal) this.emitChunk('', true);
      return;
    }

    // ai-chat: raw Moonshine/Whisper output. Skip artifact-stripping AND
    // dictionary fuzzy-correction. Overlap-stripping still runs because
    // it's a deduplication, not a rewrite.
    let cleaned = this.activeSource === 'ai-chat'
      ? (rawText || '').trim()
      : sanitizeTranscribedText(rawText);

    // Strip overlap region from output if we prepended context.
    if (isMoonshine && overlapBuffer.length > 0 && previousChunkText && cleaned) {
      cleaned = stripOverlapPrefix(previousChunkText, cleaned);
    }

    if (this.activeSource !== 'ai-chat') {
      // Fuzzy correction at chunk finalize. Same guardrails as the streaming
      // path — single-word terms, conservative edit-distance caps, stop-list
      // protection. Empty dictionary returns unchanged.
      const dict = getDictionaryWords();
      if (cleaned && dict.length > 0) {
        cleaned = correctTranscript(cleaned, dict);
      }
    }

    // Save new overlap tail (Moonshine only) for the next chunk.
    if (isMoonshine && !isFinal) {
      const overlapBytes = Math.floor(MOONSHINE_OVERLAP_BYTES);
      const newOverlap = audioBuffer.length > overlapBytes
        ? audioBuffer.slice(audioBuffer.length - overlapBytes)
        : audioBuffer;
      updateOverlap(newOverlap, cleaned || previousChunkText);
    }

    if (cleaned) {
      this.fullText = (this.fullText + ' ' + cleaned).replace(/\s+/g, ' ').trim();
    }
    this.chunkIndex += 1;
    this.state = { ...this.state, chunkCount: this.chunkIndex };
    this.emitChunk(cleaned, isFinal);
  }

  // ── Shared emit helpers ───────────────────────────────────────────────────

  private emitChunk(text: string, isFinal: boolean): void {
    const payload: DictationChunkEvent = {
      index: this.chunkIndex,
      text,
      isFinal,
      source: this.activeSource,
    };
    debugLog('chunk.emit', payload);
    const w = BrowserWindow.getAllWindows()[0];
    if (w && !w.isDestroyed()) {
      w.webContents.send(IPC_CHANNELS.DICTATION_STREAM_CHUNK, payload);
    }
  }

  private emitDraft(hypothesis: string): void {
    const payload: DictationDraftEvent = { hypothesis, source: this.activeSource };
    debugLog('draft.emit', { hypothesis: hypothesis.slice(0, 80), source: this.activeSource });
    const w = BrowserWindow.getAllWindows()[0];
    if (w && !w.isDestroyed()) {
      w.webContents.send(IPC_CHANNELS.DICTATION_STREAM_DRAFT, payload);
    }
  }

  private emitEndOfTurn(text: string): void {
    const payload: DictationEndOfTurnEvent = { source: this.activeSource, text };
    debugLog('end-of-turn.emit', { textLength: text.length, source: this.activeSource });
    const w = BrowserWindow.getAllWindows()[0];
    if (w && !w.isDestroyed()) {
      w.webContents.send(IPC_CHANNELS.DICTATION_STREAM_END_OF_TURN, payload);
    }
  }

  private pushState(): void {
    const w = BrowserWindow.getAllWindows()[0];
    if (w && !w.isDestroyed()) {
      w.webContents.send(IPC_CHANNELS.DICTATION_STREAM_STATE, this.state);
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  /** Idempotent cleanup — safe to call from both stop() and error handler. */
  private finalizeNativeState(): void {
    if (this.cleanupDone) return;
    this.cleanupDone = true;
    this.emitDraft('');
    try { native.addon.moonshineSessionReset?.(); } catch { /* ignore */ }
    try { native.addon.stopRecording(); } catch { /* already stopped */ }
    audioStream.release('streaming');
    // Carry the active source onto the final idle state so source-filtering
    // listeners receive their idle event. Clear activeSource only after
    // the emit so the payload is correctly stamped.
    this.state = {
      status: 'idle',
      startedAt: null,
      chunkCount: 0,
      source: this.activeSource,
      engine: this.activeEngine,
    };
    this.pushState();
    this.activeSource = 'notes';
    this.activeEngine = 'unknown';
  }
}

export const dictationStreamer = new DictationStreamer();
