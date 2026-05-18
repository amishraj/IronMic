import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Clock, Users, ChevronDown, ChevronRight, Pencil, Save, X, Loader2, RefreshCw, History, Mic, MicOff, Volume2, Pause, Play, Users as UsersIcon, Sparkles } from 'lucide-react';
import { type Editor } from '@tiptap/react';
import { MeetingTranscriptPanel, type TranscriptSegment } from './MeetingTranscriptPanel';
import { MeetingNotesPanel } from './MeetingNotesPanel';
import { MeetingRegenerateModal, type EditsDisposition } from './MeetingRegenerateModal';
import { MeetingVersionsDrawer } from './MeetingVersionsDrawer';
import { RichTextEditorShell } from './RichTextEditorShell';
import { NotesCollaborateModal } from './NotesCollaborateModal';
import type { MeetingTemplate, StructuredMeetingOutput } from '../services/tfjs/MeetingTemplateEngine';
import {
  generateMeetingSummary,
  appendVersion,
  restoreVersion,
  type StructuredOutput,
  type VersionEntry,
} from '../services/meeting/SummaryGenerator';
import { useMeetingStore } from '../stores/useMeetingStore';
import { useTtsStore } from '../stores/useTtsStore';
import { upsertMeetingNoteEntry } from '../services/notebooks';
import { resolveMeetingTitle } from '../services/meetingTitle';
import { generateMeetingTitle } from '../services/meeting/SummaryGenerator';
import { textToHtml, htmlToText, isHtmlEmpty } from '../services/tiptapText';

interface MeetingSession {
  id: string;
  started_at: string;
  ended_at?: string;
  speaker_count: number;
  summary?: string;
  total_duration_seconds?: number;
  structured_output?: string;
  detected_app?: string;
}

interface Props {
  sessionId: string;
  onBack: () => void;
  onUpdated?: () => void;
}

