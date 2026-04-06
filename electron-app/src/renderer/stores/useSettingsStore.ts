import { create } from 'zustand';

interface SettingsStore {
  hotkey: string;
  llmCleanupEnabled: boolean;
  aiEnabled: boolean;
  defaultView: 'timeline' | 'editor';
  theme: 'system' | 'light' | 'dark';
  loaded: boolean;

  loadSettings: () => Promise<void>;
  setHotkey: (hotkey: string) => Promise<void>;
  setLlmCleanup: (enabled: boolean) => Promise<void>;
  setAiEnabled: (enabled: boolean) => Promise<void>;
  setDefaultView: (view: 'timeline' | 'editor') => Promise<void>;
  setTheme: (theme: 'system' | 'light' | 'dark') => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  hotkey: 'CommandOrControl+Shift+V',
  llmCleanupEnabled: true,
  aiEnabled: true,
  defaultView: 'timeline',
  theme: 'system',
  loaded: false,

  loadSettings: async () => {
    const api = window.ironmic;
    const [hotkey, cleanup, ai, view, theme] = await Promise.all([
      api.getSetting('hotkey_record'),
      api.getSetting('llm_cleanup_enabled'),
      api.getSetting('ai_enabled'),
      api.getSetting('default_view'),
      api.getSetting('theme'),
    ]);

    const resolvedTheme = (theme as 'system' | 'light' | 'dark') || 'system';
    localStorage.setItem('ironmic-theme', resolvedTheme);

    set({
      hotkey: hotkey || 'CommandOrControl+Shift+V',
      llmCleanupEnabled: cleanup !== 'false',
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
  },
}));
