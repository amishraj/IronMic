/**
 * LocalLLMAdapter — AI Assist adapter for local LLM inference via Rust N-API.
 *
 * Unlike CopilotAdapter/ClaudeAdapter, this does NOT spawn a CLI subprocess.
 * Instead, it delegates to the Rust core's llama-cpp-rs engine via N-API.
 */

import * as path from 'path';
import * as fs from 'fs';
import type { IAIAdapter, AIModel, AIProvider } from './types';
import { CHAT_LLM_MODELS, MODEL_FILES } from '../../shared/constants';
import { llmSubprocess } from './LlmSubprocess';

/** Resolve the models directory (same env var used by Rust core). */
function getModelsDir(): string {
  // IRONMIC_MODELS_DIR is set reliably by main/index.ts at startup
  return process.env.IRONMIC_MODELS_DIR || path.join(__dirname, '..', '..', '..', '..', 'rust-core', 'models');
}

/** Get the absolute path to a chat model's GGUF file. */
export function getChatModelPath(modelId: string): string {
  const filename = MODEL_FILES[modelId];
  if (!filename) {
    throw new Error(`Unknown chat model ID: ${modelId}`);
  }
  return path.join(getModelsDir(), filename);
}

/** Check if a specific chat model is downloaded. */
export function isChatModelDownloaded(modelId: string): boolean {
  try {
    const modelPath = getChatModelPath(modelId);
    return fs.existsSync(modelPath);
  } catch {
    return false;
  }
}

export class LocalLLMAdapter implements IAIAdapter {
  name: AIProvider = 'local';

  async isInstalled(): Promise<boolean> {
    // Local LLM is "installed" if at least one model file exists on disk.
    // The ironmic-llm binary is a runtime detail — we show a helpful error
    // at send time if it's missing, rather than hiding the entire provider.
    return this.hasAnyModelDownloaded() || llmSubprocess.isAvailable();
  }

  async isAuthenticated(): Promise<boolean> {
    // "Authenticated" means at least one chat model is downloaded
    return this.hasAnyModelDownloaded();
  }

  async getVersion(): Promise<string | null> {
    return '1.0.0';
  }

  async getBinaryPath(): Promise<string | null> {
    return llmSubprocess.getBinaryPath();
  }

  availableModels(): AIModel[] {
    return CHAT_LLM_MODELS.map((m) => ({
      id: m.id,
      label: m.label,
      provider: 'local' as AIProvider,
      free: true,
      description: m.description,
    }));
  }

  /** Check if at least one chat-capable model GGUF file exists on disk. */
  hasAnyModelDownloaded(): boolean {
    return CHAT_LLM_MODELS.some((m) => isChatModelDownloaded(m.id));
  }

  /** Return download status for each chat model. */
  getModelStatuses(): Array<{ id: string; label: string; downloaded: boolean; sizeLabel: string; modelType: string; description: string; compatible: boolean }> {
    return CHAT_LLM_MODELS.map((m) => ({
      id: m.id,
      label: m.label,
      downloaded: isChatModelDownloaded(m.id),
      sizeLabel: m.sizeLabel,
      modelType: m.modelType,
      description: m.description,
      compatible: m.compatible,
    }));
  }
}
