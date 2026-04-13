/**
 * useIntentStore — Manages intent classification state and voice command execution.
 */

import { create } from 'zustand';
import { intentClassifier, type ClassifiedIntent } from '../services/tfjs/IntentClassifier';
import { actionRouter, type ActionResult } from '../services/ActionRouter';

interface IntentStore {
  /** Whether intent classification is enabled */
  enabled: boolean;
  /** The last classified intent */
  lastIntent: ClassifiedIntent | null;
  /** The last action result */
  lastActionResult: ActionResult | null;
  /** Whether a correction is pending */
  correctionPending: boolean;
  /** Number of corrections collected for training */
  correctionCount: number;

  setEnabled: (enabled: boolean) => void;
  /** Classify and optionally execute a transcript as a voice command */
  processCommand: (transcript: string) => Promise<ActionResult | null>;
  /** Clear the last intent/action */
  clear: () => void;
  /** Load settings */
  loadFromSettings: () => Promise<void>;
}

export const useIntentStore = create<IntentStore>((set, get) => ({
  enabled: false,
  lastIntent: null,
  lastActionResult: null,
  correctionPending: false,
  correctionCount: 0,

  setEnabled: (enabled) => set({ enabled }),

  processCommand: async (transcript: string) => {
    if (!get().enabled) return null;

    // Check if this is a correction
    const correction = intentClassifier.isCorrection(transcript);
    if (correction.isCorrection) {
      // Undo last action
      await actionRouter.undo();
      set({ correctionPending: false });

      // If there's corrected text, re-classify it
      if (correction.correctedText) {
        const intent = await intentClassifier.classify(correction.correctedText);
        if (intent) {
          const result = await actionRouter.execute(intent);
          set({ lastIntent: intent, lastActionResult: result });
          await intentClassifier.logSample(correction.correctedText, intent);
          return result;
        }
      }
      return null;
    }

    // Normal classification
    const intent = await intentClassifier.classify(transcript);
    if (!intent) {
      set({ lastIntent: null, lastActionResult: null });
      return null;
    }

    // Execute the action
    const result = await actionRouter.execute(intent);
    set({
      lastIntent: intent,
      lastActionResult: result,
      correctionPending: true,
    });

    // Log for training
    await intentClassifier.logSample(transcript, intent);

    return result;
  },

  clear: () => set({ lastIntent: null, lastActionResult: null, correctionPending: false }),

  loadFromSettings: async () => {
    const ironmic = (window as any).ironmic;
    if (!ironmic) return;

    const enabled = (await ironmic.getSetting('intent_classification_enabled')) === 'true';
    const llmFallback = (await ironmic.getSetting('intent_llm_fallback')) !== 'false';
    intentClassifier.setLLMFallbackEnabled(llmFallback);
    set({ enabled });

    // Load correction count
    try {
      const count = await ironmic.intentGetCorrectionCount();
      set({ correctionCount: count });
    } catch { /* non-critical */ }
  },
}));
