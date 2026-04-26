/**
 * DictationStreamer — chunked near-real-time dictation.
 *
 * Problem with single-shot dictation: the user had to stop talking and wait
 * for the whole buffer to transcribe before seeing any text. Feels laggy.
 *
 * Solution: same stop-restart chunk pattern the MeetingRecorder uses, but
 * with a much shorter chunk interval (~2.5s). Text appears in the editor
 * every couple of seconds as the user speaks, rather than all at the end.
 *
 * Trade-offs:
 *   - Whisper accuracy degrades slightly on very short clips. 2.5s is the
 *     practical floor before quality noticeably drops; words that straddle
 *     a chunk boundary may occasionally get misheard. Good enough for a
 *     notes workflow where the user is actively watching the screen.
 *   - The final chunk on stop captures the tail-end. No data is lost.
 *
 * We co-exist with the existing single-shot flow (useRecordingStore) — this
 * path is only taken when the renderer calls `startDictationStreaming`.
 */

import { BrowserWindow } from 'electron';
import { native } from './native-bridge';
import { IPC_CHANNELS } from '../shared/constants';
import {
  isAudioSilent,
  sanitizeTranscribedText,
  transcribeWithTimeout,
} from './transcribe-clean';
import { audioStream } from './audio-stream-manager';

/** Same timeout rationale as MeetingRecorder — don't let a hung Whisper call
 *  stall the 2.5s chunk loop. Dictation chunks are smaller so the timeout is
 *  tighter — 12s is well beyond legitimate transcribe time for 2.5s audio. */
const TRANSCRIBE_TIMEOUT_MS = 12_000;

export interface DictationChunkEvent {
  /** Monotonically increasing index, starting at 0 for the first chunk. */
  index: number;
  /** Raw transcribed text for this chunk (may be empty on silence). */
  text: string;
  /** True when this is the final chunk emitted on stop. */
  isFinal: boolean;
}

export interface DictationStreamState {
  status: 'idle' | 'recording' | 'stopping';
  startedAt: number | null;
  chunkCount: number;
}

/** Chunk interval — balance between latency and Whisper accuracy. */
const CHUNK_INTERVAL_MS = 2500;

class DictationStreamer {
  private chunkTimer: ReturnType<typeof setInterval> | null = null;
  private isProcessingChunk = false;
  private chunkIndex = 0;
  private state: DictationStreamState = {
    status: 'idle',
    startedAt: null,
    chunkCount: 0,
  };
  private fullText = '';

  isActive(): boolean {
    return this.state.status !== 'idle';
  }

  getFullText(): string {
    return this.fullText.trim();
  }

  async start(): Promise<void> {
    if (this.state.status !== 'idle') {
      throw new Error('Dictation is already active');
    }
    // Claim exclusive audio stream ownership before starting capture.
    audioStream.acquire('streaming');
    try {
      native.addon.startRecording();
    } catch (err: any) {
      audioStream.release('streaming');
      // Handle "already recording" — reset + retry once.
      if (err?.message?.includes('already')) {
        try { native.addon.resetPipelineState?.(); } catch { /* ignore */ }
        try {
          native.addon.startRecording();
        } catch (retryErr) {
          throw retryErr;
        }
      } else {
        throw err;
      }
    }

    this.chunkIndex = 0;
    this.fullText = '';
    this.state = { status: 'recording', startedAt: Date.now(), chunkCount: 0 };
    this.pushState();

    // Kick off the periodic drain loop.
    this.chunkTimer = setInterval(() => { void this.processChunk(); }, CHUNK_INTERVAL_MS);
  }

