/**
 * Hook wrapping the preload API calls with loading/error states.
 */

import { useState, useCallback } from 'react';
import type { Entry, NewEntry, EntryUpdate, ListOptions, ModelStatus } from '../types';

// Declare the global API exposed by preload
declare global {
  interface Window {
    ironmic: {
      // Audio
      startRecording: () => Promise<void>;
      stopRecording: () => Promise<Buffer>;
      isRecording: () => Promise<boolean>;
      resetRecording: () => Promise<void>;
      // Transcription
      transcribe: (audioBuffer: Buffer) => Promise<string>;
      polishText: (rawText: string) => Promise<string>;
      // Entries
      createEntry: (entry: NewEntry) => Promise<Entry>;
      getEntry: (id: string) => Promise<Entry | null>;
      updateEntry: (id: string, updates: EntryUpdate) => Promise<Entry>;
      deleteEntry: (id: string) => Promise<void>;
      listEntries: (opts: ListOptions) => Promise<Entry[]>;
      pinEntry: (id: string, pinned: boolean) => Promise<void>;
      archiveEntry: (id: string, archived: boolean) => Promise<void>;
      tagUntaggedEntries: (sourceApp: string) => Promise<number>;
      deleteAllEntries: () => Promise<number>;
      deleteEntriesOlderThan: (days: number) => Promise<number>;
      runAutoCleanup: () => Promise<number>;
      // Dictionary
      addWord: (word: string) => Promise<void>;
      removeWord: (word: string) => Promise<void>;
      listDictionary: () => Promise<string[]>;
      // Settings
      getSetting: (key: string) => Promise<string | null>;
      setSetting: (key: string, value: string) => Promise<void>;
      // Clipboard
      copyToClipboard: (text: string) => Promise<void>;
      // Hotkey & Pipeline
      registerHotkey: (accelerator: string) => Promise<void>;
      getPipelineState: () => Promise<string>;
      resetPipelineState: () => Promise<void>;
      getModelStatus: () => Promise<any>;
      downloadModel: (model: string) => Promise<void>;
      // Whisper & GPU
      getAvailableWhisperModels: () => Promise<any[]>;
      getCurrentWhisperModel: () => Promise<string>;
      setWhisperModel: (modelId: string) => Promise<void>;
      isGpuAvailable: () => Promise<boolean>;
      isGpuEnabled: () => Promise<boolean>;
      setGpuEnabled: (enabled: boolean) => Promise<void>;
      // TTS
      synthesizeText: (text: string) => Promise<string>;
      ttsPlay: () => Promise<void>;
      ttsPause: () => Promise<void>;
      ttsStop: () => Promise<void>;
      ttsGetPosition: () => Promise<number>;
      ttsGetState: () => Promise<string>;
      ttsSetSpeed: (speed: number) => Promise<void>;
      ttsSetVoice: (voiceId: string) => Promise<void>;
      ttsAvailableVoices: () => Promise<string>;
      ttsLoadModel: () => Promise<void>;
      isTtsModelReady: () => Promise<boolean>;
      ttsIsLoaded: () => Promise<boolean>;
      ttsToggle: () => Promise<string>;
      // Analytics
      analyticsRecomputeToday: () => Promise<void>;
      analyticsBackfill: () => Promise<void>;
      analyticsGetOverview: (period: string) => Promise<any>;
      analyticsGetDailyTrend: (from: string, to: string) => Promise<any>;
      analyticsGetTopWords: (from: string, to: string, limit: number) => Promise<any>;
      analyticsGetSourceBreakdown: (from: string, to: string) => Promise<any>;
      analyticsGetVocabularyRichness: (from: string, to: string) => Promise<any>;
      analyticsGetStreaks: () => Promise<any>;
      analyticsGetProductivityComparison: () => Promise<any>;
      analyticsGetTopicBreakdown: (from: string, to: string) => Promise<any>;
      analyticsGetTopicTrends: (from: string, to: string) => Promise<any>;
      analyticsClassifyTopicsBatch: (batchSize: number) => Promise<any>;
      analyticsGetUnclassifiedCount: () => Promise<number>;
      // AI Chat
      aiGetAuthState: () => Promise<any>;
      aiRefreshAuth: (provider?: string) => Promise<any>;
      aiPickProvider: () => Promise<'copilot' | 'claude' | 'local' | null>;
      aiSendMessage: (prompt: string, provider: string, model?: string) => Promise<string>;
      aiGetModels: (provider?: string) => Promise<any[]>;
      aiCancel: () => Promise<void>;
      aiResetSession: () => Promise<void>;
      aiGetLocalModelStatus: () => Promise<any[]>;
      // ML Notifications
      notificationCreate: (source: string, sourceId: string | null, type: string, title: string, body?: string) => Promise<string>;
      notificationList: (limit: number, offset: number, unreadOnly: boolean) => Promise<string>;
      notificationMarkRead: (id: string) => Promise<void>;
      notificationAct: (id: string) => Promise<void>;
      notificationDismiss: (id: string) => Promise<void>;
      notificationUpdatePriority: (id: string, priority: number) => Promise<void>;
      notificationLogInteraction: (notificationId: string, action: string, hour?: number, dow?: number) => Promise<void>;
      notificationGetInteractions: (sinceDate: string) => Promise<string>;
      notificationGetUnreadCount: () => Promise<number>;
      notificationDeleteOld: (days: number) => Promise<number>;
      // ML Action Log
      logAction: (actionType: string, metadataJson?: string) => Promise<void>;
      queryActionLog: (from: string, to: string, filter?: string) => Promise<string>;
      getActionCounts: () => Promise<string>;
      deleteOldActions: (days: number) => Promise<number>;
      // ML Workflows
      workflowCreate: (seq: string, pattern: string | null, conf: number, count: number) => Promise<string>;
      workflowList: (includeDismissed: boolean) => Promise<string>;
      workflowSave: (id: string, name: string) => Promise<void>;
      workflowDismiss: (id: string) => Promise<void>;
      workflowDelete: (id: string) => Promise<void>;
      // ML Embeddings
      embeddingStore: (contentId: string, contentType: string, embeddingBytes: Buffer, modelVersion: string) => Promise<void>;
      embeddingGetAll: (filter?: string) => Promise<string>;
      embeddingGetAllWithData: (filter?: string) => Promise<Buffer>;
      embeddingGetUnembedded: (limit: number) => Promise<string>;
      embeddingDelete: (contentId: string, contentType: string) => Promise<void>;
      embeddingGetStats: () => Promise<string>;
      embeddingDeleteAll: () => Promise<number>;
      // ML Model Weights
      mlSaveWeights: (name: string, weightsJson: string, metaJson: string | null, samples: number) => Promise<void>;
      mlLoadWeights: (name: string) => Promise<string>;
      mlDeleteWeights: (name: string) => Promise<void>;
      mlGetTrainingStatus: () => Promise<string>;
      mlDeleteAllData: () => Promise<void>;
      // ML VAD Training
      vadSaveSample: (features: string, label: string, corrected: boolean, sessionId?: string) => Promise<void>;
      vadGetSamples: (limit: number) => Promise<string>;
      vadGetSampleCount: () => Promise<number>;
      vadDeleteAllSamples: () => Promise<number>;
      // ML Intent Training
      intentSaveSample: (transcript: string, intent?: string, entities?: string, conf?: number, entryId?: string) => Promise<void>;
      intentGetSamples: (limit: number) => Promise<string>;
      intentGetCorrectionCount: () => Promise<number>;
      intentLogRouting: (screen: string, intent: string, route: string, entryId?: string) => Promise<void>;
      // Meeting Sessions
      meetingCreate: () => Promise<string>;
      meetingEnd: (id: string, speakers: number, summary?: string, items?: string, duration?: number, entryIds?: string) => Promise<void>;
      meetingGet: (id: string) => Promise<string>;
      meetingList: (limit: number, offset: number) => Promise<string>;
      meetingDelete: (id: string) => Promise<void>;
      meetingCreateWithTemplate: (templateId: string | null, detectedApp: string | null) => Promise<string>;
      meetingSetStructuredOutput: (id: string, structuredOutput: string) => Promise<void>;
      // Meeting Recording (Granola-style chunk loop)
      meetingStartRecording: (sessionId: string, deviceName?: string | null, chunkIntervalS?: number) => Promise<void>;
      meetingStopRecording: () => Promise<any>;
      notifyMeetingUserNotesChanged: (sessionId: string) => void;
      // Streaming dictation (near-real-time chunked transcription)
      dictationStreamStart: () => Promise<void>;
      dictationStreamStop: () => Promise<{ text: string; chunkCount: number }>;
      onDictationStreamChunk: (cb: (p: { index: number; text: string; isFinal: boolean }) => void) => () => void;
      onDictationStreamState: (cb: (s: { status: string; startedAt: number | null; chunkCount: number }) => void) => () => void;
      // Meeting Room (LAN multi-user)
      meetingRoomHostStart: (sessionId: string, hostName: string, templateId?: string | null) => Promise<any>;
      meetingRoomHostStop: () => Promise<any>;
      meetingRoomHostInfo: () => Promise<any>;
      meetingRoomJoin: (opts: { hostIp: string; hostPort: number; roomCode: string; displayName: string; deviceName?: string | null }) => Promise<any>;
      meetingRoomLeave: () => Promise<any>;
      onMeetingRoomState: (cb: (info: any) => void) => () => void;
      onMeetingRoomParticipantUpdate: (cb: (msg: any) => void) => () => void;
      // Transcript Segments
      listTranscriptSegments: (sessionId: string) => Promise<string>;
      updateSegmentSpeaker: (id: string, speakerLabel: string) => Promise<void>;
      assembleFullTranscript: (sessionId: string) => Promise<string>;
      // Audio Input
      listAudioDevices: () => Promise<string>;
      getCurrentAudioDevice: () => Promise<string>;
      checkMicPermission: () => Promise<string>;
      // Meeting Templates
      templateCreate: (name: string, meetingType: string, sections: string, llmPrompt: string, displayLayout: string) => Promise<string>;
      templateGet: (id: string) => Promise<string>;
      templateList: () => Promise<string>;
      templateUpdate: (id: string, name: string, meetingType: string, sections: string, llmPrompt: string, displayLayout: string) => Promise<void>;
      templateDelete: (id: string) => Promise<void>;
      // Export / Sharing
      copyHtmlToClipboard: (html: string, fallbackText: string) => Promise<void>;
      exportEntryMarkdown: (id: string) => Promise<string>;
      exportEntryJson: (id: string) => Promise<string>;
      exportEntryPlainText: (id: string) => Promise<string>;
      exportMeetingMarkdown: (id: string) => Promise<string>;
      textToHtml: (text: string) => Promise<string>;
      saveFileDialog: (content: string, defaultName: string, filters: any[]) => Promise<string | null>;
      // TF.js Infrastructure
      getModelsDir: () => Promise<string>;
      // Model import
      importModel: () => Promise<any>;
      getImportableModels: () => Promise<any>;
      importModelFromPath: (filePath: string, sectionFilter: string) => Promise<any>;
      importMultiPartModel: () => Promise<any>;
      openExternal: (url: string) => Promise<void>;
      // Events
      onAiOutput: (callback: (data: any) => void) => () => void;
      onAiTurnStart: (callback: (data: any) => void) => () => void;
      onAiTurnEnd: (callback: (data: any) => void) => () => void;
      onHotkeyPressed: (callback: () => void) => () => void;
      onModelDownloadProgress: (callback: (progress: any) => void) => () => void;
      onPipelineStateChanged: (callback: (state: string) => void) => () => void;
      onNotificationNew: (callback: (notification: any) => void) => () => void;
      onWorkflowDiscovered: (callback: (workflow: any) => void) => () => void;
      onMeetingSegmentReady: (callback: (segment: any) => void) => () => void;
      onMeetingRecordingState: (callback: (state: any) => void) => () => void;
      onMeetingLiveSummary: (callback: (payload: { sessionId: string; summary: string; segmentCount: number; generatedAt: number }) => void) => () => void;
      onQuickAction: (callback: (action: 'start-dictation' | 'start-meeting') => void) => () => void;
      onMeetingAppDetected: (callback: (event: any, data: any) => void) => () => void;
      // BlackHole (macOS system audio)
      blackholeCheck: (deviceListJson?: string) => Promise<'installed' | 'not_installed' | 'unsupported'>;
      blackholeInstall: () => Promise<{ ok: boolean }>;
      blackholeOpenAudioMidiSetup: () => Promise<{ ok: boolean }>;
      onBlackholeInstallProgress: (callback: (p: any) => void) => () => void;
      // Notes Collaboration
      meetingCollabStart: (sessionId: string, hostName: string, notes: string, version?: number) => Promise<any>;
      meetingCollabStop: () => Promise<{ ok: boolean }>;
      meetingCollabNotifySaved: (notes: string, savedBy: string) => Promise<{ ok: boolean }>;
      meetingCollabNotifyDraft: (content: string, senderName: string) => Promise<{ ok: boolean }>;
      meetingCollabJoin: (opts: { hostIp: string; hostPort: number; sessionCode: string; displayName: string }) => Promise<any>;
      meetingCollabLeave: () => Promise<{ ok: boolean }>;
      meetingCollabSaveNotes: (content: string) => Promise<{ ok: boolean }>;
      meetingCollabSendDraft: (content: string) => Promise<{ ok: boolean }>;
      onMeetingCollabState: (callback: (info: any) => void) => () => void;
      onMeetingCollabNotesUpdated: (callback: (data: any) => void) => () => void;
      onMeetingCollabDraft: (callback: (data: any) => void) => () => void;
      onMeetingCollabEnded: (callback: () => void) => () => void;
      onMeetingCollabFirewallWarning: (callback: (data: { message: string }) => void) => () => void;
      onWhisperLoadFailed: (callback: (data: { message: string; permanent: boolean }) => void) => () => void;
      // Processing-state notification (fire-and-forget, renderer → main)
      notifyProcessingState: (isActive: boolean) => void;
    };
  }
}

export function useRustBridge() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(async <T>(fn: () => Promise<T>): Promise<T | null> => {
    setLoading(true);
    setError(null);
    try {
      const result = await fn();
      return result;
    } catch (err: any) {
      setError(err.message || 'Unknown error');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    loading,
    error,
    clearError: () => setError(null),
    api: window.ironmic,
    call,
  };
}
