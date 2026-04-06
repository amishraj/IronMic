/**
 * Electron main process entry point.
 */

import { app, BrowserWindow, session, globalShortcut, nativeImage } from 'electron';
import path from 'path';
import { registerIpcHandlers } from './ipc-handlers';
import { createTray, destroyTray, updateTrayState } from './tray';
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function blockAllNetworkRequests(): void {
  // Privacy guarantee: block ALL outbound network requests
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

app.whenReady().then(() => {
  blockAllNetworkRequests();
  registerIpcHandlers();
  createWindow();
  createTray(() => app.quit());
  registerGlobalHotkey();

  // Run auto-cleanup on startup
  try {
    const deleted = native.addon.runAutoCleanup();
    if (deleted > 0) {
      console.log(`[auto-cleanup] Removed ${deleted} old entries`);
    }
  } catch (err) {
    console.warn('[auto-cleanup] Failed:', err);
  }
});

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
