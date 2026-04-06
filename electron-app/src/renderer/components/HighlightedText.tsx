import { useMemo } from 'react';

interface WordTimestamp {
  word: string;
  start_ms: number;
  end_ms: number;
}

interface HighlightedTextProps {
  text: string;
  timestamps: WordTimestamp[];
  currentTimeMs: number;
  isPlaying: boolean;
}

export function HighlightedText({ text, timestamps, currentTimeMs, isPlaying }: HighlightedTextProps) {
  // If not playing or no timestamps, render plain text
  if (!isPlaying || timestamps.length === 0) {
    return <span>{text}</span>;
  }

  const activeIndex = useMemo(() => {
    // Binary search for the active word
    for (let i = 0; i < timestamps.length; i++) {
      if (currentTimeMs >= timestamps[i].start_ms && currentTimeMs < timestamps[i].end_ms) {
        return i;
      }
    }
    return -1;
  }, [timestamps, currentTimeMs]);

  return (
    <span>
      {timestamps.map((ts, i) => {
        const isActive = i === activeIndex;
        const isPast = i < activeIndex;

        return (
          <span
            key={i}
            className={`transition-colors duration-100 ${
              isActive
                ? 'bg-iron-accent/20 text-iron-accent-light rounded px-0.5'
                : isPast
                ? 'text-iron-text-secondary'
                : 'text-iron-text'
            }`}
          >
            {ts.word}{i < timestamps.length - 1 ? ' ' : ''}
          </span>
        );
      })}
    </span>
  );
}
