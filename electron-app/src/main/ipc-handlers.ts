/**
 * IPC handlers that bridge renderer requests to the Rust native addon.
 * Security: input validation on high-risk channels.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS, MODEL_FILES } from '../shared/constants';
import { native } from './native-bridge';
import { downloadModel, downloadTtsModel, getModelsStatus, isTtsModelReady } from './model-downloader';
import { aiManager } from './ai/AIManager';
import type { AIProvider } from './ai/types';

// ── Input validation helpers ──

const MAX_PROMPT_LENGTH = 100_000;
const MAX_SETTING_VALUE_LENGTH = 1_000;
const MAX_AUDIO_BUFFER_SIZE = 100 * 1024 * 1024; // 100 MB
const VALID_PROVIDERS: AIProvider[] = ['copilot', 'claude'];

const ALLOWED_SETTING_KEYS = new Set([
  'hotkey_record', 'llm_cleanup_enabled', 'default_view', 'theme',
  'whisper_model', 'llm_model', 'ai_enabled',
  'tts_auto_readback', 'tts_voice', 'tts_speed', 'tts_enabled',
  'auto_delete_enabled', 'auto_delete_days',
  'security_clipboard_auto_clear', 'security_session_timeout',
  'security_clear_on_exit', 'security_ai_data_confirm', 'security_privacy_mode',
  'migration_tag_ai_done',
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
  ipcMain.handle('ai:send-message', async (_e, prompt: string, provider: AIProvider) => {
    assertString(prompt, 'prompt');
    assertString(provider, 'provider');
    assertMaxLength(prompt, MAX_PROMPT_LENGTH, 'AI prompt');
    if (!VALID_PROVIDERS.includes(provider)) {
      throw new Error(`Invalid AI provider: ${provider}`);
    }
    const window = BrowserWindow.getFocusedWindow();
    return aiManager.sendMessage(prompt, provider, window);
  });
  ipcMain.handle('ai:cancel', () => aiManager.cancel());
  ipcMain.handle('ai:reset-session', () => aiManager.resetSession());

  console.log('[ipc-handlers] All IPC handlers registered');
}
