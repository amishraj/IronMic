/**
 * Native low-level keyboard listener — replaces Electron's `globalShortcut`
 * for the Forge dictation hotkeys.
 *
 * Why we can't use globalShortcut for this:
 *   - macOS Fn key is NOT in Chromium's accelerator parser. Cannot register.
 *   - Modifier-only push-to-talk (e.g. "Ctrl+Win" held) requires distinguishing
 *     key-down from key-up events. globalShortcut only fires on press.
 *
 * Why we don't use the actual Fn key on macOS:
 *   - `uiohook-napi` (and underlying libuiohook) does NOT expose a Fn keycode.
 *     macOS routes Fn through the system below the HID event tap, so userspace
 *     hooks can't see Fn key-down/up events. Wispr Flow uses Fn via a path
 *     that requires Apple-blessed entitlements not available to off-the-shelf
 *     Electron apps.
 *   - Closest equivalent: Right Option (⌥). Lives next to Fn on the keyboard,
 *     reliably detected by uiohook, single-handed, and doesn't conflict with
 *     anything common. Same UX as Wispr's Fn — hold to talk, release to paste.
 *
 * What this module does:
 *   - Loads `uiohook-napi`, which installs a CGEventTap (mac) /
 *     SetWindowsHookEx (win) and emits `keydown`/`keyup` system-wide.
 *   - Detects two gestures:
 *       1. PUSH-TO-TALK (Wispr-Flow style, hold-to-talk)
 *          • Mac:  Right Option held  → start dictation; release → stop+paste
 *          • Win:  Ctrl + Win held    → same
 *       2. HANDS-FREE TOGGLE (chord)
 *          • Mac:  Right Option + Space  → toggle dictation (start/stop on tap)
 *          • Win:  Ctrl + Win + Space    → same
 *   - Push-to-talk is started AFTER an 80 ms grace window so we can detect
 *     a pending chord. Within the grace window, if Space arrives, we treat
 *     it as a chord (cancel push-to-talk, fire the chord event). After the
 *     grace expires, we commit to push-to-talk on the held modifier(s).
 *   - Both gestures route through Electron's existing dispatch — main owns
 *     `dictationOwner` and decides which window receives the event.
 *
 * Permissions:
 *   - macOS: same Accessibility trust we already require for paste injection.
 *     uiohook's CGEventTap fails open if AX is missing — we surface an error
 *     to the bar via the existing AX prompt.
 *   - Windows: no special permission needed (low-level keyboard hook).
 *
 * Graceful degrade:
 *   - If uiohook fails to load (prebuild missing for this Electron ABI), we
 *     fall back to Electron's `globalShortcut` with a best-effort hotkey.
 */

import { BrowserWindow, globalShortcut } from 'electron';

let uIOhook: any = null;
let UiohookKey: any = null;
let uiohookLoadError: string | null = null;

try {
  // uiohook-napi exposes a singleton emitter and a key-code map.
  // Loading is wrapped because the prebuild may be missing for the current
  // Electron ABI; in that case we fall back to globalShortcut.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('uiohook-napi');
  uIOhook = mod.uIOhook;
  UiohookKey = mod.UiohookKey;
} catch (err: any) {
  uiohookLoadError = err?.message || String(err);
  console.warn('[forge-keys] uiohook-napi unavailable:', uiohookLoadError);
}

export type ForgeKeyEvent =
  | { kind: 'push-to-talk-start' }
  | { kind: 'push-to-talk-end' }
  | { kind: 'push-to-talk-cancel' }   // PTT was armed but user pressed chord
  | { kind: 'hands-free-toggle' };

type Dispatcher = (ev: ForgeKeyEvent) => void;

let dispatcher: Dispatcher | null = null;
let started = false;

// ── State for push-to-talk + chord detection ───────────────────────────────
const isMac = process.platform === 'darwin';

// Grace window between modifier-press and committing to push-to-talk.
// If Space arrives during this window we fire a chord event instead.
const CHORD_GRACE_MS = 80;

