/**
 * IntentClassifier — Classifies voice commands into structured intents.
 *
 * V1: Rule-based regex pattern matching (no ML model required).
 * V2 (future): Bi-LSTM model trained on synthetic data, with LLM fallback.
 *
 * After Whisper transcribes a voice command, this service parses it into
 * a structured intent + entities for the ActionRouter to execute.
 */

import { MLClient } from '../../workers/ml-client';
import type { IntentPrediction } from '../../workers/types';

export interface ClassifiedIntent {
  intent: string;
  confidence: number;
  entities: Record<string, { value: string; confidence: number }>;
  rawTranscript: string;
  source: 'rules' | 'model' | 'llm_fallback';
}

// Known intents
export const INTENTS = [
  'search', 'open_view', 'navigate', 'summarize',
  'create_ticket', 'update_ticket', 'assign', 'set_status',
  'add_label', 'comment',
] as const;
export type IntentType = typeof INTENTS[number];

// Known views for navigation
const VIEW_NAMES: Record<string, string> = {
  'timeline': 'timeline', 'home': 'timeline', 'feed': 'timeline',
  'editor': 'editor', 'note': 'editor', 'notes': 'notes',
  'search': 'search', 'find': 'search',
  'analytics': 'analytics', 'stats': 'analytics', 'dashboard': 'analytics',
  'settings': 'settings', 'preferences': 'settings', 'config': 'settings',
  'dictate': 'dictate', 'record': 'dictate',
  'listen': 'listen', 'playback': 'listen',
  'ai': 'ai-chat', 'chat': 'ai-chat', 'assistant': 'ai-chat',
};

// Rule-based patterns for V1
const INTENT_PATTERNS: Array<{
  intent: IntentType;
  patterns: RegExp[];
  entityExtractor?: (match: RegExpMatchArray, transcript: string) => Record<string, { value: string; confidence: number }>;
}> = [
  {
    intent: 'search',
    patterns: [
      /^(?:search|find|look\s+(?:for|up))\s+(.+)/i,
      /^(?:search|find)\s+(?:for\s+)?(.+)/i,
    ],
    entityExtractor: (match) => ({
      search_query: { value: match[1].trim(), confidence: 0.9 },
    }),
  },
  {
    intent: 'open_view',
    patterns: [
      /^(?:open|go\s+to|show|switch\s+to|navigate\s+to)\s+(?:the\s+)?(\w+)/i,
    ],
    entityExtractor: (match) => {
      const viewInput = match[1].toLowerCase();
      const resolved = VIEW_NAMES[viewInput] || viewInput;
      return {
        view_name: { value: resolved, confidence: VIEW_NAMES[viewInput] ? 0.95 : 0.6 },
      };
    },
  },
  {
    intent: 'navigate',
    patterns: [
      /^(?:go\s+(?:back|forward|home))/i,
      /^(?:take\s+me\s+to)\s+(.+)/i,
    ],
  },
  {
    intent: 'summarize',
    patterns: [
      /^(?:summarize|summary|recap|sum\s+up)\s*(?:of\s+)?(.+)?/i,
    ],
    entityExtractor: (match) => {
      if (match[1]) {
        return { search_query: { value: match[1].trim(), confidence: 0.8 } };
      }
      return {};
    },
  },
  {
    intent: 'create_ticket',
    patterns: [
      /^(?:create|make|add|new)\s+(?:a\s+)?(?:ticket|issue|task|bug|story)\s+(?:called|named|for|about)\s+(.+)/i,
      /^(?:create|make|add|new)\s+(?:a\s+)?(?:ticket|issue|task|bug|story)\s+(.+)/i,
    ],
    entityExtractor: (match) => ({
      ticket_name: { value: match[1].trim(), confidence: 0.85 },
    }),
  },
  {
    intent: 'assign',
    patterns: [
      /^(?:assign)\s+(?:this\s+)?(?:to|ticket\s+to)\s+(.+)/i,
    ],
    entityExtractor: (match) => ({
      assignee: { value: match[1].trim(), confidence: 0.8 },
    }),
  },
  {
    intent: 'set_status',
    patterns: [
      /^(?:set|change|update)\s+(?:the\s+)?status\s+(?:to\s+)?(.+)/i,
      /^(?:mark|move)\s+(?:this\s+)?(?:as\s+)?(.+)/i,
    ],
    entityExtractor: (match) => ({
      status: { value: match[1].trim(), confidence: 0.8 },
    }),
  },
  {
    intent: 'comment',
    patterns: [
      /^(?:add\s+(?:a\s+)?comment|comment)\s+(.+)/i,
    ],
    entityExtractor: (match) => ({
      comment_text: { value: match[1].trim(), confidence: 0.9 },
    }),
  },
];

