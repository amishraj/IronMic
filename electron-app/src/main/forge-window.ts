/**
 * Forge mode — minimal floating bar window.
 *
 * The bar sits always-on-top, never accepts focus (so the target app keeps
 * the keyboard caret), and lets the user dictate text directly into whatever
 * app currently owns input. The IronMic engine in the Rust core stays alive
 * across both windows, so Forge is a thin client of the same audio /
 * transcription / paste pipeline the main window uses — no duplicate
 * recordings, no duplicate models loaded.
 *
 * Exports:
 *   - createForgeWindow / destroyForgeWindow / getForgeWindow — lifecycle
 *   - enterForgeMode / exitForgeMode — toggle mode (hides/shows the main
 *     window), updates `forgeMode` flag, and broadcasts the new mode.
 *   - isForgeMode — main process source of truth for hotkey routing.
 */

import {
  app,
  BrowserWindow,
  nativeTheme,
  screen,
  shell,
  type BrowserWindowConstructorOptions,
} from 'electron';
import path from 'path';

let forgeWindow: BrowserWindow | null = null;
let forgeMode = false;

// Window dimensions. The renderer adds a 6 px shadow-margin around the bar
// shell (#root padding) so the CSS box-shadow doesn't get clipped — bump
// each dim by 12 px versus the bar's actual visual size.
const BAR_WIDTH = 432;             // bar visual width = 420
const BAR_HEIGHT_COMPACT = 76;     // bar visual height = 64
const BAR_HEIGHT_EXPANDED = 182;   // bar visual height = 170
const BAR_HEIGHT_PERM = 162;       // bar visual height = 150
const BAR_MARGIN = 24;
// Public so other modules can compute layout if needed later.
const BAR_HEIGHT = BAR_HEIGHT_COMPACT;

export function isForgeMode(): boolean {
  return forgeMode;
}

/**
 * Read the user's `theme` setting (light/dark/system) and resolve it to an
 * applied 'light' or 'dark' using Electron's `nativeTheme` as the OS
 * preference oracle. Centralizing this here means Forge always gets a
 * concrete value — no system-resolution happens in the renderer where it
 * can flake on transparent BrowserWindows.
 */
export function resolveAppliedTheme(): 'light' | 'dark' {
  let setting: string | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { native } = require('./native-bridge');
    setting = native?.getSetting?.('theme') ?? null;
  } catch {
    /* fall through to system */
  }
  if (setting === 'dark') return 'dark';
  if (setting === 'light') return 'light';
  // 'system' or unset → trust Electron's report of the OS preference.
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

export function getForgeWindow(): BrowserWindow | null {
  return forgeWindow && !forgeWindow.isDestroyed() ? forgeWindow : null;
}

/**
 * Compute initial bar position. Defaults to top-right of the display the
 * user is currently looking at (cursor position). Multi-monitor friendly.
 */
function computeInitialPosition(): { x: number; y: number } {
  try {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const wa = display.workArea;
    return {
      x: wa.x + wa.width - BAR_WIDTH - BAR_MARGIN,
      y: wa.y + BAR_MARGIN,
    };
  } catch {
    return { x: 60, y: 60 };
  }
}

function createForgeWindow(): BrowserWindow {
  const existing = getForgeWindow();
  if (existing) {
    existing.show();
    return existing;
  }

  const { x, y } = computeInitialPosition();

  // Window options chosen so the bar:
  //   - Floats above all other apps (incl. fullscreen) — `panel` + `screen-saver`.
  //   - Never steals focus from the user's target app — `focusable: false`.
  //     This is the linchpin of "type anywhere" — paste lands in whatever
  //     window had focus before the bar appeared.
  //   - Doesn't show in the dock/taskbar — `skipTaskbar: true`.
  //   - Doesn't throttle when unfocused (it never gets focus) — `backgroundThrottling: false`.
  const opts: BrowserWindowConstructorOptions = {
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    // hasShadow: false — we draw a CSS box-shadow on the rounded bar shell.
    // Letting Electron draw a native shadow produces a *rectangular* shadow
    // that visibly extends past the bar's 14 px corners (the screenshot
    // bug). Same reason we skip `vibrancy` on macOS: vibrancy fills the
    // entire window frame with a translucent tint so the bar's rounded
    // mask gets a square halo behind it.
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    acceptFirstMouse: true,
    show: false,
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  };

  if (process.platform === 'darwin') {
    // `panel` keeps the window above fullscreen apps without taking focus.
    // We deliberately do NOT set `vibrancy` — see hasShadow note above.
    opts.type = 'panel';
  }
  // On Windows we also avoid `backgroundMaterial: 'acrylic'` for the same
  // reason — it fills the rectangular window with frosted glass behind our
  // rounded bar. CSS background + box-shadow handle the look uniformly.

  forgeWindow = new BrowserWindow(opts);
  forgeWindow.setAlwaysOnTop(true, 'screen-saver');
  try {
    forgeWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {
    // not supported on all platforms; non-fatal
  }

  // Resolve the theme to a definitive 'dark' or 'light' in the MAIN process,
  // using Electron's `nativeTheme` as the source of truth. Forge gets the
  // already-resolved value via URL query and applies it directly — no
  // matchMedia in the renderer, no race with localStorage, no dependence
  // on whether the child BrowserWindow correctly inherits the OS preference
  // (which is unreliable on transparent windows with no backing material).
  const resolvedTheme = resolveAppliedTheme();

  if (process.env.NODE_ENV === 'development') {
    forgeWindow.loadURL(`http://localhost:5173/forge.html?theme=${resolvedTheme}`);
    if (process.env.IRONMIC_FORGE_DEVTOOLS !== '0') {
      forgeWindow.webContents.once('did-finish-load', () => {
        forgeWindow?.webContents.openDevTools({ mode: 'detach' });
      });
    }
  } else {
    forgeWindow.loadFile(
      path.join(__dirname, '..', 'renderer', 'forge.html'),
      { query: { theme: resolvedTheme } },
    );
  }

  forgeWindow.once('ready-to-show', () => {
    forgeWindow?.showInactive();
  });

  // After the bar mounts, push the current resolved theme via IPC. The
  // inline script already applied it on first paint, but this guarantees
  // the React-side `dark` class state in ForgeApp is in lockstep with the
  // dom — avoids any drift if the user toggles dark mode between when
  // forge-window read the setting and when ForgeApp mounted.
  forgeWindow.webContents.once('did-finish-load', () => {
    if (forgeWindow && !forgeWindow.isDestroyed()) {
      forgeWindow.webContents.send('ironmic:theme-changed', resolvedTheme);
    }
  });

  forgeWindow.on('closed', () => {
    forgeWindow = null;
  });

  return forgeWindow;
}

export function destroyForgeWindow(): void {
  if (forgeWindow && !forgeWindow.isDestroyed()) {
    try {
      forgeWindow.close();
    } catch {
      // ignore
    }
  }
  forgeWindow = null;
}

/**
 * Stop any in-flight streaming dictation and reset the recording state.
 * Called on enter/exit Forge so we never leak a recording session across
 * mode switches (which would freeze the audio capture engine and reject
 * the next dictation with "already active").
 *
 * Lazy require avoids a circular dep with `dictation-streamer` (which in
 * turn pulls in many other modules at load time).
 */
async function stopAnyActiveDictation(): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { dictationStreamer } = require('./dictation-streamer');
    await dictationStreamer.stop().catch(() => {});
  } catch (err) {
    // streamer not loaded yet — nothing to stop
    void err;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { native } = require('./native-bridge');
    if (typeof native?.addon?.resetPipelineState === 'function') {
      native.addon.resetPipelineState();
    }
    if (typeof native?.isRecording === 'function' && native.isRecording()) {
      native.resetRecording?.();
    }
  } catch (err) {
    void err;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { clearOwner } = require('./dictation-owner');
    clearOwner?.();
  } catch (err) {
    void err;
  }
}