interface ModifierState {
  // mac — accept EITHER Option key. Right vs Left distinction is unreliable
  // on non-US keyboard layouts (some report both as the same keycode), and
  // forcing the user to press a specific physical key was the #1 source of
  // "the chord doesn't work" reports. The 80 ms grace window protects
  // against accidental triggers from quick Option-tap character composition.
  leftOpt: boolean;
  rightOpt: boolean;
  // win
  leftCtrl: boolean;
  rightCtrl: boolean;
  leftMeta: boolean;
  rightMeta: boolean;
}

const modifiers: ModifierState = {
  leftOpt: false,
  rightOpt: false,
  leftCtrl: false,
  rightCtrl: false,
  leftMeta: false,
  rightMeta: false,
};

let pushToTalkActive = false;
let chordGraceUntil = 0;
let pendingPushToTalkTimer: NodeJS.Timeout | null = null;
let lastTriggerAt = 0; // monotonic guard against repeat-fire bursts

/** Are the modifier keys for push-to-talk currently held? */
function isPushToTalkHeld(): boolean {
  if (isMac) return modifiers.leftOpt || modifiers.rightOpt;
  const ctrl = modifiers.leftCtrl || modifiers.rightCtrl;
  const meta = modifiers.leftMeta || modifiers.rightMeta;
  return ctrl && meta;
}

function clearPendingTimer(): void {
  if (pendingPushToTalkTimer) {
    clearTimeout(pendingPushToTalkTimer);
    pendingPushToTalkTimer = null;
  }
}

function fireChord(): void {
  // Guard against rapid repeats from key auto-repeat.
  const now = Date.now();
  if (now - lastTriggerAt < 250) return;
  lastTriggerAt = now;

  clearPendingTimer();
  // If PTT was already armed (slow tap — user took >80 ms between Option
  // and Space), abort it. The user clarified intent by pressing Space, so
  // we want hands-free even though we'd already started PTT-mode dictation.
  // The cancel signal lets the renderer roll back any in-flight session
  // without pasting.
  if (pushToTalkActive) {
    pushToTalkActive = false;
    console.log('[forge-keys] aborting PTT to convert to chord');
    dispatcher?.({ kind: 'push-to-talk-cancel' });
  }
  console.log('[forge-keys] chord → hands-free-toggle');
  dispatcher?.({ kind: 'hands-free-toggle' });
}

function maybeStartPushToTalk(): void {
  if (pushToTalkActive) return;
  if (!isPushToTalkHeld()) return;
  pushToTalkActive = true;
  console.log('[forge-keys] push-to-talk start');
  dispatcher?.({ kind: 'push-to-talk-start' });
}

function endPushToTalk(): void {
  clearPendingTimer();
  if (!pushToTalkActive) return;
  pushToTalkActive = false;
  console.log('[forge-keys] push-to-talk end');
  dispatcher?.({ kind: 'push-to-talk-end' });
}

// ── uiohook event handling ────────────────────────────────────────────────

/**
 * Sync our internal modifier state with the OS truth reported in the event
 * mask. uiohook on macOS occasionally misses key-up events when focus shifts
 * during a chord (very common scenario for our paste-anywhere flow!), which
 * left modifier flags stuck `true` and caused Space-alone to fire the chord.
 *
 * Calling this on every event guarantees we self-correct: if the event mask
 * says Alt isn't held, our tracked Option state is forcibly cleared
 * regardless of what we previously thought.
 */
function syncModifiersFromMask(ev: any): void {
  // Note: uiohook's altKey/ctrlKey/metaKey is platform-mapped — on macOS
  // metaKey = Cmd, altKey = Option. We only care about altKey on mac.
  if (isMac) {
    if (!ev.altKey) {
      if (modifiers.leftOpt || modifiers.rightOpt) {
        if (pushToTalkActive) {
          // We thought PTT was active but the OS says Option isn't held —
          // treat as a missed key-up.
          console.log('[forge-keys] mask sync: clearing stale Option state');
          endPushToTalk();
        }
        modifiers.leftOpt = false;
        modifiers.rightOpt = false;
      }
    }
  } else {
    if (!ev.ctrlKey) { modifiers.leftCtrl = false; modifiers.rightCtrl = false; }
    if (!ev.metaKey) { modifiers.leftMeta = false; modifiers.rightMeta = false; }
    if (!ev.ctrlKey || !ev.metaKey) {
      if (pushToTalkActive) endPushToTalk();
    }
  }
}

