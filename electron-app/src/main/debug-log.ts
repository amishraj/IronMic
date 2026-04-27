/**
 * debug-log — pipe structured pipeline events to the renderer DevTools console.
 *
 * Gated on the `debug_audio_logging` setting (default off). When the setting is
 * on, every call to `debugLog(stage, data)` does two things:
 *   1. console.log in the main process (visible in `npm run dev` terminal)
 *   2. webContents.send so the preload listener can re-emit it as
 *      `[ironmic:debug] <stage>` in the renderer's DevTools console
 *
 * Designed so the user can flip one Settings toggle, reproduce a dictation
 * failure, and copy the console output for diagnosis. Without this, every step
 * in the chain (capture drain → silence gate → whisper → sanitizer → emit →
 * recv) is silent on success AND on drop, leaving us no way to bisect a bug.
 */

import { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../shared/constants';
import { native } from './native-bridge';

let cachedEnabled: boolean | null = null;

/** Re-read the setting next time `isEnabled()` is called. */
export function invalidateDebugLogCache(): void {
  cachedEnabled = null;
}

function isEnabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled;
  try {
    const v = native.getSetting?.('debug_audio_logging');
    cachedEnabled = v === 'true' || v === '1';
  } catch {
    cachedEnabled = false;
  }
  return cachedEnabled;
}

/**
 * Emit a structured debug event. Cheap when disabled — just a setting read.
 *
 * `stage` examples: `capture.start`, `capture.drained`, `silence-gate`,
 * `whisper.in`, `whisper.raw`, `whisper.error`, `sanitize`, `chunk.emit`,
 * `chunk.recv`. Keep them stable so external scripts can grep them.
 */
export function debugLog(stage: string, data: unknown): void {
  if (!isEnabled()) return;
  // eslint-disable-next-line no-console
  console.log(`[ironmic:debug] ${stage}`, data);
  const w = BrowserWindow.getAllWindows()[0];
  if (w && !w.isDestroyed()) {
    w.webContents.send(IPC_CHANNELS.DEBUG_LOG, {
      stage,
      data,
      t: Date.now(),
    });
  }
}
