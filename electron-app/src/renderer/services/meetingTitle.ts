/**
 * Single source of truth for meeting display titles.
 *
 * Multiple surfaces (the meetings card, the detail header, the auto-filed
 * Notes-sidebar entry) used to compute their title independently and would
 * disagree — the card showed `Meeting #4` while the linked Notes entry was
 * `Meeting 4/8/2026, 3:14:22 PM`. This helper is the only function that
 * resolves a meeting title; all surfaces call it so they stay in sync.
 *
 * Precedence:
 *   1. `structured.title` (if non-empty after trim) — user-typed OR
 *      AI-generated. The provenance lives in `structured.titleSource`.
 *   2. `Meeting #${structured.sequence}` if a positive integer.
 *   3. `${capitalize(detected_app)} Meeting` if `detected_app` is set
 *      (e.g. "Zoom Meeting").
 *   4. `'Meeting'` — never date-stamped. The card already shows the date
 *      separately as a subtitle, so we don't double up.
 */
export interface MeetingTitleSession {
  detected_app?: string | null;
}

export interface MeetingTitleStructured {
  title?: string | null;
  sequence?: number | null;
}

export function resolveMeetingTitle(
  session: MeetingTitleSession | null | undefined,
  structured: MeetingTitleStructured | null | undefined,
): string {
  const explicit = (structured?.title ?? '').trim();
  if (explicit) return explicit;

  const seq = structured?.sequence;
  if (typeof seq === 'number' && Number.isFinite(seq) && seq > 0) {
    return `Meeting #${seq}`;
  }

  const app = (session?.detected_app ?? '').trim();
  if (app) {
    return `${app.charAt(0).toUpperCase()}${app.slice(1)} Meeting`;
  }

  return 'Meeting';
}
