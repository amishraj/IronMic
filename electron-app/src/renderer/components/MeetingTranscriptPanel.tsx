import { memo, useEffect, useRef, useState } from 'react';
import { Mic, Clock } from 'lucide-react';

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

/**
 * Chunked-mode pacing indicator. Shows when the next ~30 s transcript
 * block is expected to arrive — without it, switching from Moonshine to
 * Whisper mid-meeting looks broken because the panel goes silent for the
 * full chunk window.
 *
 * Resets to `chunkIntervalSec` whenever a new segment lands (we observe
 * this via the prop change in the parent) — so the countdown always
 * reflects the gap until the NEXT chunk, not since meeting start.
 *
 * `lastSegmentTick` is incremented by the parent whenever `segments.length`
 * goes up. We don't read `segments` directly here to keep the prop surface
 * narrow.
 */
function ChunkCountdown({
  lastSegmentTick,
  chunkIntervalSec,
  hasSegments,
}: {
  lastSegmentTick: number;
  chunkIntervalSec: number;
  hasSegments: boolean;
}) {
  const [secondsLeft, setSecondsLeft] = useState(chunkIntervalSec);

  useEffect(() => {
    setSecondsLeft(chunkIntervalSec);
    const id = window.setInterval(() => {
      setSecondsLeft((s) => (s > 0 ? s - 1 : chunkIntervalSec));
    }, 1000);
    return () => window.clearInterval(id);
  }, [lastSegmentTick, chunkIntervalSec]);

  return (
    <div className="flex items-center gap-1.5 text-[10px] text-iron-text-muted/80 px-2 py-1 rounded bg-iron-surface-hover/40 mb-2 w-fit">
      <Clock className="w-3 h-3" />
      <span>
        {hasSegments ? 'Next block in' : 'First block in'} ~{secondsLeft}s
      </span>
    </div>
  );
}

/**
 * Inner component — receives all props by value. Wrapped in React.memo
 * below so the panel only re-renders when its own props actually change.
 *
 * Why this matters: MeetingPage triggers many re-renders during a live
 * meeting (timer tick every 1 s, status flags toggling, live summary
 * updates every chunk). Without memoization, every parent re-render
 * rebuilds the transcript list — which is expensive at 50+ segments
 * because the speaker-color lookup and timestamp formatting run for
 * every row. On Windows machines that are already CPU-bound on Whisper
 * inference, this shows up as visible UI jank.
 *
 * `streamingMode` and `isLive` flip rarely; `draftHypothesis` updates
 * frequently (every ~200 ms in streaming mode) but causes only the
 * draft line to re-render, not the whole list (segments is reference-
 * equal across draft-only updates). `segments` is appended in place
 * by Zustand so its reference DOES change on commit — that's the
 * intentional re-render trigger.
 */
function MeetingTranscriptPanelInner({ segments, isLive, draftHypothesis, streamingMode }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);

  const draft = (draftHypothesis ?? '').trim();
  const showDraft = isLive && draft.length > 0;

  // Chunked-mode indicator gate. Live chunked path's typical interval is
  // 15–30 s (Whisper meeting setting). The user-facing copy uses ~30 s
  // because that's what the gear popover advertises and what most users
  // will run. The countdown resets on every new segment (parent-driven
  // tick) so the displayed value is always "time until the NEXT block".
  const showChunkCountdown = isLive && !streamingMode;
  const CHUNK_INTERVAL_SEC = 30;

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
              : `Segments appear every ~${CHUNK_INTERVAL_SEC} seconds.`}
          </p>
        )}
        {showChunkCountdown && (
          <div className="mt-3">
            <ChunkCountdown
              lastSegmentTick={0}
              chunkIntervalSec={CHUNK_INTERVAL_SEC}
              hasSegments={false}
            />
          </div>
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

      {/* Chunked-mode countdown — only shown when isLive AND non-streaming.
          The lastSegmentTick uses segments.length so the timer resets each
          time a new chunk arrives (mirroring user expectation: "how long
          until the next block"). */}
      {showChunkCountdown && (
        <ChunkCountdown
          lastSegmentTick={segments.length}
          chunkIntervalSec={CHUNK_INTERVAL_SEC}
          hasSegments={true}
        />
      )}

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

/**
 * Public export — memoized so re-renders are gated on actual prop change.
 * See MeetingTranscriptPanelInner doc-comment for rationale.
 */
export const MeetingTranscriptPanel = memo(MeetingTranscriptPanelInner);
