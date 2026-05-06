import React, { useEffect, useRef } from 'react';
import { Mic, X, Check, Copy, AlertCircle } from 'lucide-react';
import { useForgeStore } from '../stores/useForgeStore';

const STATUS_LABEL: Record<string, string> = {
  idle: 'Forge — Idle',
  recording: 'Listening…',
  stopping: 'Finishing…',
  pasting: 'Pasting…',
};

const STATUS_HINT_BY_MODE: Record<string, Record<string, string>> = {
  idle: {
    default: 'Hold ⌥ to talk · ⌥+Space or click mic for hands-free',
    win: 'Hold Ctrl+Win to talk · Ctrl+Win+Space for hands-free',
  },
  recording: {
    'push-to-talk': 'Release to paste',
    'hands-free': 'Tap mic or chord again to stop',
  },
};

const ForgeBar: React.FC = () => {
  const status = useForgeStore((s) => s.status);
  const mode = useForgeStore((s) => s.mode);
  const lastError = useForgeStore((s) => s.lastError);
  const previewText = useForgeStore((s) => s.previewText);
  const draftText = useForgeStore((s) => s.draftText);
  const toast = useForgeStore((s) => s.toast);
  const handleHotkeyPress = useForgeStore((s) => s.handleHotkeyPress);
  const startPushToTalk = useForgeStore((s) => s.startPushToTalk);
  const endPushToTalk = useForgeStore((s) => s.endPushToTalk);
  const cancelPushToTalk = useForgeStore((s) => s.cancelPushToTalk);
  const loadSettings = useForgeStore((s) => s.loadSettings);
  const clearToast = useForgeStore((s) => s.clearToast);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (!toast) return;
    const remaining = Math.max(0, toast.ttl - (Date.now() - toast.shownAt));
    const t = setTimeout(() => clearToast(), remaining);
    return () => clearTimeout(t);
  }, [toast, clearToast]);

  // Hotkey events from main:
  //   - 'ironmic:hotkey-pressed'    → hands-free toggle (chord or fallback)
  //   - 'ironmic:forge-ptt-start'   → modifier(s) held past chord-grace
  //   - 'ironmic:forge-ptt-end'     → modifier(s) released
  useEffect(() => {
    const api = (window as any).ironmic;
    if (!api) return;
    const offHotkey = api.onHotkeyPressed?.(() => handleHotkeyPress());
    const offPttStart = api.onForgePushToTalkStart?.(() => {
      void startPushToTalk();
    });
    const offPttEnd = api.onForgePushToTalkEnd?.(() => {
      void endPushToTalk();
    });
    const offPttCancel = api.onForgePushToTalkCancel?.(() => {
      void cancelPushToTalk();
    });
    return () => {
      try { offHotkey?.(); } catch { /* ignore */ }
      try { offPttStart?.(); } catch { /* ignore */ }
      try { offPttEnd?.(); } catch { /* ignore */ }
      try { offPttCancel?.(); } catch { /* ignore */ }
    };
  }, [handleHotkeyPress, startPushToTalk, endPushToTalk, cancelPushToTalk]);

  // Streaming dictation events.
  useEffect(() => {
    const api = (window as any).ironmic;
    if (!api) return;
    const offChunk = api.onDictationStreamChunk?.(
      (payload: { index: number; text: string; isFinal: boolean }) => {
        const { status: forgeStatus } = useForgeStore.getState();
        if (forgeStatus === 'idle') return;
        useForgeStore.getState().handleChunk(payload.text, payload.isFinal);
      },
    );
    const offDraft = api.onDictationStreamDraft?.(
      (payload: { hypothesis: string }) => {
        const { status: forgeStatus } = useForgeStore.getState();
        if (forgeStatus !== 'recording') return;
        useForgeStore.getState().handleDraft(payload.hypothesis || '');
      },
    );
    const offState = api.onDictationStreamState?.(
      (s: { status: string; chunkCount: number }) => {
        if (s.status === 'idle') {
          const { status: forgeStatus } = useForgeStore.getState();
          if (forgeStatus !== 'idle') {
            void useForgeStore.getState().finalize();
          }
        }
      },
    );
    return () => {
      try { offChunk?.(); } catch { /* ignore */ }
      try { offDraft?.(); } catch { /* ignore */ }
      try { offState?.(); } catch { /* ignore */ }
    };
  }, []);

  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [previewText, draftText]);

  const exitForge = async () => {
    try { await (window as any).ironmic?.exitForge?.(); } catch { /* ignore */ }
  };

  const onMicClick = () => {
    // Mic click always means hands-free — same gesture as the chord hotkey.
    void handleHotkeyPress();
  };

  const micClass = `forge-mic-button forge-no-drag ${
    status === 'recording'
      ? 'recording'
      : status === 'stopping' || status === 'pasting'
        ? 'processing'
        : 'idle'
  }`;

  const isWin = navigator.platform.toLowerCase().includes('win');
  const platformKey = isWin ? 'win' : 'default';

  // Hint text adapts to the current state and mode. While recording in
  // push-to-talk, prompt the release. While in hands-free, prompt the
  // toggle. While idle, show the gesture options.
  const hintText: string = (() => {
    if (lastError && status === 'idle') return lastError;
    if (status === 'idle') return STATUS_HINT_BY_MODE.idle[platformKey];
    if (status === 'recording' && mode) {
      return STATUS_HINT_BY_MODE.recording[mode] || '';
    }
    return '';
  })();

  const isExpanded = status !== 'idle' || !!lastError || !!toast;
  const showPreview =
    status === 'recording' || status === 'stopping' || status === 'pasting';
  const showError = !!lastError && status === 'idle';

  return (
    <div className={`forge-bar forge-drag ${isExpanded ? 'expanded' : ''} ${showError ? 'error' : ''}`}>
      <div className="forge-bar-row">
        <button
          type="button"
          className={micClass}
          title={
            status === 'recording'
              ? 'Click to stop hands-free dictation'
              : 'Click to start hands-free dictation'
          }
          onClick={onMicClick}
        >
          <Mic size={20} strokeWidth={2.2} />
        </button>

        <div className="forge-status">
          <div className="forge-status-label">
            {showError ? 'Last error' : STATUS_LABEL[status] || status}
          </div>
          <div className="forge-status-hint" title={lastError || undefined}>
            {hintText}
          </div>
        </div>

        <button
          type="button"
          className="forge-btn forge-no-drag"
          title="Exit Forge mode"
          onClick={exitForge}
        >
          <X size={15} strokeWidth={2.2} />
        </button>
      </div>

      {showPreview && (
        <div className="forge-preview forge-no-drag" ref={previewRef}>
          {previewText || draftText ? (
            <>
              {previewText && <span className="forge-preview-committed">{previewText}</span>}
              {previewText && draftText ? ' ' : ''}
              {draftText && <span className="forge-preview-draft">{draftText}</span>}
            </>
          ) : (
            <span className="forge-preview-placeholder">Waiting for speech…</span>
          )}
        </div>
      )}

      {toast && (
        <div className={`forge-toast forge-no-drag forge-toast-${toast.kind}`} role="status">
          {toast.kind === 'success' && <Check size={13} strokeWidth={2.4} />}
          {toast.kind === 'info' && <Copy size={13} strokeWidth={2.4} />}
          {toast.kind === 'error' && <AlertCircle size={13} strokeWidth={2.4} />}
          <span>{toast.text}</span>
        </div>
      )}
    </div>
  );
};

export default ForgeBar;
