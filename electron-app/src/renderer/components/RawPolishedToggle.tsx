import { Loader2 } from 'lucide-react';

export type PolishProvider = 'claude' | 'copilot' | 'local';

interface RawPolishedToggleProps {
  displayMode: 'raw' | 'polished';
  onToggle: (next: 'raw' | 'polished') => void;
  isPolishing?: boolean;
  providerBadge?: PolishProvider;
}

const providerLabel: Record<PolishProvider, string> = {
  claude: 'via Claude',
  copilot: 'via Copilot',
  local: 'via local',
};

const RAW_W = 52;
const POL_W = 64;
const PAD = 2;
const BTN_H = 24;

export function RawPolishedToggle({
  displayMode,
  onToggle,
  isPolishing,
  providerBadge,
}: RawPolishedToggleProps) {
  const isPolished = displayMode === 'polished';

  const select = (next: 'raw' | 'polished') => {
    if (isPolishing) return;
    if (next === displayMode) return;
    onToggle(next);
  };

  return (
    <div className="flex items-center gap-2">
      {isPolishing && (
        <Loader2 className="w-3.5 h-3.5 animate-spin text-iron-accent-light flex-shrink-0" />
      )}
      <div
        role="group"
        aria-label="Display mode"
        aria-disabled={isPolishing}
        className={`relative inline-flex bg-iron-surface border border-iron-border rounded-full ${
          isPolishing ? 'opacity-80 cursor-wait' : ''
        }`}
        style={{ padding: PAD }}
      >
        <span
          aria-hidden="true"
          className={`absolute rounded-full transition-all duration-200 ease-out ${
            isPolished ? 'bg-iron-accent/20' : 'bg-iron-bg'
          }`}
          style={{
            top: PAD,
            bottom: PAD,
            width: isPolished ? POL_W : RAW_W,
            left: isPolished ? PAD + RAW_W : PAD,
          }}
        />

        <button
          type="button"
          onClick={() => select('raw')}
          disabled={isPolishing}
          aria-pressed={!isPolished}
          className={`relative z-10 rounded-full text-[11px] font-medium transition-colors ${
            isPolishing ? 'cursor-wait' : 'cursor-pointer'
          } ${
            !isPolished
              ? 'text-iron-text'
              : 'text-iron-text-muted hover:text-iron-text-secondary'
          }`}
          style={{ width: RAW_W, height: BTN_H }}
        >
          Raw
        </button>

        <button
          type="button"
          onClick={() => select('polished')}
          disabled={isPolishing}
          aria-pressed={isPolished}
          className={`relative z-10 rounded-full text-[11px] font-medium transition-colors inline-flex items-center justify-center ${
            isPolishing ? 'cursor-wait' : 'cursor-pointer'
          } ${
            isPolished
              ? 'text-iron-accent-light'
              : 'text-iron-text-muted hover:text-iron-text-secondary'
          }`}
          style={{ width: POL_W, height: BTN_H }}
        >
          Polished
        </button>
      </div>

      {!isPolishing && providerBadge && isPolished && (
        <span className="text-[10px] text-iron-text-muted whitespace-nowrap">
          {providerLabel[providerBadge]}
        </span>
      )}
    </div>
  );
}
