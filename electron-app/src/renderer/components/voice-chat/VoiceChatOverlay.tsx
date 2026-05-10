import { useEffect, useMemo, useRef, useState } from 'react';
import { Mic, X } from 'lucide-react';
import { useTtsStore } from '../../stores/useTtsStore';

type Engine = 'moonshine-session' | 'moonshine-chunked' | 'whisper-chunked' | 'unknown';
type Provider = 'copilot' | 'claude' | 'local' | null;

export interface VoiceChatOverlayProps {
  micState: 'idle' | 'recording' | 'stopping';
  loading: boolean;             // AI is generating a response
  streaming: string;            // live AI tokens
  draftText: string;            // grey hypothesis from streamer
  committedText: string;        // committed user-turn-so-far (mirrors `input`)
  engine: Engine;
  lastAiReply: string | null;   // last assistant message content (for caption)
  /** Active AI provider — surfaced as a "via …" badge so the user always sees
   *  where each turn went, especially after opting into cloud Voice Chat. */
  provider: Provider;
  onClose: () => void;
  onMicClick: () => void;       // toggle off (kept for parity with mic button)
}

type Phase = 'listening' | 'thinking' | 'speaking' | 'idle';

const BAR_COUNT = 40;

/**
 * Voice Chat overlay — focused, centered listening surface for the
 * conversational loop. Displays:
 *   - phase pill (Listening… / Thinking… / Speaking…)
 *   - synthetic 40-bar waveform driven off phase (no real audio tap in v1)
 *   - committed transcript + grey-italic draft tail
 *   - last AI reply caption (so the user has visual context for what's being spoken)
 *   - manual-fallback banner when engine doesn't support hands-free EOT
 */
