import { create } from 'zustand';

/**
 * Cross-page intent for opening Settings to a specific tab and (optionally)
 * focusing a specific control. Set by callers like AIChat's
 * "Enable cloud Voice Chat" deep-link, then consumed by SettingsPanel on
 * mount. Decoupled from the navigation router so it survives the brief
 * window where Settings hasn't mounted yet — a CustomEvent dispatched
 * before mount would drop on the floor.
 */

export type SettingsTab =
  | 'general'
  | 'audio'
  | 'speech'
  | 'ai'
  | 'voice-ai'
  | 'models'
  | 'data'
  | 'security';

interface SettingsIntent {
  pendingTab: SettingsTab | null;
  focusKey: string | null;
  setIntent: (intent: { pendingTab?: SettingsTab | null; focusKey?: string | null }) => void;
  consume: () => void;
}

export const useSettingsIntentStore = create<SettingsIntent>((set) => ({
  pendingTab: null,
  focusKey: null,
  setIntent: ({ pendingTab = null, focusKey = null }) =>
    set({ pendingTab, focusKey }),
  consume: () => set({ pendingTab: null, focusKey: null }),
}));
