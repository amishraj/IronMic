import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

type CliProvider = 'copilot' | 'claude' | 'local';

let cachedEnv: NodeJS.ProcessEnv | null = null;

const BASE_KEYS = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR',
  'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'HOMEDRIVE', 'HOMEPATH', 'SYSTEMROOT', 'SYSTEMDRIVE',
  'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'WINDIR',
  'SSH_AUTH_SOCK',
];

const PROVIDER_KEYS: Record<CliProvider, string[]> = {
  copilot: ['GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_ASKPASS', 'COPILOT_CUSTOM_INSTRUCTIONS_DIRS'],
  claude: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_MODEL', 'ENABLE_TOOL_SEARCH'],
  local: [],
};

function withCommonPathDirs(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform === 'win32') return { ...env };

  const home = env.HOME || process.env.HOME || '';
  const extra = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${home}/.local/bin`,
    `${home}/bin`,
    `${home}/.volta/bin`,
    `${home}/.npm-global/bin`,
  ].filter(Boolean);
  const current = (env.PATH || process.env.PATH || '').split(':').filter(Boolean);
  return { ...env, PATH: [...new Set([...extra, ...current])].join(':') };
}

/**
 * Capture the user's login-shell PATH once. Electron desktop launches often
 * miss Homebrew/npm/Volta paths, especially on macOS.
 */
export async function initShellEnv(): Promise<void> {
  if (cachedEnv) return;

  if (process.platform === 'win32') {
    cachedEnv = withCommonPathDirs({ ...process.env });
    return;
  }

  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const { stdout } = await execFileAsync(shell, ['-l', '-c', 'printf %s "$PATH"'], {
      timeout: 8000,
      env: process.env,
    });
    cachedEnv = withCommonPathDirs({ ...process.env, PATH: stdout.trim() || process.env.PATH });
  } catch {
    cachedEnv = withCommonPathDirs({ ...process.env });
  }
}

export function getSpawnEnv(): NodeJS.ProcessEnv {
  return cachedEnv ?? withCommonPathDirs({ ...process.env });
}

export function getScopedSpawnEnv(provider: CliProvider): NodeJS.ProcessEnv {
  const source = getSpawnEnv();
  const env: NodeJS.ProcessEnv = { TERM: 'dumb' };

  for (const key of BASE_KEYS) {
    if (source[key]) env[key] = source[key];
  }
  for (const key of PROVIDER_KEYS[provider]) {
    if (source[key]) env[key] = source[key];
  }

  return env;
}

export async function resolveInShell(name: string): Promise<string | null> {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return null;

  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('where', [name], {
        timeout: 5000,
        env: getSpawnEnv(),
      });
      return stdout.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() || null;
    } catch {
      return null;
    }
  }

  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const { stdout } = await execFileAsync(shell, ['-l', '-c', 'command -v "$1"', 'sh', name], {
      timeout: 8000,
      env: getSpawnEnv(),
    });
    const line = stdout.split(/\r?\n/).find((entry) => entry.trim().length > 0)?.trim();
    return line && line.startsWith('/') ? line : null;
  } catch {
    return null;
  }
}
