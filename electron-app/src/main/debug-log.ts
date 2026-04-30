/**
 * debug-log — pipe structured pipeline events to the renderer DevTools console.
 *
 * ALWAYS-ON. Every call to `debugLog(stage, data)` does two things:
 *   1. console.log in the main process (visible in `npm run dev` terminal)
 *   2. webContents.send so the preload listener can re-emit it as
 *      `[ironmic:debug] <stage>` in the renderer's DevTools console
 *
 * The events are low-frequency (≤ once per 2.5s chunk in dictation, once per
 * 10–60s chunk in meetings) so the noise cost is trivial and the diagnostic
 * value is high. The earlier version gated on a Settings toggle, but that
 * meant the very first failed-on-Windows test produced zero data and the user
 * had to make a second trip to flip the switch. Always-on removes that step.
 *
 * The `invalidateDebugLogCache` export is kept (no-op) so existing callers
 * don't break.
 */

import { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../shared/constants';

/** No-op kept for compatibility with existing call-sites. */
export function invalidateDebugLogCache(): void {
  /* always-on, nothing to invalidate */
}

/**
 * Emit a structured debug event.
 *
 * `stage` examples: `capture.start`, `capture.drained`, `silence-gate`,
 * `whisper.in`, `whisper.raw`, `whisper.error`, `sanitize`, `chunk.emit`,
 * `chunk.recv`. Keep them stable so external scripts can grep them.
 */
export function debugLog(stage: string, data: unknown): void {
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
