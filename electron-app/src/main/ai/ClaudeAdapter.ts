import { execFileSync } from 'child_process';
import type { ICLIAdapter, ParsedOutput, AIProvider, AIModel, CliInvocation } from './types';
import { getSpawnEnv, resolveInShell } from '../utils/shell-env';

/**
 * Argv-eligibility ceiling for Claude. Same rationale as Copilot: keeps the
 * spawn within Windows cmd.exe's 8191-char limit (for .cmd shims) and avoids
 * argv-quoting fragility for multiline / metacharacter content.
 */
const CLAUDE_ARGV_SIZE_LIMIT = 4096;

function claudeArgvEligible(binaryPath: string, prompt: string): boolean {
  if (prompt.length > CLAUDE_ARGV_SIZE_LIMIT) return false;
  const wrapsViaCmd =
    process.platform === 'win32' &&
    (/\.cmd$/i.test(binaryPath) || !/\.[a-z]+$/i.test(binaryPath));
  if (wrapsViaCmd && /[\n\r&|<>^"]/.test(prompt)) return false;
  return true;
}

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

  buildArgs(prompt: string, continueSession: boolean, model?: AIModel | string): string[] {
    const args: string[] = [];
    const modelId = typeof model === 'object' ? model.id : model;
    if (modelId) args.push('--model', modelId);
    if (continueSession) args.push('--continue');
    args.push('--print', prompt);
    return args;
  }

  /**
   * Claude CLI accepts the prompt either positionally after `--print` or via
   * stdin when `--print` is the final flag. Preserve the documented option
   * ordering (`--model id --continue --print [prompt]`) so the parser never
   * sees a prompt argument before its option flags.
   */
  async buildInvocation(
    binaryPath: string,
    prompt: string,
    continueSession: boolean,
    model?: AIModel | string,
  ): Promise<CliInvocation> {
    const modelId = typeof model === 'object' ? model.id : model;
    const baseArgs: string[] = [];
    if (modelId) baseArgs.push('--model', modelId);
    if (continueSession) baseArgs.push('--continue');
    baseArgs.push('--print');

    if (claudeArgvEligible(binaryPath, prompt)) {
      return {
        args: [...baseArgs, prompt],
        transport: 'argv',
        backendLabel: 'claude',
      };
    }
    return {
      args: baseArgs,
      stdin: prompt,
      transport: 'stdin',
      backendLabel: 'claude',
    };
  }

  async listAvailableModels(): Promise<AIModel[]> {
    return [
      { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', provider: 'claude', source: 'static', billing: 'paid', description: 'Best balance of speed and capability' },
      { id: 'claude-opus-4-20250514', label: 'Claude Opus 4', provider: 'claude', source: 'static', billing: 'paid', description: 'Most capable, slower' },
      // Haiku model id format: Anthropic's dated ids use the pattern
      // `claude-{version}-{family}-{YYYYMMDD}`, so Haiku 3.5 is
      // `claude-3-5-haiku-20241022` — NOT `claude-haiku-3-5-20241022`
      // (that bogus reordering was the source of the "selected model
      // doesn't exist" CLI rejection). Listing the alias `claude-haiku-4-5`
      // alongside so users can pick the newer fast model that matches
      // the Sonnet 4 / Opus 4 generation above.
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'claude', source: 'static', billing: 'paid', description: 'Fastest and most affordable' },
      { id: 'claude-3-5-haiku-20241022', label: 'Claude Haiku 3.5', provider: 'claude', source: 'static', billing: 'paid', description: 'Previous-gen fast model' },
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
