import { useEffect, useState } from 'react';
import { ArrowLeft, Clock, Users, ChevronDown, ChevronRight, Pencil, Save, X, Loader2, RefreshCw, History } from 'lucide-react';
import { MeetingTranscriptPanel, type TranscriptSegment } from './MeetingTranscriptPanel';
import { MeetingNotesPanel } from './MeetingNotesPanel';
import { MeetingRegenerateModal, type EditsDisposition } from './MeetingRegenerateModal';
import { MeetingVersionsDrawer } from './MeetingVersionsDrawer';
import type { MeetingTemplate, StructuredMeetingOutput } from '../services/tfjs/MeetingTemplateEngine';
import {
  generateMeetingSummary,
  appendVersion,
  restoreVersion,
  type StructuredOutput,
  type VersionEntry,
} from '../services/meeting/SummaryGenerator';
import { useMeetingStore } from '../stores/useMeetingStore';

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
  const [draftTitle, setDraftTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const processingMeetings = useMeetingStore(s => s.processingMeetings);
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
        setDraftTitle(extractTitle(s));
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
    // Make sure the templates list is hydrated so the regenerate modal has
    // something to offer even if the user landed here via a deep-link.
    if (templates.length === 0) void loadTemplates();

    // Poll while this meeting is still in the background-processing set.
    // Stops polling as soon as the store unmarks the id.
    const poll = setInterval(() => {
      if (processingMeetings.includes(sessionId)) {
        load();
      }
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [sessionId, processingMeetings]);

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

  function extractTitle(s: MeetingSession): string {
    if (s.structured_output) {
      try {
        const parsed = JSON.parse(s.structured_output);
        if (parsed.title && typeof parsed.title === 'string') return parsed.title;
      } catch { /* ignore */ }
    }
    return s.detected_app
      ? `${s.detected_app.charAt(0).toUpperCase() + s.detected_app.slice(1)} Meeting`
      : 'Meeting';
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
      const merged = {
        ...existing,
        title: draftTitle.trim(),
        sections: [{ key: 'summary', title: 'Summary', content: draftSummary }],
        plainSummary: draftSummary,
        processingState: existing.processingState === 'empty' ? 'empty' : 'done',
        hasUserEdits: true,
      };
      const newStructured = JSON.stringify(merged);

      await window.ironmic.meetingSetStructuredOutput(session.id, newStructured);
      await window.ironmic.meetingEnd(
        session.id,
        session.speaker_count || 1,
        draftSummary,
        '',
        session.total_duration_seconds ?? 0,
        '',
      );
      const updated = { ...session, summary: draftSummary, structured_output: newStructured };
      setSession(updated);
      patchSession(session.id, { summary: draftSummary, structured_output: newStructured });
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
        processingState: 'generating',
        templateId: args.template?.id,
        templateName: args.template?.name,
        versions: carriedVersions,
      };
      await window.ironmic.meetingSetStructuredOutput(session.id, JSON.stringify(placeholder));
      setSession({ ...session, structured_output: JSON.stringify(placeholder) });

      // 3. Run the shared summarizer.
      const fresh = await generateMeetingSummary(transcript, args.template);

      // 4. Preserve title + carried versions in the fresh output.
      const merged: StructuredOutput = {
        ...fresh,
        title: existing?.title,
        versions: carriedVersions,
        hasUserEdits: false,
      };
      const newStructured = JSON.stringify(merged);
      const summaryForColumn =
        merged.plainSummary ??
        merged.sections
          .filter(s => s.content && s.content.trim() !== 'None mentioned')
          .map(s => `## ${s.title}\n${s.content}`)
          .join('\n\n');

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
      setDraftTitle(extractTitle(updated));
      patchSession(session.id, { summary: summaryForColumn, structured_output: newStructured });
      setRegenerateOpen(false);
      onUpdated?.();
    } catch (err) {
      console.error('[MeetingDetailPage] Regenerate failed:', err);
    } finally {
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
      setDraftTitle(extractTitle(updated));
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
  const isEmpty = processingState === 'empty';
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
      const persisted = extractEditableSummary(session);
      if (draftSummary.trim() !== persisted.trim()) return true;
      if (draftTitle.trim() !== extractTitle(session).trim()) return true;
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
                placeholder="Meeting title"
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
                  setDraftTitle(extractTitle(session));
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
                <textarea
                  value={draftSummary}
                  onChange={(e) => setDraftSummary(e.target.value)}
                  className="w-full min-h-[300px] bg-iron-surface border border-iron-border rounded-lg px-3 py-2 text-sm text-iron-text leading-relaxed focus:outline-none focus:border-iron-accent/40 font-mono"
                  placeholder="Write your meeting notes here…"
                />
              ) : isProcessing ? (
                <div className="flex items-center gap-2 text-sm text-amber-400 bg-amber-500/5 border border-amber-500/20 rounded-lg px-4 py-3">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Your meeting notes are currently being processed. Please check back in a few moments — you'll be able to edit them once they're ready.
                </div>
              ) : isEmpty ? (
                <div className="text-sm text-iron-text-muted bg-iron-surface border border-iron-border rounded-lg px-4 py-3">
                  No speech was detected during this recording, so no notes were generated. You can still edit the title or write notes manually by clicking Edit above.
                </div>
              ) : (
                <MeetingNotesPanel
                  structuredOutput={structuredOutput}
                  summary={plainSummary}
                  isGenerating={false}
                />
              )}
            </div>

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
    </div>
  );
}
