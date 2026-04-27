/**
 * Electron main process entry point.
 */

import { app, BrowserWindow, session, globalShortcut, nativeImage, dialog } from 'electron';
import path from 'path';
import { registerIpcHandlers } from './ipc-handlers';
import { createTray, destroyTray, updateTrayState } from './tray';
import { ensureBundledVoices, ensureBundledTFJSModels } from './model-downloader';
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

function registerGlobalHotkey(): void {
  const hotkey = native.getSetting('hotkey_record') || 'CommandOrControl+Shift+V';

  try {
    globalShortcut.register(hotkey, () => {
      console.log('[hotkey] Global hotkey pressed');
      if (mainWindow) {
        mainWindow.webContents.send('ironmic:hotkey-pressed');
      }
    });
    console.log(`[hotkey] Registered global hotkey: ${hotkey}`);
  } catch (err) {
    console.error(`[hotkey] Failed to register hotkey ${hotkey}:`, err);
  }
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
          native.loadWhisperModel();
          console.log('[whisper] Model pre-loaded successfully');
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error('[whisper] Pre-load failed:', message);
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
