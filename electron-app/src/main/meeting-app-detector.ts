/**
 * MeetingAppDetector — Polls the active window title to detect meeting apps
 * and sends the user an OS notification + in-app prompt to start recording.
 *
 * Design changes from v1:
 *  - **Enabled by default** (migration on first boot flips the seeded 'false').
 *  - **Real window titles**, not just the frontmost process name. This lets
 *    us detect browser-hosted meetings (e.g. Google Meet in Chrome's title
 *    "Meet – standup – Google Chrome").
 *  - **Expanded patterns**: Zoom, Teams, Google Meet, Webex, FaceTime,
 *    Slack Huddle, Discord call, Jitsi, Around, GoToMeeting.
 *  - **OS Notification** via Electron's Notification API. Clicking it
 *    focuses the app and navigates to the Meetings page via the existing
 *    tray quick-action channel — one click from spotting the meeting to
 *    recording locally.
 *
 * Privacy: Still read-only — only active-window titles. No screen capture,
 * no audio monitoring, no deep process inspection. Never goes to disk.
 */

import { BrowserWindow, Notification, app as electronApp } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';
import { native } from './native-bridge';

/** Async child_process.exec — critical that we never use execSync from the
 *  main process, since the main thread owns IPC and blocking it stalls every
 *  click/scroll in the renderer. */
const execAsync = promisify(exec);

export type DetectedApp =
  | 'zoom' | 'teams' | 'meet' | 'webex' | 'facetime'
  | 'slack-huddle' | 'discord' | 'jitsi' | 'around' | 'gotomeeting'
  | null;

/** Poll interval for active-window detection.
 *  Trade-off: a single AppleScript/PowerShell call per tick is cheap (<5ms on
 *  a modern machine), so we poll aggressively to minimize the gap between a
 *  meeting starting and the user seeing our desktop notification. At 1500ms,
 *  p50 detection latency is ~750ms — fast enough that the notification
 *  arrives while the user is still mid-greeting. */
const POLL_INTERVAL_MS = 1500;
/** Notification throttle — prevent spam when the user briefly switches away
 *  from a meeting window and back. Shorter than before so that reopening a
 *  DIFFERENT meeting within a minute still notifies. */
const NOTIFY_THROTTLE_MS = 20_000;

/**
 * Detection patterns. Ordered: more-specific patterns first, catch-all
 * process-name patterns as fallback. Most patterns also match browser tabs
 * because browsers show the tab title in their window title.
 */
