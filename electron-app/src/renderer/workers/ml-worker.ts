/**
 * ML Web Worker — Hosts all TF.js models for non-blocking inference.
 *
 * Runs with CPU backend (Web Workers don't have WebGL access).
 * For the small models used here (<30MB), CPU inference is fast enough
 * (sub-50ms for all models except USE which is ~100ms per sentence).
 *
 * Communication protocol: typed messages defined in ./types.ts
 */

import * as tf from '@tensorflow/tfjs';
import type {
  WorkerInMessage,
  WorkerOutMessage,
  MLModelId,
  VADPrediction,
  EmbeddingResult,
  SimilarityResult,
  IntentPrediction,
  NotificationScore,
  TurnDetectionPrediction,
  VoiceRoutePrediction,
  WorkflowPrediction,
} from './types';

// ── State ──

const models = new Map<MLModelId, tf.LayersModel | tf.GraphModel>();
const modelConfigs = new Map<MLModelId, Record<string, unknown>>();

// ── Initialization ──

async function initTFJS(): Promise<void> {
  await tf.setBackend('cpu');
  await tf.ready();
  console.log('[ML Worker] TF.js ready with CPU backend');
}

// ── Model Management ──

async function initModel(
  modelId: MLModelId,
  payload: {
    modelTopology?: ArrayBuffer | object;
    weightSpecs?: unknown[];
    weightData?: ArrayBuffer;
    modelUrl?: string;
    config?: Record<string, unknown>;
  }
): Promise<void> {
  if (models.has(modelId)) {
    console.log(`[ML Worker] Model ${modelId} already loaded`);
    return;
  }

  let model: tf.LayersModel | tf.GraphModel;

  if (payload.modelTopology && payload.weightSpecs && payload.weightData) {
    // Load from in-memory artifacts (sent from main process via renderer)
    const handler = tf.io.fromMemory(
      payload.modelTopology,
      payload.weightSpecs as tf.io.WeightsManifestEntry[],
      payload.weightData
    );
    // Try GraphModel first, fall back to LayersModel
    try {
      model = await tf.loadGraphModel(handler);
    } catch {
      const handler2 = tf.io.fromMemory(
        payload.modelTopology,
        payload.weightSpecs as tf.io.WeightsManifestEntry[],
        payload.weightData
      );
      model = await tf.loadLayersModel(handler2);
    }
  } else if (payload.modelUrl) {
    // Load from URL (file:// or http:// for dev)
    try {
      model = await tf.loadGraphModel(payload.modelUrl);
    } catch {
      model = await tf.loadLayersModel(payload.modelUrl);
    }
  } else {
    throw new Error(`No model source provided for ${modelId}`);
  }

  models.set(modelId, model);
  if (payload.config) {
    modelConfigs.set(modelId, payload.config);
  }
  console.log(`[ML Worker] Loaded model: ${modelId}`);
}

function getModel(modelId: MLModelId): tf.LayersModel | tf.GraphModel {
  const model = models.get(modelId);
  if (!model) {
    throw new Error(`Model ${modelId} is not loaded. Call INIT_MODEL first.`);
  }
  return model;
}

// ── Prediction Dispatchers ──

async function predict(
  modelId: MLModelId,
  input: Float32Array | number[] | string | string[],
  options?: Record<string, unknown>
): Promise<unknown> {
  switch (modelId) {
    case 'vad-silero':
      return predictVAD(input as Float32Array, options);
    case 'turn-detector':
      return predictTurnDetection(input as Float32Array, options);
    case 'voice-router':
      return predictVoiceRoute(input as Float32Array, options);
    case 'intent-classifier':
      return predictIntent(input as number[], options);
    case 'notification-ranker':
      return predictNotificationScore(input as Float32Array, options);
    case 'workflow-predictor':
      return predictWorkflow(input as Float32Array, options);
    case 'universal-sentence-encoder':
      return predictEmbedding(input as string | string[], options);
    default:
      throw new Error(`Unknown model: ${modelId}`);
  }
}

// ── Model-specific prediction functions ──

