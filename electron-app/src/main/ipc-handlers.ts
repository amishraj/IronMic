/**
 * IPC handlers that bridge renderer requests to the Rust native addon.
 * Security: input validation on high-risk channels.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS, MODEL_FILES } from '../shared/constants';
import { native } from './native-bridge';
import { downloadModel, downloadTtsModel, getModelsStatus, isTtsModelReady, importModelFile, getImportableModels } from './model-downloader';
import { aiManager } from './ai/AIManager';
import { getChatModelPath } from './ai/LocalLLMAdapter';
import { llmSubprocess } from './ai/LlmSubprocess';
import type { AIProvider } from './ai/types';

// ── Input validation helpers ──

const MAX_PROMPT_LENGTH = 100_000;
const MAX_SETTING_VALUE_LENGTH = 1_000;
const MAX_AUDIO_BUFFER_SIZE = 100 * 1024 * 1024; // 100 MB
const VALID_PROVIDERS: AIProvider[] = ['copilot', 'claude', 'local'];

const ALLOWED_SETTING_KEYS = new Set([
  'hotkey_record', 'llm_cleanup_enabled', 'default_view', 'theme',
  'whisper_model', 'llm_model', 'ai_enabled',
  'ai_provider', 'ai_model', 'ai_local_model',
  'tts_auto_readback', 'tts_voice', 'tts_speed', 'tts_enabled',
  'auto_delete_enabled', 'auto_delete_days',
  'security_clipboard_auto_clear', 'security_session_timeout',
  'security_clear_on_exit', 'security_ai_data_confirm', 'security_privacy_mode',
  'migration_tag_ai_done',
  'analytics_backfill_done',
  // ML Feature settings (v1.1.0)
  'vad_enabled', 'vad_sensitivity', 'vad_web_audio_enabled',
  'turn_detection_enabled', 'turn_detection_timeout_ms', 'turn_detection_mode',
  'voice_routing_enabled', 'meeting_mode_enabled',
  'intent_classification_enabled', 'intent_llm_fallback',
  'ml_notifications_enabled', 'ml_notifications_threshold', 'ml_notifications_retention_days',
  'ml_workflows_enabled', 'ml_workflows_confidence',
  'ml_semantic_search_enabled',
  // Network / proxy (v1.1.8)
  'proxy_url', 'proxy_enabled',
]);

function assertString(val: unknown, name: string): asserts val is string {
  if (typeof val !== 'string') throw new Error(`${name} must be a string`);
}

function assertMaxLength(val: string, max: number, name: string): void {
  if (val.length > max) throw new Error(`${name} exceeds maximum length (${max})`);
}

export function registerIpcHandlers(): void {
  // Audio
  ipcMain.handle(IPC_CHANNELS.START_RECORDING, () => native.startRecording());
  ipcMain.handle(IPC_CHANNELS.STOP_RECORDING, () => native.stopRecording());
  ipcMain.handle(IPC_CHANNELS.IS_RECORDING, () => native.isRecording());
  ipcMain.handle('ironmic:reset-recording', () => native.addon.resetRecording());

  // Transcription — validate buffer size, convert Uint8Array to Buffer (sandbox sends Uint8Array)
  ipcMain.handle(IPC_CHANNELS.TRANSCRIBE, (_e, audioBuffer: any) => {
    if (!Buffer.isBuffer(audioBuffer) && !(audioBuffer instanceof Uint8Array)) {
      throw new Error('audioBuffer must be a Buffer or Uint8Array');
    }
    if (audioBuffer.length > MAX_AUDIO_BUFFER_SIZE) {
      throw new Error(`Audio buffer too large: ${audioBuffer.length} bytes (max ${MAX_AUDIO_BUFFER_SIZE})`);
    }
    const buf = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
    return native.transcribe(buf);
  });
  ipcMain.handle(IPC_CHANNELS.POLISH_TEXT, (_e, rawText: string) =>
    native.polishText(rawText)
  );

  // Entries
  ipcMain.handle(IPC_CHANNELS.CREATE_ENTRY, (_e, entry) => native.createEntry(entry));
  ipcMain.handle(IPC_CHANNELS.GET_ENTRY, (_e, id: string) => native.getEntry(id));
  ipcMain.handle(IPC_CHANNELS.UPDATE_ENTRY, (_e, id: string, updates) =>
    native.updateEntry(id, updates)
  );
  ipcMain.handle(IPC_CHANNELS.DELETE_ENTRY, (_e, id: string) => native.deleteEntry(id));
  ipcMain.handle('ironmic:tag-untagged-entries', (_e, sourceApp: string) =>
    native.addon.tagUntaggedEntries(sourceApp)
  );
  ipcMain.handle(IPC_CHANNELS.LIST_ENTRIES, (_e, opts) => native.listEntries(opts));
  ipcMain.handle(IPC_CHANNELS.PIN_ENTRY, (_e, id: string, pinned: boolean) =>
    native.pinEntry(id, pinned)
  );
  ipcMain.handle(IPC_CHANNELS.ARCHIVE_ENTRY, (_e, id: string, archived: boolean) =>
    native.archiveEntry(id, archived)
  );
  ipcMain.handle('ironmic:delete-all-entries', () => native.addon.deleteAllEntries());
  ipcMain.handle('ironmic:delete-entries-older-than', (_e, days: number) =>
    native.addon.deleteEntriesOlderThan(days)
  );
  ipcMain.handle('ironmic:run-auto-cleanup', () => native.addon.runAutoCleanup());

  // Dictionary
  ipcMain.handle(IPC_CHANNELS.ADD_WORD, (_e, word: string) => native.addWord(word));
  ipcMain.handle(IPC_CHANNELS.REMOVE_WORD, (_e, word: string) => native.removeWord(word));
  ipcMain.handle(IPC_CHANNELS.LIST_DICTIONARY, () => native.listDictionary());

  // Settings — validate key allowlist and value length
  ipcMain.handle(IPC_CHANNELS.GET_SETTING, (_e, key: string) => {
    assertString(key, 'key');
    return native.getSetting(key);
  });
  ipcMain.handle(IPC_CHANNELS.SET_SETTING, (_e, key: string, value: string) => {
    assertString(key, 'key');
    assertString(value, 'value');
    if (!ALLOWED_SETTING_KEYS.has(key)) {
      throw new Error(`Unknown setting key: ${key}`);
    }
    assertMaxLength(value, MAX_SETTING_VALUE_LENGTH, 'setting value');
    return native.setSetting(key, value);
  });

  // Clipboard
  ipcMain.handle(IPC_CHANNELS.COPY_TO_CLIPBOARD, (_e, text: string) =>
    native.copyToClipboard(text)
  );

  // Hotkey & Pipeline
  ipcMain.handle(IPC_CHANNELS.REGISTER_HOTKEY, (_e, accelerator: string) =>
    native.registerHotkey(accelerator)
  );
  ipcMain.handle(IPC_CHANNELS.GET_PIPELINE_STATE, () => native.getPipelineState());
  ipcMain.handle(IPC_CHANNELS.RESET_PIPELINE_STATE, () => native.resetPipelineState());
  ipcMain.handle(IPC_CHANNELS.GET_MODEL_STATUS, () => ({
    ...native.getModelStatus(),
    files: getModelsStatus(),
  }));

  // Model downloads — validate model name against known list
  ipcMain.handle(IPC_CHANNELS.DOWNLOAD_MODEL, (_e, model: string) => {
    assertString(model, 'model');
    if (model !== 'tts' && !MODEL_FILES[model]) {
      throw new Error(`Unknown model: ${model}`);
    }
    const window = BrowserWindow.getFocusedWindow();
    if (model === 'tts') {
      return downloadTtsModel(window);
    }
    return downloadModel(model, window);
  });
  ipcMain.handle('ironmic:is-tts-model-ready', () => isTtsModelReady());

  // Whisper model & GPU config
  ipcMain.handle('ironmic:get-available-whisper-models', () => native.addon.getAvailableWhisperModels());
  ipcMain.handle('ironmic:get-current-whisper-model', () => native.addon.getCurrentWhisperModel());
  ipcMain.handle('ironmic:set-whisper-model', (_e, modelId: string) => native.addon.setWhisperModel(modelId));
  ipcMain.handle('ironmic:is-gpu-available', () => native.addon.isGpuAvailable());
  ipcMain.handle('ironmic:is-gpu-enabled', () => native.addon.isGpuEnabled());
  ipcMain.handle('ironmic:set-gpu-enabled', (_e, enabled: boolean) => native.addon.setGpuEnabled(enabled));

  // ── Analytics ──
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_RECOMPUTE_TODAY, () => native.addon.analyticsRecomputeToday());
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_BACKFILL, () => native.addon.analyticsBackfill());
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_OVERVIEW, (_e, period: string) => {
    assertString(period, 'period');
    return native.addon.analyticsGetOverview(period);
  });
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_DAILY_TREND, (_e, from: string, to: string) => {
    assertString(from, 'from');
    assertString(to, 'to');
    return native.addon.analyticsGetDailyTrend(from, to);
  });
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_TOP_WORDS, (_e, from: string, to: string, limit: number) => {
    assertString(from, 'from');
    assertString(to, 'to');
    return native.addon.analyticsGetTopWords(from, to, limit);
  });
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_SOURCE_BREAKDOWN, (_e, from: string, to: string) => {
    assertString(from, 'from');
    assertString(to, 'to');
    return native.addon.analyticsGetSourceBreakdown(from, to);
  });
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_VOCABULARY_RICHNESS, (_e, from: string, to: string) => {
    assertString(from, 'from');
    assertString(to, 'to');
    return native.addon.analyticsGetVocabularyRichness(from, to);
  });
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_STREAKS, () => native.addon.analyticsGetStreaks());
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_PRODUCTIVITY_COMPARISON, () => native.addon.analyticsGetProductivityComparison());
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_TOPIC_BREAKDOWN, (_e, from: string, to: string) => {
    assertString(from, 'from');
    assertString(to, 'to');
    return native.addon.analyticsGetTopicBreakdown(from, to);
  });
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_TOPIC_TRENDS, (_e, from: string, to: string) => {
    assertString(from, 'from');
    assertString(to, 'to');
    return native.addon.analyticsGetTopicTrends(from, to);
  });
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_CLASSIFY_TOPICS_BATCH, async (_e, batchSize: number) => {
    if (!llmSubprocess.isAvailable()) {
      throw new Error('LLM subprocess not available');
    }

    // Get unclassified entries (id + text pairs) from Rust
    const entriesJson: string = native.addon.analyticsGetUnclassifiedEntries(batchSize);
    const entries: Array<[string, string]> = JSON.parse(entriesJson);
    if (entries.length === 0) return 0;

    const modelPath = getChatModelPath('llm');
    const TOPIC_PROMPT = `You are a topic classifier. Given a transcription, output 1 to 3 topic categories that best describe the content.

Choose from broad, reusable categories such as:
- Software Development
- Meeting Notes
- Personal Thoughts
- Email Draft
- Creative Writing
- Project Planning
- Technical Discussion
- Documentation
- Code Review
- Business Strategy
- Data Analysis
- Design
- Customer Support
- General

Output ONLY a JSON array of strings, nothing else.
Example output: ["Software Development", "Code Review"]
If the text is too short or unclear, output: ["General"]`;

    let classified = 0;
    for (const [entryId, text] of entries) {
      try {
        // Truncate to ~500 words
        const truncated = text.split(/\s+/).slice(0, 500).join(' ');
        const response = await llmSubprocess.chatComplete({
          modelPath,
          modelType: 'mistral',
          messages: [
            { role: 'user', content: `${TOPIC_PROMPT}\n\nTranscription:\n${truncated}` },
          ],
          maxTokens: 128,
          temperature: 0.1,
        });

        // Parse topics from LLM response
        const topics = parseTopicResponse(response);
        const topicsJson = JSON.stringify(topics);
        native.addon.analyticsSaveEntryTopics(entryId, topicsJson);
        classified++;
      } catch (err) {
        console.warn(`[analytics] Failed to classify entry ${entryId}:`, err);
        // Save as General on failure so we don't retry forever
        native.addon.analyticsSaveEntryTopics(entryId, JSON.stringify([["General", 0.5]]));
        classified++;
      }
    }
    return classified;
  });
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_UNCLASSIFIED_COUNT, () =>
    native.addon.analyticsGetUnclassifiedCount()
  );

  // ── TTS ──
  ipcMain.handle('ironmic:synthesize-text', (_e, text: string) => native.addon.synthesizeText(text));
  ipcMain.handle('ironmic:tts-play', () => native.addon.ttsPlay());
  ipcMain.handle('ironmic:tts-pause', () => native.addon.ttsPause());
  ipcMain.handle('ironmic:tts-stop', () => native.addon.ttsStop());
  ipcMain.handle('ironmic:tts-get-position', () => native.addon.ttsGetPosition());
  ipcMain.handle('ironmic:tts-get-state', () => native.addon.ttsGetState());
  ipcMain.handle('ironmic:tts-set-speed', (_e, speed: number) => native.addon.ttsSetSpeed(speed));
  ipcMain.handle('ironmic:tts-set-voice', (_e, voiceId: string) => native.addon.ttsSetVoice(voiceId));
  ipcMain.handle('ironmic:tts-available-voices', () => native.addon.ttsAvailableVoices());
  ipcMain.handle('ironmic:tts-load-model', () => native.addon.ttsLoadModel());
  ipcMain.handle('ironmic:tts-is-loaded', () => native.addon.ttsIsLoaded());
  ipcMain.handle('ironmic:tts-toggle', () => native.addon.ttsToggle());

  // ── AI Chat ──
  ipcMain.handle('ai:get-auth-state', () => aiManager.getAuthState());
  ipcMain.handle('ai:refresh-auth', (_e, provider?: AIProvider) => aiManager.refreshAuth(provider));
  ipcMain.handle('ai:pick-provider', () => aiManager.pickProvider());
  ipcMain.handle('ai:send-message', async (_e, prompt: string, provider: AIProvider, model?: string) => {
    assertString(prompt, 'prompt');
    assertString(provider, 'provider');
    assertMaxLength(prompt, MAX_PROMPT_LENGTH, 'AI prompt');
    if (!VALID_PROVIDERS.includes(provider)) {
      throw new Error(`Invalid AI provider: ${provider}`);
    }
    if (model !== undefined && model !== null) {
      assertString(model, 'model');
      assertMaxLength(model, 100, 'model');
    }
    const window = BrowserWindow.getFocusedWindow();
    return aiManager.sendMessage(prompt, provider, window, model || undefined);
  });
  ipcMain.handle('ai:get-models', (_e, provider?: AIProvider) => {
    if (provider) return aiManager.getModels(provider);
    return aiManager.getAllModels();
  });
  ipcMain.handle('ai:cancel', () => aiManager.cancel());
  ipcMain.handle('ai:reset-session', () => aiManager.resetSession());
  ipcMain.handle('ai:local-model-status', () => aiManager.getLocalModelStatuses());

  // ── ML Features: Notifications ──

  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_CREATE, (_e, source: string, sourceId: string | null, type: string, title: string, body?: string) =>
    native.addon.createNotification(source, sourceId, type, title, body ?? null)
  );
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_LIST, (_e, limit: number, offset: number, unreadOnly: boolean) =>
    native.addon.listNotifications(limit, offset, unreadOnly)
  );
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_MARK_READ, (_e, id: string) => native.addon.markNotificationRead(id));
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_ACT, (_e, id: string) => native.addon.notificationAct(id));
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_DISMISS, (_e, id: string) => native.addon.notificationDismiss(id));
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_UPDATE_PRIORITY, (_e, id: string, priority: number) =>
    native.addon.updateNotificationPriority(id, priority)
  );
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_LOG_INTERACTION, (_e, notificationId: string, action: string, hour?: number, dow?: number) =>
    native.addon.logNotificationInteraction(notificationId, action, hour ?? null, dow ?? null)
  );
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_GET_INTERACTIONS, (_e, sinceDate: string) =>
    native.addon.getNotificationInteractions(sinceDate)
  );
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_GET_UNREAD_COUNT, () => native.addon.getUnreadNotificationCount());
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_DELETE_OLD, (_e, days: number) => native.addon.deleteOldNotifications(days));

  // ── ML Features: Action Log ──

  ipcMain.handle(IPC_CHANNELS.ACTION_LOG, (_e, actionType: string, metadataJson?: string) =>
    native.addon.logAction(actionType, metadataJson ?? null)
  );
  ipcMain.handle(IPC_CHANNELS.ACTION_LOG_QUERY, (_e, from: string, to: string, filter?: string) =>
    native.addon.queryActionLog(from, to, filter ?? null)
  );
  ipcMain.handle(IPC_CHANNELS.ACTION_LOG_GET_COUNTS, () => native.addon.getActionCounts());
  ipcMain.handle(IPC_CHANNELS.ACTION_LOG_DELETE_OLD, (_e, days: number) => native.addon.deleteOldActions(days));

  // ── ML Features: Workflows ──

  ipcMain.handle(IPC_CHANNELS.WORKFLOW_CREATE, (_e, seq: string, pattern: string | null, conf: number, count: number) =>
    native.addon.createWorkflow(seq, pattern, conf, count)
  );
  ipcMain.handle(IPC_CHANNELS.WORKFLOW_LIST, (_e, includeDismissed: boolean) => native.addon.listWorkflows(includeDismissed));
  ipcMain.handle(IPC_CHANNELS.WORKFLOW_SAVE, (_e, id: string, name: string) => native.addon.saveWorkflow(id, name));
  ipcMain.handle(IPC_CHANNELS.WORKFLOW_DISMISS, (_e, id: string) => native.addon.dismissWorkflow(id));
  ipcMain.handle(IPC_CHANNELS.WORKFLOW_DELETE, (_e, id: string) => native.addon.deleteWorkflow(id));

  // ── ML Features: Embeddings ──

  ipcMain.handle(IPC_CHANNELS.EMBEDDING_STORE, (_e, contentId: string, contentType: string, embeddingBytes: Buffer, modelVersion: string) =>
    native.addon.storeEmbedding(contentId, contentType, embeddingBytes, modelVersion)
  );
  ipcMain.handle(IPC_CHANNELS.EMBEDDING_GET_ALL, (_e, filter?: string) => native.addon.getAllEmbeddings(filter ?? null));
  ipcMain.handle(IPC_CHANNELS.EMBEDDING_GET_ALL_WITH_DATA, (_e, filter?: string) => native.addon.getAllEmbeddingsWithData(filter ?? null));
  ipcMain.handle(IPC_CHANNELS.EMBEDDING_GET_UNEMBEDDED, (_e, limit: number) => native.addon.getUnembeddedEntries(limit));
  ipcMain.handle(IPC_CHANNELS.EMBEDDING_DELETE, (_e, contentId: string, contentType: string) =>
    native.addon.deleteEmbedding(contentId, contentType)
  );
  ipcMain.handle(IPC_CHANNELS.EMBEDDING_GET_STATS, () => native.addon.getEmbeddingStats());
  ipcMain.handle(IPC_CHANNELS.EMBEDDING_DELETE_ALL, () => native.addon.deleteAllEmbeddings());

  // ── ML Features: Model Weights ──

  ipcMain.handle(IPC_CHANNELS.ML_SAVE_WEIGHTS, (_e, name: string, weightsJson: string, metaJson: string | null, samples: number) =>
    native.addon.saveMlWeights(name, weightsJson, metaJson, samples)
  );
  ipcMain.handle(IPC_CHANNELS.ML_LOAD_WEIGHTS, (_e, name: string) => native.addon.loadMlWeights(name));
  ipcMain.handle(IPC_CHANNELS.ML_DELETE_WEIGHTS, (_e, name: string) => native.addon.deleteMlWeights(name));
  ipcMain.handle(IPC_CHANNELS.ML_GET_TRAINING_STATUS, () => native.addon.getMlTrainingStatus());
  ipcMain.handle(IPC_CHANNELS.ML_DELETE_ALL_DATA, () => native.addon.deleteAllMlData());

  // ── ML Features: VAD Training ──

  ipcMain.handle(IPC_CHANNELS.VAD_SAVE_SAMPLE, (_e, features: string, label: string, corrected: boolean, sessionId?: string) =>
    native.addon.saveVadTrainingSample(features, label, corrected, sessionId ?? null)
  );
  ipcMain.handle(IPC_CHANNELS.VAD_GET_SAMPLES, (_e, limit: number) => native.addon.getVadTrainingSamples(limit));
  ipcMain.handle(IPC_CHANNELS.VAD_GET_SAMPLE_COUNT, () => native.addon.getVadSampleCount());
  ipcMain.handle(IPC_CHANNELS.VAD_DELETE_ALL_SAMPLES, () => native.addon.deleteAllVadSamples());

  // ── ML Features: Intent Training ──

  ipcMain.handle(IPC_CHANNELS.INTENT_SAVE_SAMPLE, (_e, transcript: string, intent?: string, entities?: string, conf?: number, entryId?: string) =>
    native.addon.saveIntentTrainingSample(transcript, intent ?? null, entities ?? null, conf ?? null, entryId ?? null)
  );
  ipcMain.handle(IPC_CHANNELS.INTENT_GET_SAMPLES, (_e, limit: number) => native.addon.getIntentTrainingSamples(limit));
  ipcMain.handle(IPC_CHANNELS.INTENT_GET_CORRECTION_COUNT, () => native.addon.getIntentCorrectionCount());
  ipcMain.handle(IPC_CHANNELS.INTENT_LOG_ROUTING, (_e, screen: string, intent: string, route: string, entryId?: string) =>
    native.addon.logVoiceRouting(screen, intent, route, entryId ?? null)
  );

  // ── ML Features: Meeting Sessions ──

  ipcMain.handle(IPC_CHANNELS.MEETING_CREATE, () => native.addon.createMeetingSession());
  ipcMain.handle(IPC_CHANNELS.MEETING_END, (_e, id: string, speakers: number, summary?: string, items?: string, duration?: number, entryIds?: string) =>
    native.addon.endMeetingSession(id, speakers, summary ?? null, items ?? null, duration ?? 0, entryIds ?? null)
  );
  ipcMain.handle(IPC_CHANNELS.MEETING_GET, (_e, id: string) => native.addon.getMeetingSession(id));
  ipcMain.handle(IPC_CHANNELS.MEETING_LIST, (_e, limit: number, offset: number) => native.addon.listMeetingSessions(limit, offset));
  ipcMain.handle(IPC_CHANNELS.MEETING_DELETE, (_e, id: string) => native.addon.deleteMeetingSession(id));

  // ── TF.js Infrastructure ──

  ipcMain.handle(IPC_CHANNELS.GET_MODELS_DIR, () => {
    return process.env.IRONMIC_MODELS_DIR || '';
  });

  // ── Manual Model Import ──

  ipcMain.handle(IPC_CHANNELS.IMPORT_MODEL, () => {
    const window = BrowserWindow.getFocusedWindow();
    return importModelFile(window);
  });
  ipcMain.handle('ironmic:get-importable-models', () => {
    return JSON.stringify(getImportableModels());
  });

  console.log('[ipc-handlers] All IPC handlers registered');
}

/** Parse LLM topic classification response into [topic, confidence] pairs. */
function parseTopicResponse(response: string): Array<[string, number]> {
  const trimmed = response.trim();

  // Find JSON array in response
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      const topics: string[] = JSON.parse(trimmed.slice(start, end + 1));
      return topics.filter((t) => typeof t === 'string' && t.length > 0).map((t) => [t, 1.0]);
    } catch { /* fall through */ }
  }

  return [['General', 1.0]];
}
