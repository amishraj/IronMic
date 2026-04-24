import { create } from 'zustand';
import { useTtsStore } from './useTtsStore';
import { useAiChatStore } from './useAiChatStore';
import { useToastStore } from './useToastStore';
import { vadService } from '../services/tfjs/VADService';
import type { PipelineState, TranscriptionResult, VoiceState } from '../types';

interface RecordingStore {
  state: PipelineState;
  lastResult: TranscriptionResult | null;
  error: string | null;
  /** Real-time voice state from VAD (speech/silence/unknown) */
  voiceState: VoiceState;
  /** Whether VAD is active for the current recording */
  vadActive: boolean;

  setState: (state: PipelineState) => void;
  setResult: (result: TranscriptionResult) => void;
  setError: (error: string | null) => void;
  reset: () => void;

  // Full recording flow. sourceApp tags the entry (e.g. 'ai-chat').
  handleHotkeyPress: (sourceApp?: string) => Promise<void>;
}

// Guard against double-invocations
let actionInProgress = false;

export const useRecordingStore = create<RecordingStore>((set, get) => ({
  state: 'idle',
  lastResult: null,
  error: null,
  voiceState: 'unknown',
  vadActive: false,

  setState: (state) => set({ state }),
  setResult: (result) => set({ lastResult: result, state: 'idle' }),
  setError: (error) => set({ error }),
  reset: () => set({ state: 'idle', lastResult: null, error: null, voiceState: 'unknown', vadActive: false }),

  handleHotkeyPress: async (sourceApp?: string) => {
    // Prevent double-invocation (sidebar + page button + hotkey racing)
    if (actionInProgress) return;
    actionInProgress = true;

    try {
      await handleRecordingAction(get, set, sourceApp);
    } finally {
      actionInProgress = false;
    }
  },
}));

