/**
 * Shared type definitions for ML Web Worker communication.
 *
 * The ML Worker hosts all TF.js models and communicates with the renderer
 * via a typed postMessage protocol. The MLClient wraps this in Promises.
 */

// ── Model identifiers ──

export type MLModelId =
  | 'vad-silero'
  | 'turn-detector'
  | 'voice-router'
  | 'intent-classifier'
  | 'meeting-detector'
  | 'notification-ranker'
  | 'workflow-predictor'
  | 'universal-sentence-encoder';

// ── Messages: Renderer -> Worker ──

export interface InitModelMessage {
  type: 'INIT_MODEL';
  model: MLModelId;
  requestId: string;
  payload: {
    /** Model topology as JSON or ArrayBuffer */
    modelTopology?: ArrayBuffer | object;
    /** Weight manifest entries */
    weightSpecs?: unknown[];
    /** Concatenated weight data */
    weightData?: ArrayBuffer;
    /** File URL path (alternative to in-memory loading) */
    modelUrl?: string;
    /** Model configuration */
    config?: Record<string, unknown>;
  };
}

export interface PredictMessage {
  type: 'PREDICT';
  model: MLModelId;
  requestId: string;
  payload: {
    /** Input data — shape depends on model */
    input: Float32Array | number[] | string | string[];
    /** Optional parameters for this prediction */
    options?: Record<string, unknown>;
  };
}

export interface TrainMessage {
  type: 'TRAIN';
  model: MLModelId;
  requestId: string;
  payload: {
    /** Training inputs */
    inputs: Float32Array | number[][];
    /** Training labels */
    labels: Float32Array | number[][];
    /** Training configuration */
    config: {
      epochs?: number;
      batchSize?: number;
      learningRate?: number;
    };
  };
}

export interface GetWeightsMessage {
  type: 'GET_WEIGHTS';
  model: MLModelId;
  requestId: string;
}

export interface LoadWeightsMessage {
  type: 'LOAD_WEIGHTS';
  model: MLModelId;
  requestId: string;
  payload: {
    weightsJson: string;
    metadataJson?: string;
  };
}

export interface DisposeModelMessage {
  type: 'DISPOSE_MODEL';
  model: MLModelId;
  requestId: string;
}

export interface PingMessage {
  type: 'PING';
  requestId: string;
}

export type WorkerInMessage =
  | InitModelMessage
  | PredictMessage
  | TrainMessage
  | GetWeightsMessage
  | LoadWeightsMessage
  | DisposeModelMessage
  | PingMessage;

// ── Messages: Worker -> Renderer ──

export interface ResultMessage {
  type: 'RESULT';
  requestId: string;
  payload: unknown;
}

export interface ErrorMessage {
  type: 'ERROR';
  requestId: string;
  error: string;
}

export interface ProgressMessage {
  type: 'PROGRESS';
  model: MLModelId;
  requestId: string;
  progress: number; // 0.0 - 1.0
  message?: string;
}

export interface ReadyMessage {
  type: 'READY';
}

export type WorkerOutMessage =
  | ResultMessage
  | ErrorMessage
  | ProgressMessage
  | ReadyMessage;

// ── Prediction result types (per model) ──

export interface VADPrediction {
  speechProbability: number;
  isSpeech: boolean;
}

export interface TurnDetectionPrediction {
  endOfTurn: number;
  thinkingPause: number;
  continueListening: number;
}

export interface VoiceRoutePrediction {
  dictation: number;
  conversation: number;
  command: number;
  transcription: number;
}

export interface IntentPrediction {
  intent: string;
  confidence: number;
  entities: Record<string, { value: string; confidence: number; span: [number, number] }>;
}

export interface NotificationScore {
  engagementProbability: number;
  reason: string;
}

export interface WorkflowPrediction {
  nextAction: string;
  confidence: number;
  alternatives: Array<{ action: string; confidence: number }>;
}

export interface EmbeddingResult {
  embedding: Float32Array;
  dimensions: number;
}

export interface SimilarityResult {
  contentId: string;
  contentType: string;
  score: number;
}
