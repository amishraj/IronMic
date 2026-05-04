import { useEffect, useRef } from 'react';
import { Mic } from 'lucide-react';

export interface TranscriptSegment {
  id: string;
  session_id: string;
  speaker_label: string | null;
  start_ms: number;
  end_ms: number;
  text: string;
  source: string;
  participant_id: string | null;
  confidence: number | null;
  created_at: string;
}

interface Props {
  segments: TranscriptSegment[];
  isLive: boolean;
  /** Live Moonshine hypothesis — rendered as grey italic text while the user
   *  is mid-utterance. Empty when no draft is in flight. */
  draftHypothesis?: string;
  /** True when the recorder is using the Moonshine streaming session path.
   *  Drives the empty-state copy: streaming → "words appear as you speak",
   *  chunked → "segments every ~15 seconds". */
  streamingMode?: boolean;
}

// Stable color palette for OTHER speakers' badges — cycles for > 5 speakers.
// Green is reserved for the local user ("Me"); never appears in this rotation.
const SPEAKER_COLORS = [
  'bg-blue-100 text-blue-700',
  'bg-purple-100 text-purple-700',
  'bg-orange-100 text-orange-700',
  'bg-pink-100 text-pink-700',
  'bg-teal-100 text-teal-700',
];

const ME_COLOR = 'bg-green-100 text-green-700';

function getSpeakerColor(label: string): string {
  // Extract the numeric part of "Speaker N" or participant name hash
  const match = label.match(/(\d+)$/);
  const index = match ? (parseInt(match[1], 10) - 1) : label.charCodeAt(0) % SPEAKER_COLORS.length;
  return SPEAKER_COLORS[index % SPEAKER_COLORS.length];
}

/** A segment is "mine" (produced by this machine's mic) when its source is
 *  neither a broadcast received from the host nor a `participant:<name>`
 *  segment forwarded from another room peer. */
function isOwnSegment(seg: TranscriptSegment): boolean {
  const src = seg.source ?? '';
  if (src === 'broadcast') return false;
  if (src.startsWith('participant:')) return false;
  return true;
}

function formatMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function DraftLine({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 italic" style={{ opacity: 0.55 }}>
      <span className="text-xs text-iron-text-muted font-mono mt-0.5 shrink-0 w-12">--:--</span>
      <span className={`text-xs font-medium px-1.5 py-0.5 rounded shrink-0 ${ME_COLOR}`}>
        Me
      </span>
      <p className="text-sm text-iron-text leading-relaxed flex-1">{text}</p>
    </div>
  );
}

export function MeetingTranscriptPanel({ segments, isLive, draftHypothesis, streamingMode }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);

  const draft = (draftHypothesis ?? '').trim();
  const showDraft = isLive && draft.length > 0;

  // Auto-scroll to bottom when new segments OR a draft update arrives,
  // unless the user has scrolled up to read history.
  useEffect(() => {
    if (!userScrolledUpRef.current && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [segments.length, draft]);

  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;
    const isAtBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 40;
    userScrolledUpRef.current = !isAtBottom;
  };

  // Empty state — no committed segments yet. Still render the draft line
  // here so the user sees grey-typing on the very first utterance, before
  // the first commit lands.
  if (segments.length === 0) {
    if (showDraft) {
      return (
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto space-y-3 pr-1"
        >
          <DraftLine text={draft} />
          <div ref={bottomRef} />
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center h-full text-center py-12 px-4">
        <Mic className="w-8 h-8 text-iron-text-muted/60 mb-3" />
        <p className="text-sm text-iron-text-muted">
          {isLive ? 'Listening… transcript will appear here.' : 'No transcript segments yet.'}
        </p>
        {isLive && (
          <p className="text-xs text-iron-text-muted/80 mt-1">
            {streamingMode
              ? 'Live transcription — words appear as you speak.'
              : 'Segments appear every ~15 seconds.'}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="h-full overflow-y-auto space-y-3 pr-1"
    >
      {segments.map((segment) => {
        const own = isOwnSegment(segment);
        const badgeText = own ? 'Me' : segment.speaker_label;
        const badgeClass = own
          ? ME_COLOR
          : segment.speaker_label
            ? getSpeakerColor(segment.speaker_label)
            : 'bg-iron-surface-hover text-iron-text-muted';
        return (
          <div key={segment.id} className="group">
            <div className="flex items-start gap-2">
              {/* Timestamp */}
              <span className="text-xs text-iron-text-muted font-mono mt-0.5 shrink-0 w-12">
                {formatMs(segment.start_ms)}
              </span>
              {/* Speaker badge */}
              <span
                className={`text-xs font-medium px-1.5 py-0.5 rounded shrink-0 ${badgeClass}`}
              >
                {badgeText ?? '–'}
              </span>
              {/* Transcript text */}
              <p className="text-sm text-iron-text leading-relaxed flex-1">{segment.text}</p>
            </div>
          </div>
        );
      })}

      {/* Live grey-typing line — appears below the latest committed segment */}
      {showDraft && <DraftLine text={draft} />}

      {/* Live pulse indicator */}
      {isLive && (
        <div className="flex items-center gap-2 text-xs text-iron-text-muted py-2">
          <span className="inline-block w-2 h-2 rounded-full bg-red-400 animate-pulse" />
          Recording…
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
