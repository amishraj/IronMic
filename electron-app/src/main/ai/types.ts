import type { ChildProcess } from 'child_process';

export type AIProvider = 'copilot' | 'claude' | 'local';

export interface AuthStatus {
  installed: boolean;
  authenticated: boolean;
  binaryPath: string | null;
  version: string | null;
  checkedAt: number;
}

export interface AIAuthState {
  copilot: AuthStatus;
  claude: AuthStatus;
  local: AuthStatus;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  provider?: AIProvider;
}

export interface ParsedOutput {
  type: 'text' | 'tool-use' | 'error' | 'status' | 'thinking';
  content: string;
}

/** Base adapter interface for all AI providers. */
export interface IAIAdapter {
  name: AIProvider;
  isInstalled(): Promise<boolean>;
  isAuthenticated(): Promise<boolean>;
  getVersion(): Promise<string | null>;
  getBinaryPath(): Promise<string | null>;
  /**
   * Cache-only: returns the most recently cached catalog, or a conservative
   * fallback. Must NOT spawn child processes. Use `refreshModels()` to probe.
   */
  listAvailableModels(): Promise<AIModel[]>;
  /** Optional: probe-and-refresh path. Defaults to listAvailableModels(). */
  refreshModels?(opts?: { force?: boolean }): Promise<AIModel[]>;
  /** Optional: invalidate any cached catalog so next refresh re-probes. */
  clearModelCache?(): void;
}

export type CliTransport = 'argv' | 'stdin';

/**
 * How an adapter wants its subprocess invoked for a given prompt.
 *
 * `transport: 'argv'` — prompt is embedded in `args`; stdin is closed immediately
 * after spawn (existing behavior, fine for small/safe prompts).
 *
 * `transport: 'stdin'` — prompt is NOT in `args`; AIManager writes `stdin` to the
 * child stdin then closes it. This is the safe path for large or
 * metacharacter-containing prompts that would otherwise hit Windows cmd.exe's
 * 8191-char limit or argv-quoting fragility.
 */
export interface CliInvocation {
  /** argv to pass to spawn. For stdin transport, prompt is NOT in args. */
  args: string[];
  /** When set, piped to child stdin then stdin closed. */
  stdin?: string;
  /** Transport the adapter chose. Carried through so AIManager can log without re-inferring. */
  transport: CliTransport;
  /**
   * Free-form backend label for logging only (e.g. 'copilot-cli', 'gh-models',
   * 'claude'). Provider-neutral — this generic interface must not import
   * Copilot-specific enums.
   */
  backendLabel?: string;
}

/** Extended adapter interface for CLI-based providers (Claude, Copilot). */
export interface ICLIAdapter extends IAIAdapter {
  buildArgs(prompt: string, continueSession: boolean, model?: AIModel | string): string[];
  /**
   * Choose an invocation shape (argv vs stdin) for the given prompt. Async
   * because some adapters lazily probe the CLI's capabilities before deciding.
   * AIManager calls this in place of `buildArgs` for all production spawn paths.
   */
  buildInvocation(
    binaryPath: string,
    prompt: string,
    continueSession: boolean,
    model?: AIModel | string,
  ): Promise<CliInvocation>;
  parseOutput(data: string): ParsedOutput;
}

export interface AIModelRunIds {
  /** Run-id passed to `copilot --model <id>` (unprefixed, e.g. 'claude-haiku-4.5'). */
  copilotCli?: string;
  /** Run-id passed to `gh models run <id>` (provider-prefixed, e.g. 'openai/gpt-4.1'). */
  ghModels?: string;
}

export interface AIModel {
  /**
   * Stable internal key persisted in the `ai_model` setting.
   *
   * For Copilot dynamic entries we use the raw backend run-id directly
   * ('claude-haiku-4.5' for copilot-cli, 'openai/gpt-4.1' for gh-models)
   * so saved selections survive app restart even when the in-memory
   * runIds map is empty.
   */
  id: string;
  label: string;
  provider: AIProvider;
  /** Origin of the entry. Optional — Claude='static', Local='local', Copilot='cli'|'curated'|'fallback'. */
  source?: 'cli' | 'fallback' | 'static' | 'local' | 'curated';
  /** Replaces the previous `free: boolean`. 'unknown' for dynamically discovered models. */
  billing?: 'free' | 'paid' | 'unknown';
  description?: string;
  runIds?: AIModelRunIds;
}
