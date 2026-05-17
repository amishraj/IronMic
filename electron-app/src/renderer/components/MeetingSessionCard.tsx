import { useState } from 'react';
import { Clock, Users, Trash2, ChevronDown, ChevronRight, Mic, Pencil, Loader2, FileText, Check, Sparkles } from 'lucide-react';
import { Card } from './ui';
import { AddToNotebookMenu } from './AddToNotebookMenu';
import { useMeetingStore } from '../stores/useMeetingStore';
import { resolveMeetingTitle } from '../services/meetingTitle';

interface MeetingSession {
  id: string;
  started_at: string;
  ended_at?: string;
  speaker_count: number;
  summary?: string;
  action_items?: string;
  total_duration_seconds?: number;
  template_id?: string;
  structured_output?: string;
  detected_app?: string;
}

interface Props {
  session: MeetingSession;
  onDelete: (id: string) => void;
  onOpen?: (id: string) => void;
  /** Selection-mode flag from the parent. When true, the mic icon
   *  becomes a checkbox and clicking the card toggles selection
   *  instead of opening the detail view. */
  selectionMode?: boolean;
  /** This card's own selected state (independent of selectionMode so a
   *  newly-clicked mic can render selected before the global flag flips). */
  selected?: boolean;
  /** Toggle handler for the checkbox / mic. When provided, clicking the
   *  mic icon area calls this; the parent decides whether to enter
   *  selection mode. */
  onToggleSelect?: (id: string) => void;
}

