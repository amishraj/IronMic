/**
 * Pretty-print a raw model id for UI display. Mirrors the main-process
 * helpers in CopilotAdapter and AIManager — duplicated rather than
 * cross-imported because main and renderer can't share a module cleanly.
 *   'openai/gpt-4o-mini'   -> 'gpt-4o-mini (openai)'
 *   'claude-haiku-4.5'     -> 'Claude Haiku 4.5'
 */
export function prettifyModelId(id: string): string {
  if (!id) return '';
  if (id.includes('/')) {
    const [vendor, name] = id.split('/');
    return `${name} (${vendor})`;
  }
  return id
    .split(/[-_]/)
    .map((p) => (p.length === 0 ? p : p[0].toUpperCase() + p.slice(1)))
    .join(' ');
}
