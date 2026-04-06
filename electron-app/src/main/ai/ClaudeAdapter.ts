import { execSync } from 'child_process';
import type { ICLIAdapter, ParsedOutput, AIProvider, AIModel } from './types';

export class ClaudeAdapter implements ICLIAdapter {
  name: AIProvider = 'claude';

  async isInstalled(): Promise<boolean> {
    const path = await this.getBinaryPath();
    return path !== null;
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      // Check env var first
      if (process.env.ANTHROPIC_API_KEY) return true;

      // Try claude auth status
      const result = execSync('claude auth status 2>&1', {
        encoding: 'utf-8',
        timeout: 5000,
        shell: process.env.SHELL || '/bin/zsh',
      });
      return !result.toLowerCase().includes('not logged in') && !result.toLowerCase().includes('no api key');
    } catch {
      // If the command fails, check for credential files
      try {
        const fs = require('fs');
        const path = require('path');
        const home = process.env.HOME || '';
        const credPaths = [
          path.join(home, '.claude', '.credentials.json'),
          path.join(home, '.claude', 'credentials.json'),
          path.join(home, '.claude', 'auth.json'),
        ];
        return credPaths.some((p: string) => fs.existsSync(p));
      } catch {
        return false;
      }
    }
  }

  async getVersion(): Promise<string | null> {
    try {
      const result = execSync('claude --version 2>/dev/null', {
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
      const result = execSync('which claude 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 3000,
        shell: process.env.SHELL || '/bin/zsh',
      });
      return result.trim() || null;
    } catch {
      return null;
    }
  }

  buildArgs(prompt: string, continueSession: boolean, model?: string): string[] {
    const args: string[] = [];
    if (model) args.push('--model', model);
    if (continueSession) args.push('--continue');
    args.push('--print', prompt);
    return args;
  }

  availableModels(): AIModel[] {
    return [
      { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', provider: 'claude', free: false, description: 'Best balance of speed and capability' },
      { id: 'claude-opus-4-20250514', label: 'Claude Opus 4', provider: 'claude', free: false, description: 'Most capable, slower' },
      { id: 'claude-haiku-3-5-20241022', label: 'Claude Haiku 3.5', provider: 'claude', free: false, description: 'Fastest and most affordable' },
    ];
  }

  parseOutput(data: string): ParsedOutput {
    const trimmed = data.trim();
    if (!trimmed) return { type: 'text', content: '' };

    // Detect thinking blocks
    if (trimmed.startsWith('<thinking>') || trimmed.startsWith('Thinking...')) {
      return { type: 'thinking', content: trimmed };
    }

    // Detect tool use
    if (trimmed.includes('Tool:') || trimmed.includes('Running:')) {
      return { type: 'tool-use', content: trimmed };
    }

    // Detect errors
    if (trimmed.startsWith('Error') || trimmed.startsWith('error')) {
      return { type: 'error', content: trimmed };
    }

    return { type: 'text', content: trimmed };
  }
}
