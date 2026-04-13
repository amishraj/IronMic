/**
 * MLClient — Renderer-side typed wrapper around the ML Web Worker.
 *
 * Creates the worker, correlates request/response via message IDs,
 * and exposes a Promise-based API for model operations.
 */

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

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

const REQUEST_TIMEOUT_MS = 30_000; // 30 seconds for model loading, training

class MLClientImpl {
  private worker: Worker | null = null;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private progressListeners = new Map<string, (progress: number, message?: string) => void>();

  /**
   * Initialize the ML Worker. Call once at app startup.
   */
  async init(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      try {
        this.worker = new Worker(
          new URL('./ml-worker.ts', import.meta.url),
          { type: 'module' }
        );

        this.worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
          this.handleMessage(event.data);
          if (event.data.type === 'READY') {
            this.ready = true;
            resolve();
          }
        };

        this.worker.onerror = (error) => {
          console.error('[MLClient] Worker error:', error);
          reject(new Error(`ML Worker failed: ${error.message}`));
        };
      } catch (err) {
        reject(err);
      }
    });

    return this.readyPromise;
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Terminate the worker and clean up.
   */
  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.ready = false;
      this.readyPromise = null;
    }
    // Reject all pending requests
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('MLClient disposed'));
    }
    this.pending.clear();
  }

  // ── High-level API ──

  async ping(): Promise<{ pong: boolean; backend: string }> {
    return this.send({ type: 'PING', requestId: '' }) as Promise<{ pong: boolean; backend: string }>;
  }

  async initModel(
    model: MLModelId,
    payload: {
      modelTopology?: ArrayBuffer | object;
      weightSpecs?: unknown[];
      weightData?: ArrayBuffer;
      modelUrl?: string;
      config?: Record<string, unknown>;
    },
    transferables?: Transferable[]
  ): Promise<void> {
    await this.send(
      { type: 'INIT_MODEL', model, requestId: '', payload },
      transferables
    );
  }

  async disposeModel(model: MLModelId): Promise<void> {
    await this.send({ type: 'DISPOSE_MODEL', model, requestId: '' });
  }

  // ── Typed prediction methods ──

  async predictVAD(audioFrame: Float32Array, threshold?: number): Promise<VADPrediction> {
    return this.send({
      type: 'PREDICT',
      model: 'vad-silero',
      requestId: '',
      payload: { input: audioFrame, options: threshold != null ? { threshold } : undefined },
    }, [audioFrame.buffer]) as Promise<VADPrediction>;
  }

  async predictTurnDetection(features: Float32Array): Promise<TurnDetectionPrediction> {
    return this.send({
      type: 'PREDICT',
      model: 'turn-detector',
      requestId: '',
      payload: { input: features },
    }, [features.buffer]) as Promise<TurnDetectionPrediction>;
  }

  async predictVoiceRoute(features: Float32Array): Promise<VoiceRoutePrediction> {
    return this.send({
      type: 'PREDICT',
      model: 'voice-router',
      requestId: '',
      payload: { input: features },
    }, [features.buffer]) as Promise<VoiceRoutePrediction>;
  }

  async classifyIntent(tokenIds: number[]): Promise<IntentPrediction> {
    return this.send({
      type: 'PREDICT',
      model: 'intent-classifier',
      requestId: '',
      payload: { input: tokenIds },
    }) as Promise<IntentPrediction>;
  }

  async scoreNotification(features: Float32Array): Promise<NotificationScore> {
    return this.send({
      type: 'PREDICT',
      model: 'notification-ranker',
      requestId: '',
      payload: { input: features },
    }, [features.buffer]) as Promise<NotificationScore>;
  }

  async predictNextAction(features: Float32Array): Promise<WorkflowPrediction> {
    return this.send({
      type: 'PREDICT',
      model: 'workflow-predictor',
      requestId: '',
      payload: { input: features },
    }, [features.buffer]) as Promise<WorkflowPrediction>;
  }

  async embed(text: string | string[]): Promise<EmbeddingResult | EmbeddingResult[]> {
    return this.send({
      type: 'PREDICT',
      model: 'universal-sentence-encoder',
      requestId: '',
      payload: { input: text },
    }) as Promise<EmbeddingResult | EmbeddingResult[]>;
  }

  // ── Training ──

  async train(
    model: MLModelId,
    inputs: Float32Array | number[][],
    labels: Float32Array | number[][],
    config: { epochs?: number; batchSize?: number; learningRate?: number } = {}
  ): Promise<{ loss: number; epochs: number }> {
    const transferables: Transferable[] = [];
    if (inputs instanceof Float32Array) transferables.push(inputs.buffer);
    if (labels instanceof Float32Array) transferables.push(labels.buffer);

    return this.send(
      { type: 'TRAIN', model, requestId: '', payload: { inputs, labels, config } },
      transferables
    ) as Promise<{ loss: number; epochs: number }>;
  }

  // ── Weight Persistence ──

  async getWeights(model: MLModelId): Promise<{ weightsJson: string; metadataJson: string }> {
    return this.send({
      type: 'GET_WEIGHTS',
      model,
      requestId: '',
    }) as Promise<{ weightsJson: string; metadataJson: string }>;
  }

  async loadWeights(model: MLModelId, weightsJson: string, metadataJson?: string): Promise<void> {
    await this.send({
      type: 'LOAD_WEIGHTS',
      model,
      requestId: '',
      payload: { weightsJson, metadataJson },
    });
  }

  // ── Progress Listeners ──

  onProgress(model: MLModelId, callback: (progress: number, message?: string) => void): () => void {
    this.progressListeners.set(model, callback);
    return () => this.progressListeners.delete(model);
  }

  // ── Internal ──

  private async send(
    message: WorkerInMessage,
    transferables?: Transferable[]
  ): Promise<unknown> {
    if (!this.worker || !this.ready) {
      await this.init();
    }

    const requestId = `req_${++this.requestCounter}_${Date.now()}`;
    message.requestId = requestId;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`ML Worker request timed out after ${REQUEST_TIMEOUT_MS}ms: ${message.type} ${(message as any).model ?? ''}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(requestId, { resolve, reject, timeoutId });

      if (transferables?.length) {
        this.worker!.postMessage(message, transferables);
      } else {
        this.worker!.postMessage(message);
      }
    });
  }

  private handleMessage(msg: WorkerOutMessage): void {
    if (msg.type === 'READY') return; // Handled in init()

    if (msg.type === 'PROGRESS') {
      const listener = this.progressListeners.get(msg.model);
      if (listener) listener(msg.progress, msg.message);
      return;
    }

    const requestId = msg.requestId;
    const pending = this.pending.get(requestId);
    if (!pending) return;

    this.pending.delete(requestId);
    clearTimeout(pending.timeoutId);

    if (msg.type === 'ERROR') {
      pending.reject(new Error(msg.error));
    } else {
      pending.resolve(msg.payload);
    }
  }
}

/** Singleton ML Client instance */
export const MLClient = new MLClientImpl();