function onKeyDown(ev: any): void {
  syncModifiersFromMask(ev);
  const code = ev.keycode;
  if (!UiohookKey) return;

  if (isMac) {
    // Either Option key counts as the PTT modifier. Distinguishing left
    // vs right is unreliable across keyboard layouts.
    if (code === UiohookKey.Alt || code === UiohookKey.AltRight) {
      const isRight = code === UiohookKey.AltRight;
      if (isRight ? modifiers.rightOpt : modifiers.leftOpt) return; // auto-repeat
      if (isRight) modifiers.rightOpt = true; else modifiers.leftOpt = true;
      console.log(`[forge-keys] ${isRight ? 'Right' : 'Left'} Option down — arming chord grace`);
      chordGraceUntil = Date.now() + CHORD_GRACE_MS;
      clearPendingTimer();
      pendingPushToTalkTimer = setTimeout(() => {
        if (isPushToTalkHeld()) maybeStartPushToTalk();
      }, CHORD_GRACE_MS);
      return;
    }
    // Authoritative chord check: use the event's altKey mask directly.
    // Don't trust our tracked state alone — if we missed an Option-up event
    // and the user presses Space-alone, the OS mask correctly says
    // altKey === false and we won't fire a phantom chord.
    if (code === UiohookKey.Space && ev.altKey) {
      console.log('[forge-keys] Option + Space chord (mask-verified)');
      fireChord();
      return;
    }
  } else {
    // Windows
    if (code === UiohookKey.Ctrl) {
      if (modifiers.leftCtrl) return;
      modifiers.leftCtrl = true;
    } else if (code === UiohookKey.CtrlRight) {
      if (modifiers.rightCtrl) return;
      modifiers.rightCtrl = true;
    } else if (code === UiohookKey.Meta) {
      if (modifiers.leftMeta) return;
      modifiers.leftMeta = true;
    } else if (code === UiohookKey.MetaRight) {
      if (modifiers.rightMeta) return;
      modifiers.rightMeta = true;
    } else if (code === UiohookKey.Space) {
      // Authoritative chord check — use the event's mask, not our tracked
      // state, in case we missed a key-up event for Ctrl or Win.
      if (ev.ctrlKey && ev.metaKey) {
        console.log('[forge-keys] Ctrl+Win+Space chord (mask-verified)');
        fireChord();
        return;
      }
      return;
    } else {
      return; // unrelated key
    }

    // Ctrl+Win is now held. Defer push-to-talk start to detect chord.
    if (isPushToTalkHeld()) {
      chordGraceUntil = Date.now() + CHORD_GRACE_MS;
      clearPendingTimer();
      pendingPushToTalkTimer = setTimeout(() => {
        if (isPushToTalkHeld()) maybeStartPushToTalk();
      }, CHORD_GRACE_MS);
    }
  }
}