async function predictVAD(
  audioFrame: Float32Array,
  _options?: Record<string, unknown>
): Promise<VADPrediction> {
  const model = getModel('vad-silero');
  const inputTensor = tf.tensor(audioFrame).reshape([1, -1]);
  const result = model.predict(inputTensor) as tf.Tensor;
  const prob = (await result.data())[0];
  inputTensor.dispose();
  result.dispose();

  const threshold = (_options?.threshold as number) ?? 0.5;
  return {
    speechProbability: prob,
    isSpeech: prob >= threshold,
  };
}

async function predictTurnDetection(
  features: Float32Array,
  _options?: Record<string, unknown>
): Promise<TurnDetectionPrediction> {
  const model = getModel('turn-detector');
  const inputTensor = tf.tensor(features).reshape([1, -1]);
  const result = model.predict(inputTensor) as tf.Tensor;
  const probs = await result.data();
  inputTensor.dispose();
  result.dispose();

  return {
    endOfTurn: probs[0],
    thinkingPause: probs[1],
    continueListening: probs[2],
  };
}

async function predictVoiceRoute(
  features: Float32Array,
  _options?: Record<string, unknown>
): Promise<VoiceRoutePrediction> {
  const model = getModel('voice-router');
  const inputTensor = tf.tensor(features).reshape([1, -1]);
  const result = model.predict(inputTensor) as tf.Tensor;
  const probs = await result.data();
  inputTensor.dispose();
  result.dispose();

  return {
    dictation: probs[0],
    conversation: probs[1],
    command: probs[2],
    transcription: probs[3],
  };
}

async function predictIntent(
  tokenIds: number[],
  _options?: Record<string, unknown>
): Promise<IntentPrediction> {
  const model = getModel('intent-classifier');
  const config = modelConfigs.get('intent-classifier') ?? {};
  const maxLen = (config.maxSeqLength as number) ?? 64;
  const intentLabels = (config.intentLabels as string[]) ?? [];

  // Pad or truncate to maxLen
  const padded = new Float32Array(maxLen);
  for (let i = 0; i < Math.min(tokenIds.length, maxLen); i++) {
    padded[i] = tokenIds[i];
  }

  const inputTensor = tf.tensor(padded).reshape([1, maxLen]);
  const outputs = model.predict(inputTensor);

  // Expect [intentLogits, entityLogits] or just intentLogits
  let intentProbs: Float32Array;
  if (Array.isArray(outputs)) {
    intentProbs = await (outputs[0] as tf.Tensor).data() as Float32Array;
    for (const t of outputs) (t as tf.Tensor).dispose();
  } else {
    intentProbs = await (outputs as tf.Tensor).data() as Float32Array;
    (outputs as tf.Tensor).dispose();
  }
  inputTensor.dispose();

  // Find top intent
  let maxIdx = 0;
  let maxProb = intentProbs[0];
  for (let i = 1; i < intentProbs.length; i++) {
    if (intentProbs[i] > maxProb) {
      maxProb = intentProbs[i];
      maxIdx = i;
    }
  }

  return {
    intent: intentLabels[maxIdx] ?? `intent_${maxIdx}`,
    confidence: maxProb,
    entities: {}, // Entity extraction is a stretch goal for v2
  };
}

async function predictNotificationScore(
  features: Float32Array,
  _options?: Record<string, unknown>
): Promise<NotificationScore> {
  const model = getModel('notification-ranker');
  const inputTensor = tf.tensor(features).reshape([1, -1]);
  const result = model.predict(inputTensor) as tf.Tensor;
  const prob = (await result.data())[0];
  inputTensor.dispose();
  result.dispose();

  return {
    engagementProbability: prob,
    reason: '', // Computed by the renderer based on feature importance
  };
}

async function predictWorkflow(
  features: Float32Array,
  _options?: Record<string, unknown>
): Promise<WorkflowPrediction> {
  const model = getModel('workflow-predictor');
  const config = modelConfigs.get('workflow-predictor') ?? {};
  const actionLabels = (config.actionLabels as string[]) ?? [];

  const inputTensor = tf.tensor(features).reshape([1, 5, -1]);
  const result = model.predict(inputTensor) as tf.Tensor;
  const probs = await result.data();
  inputTensor.dispose();
  result.dispose();

  // Sort by probability
  const indexed = Array.from(probs).map((p, i) => ({ action: actionLabels[i] ?? `action_${i}`, confidence: p }));
  indexed.sort((a, b) => b.confidence - a.confidence);

  return {
    nextAction: indexed[0]?.action ?? 'unknown',
    confidence: indexed[0]?.confidence ?? 0,
    alternatives: indexed.slice(1, 4),
  };
}

