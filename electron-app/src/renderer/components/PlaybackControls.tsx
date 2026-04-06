import { Play, Pause, Square, Volume2 } from 'lucide-react';
import { useTtsStore } from '../stores/useTtsStore';

interface PlaybackControlsProps {
  text: string;
  entryId?: string;
  compact?: boolean;
}

const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

export function PlaybackControls({ text, entryId, compact }: PlaybackControlsProps) {
  const { state, currentTimeMs, durationMs, speed, activeEntryId, synthesizeAndPlay, pause, play, stop, setSpeed } =
    useTtsStore();

  const isThisEntry = activeEntryId === entryId || (!entryId && state !== 'idle');
  const isPlaying = isThisEntry && state === 'playing';
  const isPaused = isThisEntry && state === 'paused';
  const isSynthesizing = isThisEntry && state === 'synthesizing';
  const isActive = isPlaying || isPaused || isSynthesizing;

  const handlePlayPause = async () => {
    if (isPlaying) {
      await pause();
    } else if (isPaused) {
      await play();
    } else {
      await synthesizeAndPlay(text, entryId);
    }
  };

  const handleStop = async () => {
    await stop();
  };

  const progressPercent = durationMs > 0 ? Math.min((currentTimeMs / durationMs) * 100, 100) : 0;

  if (compact) {
    return (
      <button
        onClick={handlePlayPause}
        disabled={isSynthesizing}
        className={`p-1.5 rounded-lg transition-all ${
          isPlaying
            ? 'text-iron-accent-light bg-iron-accent/15'
            : 'text-iron-text-muted hover:text-iron-text-secondary hover:bg-iron-surface-hover'
        } disabled:opacity-40`}
        title={isPlaying ? 'Pause' : 'Play'}
      >
        {isSynthesizing ? (
          <div className="w-3.5 h-3.5 border-2 border-iron-accent border-t-transparent rounded-full animate-spin" />
        ) : isPlaying ? (
          <Pause className="w-3.5 h-3.5" />
        ) : (
          <Volume2 className="w-3.5 h-3.5" />
        )}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {/* Play/Pause */}
      <button
        onClick={handlePlayPause}
        disabled={isSynthesizing}
        className={`p-1.5 rounded-lg transition-all ${
          isPlaying
            ? 'text-iron-accent-light bg-iron-accent/15'
            : 'text-iron-text-muted hover:text-iron-text-secondary hover:bg-iron-surface-hover'
        } disabled:opacity-40`}
        title={isPlaying ? 'Pause' : 'Play'}
      >
        {isSynthesizing ? (
          <div className="w-4 h-4 border-2 border-iron-accent border-t-transparent rounded-full animate-spin" />
        ) : isPlaying ? (
          <Pause className="w-4 h-4" />
        ) : (
          <Play className="w-4 h-4" />
        )}
      </button>

      {/* Stop */}
      {isActive && (
        <button
          onClick={handleStop}
          className="p-1.5 rounded-lg text-iron-text-muted hover:text-iron-danger hover:bg-iron-danger/10 transition-all"
          title="Stop"
        >
          <Square className="w-3.5 h-3.5" />
        </button>
      )}

      {/* Progress bar */}
      {isActive && (
        <div className="flex-1 min-w-[60px] h-1 bg-iron-surface-active rounded-full overflow-hidden">
          <div
            className="h-full bg-iron-accent rounded-full transition-all duration-100"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      )}

      {/* Speed */}
      {isActive && (
        <select
          value={speed}
          onChange={(e) => setSpeed(parseFloat(e.target.value))}
          className="text-[10px] bg-iron-bg border border-iron-border rounded px-1 py-0.5 text-iron-text-muted appearance-none cursor-pointer"
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
