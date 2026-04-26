/**
 * AudioStreamManager — exclusive ownership of the native audio stream.
 *
 * Three callers compete for the same CaptureEngine:
 *   - 'dictation'  (ipc-handlers START/STOP_RECORDING)
 *   - 'meeting'    (MeetingRecorderManager)
 *   - 'streaming'  (DictationStreamer)
 *
 * Before any caller invokes native.startRecording() it must acquire()
 * the stream. acquire() throws immediately if another caller owns it,
 * so the error surfaces as an IPC rejection / toast rather than a
 * silent "already active" state corruption.
 *
 * The stop-restart chunk pattern used by meeting and streaming recorders
 * is allowed because the same owner is doing both operations; acquire()
 * is idempotent when called by the current owner.
 */

export type StreamOwner = 'dictation' | 'meeting' | 'streaming';

class AudioStreamManager {
  private owner: StreamOwner | null = null;

  /** Claim the stream. Throws if held by a different caller. */
  acquire(who: StreamOwner): void {
    if (this.owner !== null && this.owner !== who) {
      throw new Error(
        `Audio stream is already held by '${this.owner}'. Stop that recording first.`,
      );
    }
    this.owner = who;
  }

  /** Release the stream. No-op if caller is not the current owner. */
  release(who: StreamOwner): void {
    if (this.owner === who) {
      this.owner = null;
    }
  }

  /**
   * Force-clear the owner without touching the native layer.
   * Called by the reset-recording IPC when the stream is stuck.
   */
  forceReset(): void {
    this.owner = null;
  }

  currentOwner(): StreamOwner | null {
    return this.owner;
  }

  isIdle(): boolean {
    return this.owner === null;
  }
}

export const audioStream = new AudioStreamManager();
