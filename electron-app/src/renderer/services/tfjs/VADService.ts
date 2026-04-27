/**
 * VADService — inert stub.
 *
 * The Web Audio + AudioBridge pipeline that drove this used to open a second
 * getUserMedia stream alongside the Rust/cpal capture, contending for WASAPI
 * exclusive access on Windows and producing silent dictations. Push-to-talk
 * (the only mode IronMic ships) doesn't need VAD: the user explicitly frames
 * the recording with the hotkey.
 *
 * The public surface is preserved so MeetingDetector and TurnDetector keep
 * compiling without changes, but every entry point is a no-op. start()
 * returns immediately, no callbacks ever fire, and stop() returns an empty
 * VADResult that won't trigger the skip-transcription path upstream.
 */

export type VoiceState = 'speech' | 'silence' | 'unknown';

export interface VADResult {
  totalSpeechMs: number;
  totalSilenceMs: number;
  speechSegments: Array<[number, number]>;
  hasSufficientSpeech: boolean;
}

type VoiceStateCallback = (state: VoiceState, speechProbability: number) => void;

export class VADService {
  isActive(): boolean { return false; }
  setSensitivity(_value: number): void { /* no-op */ }
  async start(): Promise<void> { /* no-op */ }
  stop(): VADResult {
    return {
      totalSpeechMs: 0,
      totalSilenceMs: 0,
      speechSegments: [],
      // Default true so any leftover caller doesn't suppress transcription.
      hasSufficientSpeech: true,
    };
  }
  onVoiceStateChange(_cb: VoiceStateCallback): () => void {
    return () => { /* nothing to unsubscribe */ };
  }
}

export const vadService = new VADService();
