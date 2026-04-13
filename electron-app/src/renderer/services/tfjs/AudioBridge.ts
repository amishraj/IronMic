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
      // Request microphone access
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: { ideal: 16000 },
        },
      });

      // Create AudioContext
      this.audioContext = new AudioContext({
        sampleRate: 16000, // Match Whisper's expected sample rate
      });

      // Load the AudioWorklet processor module
      if (!this.workletLoaded) {
        // The worklet processor is bundled as a separate asset by Vite
        const workletUrl = new URL('./audio-worklet-processor.ts', import.meta.url);
        await this.audioContext.audioWorklet.addModule(workletUrl.href);
        this.workletLoaded = true;
      }

      // Connect the pipeline: MediaStream -> Source -> Worklet
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.workletNode = new AudioWorkletNode(this.audioContext, 'audio-frame-forwarder');

      // Listen for frames from the worklet
      this.workletNode.port.onmessage = (event: MessageEvent) => {
        if (event.data?.type === 'AUDIO_FRAME' && event.data.frame) {
          const frame = event.data.frame as Float32Array;
          const sampleRate = this.audioContext?.sampleRate ?? 16000;
          for (const cb of this.frameCallbacks) {
            cb(frame, sampleRate);
          }
        }
      };

      // Connect nodes
      this.sourceNode.connect(this.workletNode);
      // Don't connect worklet to destination — we don't want to hear ourselves
      // The worklet processes audio but doesn't output anything

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

  /**
   * Check if the stream is currently active.
   */
  isActive(): boolean {
    return this.active;
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
