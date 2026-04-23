import { Loader2, Sparkles } from 'lucide-react';

interface RawPolishedToggleProps {
  displayMode: 'raw' | 'polished';
  hasPolished: boolean;
  onToggle: () => void;
  onPolishNow?: () => void;
  /** When true, the polish pass is in flight. The button is disabled and
   *  shows a spinner so the user knows the LLM is working on it. */
  isPolishing?: boolean;
}

export function RawPolishedToggle({
  displayMode,
  hasPolished,
  onToggle,
  onPolishNow,
  isPolishing,
}: RawPolishedToggleProps) {
  if (!hasPolished && onPolishNow) {
    return (
      <button
        onClick={isPolishing ? undefined : onPolishNow}
        disabled={isPolishing}
        className={`flex items-center gap-1 text-[11px] font-medium transition-colors ${
          isPolishing
            ? 'text-iron-accent-light/70 cursor-wait'
            : 'text-iron-accent-light hover:text-iron-accent'
        }`}
        title={isPolishing ? 'Running local LLM…' : 'Run local LLM to clean up this transcript'}
      >
        {isPolishing ? (
          <>
            <Loader2 className="w-3 h-3 animate-spin" />
            Polishing…
          </>
        ) : (
          <>
            <Sparkles className="w-3 h-3" />
            Polish now
          </>
        )}
      </button>
    );
  }

  if (!hasPolished) return null;

  return (
    <button
      onClick={onToggle}
      className="text-[11px] text-iron-text-muted hover:text-iron-text-secondary font-medium transition-colors"
    >
      {displayMode === 'polished' ? 'Show raw' : 'Show polished'}
    </button>
  );
}
