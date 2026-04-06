/**
 * Hook wrapping the preload API calls with loading/error states.
 */

import { useState, useCallback } from 'react';
import type { Entry, NewEntry, EntryUpdate, ListOptions, ModelStatus } from '../types';

// Declare the global API exposed by preload
declare global {
  interface Window {
    ironmic: {
      startRecording: () => Promise<void>;
      stopRecording: () => Promise<Buffer>;
      isRecording: () => Promise<boolean>;
      resetRecording: () => Promise<void>;
      transcribe: (audioBuffer: Buffer) => Promise<string>;
      polishText: (rawText: string) => Promise<string>;
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
      addWord: (word: string) => Promise<void>;
      removeWord: (word: string) => Promise<void>;
      listDictionary: () => Promise<string[]>;
      getSetting: (key: string) => Promise<string | null>;
      setSetting: (key: string, value: string) => Promise<void>;
      copyToClipboard: (text: string) => Promise<void>;
      registerHotkey: (accelerator: string) => Promise<void>;
      getPipelineState: () => Promise<string>;
      resetPipelineState: () => Promise<void>;
      getModelStatus: () => Promise<any>;
      downloadModel: (model: 'whisper' | 'llm' | 'tts') => Promise<void>;
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
      ttsIsLoaded: () => Promise<boolean>;
      isTtsModelReady: () => Promise<boolean>;
      ttsToggle: () => Promise<string>;
      // AI Chat
      aiGetAuthState: () => Promise<any>;
      aiRefreshAuth: (provider?: string) => Promise<any>;
      aiPickProvider: () => Promise<string | null>;
      aiSendMessage: (prompt: string, provider: string) => Promise<string>;
      aiCancel: () => Promise<void>;
      aiResetSession: () => Promise<void>;
      onAiOutput: (callback: (data: any) => void) => () => void;
      onAiTurnStart: (callback: (data: any) => void) => () => void;
      onAiTurnEnd: (callback: (data: any) => void) => () => void;
      onHotkeyPressed: (callback: () => void) => () => void;
      onModelDownloadProgress: (callback: (progress: any) => void) => () => void;
      onPipelineStateChanged: (callback: (state: string) => void) => () => void;
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
