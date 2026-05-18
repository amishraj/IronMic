/**
 * blackhole-setup.ts — BlackHole 2ch detection and guided installation.
 *
 * BlackHole is a macOS CoreAudio "audio server plug-in" (NOT a kext).
 * Installing it requires only an admin password — no SIP changes needed.
 *
 * On Windows, WASAPI loopback works natively by selecting the output device
 * as an input source, so no extra software is needed.
 *
 * Privacy note: the download comes from the official BlackHole GitHub
 * release. No audio data is ever sent anywhere.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as os from 'os';
import { execFile } from 'child_process';
import { BrowserWindow, app } from 'electron';

// Official BlackHole 2ch release pkg (CoreAudio HAL plug-in, no kext)
const BLACKHOLE_PKG_URL =
  'https://github.com/ExistentialAudio/BlackHole/releases/download/v0.6.0/BlackHole2ch.v0.6.0.pkg';
const BLACKHOLE_PKG_FILENAME = 'BlackHole2ch.v0.6.0.pkg';

/** Virtual / loopback device names across platforms */
export const VIRTUAL_AUDIO_DEVICE_PATTERNS =
  /blackhole|soundflower|loopback|virtual|vb.?cable|voicemeeter/i;

export type BlackHoleStatus = 'installed' | 'not_installed' | 'unsupported';

export interface InstallProgress {
  stage: 'downloading' | 'installing' | 'done' | 'error';
  /** 0-100 during download, undefined otherwise */
  percent?: number;
  message: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Detection
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Determine whether BlackHole (or a similar virtual device) is present.
 * We rely on the existing `list_audio_devices` N-API call when possible,
 * but fall back to system_profiler if we're in the main process without a
 * loaded addon.
 */
export async function checkBlackHoleInstalled(
  deviceListJson?: string,
): Promise<BlackHoleStatus> {
  if (process.platform !== 'darwin') return 'unsupported';

  // Fast path: caller already has the device list from the Rust addon
  if (deviceListJson) {
    try {
      const devices: Array<{ name: string }> = JSON.parse(deviceListJson);
      const found = devices.some(d => VIRTUAL_AUDIO_DEVICE_PATTERNS.test(d.name));
      return found ? 'installed' : 'not_installed';
    } catch { /* fall through to system_profiler */ }
  }

  // Slow path: ask system_profiler
  return new Promise((resolve) => {
    execFile(
      'system_profiler',
      ['SPAudioDataType', '-json'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve('not_installed');
        try {
          const obj = JSON.parse(stdout);
          const str = JSON.stringify(obj);
          resolve(VIRTUAL_AUDIO_DEVICE_PATTERNS.test(str) ? 'installed' : 'not_installed');
        } catch {
          resolve('not_installed');
        }
      },
    );
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Installation
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Download the BlackHole pkg (if needed) and run the macOS `installer` via
 * `osascript` so the user sees a standard admin-password dialog.
 *
 * `onProgress` is called throughout — callers should relay these to the UI
 * via a push IPC event.
 */
export async function installBlackHole(
  onProgress: (p: InstallProgress) => void,
): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('BlackHole is only needed on macOS.');
  }

  const tmpDir = os.tmpdir();
  const pkgPath = path.join(tmpDir, BLACKHOLE_PKG_FILENAME);

  // 1. Use bundled pkg if it shipped with the app (reduces network dependency)
  const resourcesPkg = path.join(
    process.resourcesPath ?? path.join(__dirname, '..', '..', 'resources'),
    'blackhole',
    BLACKHOLE_PKG_FILENAME,
  );

  let sourcePkg: string;
  if (fs.existsSync(resourcesPkg)) {
    onProgress({ stage: 'installing', percent: 0, message: 'Using bundled BlackHole package…' });
    sourcePkg = resourcesPkg;
  } else {
    onProgress({ stage: 'downloading', percent: 0, message: 'Downloading BlackHole 2ch…' });
    await downloadFile(BLACKHOLE_PKG_URL, pkgPath, (pct) => {
      onProgress({ stage: 'downloading', percent: pct, message: `Downloading… ${pct}%` });
    });
    sourcePkg = pkgPath;
  }

  // 2. Run installer with admin privileges via AppleScript
  onProgress({ stage: 'installing', percent: 0, message: 'Waiting for admin password…' });
  await runInstallerWithPrivileges(sourcePkg);
  onProgress({ stage: 'done', message: 'BlackHole 2ch installed. Restart your audio apps.' });

  // Clean up temp download
  if (sourcePkg === pkgPath) {
    try { fs.unlinkSync(pkgPath); } catch { /* ignore */ }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

async function downloadFile(
  url: string,
  dest: string,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const doGet = (getUrl: string) => {
      const req = https.get(getUrl, (res) => {
        // Follow one redirect
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          return doGet(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }
        const total = parseInt(res.headers['content-length'] ?? '0', 10);
        let received = 0;
        const file = fs.createWriteStream(dest);
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (total > 0) onProgress(Math.round((received / total) * 100));
        });
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
      });
      req.on('error', reject);
    };
    doGet(url);
  });
}

async function runInstallerWithPrivileges(pkgPath: string): Promise<void> {
  // Escape single quotes in path (unlikely but safe)
  const safePath = pkgPath.replace(/'/g, "'\\''");
  const script = `do shell script "installer -pkg '${safePath}' -target /" with administrator privileges`;
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 120_000 }, (err) => {
      if (!err) return resolve();
      if (err.message.includes('User canceled') || err.message.includes('-128')) {
        reject(new Error('Installation cancelled.'));
      } else {
        reject(new Error(`Installation failed: ${err.message}`));
      }
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Aggregate Device helper (macOS Audio MIDI Setup)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Open macOS Audio MIDI Setup so the user can create an Aggregate Device
 * combining their mic with BlackHole.  Creating it programmatically requires
 * the CoreAudio framework which isn't available from Node; pointing users to
 * the GUI is the safest approach.
 */
export function openAudioMidiSetup(): void {
  execFile('open', ['-a', 'Audio MIDI Setup'], (err) => {
    if (err) console.warn('[BlackHole] Could not open Audio MIDI Setup:', err.message);
  });
}

/** Push install progress to all renderer windows. */
export function broadcastInstallProgress(progress: InstallProgress): void {
  const wins = BrowserWindow.getAllWindows();
  for (const win of wins) {
    if (!win.isDestroyed()) {
      win.webContents.send('ironmic:blackhole-install-progress', progress);
    }
  }
}
