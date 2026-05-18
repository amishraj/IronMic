import { Loader2, Mic, Check } from 'lucide-react';
import { Card } from './ui';
import type { PendingEntry } from '../stores/useEntryStore';

interface Props {
  pending: PendingEntry;
}

export function PendingEntryCard({ pending }: Props) {
  const time = new Date(pending.startedAt).toLocaleString();

  return (
    <Card variant="highlighted" padding="none" className="animate-fade-in border-iron-accent/20">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <div className="flex items-center gap-2 text-[11px] text-iron-text-muted">
          <Mic className="w-3 h-3" />
          <span>{time}</span>
        </div>
      </div>

      {/* Progress */}
      <div className="px-4 pb-3 space-y-3">
        <StageRow
          label="Transcribing speech"
          status={pending.stage === 'transcribing' ? 'active' : 'done'}
        />

        {/* Show raw transcript as soon as available */}
        {pending.rawTranscript && (
          <div className="text-sm leading-relaxed whitespace-pre-wrap text-iron-text pl-6">
            {pending.rawTranscript}
          </div>
        )}

        {pending.stage === 'complete' && (
          <StageRow label="Copied to clipboard" status="done" />
        )}
      </div>
    </Card>
  );
}

function StageRow({ label, status }: { label: string; status: 'active' | 'done' }) {
  return (
    <div className="flex items-center gap-2">
      {status === 'active' && (
        <Loader2 className="w-4 h-4 text-iron-accent animate-spin flex-shrink-0" />
      )}
      {status === 'done' && (
        <Check className="w-4 h-4 text-green-400 flex-shrink-0" />
      )}
      <span className={`text-xs ${
        status === 'active' ? 'text-iron-accent-light font-medium' : 'text-green-400'
      }`}>
        {label}
      </span>
    </div>
  );
}