async function predictEmbedding(
  input: string | string[],
  _options?: Record<string, unknown>
): Promise<EmbeddingResult | EmbeddingResult[]> {
  const model = getModel('universal-sentence-encoder');
  const sentences = Array.isArray(input) ? input : [input];

  // USE expects string inputs via the model's built-in tokenizer
  // When loaded as a GraphModel, we need to handle tokenization ourselves
  // For now, use a simple encoding approach — this will be refined when the actual USE model is integrated
  const inputTensor = tf.tensor(sentences.map(s => Array.from(s).map(c => c.charCodeAt(0)).slice(0, 128)));
  const result = model.predict(inputTensor) as tf.Tensor;
  const embeddings = await result.data();
  const dims = result.shape[1] ?? 512;
  inputTensor.dispose();
  result.dispose();

  const results: EmbeddingResult[] = [];
  for (let i = 0; i < sentences.length; i++) {
    const start = i * dims;
    const embedding = new Float32Array(embeddings.buffer, start * 4, dims);
    results.push({ embedding: new Float32Array(embedding), dimensions: dims });
  }

  return Array.isArray(input) ? results : results[0];
}

// ── Training ──

async function train(
  modelId: MLModelId,
  inputs: Float32Array | number[][],
  labels: Float32Array | number[][],
  config: { epochs?: number; batchSize?: number; learningRate?: number }
): Promise<{ loss: number; epochs: number }> {
  const model = models.get(modelId);
  if (!model || !('fit' in model)) {
    throw new Error(`Model ${modelId} is not a LayersModel or not loaded — cannot train`);
  }

  const layersModel = model as tf.LayersModel;
  const inputShape = layersModel.inputs[0].shape;
  const inputDim = inputShape[inputShape.length - 1] ?? 1;

  const xs = tf.tensor2d(
    inputs instanceof Float32Array ? Array.from(inputs) : inputs.flat(),
    [inputs instanceof Float32Array ? inputs.length / inputDim : inputs.length, inputDim]
  );

  const outputShape = layersModel.outputs[0].shape;
  const outputDim = outputShape[outputShape.length - 1] ?? 1;

  const ys = tf.tensor2d(
    labels instanceof Float32Array ? Array.from(labels) : labels.flat(),
    [labels instanceof Float32Array ? labels.length / outputDim : labels.length, outputDim]
  );

  const epochs = config.epochs ?? 5;
  const batchSize = config.batchSize ?? 32;

  if (config.learningRate) {
    layersModel.compile({
      optimizer: tf.train.adam(config.learningRate),
      loss: 'binaryCrossentropy',
    });
  }

  const history = await layersModel.fit(xs, ys, {
    epochs,
    batchSize,
    shuffle: true,
    verbose: 0,
  });

  xs.dispose();
  ys.dispose();

  const finalLoss = history.history.loss?.[history.history.loss.length - 1] as number ?? 0;
  return { loss: finalLoss, epochs };
}

// ── Weight Serialization ──

async function getWeights(modelId: MLModelId): Promise<{ weightsJson: string; metadataJson: string }> {
  const model = models.get(modelId);
  if (!model || !('getWeights' in model)) {
    throw new Error(`Model ${modelId} not loaded or not a LayersModel`);
  }

  const layersModel = model as tf.LayersModel;
  const weights = layersModel.getWeights();
  const serialized = await Promise.all(
    weights.map(async (w) => ({
      name: w.name,
      shape: w.shape,
      data: Array.from(await w.data()),
    }))
  );

  return {
    weightsJson: JSON.stringify(serialized),
    metadataJson: JSON.stringify({
      modelId,
      numWeights: weights.length,
      exportedAt: new Date().toISOString(),
    }),
  };
}

