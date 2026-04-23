/**
 * Notebooks — a lightweight grouping layer on top of the existing entries
 * table, with NO schema changes required in the Rust core.
 *
 * Storage model:
 *   - Notebook metadata (id, name, createdAt) lives in the `settings` table
 *     under a single key `notebooks` as a JSON array. Cheap, atomic, and
 *     survives migrations trivially.
 *   - Entry→notebook association is encoded in the entry's `tags` field as
 *     a hidden tag: `__notebook__:<notebookId>`. `parseTags()` already
 *     filters these hidden tags out of the user-visible chip list.
 *   - A seeded default notebook (`id: 'default'`, name: 'My Notes') is
 *     ensured on first read.
 *
 * This approach lets us ship the feature TODAY without a Rust rebuild.
 * When/if we want first-class notebooks, a future migration can promote
 * these rows into a proper `notebooks` table.
 */

import { NOTEBOOK_TAG_PREFIX, MEETING_TAG_PREFIX, TITLE_TAG_PREFIX, STATUS_TAG_PREFIX, parseMeetingTag } from '../types';

export interface Notebook {
  id: string;
  name: string;
  createdAt: string; // ISO
}

const NOTEBOOKS_SETTING_KEY = 'notebooks';
const DEFAULT_NOTEBOOK: Notebook = {
  id: 'default',
  name: 'My Notes',
  createdAt: new Date('2000-01-01T00:00:00Z').toISOString(),
};

/** Load all notebooks. Seeds the default on first read. */
export async function listNotebooks(): Promise<Notebook[]> {
  const api = window.ironmic;
  let raw: string | null = null;
  try { raw = await api.getSetting(NOTEBOOKS_SETTING_KEY); }
  catch { /* fall through */ }

  let list: Notebook[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        list = parsed.filter(
          (n: any) =>
            n &&
            typeof n.id === 'string' &&
            typeof n.name === 'string' &&
            typeof n.createdAt === 'string',
        );
      }
    } catch { /* malformed — reset */ }
  }

  // Ensure both built-in notebooks exist. We seed Meeting Notes here (not
  // just in ensureMeetingNotesNotebook) so entries filed there are never
  // shown as "Unfiled" even on the first app session before any meeting runs.
  let needsWrite = false;
  if (!list.some(n => n.id === DEFAULT_NOTEBOOK.id)) {
    list.unshift({ ...DEFAULT_NOTEBOOK });
    needsWrite = true;
  }
  const MEETING_BUILTIN: Notebook = {
    id: 'meeting-notes',
    name: 'Meeting Notes',
    createdAt: new Date('2000-01-02T00:00:00Z').toISOString(),
  };
  if (!list.some(n => n.id === MEETING_BUILTIN.id)) {
    list.push({ ...MEETING_BUILTIN });
    needsWrite = true;
  }
  if (needsWrite) {
    try { await api.setSetting(NOTEBOOKS_SETTING_KEY, JSON.stringify(list)); }
    catch { /* ignore — we'll retry on next call */ }
  }

  return list;
}

