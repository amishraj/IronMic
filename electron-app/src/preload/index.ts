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
  downloadModel: (model: string) => ipcRenderer.invoke('ironmic:download-model', model),

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

  // Analytics
  analyticsRecomputeToday: () => ipcRenderer.invoke('ironmic:analytics-recompute-today'),
  analyticsBackfill: () => ipcRenderer.invoke('ironmic:analytics-backfill'),
  analyticsGetOverview: (period: string) => ipcRenderer.invoke('ironmic:analytics-get-overview', period),
  analyticsGetDailyTrend: (from: string, to: string) => ipcRenderer.invoke('ironmic:analytics-get-daily-trend', from, to),
  analyticsGetTopWords: (from: string, to: string, limit: number) => ipcRenderer.invoke('ironmic:analytics-get-top-words', from, to, limit),
  analyticsGetSourceBreakdown: (from: string, to: string) => ipcRenderer.invoke('ironmic:analytics-get-source-breakdown', from, to),
  analyticsGetVocabularyRichness: (from: string, to: string) => ipcRenderer.invoke('ironmic:analytics-get-vocabulary-richness', from, to),
  analyticsGetStreaks: () => ipcRenderer.invoke('ironmic:analytics-get-streaks'),
  analyticsGetProductivityComparison: () => ipcRenderer.invoke('ironmic:analytics-get-productivity-comparison'),
  analyticsGetTopicBreakdown: (from: string, to: string) => ipcRenderer.invoke('ironmic:analytics-get-topic-breakdown', from, to),
  analyticsGetTopicTrends: (from: string, to: string) => ipcRenderer.invoke('ironmic:analytics-get-topic-trends', from, to),
  analyticsClassifyTopicsBatch: (batchSize: number) => ipcRenderer.invoke('ironmic:analytics-classify-topics-batch', batchSize),
  analyticsGetUnclassifiedCount: () => ipcRenderer.invoke('ironmic:analytics-get-unclassified-count'),

  // AI Chat
  aiGetAuthState: () => ipcRenderer.invoke('ai:get-auth-state'),
  aiRefreshAuth: (provider?: string) => ipcRenderer.invoke('ai:refresh-auth', provider),
  aiPickProvider: () => ipcRenderer.invoke('ai:pick-provider'),
  aiSendMessage: (prompt: string, provider: string, model?: string) => ipcRenderer.invoke('ai:send-message', prompt, provider, model),
  aiGetModels: (provider?: string) => ipcRenderer.invoke('ai:get-models', provider),
  aiCancel: () => ipcRenderer.invoke('ai:cancel'),
  aiResetSession: () => ipcRenderer.invoke('ai:reset-session'),
  aiGetLocalModelStatus: () => ipcRenderer.invoke('ai:local-model-status'),
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

  // ── ML Features: Notifications ──
  notificationCreate: (source: string, sourceId: string | null, type: string, title: string, body?: string) =>
    ipcRenderer.invoke('ironmic:notification-create', source, sourceId, type, title, body),
  notificationList: (limit: number, offset: number, unreadOnly: boolean) =>
    ipcRenderer.invoke('ironmic:notification-list', limit, offset, unreadOnly),
  notificationMarkRead: (id: string) => ipcRenderer.invoke('ironmic:notification-mark-read', id),
  notificationAct: (id: string) => ipcRenderer.invoke('ironmic:notification-act', id),
  notificationDismiss: (id: string) => ipcRenderer.invoke('ironmic:notification-dismiss', id),
  notificationUpdatePriority: (id: string, priority: number) =>
    ipcRenderer.invoke('ironmic:notification-update-priority', id, priority),
  notificationLogInteraction: (notificationId: string, action: string, hour?: number, dow?: number) =>
    ipcRenderer.invoke('ironmic:notification-log-interaction', notificationId, action, hour, dow),
  notificationGetInteractions: (sinceDate: string) =>
    ipcRenderer.invoke('ironmic:notification-get-interactions', sinceDate),
  notificationGetUnreadCount: () => ipcRenderer.invoke('ironmic:notification-get-unread-count'),
  notificationDeleteOld: (days: number) => ipcRenderer.invoke('ironmic:notification-delete-old', days),

  // ── ML Features: Action Log ──
  logAction: (actionType: string, metadataJson?: string) =>
    ipcRenderer.invoke('ironmic:action-log', actionType, metadataJson),
  queryActionLog: (from: string, to: string, filter?: string) =>
    ipcRenderer.invoke('ironmic:action-log-query', from, to, filter),
  getActionCounts: () => ipcRenderer.invoke('ironmic:action-log-get-counts'),
  deleteOldActions: (days: number) => ipcRenderer.invoke('ironmic:action-log-delete-old', days),

  // ── ML Features: Workflows ──
  workflowCreate: (seq: string, pattern: string | null, conf: number, count: number) =>
    ipcRenderer.invoke('ironmic:workflow-create', seq, pattern, conf, count),
  workflowList: (includeDismissed: boolean) => ipcRenderer.invoke('ironmic:workflow-list', includeDismissed),
  workflowSave: (id: string, name: string) => ipcRenderer.invoke('ironmic:workflow-save', id, name),
  workflowDismiss: (id: string) => ipcRenderer.invoke('ironmic:workflow-dismiss', id),
  workflowDelete: (id: string) => ipcRenderer.invoke('ironmic:workflow-delete', id),

  // ── ML Features: Embeddings ──
  embeddingStore: (contentId: string, contentType: string, embeddingBytes: Buffer, modelVersion: string) =>
    ipcRenderer.invoke('ironmic:embedding-store', contentId, contentType, embeddingBytes, modelVersion),
  embeddingGetAll: (filter?: string) => ipcRenderer.invoke('ironmic:embedding-get-all', filter),
  embeddingGetAllWithData: (filter?: string) => ipcRenderer.invoke('ironmic:embedding-get-all-with-data', filter),
  embeddingGetUnembedded: (limit: number) => ipcRenderer.invoke('ironmic:embedding-get-unembedded', limit),
  embeddingDelete: (contentId: string, contentType: string) =>
    ipcRenderer.invoke('ironmic:embedding-delete', contentId, contentType),
  embeddingGetStats: () => ipcRenderer.invoke('ironmic:embedding-get-stats'),
  embeddingDeleteAll: () => ipcRenderer.invoke('ironmic:embedding-delete-all'),

  // ── ML Features: Model Weights ──
  mlSaveWeights: (name: string, weightsJson: string, metaJson: string | null, samples: number) =>
    ipcRenderer.invoke('ironmic:ml-save-weights', name, weightsJson, metaJson, samples),
  mlLoadWeights: (name: string) => ipcRenderer.invoke('ironmic:ml-load-weights', name),
  mlDeleteWeights: (name: string) => ipcRenderer.invoke('ironmic:ml-delete-weights', name),
  mlGetTrainingStatus: () => ipcRenderer.invoke('ironmic:ml-get-training-status'),
  mlDeleteAllData: () => ipcRenderer.invoke('ironmic:ml-delete-all-data'),

  // ── ML Features: VAD Training ──
  vadSaveSample: (features: string, label: string, corrected: boolean, sessionId?: string) =>
    ipcRenderer.invoke('ironmic:vad-save-sample', features, label, corrected, sessionId),
  vadGetSamples: (limit: number) => ipcRenderer.invoke('ironmic:vad-get-samples', limit),
  vadGetSampleCount: () => ipcRenderer.invoke('ironmic:vad-get-sample-count'),
  vadDeleteAllSamples: () => ipcRenderer.invoke('ironmic:vad-delete-all-samples'),

  // ── ML Features: Intent Training ──
  intentSaveSample: (transcript: string, intent?: string, entities?: string, conf?: number, entryId?: string) =>
    ipcRenderer.invoke('ironmic:intent-save-sample', transcript, intent, entities, conf, entryId),
  intentGetSamples: (limit: number) => ipcRenderer.invoke('ironmic:intent-get-samples', limit),
  intentGetCorrectionCount: () => ipcRenderer.invoke('ironmic:intent-get-correction-count'),
  intentLogRouting: (screen: string, intent: string, route: string, entryId?: string) =>
    ipcRenderer.invoke('ironmic:intent-log-routing', screen, intent, route, entryId),

  // ── ML Features: Meeting Sessions ──
  meetingCreate: () => ipcRenderer.invoke('ironmic:meeting-create'),
  meetingEnd: (id: string, speakers: number, summary?: string, items?: string, duration?: number, entryIds?: string) =>
    ipcRenderer.invoke('ironmic:meeting-end', id, speakers, summary, items, duration, entryIds),
  meetingGet: (id: string) => ipcRenderer.invoke('ironmic:meeting-get', id),
  meetingList: (limit: number, offset: number) => ipcRenderer.invoke('ironmic:meeting-list', limit, offset),
  meetingDelete: (id: string) => ipcRenderer.invoke('ironmic:meeting-delete', id),
  meetingCreateWithTemplate: (templateId: string | null, detectedApp: string | null) => ipcRenderer.invoke('ironmic:meeting-create-with-template', templateId, detectedApp),
  meetingSetStructuredOutput: (id: string, structuredOutput: string) => ipcRenderer.invoke('ironmic:meeting-set-structured-output', id, structuredOutput),

  // ── Meeting Recording (Granola-style chunk loop) ──
  meetingStartRecording: (sessionId: string, deviceName?: string | null, chunkIntervalS?: number) =>
    ipcRenderer.invoke('ironmic:meeting-start-recording', sessionId, deviceName, chunkIntervalS),
  meetingStopRecording: () => ipcRenderer.invoke('ironmic:meeting-stop-recording'),

  // ── Streaming dictation (near-real-time) ──
  dictationStreamStart: () => ipcRenderer.invoke('ironmic:dictation-stream-start'),
  dictationStreamStop: () => ipcRenderer.invoke('ironmic:dictation-stream-stop'),
  onDictationStreamChunk: (callback: (payload: { index: number; text: string; isFinal: boolean }) => void) => {
    const handler = (_e: any, p: any) => callback(p);
    ipcRenderer.on('ironmic:dictation-stream-chunk', handler);
    return () => ipcRenderer.removeListener('ironmic:dictation-stream-chunk', handler);
  },
  onDictationStreamState: (callback: (state: { status: string; startedAt: number | null; chunkCount: number }) => void) => {
    const handler = (_e: any, s: any) => callback(s);
    ipcRenderer.on('ironmic:dictation-stream-state', handler);
    return () => ipcRenderer.removeListener('ironmic:dictation-stream-state', handler);
  },
  /** Notify the main-process LiveSummarizer that the user typed new notes.
   *  Fire-and-forget — the summarizer will re-read the persisted notes and
   *  debounce a re-summary. Caller should persist via meetingSetStructuredOutput FIRST. */
  notifyMeetingUserNotesChanged: (sessionId: string) =>
    ipcRenderer.send('ironmic:meeting-user-notes-changed', sessionId),

  // ── Meeting Room (LAN multi-user collaboration) ──
  meetingRoomHostStart: (sessionId: string, hostName: string, templateId?: string | null) =>
    ipcRenderer.invoke('ironmic:meeting-room-host-start', sessionId, hostName, templateId),
  meetingRoomHostStop: () => ipcRenderer.invoke('ironmic:meeting-room-host-stop'),
  meetingRoomHostInfo: () => ipcRenderer.invoke('ironmic:meeting-room-host-info'),
  meetingRoomJoin: (opts: { hostIp: string; hostPort: number; roomCode: string; displayName: string; deviceName?: string | null }) =>
    ipcRenderer.invoke('ironmic:meeting-room-join', opts),
  meetingRoomLeave: () => ipcRenderer.invoke('ironmic:meeting-room-leave'),

  // ── Transcript Segments ──
  listTranscriptSegments: (sessionId: string) => ipcRenderer.invoke('ironmic:list-transcript-segments', sessionId),
  updateSegmentSpeaker: (id: string, speakerLabel: string) => ipcRenderer.invoke('ironmic:update-segment-speaker', id, speakerLabel),
  assembleFullTranscript: (sessionId: string) => ipcRenderer.invoke('ironmic:assemble-full-transcript', sessionId),

  // ── Audio Input ──
  listAudioDevices: () => ipcRenderer.invoke('ironmic:list-audio-devices'),
  getCurrentAudioDevice: () => ipcRenderer.invoke('ironmic:get-current-audio-device'),
  checkMicPermission: () => ipcRenderer.invoke('ironmic:check-mic-permission'),

  // ── Meeting Templates ──
  templateCreate: (name: string, meetingType: string, sections: string, llmPrompt: string, displayLayout: string) => ipcRenderer.invoke('ironmic:template-create', name, meetingType, sections, llmPrompt, displayLayout),
  templateGet: (id: string) => ipcRenderer.invoke('ironmic:template-get', id),
  templateList: () => ipcRenderer.invoke('ironmic:template-list'),
  templateUpdate: (id: string, name: string, meetingType: string, sections: string, llmPrompt: string, displayLayout: string) => ipcRenderer.invoke('ironmic:template-update', id, name, meetingType, sections, llmPrompt, displayLayout),
  templateDelete: (id: string) => ipcRenderer.invoke('ironmic:template-delete', id),

  // ── Export / Sharing ──
  copyHtmlToClipboard: (html: string, fallbackText: string) => ipcRenderer.invoke('ironmic:copy-html-clipboard', html, fallbackText),
  exportEntryMarkdown: (id: string) => ipcRenderer.invoke('ironmic:export-entry-markdown', id),
  exportEntryJson: (id: string) => ipcRenderer.invoke('ironmic:export-entry-json', id),
  exportEntryPlainText: (id: string) => ipcRenderer.invoke('ironmic:export-entry-plain-text', id),
  exportMeetingMarkdown: (id: string) => ipcRenderer.invoke('ironmic:export-meeting-markdown', id),
  textToHtml: (text: string) => ipcRenderer.invoke('ironmic:text-to-html', text),
  saveFileDialog: (content: string, defaultName: string, filters: any[]) => ipcRenderer.invoke('ironmic:save-file-dialog', content, defaultName, JSON.stringify(filters)),

  // ── TF.js Infrastructure ──
  getModelsDir: () => ipcRenderer.invoke('ironmic:get-models-dir'),

  // Manual model import
  importModel: () => ipcRenderer.invoke('ironmic:import-model'),
  getImportableModels: () => ipcRenderer.invoke('ironmic:get-importable-models'),
  importModelFromPath: (filePath: string, sectionFilter: string) => ipcRenderer.invoke('ironmic:import-model-from-path', filePath, sectionFilter),
  importMultiPartModel: () => ipcRenderer.invoke('ironmic:import-multi-part-model'),
  openExternal: (url: string) => ipcRenderer.invoke('ironmic:open-external', url),

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
  onNotificationNew: (callback: (notification: any) => void) => {
    const handler = (_event: any, notification: any) => callback(notification);
    ipcRenderer.on('ironmic:notification-new', handler);
    return () => ipcRenderer.removeListener('ironmic:notification-new', handler);
  },
  onWorkflowDiscovered: (callback: (workflow: any) => void) => {
    const handler = (_event: any, workflow: any) => callback(workflow);
    ipcRenderer.on('ironmic:workflow-discovered', handler);
    return () => ipcRenderer.removeListener('ironmic:workflow-discovered', handler);
  },

  // ── Meeting Recording Events (main → renderer) ──
  onMeetingSegmentReady: (callback: (segment: any) => void) => {
    const handler = (_event: any, segment: any) => callback(segment);
    ipcRenderer.on('ironmic:meeting-segment-ready', handler);
    return () => ipcRenderer.removeListener('ironmic:meeting-segment-ready', handler);
  },
  onMeetingRecordingState: (callback: (state: any) => void) => {
    const handler = (_event: any, state: any) => callback(state);
    ipcRenderer.on('ironmic:meeting-recording-state', handler);
    return () => ipcRenderer.removeListener('ironmic:meeting-recording-state', handler);
  },
  onMeetingLiveSummary: (callback: (payload: any) => void) => {
    const handler = (_event: any, payload: any) => callback(payload);
    ipcRenderer.on('ironmic:meeting-live-summary', handler);
    return () => ipcRenderer.removeListener('ironmic:meeting-live-summary', handler);
  },
  /** Tray/menu/notification quick actions → renderer opens the right page and runs the action. */
  onQuickAction: (callback: (action: 'start-dictation' | 'start-meeting') => void) => {
    const handler = (_event: any, action: 'start-dictation' | 'start-meeting') => callback(action);
    ipcRenderer.on('ironmic:quick-action', handler);
    return () => ipcRenderer.removeListener('ironmic:quick-action', handler);
  },
  onMeetingAppDetected: (callback: (event: any, data: any) => void) => {
    ipcRenderer.on('ironmic:meeting-app-detected', callback);
    return () => ipcRenderer.removeListener('ironmic:meeting-app-detected', callback);
  },

  // ── Meeting Room Events (main → renderer) ──
  onMeetingRoomState: (callback: (info: any) => void) => {
    const handler = (_event: any, info: any) => callback(info);
    ipcRenderer.on('ironmic:meeting-room-state', handler);
    return () => ipcRenderer.removeListener('ironmic:meeting-room-state', handler);
  },
  onMeetingRoomParticipantUpdate: (callback: (msg: any) => void) => {
    const handler = (_event: any, msg: any) => callback(msg);
    ipcRenderer.on('ironmic:meeting-room-participant-update', handler);
    return () => ipcRenderer.removeListener('ironmic:meeting-room-participant-update', handler);
  },

  // ── BlackHole (macOS system audio) ──
  blackholeCheck: (deviceListJson?: string) =>
    ipcRenderer.invoke('ironmic:blackhole-check', deviceListJson),
  blackholeInstall: () => ipcRenderer.invoke('ironmic:blackhole-install'),
  blackholeOpenAudioMidiSetup: () => ipcRenderer.invoke('ironmic:blackhole-open-audio-midi-setup'),
  onBlackholeInstallProgress: (callback: (p: any) => void) => {
    const handler = (_event: any, p: any) => callback(p);
    ipcRenderer.on('ironmic:blackhole-install-progress', handler);
    return () => ipcRenderer.removeListener('ironmic:blackhole-install-progress', handler);
  },

  // ── Processing state notifications (renderer → main, fire-and-forget) ──
  // Called when note generation starts/ends so the main process can intercept
  // window close and warn the user about in-flight work.
  notifyProcessingState: (isActive: boolean) =>
    ipcRenderer.send('ironmic:notify-processing-state', isActive),

  // ── Notes Collaboration ──
  meetingCollabStart: (sessionId: string, hostName: string, notes: string, version?: number) =>
    ipcRenderer.invoke('ironmic:meeting-collab-start', sessionId, hostName, notes, version),
  meetingCollabStop: () => ipcRenderer.invoke('ironmic:meeting-collab-stop'),
  meetingCollabNotifySaved: (notes: string, savedBy: string) =>
    ipcRenderer.invoke('ironmic:meeting-collab-notify-saved', notes, savedBy),
  meetingCollabNotifyDraft: (content: string, senderName: string) =>
    ipcRenderer.invoke('ironmic:meeting-collab-notify-draft', content, senderName),
  meetingCollabJoin: (opts: { hostIp: string; hostPort: number; sessionCode: string; displayName: string }) =>
    ipcRenderer.invoke('ironmic:meeting-collab-join', opts),
  meetingCollabLeave: () => ipcRenderer.invoke('ironmic:meeting-collab-leave'),
  meetingCollabSaveNotes: (content: string) => ipcRenderer.invoke('ironmic:meeting-collab-save-notes', content),
  meetingCollabSendDraft: (content: string) => ipcRenderer.invoke('ironmic:meeting-collab-send-draft', content),
  onMeetingCollabState: (callback: (info: any) => void) => {
    const handler = (_event: any, info: any) => callback(info);
    ipcRenderer.on('ironmic:meeting-collab-state', handler);
    return () => ipcRenderer.removeListener('ironmic:meeting-collab-state', handler);
  },
  onMeetingCollabNotesUpdated: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('ironmic:meeting-collab-notes-updated', handler);
    return () => ipcRenderer.removeListener('ironmic:meeting-collab-notes-updated', handler);
  },
  onMeetingCollabDraft: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('ironmic:meeting-collab-draft', handler);
    return () => ipcRenderer.removeListener('ironmic:meeting-collab-draft', handler);
  },
  onMeetingCollabEnded: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('ironmic:meeting-collab-ended', handler);
    return () => ipcRenderer.removeListener('ironmic:meeting-collab-ended', handler);
  },
};

contextBridge.exposeInMainWorld('ironmic', api);

// Type declaration for the renderer
export type IronMicAPI = typeof api;
