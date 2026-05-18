import { Mic, Loader2, MicOff } from 'lucide-react';
import { useRecordingStore } from '../stores/useRecordingStore';
import { useMeetingStore } from '../stores/useMeetingStore';
import { useDictationStore } from '../stores/useDictationStore';

export function RecordingIndicator() {
  const { state, error } = useRecordingStore();
  const isGranolaRecording = useMeetingStore(s => s.isGranolaRecording);
  const isMicMuted = useMeetingStore(s => s.isMicMuted);
  const processingMeetings = useMeetingStore(s => s.processingMeetings);
  // Streaming dictation lives in its own store — the legacy useRecordingStore
  // stays idle for the streaming pipeline, so without this the top-bar pill
  // shows "Idle" while the user is actively dictating.
  const dictationStatus = useDictationStore(s => s.status);

  // Whichever capture/inference is actually running wins. Meeting (Granola)
  // and streaming dictation are independent pipelines; either should drive
  // the indicator out of idle.
  let effectiveState: 'idle' | 'recording' | 'processing' = state;
  let effectiveLabel: string | null = null;
  // When a meeting is active OR generating notes, clicking the pill should
  // take the user back to the live meeting page. When dictating, jump back
  // to the notes editor. Idle pills are not clickable.
  let navigateTarget: 'meetings' | 'dictate' | null = null;
  if (isGranolaRecording) {
    effectiveState = 'recording';
    effectiveLabel = isMicMuted ? 'Meeting · Muted' : 'Meeting';
    navigateTarget = 'meetings';
  } else if (dictationStatus === 'recording') {
    effectiveState = 'recording';
    effectiveLabel = 'Dictating';
    navigateTarget = 'dictate';
  } else if (dictationStatus === 'stopping') {
    effectiveState = 'processing';
    effectiveLabel = 'Finalizing';
    navigateTarget = 'dictate';
  } else if (processingMeetings.length > 0 && state === 'idle') {
    effectiveState = 'processing';
    effectiveLabel = 'Generating notes';
    navigateTarget = 'meetings';
  }

  // Meeting recording: swap the Mic glyph for MicOff so the pill itself
  // reflects self-mute at a glance — no need to navigate to the meeting page.
  const recordingIcon = isGranolaRecording && isMicMuted
    ? <MicOff className="w-4 h-4" />
    : <Mic className="w-4 h-4" />;

  const config = {
    idle: {
      icon: <MicOff className="w-4 h-4" />,
      label: 'Idle',
      classes: 'bg-iron-surface-active text-iron-text-muted',
    },
    recording: {
      icon: recordingIcon,
      label: 'Recording',
      classes: 'bg-iron-danger/15 text-iron-danger border border-iron-danger/20 shadow-glow-danger animate-pulse-recording',
    },
    processing: {
      icon: <Loader2 className="w-4 h-4 animate-spin" />,
      label: 'Processing',
      classes: 'bg-iron-warning/15 text-iron-warning border border-iron-warning/20',
    },
  }[effectiveState];

  const handleClick = () => {
    if (!navigateTarget) return;
    window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: navigateTarget }));
  };

  const interactive = navigateTarget !== null;

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={handleClick}
        disabled={!interactive}
        title={
          navigateTarget === 'meetings'
            ? 'Back to meeting'
            : navigateTarget === 'dictate'
              ? 'Back to dictation'
              : undefined
        }
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-300 ${config.classes} ${
          interactive ? 'cursor-pointer hover:brightness-110' : 'cursor-default'
        }`}
      >
        {config.icon}
        <span>{effectiveLabel ?? config.label}</span>
      </button>
      {error && (
        <span className="text-[11px] text-iron-danger max-w-[200px] truncate" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
