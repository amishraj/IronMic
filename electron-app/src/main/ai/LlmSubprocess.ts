/**
 * LlmSubprocess — manages the persistent ironmic-llm child process.
 *
 * The ironmic-llm binary runs LLM inference in a separate process to avoid
 * ggml symbol collision with whisper-rs in the main N-API addon.
 *
 * Protocol: JSON commands on stdin, streamed tokens on stdout, __DONE__ sentinel.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

interface ChatRequest {
  command: 'chat';
  model_path: string;
  model_type: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens: number;
  temperature: number;
}

interface PolishRequest {
  command: 'polish';
  model_path: string;
  text: string;
}

type LlmRequest = ChatRequest | PolishRequest;

/** Find the ironmic-llm binary. */
function findBinary(): string | null {
  // On Windows the binary is `ironmic-llm.exe`. The previous lookup used the
  // bare name on every platform, so packaged Windows installs (where the
  // .exe is bundled into resources) silently failed and local LLM "didn't
  // work" with no clear error.
  const exe = process.platform === 'win32' ? 'ironmic-llm.exe' : 'ironmic-llm';
  const possiblePaths = [
    // Development path — __dirname is dist/main/ai/, need to go up to project root
    path.join(__dirname, '..', '..', '..', '..', 'rust-core', 'target', 'release', exe),
    // Also check via IRONMIC_MODELS_DIR which is set reliably in index.ts
    process.env.IRONMIC_MODELS_DIR
      ? path.join(process.env.IRONMIC_MODELS_DIR, '..', '..', 'target', 'release', exe)
      : '',
    // Production path (bundled)
    path.join(process.resourcesPath || '', exe),
  ].filter(Boolean);
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

class LlmSubprocessManager {
  private proc: ChildProcess | null = null;
  private binaryPath: string | null = null;
  private pendingResolve: ((result: string) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;
  private pendingOnToken: ((token: string) => void) | null = null;
  private outputBuffer = '';
  private requestQueue: Array<{
    request: LlmRequest;
    onToken?: (token: string) => void;
    resolve: (result: string) => void;
    reject: (err: Error) => void;
    signal?: AbortSignal;
    signalHandler?: () => void;
  }> = [];
  private busy = false;
  /** Tracks the in-flight request so its AbortSignal can cancel it mid-stream. */
  private activeAbort: { signal: AbortSignal; handler: () => void } | null = null;

  /** Check if the binary exists. */
  isAvailable(): boolean {
    if (!this.binaryPath) this.binaryPath = findBinary();
    return this.binaryPath !== null;
  }

  /** Get the binary path. */
  getBinaryPath(): string | null {
    if (!this.binaryPath) this.binaryPath = findBinary();
    return this.binaryPath;
  }

  /** Ensure the subprocess is running. */
  private ensureProcess(): ChildProcess {
    if (this.proc && !this.proc.killed) return this.proc;

    const binary = this.getBinaryPath();
    if (!binary) {
      throw new Error('ironmic-llm binary not found. Build it with: cargo build --release --bin ironmic-llm --features llm-bin');
    }

    if (process.env.NODE_ENV === 'development') {
      console.log(`[llm-subprocess] Spawning: ${binary}`);
    }

    this.proc = spawn(binary, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        IRONMIC_MODELS_DIR: process.env.IRONMIC_MODELS_DIR || '',
      },
    });

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.handleStdout(chunk.toString());
    });

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      if (process.env.NODE_ENV === 'development') {
        // Filter out model loading noise — only show errors/warnings
        const text = chunk.toString();
        if (text.includes('ERROR') || text.includes('WARN') || text.includes('INFO ironmic')) {
          console.error(`[llm-subprocess] ${text.trim()}`);
        }
      }
    });

    this.proc.on('error', (err) => {
      console.error(`[llm-subprocess] Process error: ${err.message}`);
      if (this.pendingReject) {
        this.pendingReject(new Error(`LLM subprocess error: ${err.message}`));
        this.pendingResolve = null;
        this.pendingReject = null;
        this.pendingOnToken = null;
      }
      this.proc = null;
    });

    this.proc.on('close', (code) => {
      if (process.env.NODE_ENV === 'development') {
        console.log(`[llm-subprocess] Process exited with code ${code}`);
      }
      if (this.pendingReject) {
        this.pendingReject(new Error(`LLM subprocess exited unexpectedly (code ${code})`));
        this.pendingResolve = null;
        this.pendingReject = null;
        this.pendingOnToken = null;
      }
      this.proc = null;
      this.busy = false;
      // Process next queued request
      this.processQueue();
    });

    return this.proc;
  }

  /** Handle stdout data from the subprocess. */
  private handleStdout(data: string) {
    this.outputBuffer += data;

    // Check for __DONE__ sentinel
    const doneIdx = this.outputBuffer.indexOf('__DONE__');
    const errorIdx = this.outputBuffer.indexOf('__ERROR__:');

    if (errorIdx !== -1) {
      const errorEnd = this.outputBuffer.indexOf('\n', errorIdx);
      const errorMsg = errorEnd !== -1
        ? this.outputBuffer.substring(errorIdx + '__ERROR__:'.length, errorEnd)
        : this.outputBuffer.substring(errorIdx + '__ERROR__:'.length);

      if (this.pendingReject) {
        this.pendingReject(new Error(errorMsg.trim()));
      }
      this.outputBuffer = '';
      this.pendingResolve = null;
      this.pendingReject = null;
      this.pendingOnToken = null;
      this.busy = false;
      this.clearActiveAbort();
      this.processQueue();
      return;
    }

    if (doneIdx !== -1) {
      // Extract the full response (everything before __DONE__)
      const fullResponse = this.outputBuffer.substring(0, doneIdx).trim();

      if (this.pendingResolve) {
        this.pendingResolve(fullResponse);
      }
      this.outputBuffer = '';
      this.pendingResolve = null;
      this.pendingReject = null;
      this.pendingOnToken = null;
      this.busy = false;
      this.clearActiveAbort();
      this.processQueue();
      return;
    }

    // Stream tokens to callback as they arrive
    if (this.pendingOnToken && data.length > 0) {
      this.pendingOnToken(data);
    }
  }

  /** Process the next request in the queue. */
  private processQueue() {
    if (this.busy || this.requestQueue.length === 0) return;

    // Skip already-aborted queued requests
    while (this.requestQueue.length > 0) {
      const head = this.requestQueue[0];
      if (head.signal?.aborted) {
        this.requestQueue.shift();
        if (head.signalHandler) head.signal?.removeEventListener('abort', head.signalHandler);
        head.reject(new Error('LLM request aborted'));
        continue;
      }
      break;
    }
    if (this.requestQueue.length === 0) return;

    const { request, onToken, resolve, reject, signal } = this.requestQueue.shift()!;
    this.executeRequest(request, onToken, resolve, reject, signal);
  }

  /** Execute a request against the subprocess. */
  private executeRequest(
    request: LlmRequest,
    onToken: ((token: string) => void) | undefined,
    resolve: (result: string) => void,
    reject: (err: Error) => void,
    signal?: AbortSignal,
  ) {
    this.busy = true;
    this.outputBuffer = '';
    this.pendingResolve = resolve;
    this.pendingReject = reject;
    this.pendingOnToken = onToken || null;

    // Wire cancellation: aborting mid-stream kills the subprocess (it respawns
    // on next request). This is the only way to stop llama.cpp inference —
    // the protocol has no cancel command.
    if (signal) {
      if (signal.aborted) {
        this.busy = false;
        this.pendingResolve = null;
        this.pendingReject = null;
        this.pendingOnToken = null;
        reject(new Error('LLM request aborted'));
        // Process the next request after microtask so state is clean
        setImmediate(() => this.processQueue());
        return;
      }
      const handler = () => {
        if (this.pendingReject) {
          const rej = this.pendingReject;
          this.pendingResolve = null;
          this.pendingReject = null;
          this.pendingOnToken = null;
          rej(new Error('LLM request aborted'));
        }
        // Kill the subprocess — the 'close' handler will reset busy and drain queue.
        if (this.proc && !this.proc.killed) {
          try { this.proc.kill('SIGTERM'); } catch { /* ignore */ }
        }
        this.activeAbort = null;
      };
      signal.addEventListener('abort', handler, { once: true });
      this.activeAbort = { signal, handler };
    }

    try {
      const proc = this.ensureProcess();
      const json = JSON.stringify(request) + '\n';
      proc.stdin?.write(json);
    } catch (err: unknown) {
      this.busy = false;
      if (this.activeAbort) {
        this.activeAbort.signal.removeEventListener('abort', this.activeAbort.handler);
        this.activeAbort = null;
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Send a request (queued if busy). */
  private sendRequest(
    request: LlmRequest,
    onToken?: (token: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('LLM request aborted'));
        return;
      }
      if (this.busy) {
        const entry = { request, onToken, resolve, reject, signal, signalHandler: undefined as (() => void) | undefined };
        if (signal) {
          const handler = () => {
            // Remove from queue if still there
            const idx = this.requestQueue.indexOf(entry);
            if (idx !== -1) {
              this.requestQueue.splice(idx, 1);
              reject(new Error('LLM request aborted'));
            }
          };
          entry.signalHandler = handler;
          signal.addEventListener('abort', handler, { once: true });
        }
        this.requestQueue.push(entry);
      } else {
        this.executeRequest(request, onToken, resolve, reject, signal);
      }
    });
  }

  /** Clear the AbortSignal listener for the current in-flight request. */
  private clearActiveAbort(): void {
    if (this.activeAbort) {
      this.activeAbort.signal.removeEventListener('abort', this.activeAbort.handler);
      this.activeAbort = null;
    }
  }

  /** Run chat completion. Pass `signal` to cancel mid-stream. */
  async chatComplete(
    params: {
      modelPath: string;
      modelType: string;
      messages: Array<{ role: string; content: string }>;
      maxTokens: number;
      temperature: number;
      signal?: AbortSignal;
    },
    onToken?: (token: string) => void,
  ): Promise<string> {
    return this.sendRequest(
      {
        command: 'chat',
        model_path: params.modelPath,
        model_type: params.modelType,
        messages: params.messages,
        max_tokens: params.maxTokens,
        temperature: params.temperature,
      },
      onToken,
      params.signal,
    );
  }

  /** Run text polishing. */
  async polishText(text: string, modelPath: string): Promise<string> {
    return this.sendRequest({
      command: 'polish',
      model_path: modelPath,
      text,
    });
  }

  /** Kill the subprocess. */
  kill() {
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    this.busy = false;
    this.requestQueue = [];
  }
}

// Singleton
export const llmSubprocess = new LlmSubprocessManager();
