/**
 * MeetingEngineGearButton — gear icon + popover for choosing the
 * transcription engine used during meetings. Mounts in two places in
 * MeetingPage:
 *
 *  1. The active-recording toolbar (next to Mic / Collaborate / End).
 *     Selection takes effect on the next 30 s chunk via
 *     `swapMeetingEngineLive()`.
 *
 *  2. The pre-recording header (next to the template / audio device
 *     pickers). Selection just persists `meeting_transcription_engine`;
 *     the swap happens on `applyMeetingEngine()` when the meeting starts.
 *
 * Whisper Large is the recommended default for meetings — accuracy beats
 * latency since meetings process in 30 s+ chunks. Moonshine remains
 * available for users who prefer to keep meetings on the same engine as
 * dictation.
 */

import { useEffect, useRef, useState } from 'react';
import { Settings, Check, AlertCircle, Loader2 } from 'lucide-react';
import { TRANSCRIPTION_ENGINES } from '../../shared/constants';
import { swapMeetingEngineLive } from '../services/meeting/meetingEngineLifecycle';
import { useMeetingStore } from '../stores/useMeetingStore';

interface Props {
  /**
   * `true` when a meeting is actively recording. Determines whether the
   * popover does a live swap (`swapMeetingEngineLive`) vs. only persisting
   * the next-meeting preference.
   */
  isRecording: boolean;
}

const SETTING_MEETING = 'meeting_transcription_engine';

