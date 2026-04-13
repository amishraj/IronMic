/**
 * useTurnDetectionStore — Manages turn detection mode and the
 * hands-free conversational loop (auto-stop → transcribe → AI → TTS → resume).
 */

import { create } from 'zustand';
import { turnDetector, type TurnEvent } from '../services/tfjs/TurnDetector';
import { useRecordingStore } from './useRecordingStore';
import type { TurnDetectionMode } from '../types';

interface TurnDetectionStore {
  mode: TurnDetectionMode;
  timeoutMs: number;
  /** Whether the conversation loop is currently active */
  conversationLoopActive: boolean;
  /** Whether we're waiting for TTS to finish before resuming recording */
  waitingForTTS: boolean;

  setMode: (mode: TurnDetectionMode) => Promise<void>;
  setTimeoutMs: (ms: number) => Promise<void>;
  /** Start the conversation loop (for auto-detect and always-listening modes) */
  startConversationLoop: (sourceApp?: string) => void;
  /** Stop the conversation loop */
  stopConversationLoop: () => void;
  /** Called when TTS finishes playing — resumes recording if in loop */
  onTTSComplete: () => void;
  /** Initialize from settings */
  loadFromSettings: () => Promise<void>;
}

let unsubTurnEvent: (() => void) | null = null;
let loopSourceApp: string | undefined;

export const useTurnDetectionStore = create<TurnDetectionStore>((set, get) => ({
  mode: 'push-to-talk',
  timeoutMs: 3000,
  conversationLoopActive: false,
  waitingForTTS: false,

  setMode: async (mode) => {
    set({ mode });
    turnDetector.setMode(mode);
    const ironmic = (window as any).ironmic;
    if (ironmic) await ironmic.setSetting('turn_detection_mode', mode);
  },

  setTimeoutMs: async (ms) => {
    set({ timeoutMs: ms });
    turnDetector.setTimeoutMs(ms);
    const ironmic = (window as any).ironmic;
    if (ironmic) await ironmic.setSetting('turn_detection_timeout_ms', String(ms));
  },

  startConversationLoop: (sourceApp?: string) => {
    const { mode, timeoutMs } = get();
    if (mode === 'push-to-talk') return;

    loopSourceApp = sourceApp;
    turnDetector.setMode(mode);
    turnDetector.setTimeoutMs(timeoutMs);

    // Subscribe to turn events
    if (unsubTurnEvent) unsubTurnEvent();
    unsubTurnEvent = turnDetector.onTurnEvent((event: TurnEvent) => {
      if (event === 'end-of-turn') {
        handleEndOfTurn();
      }
    });

    // Start turn detection (VAD must be active)
    turnDetector.start();
    set({ conversationLoopActive: true, waitingForTTS: false });
    console.log(`[TurnDetection] Conversation loop started (mode: ${mode})`);
  },

  stopConversationLoop: () => {
    turnDetector.stop();
    if (unsubTurnEvent) {
      unsubTurnEvent();
      unsubTurnEvent = null;
    }
    loopSourceApp = undefined;
    set({ conversationLoopActive: false, waitingForTTS: false });
    console.log('[TurnDetection] Conversation loop stopped');
  },

  onTTSComplete: () => {
    const { conversationLoopActive, waitingForTTS, mode } = get();
    if (!conversationLoopActive || !waitingForTTS) return;

    set({ waitingForTTS: false });

    // Resume recording for the next turn
    if (mode === 'auto-detect' || mode === 'always-listening') {
      console.log('[TurnDetection] TTS complete — resuming recording for next turn');
      // Small delay to avoid capturing TTS audio bleed
      setTimeout(() => {
        const recording = useRecordingStore.getState();
        if (recording.state === 'idle') {
          recording.handleHotkeyPress(loopSourceApp);
        }
      }, 300);
    }
  },

  loadFromSettings: async () => {
    const ironmic = (window as any).ironmic;
    if (!ironmic) return;

    const mode = (await ironmic.getSetting('turn_detection_mode')) || 'push-to-talk';
    const timeoutMs = parseInt((await ironmic.getSetting('turn_detection_timeout_ms')) || '3000', 10);

    set({ mode: mode as TurnDetectionMode, timeoutMs });
    turnDetector.setMode(mode as TurnDetectionMode);
    turnDetector.setTimeoutMs(timeoutMs);
  },
}));

/**
 * Handle end-of-turn: auto-stop recording, which triggers the
 * normal transcription → AI → TTS pipeline in useRecordingStore.
 */
function handleEndOfTurn(): void {
  const recording = useRecordingStore.getState();
  if (recording.state !== 'recording') return;

  console.log('[TurnDetection] End of turn detected — auto-stopping recording');
  useTurnDetectionStore.setState({ waitingForTTS: true });

  // Trigger stop, which runs the full pipeline (transcribe → AI → TTS)
  recording.handleHotkeyPress(loopSourceApp);
}