/**
 * Enter Forge mode. Hides the main window (per UX agreement: "I only see
 * that small minimal UI"), shows the bar, flips the mode flag so the global
 * hotkey routes to Forge.
 *
 * Also cancels any in-flight main-app dictation so the streamer is idle
 * before Forge takes over.
 */
export function enterForgeMode(mainWindow: BrowserWindow | null): void {
  void stopAnyActiveDictation();
  forgeMode = true;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    try {
      mainWindow.hide();
    } catch {
      // ignore
    }
  }
  createForgeWindow();
  refreshTrayIfPresent();
}

/**
 * Exit Forge mode. Tears down the bar (saves ~50 MB RSS) and restores the
 * main window. Hotkey routing returns to main.
 *
 * Cancels any in-flight Forge dictation so the streamer is idle before
 * main takes over and the next gesture starts cleanly.
 */
export function exitForgeMode(mainWindow: BrowserWindow | null): void {
  void stopAnyActiveDictation();
  forgeMode = false;
  destroyForgeWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    } catch {
      // ignore
    }
  }
  refreshTrayIfPresent();
}

// Lazy require to avoid a circular import (tray imports forge-window for the
// "Switch to Forge" menu item; we want to call back into tray here).
function refreshTrayIfPresent(): void {
  try {
    const { refreshTrayMenu } = require('./tray');
    refreshTrayMenu?.();
  } catch {
    // tray not loaded yet (very early startup); harmless
  }
}

/** macOS deep-link to Accessibility settings. No-op on other platforms. */
export async function openAccessibilityPrefs(): Promise<void> {
  if (process.platform === 'darwin') {
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    );
  }
}

/**
 * Resize the Forge window. Three modes:
 *   - 'compact'    — idle bar, just the status pill (64 px tall)
 *   - 'expanded'   — recording, with live preview area (150 px tall)
 *   - 'permission' — macOS AX prompt panel (150 px tall)
 *
 * The window animates between sizes so the user sees the bar grow naturally
 * as it starts listening.
 */
export function setForgeWindowMode(mode: 'compact' | 'expanded' | 'permission'): void {
  const fw = getForgeWindow();
  if (!fw) return;
  const targetHeight =
    mode === 'permission'
      ? BAR_HEIGHT_PERM
      : mode === 'expanded'
        ? BAR_HEIGHT_EXPANDED
        : BAR_HEIGHT_COMPACT;
  try {
    const bounds = fw.getBounds();
    if (bounds.height === targetHeight) return;
    // Use setBounds rather than setSize: on Windows, setSize() is silently
    // ignored for windows created with resizable:false (the OS style bits
    // don't include WS_SIZEBOX so SetWindowPos rejects the resize). setBounds
    // goes through a different path that works regardless of resizable state.
    // animate is macOS-only; on Windows/Linux the parameter is ignored so we
    // pass it explicitly only on darwin to keep intent clear.
    fw.setBounds(
      { x: bounds.x, y: bounds.y, width: bounds.width, height: targetHeight },
      process.platform === 'darwin',
    );
  } catch {
    // ignore — window may be torn down mid-call
  }
}

// Quitting cleans up the bar so `app` exits cleanly.
app.on('before-quit', () => {
  destroyForgeWindow();
});
