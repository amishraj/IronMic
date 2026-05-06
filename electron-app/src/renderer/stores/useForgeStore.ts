import { create } from 'zustand';

export type ForgeStatus = 'idle' | 'recording' | 'stopping' | 'pasting';

/** Toast surfaced inside the bar ("Copied", "Pasted", error). Auto-dismisses. */
export interface ForgeToast {
  kind: 'success' | 'info' | 'error';
  text: string;
  /** epoch ms when shown — used to auto-dismiss after `ttl`. */
  shownAt: number;
  ttl: number;
}

interface ForgeState {
  status: ForgeStatus;
  /** Mode of the current dictation:
   *    - 'push-to-talk': started by Fn/Ctrl+Win held, ends on release
   *    - 'hands-free':   started by chord (Fn+Space / Ctrl+Win+Space) or mic click,
   *                      ends on the same gesture again. */
  mode: 'push-to-talk' | 'hands-free' | null;
  lastError: string | null;
  previewText: string;
  draftText: string;
  actionInProgress: boolean;
  startedAt: number | null;
  pasteMode: 'paste' | 'type';
  historyEnabled: boolean;
  clipboardRestore: boolean;

  lastAutoCopyWordCount: number;
  lastCopiedText: string;
  toast: ForgeToast | null;

  loadSettings: () => Promise<void>;
  /** Hands-free toggle entry point. Called from chord, mic click, etc. */
  handleHotkeyPress: () => Promise<void>;
  /** Push-to-talk: modifier(s) pressed, start dictation. */
  startPushToTalk: () => Promise<void>;
  /** Push-to-talk: modifier(s) released, stop and paste. */
  endPushToTalk: () => Promise<void>;
  /** Push-to-talk aborted by chord upgrade — stop without paste. */
  cancelPushToTalk: () => Promise<void>;
  handleChunk: (text: string, isFinal: boolean) => void;
  handleDraft: (hypothesis: string) => void;
  finalize: () => Promise<void>;
  reset: () => void;
  showToast: (toast: Omit<ForgeToast, 'shownAt'>) => void;
  clearToast: () => void;
}

// Auto-copy thresholds. Every time word count crosses one of these we push
// the accumulated transcript to the system clipboard and flash a toast. That
// way the user always has a working copy in their clipboard even if the
// final paste-at-cursor fails for whatever reason.
const AUTOCOPY_WORD_THRESHOLDS = [10, 30, 60, 120, 240, 500];

function wordCount(s: string): number {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}

function nextThresholdHit(currentWords: number, lastCopiedAt: number): number | null {
  for (const t of AUTOCOPY_WORD_THRESHOLDS) {
    if (currentWords >= t && lastCopiedAt < t) return t;
  }
  return null;
}

