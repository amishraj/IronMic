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
  availableModels(): AIModel[];
}

/** Extended adapter interface for CLI-based providers (Claude). */
export interface ICLIAdapter extends IAIAdapter {
  buildArgs(prompt: string, continueSession: boolean, model?: string): string[];
  parseOutput(data: string): ParsedOutput;
}

/** Extended adapter interface for HTTP-based providers (Copilot). */
export interface IHTTPAdapter extends IAIAdapter {
  sendMessageHTTP(
    messages: Array<{ role: string; content: string }>,
    model: string | undefined,
    onToken: (token: string) => void,
  ): Promise<string>;
}

export interface AIModel {
  id: string;
  label: string;
  provider: AIProvider;
  free: boolean;
  description: string;
}
