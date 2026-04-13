/**
 * VoiceRouter — Context-aware routing of voice input.
 *
 * V1: Rule-based routing based on active screen and transcript keywords.
 * V2 (future): Small ML classifier taking screen context + text features.
 *
 * Routes voice input to one of four targets:
 * - dictation: Text goes to clipboard + entry store
 * - conversation: Text goes to AI Chat
 * - command: Text goes to IntentClassifier
 * - transcription: Text goes to entry store only
 */

import type { VoiceRoute } from '../../types';
import { intentClassifier, INTENTS } from './IntentClassifier';

export interface RoutingDecision {
  route: VoiceRoute;
  confidence: number;
  reason: string;
}

// Keywords that suggest a command
const COMMAND_KEYWORDS = [
  'search', 'find', 'look', 'open', 'go', 'show', 'switch', 'navigate',
  'create', 'make', 'add', 'new', 'assign', 'set', 'change', 'update',
  'mark', 'move', 'summarize', 'summary', 'recap', 'comment',
];

// Correction phrases
const CORRECTION_STARTERS = ['no', 'nope', 'cancel', 'undo', 'i meant', 'actually', 'correction'];

export class VoiceRouter {
  private enabled = false;
  private currentScreen: string = 'timeline';

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Update the current active screen. Called by Layout or view components.
   */
  setCurrentScreen(screen: string): void {
    this.currentScreen = screen;
  }

  getCurrentScreen(): string {
    return this.currentScreen;
  }

  /**
   * Determine where to route a voice input based on context.
   */
  route(transcript: string): RoutingDecision {
    if (!this.enabled) {
      // Default: route to dictation (existing behavior)
      return { route: 'dictation', confidence: 1.0, reason: 'Voice routing disabled — using default' };
    }

    const trimmed = transcript.trim().toLowerCase();
    const firstWord = trimmed.split(/\s+/)[0] || '';

    // 1. Check for corrections first — they should go to the same route as the original
    if (CORRECTION_STARTERS.some((s) => trimmed.startsWith(s))) {
      return { route: 'command', confidence: 0.9, reason: 'Correction detected' };
    }

    // 2. Route based on active screen
    switch (this.currentScreen) {
      case 'ai-chat':
        return { route: 'conversation', confidence: 0.95, reason: 'AI Chat screen is active' };

      case 'search':
        // On search page, input goes to search query
        return { route: 'command', confidence: 0.9, reason: 'Search screen is active' };

      case 'editor':
      case 'notes':
        return { route: 'dictation', confidence: 0.9, reason: 'Editor/Notes screen is active' };

      case 'listen':
        return { route: 'transcription', confidence: 0.85, reason: 'Listen/playback screen is active' };
    }

    // 3. Check if transcript looks like a command (keyword matching)
    if (COMMAND_KEYWORDS.includes(firstWord)) {
      return { route: 'command', confidence: 0.8, reason: `Starts with command keyword: "${firstWord}"` };
    }

    // 4. Default: dictation
    return { route: 'dictation', confidence: 0.7, reason: 'Default routing to dictation' };
  }

  /**
   * Log a routing decision for future ML training.
   */
  async logRouting(decision: RoutingDecision, entryId?: string): Promise<void> {
    const ironmic = (window as any).ironmic;
    if (!ironmic?.intentLogRouting) return;

    try {
      await ironmic.intentLogRouting(
        this.currentScreen,
        decision.reason,
        decision.route,
        entryId,
      );
    } catch {
      // Non-critical
    }
  }
}

/** Singleton instance */
export const voiceRouter = new VoiceRouter();
