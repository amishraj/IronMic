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

interface ExecFileWithStdinOptions {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  /** Cap the captured output (bytes). Default 1 MB. */
  maxBuffer?: number;
}

/**
 * Sibling of `execFilePortable` that writes a prompt to the child's stdin and
 * closes it, then collects stdout/stderr until the process exits. Used by the
 * Copilot stdin-capability probe and by `AIManager` for stdin-transport calls
 * that don't need streaming. Always shell:false.
 *
 * Behavior:
 * - Resolves with `{ stdout, stderr }` on a zero exit code.
 * - Rejects on a non-zero exit code, attaching stdout/stderr to the error so
 *   callers can inspect the partial output.
 * - Rejects with a clear timeout error after `opts.timeout` ms (default 10s).
 *   SIGTERM is sent on timeout.
 */
export function execFilePortableWithStdin(
  binary: string,
  args: string[],
  input: string,
  opts: ExecFileWithStdinOptions = {},
): Promise<ExecFilePortableResult> {
  const { bin, spawnArgs } = resolvePortableSpawn(binary, args);
  const timeoutMs = opts.timeout ?? 10_000;
  const maxBuffer = opts.maxBuffer ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, spawnArgs, {
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      reject(new Error(`execFilePortableWithStdin timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // Attach stdin error handler BEFORE writing to avoid uncaught EPIPE when
    // the child exits before consuming the payload.
    proc.stdin?.on('error', () => { /* surfaced via close handler */ });

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < maxBuffer) {
        stdout += chunk.toString('utf-8');
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < maxBuffer) {
        stderr += chunk.toString('utf-8');
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      (err as Error & { stdout?: string; stderr?: string }).stdout = stdout;
      (err as Error & { stdout?: string; stderr?: string }).stderr = stderr;
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err = new Error(`exited with code ${code}`) as Error & {
          stdout?: string;
          stderr?: string;
          code?: number | null;
        };
        err.stdout = stdout;
        err.stderr = stderr;
        err.code = code;
        reject(err);
      }
    });

    // Single write+end avoids backpressure plumbing for prompt-sized payloads.
    try {
      proc.stdin?.end(input, 'utf-8');
    } catch {
      /* stdin may already be closed if the child errored on spawn */
    }
  });
}
