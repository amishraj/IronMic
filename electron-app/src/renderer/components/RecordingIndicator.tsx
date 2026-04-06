import { Mic, Loader2, MicOff } from 'lucide-react';
import { useRecordingStore } from '../stores/useRecordingStore';

export function RecordingIndicator() {
  const { state, error } = useRecordingStore();

  const config = {
    idle: {
      icon: <MicOff className="w-4 h-4" />,
      label: 'Idle',
      classes: 'bg-iron-surface-active text-iron-text-muted',
    },
    recording: {
      icon: <Mic className="w-4 h-4" />,
      label: 'Recording',
      classes: 'bg-iron-danger/15 text-iron-danger border border-iron-danger/20 shadow-glow-danger animate-pulse-recording',
    },
    processing: {
      icon: <Loader2 className="w-4 h-4 animate-spin" />,
      label: 'Processing',
      classes: 'bg-iron-warning/15 text-iron-warning border border-iron-warning/20',
    },
  }[state];

  return (
    <div className="flex items-center gap-3">
      <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-300 ${config.classes}`}>
        {config.icon}
        <span>{config.label}</span>
      </div>
      {error && (
        <span className="text-[11px] text-iron-danger max-w-[200px] truncate" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
