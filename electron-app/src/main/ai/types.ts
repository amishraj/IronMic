import type { ChildProcess } from 'child_process';

export type AIProvider = 'copilot' | 'claude';

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

export interface ICLIAdapter {
  name: AIProvider;
  isInstalled(): Promise<boolean>;
  isAuthenticated(): Promise<boolean>;
  getVersion(): Promise<string | null>;
  getBinaryPath(): Promise<string | null>;
  buildArgs(prompt: string, continueSession: boolean, model?: string): string[];
  parseOutput(data: string): ParsedOutput;
  availableModels(): AIModel[];
}

export interface AIModel {
  id: string;
  label: string;
  provider: AIProvider;
  free: boolean;
  description: string;
}
