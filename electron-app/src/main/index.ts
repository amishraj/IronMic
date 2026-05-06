/**
 * Electron main process entry point.
 */

import { app, BrowserWindow, session, globalShortcut, nativeImage, dialog } from 'electron';
import path from 'path';
import { registerIpcHandlers } from './ipc-handlers';
import { debugLog } from './debug-log';
import { createTray, destroyTray, updateTrayState } from './tray';
import {
  isForgeMode,
  getForgeWindow,
} from './forge-window';
import { tryDispatchHotkey, getOwner, clearMainOwner, clearOwner } from './dictation-owner';
import {
  startKeyboardListener,
  stopKeyboardListener,
  type ForgeKeyEvent,
} from './keyboard-listener';
import {
  ensureBundledVoices,
  ensureBundledTFJSModels,
  ensureBundledMoonshineBase,
  ensureBundledLlm,
} from './model-downloader';
import { startMeetingAppDetection, applyAutoDetectDefaultMigration } from './meeting-app-detector';
import { meetingRecorder } from './meeting-recorder';
import { initShellEnv } from './utils/shell-env';

// Set the models directory env var BEFORE the Rust addon loads.
// In production, models go to the user's app-data directory (writable).
// In dev, they live in rust-core/models relative to the source tree.
if (process.env.NODE_ENV !== 'development') {
  process.env.IRONMIC_MODELS_DIR = path.join(app.getPath('userData'), 'models');
} else {
  process.env.IRONMIC_MODELS_DIR = path.join(__dirname, '..', '..', '..', 'rust-core', 'models');
}

import { native } from './native-bridge';

const ICON_PATH = path.join(__dirname, '..', '..', 'resources', 'icon.png');

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    title: 'IronMic',
    titleBarStyle: 'hiddenInset',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // In development, load from Vite dev server
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // In production, load the built renderer
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  // Intercept window close to warn about in-progress recording or note generation.
  // We must call event.preventDefault() synchronously and re-try the close from
  // inside the async dialog callback — that's Electron's required pattern.
  mainWindow.on('close', (event) => {
    const isRecording = meetingRecorder.isActive();
    const generatingCount: number =
      typeof (global as any).__ironmicActiveGeneratingCount === 'function'
        ? (global as any).__ironmicActiveGeneratingCount()
        : 0;

    if (!isRecording && generatingCount === 0) return; // nothing to warn about

    event.preventDefault(); // hold the close while the dialog is shown

    const lines: string[] = [];
    if (isRecording) lines.push('• A meeting is currently being recorded.');
    if (generatingCount > 0) lines.push(`• Meeting notes are still being generated (${generatingCount} in progress).`);

    dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      buttons: ['Quit anyway', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'IronMic — work in progress',
      message: 'Quitting now may lose data:',
      detail: lines.join('\n') + '\n\nQuit anyway?',
    }).then(({ response }) => {
      if (response === 0) {
        // User confirmed — force close (remove this listener so it doesn't loop)
        mainWindow?.removeAllListeners('close');
        mainWindow?.close();
      }
      // Otherwise: do nothing, window stays open
    }).catch(() => {
      // Dialog failed (unlikely) — close anyway
      mainWindow?.removeAllListeners('close');
      mainWindow?.close();
    });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** Domains allowed for model downloads (must match model-downloader.ts ALLOWED_DOMAINS) */
const MODEL_DOWNLOAD_DOMAINS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'huggingface.co', 'xethub.hf.co'];

function blockAllNetworkRequests(): void {
  // Privacy guarantee: block ALL outbound network requests except model downloads.
  // Model downloads are the ONLY network activity, triggered explicitly by the user.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    // Allow devtools and local file:// and localhost (dev server)
    if (
      url.startsWith('devtools://') ||
      url.startsWith('file://') ||
      url.startsWith('http://localhost') ||
      url.startsWith('ws://localhost') ||
      url.startsWith('data:') ||
      url.startsWith('chrome-extension://')
    ) {
      callback({});
      return;
    }
    // Allow HTTPS model downloads from trusted domains
    if (url.startsWith('https://')) {
      try {
        const hostname = new URL(url).hostname;
        if (MODEL_DOWNLOAD_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))) {
          callback({});
          return;
        }
      } catch { /* invalid URL — block it */ }
    }
    console.warn(`[security] Blocked network request: ${url}`);
    callback({ cancel: true });
  });
}

