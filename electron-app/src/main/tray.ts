/**
 * System tray icon with status indicator.
 */

import { Tray, Menu, nativeImage, app } from 'electron';
import path from 'path';
import type { PipelineState } from '../renderer/types';

let tray: Tray | null = null;

export function createTray(onQuit: () => void): Tray {
  const iconPath = path.join(__dirname, '..', '..', 'resources', 'tray-icon.png');
  let icon: Electron.NativeImage;

  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error('Empty icon');
    // Resize for macOS tray (should be ~22x22 or 44x44 @2x)
    icon = icon.resize({ width: 22, height: 22 });
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('IronMic — Idle');

  updateTrayMenu('idle', onQuit);

  return tray;
}

export function updateTrayState(state: PipelineState): void {
  if (!tray) return;

  const tooltips: Record<PipelineState, string> = {
    idle: 'IronMic — Idle',
    recording: 'IronMic — Recording...',
    processing: 'IronMic — Processing...',
  };

  tray.setToolTip(tooltips[state] || 'IronMic');
}

function updateTrayMenu(state: PipelineState, onQuit: () => void): void {
  if (!tray) return;

  const menu = Menu.buildFromTemplate([
    { label: `IronMic — ${state.charAt(0).toUpperCase() + state.slice(1)}`, enabled: false },
    { type: 'separator' },
    { label: 'Quit', click: onQuit },
  ]);

  tray.setContextMenu(menu);
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
