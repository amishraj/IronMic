/**
 * Cross-platform process spawn helper.
 *
 * On Windows, .cmd batch files and extensionless npm shims cannot be executed
 * by CreateProcess() directly (spawn shell:false). Wrap them with cmd.exe /c.
 * On other platforms the binary and args pass through unchanged.
 *
 * shell:true is intentionally avoided because it requires escaping user-supplied
 * prompts against cmd.exe metacharacter injection. The /c form passes args
 * verbatim through the cmd.exe argv parser without invoking shell expansion.
 */

import { execFile, spawn, ExecFileOptions, ChildProcess, SpawnOptions } from 'child_process';

export function resolvePortableSpawn(
  binary: string,
  args: string[],
): { bin: string; spawnArgs: string[] } {
  if (
    process.platform === 'win32' &&
    (/\.cmd$/i.test(binary) || !/\.[a-z]+$/i.test(binary))
  ) {
    return {
      bin: process.env.COMSPEC || 'cmd.exe',
      spawnArgs: ['/c', binary, ...args],
    };
  }
  return { bin: binary, spawnArgs: args };
}

export function spawnPortable(
  binary: string,
  args: string[],
  opts: SpawnOptions,
): ChildProcess {
  const { bin, spawnArgs } = resolvePortableSpawn(binary, args);
  return spawn(bin, spawnArgs, opts);
}

interface ExecFilePortableResult {
  stdout: string;
  stderr: string;
}

/**
 * Promise-based execFile that wraps Windows .cmd shims via cmd.exe /c.
 * Always uses shell:false. Caller must supply timeout (ms) and signal for
 * cancellation. The Node execFile timeout sends SIGTERM; the AbortController
 * passed in `signal` sends the same signal at the parent process level.
 */
export function execFilePortable(
  binary: string,
  args: string[],
  opts: ExecFileOptions = {},
): Promise<ExecFilePortableResult> {
  const { bin, spawnArgs } = resolvePortableSpawn(binary, args);
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      spawnArgs,
      {
        encoding: 'utf-8',
        windowsHide: true,
        ...opts,
      },
      (err, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : stdout?.toString('utf-8') ?? '';
        const errOut = typeof stderr === 'string' ? stderr : stderr?.toString('utf-8') ?? '';
        if (err) {
          (err as Error & { stdout?: string; stderr?: string }).stdout = out;
          (err as Error & { stdout?: string; stderr?: string }).stderr = errOut;
          reject(err);
          return;
        }
        resolve({ stdout: out, stderr: errOut });
      },
    );
  });
}
