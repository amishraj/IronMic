import { execSync } from 'child_process';
import type { ICLIAdapter, ParsedOutput, AIProvider, AIModel } from './types';

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

  buildArgs(prompt: string, _continueSession: boolean, model?: string): string[] {
    // gh copilot uses models via --model flag in newer versions
    const args = ['copilot', 'suggest', '-t', 'shell'];
    if (model) args.push('--model', model);
    args.push(prompt);
    return args;
  }

  availableModels(): AIModel[] {
    return [
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', provider: 'copilot', free: true, description: 'Free with GitHub — fast and capable' },
      { id: 'gpt-4.1', label: 'GPT-4.1', provider: 'copilot', free: false, description: 'Most capable GPT model' },
      { id: 'gpt-4o', label: 'GPT-4o', provider: 'copilot', free: false, description: 'Multimodal, fast' },
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini', provider: 'copilot', free: true, description: 'Lightweight and free' },
      { id: 'o3-mini', label: 'o3-mini', provider: 'copilot', free: false, description: 'Advanced reasoning' },
      { id: 'claude-sonnet-4', label: 'Claude Sonnet 4', provider: 'copilot', free: false, description: 'Anthropic via GitHub Models' },
    ];
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
