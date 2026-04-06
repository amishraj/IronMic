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

// Helper to parse tags from JSON string
export function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    return JSON.parse(tags);
  } catch {
    return [];
  }
}

// Helper to stringify tags to JSON
export function stringifyTags(tags: string[]): string {
  return JSON.stringify(tags);
}