/**
 * Wispr-Flow-style hotkey routing.
 *
 * The native keyboard listener (uiohook) emits three high-level events:
 *   - 'push-to-talk-start'  → user is holding Fn (Mac) or Ctrl+Win (Win)
 *   - 'push-to-talk-end'    → user released the modifier(s)
 *   - 'hands-free-toggle'   → user tapped Fn+Space or Ctrl+Win+Space
 *
 * We forward each as an IPC channel to whichever window owns the active
 * mode. The owner serialization (`tryDispatchHotkey`) prevents the toggle
 * variant from triggering twice if the user double-taps mid-dictation.
 */
function dispatchForgeKeyEvent(ev: ForgeKeyEvent): void {
  const forge = isForgeMode();
  const target: 'forge' | 'main' = forge ? 'forge' : 'main';

  // Owner serialization is required for FORGE because Forge has explicit
  // PTT-start / PTT-end semantics that need to be paired. For MAIN, the
  // existing useRecordingStore already has its own actionInProgress guard;
  // adding owner tracking here would deadlock if main's complete-handshake
  // ever desyncs (and main doesn't fire `notifyForgeDictationComplete`, so
  // the owner would never clear). We dispatch directly to main and let
  // its renderer-side store handle re-entrancy.
  // PTT-cancel resets the owner immediately so the hands-free-toggle that
  // arrives right after starts cleanly instead of transitioning into a
  // 'processing' phase.
  if (ev.kind === 'push-to-talk-cancel') {
    clearOwner();
  }

  if (target === 'forge' && ev.kind === 'hands-free-toggle') {
    const decision = tryDispatchHotkey('forge');
    if (!decision.dispatch) {
      console.log(`[forge-keys] hands-free dropped (forge): ${decision.reason}`);
      return;
    }
    console.log(`[forge-keys] hands-free → forge (${decision.phase})`);
  } else if (target === 'main') {
    // Belt-and-braces: if owner state was somehow stuck pointing at main
    // (shouldn't happen, but harmless to clean), reset it so we never wedge.
    const owner = getOwner();
    if (owner?.owner === 'main') clearMainOwner();
    console.log(`[forge-keys] ${ev.kind} → main`);
  }

  const channel =
    ev.kind === 'push-to-talk-start'
      ? 'ironmic:forge-ptt-start'
      : ev.kind === 'push-to-talk-end'
        ? 'ironmic:forge-ptt-end'
        : ev.kind === 'push-to-talk-cancel'
          ? 'ironmic:forge-ptt-cancel'
          : 'ironmic:hotkey-pressed';

  if (target === 'forge') {
    const fw = getForgeWindow();
    if (fw && !fw.isDestroyed()) {
      fw.webContents.send(channel);
    } else if (ev.kind === 'hands-free-toggle' && mainWindow && !mainWindow.isDestroyed()) {
      // Forge mode flag was on but the bar is gone — graceful fallback.
      mainWindow.webContents.send(channel);
    }
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    // Main app receives only the hands-free toggle event today. PTT in main
    // is a future enhancement (would require main's recording store to
    // expose explicit start/end methods like Forge has).
    if (ev.kind === 'hands-free-toggle') {
      mainWindow.webContents.send(channel);
    }
  }
}

function registerGlobalHotkey(): void {
  const ok = startKeyboardListener(dispatchForgeKeyEvent);
  if (ok) {
    console.log(
      '[hotkey] native listener active — Mac: Fn (hold) / Fn+Space (toggle), Win: Ctrl+Win (hold) / Ctrl+Win+Space (toggle)',
    );
  } else {
    console.warn(
      '[hotkey] native listener fell back to globalShortcut — push-to-talk disabled, hands-free works via Cmd+Shift+Space (Mac) / Ctrl+Win+Space (Win)',
    );
  }
}