async function handleRecordingAction(
  get: () => RecordingStore,
  set: (partial: Partial<RecordingStore>) => void,
  sourceApp?: string,
) {
  const { state } = get();
  const api = window.ironmic;

  if (state === 'processing') return;

  // ── START RECORDING ──
  if (state === 'idle') {
    try {
      // Stop TTS playback before recording
      try { await useTtsStore.getState().stop(); } catch { /* ignore */ }
      set({ state: 'recording', error: null, voiceState: 'unknown', vadActive: false });

      // Start VAD alongside recording — but ONLY in turn-detection modes that
      // actually need it (auto-detect, always-listening). For default
      // push-to-talk, opening a second mic stream via getUserMedia + Web Audio
      // contends with Rust/cpal on Windows WASAPI and macOS CoreAudio, causing
      // empty captures and "dictation hangs" symptoms. The skip-if-empty
      // optimization VAD provided isn't worth that cost in push-to-talk where
      // the user is explicitly framing the recording.
      try {
        const vadEnabled = await api.getSetting('vad_enabled');
        const turnMode = (await api.getSetting('turn_detection_mode')) || 'push-to-talk';
        const needsVad = vadEnabled !== 'false' && turnMode !== 'push-to-talk';
        if (needsVad) {
          const sensitivity = parseFloat((await api.getSetting('vad_sensitivity')) || '0.5');
          vadService.setSensitivity(sensitivity);
          await vadService.start();
          set({ vadActive: true });
          vadService.onVoiceStateChange((voiceState) => {
            set({ voiceState });
          });
        }
      } catch (vadErr) {
        console.warn('[recording] VAD failed to start (non-fatal):', vadErr);
      }

      try {
        await api.startRecording();
      } catch (startErr: any) {
        // If Rust says "already active", the state is out of sync.
        // Force-reset Rust, then retry once.
        if (startErr.message?.includes('already active')) {
          console.warn('[recording] Rust says already active — force-resetting and retrying');
          try {
            await api.resetRecording();
            await api.startRecording();
          } catch (retryErr: any) {
            set({ state: 'idle', error: retryErr.message || 'Failed to start recording' });
            showErrorToast('Recording failed to start. Please try again.', retryErr.message);
            return;
          }
        } else {
          throw startErr;
        }
      }
    } catch (err: any) {
      set({ state: 'idle', error: err.message || 'Failed to start recording' });
      showErrorToast('Could not access your microphone.', err.message);
    }
    return;
  }

  // ── STOP RECORDING + PROCESS ──
  if (state === 'recording') {
    try {
      set({ state: 'processing', voiceState: 'unknown' });

      // Stop VAD and check speech detection
      const vadResult = vadService.isActive() ? vadService.stop() : null;
      set({ vadActive: false });

      // If VAD detected insufficient speech, skip transcription entirely
      if (vadResult && !vadResult.hasSufficientSpeech) {
        console.log(`[recording] VAD: insufficient speech (${vadResult.totalSpeechMs}ms) — skipping transcription`);
        try { await api.stopRecording(); } catch { /* discard audio */ }
        set({ state: 'idle', lastResult: null, error: null });
        window.dispatchEvent(new CustomEvent('ironmic:dictation-empty'));
        return;
      }

      let audioBuffer: Buffer;
      try {
        audioBuffer = await api.stopRecording();
      } catch (stopErr: any) {
        // If stop fails, force-reset to recover
        console.error('[recording] Stop failed, force-resetting:', stopErr);
        try { await api.resetRecording(); } catch { /* last resort */ }
        set({ state: 'idle', error: null });
        showErrorToast('Recording stopped unexpectedly.', 'The recording was reset. Please try again.');
        return;
      }

      let rawTranscript: string;
      try {
        rawTranscript = await api.transcribe(audioBuffer);
      } catch (transcribeErr: any) {
        set({ state: 'idle', error: transcribeErr.message });
        showErrorToast(
          'Transcription failed.',
          transcribeErr.message?.includes('not found') || transcribeErr.message?.includes('not downloaded')
            ? 'The Whisper model is not downloaded. Go to Settings > Models to download it.'
            : transcribeErr.message,
          transcribeErr.message?.includes('not found') || transcribeErr.message?.includes('not downloaded')
            ? { label: 'Go to Settings', onClick: () => window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'settings' })) }
            : undefined,
        );
        return;
      }

      // If the native addon returned a stub response, Whisper was not compiled
      // into this build. Surface a clear error so the user knows why nothing happens.
      if (rawTranscript.trim().startsWith('[stub')) {
        set({ state: 'idle', error: 'Whisper engine not available in this build' });
        showErrorToast(
          'Transcription engine missing.',
          'This build does not include Whisper support. Reinstall the latest release from GitHub.',
        );
        return;
      }

      // If nothing was heard, skip everything
      if (!rawTranscript.trim()) {
        set({ state: 'idle', lastResult: null, error: null });
        window.dispatchEvent(new CustomEvent('ironmic:dictation-empty'));
        return;
      }

      // LLM cleanup
      const cleanupEnabled = await api.getSetting('llm_cleanup_enabled');
      let polishedText: string | null = null;

      if (cleanupEnabled === 'true' && rawTranscript.trim()) {
        try {
          polishedText = await api.polishText(rawTranscript);
        } catch {
          // LLM polish is optional — continue without it
        }
      }

      const finalText = polishedText || rawTranscript;

      // Copy to clipboard, with optional auto-clear
      try {
        await api.copyToClipboard(finalText);
        const autoClear = await api.getSetting('security_clipboard_auto_clear');
        if (autoClear && autoClear !== 'off') {
          const seconds = parseInt(autoClear);
          if (seconds > 0) {
            setTimeout(() => api.copyToClipboard('').catch(() => {}), seconds * 1000);
          }
        }
      } catch { /* clipboard is nice-to-have */ }

      // If recorded from the AI tab, ensure a session exists before saving
      if (sourceApp === 'ai-chat') {
        if (!useAiChatStore.getState().activeSessionId) {
          useAiChatStore.getState().createSession(null);
        }
        window.dispatchEvent(new CustomEvent('ironmic:ai-dictation', { detail: finalText }));
      }

      // Build sourceApp — include session ID for AI entries
      let resolvedSourceApp = sourceApp;
      if (sourceApp === 'ai-chat') {
        const sessionId = useAiChatStore.getState().activeSessionId;
        if (sessionId) resolvedSourceApp = `ai-chat:${sessionId}`;
      }

      // Save entry
      let savedEntryId: string | null = null;
      try {
        const saved = await api.createEntry({
          rawTranscript,
          polishedText: polishedText ?? undefined,
          durationSeconds: undefined,
          sourceApp: resolvedSourceApp ?? undefined,
        } as any);
        savedEntryId = saved?.id ?? null;
      } catch (saveErr: any) {
        console.error('[recording] Failed to save entry:', saveErr);
        // Don't fail the whole flow — text is already in clipboard
      }

      // Auto read-back if enabled
      try {
        const autoReadback = await api.getSetting('tts_auto_readback');
        if (autoReadback === 'true' && finalText.trim()) {
          await useTtsStore.getState().synthesizeAndPlay(finalText);
        }
      } catch { /* TTS is optional */ }

      // Notify the app that dictation completed
      window.dispatchEvent(new CustomEvent('ironmic:dictation-complete', {
        detail: {
          text: finalText,
          sourceApp: resolvedSourceApp || null,
          entryId: savedEntryId,
          preview: finalText.length > 80 ? finalText.slice(0, 80) + '...' : finalText,
        },
      }));

      set({
        state: 'idle',
        lastResult: { rawTranscript, polishedText, durationSeconds: 0 },
        error: null,
      });
    } catch (err: any) {
      // Catch-all: force-reset Rust side to ensure we're not stuck
      try { await api.resetRecording(); } catch { /* ignore */ }
      set({ state: 'idle', error: err.message || 'Processing failed' });
      showErrorToast('Something went wrong during processing.', err.message);
    }
  }
}

/** Show an error toast with optional action button */
function showErrorToast(
  message: string,
  detail?: string,
  action?: { label: string; onClick: () => void },
) {
  useToastStore.getState().show({
    message: detail ? `${message} ${detail}` : message,
    type: 'error',
    durationMs: 10000,
    action,
  });
}
