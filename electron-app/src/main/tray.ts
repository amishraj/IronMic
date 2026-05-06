/**
 * System tray icon with status indicator + quick-start menu items.
 *
 * The menu exposes two shortcuts the user requested:
 *   - Quick Start Dictation → focus window, navigate to Dictate, start recording.
 *   - Quick Start Meeting    → focus window, navigate to Meetings, start meeting.
 *
 * Both dispatch an `ironmic:quick-action` IPC event to the renderer so the
 * renderer can open the right page and kick off the action. We focus + show
 * the window here in main so the user always sees what's happening.
 */

import { Tray, Menu, nativeImage, app, BrowserWindow } from 'electron';
import path from 'path';
import type { PipelineState } from '../renderer/types';
import { isForgeMode, enterForgeMode, exitForgeMode } from './forge-window';

let tray: Tray | null = null;
let quitHandler: (() => void) | null = null;
let currentState: PipelineState = 'idle';

export type QuickAction = 'start-dictation' | 'start-meeting';

/** Re-render the tray menu. Exported so forge-window.ts can refresh the
 *  "Switch to / Exit" toggle when the user enters or exits Forge mode via
 *  routes other than the tray (sidebar button, bar ✕). */
export function refreshTrayMenu(): void {
  rebuildMenu();
}

function focusMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  const w = windows[0];
  if (!w || w.isDestroyed()) return null;
  if (w.isMinimized()) w.restore();
  if (!w.isVisible()) w.show();
  w.focus();
  return w;
}

/** Emit a quick-action request to the renderer. */
function sendQuickAction(action: QuickAction): void {
  const w = focusMainWindow();
  if (!w) return;
  w.webContents.send('ironmic:quick-action', action);
}

export function createTray(onQuit: () => void): Tray {
  const iconPath = path.join(__dirname, '..', '..', 'resources', 'tray-icon.png');
  let icon: Electron.NativeImage;

  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error('Empty icon');
    icon = icon.resize({ width: 22, height: 22 });
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  quitHandler = onQuit;
  tray.setToolTip('IronMic — Idle');

  // Clicking the icon itself reveals the window (macOS and Windows convention).
  tray.on('click', () => { focusMainWindow(); });
  rebuildMenu();

  return tray;
}

export function updateTrayState(state: PipelineState): void {
  if (!tray) return;
  currentState = state;

  const tooltips: Record<PipelineState, string> = {
    idle: 'IronMic — Idle',
    recording: 'IronMic — Recording...',
    processing: 'IronMic — Processing...',
  };
  tray.setToolTip(tooltips[state] || 'IronMic');
  rebuildMenu();
}

/**
 * Build the tray menu. Called on creation and whenever state changes so the
 * header label reflects the current pipeline state.
 */
function rebuildMenu(): void {
  if (!tray) return;
  const stateLabel = currentState.charAt(0).toUpperCase() + currentState.slice(1);
  const inForge = isForgeMode();

  const menu = Menu.buildFromTemplate([
    { label: `IronMic — ${stateLabel}${inForge ? ' (Forge)' : ''}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Quick Start Dictation',
      accelerator: 'CommandOrControl+Shift+V',
      click: () => sendQuickAction('start-dictation'),
      enabled: !inForge,
    },
    {
      label: 'Quick Start Meeting',
      accelerator: 'CommandOrControl+Shift+M',
      click: () => sendQuickAction('start-meeting'),
      enabled: !inForge,
    },
    { type: 'separator' },
    inForge
      ? {
          label: 'Exit Forge mode',
          click: () => {
            const main = BrowserWindow.getAllWindows().find(
              (w) => !w.isDestroyed() && w.getTitle() === 'IronMic',
            );
            exitForgeMode(main || null);
            rebuildMenu();
          },
        }
      : {
          label: 'Switch to Forge mode',
          click: () => {
            const main = BrowserWindow.getAllWindows().find(
              (w) => !w.isDestroyed() && w.getTitle() === 'IronMic',
            );
            enterForgeMode(main || null);
            rebuildMenu();
          },
        },
    { type: 'separator' },
    { label: 'Open IronMic', click: () => { focusMainWindow(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => quitHandler?.() },
  ]);
  tray.setContextMenu(menu);
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
