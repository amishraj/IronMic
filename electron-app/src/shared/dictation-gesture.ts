/**
 * Single source of truth for the user-facing dictation gesture strings.
 *
 * Since v1.7 the dictation hotkey is NOT a registerable Electron accelerator —
 * it's a low-level keyboard gesture handled by `main/keyboard-listener.ts`
 * (uiohook). The hardcoded gestures are:
 *
 *   - macOS:   Right Option (⌥) — hold to talk, release to paste.
 *              Right Option + Space — hands-free toggle.
 *   - Windows: Ctrl + Win — hold to talk, release to paste.
 *              Ctrl + Win + Space — hands-free toggle.
 *
 * Any UI that displays "the hotkey" (Welcome page, Settings, tooltips, etc.)
 * MUST read from this module so the strings stay in sync with the listener.
 *
 * Why Right Option instead of Fn on macOS:
 *   - macOS Fn is handled below the public CGEventTap layer; userspace
 *     hooks cannot observe its press/release. Wispr Flow uses Fn via a
 *     private path that requires Apple-blessed entitlements unavailable to
 *     off-the-shelf Electron apps. Right Option is the closest substitute
 *     that uiohook reliably detects, sits next to Fn on the keyboard, and
 *     doesn't conflict with normal use (unlike Left Option, which macOS
 *     uses for character composition).
 */

export interface DictationGesture {
  /** Push-to-talk gesture (hold to talk). */
  pushToTalk: string;
  /** Hands-free toggle gesture (chord). */
  handsFree: string;
  /**
   * The "primary" hotkey to surface in marketing-style UI like the home
   * page. We pick the hands-free chord because it's the closest analog of
   * the old toggle-style ⌘⇧V — tap to start, tap to stop.
   */
  primary: string;
  /** A short, human description suitable for a tooltip or onboarding card. */
  description: string;
}

function detectPlatform(): 'mac' | 'win' | 'linux' {
  const p = (typeof navigator !== 'undefined' ? navigator.platform : '').toLowerCase();
  if (p.includes('mac')) return 'mac';
  if (p.includes('win')) return 'win';
  return 'linux';
}

export function getDictationGesture(): DictationGesture {
  switch (detectPlatform()) {
    case 'mac':
      return {
        pushToTalk: 'Hold ⌥ (Option)',
        handsFree: '⌥ + Space',
        primary: '⌥ + Space',
        description:
          'Hold Option to talk and release to paste, or tap Option + Space for hands-free dictation.',
      };
    case 'win':
      return {
        pushToTalk: 'Hold Ctrl + Win',
        handsFree: 'Ctrl + Win + Space',
        primary: 'Ctrl + Win + Space',
        description:
          'Hold Ctrl + Win to talk and release to paste, or tap Ctrl + Win + Space for hands-free dictation.',
      };
    default:
      return {
        pushToTalk: 'Hold Right Alt',
        handsFree: 'Right Alt + Space',
        primary: 'Right Alt + Space',
        description:
          'Hold Right Alt to talk and release to paste, or tap Right Alt + Space for hands-free dictation.',
      };
  }
}