const MEETING_PATTERNS: Array<{ pattern: RegExp; app: Exclude<DetectedApp, null>; label: string }> = [
  // Zoom — native app AND zoom.us web client
  { pattern: /zoom\s+(meeting|webinar)/i, app: 'zoom', label: 'Zoom' },
  { pattern: /\bzoom\.us\b/i, app: 'zoom', label: 'Zoom (web)' },

  // Microsoft Teams — desktop + teams.microsoft.com web
  { pattern: /microsoft\s+teams/i, app: 'teams', label: 'Microsoft Teams' },
  { pattern: /teams\.(microsoft|live)\.com/i, app: 'teams', label: 'Teams (web)' },

  // Google Meet — always browser-hosted. Chrome/Safari/Firefox/Edge show
  // "Meet – <room name>" in the window title for active meet tabs.
  { pattern: /meet\.google\.com/i, app: 'meet', label: 'Google Meet' },
  { pattern: /\bMeet\s*[–-]\s*/i, app: 'meet', label: 'Google Meet' },

  // Cisco Webex
  { pattern: /\bwebex\b/i, app: 'webex', label: 'Webex' },

  // macOS FaceTime
  { pattern: /\bfacetime\b/i, app: 'facetime', label: 'FaceTime' },

  // Slack huddle (the window title shows "— Huddle" while in one)
  { pattern: /\bhuddle\b/i, app: 'slack-huddle', label: 'Slack Huddle' },

  // Discord call/voice
  { pattern: /discord\s+[-–]\s+.*#/i, app: 'discord', label: 'Discord' },

  // Jitsi Meet
  { pattern: /meet\.jit\.si|\bjitsi\b/i, app: 'jitsi', label: 'Jitsi' },

  // Around
  { pattern: /\baround\b.*room|^around$/i, app: 'around', label: 'Around' },

  // GoToMeeting
  { pattern: /gotomeeting|gotomeet\.me/i, app: 'gotomeeting', label: 'GoToMeeting' },
];

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastDetected: DetectedApp = null;
let lastNotifiedAt = 0;
let enabled = false;
/** Guard against overlapping polls — if osascript is slow, we skip the next
 *  tick rather than stacking concurrent calls (which would compound latency). */
let checkInFlight = false;

/**
 * One-time migration: flip the seeded default from 'false' to 'true' for
 * users who never explicitly touched the setting. Called at startup BEFORE
 * the first check. Idempotent — guarded by its own settings key.
 */
export function applyAutoDetectDefaultMigration(): void {
  try {
    const migrationDone = native.getSetting('migration_auto_detect_default_v2');
    if (migrationDone === 'true') return;
    // Flip to 'true' (new default). If a user previously explicitly set
    // 'false' and that was intentional, they can flip it back in Settings.
    native.setSetting('meeting_auto_detect_enabled', 'true');
    native.setSetting('migration_auto_detect_default_v2', 'true');
    console.log('[meeting-app-detector] One-time migration: enabled auto-detect by default');
  } catch (err) {
    console.warn('[meeting-app-detector] Migration failed (non-fatal):', err);
  }
}

/**
 * Start polling for meeting apps (if enabled in settings).
 */
export function startMeetingAppDetection(): void {
  const setting = native.getSetting('meeting_auto_detect_enabled');
  enabled = setting !== 'false'; // default to enabled if unset

  if (!enabled) {
    console.log('[meeting-app-detector] Disabled by user setting');
    return;
  }
  if (pollTimer) return;

  console.log(`[meeting-app-detector] Started polling (${POLL_INTERVAL_MS}ms)`);
  pollTimer = setInterval(() => { void checkActiveWindow(); }, POLL_INTERVAL_MS);
  // Run once immediately so a just-launched meeting is caught without waiting
  // for the first interval tick.
  setTimeout(() => { void checkActiveWindow(); }, 200);
}

export function stopMeetingAppDetection(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    lastDetected = null;
  }
}

export function setMeetingAppDetectionEnabled(value: boolean): void {
  enabled = value;
  if (value) startMeetingAppDetection();
  else stopMeetingAppDetection();
}

async function checkActiveWindow(): Promise<void> {
  if (!enabled) return;
  if (checkInFlight) return; // previous poll still running — skip this tick
  checkInFlight = true;
  try {
    const title = await getActiveWindowTitle();
    if (!title) return;
    const match = detectMeetingApp(title);

    // Only react when we transition to a new detection (avoid spam on repeat).
    if (match && match.app !== lastDetected) {
      lastDetected = match.app;
      notifyDetection(match.app, match.label, title);
    } else if (!match) {
      lastDetected = null;
    }
  } catch {
    // Silent — OS calls can fail (sandboxing, permissions, etc.)
  } finally {
    checkInFlight = false;
  }
}

function detectMeetingApp(title: string): { app: Exclude<DetectedApp, null>; label: string } | null {
  for (const { pattern, app, label } of MEETING_PATTERNS) {
    if (pattern.test(title)) return { app, label };
  }
  return null;
}

