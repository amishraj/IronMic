/**
 * VADService — Voice Activity Detection using Silero VAD model.
 *
 * Runs during recording to classify each audio frame as speech or silence.
 * Integrates with AudioBridge for real-time frames and MLClient for inference.
 *
 * Key behaviors:
 * - Speech must persist >200ms to count (debounce transient noise)
 * - Silence must persist >500ms to trigger silence event
 * - Tracks total speech duration for skip-if-empty optimization
 * - Emits real-time voice state changes for UI indicators
 */

import { audioBridge } from './AudioBridge';
import { MLClient } from '../../workers/ml-client';

export type VoiceState = 'speech' | 'silence' | 'unknown';

export interface VADResult {
  /** Total milliseconds of detected speech */
  totalSpeechMs: number;
  /** Total milliseconds of detected silence */
  totalSilenceMs: number;
  /** Speech segments as [startMs, endMs] pairs */
  speechSegments: Array<[number, number]>;
  /** Whether enough speech was detected to warrant transcription */
  hasSufficientSpeech: boolean;
}

type VoiceStateCallback = (state: VoiceState, speechProbability: number) => void;

const SPEECH_DEBOUNCE_MS = 200;
const SILENCE_DEBOUNCE_MS = 500;
const MIN_SPEECH_MS = 500; // Minimum speech to be worth transcribing

// Frame accumulation for Silero VAD — it expects 512 samples at 16kHz (32ms)
const SILERO_FRAME_SAMPLES = 512;
const SILERO_SAMPLE_RATE = 16000;

export class VADService {
  private active = false;
  private streamRunning = false;
  private modelLoaded = false;
  private sensitivity = 0.5;
  private stateCallbacks: VoiceStateCallback[] = [];
  private unsubFrame: (() => void) | null = null;

  // Tracking state
  private currentState: VoiceState = 'unknown';
  private stateStartTime = 0;
  private pendingState: VoiceState = 'unknown';
  private pendingStateStart = 0;

  // Accumulation
  private totalSpeechMs = 0;
  private totalSilenceMs = 0;
  private speechSegments: Array<[number, number]> = [];
  private currentSpeechStart = -1;
  private startTime = 0;

  // Frame buffer — accumulate 128-sample AudioWorklet frames into 512-sample Silero frames
  private frameBuffer = new Float32Array(SILERO_FRAME_SAMPLES);
  private frameBufferOffset = 0;

  /**
   * Load the VAD model into the ML Worker.
   * Call once at app startup or on first use.
   */
  async loadModel(): Promise<void> {
    if (this.modelLoaded) return;

    try {
      // Ensure ML Worker is initialized
      await MLClient.init();

      // For now, initialize with a URL path — will be replaced with in-memory loading
      // when actual Silero VAD model is bundled
      const ironmic = (window as any).ironmic;
      const modelsDir = ironmic?.getModelsDir ? await ironmic.getModelsDir() : '';

      if (modelsDir) {
        await MLClient.initModel('vad-silero', {
          modelUrl: `file://${modelsDir}/tfjs/vad-silero/model.json`,
          config: { sampleRate: SILERO_SAMPLE_RATE, frameSamples: SILERO_FRAME_SAMPLES },
        });
        this.modelLoaded = true;
        console.log('[VADService] Silero VAD model loaded');
      } else {
        console.warn('[VADService] Models directory not available — VAD will use energy-based fallback');
      }
    } catch (err) {
      console.warn('[VADService] Failed to load VAD model, using energy-based fallback:', err);
    }
  }

  /**
   * Set the speech detection sensitivity threshold.
   * @param sensitivity 0.0 (less sensitive) to 1.0 (more sensitive)
   */
  setSensitivity(sensitivity: number): void {
    this.sensitivity = Math.max(0, Math.min(1, sensitivity));
  }

  /**
   * Start VAD processing. Opens the AudioBridge and begins classifying frames.
   */
  async start(): Promise<void> {
    if (this.active) return;

    // Reset tracking state
    this.totalSpeechMs = 0;
    this.totalSilenceMs = 0;
    this.speechSegments = [];
    this.currentSpeechStart = -1;
    this.currentState = 'unknown';
    this.pendingState = 'unknown';
    this.frameBufferOffset = 0;
    this.startTime = Date.now();

    // Start audio stream
    try {
      await audioBridge.startStream();
      this.streamRunning = true;
    } catch (err) {
      console.warn('[VADService] Failed to start audio stream — VAD disabled for this recording:', err);
      // Mark active so stop() returns a result, but leave streamRunning=false
      // so stop() knows it never got any frames and won't falsely gate
      // transcription on "insufficient speech".
      this.active = true;
      this.streamRunning = false;
      return;
    }

    // Subscribe to audio frames
    this.unsubFrame = audioBridge.onFrame((frame, _sampleRate) => {
      this.processFrame(frame);
    });

    this.active = true;
    console.log('[VADService] Started');
  }