// ── Single-instance lock ─────────────────────────────────────────────────
// IronMic owns a system-wide hotkey, the Rust audio capture, and global
// model loaders — running two copies in parallel would race on the mic and
// double-load 100MB+ of models. If a second launch is attempted (e.g. user
// double-clicks the dock icon while Forge is active and the main window is
// hidden), we focus the existing instance and exit.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  await initShellEnv();
  blockAllNetworkRequests();
  registerIpcHandlers();
  createWindow();
  createTray(() => app.quit());
  registerGlobalHotkey();

  // Copy bundled TTS voices to user data on first launch
  try { ensureBundledVoices(); } catch (err) {
    console.warn('[startup] Failed to copy bundled voices:', err);
  }

  // Copy bundled Moonshine Base (default transcription engine) to user data
  // on first launch. Must run before the engine pre-load below so the Rust
  // loader finds the files where it expects them. Log the result on a single
  // line so debugging "did the bundle work?" doesn't require digging.
  try {
    const status = ensureBundledMoonshineBase();
    switch (status) {
      case 'copied':
        console.log('[startup] Moonshine Base: bundled copy restored from app resources');
        break;
      case 'already-present':
        console.log('[startup] Moonshine Base: already present in user data');
        break;
      case 'incomplete-bundle':
        console.warn('[startup] Moonshine Base: bundled directory is incomplete — user must download');
        break;
      case 'bundle-missing':
        console.log('[startup] Moonshine Base: no bundled copy (dev mode or unpackaged) — user must download');
        break;
    }
  } catch (err) {
    console.warn('[startup] Failed to copy bundled Moonshine Base:', err);
  }

  // Copy bundled Phi-3 Mini Q2_K (default LLM for polish + AI Assist) to user data.
  try {
    const llmStatus = ensureBundledLlm();
    switch (llmStatus) {
      case 'copied':
        console.log('[startup] Phi-3 Mini Q2_K: bundled copy restored from app resources');
        break;
      case 'already-present':
        console.log('[startup] Phi-3 Mini Q2_K: already present in user data');
        break;
      case 'source-missing':
        console.warn('[startup] Phi-3 Mini Q2_K: no bundled copy (dev mode or unpackaged) — user must download');
        break;
    }
    // Seed ai_local_model to phi3 on first launch if the user has not yet chosen a model.
    // This makes resolveActiveChatModel() pick Phi-3 first without changing the fallback array.
    if (llmStatus !== 'source-missing') {
      const existing = native.getSetting('ai_local_model');
      if (!existing) {
        native.setSetting('ai_local_model', 'llm-chat-phi3');
        console.log('[startup] ai_local_model seeded to llm-chat-phi3');
      }
    }
  } catch (err) {
    console.warn('[startup] Failed to copy bundled Phi-3 Mini Q2_K:', err);
  }

  // Extract bundled TF.js ML models to user data on first launch
  try { ensureBundledTFJSModels(); } catch (err) {
    console.warn('[startup] Failed to extract bundled TF.js models:', err);
  }

  // Run auto-cleanup on startup
  try {
    const deleted = native.addon.runAutoCleanup();
    if (deleted > 0) {
      console.log(`[auto-cleanup] Removed ${deleted} old entries`);
    }
  } catch (err) {
    console.warn('[auto-cleanup] Failed:', err);
  }

  // Apply the one-time migration that flips the seeded auto-detect default
  // from 'false' to 'true' for users who never explicitly set it. Must run
  // BEFORE startMeetingAppDetection reads the setting.
  try { applyAutoDetectDefaultMigration(); } catch (err) {
    console.warn('[meeting-app-detector] Migration failed (non-fatal):', err);
  }

  // Start meeting app auto-detection (default: enabled; user can disable in Settings)
  try { startMeetingAppDetection(); } catch (err) {
    console.warn('[meeting-app-detector] Failed to start:', err);
  }

  // Whisper readiness check.  The first transcription call lazily loads the
  // model, which on Windows can take 10s+ for large-v3-turbo and surfaces any
  // path/feature errors only at that point — long after the user pressed the
  // hotkey.  Pre-loading at startup turns that into an immediate, visible
  // failure with a clear path forward.
  try {
    const features = native.nativeFeatures();
    const status = native.getModelStatus();
    console.log('[whisper] Native feature flags:', features);
    console.log('[whisper] Model status at startup:', status);

    if (!features.whisper) {
      const msg = features.stub
        ? 'IronMic could not load its native module. Reinstall the app from the GitHub release.'
        : 'This build was compiled without Whisper support. Rebuild with --features whisper or reinstall from the GitHub release.';
      console.error('[whisper]', msg);
      sendWhisperFailure(msg, /* permanent */ true);
    } else {
      // Load eagerly off the critical path — don't block the UI.
      void (async () => {
        try {
          // ── Force Moonshine Base as the active engine on every launch ──
          // Policy: Moonshine Base is the always-on default. It ships bundled
          // with the installer (electron-builder.config.js extraResources +
          // ensureBundledMoonshineBase above), so it is always available.
          // The persisted `transcription_engine` setting is overwritten on
          // every launch, which means a user's in-session Switch to Whisper
          // (or any other engine) lasts only for that session — the next
          // launch returns to Moonshine Base. This is intentional and matches
          // the product policy that Moonshine is the primary engine.
          try {
            native.setTranscriptionEngine('moonshine-base');
            native.setSetting('transcription_engine', 'moonshine-base');
            console.log('[engine] Active transcription engine: moonshine-base (forced default)');
            debugLog('engine.startup', { kind: 'moonshine-base', source: 'forced-default' });
          } catch (engineErr) {
            console.warn('[engine] Force-default to moonshine-base failed:', engineErr);
            debugLog('engine.startup', {
              kind: 'moonshine-base',
              source: 'forced-default',
              error: String(engineErr),
            });
          }

          // Apply user-configured thread count before the model loads.
          // Only meaningful for Whisper engines; Moonshine uses ORT's intra-op
          // pool which is governed separately. Harmless to call regardless.
          const threadsSetting = native.getSetting('whisper_threads');
          if (threadsSetting) {
            const n = parseInt(threadsSetting, 10);
            if (!isNaN(n) && n >= 1 && n <= 16) {
              native.setWhisperNThreads(n);
              console.log(`[whisper] Thread count set to ${n} from settings`);
            }
          }
          // loadWhisperModel now loads the *active* engine's model (despite
          // the legacy name kept for backwards compatibility).
          native.loadWhisperModel();
          console.log('[engine] Active engine model pre-loaded successfully');

          // Push the persisted custom dictionary into the just-loaded engine.
          // The Rust addon already syncs on every addWord/removeWord, but the
          // engine is freshly constructed at boot — this seeds it from SQLite
          // so the user's vocabulary biases the very first dictation. Cheap
          // (single SELECT + HashSet rebuild). Skip silently on older addon
          // binaries that lack the export.
          try {
            const wordCount = native.refreshTranscriptionDictionary();
            console.log(`[dictionary] Loaded ${wordCount} custom words into active engine`);
          } catch (dictErr) {
            console.warn('[dictionary] refreshTranscriptionDictionary at boot failed:', dictErr);
          }
          // Log CPU feature flags to DevTools so AVX/AVX512 issues are
          // visible without checking the terminal. E.g.:
          //   [ironmic:debug] whisper.sysinfo {system_info: "AVX = 1 | AVX512 = 0 | ..."}
          // (Whisper-specific; Moonshine doesn't expose equivalent metadata.)
          try {
            const sysinfo = native.getWhisperSystemInfo();
            debugLog('whisper.sysinfo', { system_info: sysinfo });
          } catch (siErr) {
            console.warn('[whisper] getWhisperSystemInfo failed:', siErr);
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error('[engine] Pre-load failed:', message);
          sendWhisperFailure(message, false);
        }
      })();
    }
  } catch (err) {
    console.warn('[whisper] Readiness probe failed (non-fatal):', err);
  }
});

function sendWhisperFailure(message: string, permanent: boolean): void {
  const payload = { message, permanent };
  // Renderer may not be ready yet — retry once after a short delay.
  const send = () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('ironmic:whisper-load-failed', payload);
      }
    }
  };
  send();
  setTimeout(send, 3000);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('will-quit', () => {
  stopKeyboardListener();
  globalShortcut.unregisterAll();
  destroyTray();

  // Security: clear session data on exit if enabled
  try {
    const clearOnExit = native.getSetting('security_clear_on_exit');
    if (clearOnExit === 'true' && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(`
        localStorage.removeItem('ironmic-ai-sessions');
        localStorage.removeItem('ironmic-notes');
        localStorage.removeItem('ironmic-notebooks');
      `).catch(() => {});
    }
  } catch { /* ignore if addon not ready */ }
});
