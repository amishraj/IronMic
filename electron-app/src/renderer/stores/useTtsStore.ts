import { create } from 'zustand';
import { useToastStore } from './useToastStore';

interface WordTimestamp {
  word: string;
  start_ms: number;
  end_ms: number;
}

type TtsState = 'idle' | 'synthesizing' | 'playing' | 'paused';

interface TtsStore {
  state: TtsState;
  timestamps: WordTimestamp[];
  currentTimeMs: number;
  durationMs: number;
  speed: number;
  error: string | null;
  activeEntryId: string | null;
  pollHandle: number | null;

  synthesizeAndPlay: (text: string, entryId?: string) => Promise<void>;
  play: () => Promise<void>;
  pause: () => Promise<void>;
  stop: () => Promise<void>;
  toggle: () => Promise<void>;
  setSpeed: (speed: number) => Promise<void>;
}

export const useTtsStore = create<TtsStore>((set, get) => ({
  state: 'idle',
  timestamps: [],
  currentTimeMs: 0,
  durationMs: 0,
  speed: 1.0,
  error: null,
  activeEntryId: null,
  pollHandle: null,

  synthesizeAndPlay: async (text, entryId) => {
    const api = window.ironmic;

    // Stop any current playback
    const { pollHandle } = get();
    if (pollHandle) cancelAnimationFrame(pollHandle);
    try { await api.ttsStop(); } catch { /* ignore */ }

    set({ state: 'synthesizing', error: null, activeEntryId: entryId || null, timestamps: [], currentTimeMs: 0 });

    try {
      const resultJson = await api.synthesizeText(text);
      const result = JSON.parse(resultJson);

      set({
        state: 'playing',
        timestamps: result.timestamps || [],
        durationMs: result.durationMs || 0,
      });

      // Start polling position for word highlighting
      startPolling(set, get);
    } catch (err: any) {
      const msg = err.message || 'TTS synthesis failed';
      set({ state: 'idle', error: msg });

      const isModelMissing = msg.includes('not downloaded') || msg.includes('not found');
      useToastStore.getState().show({
        message: isModelMissing
          ? 'TTS model not downloaded. Download it in Settings to enable speech playback.'
          : `Text-to-speech failed: ${msg}`,
        type: 'error',
        action: isModelMissing
          ? { label: 'Go to Settings', onClick: () => window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'settings' })) }
          : undefined,
      });
    }
  },

  play: async () => {
    await window.ironmic.ttsPlay();
    set({ state: 'playing' });
    startPolling(set, get);
  },

  pause: async () => {
    await window.ironmic.ttsPause();
    const { pollHandle } = get();
    if (pollHandle) cancelAnimationFrame(pollHandle);
    set({ state: 'paused', pollHandle: null });
  },

  stop: async () => {
    const { pollHandle } = get();
    if (pollHandle) cancelAnimationFrame(pollHandle);
    await window.ironmic.ttsStop();
    set({ state: 'idle', timestamps: [], currentTimeMs: 0, durationMs: 0, activeEntryId: null, pollHandle: null });
  },

  toggle: async () => {
    const { state } = get();
    if (state === 'playing') {
      await get().pause();
    } else if (state === 'paused') {
      await get().play();
    }
  },

  setSpeed: async (speed) => {
    await window.ironmic.ttsSetSpeed(speed);
    set({ speed });
  },
}));

function startPolling(
  set: (partial: Partial<ReturnType<typeof useTtsStore.getState>>) => void,
  get: () => ReturnType<typeof useTtsStore.getState>,
) {
  const poll = async () => {
    const state = get().state;
    if (state !== 'playing') return;

    try {
      const [posMs, ttsState] = await Promise.all([
        window.ironmic.ttsGetPosition(),
        window.ironmic.ttsGetState(),
      ]);

      set({ currentTimeMs: posMs });

      // Check if playback finished
      if (ttsState === 'idle') {
        set({ state: 'idle', currentTimeMs: 0, activeEntryId: null, pollHandle: null });
        return;
      }
    } catch { /* ignore polling errors */ }

    const handle = requestAnimationFrame(poll);
    set({ pollHandle: handle });
  };

  const handle = requestAnimationFrame(poll);
  set({ pollHandle: handle });
}