export function MeetingEngineGearButton({ isRecording }: Props) {
  const [open, setOpen] = useState(false);
  const [currentMeetingEngine, setCurrentMeetingEngine] = useState<string | null>(null);
  const [readyMap, setReadyMap] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  // Backend-reported swap state — `busy` is the renderer-side optimistic
  // flag (covers the moment between click and IPC ack); `isEngineSwapping`
  // is the source of truth from MeetingRecorder. Show the spinner while
  // EITHER is true so it never blinks off between the renderer ack and the
  // backend's first push.
  const isEngineSwapping = useMeetingStore((s) => s.isEngineSwapping);
  const remoteCaptureMode = useMeetingStore((s) => s.remoteCaptureMode);
  const showSpinner = busy || (isRecording && isEngineSwapping);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Load current preference and per-engine readiness whenever the popover
  // is opened so disabled rows always reflect the latest download state.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const v = await window.ironmic.getSetting(SETTING_MEETING);
        if (!cancelled) setCurrentMeetingEngine(v);
      } catch {
        if (!cancelled) setCurrentMeetingEngine(null);
      }
      try {
        const entries = await Promise.all(
          TRANSCRIPTION_ENGINES.map(async (e) => {
            try {
              const ok = await window.ironmic.isTranscriptionEngineReady(e.id);
              return [e.id, !!ok] as const;
            } catch {
              return [e.id, false] as const;
            }
          }),
        );
        if (!cancelled) {
          setReadyMap(Object.fromEntries(entries));
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Close on outside click. Bound only while the popover is open so the
  // listener doesn't leak across mounts.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Recommended default appears first in the list. We don't re-order
  // TRANSCRIPTION_ENGINES (it's used elsewhere); we mark the row inline.
  const RECOMMENDED_ID = 'whisper-large-v3-turbo';

  const handleSelect = async (engineId: string) => {
    if (engineId === currentMeetingEngine) {
      setOpen(false);
      return;
    }
    if (readyMap[engineId] === false) {
      // Disabled row — clicked anyway. Tooltip already explains; no-op.
      return;
    }
    setBusy(true);
    setHint(null);
    try {
      if (isRecording) {
        // Live path — swapMeetingEngineLive handles readiness + DB
        // rollback + persistence of both keys. Never throws. After it
        // resolves the native engine is swapped AND the MeetingRecorder
        // has handled its streaming↔chunked mode transition (the IPC
        // handler dispatches handleEngineSwap immediately after).
        await swapMeetingEngineLive(engineId);
        // Set a mode-aware hint so the user knows what to expect. Both
        // engine families behave very differently:
        //   • Moonshine → live grey-typing draft + commits on pause/cap
        //   • Whisper   → silent ~Ns blocks, then a fully-formed segment
        // Without the hint, switching mid-meeting feels broken because
        // the panel doesn't update for many seconds either way.
        const isMoonshine = engineId.startsWith('moonshine');
        setHint(
          isMoonshine
            ? 'Switched to live transcription — next words will appear as you speak.'
            : 'Switched. The next transcript block will appear in ~30 s.',
        );
        // Reflect optimistically; the lifecycle helper may have rolled
        // back on failure, but its toast already explains.
        setCurrentMeetingEngine(engineId);
      } else {
        // Pre-meeting path — just persist the preference. applyMeetingEngine
        // reads this on meeting start.
        await window.ironmic.setSetting(SETTING_MEETING, engineId);
        setCurrentMeetingEngine(engineId);
      }
      // Auto-close after a beat so the user sees the checkmark move.
      // Slightly longer for live swap so the hint is readable.
      window.setTimeout(() => setOpen(false), isRecording ? 2200 : 250);
    } finally {
      setBusy(false);
    }
  };

  // Reset transient hint when the popover closes.
  useEffect(() => {
    if (!open) setHint(null);
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 px-2 py-1.5 lg:px-2.5 text-xs rounded-lg border transition-colors whitespace-nowrap ${
          showSpinner
            ? 'bg-iron-accent/15 text-iron-accent-light border-iron-accent/30'
            : open
              ? 'bg-iron-accent/15 text-iron-accent-light border-iron-accent/20'
              : 'text-iron-text-muted border-iron-border hover:bg-iron-surface-hover'
        }`}
        title={showSpinner ? 'Switching engine…' : 'Meeting transcription engine'}
        aria-label={showSpinner ? 'Switching transcription engine' : 'Meeting transcription engine'}
      >
        {showSpinner ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Settings className="w-3.5 h-3.5" />
        )}
        <span className="hidden lg:inline">{showSpinner ? 'Switching…' : 'Engine'}</span>
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute right-0 mt-2 w-80 bg-iron-surface border border-iron-border rounded-lg shadow-xl z-50 p-2"
          role="dialog"
          aria-label="Meeting transcription engine"
        >
          <p className="px-2 pt-1 pb-2 text-[11px] text-iron-text-muted">
            {isRecording
              ? 'Switching applies on the next 30 s chunk.'
              : 'Used for this and future meetings. Dictation is unaffected.'}
          </p>
          {isRecording && remoteCaptureMode && (
            <p className="mx-2 mb-2 text-[10px] text-amber-400/90 bg-amber-500/5 border border-amber-500/20 rounded-md px-2 py-1.5 leading-snug">
              Remote-meeting capture is on — engines run in chunked mode (no
              live grey-typing). Picking a Moonshine engine still works, but
              dual-stream streaming is deferred to a future release.
            </p>
          )}
          <div className="flex flex-col gap-1">
            {TRANSCRIPTION_ENGINES.map((e) => {
              const isSelected = e.id === currentMeetingEngine;
              const isRecommended = e.id === RECOMMENDED_ID;
              const isReady = readyMap[e.id] !== false; // optimistic default
              return (
                <button
                  key={e.id}
                  onClick={() => handleSelect(e.id)}
                  disabled={busy || !isReady}
                  className={`text-left px-3 py-2 rounded-md border transition-colors ${
                    isSelected
                      ? 'bg-iron-accent/15 border-iron-accent/30'
                      : 'border-transparent hover:bg-iron-surface-hover'
                  } ${!isReady ? 'opacity-50 cursor-not-allowed' : ''}`}
                  title={!isReady ? 'Model not downloaded — open the Model Manager to install it.' : undefined}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-iron-text truncate">
                          {e.label}
                        </span>
                        {isRecommended && (
                          <span className="text-[9px] uppercase tracking-wider text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded">
                            Recommended
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-iron-text-muted mt-0.5">
                        {e.description}
                      </p>
                      <p className="text-[10px] text-iron-text-muted/80 mt-0.5">
                        {e.sizeLabel} · {e.latencyHint}
                      </p>
                      {!isReady && (
                        <p className="text-[10px] text-amber-300/80 mt-1 flex items-center gap-1">
                          <AlertCircle className="w-3 h-3" />
                          Not downloaded — install in Settings → Models
                        </p>
                      )}
                    </div>
                    {isSelected && (
                      <Check className="w-4 h-4 text-iron-accent-light shrink-0 mt-0.5" />
                    )}
                  </div>
                </button>
              );
            })}
          </div>
          {showSpinner && (
            <div className="px-2 pt-2 flex items-center gap-1.5 text-[11px] text-iron-accent-light">
              <Loader2 className="w-3 h-3 animate-spin shrink-0" />
              <span>Switching engine — recording continues. Audio is preserved.</span>
            </div>
          )}
          {hint && !showSpinner && (
            <p className="px-2 pt-2 text-[11px] text-emerald-400">
              {hint}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
