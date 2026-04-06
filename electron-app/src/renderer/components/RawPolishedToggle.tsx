interface RawPolishedToggleProps {
  displayMode: 'raw' | 'polished';
  hasPolished: boolean;
  onToggle: () => void;
  onPolishNow?: () => void;
}

export function RawPolishedToggle({ displayMode, hasPolished, onToggle, onPolishNow }: RawPolishedToggleProps) {
  if (!hasPolished && onPolishNow) {
    return (
      <button
        onClick={onPolishNow}
        className="text-[11px] text-iron-accent-light hover:text-iron-accent font-medium transition-colors"
      >
        Polish now
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