export function MeetingSessionCard({
  session, onDelete, onOpen,
  selectionMode = false, selected = false, onToggleSelect,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const processingMeetings = useMeetingStore(s => s.processingMeetings);
  const transcribingMeetings = useMeetingStore(s => s.transcribingMeetings);
  const isTranscribing = transcribingMeetings.includes(session.id);

  const date = new Date(session.started_at).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const duration = session.total_duration_seconds
    ? `${Math.round(session.total_duration_seconds / 60)} min`
    : '';

  // Try to parse structured output
  let structuredSections: Array<{ key: string; title: string; content: string }> | null = null;
  let processingState: string | null = null;
  let enhancementState: string | null = null;
  let parsedStructured: any = null;
  if (session.structured_output) {
    try {
      parsedStructured = JSON.parse(session.structured_output);
      structuredSections = parsedStructured.sections || null;
      processingState = parsedStructured.processingState ?? null;
      // Two-phase finalize introduced an enhancement layer on top of the
      // basic processingState. After Phase A, processingState='done' AND
      // enhancementState='enhancing' — meaning the user can READ the live
      // summary now while the heavier template pass runs in background.
      // 'enhanced' = template pass succeeded. 'failed' = template pass
      // failed but the live summary baseline is still readable.
      enhancementState = parsedStructured.enhancementState ?? null;
    } catch { /* fallback to summary */ }
  }

  // "Processing…" should only show for the legacy old-style mid-generation
  // state OR when we have nothing readable yet. Once Phase A has laid down
  // the live summary, the card shows "Notes ready" + "Enhancing…" so the
  // user sees value immediately. Without this guard the card would flip
  // back to "Processing…" during the enhancement pass and feel slower than
  // before despite the optimization.
  const isProcessing = processingMeetings.includes(session.id) || processingState === 'generating';
  const isEmpty = processingState === 'empty';
  const isInsufficient = processingState === 'insufficient';
  // `'failed'` means audio WAS captured but the summary pipeline failed on
  // every retry (e.g. Copilot CLI rejected large prompts AND local LLM
  // unavailable). Distinct from `'empty'` so the card copy stays honest.
  const isFailed = processingState === 'failed';
  const isEnhancing = enhancementState === 'enhancing' && !isProcessing && !isEmpty && !isFailed;
  // Notes are "done" when the LLM finished and produced at least one section or a plainSummary.
  const hasSummary = !!(
    (structuredSections && structuredSections.length > 0) ||
    session.summary
  );
  const hasNotes =
    !isProcessing && !isEmpty && !isInsufficient && !isFailed && processingState === 'done' && hasSummary;

  const titleText = resolveMeetingTitle(session, parsedStructured);

  // Card-level click behavior:
  //   - selection mode → toggle selection (whole card is the hit target)
  //   - normal mode + onOpen → navigate to detail
  //   - no onOpen → toggle inline expansion (legacy ambient-mode flow)
  const handleCardClick = () => {
    if (selectionMode && onToggleSelect) {
      onToggleSelect(session.id);
      return;
    }
    if (onOpen) onOpen(session.id);
    else setExpanded(!expanded);
  };

  return (
    <Card
      variant="default"
      padding="none"
      className={`animate-fade-in ${selected ? 'ring-2 ring-iron-accent/40 border-iron-accent/30' : ''}`}
    >
      {/* Header. Used to be a `<button>` but we have interactive children
          (AddToNotebookMenu, the per-card delete button, the mic-as-checkbox
          toggle). Browsers either swallow the inner clicks or, in some
          versions of React, fire BOTH the inner and outer handlers — the
          AddToNotebook menu was getting closed before its dropdown could
          render. `role="button"` keeps the keyboard semantics. */}
      <div
        role="button"
        tabIndex={0}
        onClick={handleCardClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleCardClick();
          }
        }}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-iron-surface-hover/50 transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-3 min-w-0">
          {/* Mic icon is a click target: clicking it toggles selection
              (entering selection mode if not already in it). In selection
              mode the icon swaps for a checkbox; clicking the checkbox
              also toggles selection. stopPropagation so the surrounding
              card-button doesn't double-fire. */}
          <div
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect?.(session.id);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                onToggleSelect?.(session.id);
              }
            }}
            className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 cursor-pointer transition-colors ${
              selected
                ? 'bg-iron-accent text-white'
                : selectionMode
                  ? 'bg-iron-surface-hover text-iron-text-muted border border-iron-border hover:border-iron-accent/40'
                  : 'bg-iron-accent/10 text-iron-accent-light hover:bg-iron-accent/20'
            }`}
            title={
              selected
                ? 'Deselect'
                : selectionMode
                  ? 'Select this meeting'
                  : 'Click to start selecting meetings'
            }
          >
            {selected ? (
              <Check className="w-4 h-4" />
            ) : selectionMode ? (
              <span className="w-3.5 h-3.5 rounded-sm border-2 border-current" />
            ) : (
              <Mic className="w-4 h-4" />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-iron-text truncate">
                {titleText}
              </p>
              {isProcessing && (
                <span className="flex items-center gap-1 text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded">
                  <Loader2 className="w-2.5 h-2.5 animate-spin" />
                  Processing…
                </span>
              )}
              {hasNotes && (
                <span className="flex items-center gap-1 text-[10px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded">
                  <FileText className="w-2.5 h-2.5" />
                  Notes ready
                </span>
              )}
              {/* "Enhancing…" — Phase B (background template pass) is
                  running. The user can already read the live-summary
                  baseline; this badge tells them an upgraded version is
                  on its way. Distinct from "Processing…" both visually
                  (accent vs amber) AND semantically (something IS
                  readable; we're just polishing it). */}
              {isEnhancing && (
                <span
                  className="flex items-center gap-1 text-[10px] text-iron-accent-light bg-iron-accent/10 border border-iron-accent/20 px-1.5 py-0.5 rounded"
                  title="Adding template formatting and context. The basic summary is already available."
                >
                  <Sparkles className="w-2.5 h-2.5 animate-pulse" />
                  Enhancing…
                </span>
              )}
              {isTranscribing && !isProcessing && (
                <span
                  className="flex items-center gap-1 text-[10px] text-iron-text-muted bg-iron-surface-hover border border-iron-border px-1.5 py-0.5 rounded"
                  title="Finishing transcription of the final audio segment — summary already available above."
                >
                  <Loader2 className="w-2.5 h-2.5 animate-spin" />
                  Transcribing…
                </span>
              )}
              {isEmpty && !isProcessing && (
                <span
                  className="text-[10px] text-iron-text-muted bg-iron-surface-hover px-1.5 py-0.5 rounded"
                  title="No audio was captured — check that your microphone was unmuted."
                >
                  No audio captured
                </span>
              )}
              {isInsufficient && !isProcessing && (
                <span
                  className="text-[10px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded"
                  title="Audio was captured but too little speech was present to summarize faithfully."
                >
                  Too brief to summarize
                </span>
              )}
              {isFailed && !isProcessing && (
                // Card has no regenerate prop; the existing Regenerate button
                // lives on MeetingDetailPage. The badge label invites the
                // user to open the detail page (the card's normal click
                // behavior) and retry from there.
                <span
                  className="text-[10px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded"
                  title="Audio was captured but the summary generation failed. Open the meeting to retry."
                >
                  Summary unavailable — open to retry
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-[11px] text-iron-text-muted">
              <Clock className="w-3 h-3" />
              <span>{date}</span>
              {duration && <span>· {duration}</span>}
              {session.speaker_count > 0 && (
                <>
                  <Users className="w-3 h-3 ml-1" />
                  <span>{session.speaker_count}</span>
                </>
              )}
            </div>
          </div>
        </div>
        {/* Right-side per-card actions. Hidden in selection mode so the
            user focuses on bulk selection — the floating action bar at
            the bottom of MeetingPage takes over for delete + cancel. */}
        {!selectionMode && (
          <div className="flex items-center gap-1 flex-shrink-0">
            {onOpen && (
              <span
                className="p-1.5 rounded-lg text-iron-text-muted hover:text-iron-accent-light hover:bg-iron-accent/10 transition-colors"
                title="Open & edit"
              >
                <Pencil className="w-3.5 h-3.5" />
              </span>
            )}
            {hasNotes && (
              <div onClick={(e) => e.stopPropagation()}>
                <AddToNotebookMenu
                  title={titleText}
                  // The full structured markdown summary — passed straight
                  // through. addTextAsEntryToNotebook now runs convertMarkdown
                  // on this so the resulting entry has both polished_text
                  // and polished_text_json populated, and DictatePage renders
                  // it with headings/bold/lists exactly like the meeting
                  // detail page.
                  plainText={buildMeetingPlainText(titleText, structuredSections, session.summary)}
                  sourceApp={`meeting-export:${session.id}`}
                />
              </div>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                const label = titleText || 'this meeting';
                const ok = window.confirm(
                  `Delete "${label}"?\n\nThis will permanently remove the meeting, its transcript, and notes. This cannot be undone.`,
                );
                if (ok) onDelete(session.id);
              }}
              className="p-1.5 rounded-lg text-iron-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
              title="Delete"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            {!onOpen && (expanded ? <ChevronDown className="w-4 h-4 text-iron-text-muted" /> : <ChevronRight className="w-4 h-4 text-iron-text-muted" />)}
          </div>
        )}
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-iron-border/50">
          {isProcessing ? (
            <div className="pt-3 flex items-center gap-2 text-xs text-amber-400">
              <Loader2 className="w-3 h-3 animate-spin" />
              Your meeting notes are currently being processed. Please check back in a few moments.
            </div>
          ) : isEmpty ? (
            <p className="text-xs text-iron-text-muted pt-3">
              No audio was captured. Check that the correct microphone is selected and not muted, then try again.
            </p>
          ) : isInsufficient ? (
            <p className="text-xs text-amber-300/90 pt-3">
              Too little speech was captured to generate reliable AI notes. The raw transcript is preserved and visible on the detail page — you can write your own notes there.
            </p>
          ) : structuredSections && structuredSections.length > 0 ? (
            // Structured output from template
            structuredSections.map((section) => (
              <div key={section.key} className="pt-3">
                <h4 className="text-xs font-semibold text-iron-text-muted uppercase tracking-wider mb-1.5">
                  {section.title}
                </h4>
                <div className="text-sm text-iron-text leading-relaxed whitespace-pre-wrap">
                  {section.content}
                </div>
              </div>
            ))
          ) : session.summary ? (
            // Plain summary
            <div className="pt-3">
              <h4 className="text-xs font-semibold text-iron-text-muted uppercase tracking-wider mb-1.5">Summary</h4>
              <div className="text-sm text-iron-text leading-relaxed whitespace-pre-wrap">
                {session.summary}
              </div>
            </div>
          ) : (
            <p className="text-xs text-iron-text-muted pt-3">No summary available.</p>
          )}

          {session.action_items && !structuredSections && (
            <div>
              <h4 className="text-xs font-semibold text-iron-text-muted uppercase tracking-wider mb-1.5">Action Items</h4>
              <div className="text-sm text-iron-text leading-relaxed whitespace-pre-wrap">
                {session.action_items}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * Build a plaintext rendering of the meeting notes suitable for storing
 * in the entries table when the user adds them to a notebook. Preserves
 * section headings for readability.
 */
function buildMeetingPlainText(
  title: string,
  sections: Array<{ key: string; title: string; content: string }> | null,
  fallbackSummary: string | undefined,
): string {
  const parts: string[] = [];
  parts.push(`# ${title}`);
  if (sections && sections.length > 0) {
    for (const s of sections) {
      if (!s.content || !s.content.trim()) continue;
      parts.push('');
      parts.push(`## ${s.title}`);
      parts.push(s.content.trim());
    }
  } else if (fallbackSummary && fallbackSummary.trim()) {
    parts.push('');
    parts.push(fallbackSummary.trim());
  }
  return parts.join('\n');
}
