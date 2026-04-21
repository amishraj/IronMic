/**
 * AudioSetupModal — step-by-step guide for installing + configuring BlackHole 2ch
 * on macOS.
 *
 * BlackHole alone is useless — it's just a virtual audio driver. To actually
 * capture system audio, the user needs to ROUTE audio into it via Audio MIDI
 * Setup. This modal walks through all three supported capture scenarios.
 *
 * On Windows system audio can be captured natively via WASAPI loopback, so
 * this modal is macOS-only.
 */

import { useState, useEffect } from 'react';
import {
  X, Download, Check, ExternalLink, AlertTriangle, Loader2, Layers, Mic, Users, Volume2, ArrowRight,
} from 'lucide-react';

interface Props {
  onClose: () => void;
  /** Called after a successful install so the parent can refresh the device list. */
  onInstalled?: () => void;
}

type Stage = 'idle' | 'downloading' | 'installing' | 'done' | 'error';
type CaptureScenario = 'mic' | 'system' | 'both';

export function AudioSetupModal({ onClose, onInstalled }: Props) {
  const [stage, setStage] = useState<Stage>('idle');
  const [progressMsg, setProgressMsg] = useState('');
  const [progressPct, setProgressPct] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [scenario, setScenario] = useState<CaptureScenario>('both');

  useEffect(() => {
    const unsub = window.ironmic?.onBlackholeInstallProgress?.((p: any) => {
      setProgressMsg(p.message ?? '');
      setProgressPct(p.percent ?? 0);
      if (p.stage === 'done') setStage('done');
      else if (p.stage === 'error') { setStage('error'); setErrorMsg(p.message ?? 'Unknown error'); }
      else if (p.stage === 'installing') setStage('installing');
      else if (p.stage === 'downloading') setStage('downloading');
    });
    return () => { unsub?.(); };
  }, []);

  const handleInstall = async () => {
    setStage('downloading');
    setErrorMsg('');
    try {
      await window.ironmic.blackholeInstall();
    } catch (err: any) {
      setStage('error');
      setErrorMsg(err?.message ?? 'Installation failed');
    }
  };

  const handleDone = () => {
    onInstalled?.();
    onClose();
  };

  const scenarioCard = (
    key: CaptureScenario,
    icon: React.ReactNode,
    title: string,
    subtitle: string,
  ) => (
    <button
      onClick={() => setScenario(key)}
      className={`flex-1 flex flex-col gap-1 px-3 py-2.5 rounded-lg border text-left transition-colors ${
        scenario === key
          ? 'bg-iron-accent/10 border-iron-accent/30 text-iron-accent-light'
          : 'bg-iron-surface border-iron-border text-iron-text-muted hover:border-iron-border-hover'
      }`}
    >
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-[11px] font-semibold">{title}</span>
      </div>
      <span className="text-[10px] leading-tight">{subtitle}</span>
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-iron-surface border border-iron-border rounded-xl shadow-2xl max-h-[92vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-iron-border shrink-0">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-iron-accent-light" />
            <h2 className="text-sm font-medium text-iron-text">Meeting audio setup</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-iron-text-muted hover:bg-iron-surface-hover"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Intro */}
          <p className="text-[12px] text-iron-text/80 leading-relaxed">
            By default IronMic captures <strong className="text-iron-text">only your microphone</strong>.
            To transcribe other participants (in Zoom/Teams/Meet) or any other
            system audio, you need to install <strong className="text-iron-text">BlackHole 2ch</strong>{' '}
            — a free, open-source virtual audio driver by Existential Audio — and
            then tell macOS to route audio through it.
          </p>

          {/* Scenario picker */}
          <div>
            <p className="text-[10px] font-semibold text-iron-text-muted uppercase tracking-wider mb-1.5">
              What do you want to capture?
            </p>
            <div className="flex gap-2">
              {scenarioCard('mic',
                <Mic className="w-3.5 h-3.5" />,
                'Just my mic',
                'No BlackHole needed',
              )}
              {scenarioCard('system',
                <Volume2 className="w-3.5 h-3.5" />,
                'System audio',
                'Others only (no me)',
              )}
              {scenarioCard('both',
                <Users className="w-3.5 h-3.5" />,
                'Me + others',
                'Recommended',
              )}
            </div>
          </div>

          {/* Scenario-specific instructions */}
          {scenario === 'mic' ? (
            <div className="rounded-lg border border-green-500/20 bg-green-500/5 p-3">
              <div className="flex items-start gap-2">
                <Check className="w-4 h-4 text-green-400 mt-0.5 shrink-0" />
                <div className="space-y-1">
                  <p className="text-[12px] font-medium text-iron-text">You're all set</p>
                  <p className="text-[11px] text-iron-text-muted leading-relaxed">
                    Close this dialog, leave the audio picker on{' '}
                    <strong className="text-iron-text">Default Mic</strong>, and start your meeting.
                    IronMic will capture and transcribe your voice only.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* Step 1 — Install BlackHole */}
              <div className={`rounded-lg border p-3 space-y-2 ${
                stage === 'done' ? 'border-green-500/30 bg-green-500/5' : 'border-iron-border bg-iron-surface-hover/50'
              }`}>
                <div className="flex items-center gap-2">
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                    stage === 'done' ? 'bg-green-500 text-white' : 'bg-iron-accent/20 text-iron-accent-light'
                  }`}>
                    {stage === 'done' ? <Check className="w-3 h-3" /> : '1'}
                  </div>
                  <p className="text-[12px] font-medium text-iron-text">Install BlackHole 2ch</p>
                </div>

                {stage === 'idle' && (
                  <div className="pl-7 space-y-2">
                    <p className="text-[11px] text-iron-text-muted">
                      Downloads ~500 KB from the official GitHub release. You'll be
                      asked for your admin password.
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleInstall}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-iron-accent/15 text-iron-accent-light border border-iron-accent/20 rounded-lg hover:bg-iron-accent/25 transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Install automatically
                      </button>
                      <button
                        onClick={() => window.ironmic?.openExternal?.('https://existential.audio/blackhole/')}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-iron-text-muted border border-iron-border rounded-lg hover:bg-iron-surface-hover transition-colors"
                      >
                        <ExternalLink className="w-3 h-3" />
                        Download manually
                      </button>
                    </div>
                  </div>
                )}

                {(stage === 'downloading' || stage === 'installing') && (
                  <div className="pl-7 space-y-1.5">
                    <div className="flex items-center gap-2 text-[11px] text-iron-text-muted">
                      <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                      {progressMsg || (stage === 'downloading' ? 'Downloading…' : 'Installing…')}
                    </div>
                    {stage === 'downloading' && progressPct > 0 && (
                      <div className="h-1 bg-iron-surface rounded-full overflow-hidden">
                        <div className="h-full bg-iron-accent transition-all" style={{ width: `${progressPct}%` }} />
                      </div>
                    )}
                  </div>
                )}

                {stage === 'error' && (
                  <div className="pl-7 space-y-2">
                    <div className="flex items-start gap-2 text-[11px] text-red-400">
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span>{errorMsg}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleInstall}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-iron-accent/15 text-iron-accent-light border border-iron-accent/20 rounded-lg hover:bg-iron-accent/25 transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Retry
                      </button>
                      <button
                        onClick={() => window.ironmic?.openExternal?.('https://existential.audio/blackhole/')}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-iron-text-muted border border-iron-border rounded-lg hover:bg-iron-surface-hover transition-colors"
                      >
                        <ExternalLink className="w-3 h-3" />
                        Download manually
                      </button>
                    </div>
                  </div>
                )}

                {stage === 'done' && (
                  <p className="pl-7 text-[11px] text-green-400">
                    BlackHole 2ch installed. Continue with the routing step below.
                  </p>
                )}
              </div>

              {/* Step 2 — Route audio (differs per scenario) */}
              <div className={`rounded-lg border p-3 space-y-2 ${
                stage === 'done' ? 'border-iron-border bg-iron-surface-hover/50' : 'border-iron-border/50 bg-iron-surface/50 opacity-70'
              }`}>
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 bg-iron-accent/20 text-iron-accent-light">
                    2
                  </div>
                  <p className="text-[12px] font-medium text-iron-text">
                    {scenario === 'system'
                      ? 'Route system audio through BlackHole'
                      : 'Create an Aggregate Device (Mic + BlackHole)'}
                  </p>
                </div>

                <div className="pl-7 space-y-2">
                  {scenario === 'system' ? (
                    <>
                      <p className="text-[11px] text-iron-text-muted leading-relaxed">
                        BlackHole only captures what your Mac sends to it. To capture
                        other meeting participants, create a{' '}
                        <strong className="text-iron-text">Multi-Output Device</strong>{' '}
                        so audio plays through your speakers <em>and</em> BlackHole at the same time.
                      </p>
                      <ol className="text-[11px] text-iron-text-muted leading-relaxed list-decimal pl-4 space-y-0.5">
                        <li>Open <strong className="text-iron-text">Audio MIDI Setup</strong> (button below).</li>
                        <li>Click the <strong>+</strong> in the bottom-left → <strong>Create Multi-Output Device</strong>.</li>
                        <li>Check both <strong className="text-iron-text">Built-in Output</strong> (your speakers/headphones) and <strong className="text-iron-text">BlackHole 2ch</strong>.</li>
                        <li>In macOS menu bar → sound icon → pick the new Multi-Output Device as system output.</li>
                        <li>Back in IronMic, select <strong className="text-iron-text">BlackHole 2ch</strong> as the audio source.</li>
                      </ol>
                    </>
                  ) : (
                    <>
                      <p className="text-[11px] text-iron-text-muted leading-relaxed">
                        To record <em>both</em> your mic and system audio in one stream,
                        combine them into an <strong className="text-iron-text">Aggregate Device</strong>.
                        You'll also need a Multi-Output Device so you can still hear system audio.
                      </p>
                      <ol className="text-[11px] text-iron-text-muted leading-relaxed list-decimal pl-4 space-y-0.5">
                        <li>Open <strong className="text-iron-text">Audio MIDI Setup</strong> (button below).</li>
                        <li>
                          Click <strong>+</strong> → <strong>Create Multi-Output Device</strong>;
                          check <strong className="text-iron-text">Built-in Output</strong> + <strong className="text-iron-text">BlackHole 2ch</strong>.
                          Then set it as your Mac's system output (menu-bar sound icon).
                        </li>
                        <li>
                          Click <strong>+</strong> → <strong>Create Aggregate Device</strong>;
                          check <strong className="text-iron-text">Built-in Microphone</strong> + <strong className="text-iron-text">BlackHole 2ch</strong>.
                          Rename it "Meeting Input" for clarity.
                        </li>
                        <li>
                          Back in IronMic, select <strong className="text-iron-text">Meeting Input</strong> as the audio source.
                        </li>
                      </ol>
                    </>
                  )}

                  <button
                    onClick={() => window.ironmic?.blackholeOpenAudioMidiSetup?.()}
                    disabled={stage !== 'done'}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-iron-text-muted border border-iron-border rounded-lg hover:bg-iron-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ExternalLink className="w-3 h-3" />
                    Open Audio MIDI Setup
                  </button>
                </div>
              </div>

              {/* Step 3 — Verify */}
              <div className="rounded-lg border border-iron-border/50 bg-iron-surface/50 p-3 space-y-1.5">
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 bg-iron-accent/20 text-iron-accent-light">
                    3
                  </div>
                  <p className="text-[12px] font-medium text-iron-text">Verify the setup</p>
                </div>
                <div className="pl-7 space-y-1">
                  <p className="text-[11px] text-iron-text-muted leading-relaxed">
                    Play a short YouTube clip or start a test Zoom call. You should still
                    hear audio through your speakers/headphones. If Whisper transcribes
                    repeated "Thank you." or "You." output, BlackHole is getting silence
                    — double-check that system output is set to your Multi-Output Device.
                  </p>
                  <div className="flex items-center gap-1 text-[10px] text-iron-text-muted/80">
                    <ArrowRight className="w-2.5 h-2.5" />
                    If audio <em>plays</em> but transcripts are empty, system audio isn't reaching BlackHole.
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-iron-border shrink-0">
          <p className="text-[10px] text-iron-text-muted">
            Everything stays on your machine. BlackHole is a local CoreAudio plug-in — no network.
          </p>
          {stage === 'done' || scenario === 'mic' ? (
            <button
              onClick={handleDone}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-iron-accent/15 text-iron-accent-light border border-iron-accent/20 rounded-lg hover:bg-iron-accent/25 transition-colors shrink-0"
            >
              <Check className="w-3.5 h-3.5" />
              Done
            </button>
          ) : (
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-iron-text-muted rounded-lg border border-iron-border hover:bg-iron-surface-hover transition-colors shrink-0"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