export function MeetingDetailPage({ sessionId, onBack, onUpdated }: Props) {
  const [session, setSession] = useState<MeetingSession | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftSummary, setDraftSummary] = useState('');
  /** TipTap-formatted HTML being edited. Seeded from `htmlContent` (if the
   *  user previously saved with formatting) or by promoting `plainSummary`
   *  via `textToHtml` so paragraph breaks survive. Plain text is derived
   *  from this on save — `draftSummary` is just a cached mirror used by
   *  the unsaved-edits diff. */
  const [editingHtml, setEditingHtml] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [collabOpen, setCollabOpen] = useState(false);
  /** Local dictate-append state — scoped to this editor instance, NOT
   *  global. Avoids the NoteEditor pattern of "fetch latest entry on
   *  pipeline-idle" which would inject the wrong content into the wrong
   *  surface. We capture the audio buffer ourselves and insert at cursor. */
  const [dictateState, setDictateState] = useState<'idle' | 'recording' | 'processing'>('idle');
  const editorRef = useRef<Editor | null>(null);
  const processingMeetings = useMeetingStore(s => s.processingMeetings);
  const transcribingMeetings = useMeetingStore(s => s.transcribingMeetings);
  const markMeetingProcessing = useMeetingStore(s => s.markMeetingProcessing);
  const unmarkMeetingProcessing = useMeetingStore(s => s.unmarkMeetingProcessing);
  const patchSession = useMeetingStore(s => s.patchSession);
  const templates = useMeetingStore(s => s.templates);
  const loadTemplates = useMeetingStore(s => s.loadTemplates);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const raw = await window.ironmic.meetingGet(sessionId);
        if (cancelled) return;
        const s = JSON.parse(raw) as MeetingSession;
        setSession(s);
        setDraftSummary(extractEditableSummary(s));
        setDraftTitle(extractRawTitle(s));
        setEditingHtml(extractEditableHtml(s));
      } catch (err) {
        console.error('[MeetingDetailPage] Failed to load session:', err);
      }

      try {
        const rawSegs = await window.ironmic.listTranscriptSegments(sessionId);
        if (cancelled) return;
        const segs = JSON.parse(rawSegs) as TranscriptSegment[];
        setSegments(segs);
      } catch {
        if (!cancelled) setSegments([]);
      }
    };

    load();
    if (templates.length === 0) void loadTemplates();

    const poll = setInterval(() => {
      if (processingMeetings.includes(sessionId)) load();
    }, 2000);

    // Reload the session whenever an entries-changed event fires — this covers
    // edits made in the Notes sidebar (DictatePage dispatches entries-changed
    // after syncing the meeting session via syncMeetingEntryToSession, so the
    // freshly-fetched session already has the updated content).
    const onEntriesChanged = () => {
      if (editing) return; // don't clobber a local draft in progress
      void load();
    };
    window.addEventListener('ironmic:entries-changed', onEntriesChanged);

    // Subscribe to end-of-meeting speaker-label patches. The main process
    // emits this once at stop after AHC refinement (+ optional LLM
    // roster-rename). Patches arrive even when this page is the active
    // view at meeting-stop time, so we mutate `segments` in place rather
    // than triggering a DB re-fetch. Empty `patches` means refinement
    // ran but produced no changes — no UI update needed.
    interface RelabelPayload {
      sessionId: string;
      patches: Array<{ segmentId: string; newLabel: string }>;
    }
    const unsubRelabel: (() => void) | undefined =
      window.ironmic.onMeetingSegmentsRelabeled?.((payload: RelabelPayload) => {
        if (!payload || payload.sessionId !== sessionId) return;
        if (!Array.isArray(payload.patches) || payload.patches.length === 0) return;
        const byId = new Map<string, string>(
          payload.patches.map(p => [p.segmentId, p.newLabel] as const),
        );
        setSegments(prev =>
          prev.map(seg => {
            const next = byId.get(seg.id);
            return next ? { ...seg, speaker_label: next } : seg;
          }),
        );
      });

    return () => {
      cancelled = true;
      clearInterval(poll);
      window.removeEventListener('ironmic:entries-changed', onEntriesChanged);
      if (typeof unsubRelabel === 'function') unsubRelabel();
    };
  }, [sessionId, processingMeetings, editing]);

  function extractEditableSummary(s: MeetingSession): string {
    if (s.structured_output) {
      try {
        const parsed = JSON.parse(s.structured_output);
        if (parsed.plainSummary) return parsed.plainSummary;
        if (parsed.sections && parsed.sections.length > 0) {
          return parsed.sections
            .map((sec: any) => `## ${sec.title}\n${sec.content}`)
            .join('\n\n');
        }
      } catch { /* fallthrough */ }
    }
    return s.summary ?? '';
  }

  /** TipTap-formatted HTML to seed the editor. Prefers a previously
   *  saved `htmlContent` (preserves user formatting like bold + lists);
   *  falls back to promoting the plain summary so paragraph breaks survive
   *  the round-trip. Used only by the load effect — the editor itself
   *  drives `editingHtml` while editing. */
  function extractEditableHtml(s: MeetingSession): string {
    if (s.structured_output) {
      try {
        const parsed = JSON.parse(s.structured_output);
        if (typeof parsed?.htmlContent === 'string' && parsed.htmlContent.trim()) {
          return parsed.htmlContent;
        }
      } catch { /* ignore */ }
    }
    return textToHtml(extractEditableSummary(s));
  }

  /** Display title for the header — always a non-empty string. Falls
   *  through `Meeting #N` → detected-app → `Meeting`. Single source of
   *  truth lives in services/meetingTitle.ts so this stays in sync with
   *  the meetings card and the auto-filed Notes-sidebar entry. */
  function extractTitle(s: MeetingSession): string {
    let parsed: any = null;
    if (s.structured_output) {
      try { parsed = JSON.parse(s.structured_output); } catch { /* ignore */ }
    }
    return resolveMeetingTitle(s, parsed);
  }

  /** The bare *user-typed* title only — empty when no title has been
   *  authored yet. Used to seed the editable input so the user sees a
   *  blank field (with `Meeting #N` as the placeholder) rather than a
   *  pre-filled fallback string they'd have to delete. */
  function extractRawTitle(s: MeetingSession): string {
    if (!s.structured_output) return '';
    try {
      const parsed = JSON.parse(s.structured_output);
      const t = parsed?.title;
      // Only return user-authored titles in the editable input — AI titles
      // are still displayed in the header via extractTitle but should not
      // pre-fill the input, otherwise the user's "clear it" action and a
      // user-provided edit are indistinguishable on save.
      if (typeof t === 'string' && t.trim() && parsed?.titleSource !== 'ai') {
        return t;
      }
    } catch { /* ignore */ }
    return '';
  }

  function extractProcessingState(s: MeetingSession | null): string | null {
    if (!s?.structured_output) return null;
    try {
      const parsed = JSON.parse(s.structured_output);
      return parsed.processingState ?? null;
    } catch { return null; }
  }

  const structuredOutput: StructuredMeetingOutput | null = (() => {
    if (!session?.structured_output) return null;
    try {
      const parsed = JSON.parse(session.structured_output);
      if (parsed.sections && !parsed.plainSummary) return parsed as StructuredMeetingOutput;
    } catch { /* ignore */ }
    return null;
  })();

  // User-authored notes captured during the live meeting (Your Notes panel).
  // Kept read-only on this detail page per product spec.
  const userNotesHtml = (() => {
    if (!session?.structured_output) return null;
    try {
      const parsed = JSON.parse(session.structured_output);
      if (typeof parsed?.userNotes === 'string' && parsed.userNotes.trim()) {
        return parsed.userNotes as string;
      }
    } catch { /* ignore */ }
    return null;
  })();

  const plainSummary = (() => {
    if (!session) return null;
    if (session.structured_output) {
      try {
        const parsed = JSON.parse(session.structured_output);
        if (parsed.plainSummary) return parsed.plainSummary as string;
      } catch { /* ignore */ }
    }
    return session.summary ?? null;
  })();

  /** TipTap-formatted HTML synced from the Notes page. When present, the
   *  meeting notes panel renders this instead of plain text so the user's
   *  formatting (bold, headings, lists, etc.) is preserved. */
  const notesHtmlContent = (() => {
    if (!session?.structured_output) return null;
    try {
      const parsed = JSON.parse(session.structured_output);
      if (typeof parsed?.htmlContent === 'string' && parsed.htmlContent.trim()) {
        return parsed.htmlContent as string;
      }
    } catch { /* ignore */ }
    return null;
  })();

  const handleSave = async () => {
    if (!session) return;
    setSaving(true);
    try {
      // Preserve existing structured output shape (processingState, versions[],
      // templateId, etc.) while overriding title + editable summary, and mark
      // `hasUserEdits` so a later regenerate knows to prompt.
      let existing: any = {};
      if (session.structured_output) {
        try { existing = JSON.parse(session.structured_output); } catch { /* ignore */ }
      }
      const trimmedTitle = draftTitle.trim();
      // The TipTap shell is the source of truth while editing. Derive plain
      // text from its HTML so the rest of the app (FTS, exports, sidebar
      // previews) keeps reading a clean string, while we persist the HTML
      // alongside it so the formatting survives reload.
      const finalHtml = editingHtml;
      const finalPlain = isHtmlEmpty(finalHtml) ? '' : htmlToText(finalHtml);
      const merged: any = {
        ...existing,
        sections: [{ key: 'summary', title: 'Summary', content: finalPlain }],
        plainSummary: finalPlain,
        htmlContent: isHtmlEmpty(finalHtml) ? null : finalHtml,
        // Preserve `'empty'` (no audio) and `'failed'` (summary pipeline
        // gave up on a real recording) so a manual edit doesn't silently
        // mislabel the meeting as a completed summary. Everything else
        // (including `'insufficient'`) flips to `'done'` because the user
        // has now provided notes manually.
        processingState:
          existing.processingState === 'empty'
            ? 'empty'
            : existing.processingState === 'failed'
              ? 'failed'
              : 'done',
        hasUserEdits: true,
      };
      if (trimmedTitle) {
        // Non-empty → user-authored. Stamp provenance so regenerate
        // preserves it.
        merged.title = trimmedTitle;
        merged.titleSource = 'user';
      } else {
        // Blank → "no authored title". Drop both fields so
        // resolveMeetingTitle falls back to Meeting #N.
        delete merged.title;
        delete merged.titleSource;
      }

      // Keep the Notes sidebar in sync — upsert the linked notebook entry so
      // edits made here are immediately reflected in the Notes > Meeting Notes
      // view. This is the same record, so updating it here is a no-op write
      // if the text is identical.
      try {
        // Sync the user-edited summary to the notebook entry. Polished side
        // gets the user's edited markdown; raw side stays the original
        // transcript pulled from the session record (so user edits to the
        // summary don't overwrite the transcript on the raw side).
        const sessionTranscript: string =
          (typeof (session as any).full_transcript === 'string' && (session as any).full_transcript.trim())
            ? (session as any).full_transcript
            : finalPlain;
        const entryId = await upsertMeetingNoteEntry({
          existingEntryId: merged.notebookEntryId ?? null,
          sessionId: session.id,
          title: resolveMeetingTitle(session, merged),
          polishedMarkdown: finalPlain,
          rawTranscript: sessionTranscript,
        });
        merged.notebookEntryId = entryId;
      } catch (err) {
        console.warn('[MeetingDetailPage] Notebook sync failed:', err);
      }

      const newStructured = JSON.stringify(merged);
      await window.ironmic.meetingSetStructuredOutput(session.id, newStructured);
      await window.ironmic.meetingEnd(
        session.id,
        session.speaker_count || 1,
        finalPlain,
        '',
        session.total_duration_seconds ?? 0,
        '',
      );
      const updated = { ...session, summary: finalPlain, structured_output: newStructured };
      setSession(updated);
      setDraftSummary(finalPlain);
      patchSession(session.id, { summary: finalPlain, structured_output: newStructured });
      setEditing(false);
      onUpdated?.();
    } catch (err) {
      console.error('[MeetingDetailPage] Failed to save edits:', err);
    } finally {
      setSaving(false);
    }
  };

  // ── Regenerate flow ──────────────────────────────────────────────────────
  /**
   * Reconstruct the full transcript from the loaded segments.  We rely on the
   * in-memory segments array rather than re-fetching so we don't race with the
   * user's network.  Returns empty string if no segments exist.
   */
  const reconstructTranscript = (): string => {
    if (segments.length === 0) return '';
    return segments
      .slice()
      .sort((a, b) => (a.start_ms ?? 0) - (b.start_ms ?? 0))
      .map(s => s.text)
      .filter(Boolean)
      .join('\n\n');
  };

  /**
   * Parse the current structured_output into a typed object (best-effort).
   * Returns null if the session has no structured_output yet.
   */
  const parseStructured = (): StructuredOutput | null => {
    if (!session?.structured_output) return null;
    try {
      return JSON.parse(session.structured_output) as StructuredOutput;
    } catch {
      return null;
    }
  };

  const handleRegenerate = async (args: {
    template: MeetingTemplate | null;
    disposition?: EditsDisposition;
  }) => {
    if (!session) return;
    const transcript = reconstructTranscript();
    if (!transcript) {
      console.warn('[MeetingDetailPage] No transcript segments — cannot regenerate');
      setRegenerateOpen(false);
      return;
    }

    setRegenerating(true);
    markMeetingProcessing(session.id);
    try {
      const existing = parseStructured();

      // 1. If the user opted to save edits to history, snapshot the current
      //    state into versions[] BEFORE we overwrite it.
      let carriedVersions: VersionEntry[] = existing?.versions ?? [];
      if (existing && args.disposition === 'save-to-history') {
        const reason: VersionEntry['reason'] =
          (existing.templateId ?? null) !== (args.template?.id ?? null)
            ? 'template-switch'
            : 'user-edit-before-regenerate';
        const withVersion = appendVersion(existing, reason);
        carriedVersions = withVersion.versions ?? carriedVersions;
      }

      // 2. Mark the session as generating so UI shows the processing state.
      const placeholder: StructuredOutput = {
        sections: existing?.sections ?? [],
        plainSummary: existing?.plainSummary,
        title: existing?.title,
        titleSource: existing?.titleSource,
        processingState: 'generating',
        templateId: args.template?.id,
        templateName: args.template?.name,
        versions: carriedVersions,
      };
      await window.ironmic.meetingSetStructuredOutput(session.id, JSON.stringify(placeholder));
      setSession({ ...session, structured_output: JSON.stringify(placeholder) });

      // 3. Run the shared summarizer (notify main process for quit-guard).
      // Build the metadata context (attendees only — date is shown in the
      // meeting header above the notes, no need to duplicate it inside).
      // Attendees come from the v7 participants roster (host + every joiner).
      window.ironmic?.notifyProcessingState?.(true);
      let summaryContext: { attendees?: string[] } | undefined;
      const rawParticipants = (session as any).participants;
      if (typeof rawParticipants === 'string' && rawParticipants.trim()) {
        try {
          const roster = JSON.parse(rawParticipants);
          if (Array.isArray(roster)) {
            const names = roster
              .map((p: any) => (typeof p?.displayName === 'string' ? p.displayName.trim() : ''))
              .filter((s: string) => s.length > 0);
            if (names.length > 0) summaryContext = { attendees: names };
          }
        } catch { /* malformed — skip */ }
      }
      const fresh = await generateMeetingSummary(
        transcript,
        args.template,
        summaryContext,
      );

      // 4. Preserve title + carried versions in the fresh output.
      //    Title preservation rules (do NOT overload hasUserEdits — that
      //    tracks body edits):
      //    - User-authored title (titleSource === 'user'): always keep.
      //    - AI title (titleSource === 'ai') or unset: regenerate from
      //      the new content. Falls through to `Meeting #N` if too thin.
      const userAuthored = existing?.titleSource === 'user' && !!existing?.title;
      const merged: StructuredOutput = {
        ...fresh,
        title: userAuthored ? existing!.title : undefined,
        titleSource: userAuthored ? 'user' : undefined,
        versions: carriedVersions,
        hasUserEdits: false,
        // Preserve `fresh.htmlContent` — the SummaryGenerator now runs the
        // LLM markdown through the sanitization pipeline (convertMarkdown)
        // and returns the rich HTML alongside sections. Previously this
        // line nulled htmlContent on the assumption that AI output is
        // always plain; that was true before this change but is no longer
        // — regen would otherwise destroy the formatting we just generated.
        // (`...fresh` already carries `htmlContent`; not re-listed here.)
        // Carry forward the linked notebook entry id so regen updates in place.
        notebookEntryId: (existing as any)?.notebookEntryId,
      } as StructuredOutput;
      const summaryForColumn =
        merged.plainSummary ??
        merged.sections
          .filter(s => s.content && s.content.trim() !== 'None mentioned')
          .map(s => `## ${s.title}\n${s.content}`)
          .join('\n\n');

      if (!userAuthored && summaryForColumn.trim()) {
        const aiTitle = await generateMeetingTitle(summaryForColumn);
        if (aiTitle) {
          merged.title = aiTitle;
          (merged as any).titleSource = 'ai';
        }
      }

      // Upsert the Meeting Notes notebook entry for this session so the
      // regenerated summary is reflected in the unified notes corpus.
      // The reconstructed transcript (used for the regen LLM call above)
      // is the verbatim source — write it on the raw side. Polished side
      // gets the freshly-regenerated structured summary.
      try {
        const entryId = await upsertMeetingNoteEntry({
          existingEntryId: (merged as any).notebookEntryId ?? null,
          sessionId: session.id,
          title: resolveMeetingTitle(session, merged as any),
          polishedMarkdown: summaryForColumn,
          rawTranscript: transcript,
        });
        (merged as any).notebookEntryId = entryId;
      } catch (err) {
        console.warn('[MeetingDetailPage] Notebook upsert failed:', err);
      }
      const newStructured = JSON.stringify(merged);

      await window.ironmic.meetingSetStructuredOutput(session.id, newStructured);
      await window.ironmic.meetingEnd(
        session.id,
        session.speaker_count || 1,
        summaryForColumn,
        '',
        session.total_duration_seconds ?? 0,
        '',
      );

      const updated = { ...session, summary: summaryForColumn, structured_output: newStructured };
      setSession(updated);
      setDraftSummary(extractEditableSummary(updated));
      setDraftTitle(extractRawTitle(updated));
      setEditingHtml(extractEditableHtml(updated));
      patchSession(session.id, { summary: summaryForColumn, structured_output: newStructured });
      setRegenerateOpen(false);
      onUpdated?.();
    } catch (err) {
      console.error('[MeetingDetailPage] Regenerate failed:', err);
    } finally {
      window.ironmic?.notifyProcessingState?.(false);
      setRegenerating(false);
      unmarkMeetingProcessing(session.id);
    }
  };

  const handleRestoreVersion = async (versionId: string) => {
    if (!session) return;
    const existing = parseStructured();
    if (!existing) return;
    const restored = restoreVersion(existing, versionId);
    if (!restored) return;
    const newStructured = JSON.stringify(restored);
    const summaryForColumn =
      restored.plainSummary ??
      restored.sections
        .filter(s => s.content && s.content.trim() !== 'None mentioned')
        .map(s => `## ${s.title}\n${s.content}`)
        .join('\n\n');
    try {
      await window.ironmic.meetingSetStructuredOutput(session.id, newStructured);
      await window.ironmic.meetingEnd(
        session.id,
        session.speaker_count || 1,
        summaryForColumn,
        '',
        session.total_duration_seconds ?? 0,
        '',
      );
      const updated = { ...session, summary: summaryForColumn, structured_output: newStructured };
      setSession(updated);
      setDraftSummary(extractEditableSummary(updated));
      setDraftTitle(extractRawTitle(updated));
      setEditingHtml(extractEditableHtml(updated));
      patchSession(session.id, { summary: summaryForColumn, structured_output: newStructured });
      setHistoryOpen(false);
      onUpdated?.();
    } catch (err) {
      console.error('[MeetingDetailPage] Restore failed:', err);
    }
  };

  if (!session) {
    return (
      <div className="flex items-center justify-center h-full text-iron-text-muted text-sm">
        Loading meeting…
      </div>
    );
  }

  const date = new Date(session.started_at).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const durationLabel = session.total_duration_seconds
    ? `${Math.round(session.total_duration_seconds / 60)} min`
    : '';

  const processingState = extractProcessingState(session);
  const isProcessing =
    processingMeetings.includes(sessionId) || processingState === 'generating' || regenerating;
  const isTranscribing = transcribingMeetings.includes(sessionId) && !isProcessing;
  const isEmpty = processingState === 'empty';
  const isInsufficient = processingState === 'insufficient';
  // Summary pipeline ran but every retry failed (e.g. Copilot CLI couldn't
  // accept large prompts AND local LLM unavailable). Distinct from `'empty'`
  // because audio WAS captured — the user should see "Summary unavailable"
  // and the Regenerate button below, not "No audio captured."
  const isFailed = processingState === 'failed';
  // Two-phase finalize: enhancementState is 'enhancing' while the template
  // pass runs over the live-summary baseline; 'enhanced' on success;
  // 'failed' if the template pass exhausted retries (the live summary
  // baseline is still readable — show an "Enhance" retry button).
  const enhancementState = (() => {
    if (!session?.structured_output) return null;
    try {
      const parsed = JSON.parse(session.structured_output);
      return parsed?.enhancementState ?? null;
    } catch { return null; }
  })();
  const isEnhancing = enhancementState === 'enhancing' && !isProcessing && !isEmpty && !isFailed;
  const isEnhancementFailed = enhancementState === 'failed' && !isProcessing && !isEmpty && !isFailed;
  const titleText = extractTitle(session);

  // ── Derived state for regenerate / history UI ──
  const parsedStructured: StructuredOutput | null = (() => {
    if (!session?.structured_output) return null;
    try { return JSON.parse(session.structured_output) as StructuredOutput; } catch { return null; }
  })();
  const versions: VersionEntry[] = parsedStructured?.versions ?? [];
  const currentTemplate: MeetingTemplate | null = (() => {
    const id = parsedStructured?.templateId;
    if (!id) return null;
    return templates.find(t => t.id === id) ?? null;
  })();
  /** Linked notebook-entry id used as the target for Collaborate / TTS.
   *  Empty meetings (no auto-filed entry yet) get the controls disabled
   *  with a tooltip telling the user to save first — clicking Save lazily
   *  upserts via `handleSave`, which makes them light up. */
  const notebookEntryIdForTools = parsedStructured?.notebookEntryId ?? null;

  /**
   * "Unsaved edits" for the regenerate prompt.
   *  - If the persisted structured_output carries `hasUserEdits: true`, that
   *    flag was set by a previous Save → always prompt.
   *  - If the editor is open and the draft differs from the persisted output,
   *    we also treat that as edits so the user isn't surprised.
   */
  const hasUnsavedEdits = (() => {
    if (parsedStructured?.hasUserEdits) return true;
    if (editing) {
      // Compare HTML when an htmlContent baseline exists (the user typed
      // formatted notes that we'd otherwise miss with a plain-text diff);
      // fall back to plain-text diff against the editable summary.
      const persistedHtml = parsedStructured?.htmlContent ?? '';
      if (persistedHtml) {
        if (editingHtml !== persistedHtml) return true;
      } else {
        const persistedPlain = extractEditableSummary(session);
        const draftPlain = isHtmlEmpty(editingHtml) ? '' : htmlToText(editingHtml);
        if (draftPlain.trim() !== persistedPlain.trim()) return true;
      }
      if (draftTitle.trim() !== extractRawTitle(session).trim()) return true;
    }
    return false;
  })();

  const canRegenerate = !isProcessing && !editing && segments.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-iron-border bg-iron-surface shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={onBack}
            className="p-1.5 rounded-lg text-iron-text-muted hover:bg-iron-surface-hover transition-colors"
            title="Back"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0 flex-1">
            {editing ? (
              <input
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                placeholder={titleText}
                className="w-full bg-iron-surface-hover border border-iron-border rounded px-2 py-1 text-sm font-medium text-iron-text focus:outline-none focus:border-iron-accent/40"
              />
            ) : (
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-iron-text truncate">{titleText}</p>
                {isProcessing && (
                  <span className="flex items-center gap-1 text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded">
                    <Loader2 className="w-2.5 h-2.5 animate-spin" />
                    Processing…
                  </span>
                )}
                {isEmpty && !isProcessing && (
                  <span className="text-[10px] text-iron-text-muted bg-iron-surface-hover px-1.5 py-0.5 rounded">
                    No speech
                  </span>
                )}
                {isInsufficient && !isProcessing && (
                  <span className="text-[10px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded">
                    Not enough content
                  </span>
                )}
                {isFailed && !isProcessing && (
                  <span className="text-[10px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded">
                    Summary unavailable
                  </span>
                )}
                {/* Two-phase finalize indicators. "Enhancing…" — Phase B
                    template pass is running in the background; the user
                    can already read the basic summary below. "Enhanced" —
                    the upgraded version is ready (no badge, the upgrade
                    is just visible in the body). "Enhancement failed" —
                    the user can click Enhance below to retry the
                    template pass. */}
                {isEnhancing && (
                  <span
                    className="flex items-center gap-1 text-[10px] text-iron-accent-light bg-iron-accent/10 border border-iron-accent/20 px-1.5 py-0.5 rounded"
                    title="Adding template formatting and context. The basic summary is already available below."
                  >
                    <Sparkles className="w-2.5 h-2.5 animate-pulse" />
                    Enhancing…
                  </span>
                )}
                {isEnhancementFailed && (
                  <span
                    className="text-[10px] text-iron-text-muted bg-iron-surface-hover px-1.5 py-0.5 rounded"
                    title="The template-formatted version couldn't be generated. The basic summary is available below; click Enhance to retry."
                  >
                    Basic summary only
                  </span>
                )}
                {isTranscribing && (
                  <span
                    className="flex items-center gap-1 text-[10px] text-iron-text-muted bg-iron-surface-hover border border-iron-border px-1.5 py-0.5 rounded"
                    title="Finishing transcription of the final audio segment. Your summary is already available."
                  >
                    <Loader2 className="w-2.5 h-2.5 animate-spin" />
                    Transcribing…
                  </span>
                )}
              </div>
            )}
            <div className="flex items-center gap-2 text-[11px] text-iron-text-muted">
              <Clock className="w-3 h-3" />
              <span>{date}</span>
              {durationLabel && <span>· {durationLabel}</span>}
              {session.speaker_count > 0 && (
                <>
                  <Users className="w-3 h-3 ml-1" />
                  <span>{session.speaker_count}</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <button
                onClick={() => {
                  setEditing(false);
                  setDraftSummary(extractEditableSummary(session));
                  setDraftTitle(extractRawTitle(session));
                  setEditingHtml(extractEditableHtml(session));
                }}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-iron-text-muted rounded-lg border border-iron-border hover:bg-iron-surface-hover transition-colors"
              >
                <X className="w-3.5 h-3.5" />
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-iron-accent/15 text-iron-accent-light rounded-lg border border-iron-accent/20 hover:bg-iron-accent/25 transition-colors disabled:opacity-50"
              >
                <Save className="w-3.5 h-3.5" />
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            <>
              <ReadAloudButton
                getText={() => editing ? (editorRef.current?.getText() || '') : (plainSummary || '')}
                ttsKey={notebookEntryIdForTools}
                disabled={isProcessing || (!editing && !plainSummary)}
              />
              <button
                onClick={() => setCollabOpen(true)}
                disabled={!notebookEntryIdForTools}
                title={notebookEntryIdForTools
                  ? 'Collaborate on these notes'
                  : 'Save the meeting first to enable collaboration'}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-iron-text-muted rounded-lg border border-iron-border hover:bg-iron-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <UsersIcon className="w-3.5 h-3.5" />
                Collaborate
              </button>
              {versions.length > 0 && (
                <button
                  onClick={() => setHistoryOpen(true)}
                  className="relative flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-iron-text-muted rounded-lg border border-iron-border hover:bg-iron-surface-hover transition-colors"
                  title={`Notes history — ${versions.length} version${versions.length === 1 ? '' : 's'}`}
                >
                  <History className="w-3.5 h-3.5" />
                  <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 text-[9px] font-medium bg-iron-accent/20 text-iron-accent-light rounded-full flex items-center justify-center">
                    {versions.length}
                  </span>
                </button>
              )}
              {/* "Enhance" retry — only visible when enhancement previously
                  failed. One-click rerun of the template pass using the
                  current/persisted template; no modal needed (the modal
                  is for picking a different template, which is what
                  Regenerate is for). Reuses the same handleRegenerate
                  pipeline so error handling + history snapshot all
                  behave the same. */}
              {isEnhancementFailed && (
                <button
                  onClick={() => {
                    void handleRegenerate({
                      template: currentTemplate,
                      disposition: 'discard',
                    });
                  }}
                  disabled={!canRegenerate}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-iron-accent/15 text-iron-accent-light rounded-lg border border-iron-accent/20 hover:bg-iron-accent/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Retry the template-formatted enhancement pass"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Enhance
                </button>
              )}
              <button
                onClick={() => setRegenerateOpen(true)}
                disabled={!canRegenerate}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-iron-text-muted rounded-lg border border-iron-border hover:bg-iron-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title={
                  segments.length === 0
                    ? 'No transcript available to regenerate from'
                    : isProcessing
                      ? 'Notes are being generated — regenerate will be available shortly'
                      : 'Regenerate notes (optionally with a different template)'
                }
              >
                <RefreshCw className={`w-3.5 h-3.5 ${regenerating ? 'animate-spin' : ''}`} />
                Regenerate
              </button>
              <button
                onClick={() => setEditing(true)}
                disabled={isProcessing}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-iron-text-muted rounded-lg border border-iron-border hover:bg-iron-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title={isProcessing ? 'Notes are being generated — edit will be available shortly' : 'Edit notes'}
              >
                <Pencil className="w-3.5 h-3.5" />
                Edit
              </button>
            </>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
            {/* Notes */}
            <div>
              <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider mb-2">Notes</p>
              {editing ? (
                <div className="min-h-[300px] bg-iron-surface border border-iron-border rounded-lg overflow-hidden">
                  <RichTextEditorShell
                    valueHtml={editingHtml}
                    onChangeHtml={setEditingHtml}
                    placeholder="Write your meeting notes here…"
                    onReady={(ed) => { editorRef.current = ed; }}
                    rightToolbarSlot={
                      <DictateButton
                        state={dictateState}
                        onStart={async () => {
                          setDictateState('recording');
                          try { await window.ironmic.startRecording(); }
                          catch (err) {
                            console.error('[MeetingDetailPage] startRecording failed:', err);
                            setDictateState('idle');
                          }
                        }}
                        onStop={async () => {
                          setDictateState('processing');
                          try {
                            const buf = await window.ironmic.stopRecording();
                            const text = await window.ironmic.transcribe(buf);
                            const trimmed = (text || '').trim();
                            if (trimmed && editorRef.current) {
                              // Insert at cursor — scoped to this editor only.
                              // No global onPipelineStateChanged listener,
                              // so other surfaces are unaffected.
                              editorRef.current.commands.insertContent(trimmed + ' ');
                            }
                          } catch (err) {
                            console.error('[MeetingDetailPage] dictate stop failed:', err);
                          } finally {
                            setDictateState('idle');
                          }
                        }}
                      />
                    }
                    className="flex flex-col bg-iron-surface min-h-[300px]"
                  />
                </div>
              ) : isProcessing ? (
                <div className="flex items-center gap-2 text-sm text-amber-400 bg-amber-500/5 border border-amber-500/20 rounded-lg px-4 py-3">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Your meeting notes are currently being processed. Please check back in a few moments — you'll be able to edit them once they're ready.
                </div>
              ) : isEmpty ? (
                <div className="text-sm text-iron-text-muted bg-iron-surface border border-iron-border rounded-lg px-4 py-3 leading-relaxed">
                  <p className="font-medium mb-1 text-iron-text">No audio captured</p>
                  <p>
                    The recording didn't pick up any sound — this usually means the wrong microphone was selected, the mic was muted, or the meeting audio wasn't routed to IronMic (e.g. BlackHole not installed for system audio). You can still use <em>Edit</em> above to write notes manually.
                  </p>
                </div>
              ) : isInsufficient ? (
                <div className="text-sm text-amber-300/90 bg-amber-500/5 border border-amber-500/20 rounded-lg px-4 py-3 leading-relaxed">
                  <p className="font-medium mb-1">Too brief to summarize</p>
                  <p className="text-amber-300/70">
                    Audio <em>was</em> captured, but it contained too little actual speech for the AI to produce faithful notes — we'd rather leave this blank than fabricate bullets. The raw transcript is saved below, and you can write your own notes with <em>Edit</em>.
                  </p>
                </div>
              ) : isFailed ? (
                <div className="text-sm text-amber-300/90 bg-amber-500/5 border border-amber-500/20 rounded-lg px-4 py-3 leading-relaxed">
                  <p className="font-medium mb-1">Summary unavailable</p>
                  <p className="text-amber-300/70">
                    Audio <em>was</em> captured, but the summary pipeline failed (e.g. the configured AI provider rejected the prompt). The raw transcript is saved below. Use <em>Regenerate</em> above to try again — switching to a different AI provider in Settings often helps — or write your own notes with <em>Edit</em>.
                  </p>
                </div>
              ) : (
                <MeetingNotesPanel
                  structuredOutput={structuredOutput}
                  summary={plainSummary}
                  htmlContent={notesHtmlContent}
                  isGenerating={false}
                />
              )}
            </div>

            {/* User's own notes — read-only post-meeting */}
            {userNotesHtml && (
              <div className="border-t border-iron-border/50 pt-4">
                <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider mb-2">
                  Your Notes
                </p>
                <div
                  className="prose prose-invert prose-sm max-w-none text-iron-text"
                  // userNotesHtml originates from TipTap's getHTML() on the same
                  // user's machine — never from network — so it's safe to render.
                  dangerouslySetInnerHTML={{ __html: userNotesHtml }}
                />
              </div>
            )}

            {/* Collapsible transcript */}
            <div className="border-t border-iron-border/50 pt-4">
              <button
                onClick={() => setTranscriptOpen(v => !v)}
                className="flex items-center gap-2 text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider hover:text-iron-text transition-colors"
              >
                {transcriptOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                Transcript
                {segments.length > 0 && (
                  <span className="text-iron-text-muted/70 normal-case font-normal">
                    · {segments.length} segment{segments.length === 1 ? '' : 's'}
                  </span>
                )}
              </button>

              {transcriptOpen && (
                <div className="mt-3 max-h-[60vh] overflow-y-auto">
                  {segments.length > 0 ? (
                    <MeetingTranscriptPanel segments={segments} isLive={false} />
                  ) : (
                    <p className="text-xs text-iron-text-muted py-4">No transcript segments were saved for this meeting.</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Regenerate modal */}
      {regenerateOpen && (
        <MeetingRegenerateModal
          templates={templates}
          currentTemplate={currentTemplate}
          hasUnsavedEdits={hasUnsavedEdits}
          onClose={() => setRegenerateOpen(false)}
          onConfirm={handleRegenerate}
        />
      )}

      {/* Versions history drawer */}
      {historyOpen && (
        <MeetingVersionsDrawer
          versions={versions}
          onClose={() => setHistoryOpen(false)}
          onRestore={handleRestoreVersion}
        />
      )}

      {/* Collaborate modal — targets the linked notebook entry so the
          existing meeting-collab WebSocket plumbing applies unchanged. */}
      {collabOpen && notebookEntryIdForTools && (
        <NotesCollaborateModal
          noteId={notebookEntryIdForTools}
          initialNotes={editing
            ? (editorRef.current?.getText() || htmlToText(editingHtml))
            : (plainSummary || '')}
          onJoined={() => { /* Meetings host doesn't expose join here. */ }}
          onClose={() => setCollabOpen(false)}
        />
      )}
    </div>
  );
}

/* ─── Read-aloud button ─── */

/**
 * Header button that reads the current notes via the shared TTS store.
 *
 * `getText` is a thunk so we can pull live editor text in edit mode
 * without coupling this component to the editor instance — the parent
 * decides where the text comes from.
 *
 * `ttsKey` is the linked notebook entry id when one exists; we pass it
 * through to the store so the play/pause state correctly tracks "this
 * meeting" across navigations and so caption highlights scope correctly.
 */
function ReadAloudButton({
  getText,
  ttsKey,
  disabled,
}: {
  getText: () => string;
  ttsKey: string | null;
  disabled?: boolean;
}) {
  const { state, synthesizeAndPlay, pause, play, activeEntryId } = useTtsStore();
  const isThisOne = !!ttsKey && activeEntryId === ttsKey;
  const isPlayingThis = isThisOne && state === 'playing';
  const isPausedThis = isThisOne && state === 'paused';
  const isSynthThis = isThisOne && state === 'synthesizing';

  const handleClick = async () => {
    if (isPlayingThis) { await pause(); return; }
    if (isPausedThis) { await play(); return; }
    const text = getText();
    if (text.trim()) {
      await synthesizeAndPlay(text, ttsKey || undefined);
    }
  };

  // Icon-only button. Speakerphone (Volume2) when idle; Pause while
  // actively speaking; Play to resume from a paused stream. The tooltip
  // carries the verb so the affordance is still discoverable on hover.
  const Icon = isPlayingThis ? Pause : isPausedThis ? Play : Volume2;
  const title = isPlayingThis
    ? 'Pause'
    : isPausedThis
    ? 'Resume'
    : isThisOne
    ? 'Read aloud'
    : activeEntryId
    ? 'Read aloud (replaces current playback)'
    : 'Read aloud';

  return (
    <button
      onClick={handleClick}
      disabled={disabled || isSynthThis}
      title={title}
      aria-label={title}
      className={`p-2 rounded-lg border transition-colors ${
        isPlayingThis || isPausedThis
          ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
          : 'text-iron-text-muted border-iron-border hover:bg-iron-surface-hover'
      } disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {isSynthThis ? (
        <div className="w-3.5 h-3.5 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
      ) : (
        <Icon className="w-3.5 h-3.5" />
      )}
    </button>
  );
}

/* ─── Dictate-append button (toolbar slot, edit mode only) ─── */

/**
 * Three-state toggle: idle → recording (red Stop) → processing → idle.
 *
 * Uses the SCOPED start/stop/transcribe API rather than the global
 * dictation streamer or `onPipelineStateChanged` listeners — that lets
 * the meeting editor receive its own transcript without other surfaces
 * (Notes, Forge, AI Chat) racing for the chunk on idle.
 */
function DictateButton({
  state,
  onStart,
  onStop,
}: {
  state: 'idle' | 'recording' | 'processing';
  onStart: () => void;
  onStop: () => void;
}) {
  const isRecording = state === 'recording';
  const isProcessing = state === 'processing';

  return (
    <button
      onClick={isRecording ? onStop : onStart}
      disabled={isProcessing}
      title={
        isProcessing
          ? 'Transcribing…'
          : isRecording
          ? 'Stop dictation and insert at cursor'
          : 'Dictate (insert at cursor)'
      }
      className={`p-1.5 rounded-md transition-all ${
        isRecording
          ? 'bg-red-500/20 text-red-400 animate-pulse'
          : isProcessing
          ? 'bg-amber-500/15 text-amber-400'
          : 'text-iron-text-muted hover:text-iron-text-secondary hover:bg-iron-surface-hover'
      } disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {isProcessing ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : isRecording ? (
        <MicOff className="w-3.5 h-3.5" />
      ) : (
        <Mic className="w-3.5 h-3.5" />
      )}
    </button>
  );
}