function onKeyUp(ev: any): void {
  syncModifiersFromMask(ev);
  const code = ev.keycode;
  if (!UiohookKey) return;

  if (isMac) {
    if (code === UiohookKey.Alt || code === UiohookKey.AltRight) {
      if (code === UiohookKey.AltRight) modifiers.rightOpt = false;
      else modifiers.leftOpt = false;
      // Only end PTT once the LAST option key is released (in case both
      // were held).
      if (!modifiers.leftOpt && !modifiers.rightOpt) {
        endPushToTalk();
      }
      return;
    }
  } else {
    if (code === UiohookKey.Ctrl) modifiers.leftCtrl = false;
    else if (code === UiohookKey.CtrlRight) modifiers.rightCtrl = false;
    else if (code === UiohookKey.Meta) modifiers.leftMeta = false;
    else if (code === UiohookKey.MetaRight) modifiers.rightMeta = false;
    else return;

    // If either modifier was released and push-to-talk was active, end it.
    if (!isPushToTalkHeld()) {
      endPushToTalk();
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────

export function isUiohookAvailable(): boolean {
  return uIOhook !== null;
}

export function getKeyboardListenerStatus(): {
  available: boolean;
  active: boolean;
  error: string | null;
} {
  return { available: !!uIOhook, active: started, error: uiohookLoadError };
}

/**
 * Start the listener. `dispatch` receives high-level Forge key events that
 * already encode push-to-talk vs hands-free intent.
 *
 * Returns whether the native hook started; `false` means we fell back to
 * `globalShortcut` and the caller should consult `getKeyboardListenerStatus`.
 */
export function startKeyboardListener(dispatch: Dispatcher): boolean {
  dispatcher = dispatch;
  if (started) return true;

  if (!uIOhook) {
    console.warn('[forge-keys] native hook not available, using globalShortcut fallback');
    registerGlobalShortcutFallback(dispatch);
    return false;
  }

  uIOhook.on('keydown', onKeyDown);
  uIOhook.on('keyup', onKeyUp);
  try {
    uIOhook.start();
    started = true;
    console.log(`[forge-keys] uiohook started — platform=${process.platform}`);
    return true;
  } catch (err: any) {
    console.error('[forge-keys] uiohook.start() failed:', err);
    uiohookLoadError = err?.message || String(err);
    registerGlobalShortcutFallback(dispatch);
    return false;
  }
}

export function stopKeyboardListener(): void {
  clearPendingTimer();
  pushToTalkActive = false;
  modifiers.leftOpt = false;
  modifiers.rightOpt = false;
  modifiers.leftCtrl = false;
  modifiers.rightCtrl = false;
  modifiers.leftMeta = false;
  modifiers.rightMeta = false;
  if (started && uIOhook) {
    try {
      uIOhook.stop();
      uIOhook.removeAllListeners?.();
    } catch (err) {
      console.warn('[forge-keys] uiohook.stop() failed:', err);
    }
    started = false;
  }
  globalShortcut.unregisterAll();
}

/**
 * Fallback when the native hook can't load. We map the chord (hands-free
 * toggle) to a registerable globalShortcut. Push-to-talk simply isn't
 * possible without the native hook, so we degrade to toggle-only behavior
 * and surface a warning to the user via console.
 */
function registerGlobalShortcutFallback(dispatch: Dispatcher): void {
  // Hands-free chord:
  //   Mac:  Cmd+Shift+Space  (closest to Fn+Space we can register)
  //   Win:  Control+Super+Space
  const accelerator = isMac ? 'CommandOrControl+Shift+Space' : 'Control+Super+Space';
  try {
    globalShortcut.register(accelerator, () => {
      console.log('[forge-keys] fallback chord pressed →', accelerator);
      dispatch({ kind: 'hands-free-toggle' });
    });
    console.log(`[forge-keys] globalShortcut fallback registered: ${accelerator}`);
  } catch (err) {
    console.error('[forge-keys] globalShortcut fallback failed:', err);
  }
  console.warn(
    '[forge-keys] push-to-talk DISABLED — install/rebuild uiohook-napi for the running Electron ABI to enable Fn / Ctrl+Win hold-to-talk',
  );
}

/** Helper for renderer-targeted send (mode-aware in main/index.ts). */
export function sendToTargetWindow(
  windows: { forge: BrowserWindow | null; main: BrowserWindow | null; useForge: boolean },
  channel: string,
): void {
  const target = windows.useForge && windows.forge && !windows.forge.isDestroyed()
    ? windows.forge
    : windows.main;
  if (target && !target.isDestroyed()) {
    target.webContents.send(channel);
  }
}