  /**
   * Stop VAD processing and return the analysis result.
   */
  stop(): VADResult {
    if (!this.active) {
      return {
        totalSpeechMs: 0,
        totalSilenceMs: 0,
        speechSegments: [],
        hasSufficientSpeech: false,
      };
    }

    // Close current speech segment if active
    if (this.currentSpeechStart >= 0) {
      const elapsed = Date.now() - this.startTime;
      this.speechSegments.push([this.currentSpeechStart, elapsed]);
      this.totalSpeechMs += elapsed - this.currentSpeechStart;
      this.currentSpeechStart = -1;
    }

    // Cleanup
    if (this.unsubFrame) {
      this.unsubFrame();
      this.unsubFrame = null;
    }
    if (this.streamRunning) {
      audioBridge.stopStream();
    }
    const streamDidRun = this.streamRunning;
    this.streamRunning = false;
    this.active = false;

    // If the VAD stream never started, OR it started but never actually
    // delivered any frames (broken AudioWorklet in a packaged build, mic
    // contended by Rust/cpal, etc.), don't gate transcription on a bogus
    // 0ms speech reading — let Whisper decide. Otherwise silent VAD ==
    // silent dictation, which looks like the app is broken.
    const gotFrames = this.totalSpeechMs + this.totalSilenceMs > 0;
    const hasSufficientSpeech = streamDidRun && gotFrames
      ? this.totalSpeechMs >= MIN_SPEECH_MS
      : true;

    const result: VADResult = {
      totalSpeechMs: this.totalSpeechMs,
      totalSilenceMs: this.totalSilenceMs,
      speechSegments: this.speechSegments,
      hasSufficientSpeech,
    };

    console.log(`[VADService] Stopped — speech: ${this.totalSpeechMs}ms, silence: ${this.totalSilenceMs}ms, segments: ${this.speechSegments.length}`);
    return result;
  }

  /**
   * Register a callback for real-time voice state changes.
   */
  onVoiceStateChange(callback: VoiceStateCallback): () => void {
    this.stateCallbacks.push(callback);
    return () => {
      this.stateCallbacks = this.stateCallbacks.filter((cb) => cb !== callback);
    };
  }

  /**
   * Check if VAD is currently running.
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Get the current voice state.
   */
  getCurrentState(): VoiceState {
    return this.currentState;
  }

  // ── Internal ──

  private processFrame(frame: Float32Array): void {
    // Accumulate into Silero-sized frames
    const remaining = SILERO_FRAME_SAMPLES - this.frameBufferOffset;
    const toCopy = Math.min(frame.length, remaining);

    this.frameBuffer.set(frame.subarray(0, toCopy), this.frameBufferOffset);
    this.frameBufferOffset += toCopy;

    if (this.frameBufferOffset >= SILERO_FRAME_SAMPLES) {
      // We have a full frame — classify it
      this.classifyFrame(new Float32Array(this.frameBuffer));
      this.frameBufferOffset = 0;

      // Handle leftover samples from this frame
      if (toCopy < frame.length) {
        const leftover = frame.subarray(toCopy);
        this.frameBuffer.set(leftover);
        this.frameBufferOffset = leftover.length;
      }
    }
  }

  private async classifyFrame(frame: Float32Array): Promise<void> {
    let isSpeech: boolean;
    let probability: number;

    if (this.modelLoaded) {
      // Use ML model
      try {
        const result = await MLClient.predictVAD(frame, 1 - this.sensitivity);
        isSpeech = result.isSpeech;
        probability = result.speechProbability;
      } catch {
        // Fallback to energy-based detection
        const energy = this.computeEnergy(frame);
        probability = Math.min(1, energy / 0.01);
        isSpeech = probability >= (1 - this.sensitivity);
      }
    } else {
      // Energy-based fallback (no model available)
      const energy = this.computeEnergy(frame);
      probability = Math.min(1, energy / 0.01);
      isSpeech = probability >= (1 - this.sensitivity);
    }

    const newState: VoiceState = isSpeech ? 'speech' : 'silence';
    const now = Date.now();
    const elapsed = now - this.startTime;

    // Debounce state transitions
    if (newState !== this.pendingState) {
      this.pendingState = newState;
      this.pendingStateStart = now;
    }

    const pendingDuration = now - this.pendingStateStart;
    const debounceMs = newState === 'speech' ? SPEECH_DEBOUNCE_MS : SILENCE_DEBOUNCE_MS;

    if (this.pendingState !== this.currentState && pendingDuration >= debounceMs) {
      const prevState = this.currentState;
      this.currentState = this.pendingState;

      // Track segments
      if (this.currentState === 'speech' && prevState !== 'speech') {
        this.currentSpeechStart = elapsed;
      } else if (this.currentState === 'silence' && prevState === 'speech' && this.currentSpeechStart >= 0) {
        this.speechSegments.push([this.currentSpeechStart, elapsed]);
        this.totalSpeechMs += elapsed - this.currentSpeechStart;
        this.currentSpeechStart = -1;
      }

      if (this.currentState === 'silence') {
        this.totalSilenceMs += debounceMs; // approximate
      }

      // Notify listeners
      for (const cb of this.stateCallbacks) {
        cb(this.currentState, probability);
      }
    }
  }

  /**
   * Simple RMS energy computation for fallback VAD when no model is available.
   */
  private computeEnergy(frame: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) {
      sum += frame[i] * frame[i];
    }
    return Math.sqrt(sum / frame.length);
  }
}

/** Singleton instance */
export const vadService = new VADService();