  async stop(): Promise<{ text: string; chunkCount: number }> {
    if (this.state.status === 'idle') {
      return { text: this.fullText.trim(), chunkCount: this.chunkIndex };
    }

    this.state = { ...this.state, status: 'stopping' };
    this.pushState();

    if (this.chunkTimer) {
      clearInterval(this.chunkTimer);
      this.chunkTimer = null;
    }

    try {
      // Wait for any in-flight chunk transcription to settle so we don't
      // double-run native.stopRecording.
      let waited = 0;
      while (this.isProcessingChunk && waited < 5000) {
        await new Promise(r => setTimeout(r, 50));
        waited += 50;
      }
      try { await this.processChunk(true /* isFinal */); }
      catch (err) { console.error('[DictationStreamer] Final chunk failed:', err); }

      return { text: this.fullText.trim(), chunkCount: this.chunkIndex };
    } finally {
      // Belt-and-braces: ensure the native recorder is stopped even if
      // processChunk(true) didn't reach the stop branch.
      try { native.addon.stopRecording(); } catch { /* already stopped */ }
      audioStream.release('streaming');
      this.state = { status: 'idle', startedAt: null, chunkCount: 0 };
      this.pushState();
    }
  }

  /**
   * Drain the audio buffer by stop→restart, transcribe the drained audio,
   * append the text to the running transcript, and push an event to the
   * renderer. On isFinal, we do NOT restart.
   */
  private async processChunk(isFinal = false): Promise<void> {
    if (this.isProcessingChunk && !isFinal) return;
    if (this.state.status === 'idle') return;
    this.isProcessingChunk = true;

    try {
      let audioBuffer: Buffer;
      try {
        audioBuffer = native.addon.stopRecording();
      } catch (err) {
        console.warn('[DictationStreamer] stopRecording mid-chunk failed:', err);
        return;
      }

      if (!isFinal) {
        // Immediately restart to keep capture gap-free.
        try { native.addon.startRecording(); }
        catch (err) {
          console.error('[DictationStreamer] Failed to restart after chunk drain:', err);
          this.state = { ...this.state, status: 'idle' };
          this.pushState();
          return;
        }
      }

      // ── Silence / low-energy gate (RMS-based) ──
      // Whisper hallucinates aggressively on silent audio. Skip the native
      // call entirely if the chunk is below the noise floor — both saves
      // CPU AND prevents "Thank you." / "[BLANK_AUDIO]" garbage from
      // appearing in the editor.
      if (isAudioSilent(audioBuffer)) {
        if (isFinal) this.emitChunk('', true);
        return;
      }

      // Timeout-guarded transcribe so a hung Whisper call can't freeze the
      // 2.5s chunk loop. On timeout we drop the chunk and carry on.
      const rawText = await transcribeWithTimeout(
        Promise.resolve(native.addon.transcribe(audioBuffer)),
        TRANSCRIBE_TIMEOUT_MS,
        'DictationStreamer.transcribe',
      );
      if (rawText == null) {
        if (isFinal) this.emitChunk('', true);
        return;
      }

      // Shared text hygiene — bracket markers, repetition loops, exact
      // hallucinations. Same filter as the meeting pipeline.
      const cleaned = sanitizeTranscribedText(rawText);
      if (cleaned) {
        this.fullText = (this.fullText + ' ' + cleaned).replace(/\s+/g, ' ').trim();
      }

      this.chunkIndex += 1;
      this.state = { ...this.state, chunkCount: this.chunkIndex };
      this.emitChunk(cleaned, isFinal);
    } finally {
      this.isProcessingChunk = false;
    }
  }

  private emitChunk(text: string, isFinal: boolean): void {
    const payload: DictationChunkEvent = {
      index: this.chunkIndex,
      text,
      isFinal,
    };
    const w = BrowserWindow.getAllWindows()[0];
    if (w && !w.isDestroyed()) {
      w.webContents.send(IPC_CHANNELS.DICTATION_STREAM_CHUNK, payload);
    }
  }

  private pushState(): void {
    const w = BrowserWindow.getAllWindows()[0];
    if (w && !w.isDestroyed()) {
      w.webContents.send(IPC_CHANNELS.DICTATION_STREAM_STATE, this.state);
    }
  }
}

// (Legacy inline sanitizer removed — replaced by the shared implementation
// in ./transcribe-clean, which adds RMS gating + repetition-loop detection.)

export const dictationStreamer = new DictationStreamer();
