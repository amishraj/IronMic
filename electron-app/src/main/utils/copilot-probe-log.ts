import { promises as fs } from 'fs';
import { join } from 'path';

const MAX_HEAD_BYTES = 4 * 1024;
const ROTATE_AT_BYTES = 1024 * 1024;

let cachedLogPath: string | null | undefined;
let printedPathOnce = false;

export interface ProbeLogEntry {
  args: string[];
  exitCode: number | string | null;
  stdout: string;
  stderr: string;
}

/**
 * Append a JSON line for one Copilot CLI probe to
 * `<userData>/logs/copilot-probe.log`. Silent no-op if Electron's `app`
 * isn't available (e.g. unit tests). Never throws.
 */
export async function logCopilotProbe(entry: ProbeLogEntry): Promise<void> {
  try {
    const path = await resolveLogPath();
    if (!path) return;

    if (!printedPathOnce) {
      printedPathOnce = true;
      // eslint-disable-next-line no-console
      console.log(`[copilot.probe] log file: ${path}`);
    }

    await maybeRotate(path);

    const stdout = truncate(entry.stdout);
    const stderr = truncate(entry.stderr);
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        args: entry.args,
        exitCode: entry.exitCode,
        stdoutLen: entry.stdout.length,
        stderrLen: entry.stderr.length,
        stdoutHead: stdout,
        stderrHead: stderr,
      }) + '\n';

    await fs.appendFile(path, line, 'utf-8');
  } catch {
    /* never block a probe */
  }
}

async function resolveLogPath(): Promise<string | null> {
  if (cachedLogPath !== undefined) return cachedLogPath;
  try {
    // Lazy require so this module is safe to import outside Electron (tests).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron');
    const userData: string | undefined = electron?.app?.getPath?.('userData');
    if (!userData) {
      cachedLogPath = null;
      return null;
    }
    const dir = join(userData, 'logs');
    await fs.mkdir(dir, { recursive: true });
    cachedLogPath = join(dir, 'copilot-probe.log');
    return cachedLogPath;
  } catch {
    cachedLogPath = null;
    return null;
  }
}

async function maybeRotate(path: string): Promise<void> {
  try {
    const stat = await fs.stat(path);
    if (stat.size > ROTATE_AT_BYTES) {
      await fs.truncate(path, 0);
    }
  } catch {
    /* file may not exist yet — appendFile will create it */
  }
}

function truncate(s: string): string {
  if (s.length <= MAX_HEAD_BYTES) return s;
  return s.slice(0, MAX_HEAD_BYTES);
}
