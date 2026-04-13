/**
 * TurnDetector — Detects when the user has finished speaking.
 *
 * V1: Rule-based (silence timeout). When silence exceeds the configured
 * threshold (default 3s), triggers an end-of-turn event.
 *
 * V2 (future): ML-based GRU model that distinguishes "thinking pause"
 * from "done speaking" based on learned user patterns.
 *
 * Integrates with VADService for real-time speech/silence state.
 */

import { vadService, type VoiceState } from './VADService';
import type { TurnDetectionMode } from '../../types';

export type TurnEvent = 'end-of-turn' | 'thinking-pause' | 'continue-listening';

type TurnEventCallback = (event: TurnEvent) => void;

export class TurnDetector {
  private mode: TurnDetectionMode = 'push-to-talk';
  private timeoutMs = 3000;
  private active = false;
  private eventCallbacks: TurnEventCallback[] = [];
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubVAD: (() => void) | null = null;
  private lastSpeechTime = 0;

  /**
   * Set the detection mode.
   */
  setMode(mode: TurnDetectionMode): void {
    this.mode = mode;
  }

  /**
   * Set the silence timeout in milliseconds.
   */
  setTimeoutMs(ms: number): void {
    this.timeoutMs = Math.max(500, Math.min(30000, ms));
  }

  /**
   * Get the current mode.
   */
  getMode(): TurnDetectionMode {
    return this.mode;
  }

  /**
   * Start monitoring for end-of-turn.
   * Requires VADService to be active.
   */
  start(): void {
    if (this.active || this.mode === 'push-to-talk') return;

    this.active = true;
    this.lastSpeechTime = Date.now();

    // Subscribe to VAD state changes
    this.unsubVAD = vadService.onVoiceStateChange((state: VoiceState) => {
      this.handleVADState(state);
    });

    console.log(`[TurnDetector] Started (mode: ${this.mode}, timeout: ${this.timeoutMs}ms)`);
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    if (!this.active) return;

    this.clearSilenceTimer();
    if (this.unsubVAD) {
      this.unsubVAD();
      this.unsubVAD = null;
    }
    this.active = false;
    console.log('[TurnDetector] Stopped');
  }

  /**
   * Register a callback for turn events.
   */
  onTurnEvent(callback: TurnEventCallback): () => void {
    this.eventCallbacks.push(callback);
    return () => {
      this.eventCallbacks = this.eventCallbacks.filter((cb) => cb !== callback);
    };
  }

  /**
   * Check if the detector is actively monitoring.
   */
  isActive(): boolean {
    return this.active;
  }

  // ── Internal ──

  private handleVADState(state: VoiceState): void {
    if (!this.active) return;

    if (state === 'speech') {
      // User is speaking — reset the silence timer
      this.lastSpeechTime = Date.now();
      this.clearSilenceTimer();
    } else if (state === 'silence') {
      // Silence detected — start/reset the silence timer
      if (!this.silenceTimer) {
        this.silenceTimer = setTimeout(() => {
          this.handleSilenceTimeout();
        }, this.timeoutMs);
      }
    }
  }

  private handleSilenceTimeout(): void {
    this.silenceTimer = null;

    if (!this.active) return;

    const silenceDuration = Date.now() - this.lastSpeechTime;

    // V1 rule-based: if silence exceeds timeout, it's end-of-turn
    if (silenceDuration >= this.timeoutMs) {
      this.emit('end-of-turn');
    }
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private emit(event: TurnEvent): void {
    for (const cb of this.eventCallbacks) {
      cb(event);
    }
  }
}

/** Singleton instance */
export const turnDetector = new TurnDetector();
