import { create } from 'zustand';
import { useToastStore } from './useToastStore';
import { sanitizeForTts } from '../utils/sanitizeForTts';

interface WordTimestamp {
  word: string;
  start_ms: number;
  end_ms: number;
}

interface TtsReadiness {
  ready: boolean;
  modelPresent: boolean;
  voicesPresent: boolean;
  selectedVoicePresent: boolean;
  selectedVoiceId: string;
  missingVoices: string[];
  espeakAvailable: boolean;
  espeakHint: string | null;
  modelPath: string;
  voicesDir: string;
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

/**
 * Build the toast message + repair hint for a non-ready TTS state. Routes the
 * user toward the specific missing piece (model / voices / espeak-ng) instead
 * of the legacy generic "TTS model not downloaded".
 */
function describeReadinessGap(r: TtsReadiness): { message: string; canRepair: boolean } {
  if (!r.espeakAvailable) {
    return {
      message: r.espeakHint
        ? `TTS phonemizer 'espeak-ng' is not installed. ${r.espeakHint}`
        : `TTS phonemizer 'espeak-ng' is not installed. Install it and try again.`,
      canRepair: false,
    };
  }
  if (!r.modelPresent && !r.voicesPresent) {
    return { message: `TTS assets missing — install the Kokoro model and voice pack to enable speech playback.`, canRepair: true };
  }
  if (!r.modelPresent) {
    return { message: `TTS model missing at ${r.modelPath}. Download it in Settings to enable speech playback.`, canRepair: true };
  }
  if (!r.voicesPresent) {
    const count = Math.max(0, 15 - r.missingVoices.length);
    return {
      message: `TTS voice pack missing (${count}/15 installed) at ${r.voicesDir}. Repair to install the voices.`,
      canRepair: true,
    };
  }
  return { message: 'TTS is not ready.', canRepair: true };
}

async function repairTts() {
  try { await window.ironmic.downloadModel('tts'); } catch (err: any) {
    useToastStore.getState().show({
      message: `TTS repair failed: ${err?.message || err}`,
      type: 'error',
    });
  }
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

    // Sanitize markdown / list markers / empty-symbol lines before they can
    // reach the phonemizer. Pure-symbol input ("- ", "* ", "---") otherwise
    // produces "Text produced no tokens" from Rust. Newlines become periods
    // so each line gets a natural prosodic pause. Length is capped at the
    // phonemizer-safe limit so a 50-page note can't blow the 510-token budget.
    const sanitized = sanitizeForTts(text);
    if (!sanitized.text) {
      set({ state: 'idle', error: null });
      useToastStore.getState().show({
        message: sanitized.emptyReason === 'symbols-only'
          ? 'Nothing readable to speak — the text contains only symbols or formatting markers.'
          : 'No text to speak.',
        type: 'info',
      });
      return;
    }
    if (sanitized.truncated) {
      useToastStore.getState().show({
        message: 'Note is long — only the first portion will be read aloud.',
        type: 'info',
      });
    }

    // Pre-flight readiness check — surface a precise toast and bail before
    // ever touching the Rust TTS engine. Reaching the engine in a not-ready
    // state was the previous failure mode that produced the generic
    // "not downloaded" toast for any of model/voices/espeak missing.
    try {
      const selectedVoice = await api.getSetting('tts_voice');
      const readiness = (await (api as any).ttsGetReadiness?.(selectedVoice || undefined)) as TtsReadiness | undefined;
      if (readiness && !readiness.ready) {
        const { message, canRepair } = describeReadinessGap(readiness);
        set({ state: 'idle', error: message });
        useToastStore.getState().show({
          message,
          type: 'error',
          action: canRepair
            ? { label: 'Repair TTS', onClick: () => { void repairTts(); } }
            : { label: 'Go to Settings', onClick: () => window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'settings' })) },
        });
        return;
      }
    } catch { /* readiness IPC unavailable in older builds — fall through to direct synth */ }

    set({ state: 'synthesizing', error: null, activeEntryId: entryId || null, timestamps: [], currentTimeMs: 0 });

    try {
      const resultJson = await api.synthesizeText(sanitized.text);
      const result = JSON.parse(resultJson);

      set({
        state: 'playing',
        timestamps: result.timestamps || [],
        durationMs: result.durationMs || 0,
      });

      // Start polling position for word highlighting
      startPolling(set, get);
    } catch (err: any) {
      // Readiness passed but synth still failed — surface the Rust error
      // verbatim. The Rust messages are now path-bearing (kokoro.rs#load_model
      // / load_voice_embedding), so they tell the user exactly what to fix.
      const msg = err.message || 'TTS synthesis failed';
      set({ state: 'idle', error: msg });
      useToastStore.getState().show({
        message: msg,
        type: 'error',
        action: { label: 'Go to Settings', onClick: () => window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'settings' })) },
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
  // Throttle the cumulative-state fetch to ~6×/sec (the timestamp array can
  // be large, no need to refetch every animation frame). Position is still
  // polled every frame so the live caption stays smooth.
  let lastStreamFetch = 0;
  const STREAM_POLL_INTERVAL_MS = 160;

  const poll = async () => {
    const state = get().state;
    if (state !== 'playing') return;

    try {
      const now = performance.now();
      const wantStream = now - lastStreamFetch >= STREAM_POLL_INTERVAL_MS;
      const requests: Promise<any>[] = [
        window.ironmic.ttsGetPosition(),
        window.ironmic.ttsGetState(),
      ];
      if (wantStream) {
        requests.push(((window.ironmic as any).ttsGetStreamState?.() ?? Promise.resolve(null)));
        lastStreamFetch = now;
      }
      const [posMs, ttsState, streamRaw] = await Promise.all(requests);

      const update: any = { currentTimeMs: posMs };

      if (streamRaw && typeof streamRaw === 'string') {
        try {
          const stream = JSON.parse(streamRaw);
          if (Array.isArray(stream.timestamps)) update.timestamps = stream.timestamps;
          if (typeof stream.durationMs === 'number') update.durationMs = stream.durationMs;
        } catch { /* malformed stream JSON — ignore this tick */ }
      }

      set(update);

      // Check if playback finished. The Rust side flips state→idle only
      // after streaming_complete is set AND the cursor reaches end of buffer,
      // so this signal is also the right "everything done" signal even for
      // streaming.
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