export function VoiceChatOverlay({
  micState,
  loading,
  streaming,
  draftText,
  committedText,
  engine,
  lastAiReply,
  provider,
  onClose,
  onMicClick,
}: VoiceChatOverlayProps) {
  const ttsState = useTtsStore((s) => s.state);

  const phase: Phase = useMemo(() => {
    if (ttsState === 'playing' || ttsState === 'synthesizing') return 'speaking';
    if (loading) return 'thinking';
    if (micState === 'recording') return 'listening';
    return 'idle';
  }, [ttsState, loading, micState]);

  const phaseLabel = phase === 'listening' ? 'Listening…'
    : phase === 'thinking' ? 'Thinking…'
    : phase === 'speaking' ? 'Speaking…'
    : 'Connecting…';

  // Animated bar heights. v1 uses a synthetic driver — listen = idle pulse,
  // speak = sine, idle/think = calm baseline. Real RMS is a v1.1 follow-up.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setTick((t) => (t + 1) % 1_000_000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const bars = useMemo(() => {
    const arr: number[] = new Array(BAR_COUNT);
    const t = tick / 8; // slow the animation
    for (let i = 0; i < BAR_COUNT; i++) {
      const center = (i - BAR_COUNT / 2) / (BAR_COUNT / 2); // -1..1
      let h: number;
      if (phase === 'speaking') {
        // Smooth sine envelope, peaks at center.
        const env = 1 - Math.abs(center);
        h = 0.25 + env * (0.4 + 0.35 * Math.sin(t * 0.4 + i * 0.6));
      } else if (phase === 'listening') {
        // Soft random-ish pulse. Pseudo-random by index + time to avoid Math.random churn.
        const a = Math.sin(t * 0.7 + i * 1.3) * 0.5 + 0.5;
        const b = Math.sin(t * 0.31 + i * 0.7) * 0.5 + 0.5;
        h = 0.18 + (a * b) * 0.55;
      } else if (phase === 'thinking') {
        // Three-dot wave traveling left to right.
        const wave = Math.sin(t * 1.5 - i * 0.4);
        h = 0.18 + Math.max(0, wave) * 0.35;
      } else {
        h = 0.18;
      }
      arr[i] = Math.max(0.06, Math.min(1, h));
    }
    return arr;
  }, [tick, phase]);

  const barColor = phase === 'speaking'
    ? 'bg-iron-accent-light'
    : phase === 'thinking'
      ? 'bg-iron-accent'
      : phase === 'listening'
        ? 'bg-iron-success'
        : 'bg-iron-text-muted/40';

  const showManualFallbackBanner = engine !== 'moonshine-session' && engine !== 'unknown';

  // What text to show prominently as "the AI is talking":
  //   - while THINKING (streaming tokens are arriving) → show the live stream
  //     so the user sees words appear as the model produces them
  //   - while SPEAKING (TTS playing the completed response) → show the same
  //     full text the TTS is reading, so the user can read along
  //   - otherwise → no live text panel (last reply still shown as caption)
  const liveAiText =
    phase === 'thinking' && streaming ? streaming
    : phase === 'speaking' ? (lastAiReply ?? streaming)
    : '';

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-iron-bg/90 backdrop-blur-sm">
      <button
        onClick={onClose}
        className="absolute top-3 right-3 p-2 rounded-lg text-iron-text-muted hover:text-iron-text hover:bg-iron-surface-hover transition-colors"
        title="Close Voice Chat"
        aria-label="Close Voice Chat"
      >
        <X className="w-4 h-4" />
      </button>

      <div className="w-full max-w-2xl mx-auto px-6 flex flex-col items-center">
        {/* Phase pill */}
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-iron-surface border border-iron-border">
          <span className="relative flex h-2 w-2">
            <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
              phase === 'speaking' ? 'bg-iron-accent-light'
                : phase === 'thinking' ? 'bg-iron-accent'
                : phase === 'listening' ? 'bg-iron-success'
                : 'bg-iron-text-muted'
            }`} />
            <span className={`relative inline-flex rounded-full h-2 w-2 ${
              phase === 'speaking' ? 'bg-iron-accent-light'
                : phase === 'thinking' ? 'bg-iron-accent'
                : phase === 'listening' ? 'bg-iron-success'
                : 'bg-iron-text-muted'
            }`} />
          </span>
          <span className="text-xs font-medium text-iron-text">{phaseLabel}</span>
        </div>

        {/* Waveform */}
        <div className="mt-8 flex items-center justify-center gap-[3px] h-24 w-full">
          {bars.map((h, i) => (
            <div
              key={i}
              className={`w-1.5 rounded-full transition-all duration-75 ${barColor}`}
              style={{ height: `${Math.round(h * 96)}px`, opacity: 0.85 }}
            />
          ))}
        </div>

        {/* Live transcript: committed + grey draft tail */}
        <div className="mt-8 w-full text-center min-h-[48px]">
          {(committedText || draftText) ? (
            <p className="text-base leading-snug">
              <span className="text-iron-text">{committedText}</span>
              {committedText && draftText ? ' ' : ''}
              <span className="italic text-iron-text-muted">{draftText}</span>
            </p>
          ) : (
            <p className="text-base text-iron-text-muted/60 italic">
              {phase === 'listening' ? 'Speak any time…' : ''}
            </p>
          )}
        </div>

        {/* Provider badge — surfaces "via Claude / Copilot / local" so the
            user always sees where each turn was sent. Especially important
            after opting into cloud Voice Chat. */}
        {provider && (
          <div className="mt-4 flex items-center justify-center gap-1.5">
            <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border ${
              provider === 'local'
                ? 'border-iron-success/30 text-iron-success bg-iron-success/5'
                : 'border-amber-500/30 text-amber-300 bg-amber-500/5'
            }`}>
              via {provider}
            </span>
          </div>
        )}

        {/* Live AI panel — prominent during thinking/speaking so the user
            reads the assistant's words AS they're produced (thinking) and
            AS they're spoken (speaking). Replaces the previous small grey
            line-clamped caption that read like an afterthought. */}
        {liveAiText && (phase === 'thinking' || phase === 'speaking') && (
          <div className="mt-6 w-full">
            <div className="flex items-center gap-2 mb-1.5 justify-center">
              <span className="text-[10px] uppercase tracking-wider text-iron-text-muted">
                {phase === 'thinking' ? 'AI is thinking…' : 'AI is speaking…'}
              </span>
              {phase === 'thinking' && (
                <span className="inline-flex w-1 h-1 rounded-full bg-iron-accent animate-pulse" />
              )}
            </div>
            <div className="max-h-[40vh] overflow-y-auto rounded-xl bg-iron-surface/80 border border-iron-border px-5 py-4">
              <p className="text-base leading-relaxed text-iron-text whitespace-pre-wrap">
                {liveAiText}
                {phase === 'thinking' && (
                  // Visible blinking caret so the panel feels alive while the
                  // model is still emitting tokens. Disappears once we flip
                  // into the speaking phase (TTS reading the full text).
                  <span className="inline-block w-[2px] h-4 ml-0.5 align-middle bg-iron-accent-light animate-pulse" />
                )}
              </p>
            </div>
          </div>
        )}

        {/* Last reply caption — only shown when the AI is idle/listening so
            the user has visual context for what was last said aloud. During
            thinking/speaking the live panel above takes over. */}
        {lastAiReply && phase !== 'thinking' && phase !== 'speaking' && (
          <p className="mt-6 text-xs text-iron-text-muted text-center max-w-prose line-clamp-3">
            Last reply: {lastAiReply}
          </p>
        )}

        {/* Manual-fallback banner */}
        {showManualFallbackBanner && (
          <div className="mt-6 px-3 py-2 rounded-lg bg-iron-warning/10 border border-iron-warning/20 text-[11px] text-iron-warning text-center">
            Hands-free auto-send needs Moonshine session mode. Press Enter / Send to submit.
          </div>
        )}

        {/* Big mic / close cluster */}
        <div className="mt-10 flex items-center gap-4">
          <button
            onClick={onMicClick}
            className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${
              micState === 'recording'
                ? 'bg-iron-danger text-white shadow-glow-danger animate-pulse-recording'
                : 'bg-iron-surface-hover text-iron-text hover:bg-iron-surface'
            }`}
            title={micState === 'recording' ? 'Stop listening' : 'Start listening'}
            aria-label={micState === 'recording' ? 'Stop listening' : 'Start listening'}
          >
            <Mic className="w-5 h-5" />
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-full text-xs font-medium text-iron-text-muted hover:text-iron-text hover:bg-iron-surface-hover transition-colors"
          >
            End voice chat
          </button>
        </div>
      </div>
    </div>
  );
}