async function loadWeights(
  modelId: MLModelId,
  weightsJson: string,
  _metadataJson?: string
): Promise<void> {
  const model = models.get(modelId);
  if (!model || !('setWeights' in model)) {
    throw new Error(`Model ${modelId} not loaded or not a LayersModel`);
  }

  const layersModel = model as tf.LayersModel;
  const serialized = JSON.parse(weightsJson) as Array<{ name: string; shape: number[]; data: number[] }>;
  const tensors = serialized.map((w) => tf.tensor(w.data, w.shape));
  layersModel.setWeights(tensors);
  // Dispose the temporary tensors
  tensors.forEach((t) => t.dispose());
  console.log(`[ML Worker] Loaded weights for model: ${modelId}`);
}

// ── Cosine Similarity (for semantic search) ──

export function cosineSimilaritySearch(
  queryEmbedding: Float32Array,
  allEmbeddings: Array<{ contentId: string; contentType: string; embedding: Float32Array }>,
  topK: number
): SimilarityResult[] {
  // Compute query norm
  let queryNorm = 0;
  for (let i = 0; i < queryEmbedding.length; i++) {
    queryNorm += queryEmbedding[i] * queryEmbedding[i];
  }
  queryNorm = Math.sqrt(queryNorm);
  if (queryNorm === 0) return [];

  const scores: SimilarityResult[] = [];

  for (const item of allEmbeddings) {
    let dot = 0;
    let itemNorm = 0;
    for (let i = 0; i < queryEmbedding.length; i++) {
      dot += queryEmbedding[i] * item.embedding[i];
      itemNorm += item.embedding[i] * item.embedding[i];
    }
    itemNorm = Math.sqrt(itemNorm);
    if (itemNorm === 0) continue;

    const score = dot / (queryNorm * itemNorm);
    scores.push({
      contentId: item.contentId,
      contentType: item.contentType,
      score,
    });
  }

  // Sort by score descending, take topK
  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, topK);
}

// ── Message Handler ──

async function handleMessage(msg: WorkerInMessage): Promise<WorkerOutMessage> {
  try {
    switch (msg.type) {
      case 'PING':
        return { type: 'RESULT', requestId: msg.requestId, payload: { pong: true, backend: tf.getBackend() } };

      case 'INIT_MODEL':
        await initModel(msg.model, msg.payload);
        return { type: 'RESULT', requestId: msg.requestId, payload: { loaded: true, model: msg.model } };

      case 'PREDICT':
        const prediction = await predict(msg.model, msg.payload.input, msg.payload.options);
        return { type: 'RESULT', requestId: msg.requestId, payload: prediction };

      case 'TRAIN':
        const trainResult = await train(msg.model, msg.payload.inputs, msg.payload.labels, msg.payload.config);
        return { type: 'RESULT', requestId: msg.requestId, payload: trainResult };

      case 'GET_WEIGHTS':
        const weights = await getWeights(msg.model);
        return { type: 'RESULT', requestId: msg.requestId, payload: weights };

      case 'LOAD_WEIGHTS':
        await loadWeights(msg.model, msg.payload.weightsJson, msg.payload.metadataJson);
        return { type: 'RESULT', requestId: msg.requestId, payload: { loaded: true } };

      case 'DISPOSE_MODEL':
        const model = models.get(msg.model);
        if (model) {
          model.dispose();
          models.delete(msg.model);
          modelConfigs.delete(msg.model);
        }
        return { type: 'RESULT', requestId: msg.requestId, payload: { disposed: true } };

      default:
        return { type: 'ERROR', requestId: (msg as any).requestId ?? '', error: `Unknown message type: ${(msg as any).type}` };
    }
  } catch (err) {
    return {
      type: 'ERROR',
      requestId: (msg as any).requestId ?? '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Worker entry point ──

self.onmessage = async (event: MessageEvent<WorkerInMessage>) => {
  const response = await handleMessage(event.data);
  self.postMessage(response);
};

// Initialize TF.js and signal readiness
initTFJS().then(() => {
  const ready: WorkerOutMessage = { type: 'READY' };
  self.postMessage(ready);
});