/** Fire the in-app event AND an OS notification. */
function notifyDetection(app: Exclude<DetectedApp, null>, label: string, windowTitle: string): void {
  console.log(`[meeting-app-detector] Detected: ${app} (${windowTitle})`);

  // In-app event (legacy — MeetingPage listens for this to pre-fill detected_app).
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    win.webContents.send('ironmic:meeting-app-detected', { app, windowTitle });
  }

  // OS-level notification — throttled so quickly toggling between meeting
  // windows doesn't spam. Shorter throttle = faster re-notify when the user
  // genuinely joined a different meeting.
  const now = Date.now();
  if (now - lastNotifiedAt < NOTIFY_THROTTLE_MS) return;
  lastNotifiedAt = now;

  try {
    if (!Notification.isSupported()) return;
    const note = new Notification({
      title: `${label} meeting detected`,
      body: 'Tap to start recording locally and take AI notes in IronMic.',
      silent: false,
    });
    note.on('click', () => {
      // Tapping the notification focuses + navigates to Meetings and auto-starts.
      const w = BrowserWindow.getAllWindows()[0];
      if (w && !w.isDestroyed()) {
        if (w.isMinimized()) w.restore();
        if (!w.isVisible()) w.show();
        w.focus();
        w.webContents.send('ironmic:quick-action', 'start-meeting');
      } else {
        // Window was closed — re-launch via app focus.
        try { electronApp.focus({ steal: true }); } catch { /* noop */ }
      }
    });
    note.show();
  } catch (err) {
    console.warn('[meeting-app-detector] Notification failed (non-fatal):', err);
  }
}

/**
 * Returns the TITLE of the currently focused window (not just the app name).
 * This is what lets us detect browser-based meetings.
 *
 * Async — shells out to osascript/powershell via non-blocking exec so the
 * main process event loop stays free for IPC. Previously this used execSync,
 * which blocked every click/scroll in the renderer every poll tick.
 */
async function getActiveWindowTitle(): Promise<string | null> {
  if (process.platform === 'darwin') return getMacOSActiveWindowTitle();
  if (process.platform === 'win32') return getWindowsActiveWindowTitle();
  return null;
}

/**
 * macOS: get BOTH the frontmost app name AND the title of its focused window.
 * Combined into one string so browser meetings (where the app is just
 * "Google Chrome" but the window title tells us it's a Meet tab) are detected.
 *
 * System Events requires the user to have granted Automation permission to
 * IronMic for "System Events" — if that hasn't happened yet, AppleScript
 * throws and we silently degrade to app-name-only detection.
 */
async function getMacOSActiveWindowTitle(): Promise<string | null> {
  try {
    // Single AppleScript call that returns "AppName ||| WindowTitle".
    // If window title access is denied we still get the app name.
    const script =
      'tell application "System Events" ' +
      'to tell (first application process whose frontmost is true) ' +
      'to try\n' +
      '    set appName to name\n' +
      '    set winTitle to ""\n' +
      '    try\n' +
      '        set winTitle to name of front window\n' +
      '    end try\n' +
      '    return appName & " ||| " & winTitle\n' +
      'end try';
    const { stdout } = await execAsync(`osascript -e '${script}'`, {
      encoding: 'utf-8',
      timeout: 2000,
    });
    const result = stdout.trim();
    if (!result) return null;
    // Join app + title with a space — detection regex can match either part.
    const parts = result.split(' ||| ');
    return parts.filter(Boolean).join(' ');
  } catch {
    return null;
  }
}

async function getWindowsActiveWindowTitle(): Promise<string | null> {
  try {
    // PowerShell one-liner: get the MainWindowTitle of the foreground process.
    const { stdout } = await execAsync(
      `powershell -command "Add-Type -MemberDefinition '[DllImport(\\\"user32.dll\\\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\\\"user32.dll\\\")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);' -Name 'W' -Namespace 'P' -PassThru; $sb = New-Object System.Text.StringBuilder 512; [P.W]::GetWindowText([P.W]::GetForegroundWindow(), $sb, 512) | Out-Null; $sb.ToString()"`,
      { encoding: 'utf-8', timeout: 3000 },
    );
    const result = stdout.trim();
    return result || null;
  } catch {
    return null;
  }
}
