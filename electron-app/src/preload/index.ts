/**
 * Preload script — exposes a typed API to the renderer via contextBridge.
 */

import { contextBridge, ipcRenderer } from 'electron';

const api = {
  // Audio
  startRecording: () => ipcRenderer.invoke('ironmic:start-recording'),
  stopRecording: () => ipcRenderer.invoke('ironmic:stop-recording'),
  isRecording: () => ipcRenderer.invoke('ironmic:is-recording'),
  resetRecording: () => ipcRenderer.invoke('ironmic:reset-recording'),

  // Transcription
  transcribe: (audioBuffer: Buffer) => ipcRenderer.invoke('ironmic:transcribe', audioBuffer),
  polishText: (rawText: string) => ipcRenderer.invoke('ironmic:polish-text', rawText),

  // Entries
  createEntry: (entry: any) => ipcRenderer.invoke('ironmic:create-entry', entry),
  getEntry: (id: string) => ipcRenderer.invoke('ironmic:get-entry', id),
  updateEntry: (id: string, updates: any) => ipcRenderer.invoke('ironmic:update-entry', id, updates),
  deleteEntry: (id: string) => ipcRenderer.invoke('ironmic:delete-entry', id),
  listEntries: (opts: any) => ipcRenderer.invoke('ironmic:list-entries', opts),
  pinEntry: (id: string, pinned: boolean) => ipcRenderer.invoke('ironmic:pin-entry', id, pinned),
  archiveEntry: (id: string, archived: boolean) => ipcRenderer.invoke('ironmic:archive-entry', id, archived),
  deleteAllEntries: () => ipcRenderer.invoke('ironmic:delete-all-entries'),
  deleteEntriesOlderThan: (days: number) => ipcRenderer.invoke('ironmic:delete-entries-older-than', days),
  runAutoCleanup: () => ipcRenderer.invoke('ironmic:run-auto-cleanup'),

  tagUntaggedEntries: (sourceApp: string) => ipcRenderer.invoke('ironmic:tag-untagged-entries', sourceApp),

  // Dictionary
  addWord: (word: string) => ipcRenderer.invoke('ironmic:add-word', word),
  removeWord: (word: string) => ipcRenderer.invoke('ironmic:remove-word', word),
  listDictionary: () => ipcRenderer.invoke('ironmic:list-dictionary'),

  // Settings
  getSetting: (key: string) => ipcRenderer.invoke('ironmic:get-setting', key),
  setSetting: (key: string, value: string) => ipcRenderer.invoke('ironmic:set-setting', key, value),

  // Clipboard
  copyToClipboard: (text: string) => ipcRenderer.invoke('ironmic:copy-to-clipboard', text),

  // Hotkey & Pipeline
  registerHotkey: (accelerator: string) => ipcRenderer.invoke('ironmic:register-hotkey', accelerator),
  getPipelineState: () => ipcRenderer.invoke('ironmic:get-pipeline-state'),
  resetPipelineState: () => ipcRenderer.invoke('ironmic:reset-pipeline-state'),
  getModelStatus: () => ipcRenderer.invoke('ironmic:get-model-status'),
  downloadModel: (model: 'whisper' | 'llm') => ipcRenderer.invoke('ironmic:download-model', model),

  // Whisper model & GPU config
  getAvailableWhisperModels: () => ipcRenderer.invoke('ironmic:get-available-whisper-models'),
  getCurrentWhisperModel: () => ipcRenderer.invoke('ironmic:get-current-whisper-model'),
  setWhisperModel: (modelId: string) => ipcRenderer.invoke('ironmic:set-whisper-model', modelId),
  isGpuAvailable: () => ipcRenderer.invoke('ironmic:is-gpu-available'),
  isGpuEnabled: () => ipcRenderer.invoke('ironmic:is-gpu-enabled'),
  setGpuEnabled: (enabled: boolean) => ipcRenderer.invoke('ironmic:set-gpu-enabled', enabled),

  // TTS
  synthesizeText: (text: string) => ipcRenderer.invoke('ironmic:synthesize-text', text),
  ttsPlay: () => ipcRenderer.invoke('ironmic:tts-play'),
  ttsPause: () => ipcRenderer.invoke('ironmic:tts-pause'),
  ttsStop: () => ipcRenderer.invoke('ironmic:tts-stop'),
  ttsGetPosition: () => ipcRenderer.invoke('ironmic:tts-get-position'),
  ttsGetState: () => ipcRenderer.invoke('ironmic:tts-get-state'),
  ttsSetSpeed: (speed: number) => ipcRenderer.invoke('ironmic:tts-set-speed', speed),
  ttsSetVoice: (voiceId: string) => ipcRenderer.invoke('ironmic:tts-set-voice', voiceId),
  ttsAvailableVoices: () => ipcRenderer.invoke('ironmic:tts-available-voices'),
  ttsLoadModel: () => ipcRenderer.invoke('ironmic:tts-load-model'),
  isTtsModelReady: () => ipcRenderer.invoke('ironmic:is-tts-model-ready'),
  ttsIsLoaded: () => ipcRenderer.invoke('ironmic:tts-is-loaded'),
  ttsToggle: () => ipcRenderer.invoke('ironmic:tts-toggle'),

  // AI Chat
  aiGetAuthState: () => ipcRenderer.invoke('ai:get-auth-state'),
  aiRefreshAuth: (provider?: string) => ipcRenderer.invoke('ai:refresh-auth', provider),
  aiPickProvider: () => ipcRenderer.invoke('ai:pick-provider'),
  aiSendMessage: (prompt: string, provider: string, model?: string) => ipcRenderer.invoke('ai:send-message', prompt, provider, model),
  aiGetModels: (provider?: string) => ipcRenderer.invoke('ai:get-models', provider),
  aiCancel: () => ipcRenderer.invoke('ai:cancel'),
  aiResetSession: () => ipcRenderer.invoke('ai:reset-session'),
  onAiOutput: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('ai:output', handler);
    return () => ipcRenderer.removeListener('ai:output', handler);
  },
  onAiTurnStart: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('ai:turn-start', handler);
    return () => ipcRenderer.removeListener('ai:turn-start', handler);
  },
  onAiTurnEnd: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('ai:turn-end', handler);
    return () => ipcRenderer.removeListener('ai:turn-end', handler);
  },

  // Events from main process
  onHotkeyPressed: (callback: () => void) => {
    ipcRenderer.on('ironmic:hotkey-pressed', callback);
    return () => ipcRenderer.removeListener('ironmic:hotkey-pressed', callback);
  },
  onModelDownloadProgress: (callback: (progress: any) => void) => {
    const handler = (_event: any, progress: any) => callback(progress);
    ipcRenderer.on('ironmic:model-download-progress', handler);
    return () => ipcRenderer.removeListener('ironmic:model-download-progress', handler);
  },
  onPipelineStateChanged: (callback: (state: string) => void) => {
    const handler = (_event: any, state: string) => callback(state);
    ipcRenderer.on('ironmic:pipeline-state-changed', handler);
    return () => ipcRenderer.removeListener('ironmic:pipeline-state-changed', handler);
  },
};

contextBridge.exposeInMainWorld('ironmic', api);

// Type declaration for the renderer
export type IronMicAPI = typeof api;
