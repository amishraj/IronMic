/**
 * AudioWorkletProcessor that forwards raw PCM audio frames to the main thread.
 *
 * This runs on the audio render thread with ~3ms latency at 48kHz/128 samples.
 * It does NOT process audio — it just relays frames for VAD/turn detection
 * to consume via the MLClient.
 *
 * IMPORTANT: This file must be loaded separately via audioContext.audioWorklet.addModule().
 * It cannot import from other modules since AudioWorkletProcessor runs in a
 * special isolated scope.
 */

class AudioFrameForwarder extends AudioWorkletProcessor {
  private active = true;

  constructor() {
    super();

    // Listen for control messages from the main thread
    this.port.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'STOP') {
        this.active = false;
      }
    };
  }

  process(
    inputs: Float32Array[][],
    _outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    if (!this.active) return false;

    // inputs[0] is the first input, inputs[0][0] is the first channel (mono)
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return this.active;
    }

    // Send a copy of the audio frame to the main thread
    // We copy because the AudioWorklet buffer is reused
    const frame = new Float32Array(input[0]);
    this.port.postMessage({ type: 'AUDIO_FRAME', frame }, [frame.buffer]);

    return this.active;
  }
}

registerProcessor('audio-frame-forwarder', AudioFrameForwarder);
