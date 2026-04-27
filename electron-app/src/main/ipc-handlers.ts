/**
 * IPC handlers that bridge renderer requests to the Rust native addon.
 * Security: input validation on high-risk channels.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS, MODEL_FILES } from '../shared/constants';
import { native } from './native-bridge';
import { downloadModel, downloadTtsModel, getModelsStatus, isTtsModelReady, importModelFile, getImportableModels, importModelFromPath, importMultiPartModel } from './model-downloader';
import { aiManager } from './ai/AIManager';
import { getChatModelPath, resolveActiveChatModel } from './ai/LocalLLMAdapter';
import { llmSubprocess } from './ai/LlmSubprocess';
import type { AIProvider } from './ai/types';
import { meetingRecorder } from './meeting-recorder';
import { liveSummarizer } from './live-summarizer';
import { dictationStreamer } from './dictation-streamer';
import { meetingRoomServer } from './meeting-room-server';
import { meetingRoomClient } from './meeting-room-client';
import { meetingNotesCollabServer } from './meeting-notes-collab-server';
import { meetingNotesCollabClient } from './meeting-notes-collab-client';
import { checkBlackHoleInstalled, installBlackHole, openAudioMidiSetup, broadcastInstallProgress } from './blackhole-setup';
import { audioStream } from './audio-stream-manager';

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
  'migration_auto_detect_default_v2',
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
  // Meeting templates (v1.3.0)
  'meeting_auto_detect_enabled', 'meeting_default_template',
  // Meeting recording / Granola mode (v1.5.0)
  'meeting_audio_device', 'meeting_chunk_interval_s', 'meeting_display_name',
  // Collaboration (v1.6.0)
  'meeting_collab_display_name',
  // Notebooks — JSON array of {id,name,createdAt}
  'notebooks',
]);

function assertString(val: unknown, name: string): asserts val is string {
  if (typeof val !== 'string') throw new Error(`${name} must be a string`);
}

function assertMaxLength(val: string, max: number, name: string): void {
  if (val.length > max) throw new Error(`${name} exceeds maximum length (${max})`);
}

export function registerIpcHandlers(): void {
  // Audio — all callers must go through audioStream for exclusive ownership.
  ipcMain.handle(IPC_CHANNELS.START_RECORDING, () => {
    audioStream.acquire('dictation');
    try {
      native.startRecording();
    } catch (err) {
      audioStream.release('dictation');
      throw err;
    }
  });
  ipcMain.handle(IPC_CHANNELS.STOP_RECORDING, () => {
    try {
      return native.stopRecording();
    } finally {
      audioStream.release('dictation');
    }
  });
  ipcMain.handle(IPC_CHANNELS.IS_RECORDING, () => native.isRecording());
  // reset-recording: clears both the Rust pipeline state and the ownership
  // flag so a stuck stream can be recovered without restarting the app.
  ipcMain.handle('ironmic:reset-recording', () => {
    audioStream.forceReset();
    if (typeof native.addon.resetRecording === 'function') {
      native.addon.resetRecording();
    } else if (typeof native.addon.resetPipelineState === 'function') {
      native.addon.resetPipelineState();
    }
  });

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
  ipcMain.handle(IPC_CHANNELS.POLISH_TEXT, async (_e, rawText: string) => {
    // Route through the actual LLM subprocess when available.
    // Rust's polish_text() is a stub (returns input unchanged) because
    // llama.cpp inference lives in the separate ironmic-llm binary to
    // avoid ggml symbol collisions with whisper.cpp.
    if (llmSubprocess.isAvailable()) {
      // Honor user's configured LLM from settings (ai_local_model / ai_model);
      // fall back to first downloaded if nothing is set.
      const resolved = resolveActiveChatModel(native);
      if (resolved) {
        try {
          // Hard timeout: 5 minutes per LLM call. Without this, a hung subprocess
          // causes note generation to block indefinitely (e.g. after app restart
          // or if the ironmic-llm binary stalls mid-inference).
          const LLM_TIMEOUT_MS = 5 * 60 * 1000;
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`LLM call timed out after ${LLM_TIMEOUT_MS / 1000}s`)), LLM_TIMEOUT_MS)
          );
          return await Promise.race([
            llmSubprocess.chatComplete({
              modelPath: resolved.modelPath,
              modelType: resolved.modelType,
              messages: [{ role: 'user', content: rawText }],
              maxTokens: 2048,
              temperature: 0.3,
            }),
            timeoutPromise,
          ]);
        } catch (err) {
          console.error('[polishText] LLM subprocess error, falling back to stub:', err);
        }
      }
    }
    // Fallback: return unchanged (stub)
    return native.polishText(rawText);
  });

  // ── Processing state tracking (for quit-confirmation) ──
  // Renderer fires this when it starts/stops LLM note generation so the main
  // process can intercept window close and warn about in-flight work.
  let activeNotesGeneratingCount = 0;
  ipcMain.on('ironmic:notify-processing-state', (_e, isActive: boolean) => {
    activeNotesGeneratingCount = Math.max(0, activeNotesGeneratingCount + (isActive ? 1 : -1));
  });
  // Expose the counter so index.ts can read it in the before-close hook.
  (global as any).__ironmicActiveGeneratingCount = () => activeNotesGeneratingCount;

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
    // `notebooks` stores a JSON array and can exceed the default 1KB cap as
    // the user adds more notebooks. Give it headroom.
    const maxLen = key === 'notebooks' ? 64_000 : MAX_SETTING_VALUE_LENGTH;
    assertMaxLength(value, maxLen, 'setting value');
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

  // Model downloads — validate model name against known list.
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

  // After a successful Whisper-model import we reload the engine and clear
  // any "model missing" banner the renderer may be showing. Without this, the
  // user has to restart the app for the just-imported model to actually be
  // picked up — which is exactly the failure mode that makes "I uploaded the
  // model but dictation still doesn't work" feel unsolvable.
  const isWhisperModel = (modelId?: string) => !!modelId && (modelId === 'whisper-large-v3-turbo' || modelId.startsWith('whisper-'));
  const refreshWhisperAfterImport = (result: any) => {
    if (!result || !isWhisperModel(result.modelId)) return result;
    void Promise.resolve().then(() => {
      try {
        native.loadWhisperModel();
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            // Empty payload acts as "clear the banner" when the renderer sees
            // permanent === false and message blank.
            win.webContents.send('ironmic:whisper-load-failed', { message: '', permanent: false });
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('ironmic:whisper-load-failed', { message, permanent: false });
          }
        }
      }
    });
    return result;
  };

  ipcMain.handle(IPC_CHANNELS.IMPORT_MODEL, async () => {
    const window = BrowserWindow.getFocusedWindow();
    return refreshWhisperAfterImport(await importModelFile(window));
  });
  ipcMain.handle('ironmic:get-importable-models', () => {
    return JSON.stringify(getImportableModels());
  });
  ipcMain.handle(IPC_CHANNELS.IMPORT_MODEL_FROM_PATH, async (_event, filePath: string, sectionFilter: string) => {
    return refreshWhisperAfterImport(await importModelFromPath(filePath, sectionFilter));
  });
  ipcMain.handle(IPC_CHANNELS.IMPORT_MULTI_PART_MODEL, async () => {
    const window = BrowserWindow.getFocusedWindow();
    return refreshWhisperAfterImport(await importMultiPartModel(window));
  });
  ipcMain.handle(IPC_CHANNELS.OPEN_EXTERNAL, (_event, url: string) => {
    // Only allow opening known model download domains
    try {
      const parsed = new URL(url);
      const allowed = ['huggingface.co', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'existential.audio', 'vb-audio.com'];
      if (allowed.some(d => parsed.hostname === d || parsed.hostname.endsWith('.' + d))) {
        const { shell } = require('electron');
        shell.openExternal(url);
      }
    } catch { /* ignore invalid URLs */ }
  });

  // ── Audio Input ──

  ipcMain.handle(IPC_CHANNELS.LIST_AUDIO_DEVICES, () => {
    return native.listAudioDevices();
  });
  ipcMain.handle(IPC_CHANNELS.GET_CURRENT_AUDIO_DEVICE, () => {
    return native.getCurrentAudioDevice();
  });
  ipcMain.handle(IPC_CHANNELS.CHECK_MIC_PERMISSION, async () => {
    // systemPreferences.getMediaAccessStatus('microphone') works on both
    // macOS and Windows (Electron 17+). On Windows it reflects the
    // Settings > Privacy > Microphone toggle. Hardcoding 'granted' here
    // hid real denial states on Windows.
    const { systemPreferences } = require('electron');
    if ((process.platform === 'darwin' || process.platform === 'win32')
        && typeof systemPreferences.getMediaAccessStatus === 'function') {
      return systemPreferences.getMediaAccessStatus('microphone');
    }
    return 'granted';
  });

  // ── Meeting Templates ──

  ipcMain.handle(IPC_CHANNELS.TEMPLATE_CREATE, (_event, name: string, meetingType: string, sections: string, llmPrompt: string, displayLayout: string) => {
    return native.createMeetingTemplate(name, meetingType, sections, llmPrompt, displayLayout);
  });
  ipcMain.handle(IPC_CHANNELS.TEMPLATE_GET, (_event, id: string) => {
    return native.getMeetingTemplate(id);
  });
  ipcMain.handle(IPC_CHANNELS.TEMPLATE_LIST, () => {
    return native.listMeetingTemplates();
  });
  ipcMain.handle(IPC_CHANNELS.TEMPLATE_UPDATE, (_event, id: string, name: string, meetingType: string, sections: string, llmPrompt: string, displayLayout: string) => {
    return native.updateMeetingTemplate(id, name, meetingType, sections, llmPrompt, displayLayout);
  });
  ipcMain.handle(IPC_CHANNELS.TEMPLATE_DELETE, (_event, id: string) => {
    return native.deleteMeetingTemplate(id);
  });
  ipcMain.handle(IPC_CHANNELS.MEETING_CREATE_WITH_TEMPLATE, (_event, templateId: string | null, detectedApp: string | null) => {
    return native.createMeetingSessionWithTemplate(templateId ?? undefined, detectedApp ?? undefined);
  });
  ipcMain.handle(IPC_CHANNELS.MEETING_SET_STRUCTURED_OUTPUT, (_event, id: string, structuredOutput: string) => {
    return native.setMeetingStructuredOutput(id, structuredOutput);
  });

  // ── Meeting Recording (Granola-style chunk loop) ──

  ipcMain.handle(IPC_CHANNELS.MEETING_START_RECORDING, async (_event, sessionId: string, deviceName?: string | null, chunkIntervalS?: number) => {
    assertString(sessionId, 'sessionId');
    // If the renderer didn't pass an interval, read the user's configured value
    // from settings; fall back to 15s. Clamp to [10, 60] — shorter hurts Whisper
    // accuracy, longer hurts the live-summary cadence.
    let interval = chunkIntervalS;
    if (typeof interval !== 'number' || !Number.isFinite(interval)) {
      try {
        const stored = native.getSetting('meeting_chunk_interval_s');
        const parsed = stored ? parseInt(stored, 10) : NaN;
        interval = Number.isFinite(parsed) ? parsed : 15;
      } catch {
        interval = 15;
      }
    }
    interval = Math.max(10, Math.min(60, Math.round(interval)));
    await meetingRecorder.startMeetingRecording(sessionId, deviceName, interval);
    // Kick off the live-summary stream for this session.
    try { liveSummarizer.start(sessionId); }
    catch (err) { console.warn('[ipc] liveSummarizer.start failed:', err); }
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_STOP_RECORDING, async () => {
    // Order matters:
    //   1. Stop the recorder first — this processes the final chunk and
    //      emits one last segment via the listener, which the LiveSummarizer
    //      picks up. Also runs diarization on the transcript.
    //   2. Flush the summarizer — waits for any in-flight pass to complete
    //      AND does one final pass covering the last segment + user notes.
    //   3. Only then actually stop() the summarizer (teardown).
    const recorderResult = await meetingRecorder.stopMeetingRecording();
    let liveSummary = '';
    let liveInsufficient = false;
    try {
      const flushed = await liveSummarizer.flush();
      liveSummary = flushed.summary;
      liveInsufficient = flushed.insufficient;
    } catch (err) {
      console.warn('[ipc] liveSummarizer.flush failed:', err);
    } finally {
      try { liveSummarizer.stop(); } catch { /* noop */ }
    }
    return { ...recorderResult, liveSummary, liveInsufficient };
  });

  // Returns the live recording state so the renderer can resync after a
  // component remount (e.g. navigate away mid-meeting → navigate back).
  ipcMain.handle('ironmic:get-meeting-recording-state', () =>
    meetingRecorder.getState(),
  );

  // ── Streaming dictation (near-real-time, chunked) ──
  ipcMain.handle(IPC_CHANNELS.DICTATION_STREAM_START, async () => {
    return dictationStreamer.start();
  });
  ipcMain.handle(IPC_CHANNELS.DICTATION_STREAM_STOP, async () => {
    return dictationStreamer.stop();
  });

  // Fire-and-forget: renderer tells the summarizer that user notes changed.
  // The summarizer debounces and will re-run, picking up the new notes from
  // the DB (YourNotesPanel persists them via meetingSetStructuredOutput first).
  ipcMain.on(IPC_CHANNELS.MEETING_USER_NOTES_CHANGED, (_e, sessionId: string) => {
    if (typeof sessionId !== 'string' || !sessionId) return;
    try { liveSummarizer.notifyUserNotesChanged(sessionId); }
    catch (err) { console.warn('[ipc] notifyUserNotesChanged failed:', err); }
  });

  // ── Meeting Room (LAN multi-user collaboration) ──

  ipcMain.handle(IPC_CHANNELS.MEETING_ROOM_HOST_START, async (_e, sessionId: string, hostName: string, templateId?: string | null) => {
    assertString(sessionId, 'sessionId');
    return meetingRoomServer.start({
      sessionId,
      hostName: hostName ?? 'Host',
      templateId: templateId ?? null,
    });
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_ROOM_HOST_STOP, async () => {
    await meetingRoomServer.stop();
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_ROOM_HOST_INFO, async () => {
    return meetingRoomServer.getInfo();
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_ROOM_JOIN, async (_e, opts: {
    hostIp: string;
    hostPort: number;
    roomCode: string;
    displayName: string;
    deviceName?: string | null;
  }) => {
    assertString(opts?.hostIp, 'hostIp');
    assertString(opts?.roomCode, 'roomCode');
    assertString(opts?.displayName, 'displayName');
    if (typeof opts.hostPort !== 'number') throw new Error('hostPort must be a number');
    return meetingRoomClient.connect(opts);
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_ROOM_LEAVE, async () => {
    await meetingRoomClient.disconnect();
    return { ok: true };
  });

  // ── Transcript Segments ──
  // These handlers fall back to in-memory storage (meetingRecorder) when the
  // transcript_segments SQLite table is not yet available in the compiled addon.

  ipcMain.handle(IPC_CHANNELS.ADD_TRANSCRIPT_SEGMENT, (_event, sessionId: string, speakerLabel: string | null, startMs: number, endMs: number, text: string, source: string) => {
    assertString(sessionId, 'sessionId');
    assertString(text, 'text');
    if (typeof native.addon.addTranscriptSegment === 'function') {
      return native.addon.addTranscriptSegment(sessionId, speakerLabel, startMs, endMs, text, source);
    }
    return JSON.stringify({ id: `seg-${Date.now()}`, session_id: sessionId, speaker_label: speakerLabel, start_ms: startMs, end_ms: endMs, text, source, participant_id: null, confidence: null, created_at: new Date().toISOString() });
  });

  ipcMain.handle(IPC_CHANNELS.LIST_TRANSCRIPT_SEGMENTS, (_event, sessionId: string) => {
    assertString(sessionId, 'sessionId');
    if (typeof native.addon.listTranscriptSegments === 'function') {
      return native.addon.listTranscriptSegments(sessionId);
    }
    // Fall back to in-memory segments from the meeting recorder
    return JSON.stringify(meetingRecorder.getSegments().filter(s => s.session_id === sessionId));
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_SEGMENT_SPEAKER, (_event, id: string, speakerLabel: string) => {
    assertString(id, 'id');
    assertString(speakerLabel, 'speakerLabel');
    if (typeof native.addon.updateSegmentSpeaker === 'function') {
      return native.addon.updateSegmentSpeaker(id, speakerLabel);
    }
  });

  ipcMain.handle(IPC_CHANNELS.ASSEMBLE_FULL_TRANSCRIPT, (_event, sessionId: string) => {
    assertString(sessionId, 'sessionId');
    if (typeof native.addon.assembleFullTranscript === 'function') {
      return native.addon.assembleFullTranscript(sessionId);
    }
    // Fall back to assembling from in-memory segments
    return meetingRecorder.getSegments()
      .filter(s => s.session_id === sessionId)
      .sort((a, b) => a.start_ms - b.start_ms)
      .map(s => s.text)
      .join('\n\n');
  });

  ipcMain.handle(IPC_CHANNELS.START_RECORDING_FROM_DEVICE, (_event, deviceName: string) => {
    assertString(deviceName, 'deviceName');
    if (typeof native.addon.startRecordingFromDevice === 'function') {
      return native.addon.startRecordingFromDevice(deviceName);
    }
    // Fall back to default mic
    return native.addon.startRecording();
  });

  // ── Export / Sharing ──

  ipcMain.handle(IPC_CHANNELS.COPY_HTML_CLIPBOARD, (_event, html: string, fallbackText: string) => {
    return native.copyHtmlToClipboard(html, fallbackText);
  });
  ipcMain.handle(IPC_CHANNELS.EXPORT_ENTRY_MARKDOWN, (_event, id: string) => {
    return native.exportEntryMarkdown(id);
  });
  ipcMain.handle(IPC_CHANNELS.EXPORT_ENTRY_JSON, (_event, id: string) => {
    return native.exportEntryJson(id);
  });
  ipcMain.handle(IPC_CHANNELS.EXPORT_ENTRY_PLAIN_TEXT, (_event, id: string) => {
    return native.exportEntryPlainText(id);
  });
  ipcMain.handle(IPC_CHANNELS.EXPORT_MEETING_MARKDOWN, (_event, id: string) => {
    return native.exportMeetingMarkdown(id);
  });
  ipcMain.handle(IPC_CHANNELS.TEXT_TO_HTML, (_event, text: string) => {
    return native.textToHtml(text);
  });
  ipcMain.handle(IPC_CHANNELS.SAVE_FILE_DIALOG, async (_event, content: string, defaultName: string, filtersJson: string) => {
    const { dialog } = require('electron');
    const fs = require('fs');
    const filters = JSON.parse(filtersJson);
    const result = await dialog.showSaveDialog({
      defaultPath: defaultName,
      filters,
    });
    if (result.canceled || !result.filePath) return false;
    await fs.promises.writeFile(result.filePath, content, 'utf-8');
    return true;
  });

  // ── BlackHole (macOS system audio capture) ──

  ipcMain.handle(IPC_CHANNELS.BLACKHOLE_CHECK, async (_e, deviceListJson?: string) => {
    return checkBlackHoleInstalled(deviceListJson);
  });

  ipcMain.handle(IPC_CHANNELS.BLACKHOLE_INSTALL, async () => {
    // Run installation; stream progress via push events back to renderer.
    await installBlackHole((progress) => {
      broadcastInstallProgress(progress);
    });
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.BLACKHOLE_OPEN_AUDIO_MIDI_SETUP, () => {
    openAudioMidiSetup();
    return { ok: true };
  });

  // ── Notes Collaboration (finished meetings, LAN) ──

  ipcMain.handle(IPC_CHANNELS.MEETING_COLLAB_START, async (
    _e,
    sessionId: string,
    hostName: string,
    notes: string,
    version?: number,
  ) => {
    assertString(sessionId, 'sessionId');
    return meetingNotesCollabServer.start({ sessionId, hostName: hostName ?? 'Host', notes, version });
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_COLLAB_STOP, async () => {
    await meetingNotesCollabServer.stop();
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_COLLAB_NOTIFY_SAVED, (_e, notes: string, savedBy: string) => {
    assertString(notes, 'notes');
    meetingNotesCollabServer.notifyNotesSaved(notes, savedBy ?? 'Host');
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_COLLAB_NOTIFY_DRAFT, (_e, content: string, senderName: string) => {
    assertString(content, 'content');
    meetingNotesCollabServer.notifyDraft(content, senderName ?? 'Host');
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_COLLAB_JOIN, async (_e, opts: {
    hostIp: string;
    hostPort: number;
    sessionCode: string;
    displayName: string;
  }) => {
    assertString(opts?.hostIp, 'hostIp');
    assertString(opts?.sessionCode, 'sessionCode');
    assertString(opts?.displayName, 'displayName');
    if (typeof opts.hostPort !== 'number') throw new Error('hostPort must be a number');
    return meetingNotesCollabClient.connect(opts);
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_COLLAB_LEAVE, async () => {
    await meetingNotesCollabClient.disconnect();
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_COLLAB_SAVE_NOTES, (_e, content: string) => {
    assertString(content, 'content');
    meetingNotesCollabClient.saveNotes(content);
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_COLLAB_SEND_DRAFT, (_e, content: string) => {
    meetingNotesCollabClient.sendDraft(content);
    return { ok: true };
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
