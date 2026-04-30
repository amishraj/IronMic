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

/** Map a chat model id to the modelType string expected by the LLM subprocess. */
export function getChatModelType(modelId: string): string {
  if (modelId === 'llm-chat-llama3') return 'llama3';
  if (modelId === 'llm-chat-phi3') return 'phi3';
  return 'mistral';
}

/**
 * Resolve the LLM model to use for local inference, honoring the user's
 * settings selection first and falling back to the first downloaded model.
 *
 * Returns null if no local chat model is downloaded at all.
 */
export function resolveActiveChatModel(
  settingsReader: { getSetting(key: string): string | null },
): { id: string; modelPath: string; modelType: string } | null {
  // 1. Honor settings selection if the user has picked a local model
  const candidates: string[] = [];
  const localModel = settingsReader.getSetting('ai_local_model');
  if (localModel) candidates.push(localModel);
  const provider = settingsReader.getSetting('ai_provider');
  const aiModel = settingsReader.getSetting('ai_model');
  if (aiModel && provider === 'local' && !candidates.includes(aiModel)) {
    candidates.push(aiModel);
  }

  // 2. Fall back to the default priority order
  for (const id of ['llm', 'llm-chat-llama3', 'llm-chat-phi3']) {
    if (!candidates.includes(id)) candidates.push(id);
  }

  for (const id of candidates) {
    if (isChatModelDownloaded(id)) {
      return {
        id,
        modelPath: getChatModelPath(id),
        modelType: getChatModelType(id),
      };
    }
  }
  return null;
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