// Correction phrases that indicate the user wants to undo/retry
const CORRECTION_PATTERNS = [
  /^(?:no|nope|cancel|undo|undo\s+that|never\s*mind)/i,
  /^(?:i\s+meant|i\s+mean|correction|actually)\s+(.+)/i,
  /^(?:that's\s+(?:not\s+)?(?:right|wrong|correct))/i,
];

export class IntentClassifier {
  private modelLoaded = false;
  private confidenceThreshold = 0.8;
  private llmFallbackEnabled = true;

  setConfidenceThreshold(threshold: number): void {
    this.confidenceThreshold = threshold;
  }

  setLLMFallbackEnabled(enabled: boolean): void {
    this.llmFallbackEnabled = enabled;
  }

  /**
   * Classify a transcript into a structured intent.
   * Tries rules first, then ML model, then LLM fallback.
   */
  async classify(transcript: string): Promise<ClassifiedIntent | null> {
    const trimmed = transcript.trim();
    if (!trimmed) return null;

    // 1. Try rule-based classification
    const ruleResult = this.classifyWithRules(trimmed);
    if (ruleResult && ruleResult.confidence >= this.confidenceThreshold) {
      return ruleResult;
    }

    // 2. Try ML model (if loaded)
    if (this.modelLoaded) {
      try {
        const modelResult = await this.classifyWithModel(trimmed);
        if (modelResult && modelResult.confidence >= this.confidenceThreshold) {
          return modelResult;
        }
      } catch (err) {
        console.warn('[IntentClassifier] Model inference failed:', err);
      }
    }

    // 3. If rule-based had a low-confidence match, return it
    if (ruleResult) {
      return ruleResult;
    }

    // 4. LLM fallback (if enabled)
    if (this.llmFallbackEnabled) {
      return this.classifyWithLLM(trimmed);
    }

    return null;
  }

  /**
   * Check if the transcript is a correction/undo command.
   */
  isCorrection(transcript: string): { isCorrection: boolean; correctedText?: string } {
    const trimmed = transcript.trim();
    for (const pattern of CORRECTION_PATTERNS) {
      const match = trimmed.match(pattern);
      if (match) {
        return {
          isCorrection: true,
          correctedText: match[1]?.trim(),
        };
      }
    }
    return { isCorrection: false };
  }

  /**
   * Log a classification result for future training.
   */
  async logSample(
    transcript: string,
    predicted: ClassifiedIntent,
    entryId?: string,
  ): Promise<void> {
    const ironmic = (window as any).ironmic;
    if (!ironmic?.intentSaveSample) return;

    try {
      await ironmic.intentSaveSample(
        transcript,
        predicted.intent,
        JSON.stringify(predicted.entities),
        predicted.confidence,
        entryId,
      );
    } catch (err) {
      console.warn('[IntentClassifier] Failed to log sample:', err);
    }
  }

  // ── Internal ──

  private classifyWithRules(transcript: string): ClassifiedIntent | null {
    for (const { intent, patterns, entityExtractor } of INTENT_PATTERNS) {
      for (const pattern of patterns) {
        const match = transcript.match(pattern);
        if (match) {
          const entities = entityExtractor ? entityExtractor(match, transcript) : {};
          return {
            intent,
            confidence: 0.85,
            entities,
            rawTranscript: transcript,
            source: 'rules',
          };
        }
      }
    }
    return null;
  }

  private async classifyWithModel(transcript: string): Promise<ClassifiedIntent | null> {
    // Simple tokenization: lowercase, split by whitespace, map to indices
    const tokens = transcript.toLowerCase().split(/\s+/).map((word) => {
      let hash = 0;
      for (let i = 0; i < word.length; i++) {
        hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0;
      }
      return Math.abs(hash) % 8000; // Vocabulary size
    });

    const result: IntentPrediction = await MLClient.classifyIntent(tokens);
    return {
      intent: result.intent,
      confidence: result.confidence,
      entities: {},
      rawTranscript: transcript,
      source: 'model',
    };
  }

  private async classifyWithLLM(transcript: string): Promise<ClassifiedIntent | null> {
    const ironmic = (window as any).ironmic;
    if (!ironmic?.polishText) return null;

    try {
      const prompt = `Classify this voice command into one of these intents: ${INTENTS.join(', ')}.
Return ONLY a JSON object: {"intent": "...", "entities": {}}

Voice command: "${transcript}"`;

      const response = await ironmic.polishText(prompt);
      // Try to parse JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.intent && INTENTS.includes(parsed.intent)) {
          return {
            intent: parsed.intent,
            confidence: 0.7,
            entities: parsed.entities || {},
            rawTranscript: transcript,
            source: 'llm_fallback',
          };
        }
      }
    } catch (err) {
      console.warn('[IntentClassifier] LLM fallback failed:', err);
    }

    return null;
  }
}

/** Singleton instance */
export const intentClassifier = new IntentClassifier();
