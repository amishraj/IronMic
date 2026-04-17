import { Mic, Loader2, MicOff } from 'lucide-react';
import { useRecordingStore } from '../stores/useRecordingStore';
import { useMeetingStore } from '../stores/useMeetingStore';

export function RecordingIndicator() {
  const { state, error } = useRecordingStore();
  const isGranolaRecording = useMeetingStore(s => s.isGranolaRecording);
  const processingMeetings = useMeetingStore(s => s.processingMeetings);

  // Meeting pipeline (Granola mode) overrides dictation state when active —
  // the top bar should reflect whichever capture/inference is actually running.
  let effectiveState: 'idle' | 'recording' | 'processing' = state;
  let effectiveLabel: string | null = null;
  if (isGranolaRecording) {
    effectiveState = 'recording';
    effectiveLabel = 'Meeting';
  } else if (processingMeetings.length > 0 && state === 'idle') {
    effectiveState = 'processing';
    effectiveLabel = 'Generating notes';
  }

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
  }[effectiveState];

  return (
    <div className="flex items-center gap-3">
      <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-300 ${config.classes}`}>
        {config.icon}
        <span>{effectiveLabel ?? config.label}</span>
      </div>
      {error && (
        <span className="text-[11px] text-iron-danger max-w-[200px] truncate" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
