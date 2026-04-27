import { execFileSync } from 'child_process';
import type { ICLIAdapter, ParsedOutput, AIProvider, AIModel } from './types';
import { getSpawnEnv, resolveInShell } from '../utils/shell-env';

export class ClaudeAdapter implements ICLIAdapter {
  name: AIProvider = 'claude';

  async isInstalled(): Promise<boolean> {
    return (await this.getBinaryPath()) !== null;
  }

  async isAuthenticated(): Promise<boolean> {
    if (getSpawnEnv().ANTHROPIC_API_KEY) return true;

    const bin = await this.getBinaryPath();
    if (bin) {
      try {
        const result = execFileSync(bin, ['auth', 'status'], {
          encoding: 'utf-8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: getSpawnEnv(),
        });
        const text = result.toLowerCase();
        return !text.includes('not logged in') && !text.includes('no api key');
      } catch {
        // fall through to credential-file probe
      }
    }
    // Fallback: detect Claude credential files in the user's home dir.
    try {
      const fs = require('fs');
      const path = require('path');
      const home = process.env.HOME || process.env.USERPROFILE || '';
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

  async getVersion(): Promise<string | null> {
    const bin = await this.getBinaryPath();
    if (!bin) return null;
    try {
      const result = execFileSync(bin, ['--version'], {
        encoding: 'utf-8',
        timeout: 5000,
        env: getSpawnEnv(),
      });
      const match = result.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  async getBinaryPath(): Promise<string | null> {
    const resolved = await resolveInShell('claude');
    if (resolved) return resolved;

    // Electron on macOS/Linux may launch without the user's full PATH.
    // Check well-known locations before giving up.
    const { existsSync } = require('fs') as typeof import('fs');
    const candidates =
      process.platform === 'win32'
        ? [
            `${process.env.LOCALAPPDATA}\\Programs\\claude\\claude.exe`,
            `${process.env.APPDATA}\\npm\\claude.cmd`,
          ]
        : [
            '/opt/homebrew/bin/claude',
            '/usr/local/bin/claude',
            '/usr/bin/claude',
            `${process.env.HOME || ''}/.local/bin/claude`,
            `${process.env.HOME || ''}/bin/claude`,
            `${process.env.HOME || ''}/.volta/bin/claude`,
            `${process.env.HOME || ''}/.npm-global/bin/claude`,
          ];
    for (const p of candidates) {
      if (p && existsSync(p)) return p;
    }
    return null;
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
