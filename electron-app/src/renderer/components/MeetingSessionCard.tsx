import { useState } from 'react';
import { Clock, Users, Trash2, ChevronDown, ChevronRight, Mic, Pencil, Loader2, FileText } from 'lucide-react';
import { Card } from './ui';
import { ShareMenu } from './ShareMenu';
import { AddToNotebookMenu } from './AddToNotebookMenu';
import { useMeetingStore } from '../stores/useMeetingStore';

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
  /** Called when user clicks "Share & Collaborate" — opens detail page with collab panel. */
  onCollaborate?: (id: string) => void;
}

export function MeetingSessionCard({ session, onDelete, onOpen, onCollaborate }: Props) {
  const [expanded, setExpanded] = useState(false);
  const processingMeetings = useMeetingStore(s => s.processingMeetings);

  const date = new Date(session.started_at).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const duration = session.total_duration_seconds
    ? `${Math.round(session.total_duration_seconds / 60)} min`
    : '';

  // Try to parse structured output
  let structuredSections: Array<{ key: string; title: string; content: string }> | null = null;
  let processingState: string | null = null;
  let customTitle: string | null = null;
  let sequence: number | null = null;
  if (session.structured_output) {
    try {
      const parsed = JSON.parse(session.structured_output);
      structuredSections = parsed.sections || null;
      processingState = parsed.processingState ?? null;
      customTitle = parsed.title ?? null;
      if (typeof parsed.sequence === 'number' && parsed.sequence > 0) {
        sequence = parsed.sequence;
      }
    } catch { /* fallback to summary */ }
  }

  const isProcessing = processingMeetings.includes(session.id) || processingState === 'generating';
  const isEmpty = processingState === 'empty';
  const isInsufficient = processingState === 'insufficient';
  // Notes are "done" when the LLM finished and produced at least one section or a plainSummary.
  const hasSummary = !!(
    (structuredSections && structuredSections.length > 0) ||
    session.summary
  );
  const hasNotes = !isProcessing && !isEmpty && !isInsufficient && processingState === 'done' && hasSummary;

  // Default title precedence (when the user hasn't set a custom title):
  //   1. Sequential number ("Meeting #N") — stable, assigned at create time.
  //   2. Detected meeting app (e.g. "Zoom Meeting") — for pre-sequence sessions.
  //   3. Plain "Meeting" — last resort for older sessions missing both.
  const defaultTitle = sequence != null
    ? `Meeting #${sequence}`
    : session.detected_app
      ? `${session.detected_app.charAt(0).toUpperCase() + session.detected_app.slice(1)} Meeting`
      : 'Meeting';
  const titleText = customTitle && customTitle.trim().length > 0 ? customTitle : defaultTitle;

  return (
    <Card variant="default" padding="none" className="animate-fade-in">
      {/* Header */}
      <button
        onClick={() => onOpen ? onOpen(session.id) : setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-iron-surface-hover/50 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-iron-accent/10 flex items-center justify-center flex-shrink-0">
            <Mic className="w-4 h-4 text-iron-accent-light" />
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
                plainText={buildMeetingPlainText(titleText, structuredSections, session.summary)}
                sourceApp={`meeting-export:${session.id}`}
              />
            </div>
          )}
          <ShareMenu
            meetingId={session.id}
            text={session.summary}
            onCollaborate={
              onCollaborate ? () => onCollaborate(session.id) : undefined
            }
          />
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
      </button>

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
