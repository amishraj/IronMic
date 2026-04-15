import { useState } from 'react';
import { Clock, Users, Trash2, ChevronDown, ChevronRight, Mic } from 'lucide-react';
import { Card } from './ui';
import { ShareMenu } from './ShareMenu';

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
}

export function MeetingSessionCard({ session, onDelete }: Props) {
  const [expanded, setExpanded] = useState(false);

  const date = new Date(session.started_at).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const duration = session.total_duration_seconds
    ? `${Math.round(session.total_duration_seconds / 60)} min`
    : '';

  // Try to parse structured output
  let structuredSections: Array<{ key: string; title: string; content: string }> | null = null;
  if (session.structured_output) {
    try {
      const parsed = JSON.parse(session.structured_output);
      structuredSections = parsed.sections || null;
    } catch { /* fallback to summary */ }
  }

  return (
    <Card variant="default" padding="none" className="animate-fade-in">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-iron-surface-hover/50 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-iron-accent/10 flex items-center justify-center flex-shrink-0">
            <Mic className="w-4 h-4 text-iron-accent-light" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-iron-text truncate">
              {session.detected_app
                ? `${session.detected_app.charAt(0).toUpperCase() + session.detected_app.slice(1)} Meeting`
                : 'Meeting'}
            </p>
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
          <ShareMenu meetingId={session.id} text={session.summary} />
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(session.id); }}
            className="p-1.5 rounded-lg text-iron-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
            title="Delete"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          {expanded ? <ChevronDown className="w-4 h-4 text-iron-text-muted" /> : <ChevronRight className="w-4 h-4 text-iron-text-muted" />}
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-iron-border/50">
          {structuredSections ? (
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
