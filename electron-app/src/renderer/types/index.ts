// Types matching the Rust N-API surface from CLAUDE.md

export interface Entry {
  id: string;
  createdAt: string;
  updatedAt: string;
  rawTranscript: string;
  polishedText: string | null;
  displayMode: 'raw' | 'polished';
  durationSeconds: number | null;
  sourceApp: string | null;
  isPinned: boolean;
  isArchived: boolean;
  tags: string | null; // JSON array string
}

export interface NewEntry {
  rawTranscript: string;
  polishedText: string | null;
  durationSeconds: number | null;
  sourceApp: string | null;
}

export interface EntryUpdate {
  rawTranscript?: string;
  polishedText?: string | null;
  displayMode?: 'raw' | 'polished';
  tags?: string | null;
}

export interface ListOptions {
  limit: number;
  offset: number;
  search?: string;
  archived?: boolean;
}

export interface TranscriptionResult {
  rawTranscript: string;
  polishedText: string | null;
  durationSeconds: number;
}

export interface ModelInfo {
  loaded: boolean;
  name: string;
  sizeBytes: number;
}

export interface ModelStatus {
  whisper: ModelInfo;
  llm: ModelInfo;
}

export type PipelineState = 'idle' | 'recording' | 'processing';

export type ViewMode = 'timeline' | 'editor';

// ── Analytics types ──

export type AnalyticsPeriod = 'today' | 'week' | 'month' | 'all_time';

export interface OverviewStats {
  total_words: number;
  total_sentences: number;
  total_entries: number;
  total_duration_seconds: number;
  avg_words_per_minute: number;
  unique_words: number;
  avg_sentence_length: number;
  period: string;
}

export interface DailySnapshot {
  date: string;
  word_count: number;
  sentence_count: number;
  entry_count: number;
  total_duration_seconds: number;
  unique_word_count: number;
  avg_sentence_length: number;
  avg_words_per_minute: number;
  source_app_breakdown: string | null;
  top_words: string | null;
  computed_at: string;
}

export interface TopicStat {
  topic: string;
  entry_count: number;
  word_count: number;
  percentage: number;
}

export interface TopicTrend {
  date: string;
  topic: string;
  count: number;
}

export interface StreakInfo {
  current_streak: number;
  longest_streak: number;
  last_active_date: string;
}

export interface ProductivityComparison {
  this_period_words: number;
  prev_period_words: number;
  change_percent: number;
  period_label: string;
}

export interface VocabularyRichness {
  ttr: number;
  unique_count: number;
  total_count: number;
}

// ── ML Feature types ──

export interface Notification {
  id: string;
  source: string;
  sourceId: string | null;
  notificationType: string;
  title: string;
  body: string | null;
  priority: number;
  createdAt: string;
  readAt: string | null;
  actedOnAt: string | null;
  dismissedAt: string | null;
  responseLatencyMs: number | null;
}

export interface Workflow {
  id: string;
  name: string | null;
  actionSequence: string;
  triggerPattern: string | null;
  confidence: number;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  isSaved: boolean;
  isDismissed: boolean;
}

export interface MeetingSession {
  id: string;
  startedAt: string;
  endedAt: string | null;
  speakerCount: number;
  summary: string | null;
  actionItems: string | null;
  totalDurationSeconds: number | null;
  entryIds: string | null;
}

export interface MLModelWeights {
  modelName: string;
  trainingSamples: number;
  version: number;
  trainedAt: string;
}

export type TurnDetectionMode = 'push-to-talk' | 'auto-detect' | 'always-listening';
export type VoiceRoute = 'dictation' | 'conversation' | 'command' | 'transcription';
export type VoiceState = 'speech' | 'silence' | 'unknown';

/** Prefix used to encode a user-visible note title inside the tags field.
 *  The renderer parses it out in parseTitleTag() and hides it from the
 *  standard tag-chip list so it doesn't appear as an ordinary tag. */
export const TITLE_TAG_PREFIX = '__title__:';
export const NOTEBOOK_TAG_PREFIX = '__notebook__:';
export const MEETING_TAG_PREFIX = '__meeting__:';
/** Lifecycle status — 'draft' when a note is being captured / in progress,
 *  'done' after the user explicitly finalizes it via the Done button. Used
 *  by NotesSidebar to render a yellow dot on drafts so users can tell at a
 *  glance which notes still need attention. */
export const STATUS_TAG_PREFIX = '__status__:';

export type NoteStatus = 'draft' | 'done';

// Helper to parse tags from JSON string.
// Filters out internal tag-prefix conventions (titles, notebook assignments,
// status) so those don't appear as user-visible chips.
export function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    const arr = JSON.parse(tags);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (s: string) =>
        typeof s === 'string' &&
        !s.startsWith(TITLE_TAG_PREFIX) &&
        !s.startsWith(NOTEBOOK_TAG_PREFIX) &&
        !s.startsWith(STATUS_TAG_PREFIX) &&
        !s.startsWith('__meeting__:'),
    );
  } catch {
    return [];
  }
}

/** Extract the status tag (draft | done). Entries with no status tag
 *  default to 'done' — every legacy entry was effectively finalized
 *  before this convention existed, so treating them as done is correct. */
export function parseStatusTag(tags: string | null): NoteStatus {
  if (!tags) return 'done';
  try {
    const arr = JSON.parse(tags);
    if (!Array.isArray(arr)) return 'done';
    const t = arr.find(
      (s: string) => typeof s === 'string' && s.startsWith(STATUS_TAG_PREFIX),
    );
    if (!t) return 'done';
    const value = (t as string).slice(STATUS_TAG_PREFIX.length);
    return value === 'draft' ? 'draft' : 'done';
  } catch {
    return 'done';
  }
}

/** Extract the embedded title tag (if any) from an entry's tags JSON. */
export function parseTitleTag(tags: string | null): string | null {
  if (!tags) return null;
  try {
    const arr = JSON.parse(tags);
    if (!Array.isArray(arr)) return null;
    const t = arr.find(
      (s: string) => typeof s === 'string' && s.startsWith(TITLE_TAG_PREFIX),
    );
    if (!t) return null;
    return (t as string).slice(TITLE_TAG_PREFIX.length);
  } catch {
    return null;
  }
}

/** Extract the linked meeting session id (if any) from an entry's tags JSON.
 *  Entries auto-generated by the meeting pipeline carry a __meeting__:<id>
 *  tag that points back to the session — used to make the entry and the
 *  meeting session behave as a single record (edits propagate both ways). */
export function parseMeetingTag(tags: string | null): string | null {
  if (!tags) return null;
  try {
    const arr = JSON.parse(tags);
    if (!Array.isArray(arr)) return null;
    const t = arr.find(
      (s: string) => typeof s === 'string' && s.startsWith(MEETING_TAG_PREFIX),
    );
    if (!t) return null;
    return (t as string).slice(MEETING_TAG_PREFIX.length);
  } catch {
    return null;
  }
}

/** Extract the embedded notebook-id tag (if any) from an entry's tags JSON. */
export function parseNotebookTag(tags: string | null): string | null {
  if (!tags) return null;
  try {
    const arr = JSON.parse(tags);
    if (!Array.isArray(arr)) return null;
    const t = arr.find(
      (s: string) => typeof s === 'string' && s.startsWith(NOTEBOOK_TAG_PREFIX),
    );
    if (!t) return null;
    return (t as string).slice(NOTEBOOK_TAG_PREFIX.length);
  } catch {
    return null;
  }
}

// Helper to stringify tags to JSON
export function stringifyTags(tags: string[]): string {
  return JSON.stringify(tags);
}
