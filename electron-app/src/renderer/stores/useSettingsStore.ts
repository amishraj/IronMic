import { create } from 'zustand';

interface SettingsStore {
  hotkey: string;
  llmCleanupEnabled: boolean;
  /** 'rich' (default) renders polished notes + meeting summaries with
   *  headings, lists, bold, tables, etc. 'plain' falls back to flat text
   *  using the legacy CLEANUP_SYSTEM_PROMPT. */
  polishFormatMode: 'rich' | 'plain';
  aiEnabled: boolean;
  defaultView: 'timeline' | 'editor';
  theme: 'system' | 'light' | 'dark';
  loaded: boolean;

  loadSettings: () => Promise<void>;
  setHotkey: (hotkey: string) => Promise<void>;
  setLlmCleanup: (enabled: boolean) => Promise<void>;
  setPolishFormatMode: (mode: 'rich' | 'plain') => Promise<void>;
  setAiEnabled: (enabled: boolean) => Promise<void>;
  setDefaultView: (view: 'timeline' | 'editor') => Promise<void>;
  setTheme: (theme: 'system' | 'light' | 'dark') => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  hotkey: 'CommandOrControl+Shift+V',
  llmCleanupEnabled: true,
  polishFormatMode: 'rich',
  aiEnabled: true,
  defaultView: 'timeline',
  theme: 'system',
  loaded: false,

  loadSettings: async () => {
    const api = window.ironmic;
    const [hotkey, cleanup, formatMode, ai, view, theme] = await Promise.all([
      api.getSetting('hotkey_record'),
      api.getSetting('llm_cleanup_enabled'),
      api.getSetting('polish_format_mode'),
      api.getSetting('ai_enabled'),
      api.getSetting('default_view'),
      api.getSetting('theme'),
    ]);

    const resolvedTheme = (theme as 'system' | 'light' | 'dark') || 'system';
    localStorage.setItem('ironmic-theme', resolvedTheme);

    set({
      hotkey: hotkey || 'CommandOrControl+Shift+V',
      llmCleanupEnabled: cleanup !== 'false',
      // 'rich' is the new default. Missing setting (Phase 4 before Phase 5
      // migrates) also resolves to 'rich' so the feature is on day one.
      polishFormatMode: formatMode === 'plain' ? 'plain' : 'rich',
      aiEnabled: ai !== 'false', // on by default
      defaultView: (view as 'timeline' | 'editor') || 'timeline',
      theme: resolvedTheme,
      loaded: true,
    });
  },

  setHotkey: async (hotkey) => {
    await window.ironmic.setSetting('hotkey_record', hotkey);
    await window.ironmic.registerHotkey(hotkey);
    set({ hotkey });
  },

  setLlmCleanup: async (enabled) => {
    await window.ironmic.setSetting('llm_cleanup_enabled', String(enabled));
    set({ llmCleanupEnabled: enabled });
  },

  setPolishFormatMode: async (mode) => {
    await window.ironmic.setSetting('polish_format_mode', mode);
    set({ polishFormatMode: mode });
  },

  setAiEnabled: async (enabled) => {
    await window.ironmic.setSetting('ai_enabled', String(enabled));
    set({ aiEnabled: enabled });
  },

  setDefaultView: async (view) => {
    await window.ironmic.setSetting('default_view', view);
    set({ defaultView: view });
  },

  setTheme: async (theme) => {
    await window.ironmic.setSetting('theme', theme);
    localStorage.setItem('ironmic-theme', theme);
    set({ theme });
    // Broadcast to all other windows (Forge bar, secondary windows). The
    // main process re-emits as 'ironmic:theme-changed' so they re-evaluate
    // light/dark and toggle the `dark` class atomically.
    try {
      await (window as any).ironmic?.broadcastTheme?.(theme);
    } catch (err) {
      console.warn('[settings] broadcastTheme failed:', err);
    }
  },
}));
