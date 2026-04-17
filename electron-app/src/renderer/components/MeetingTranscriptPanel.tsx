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
}

// Stable color palette for speaker badges — cycles for > 6 speakers
const SPEAKER_COLORS = [
  'bg-blue-100 text-blue-700',
  'bg-green-100 text-green-700',
  'bg-purple-100 text-purple-700',
  'bg-orange-100 text-orange-700',
  'bg-pink-100 text-pink-700',
  'bg-teal-100 text-teal-700',
];

function getSpeakerColor(label: string): string {
  // Extract the numeric part of "Speaker N" or participant name hash
  const match = label.match(/(\d+)$/);
  const index = match ? (parseInt(match[1], 10) - 1) : label.charCodeAt(0) % SPEAKER_COLORS.length;
  return SPEAKER_COLORS[index % SPEAKER_COLORS.length];
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

export function MeetingTranscriptPanel({ segments, isLive }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);

  // Auto-scroll to bottom when new segments arrive, unless user scrolled up
  useEffect(() => {
    if (!userScrolledUpRef.current && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [segments.length]);

  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;
    const isAtBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 40;
    userScrolledUpRef.current = !isAtBottom;
  };

  if (segments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center py-12 px-4">
        <Mic className="w-8 h-8 text-gray-300 mb-3" />
        <p className="text-sm text-gray-400">
          {isLive ? 'Listening… transcript will appear here.' : 'No transcript segments yet.'}
        </p>
        {isLive && (
          <p className="text-xs text-gray-300 mt-1">Segments appear every 30 seconds.</p>
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
      {segments.map((segment) => (
        <div key={segment.id} className="group">
          <div className="flex items-start gap-2">
            {/* Timestamp */}
            <span className="text-xs text-gray-400 font-mono mt-0.5 shrink-0 w-12">
              {formatMs(segment.start_ms)}
            </span>
            {/* Speaker badge */}
            {segment.speaker_label ? (
              <span
                className={`text-xs font-medium px-1.5 py-0.5 rounded shrink-0 ${getSpeakerColor(segment.speaker_label)}`}
              >
                {segment.speaker_label}
              </span>
            ) : (
              <span className="text-xs font-medium px-1.5 py-0.5 rounded shrink-0 bg-gray-100 text-gray-500">
                –
              </span>
            )}
            {/* Transcript text */}
            <p className="text-sm text-gray-800 leading-relaxed flex-1">{segment.text}</p>
          </div>
        </div>
      ))}

      {/* Live pulse indicator */}
      {isLive && (
        <div className="flex items-center gap-2 text-xs text-gray-400 py-2">
          <span className="inline-block w-2 h-2 rounded-full bg-red-400 animate-pulse" />
          Recording…
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
