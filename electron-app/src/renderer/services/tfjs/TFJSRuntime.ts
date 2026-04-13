/**
 * TFJSRuntime — Singleton that initializes TensorFlow.js in the renderer process,
 * manages the WebGL/CPU backend, and provides model loading with LRU caching.
 *
 * All TF.js inference runs either here (main renderer thread) or in the ML Web Worker.
 * The main thread instance is used for lightweight operations; heavy inference goes
 * through the worker via MLClient.
 */

import * as tf from '@tensorflow/tfjs';

export interface MemoryStats {
  numTensors: number;
  numDataBuffers: number;
  numBytes: number;
  unreliable: boolean;
}

export interface ModelCacheEntry {
  model: tf.LayersModel | tf.GraphModel;
  loadedAt: number;
  sizeEstimate: number;
}

const MAX_CACHED_MODELS = 8;
const MODEL_DIR_CHANNEL = 'ironmic:get-models-dir';

class TFJSRuntimeImpl {
  private initialized = false;
  private backend = 'cpu';
  private modelCache = new Map<string, ModelCacheEntry>();
  private modelsDir: string | null = null;

  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      await tf.setBackend('webgl');
      await tf.ready();
      this.backend = 'webgl';
    } catch {
      await tf.setBackend('cpu');
      await tf.ready();
      this.backend = 'cpu';
    }

    this.initialized = true;
    console.log(`[TFJSRuntime] Initialized with backend: ${this.backend}`);
  }

  isReady(): boolean {
    return this.initialized;
  }

  getBackend(): string {
    return this.backend;
  }

  getMemoryStats(): MemoryStats {
    return tf.memory();
  }

  async getModelsDir(): Promise<string> {
    if (this.modelsDir) return this.modelsDir;

    // Resolve via IPC — the main process knows where models live
    const ironmic = (window as any).ironmic;
    if (ironmic?.getModelsDir) {
      this.modelsDir = await ironmic.getModelsDir();
    } else {
      // Fallback for development
      this.modelsDir = '';
    }
    return this.modelsDir!;
  }

  /**
   * Load a TF.js LayersModel from a file path or URL.
   * Results are cached with LRU eviction.
   */
  async loadLayersModel(modelId: string, modelJsonPath: string): Promise<tf.LayersModel> {
    const cached = this.modelCache.get(modelId);
    if (cached && cached.model instanceof tf.LayersModel) {
      return cached.model as tf.LayersModel;
    }

    await this.ensureInit();
    const model = await tf.loadLayersModel(modelJsonPath);
    this.cacheModel(modelId, model);
    return model;
  }

  /**
   * Load a TF.js GraphModel from a file path or URL.
   * Results are cached with LRU eviction.
   */
  async loadGraphModel(modelId: string, modelJsonPath: string): Promise<tf.GraphModel> {
    const cached = this.modelCache.get(modelId);
    if (cached && cached.model instanceof tf.GraphModel) {
      return cached.model as tf.GraphModel;
    }

    await this.ensureInit();
    const model = await tf.loadGraphModel(modelJsonPath);
    this.cacheModel(modelId, model);
    return model;
  }

  /**
   * Load a model from in-memory artifacts (used when main process sends model bytes via IPC).
   */
  async loadGraphModelFromMemory(
    modelId: string,
    modelTopology: ArrayBuffer | object,
    weightSpecs: tf.io.WeightsManifestEntry[],
    weightData: ArrayBuffer
  ): Promise<tf.GraphModel> {
    const cached = this.modelCache.get(modelId);
    if (cached) return cached.model as tf.GraphModel;

    await this.ensureInit();
    const handler = tf.io.fromMemory(modelTopology, weightSpecs, weightData);
    const model = await tf.loadGraphModel(handler);
    this.cacheModel(modelId, model);
    return model;
  }

  /**
   * Unload a specific model from cache and dispose its tensors.
   */
  unloadModel(modelId: string): void {
    const cached = this.modelCache.get(modelId);
    if (cached) {
      cached.model.dispose();
      this.modelCache.delete(modelId);
      console.log(`[TFJSRuntime] Unloaded model: ${modelId}`);
    }
  }

  /**
   * Unload all cached models.
   */
  unloadAll(): void {
    for (const [id, entry] of this.modelCache) {
      entry.model.dispose();
      console.log(`[TFJSRuntime] Unloaded model: ${id}`);
    }
    this.modelCache.clear();
  }

  isModelLoaded(modelId: string): boolean {
    return this.modelCache.has(modelId);
  }

  getLoadedModels(): string[] {
    return Array.from(this.modelCache.keys());
  }

  private async ensureInit(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }

  private cacheModel(modelId: string, model: tf.LayersModel | tf.GraphModel): void {
    // LRU eviction: remove oldest entry if at capacity
    if (this.modelCache.size >= MAX_CACHED_MODELS) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, entry] of this.modelCache) {
        if (entry.loadedAt < oldestTime) {
          oldestTime = entry.loadedAt;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        this.unloadModel(oldestKey);
      }
    }

    this.modelCache.set(modelId, {
      model,
      loadedAt: Date.now(),
      sizeEstimate: 0, // Could be computed from weight buffers if needed
    });
    console.log(`[TFJSRuntime] Cached model: ${modelId}`);
  }
}

/** Singleton instance */
export const TFJSRuntime = new TFJSRuntimeImpl();
