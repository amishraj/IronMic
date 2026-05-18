/**
 * AudioBridge — Manages a Web Audio API pipeline for real-time audio analysis.
 *
 * Opens getUserMedia alongside the existing Rust/cpal capture,
 * creating a dual-pipeline where Rust owns the "official" recording
 * and this bridge provides real-time audio frames for VAD and turn detection.
 *
 * The bridge uses an AudioWorkletNode to forward PCM frames from the
 * audio render thread to the main renderer thread with minimal latency (~3ms).
 */

type FrameCallback = (frame: Float32Array, sampleRate: number) => void;

export class AudioBridge {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private frameCallbacks: FrameCallback[] = [];
  private active = false;
  private workletLoaded = false;

  // Recording buffer — accumulates frames when recording is active
  private recordingBuffer: Float32Array[] = [];
  private isRecordingAudio = false;

  /**
   * Start capturing audio from the microphone via Web Audio API.
   * Frames are forwarded to all registered callbacks.
   */
  async startStream(): Promise<void> {
    if (this.active) {
      console.warn('[AudioBridge] Stream already active');
      return;
    }

    try {
      // Request microphone access — use saved device preference if available
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: { ideal: 16000 },
      };
      try {
        const savedDeviceId = await (window as any).ironmic?.getSetting?.('input_device_id');
        if (savedDeviceId) {
          audioConstraints.deviceId = { ideal: savedDeviceId };
        }
      } catch { /* setting not available */ }
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });

      // Create AudioContext
      this.audioContext = new AudioContext({
        sampleRate: 16000, // Match Whisper's expected sample rate
      });

      // Connect pipeline: MediaStream -> Source -> analysis
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

      // Try AudioWorklet first (low latency), fall back to ScriptProcessor
      let workletConnected = false;
      if (!this.workletLoaded) {
        try {
          const workletUrl = new URL('./audio-worklet-processor.ts', import.meta.url);
          await this.audioContext.audioWorklet.addModule(workletUrl.href);
          this.workletLoaded = true;
        } catch (workletErr) {
          console.warn('[AudioBridge] AudioWorklet failed to load, using ScriptProcessor fallback:', workletErr);
        }
      }

      if (this.workletLoaded) {
        try {
          this.workletNode = new AudioWorkletNode(this.audioContext, 'audio-frame-forwarder');
          this.workletNode.port.onmessage = (event: MessageEvent) => {
            if (event.data?.type === 'AUDIO_FRAME' && event.data.frame) {
              const frame = event.data.frame as Float32Array;
              const sampleRate = this.audioContext?.sampleRate ?? 16000;
              this.dispatchFrame(frame, sampleRate);
            }
          };
          this.sourceNode.connect(this.workletNode);
          workletConnected = true;
        } catch (err) {
          console.warn('[AudioBridge] AudioWorkletNode creation failed:', err);
        }
      }

      // Fallback: ScriptProcessorNode (deprecated but universally supported)
      if (!workletConnected) {
        console.log('[AudioBridge] Using ScriptProcessor fallback for audio frames');
        const bufferSize = 2048;
        const scriptNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
        scriptNode.onaudioprocess = (e: AudioProcessingEvent) => {
          const input = e.inputBuffer.getChannelData(0);
          const frame = new Float32Array(input);
          const sampleRate = this.audioContext?.sampleRate ?? 16000;
          this.dispatchFrame(frame, sampleRate);
        };
        this.sourceNode.connect(scriptNode);
        scriptNode.connect(this.audioContext.destination);
        // Store reference for cleanup
        (this as any)._scriptNode = scriptNode;
      }

      this.active = true;
      console.log(`[AudioBridge] Stream started (sample rate: ${this.audioContext.sampleRate}Hz)`);
    } catch (err) {
      this.cleanup();
      throw err;
    }
  }

  /**
   * Stop the audio stream and release all resources.
   */
  stopStream(): void {
    if (!this.active) return;

    // Tell the worklet processor to stop
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'STOP' });
    }

    this.cleanup();
    this.active = false;
    console.log('[AudioBridge] Stream stopped');
  }

  /**
   * Register a callback to receive audio frames.
   * Each frame is a Float32Array of 128 samples at the AudioContext's sample rate.
   */
  onFrame(callback: FrameCallback): () => void {
    this.frameCallbacks.push(callback);
    return () => {
      this.frameCallbacks = this.frameCallbacks.filter((cb) => cb !== callback);
    };
  }

  /** Dispatch a frame to callbacks and optionally accumulate for recording. */
  private dispatchFrame(frame: Float32Array, sampleRate: number): void {
    if (this.isRecordingAudio) {
      this.recordingBuffer.push(new Float32Array(frame)); // Copy — original buffer gets reused
    }
    for (const cb of this.frameCallbacks) {
      cb(frame, sampleRate);
    }
  }

  /**
   * Start accumulating audio frames into a buffer for transcription.
   * Call this when the user starts recording.
   */
  startRecording(): void {
    this.recordingBuffer = [];
    this.isRecordingAudio = true;
    console.log('[AudioBridge] Recording buffer started');
  }

  /**
   * Stop accumulating and return the recorded audio as 16kHz mono PCM (Int16LE).
   * This is the format Whisper expects.
   */
  stopRecording(): { buffer: Uint8Array | null; durationSeconds: number } {
    this.isRecordingAudio = false;

    // Snapshot and clear the buffer atomically so no new frames arrive during processing
    const frames = this.recordingBuffer;
    this.recordingBuffer = [];

    if (frames.length === 0) {
      console.warn('[AudioBridge] Recording buffer is empty');
      return { buffer: null, durationSeconds: 0 };
    }

    // Concatenate all frames with bounds checking
    const totalSamples = frames.reduce((sum, f) => sum + f.length, 0);
    const sampleRate = this.audioContext?.sampleRate ?? 16000;
    const durationSeconds = totalSamples / sampleRate;

    // Safe frame concatenation helper
    const concatFrames = (dest: Float32Array, src: Float32Array[]) => {
      let offset = 0;
      for (const frame of src) {
        if (offset + frame.length > dest.length) break; // safety guard
        dest.set(frame, offset);
        offset += frame.length;
      }
    };

    // If AudioContext sample rate isn't 16kHz, we need to resample
    let samples: Float32Array;
    if (sampleRate === 16000) {
      samples = new Float32Array(totalSamples);
      concatFrames(samples, frames);
    } else {
      // Simple linear resampling to 16kHz
      const ratio = 16000 / sampleRate;
      const outputLen = Math.floor(totalSamples * ratio);
      samples = new Float32Array(outputLen);

      const input = new Float32Array(totalSamples);
      concatFrames(input, frames);

      for (let i = 0; i < outputLen; i++) {
        const srcIdx = i / ratio;
        const idx0 = Math.floor(srcIdx);
        const idx1 = Math.min(idx0 + 1, totalSamples - 1);
        const frac = srcIdx - idx0;
        samples[i] = input[idx0] * (1 - frac) + input[idx1] * frac;
      }
    }

    // Convert Float32 [-1, 1] to Int16LE bytes (Whisper's expected format)
    const pcmBytes = new ArrayBuffer(samples.length * 2);
    const pcmView = new DataView(pcmBytes);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      pcmView.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }

    const outputDuration = samples.length / 16000;
    console.log(`[AudioBridge] Recording buffer: ${totalSamples} samples @ ${sampleRate}Hz → ${samples.length} samples @ 16kHz (${outputDuration.toFixed(2)}s)`);

    return {
      buffer: new Uint8Array(pcmBytes),
      durationSeconds: outputDuration,
    };
  }

  /**
   * Check if the stream is currently active.
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Check if recording buffer is accumulating.
   */
  isRecording(): boolean {
    return this.isRecordingAudio;
  }

  /**
   * Get the current sample rate of the audio context.
   */
  getSampleRate(): number {
    return this.audioContext?.sampleRate ?? 16000;
  }

  /**
   * Check if Web Audio API and getUserMedia are available.
   */
  static isSupported(): boolean {
    return !!(
      typeof AudioContext !== 'undefined' &&
      typeof AudioWorkletNode !== 'undefined' &&
      navigator.mediaDevices?.getUserMedia
    );
  }

  private cleanup(): void {
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }

    // Clean up ScriptProcessor fallback if used
    if ((this as any)._scriptNode) {
      (this as any)._scriptNode.disconnect();
      (this as any)._scriptNode = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
      this.workletLoaded = false;
    }
  }
}

/** Singleton instance */
export const audioBridge = new AudioBridge();