/** Create a notebook and persist. Returns the new notebook. */
export async function createNotebook(name: string): Promise<Notebook> {
  const api = window.ironmic;
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Notebook name cannot be empty');
  const current = await listNotebooks();
  const nb: Notebook = {
    id: `nb-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    name: trimmed,
    createdAt: new Date().toISOString(),
  };
  const next = [...current, nb];
  await api.setSetting(NOTEBOOKS_SETTING_KEY, JSON.stringify(next));
  return nb;
}

/** Delete a notebook (entries remain; their tag is orphaned but harmless). */
export async function deleteNotebook(id: string): Promise<void> {
  if (id === DEFAULT_NOTEBOOK.id) {
    throw new Error('Cannot delete the default notebook');
  }
  const api = window.ironmic;
  const current = await listNotebooks();
  const next = current.filter(n => n.id !== id);
  await api.setSetting(NOTEBOOKS_SETTING_KEY, JSON.stringify(next));
}

/**
 * Create a new entry with the given text, assigning it to the given
 * notebook and setting a title tag. Used by the "Add to notebook" action
 * on the meeting page — the AI summary becomes a fresh note in that
 * notebook so the user can find it alongside their regular notes.
 *
 * Returns the created entry id.
 */
export async function addTextAsEntryToNotebook(params: {
  notebookId: string;
  title: string;
  plainText: string;
  sourceApp?: string;
}): Promise<string> {
  const api = window.ironmic;
  // Filed notes coming in from meeting-export are already finalized by the
  // time they land here — stamp them 'done' so the sidebar shows them without
  // a draft indicator.
  const tagsArr = [
    `__title__:${params.title}`,
    `${NOTEBOOK_TAG_PREFIX}${params.notebookId}`,
    `__status__:done`,
  ];
  const entry = await api.createEntry({
    rawTranscript: params.plainText,
    polishedText: undefined,
    durationSeconds: undefined,
    sourceApp: params.sourceApp ?? 'meeting-export',
    tags: JSON.stringify(tagsArr),
  } as any);
  notifyEntriesChanged();
  return (entry as any).id;
}

/** Dispatches a window-level event that NotesSidebar (and anything else) can
 *  listen to in order to refresh its view of entries. Called by every helper
 *  in this file that mutates entries so the UI stays in sync without manual
 *  polling. Use `window.dispatchEvent(new CustomEvent('ironmic:entries-changed'))`
 *  directly elsewhere if it's more convenient — they converge to the same
 *  listener. */
function notifyEntriesChanged(): void {
  try { window.dispatchEvent(new CustomEvent('ironmic:entries-changed')); }
  catch { /* noop */ }
}

export function getDefaultNotebookId(): string { return DEFAULT_NOTEBOOK.id; }

// ── Meeting Notes notebook ─────────────────────────────────────────────────

const MEETING_NOTES_NOTEBOOK_ID = 'meeting-notes';
const MEETING_NOTES_NOTEBOOK_NAME = 'Meeting Notes';

/**
 * Ensure the built-in "Meeting Notes" notebook exists. This is the destination
 * where every AI-finalized meeting summary gets filed so the user can always
 * find meeting outputs alongside their regular notes — and so the AI assistant
 * can query "what happened in last week's retro" against a single corpus.
 */
export async function ensureMeetingNotesNotebook(): Promise<Notebook> {
  const api = window.ironmic;
  const current = await listNotebooks();
  const existing = current.find((n) => n.id === MEETING_NOTES_NOTEBOOK_ID);
  if (existing) return existing;
  const nb: Notebook = {
    id: MEETING_NOTES_NOTEBOOK_ID,
    name: MEETING_NOTES_NOTEBOOK_NAME,
    createdAt: new Date('2000-01-02T00:00:00Z').toISOString(),
  };
  const next = [...current, nb];
  await api.setSetting(NOTEBOOKS_SETTING_KEY, JSON.stringify(next));
  return nb;
}

export function getMeetingNotesNotebookId(): string { return MEETING_NOTES_NOTEBOOK_ID; }

/**
 * Resolve the canonical notebook entry for a given meeting session by scanning
 * recent entries for the __meeting__:<sessionId> tag. This is the robust way
 * to find the entry — it doesn't depend on `notebookEntryId` being persisted
 * in structured_output (which can get lost or never be written on legacy
 * meetings). Returns the first match (there should only ever be one), or null.
 */
export async function findMeetingEntryBySessionId(sessionId: string): Promise<any | null> {
  const api = window.ironmic;
  try {
    // 500 is generous — covers a very active user's entire history. If this
    // becomes a scaling issue we can switch to a dedicated lookup API.
    const entries = await api.listEntries({ limit: 500, offset: 0, archived: false });
    for (const e of entries as any[]) {
      const linkedSession = parseMeetingTag(e.tags);
      if (linkedSession === sessionId) return e;
    }
  } catch (err) {
    console.warn('[notebooks] findMeetingEntryBySessionId failed:', err);
  }
  return null;
}

/**
 * Propagate an edit made to a meeting-linked notebook entry BACK into the
 * source meeting session's structured_output, so the Meeting detail page
 * reflects the change. Without this, the entry and the meeting record drift
 * apart — user edits in Notes would not appear on the Meetings page.
 *
 * No-op if the session can't be resolved. Silent-fail on write errors: we'd
 * rather the entry edit still succeed than block the user on a sync problem.
 */
export async function syncMeetingEntryToSession(params: {
  sessionId: string;
  plainText?: string;
  title?: string;
}): Promise<void> {
  const api = window.ironmic;
  try {
    const raw = await api.meetingGet(params.sessionId);
    if (!raw) return;
    let session: any;
    try { session = JSON.parse(raw); } catch { return; }
    let existing: any = {};
    if (session?.structured_output) {
      try { existing = JSON.parse(session.structured_output) || {}; }
      catch { /* start fresh */ }
    }
    const updated: any = { ...existing };
    if (params.title !== undefined) {
      updated.title = params.title.trim() || existing.title;
    }
    if (params.plainText !== undefined) {
      updated.plainSummary = params.plainText;
      // Mirror into the first section so the Notes panel renders the same text.
      const sections: any[] = Array.isArray(existing.sections) && existing.sections.length > 0
        ? existing.sections.slice()
        : [{ key: 'summary', title: 'Summary', content: '' }];
      sections[0] = { ...sections[0], content: params.plainText };
      updated.sections = sections;
      updated.hasUserEdits = true;
    }
    await api.meetingSetStructuredOutput(params.sessionId, JSON.stringify(updated));
  } catch (err) {
    console.warn('[notebooks] syncMeetingEntryToSession failed:', err);
  }
}

/**
 * Upsert the "Meeting Notes" entry for a session. Creates on first call,
 * updates in place on regenerate so we don't stack duplicate notebook entries
 * every time the user regenerates the summary.
 *
 * Returns the entry id, which the caller should persist into the session's
 * structured_output.notebookEntryId so the next call can find it.
 */
export async function upsertMeetingNoteEntry(params: {
  existingEntryId?: string | null;
  sessionId: string;
  title: string;
  plainText: string;
}): Promise<string> {
  const api = window.ironmic;
  await ensureMeetingNotesNotebook();
  const title = params.title?.trim() || `Meeting ${new Date().toLocaleString()}`;

  // Resolve the target entry. Order:
  //  1) caller-provided id (fast path, typical)
  //  2) scan by __meeting__:<sessionId> tag — auto-heals cases where
  //     notebookEntryId was never persisted OR where an older entry exists
  //     without the correct __notebook__ tag (was showing as "Unfiled").
  //  3) create fresh
  let targetId: string | null = null;
  let existingTags: string[] = [];

  const tryAdopt = async (id: string): Promise<boolean> => {
    try {
      const fresh = await api.getEntry(id);
      if (!fresh) return false;
      try {
        const parsed = JSON.parse((fresh as any).tags || '[]');
        if (Array.isArray(parsed)) existingTags = parsed.filter((s: any) => typeof s === 'string');
      } catch { /* ignore */ }
      targetId = id;
      return true;
    } catch { return false; }
  };

  if (params.existingEntryId) { await tryAdopt(params.existingEntryId); }
  if (!targetId) {
    const found = await findMeetingEntryBySessionId(params.sessionId);
    if (found?.id) { await tryAdopt(found.id); }
  }

  // Build the tag set: always stamp title/notebook/meeting, PRESERVE any
  // non-conflicting tags (user tags, status if the entry is a live draft).
  // Status defaults to 'done' only if the entry didn't carry one — prevents
  // clobbering a draft status during a live-summary upsert.
  const existingStatus = existingTags.find(s => s.startsWith(STATUS_TAG_PREFIX));
  const preserved = existingTags.filter(s =>
    !s.startsWith(TITLE_TAG_PREFIX) &&
    !s.startsWith(NOTEBOOK_TAG_PREFIX) &&
    !s.startsWith(MEETING_TAG_PREFIX) &&
    !s.startsWith(STATUS_TAG_PREFIX),
  );
  const tagsArr = [
    ...preserved,
    `${TITLE_TAG_PREFIX}${title}`,
    `${NOTEBOOK_TAG_PREFIX}${MEETING_NOTES_NOTEBOOK_ID}`,
    `${MEETING_TAG_PREFIX}${params.sessionId}`,
    existingStatus || `${STATUS_TAG_PREFIX}done`,
  ];
  const tagsJson = JSON.stringify(tagsArr);

  if (targetId) {
    await api.updateEntry(targetId, {
      rawTranscript: params.plainText,
      tags: tagsJson,
    } as any);
    notifyEntriesChanged();
    return targetId;
  }

  const entry = await api.createEntry({
    rawTranscript: params.plainText,
    polishedText: undefined,
    durationSeconds: undefined,
    sourceApp: 'meeting-auto',
    tags: tagsJson,
  } as any);
  notifyEntriesChanged();
  return (entry as any).id;
}