export const useForgeStore = create<ForgeState>((set, get) => ({
  status: 'idle',
  mode: null,
  lastError: null,
  previewText: '',
  draftText: '',
  actionInProgress: false,
  startedAt: null,
  pasteMode: 'paste',
  historyEnabled: false,
  clipboardRestore: true,
  lastAutoCopyWordCount: 0,
  lastCopiedText: '',
  toast: null,

  async loadSettings() {
    const api = (window as any).ironmic;
    if (!api) return;
    try {
      const [pasteMethod, history, restore] = await Promise.all([
        api.getSetting('forge_paste_method'),
        api.getSetting('forge_persist_history'),
        api.getSetting('forge_clipboard_restore'),
      ]);
      set({
        pasteMode: pasteMethod === 'type' ? 'type' : 'paste',
        historyEnabled: history === 'true',
        clipboardRestore: restore !== 'false',
      });
    } catch (err) {
      console.warn('[forge] loadSettings failed:', err);
    }
  },

  reset() {
    set({
      status: 'idle',
      mode: null,
      actionInProgress: false,
      lastError: null,
      previewText: '',
      draftText: '',
      startedAt: null,
      lastAutoCopyWordCount: 0,
      lastCopiedText: '',
      toast: null,
    });
  },

  showToast(toast) {
    set({ toast: { ...toast, shownAt: Date.now() } });
  },

  clearToast() {
    set({ toast: null });
  },

  handleDraft(hypothesis: string) {
    const { status } = get();
    if (status !== 'recording') return;
    set({ draftText: hypothesis });
  },

  handleChunk(text: string, _isFinal: boolean) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const { previewText, status, lastAutoCopyWordCount } = get();
    if (status === 'idle') return;
    const merged = (previewText ? `${previewText} ${trimmed}` : trimmed)
      .replace(/\s+/g, ' ')
      .trim();
    set({ previewText: merged, draftText: '' });

    // Auto-copy at word-count milestones so the clipboard always has a fresh
    // copy of the dictation. Quick safety net if paste-at-cursor fails.
    const wc = wordCount(merged);
    const hit = nextThresholdHit(wc, lastAutoCopyWordCount);
    if (hit !== null) {
      const api = (window as any).ironmic;
      api?.copyToClipboard?.(merged)
        .then(() => {
          set({ lastAutoCopyWordCount: hit, lastCopiedText: merged });
          // Subtle, short-lived toast — don't yell at the user mid-dictation.
          get().showToast({ kind: 'info', text: `Copied (${wc} words)`, ttl: 1200 });
          console.log(`[forge] auto-copy at ${wc} words`);
        })
        .catch((err: any) => console.warn('[forge] auto-copy failed:', err?.message || err));
    }
  },

  /** Hands-free toggle. Called from chord hotkey or mic click. */
  async handleHotkeyPress() {
    const api = (window as any).ironmic;
    if (!api) return;

    const { status, actionInProgress, mode } = get();
    if (actionInProgress) return;

    // If a push-to-talk session is mid-flight, ignore — user will release.
    if (mode === 'push-to-talk') return;

    if (status === 'idle') {
      set({
        actionInProgress: true,
        mode: 'hands-free',
        lastError: null,
        previewText: '',
        draftText: '',
        startedAt: Date.now(),
        lastAutoCopyWordCount: 0,
        lastCopiedText: '',
        toast: null,
      });
      try {
        await api.dictationStreamStart();
        set({ status: 'recording', actionInProgress: false });
        console.log('[forge] hands-free streaming started');
      } catch (err: any) {
        const msg = err?.message || String(err);
        console.error('[forge] dictationStreamStart failed:', msg);
        set({ status: 'idle', mode: null, actionInProgress: false, lastError: msg, startedAt: null });
        get().showToast({ kind: 'error', text: msg, ttl: 4000 });
        api.notifyForgeDictationComplete?.(msg);
      }
      return;
    }

    if (status === 'recording') {
      set({ actionInProgress: true, status: 'stopping' });
      try {
        await api.dictationStreamStop();
        console.log('[forge] hands-free stop requested');
      } catch (err: any) {
        const msg = err?.message || String(err);
        console.error('[forge] dictationStreamStop failed:', msg);
        set({ lastError: msg });
        await get().finalize();
      }
      return;
    }
  },

  /** Push-to-talk start: modifier(s) pressed past the chord-grace window. */
  async startPushToTalk() {
    const api = (window as any).ironmic;
    if (!api) return;

    const { status, actionInProgress, mode } = get();
    if (actionInProgress) return;
    if (status !== 'idle' || mode !== null) {
      // Hands-free already running or stopping — don't interrupt.
      console.log('[forge] PTT start ignored — busy:', { status, mode });
      return;
    }

    set({
      actionInProgress: true,
      mode: 'push-to-talk',
      lastError: null,
      previewText: '',
      draftText: '',
      startedAt: Date.now(),
      lastAutoCopyWordCount: 0,
      lastCopiedText: '',
      toast: null,
    });
    try {
      await api.dictationStreamStart();
      set({ status: 'recording', actionInProgress: false });
      console.log('[forge] push-to-talk streaming started');
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.error('[forge] PTT start failed:', msg);
      set({ status: 'idle', mode: null, actionInProgress: false, lastError: msg, startedAt: null });
      get().showToast({ kind: 'error', text: msg, ttl: 4000 });
      api.notifyForgeDictationComplete?.(msg);
    }
  },

  /** Push-to-talk aborted (user pressed chord) — stop streaming and reset
   *  WITHOUT pasting. Subsequent hands-free-toggle event will start a fresh
   *  recording from idle.
   *
   *  CRITICAL: state must be reset SYNCHRONOUSLY before any await. The
   *  hands-free-toggle IPC arrives within microseconds of this cancel, and
   *  if `mode` is still 'push-to-talk' when handleHotkeyPress runs, it
   *  bails out and the user sees nothing happen. */
  async cancelPushToTalk() {
    const api = (window as any).ironmic;
    const { mode, status } = get();
    if (mode !== 'push-to-talk') return;

    // Synchronous reset — must happen BEFORE any async work so the queued
    // hands-free hotkey-press handler sees idle state.
    set({
      status: 'idle',
      mode: null,
      actionInProgress: false,
      previewText: '',
      draftText: '',
      startedAt: null,
      lastAutoCopyWordCount: 0,
      lastCopiedText: '',
    });
    api?.notifyForgeDictationComplete?.(null);
    console.log('[forge] PTT cancelled (chord upgrade)');

    // Fire-and-forget the streaming-stop. No paste happens regardless of
    // outcome because we already cleared previewText.
    if (status === 'recording') {
      api.dictationStreamStop().catch((err: any) => {
        console.warn('[forge] PTT cancel stop failed:', err?.message || err);
      });
    }
  },

  /** Push-to-talk end: modifier(s) released — stop and paste. */
  async endPushToTalk() {
    const api = (window as any).ironmic;
    if (!api) return;

    const { status, mode } = get();
    if (mode !== 'push-to-talk') {
      // Either we never started (chord upgrade), or hands-free took over.
      console.log('[forge] PTT end ignored — mode is', mode);
      return;
    }

    if (status === 'recording') {
      set({ actionInProgress: true, status: 'stopping' });
      try {
        await api.dictationStreamStop();
        console.log('[forge] push-to-talk stop requested');
      } catch (err: any) {
        const msg = err?.message || String(err);
        console.error('[forge] PTT stop failed:', msg);
        set({ lastError: msg });
        await get().finalize();
      }
    } else if (status === 'idle') {
      // Race: we never finished starting. Clear the mode so the next gesture works.
      set({ mode: null, actionInProgress: false });
    }
  },

  async finalize() {
    const api = (window as any).ironmic;
    const {
      previewText,
      draftText,
      startedAt,
      pasteMode,
      clipboardRestore,
      status,
    } = get();

    if (status === 'idle') return;

    const text = (previewText || draftText).trim();
    set({ status: 'pasting' });

    if (!text) {
      console.log('[forge] empty transcript — nothing to deliver');
      api?.notifyForgeDictationComplete?.(null);
      set({
        status: 'idle',
        mode: null,
        actionInProgress: false,
        previewText: '',
        draftText: '',
        startedAt: null,
      });
      return;
    }

    // ALWAYS push to clipboard first so a paste failure isn't a data loss.
    let copyOk = false;
    try {
      await api.copyToClipboard(text);
      copyOk = true;
      set({ lastCopiedText: text });
    } catch (err) {
      console.warn('[forge] clipboard copy failed:', err);
    }

    let pasteOk = false;
    let pasteError: string | null = null;
    try {
      const result =
        pasteMode === 'type'
          ? await api.typeText(text)
          : await api.pasteText(text, clipboardRestore);
      if (result && result.ok === false) {
        pasteError = result.error || 'paste failed';
      } else {
        pasteOk = true;
      }
    } catch (err: any) {
      pasteError = err?.message || String(err);
    }

    const latencyMs = startedAt ? Date.now() - startedAt : null;
    console.log(
      `[forge] done — chars=${text.length} latency=${latencyMs}ms paste=${pasteOk} copy=${copyOk} err=${pasteError ?? 'none'}`,
    );

    const isMac = navigator.platform.toLowerCase().includes('mac');
    const shortcut = isMac ? '⌘V' : 'Ctrl+V';

    if (pasteOk) {
      get().showToast({ kind: 'success', text: '✓ Pasted', ttl: 1400 });
    } else if (copyOk) {
      get().showToast({
        kind: 'info',
        text: `Copied — press ${shortcut} to insert`,
        ttl: 4500,
      });
    } else {
      get().showToast({ kind: 'error', text: pasteError || 'Failed', ttl: 5000 });
    }

    api?.notifyForgeDictationComplete?.(pasteOk ? null : pasteError);
    set({
      status: 'idle',
      mode: null,
      actionInProgress: false,
      previewText: '',
      draftText: '',
      startedAt: null,
      lastError: pasteOk ? null : pasteError,
    });
  },
}));
