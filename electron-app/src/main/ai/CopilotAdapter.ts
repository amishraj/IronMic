import { execSync, execFile } from 'child_process';
import type { ICLIAdapter, ParsedOutput, AIProvider } from './types';

export class CopilotAdapter implements ICLIAdapter {
  name: AIProvider = 'copilot';

  async isInstalled(): Promise<boolean> {
    try {
      const path = await this.getBinaryPath();
      return path !== null;
    } catch {
      return false;
    }
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      // Check env vars first
      if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return true;

      // Check gh auth status
      const result = execSync('gh auth status 2>&1', {
        encoding: 'utf-8',
        timeout: 5000,
        shell: process.env.SHELL || '/bin/zsh',
      });
      return result.includes('Logged in');
    } catch {
      return false;
    }
  }

  async getVersion(): Promise<string | null> {
    try {
      const result = execSync('gh copilot --version 2>/dev/null || gh --version 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 5000,
        shell: process.env.SHELL || '/bin/zsh',
      });
      const match = result.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  async getBinaryPath(): Promise<string | null> {
    try {
      const result = execSync('which gh 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 3000,
        shell: process.env.SHELL || '/bin/zsh',
      });
      return result.trim() || null;
    } catch {
      return null;
    }
  }

  buildArgs(prompt: string, _continueSession: boolean): string[] {
    return ['copilot', 'suggest', '-t', 'shell', prompt];
  }

  parseOutput(data: string): ParsedOutput {
    const trimmed = data.trim();
    if (!trimmed) return { type: 'text', content: '' };
    if (trimmed.startsWith('Error') || trimmed.startsWith('error')) {
      return { type: 'error', content: trimmed };
    }
    return { type: 'text', content: trimmed };
  }
}
