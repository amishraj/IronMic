import { execFileSync } from 'child_process';
import type { ICLIAdapter, ParsedOutput, AIProvider, AIModel } from './types';

/**
 * Build a process environment with common binary directories prepended to PATH.
 * Electron on macOS/Linux often launches with a minimal system PATH that
 * omits Homebrew, npm global, and other user-installed locations.
 */
function buildAugmentedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (process.platform !== 'win32') {
    const home = process.env.HOME || '';
    const extra = [
      '/opt/homebrew/bin',       // Apple Silicon Homebrew
      '/usr/local/bin',          // Intel Homebrew / manual installs
      `${home}/.local/bin`,
      `${home}/bin`,
      `${home}/.volta/bin`,      // Volta node version manager
      `${home}/.npm-global/bin`, // npm prefix override
    ].filter(Boolean);
    const current = (process.env.PATH || '').split(':');
    env.PATH = [...new Set([...extra, ...current])].join(':');
  }
  return env;
}

export class ClaudeAdapter implements ICLIAdapter {
  name: AIProvider = 'claude';

  async isInstalled(): Promise<boolean> {
    return (await this.getBinaryPath()) !== null;
  }

  async isAuthenticated(): Promise<boolean> {
    if (process.env.ANTHROPIC_API_KEY) return true;

    const bin = await this.getBinaryPath();
    if (bin) {
      try {
        const result = execFileSync(bin, ['auth', 'status'], {
          encoding: 'utf-8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: buildAugmentedEnv(),
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
        env: buildAugmentedEnv(),
      });
      const match = result.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  async getBinaryPath(): Promise<string | null> {
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    const augmentedEnv = buildAugmentedEnv();
    try {
      const out = execFileSync(lookup, ['claude'], {
        encoding: 'utf-8',
        timeout: 3000,
        env: augmentedEnv,
      });
      const first = out.split(/\r?\n/).find((line) => line.trim().length > 0);
      if (first) return first.trim();
    } catch { /* fall through to direct path probes */ }

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
