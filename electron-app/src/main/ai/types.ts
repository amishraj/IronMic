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

/** Extended adapter interface for CLI-based providers (Claude, Copilot). */
export interface ICLIAdapter extends IAIAdapter {
  buildArgs(prompt: string, continueSession: boolean, model?: AIModel | string): string[];
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
