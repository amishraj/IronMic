/**
 * MeetingAppDetector — Polls the active window title to detect meeting apps.
 *
 * Opt-in only (gated behind meeting_auto_detect_enabled setting).
 * Checks every 5 seconds for Zoom, Teams, or Google Meet in the frontmost window.
 * Sends an IPC event to the renderer when detected.
 *
 * Privacy: Only reads the window title of the frontmost app. No deep process
 * inspection, no screen capture, no audio monitoring.
 */

import { BrowserWindow } from 'electron';
import { execSync } from 'child_process';
import { native } from './native-bridge';

type DetectedApp = 'zoom' | 'teams' | 'meet' | null;

const POLL_INTERVAL_MS = 5000;
const MEETING_PATTERNS: Array<{ pattern: RegExp; app: DetectedApp }> = [
  { pattern: /zoom\s+(meeting|webinar)/i, app: 'zoom' },
  { pattern: /^zoom$/i, app: 'zoom' },
  { pattern: /microsoft\s+teams/i, app: 'teams' },
  { pattern: /meet\.google\.com/i, app: 'meet' },
  { pattern: /google\s+meet/i, app: 'meet' },
];

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastDetected: DetectedApp = null;
let enabled = false;

/**
 * Start polling for meeting apps (if enabled in settings).
 */
export function startMeetingAppDetection(): void {
  const setting = native.getSetting('meeting_auto_detect_enabled');
  enabled = setting === 'true';

  if (!enabled) {
    console.log('[meeting-app-detector] Disabled (opt-in required)');
    return;
  }

  if (pollTimer) return; // Already running

  console.log('[meeting-app-detector] Started polling');
  pollTimer = setInterval(checkActiveWindow, POLL_INTERVAL_MS);
}

/**
 * Stop polling.
 */
export function stopMeetingAppDetection(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    lastDetected = null;
  }
}

/**
 * Update enabled state (call when setting changes).
 */
export function setMeetingAppDetectionEnabled(value: boolean): void {
  enabled = value;
  if (value) {
    startMeetingAppDetection();
  } else {
    stopMeetingAppDetection();
  }
}

function checkActiveWindow(): void {
  if (!enabled) return;

  try {
    const title = getActiveWindowTitle();
    if (!title) return;

    const detected = detectMeetingApp(title);

    // Only send event on state change (new detection, not repeated)
    if (detected && detected !== lastDetected) {
      lastDetected = detected;
      const window = BrowserWindow.getAllWindows()[0];
      if (window && !window.isDestroyed()) {
        window.webContents.send('ironmic:meeting-app-detected', {
          app: detected,
          windowTitle: title,
        });
        console.log(`[meeting-app-detector] Detected: ${detected} (${title})`);
      }
    } else if (!detected) {
      lastDetected = null;
    }
  } catch {
    // Silently ignore — window title access can fail in various cases
  }
}

function detectMeetingApp(title: string): DetectedApp {
  for (const { pattern, app } of MEETING_PATTERNS) {
    if (pattern.test(title)) return app;
  }
  return null;
}

function getActiveWindowTitle(): string | null {
  if (process.platform === 'darwin') {
    return getMacOSActiveWindowTitle();
  } else if (process.platform === 'win32') {
    return getWindowsActiveWindowTitle();
  }
  // Linux: not supported yet (would need xdotool or similar)
  return null;
}

function getMacOSActiveWindowTitle(): string | null {
  try {
    const result = execSync(
      `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`,
      { encoding: 'utf-8', timeout: 2000 },
    ).trim();
    return result || null;
  } catch {
    return null;
  }
}

function getWindowsActiveWindowTitle(): string | null {
  try {
    const result = execSync(
      `powershell -command "(Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Where-Object {$_.MainWindowHandle -eq (Add-Type -MemberDefinition '[DllImport(\\\"user32.dll\\\")] public static extern IntPtr GetForegroundWindow();' -Name 'User32' -Namespace 'Win32Functions' -PassThru)::GetForegroundWindow()}).MainWindowTitle"`,
      { encoding: 'utf-8', timeout: 3000 },
    ).trim();
    return result || null;
  } catch {
    return null;
  }
}
