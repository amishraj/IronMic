import { Volume2 } from 'lucide-react';
import { useTtsStore } from '../stores/useTtsStore';

/**
 * Word-by-word caption for an active read-back of a given note. Editors that
 * can't be highlighted in place (TipTap's rich text DOM, plain `<textarea>`)
 * surface playback context as a sticky strip above the editable area instead.
 *
 * Renders nothing when no read-back is in progress for this note.
 */
export function NoteTtsCaption({ noteId }: { noteId: string | null }) {
  const { state, timestamps, currentTimeMs, activeEntryId, durationMs } = useTtsStore();
  const isThisNote = !!noteId && activeEntryId === noteId;
  if (!isThisNote || (state !== 'playing' && state !== 'paused')) return null;

  // Find the active word index by binary-search style scan. Mirrors
  // HighlightedText.tsx — kept local to avoid coupling to that component
  // which is built around plain-text rendering.
  let activeIdx = -1;
  for (let i = 0; i < timestamps.length; i += 1) {
    const t = timestamps[i];
    if (currentTimeMs >= t.start_ms && currentTimeMs < t.end_ms) {
      activeIdx = i;
      break;
    }
    if (currentTimeMs < t.start_ms) {
      activeIdx = i - 1;
      break;
    }
  }
  if (activeIdx === -1 && timestamps.length > 0 && currentTimeMs >= timestamps[timestamps.length - 1].end_ms) {
    activeIdx = timestamps.length - 1;
  }

  // Show 4 words before and 8 after the active word for context.
  const start = Math.max(0, activeIdx - 4);
  const end = Math.min(timestamps.length, Math.max(activeIdx + 9, start + 12));
  const window = timestamps.slice(start, end);

  const progress = durationMs > 0 ? Math.min(100, (currentTimeMs / durationMs) * 100) : 0;
  const stateLabel = state === 'paused' ? 'Paused' : 'Reading aloud';

  return (
    <div className="border-b border-iron-border bg-emerald-500/5">
      <div className="flex items-center gap-3 px-4 py-2">
        <div className="flex items-center gap-1.5 text-[10px] font-medium text-emerald-400 flex-shrink-0">
          <Volume2 className="w-3 h-3" />
          {stateLabel}
        </div>
        <div className="flex-1 min-w-0 text-sm leading-relaxed truncate">
          {window.length === 0 ? (
            <span className="text-iron-text-muted italic">Synthesizing…</span>
          ) : (
            window.map((t, i) => {
              const idx = start + i;
              const isActive = idx === activeIdx;
              const isPast = idx < activeIdx;
              return (
                <span
                  key={`${idx}-${t.word}`}
                  className={
                    isActive
                      ? 'bg-emerald-500/25 text-emerald-200 px-1 rounded'
                      : isPast
                      ? 'text-iron-text-muted'
                      : 'text-iron-text'
                  }
                >
                  {i > 0 ? ' ' : ''}{t.word}
                </span>
              );
            })
          )}
        </div>
      </div>
      <div className="h-0.5 bg-iron-surface-active">
        <div className="h-full bg-emerald-500 transition-all duration-100" style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}
