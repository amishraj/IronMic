/**
 * AudioModeSelector — device picker for meeting audio capture.
 *
 * Features:
 *  - Lists all audio input devices (via existing listAudioDevices() N-API call)
 *  - Highlights virtual/loopback devices (BlackHole, Soundflower, etc.) with a
 *    badge so users know which device captures system audio
 *  - When no virtual device is found, shows a "Set up system audio" hint that
 *    opens AudioSetupModal (macOS only; Windows has WASAPI loopback natively)
 */

import { useState, useEffect } from 'react';
import { Mic, ChevronDown, Layers, AlertCircle } from 'lucide-react';
import { AudioSetupModal } from './AudioSetupModal';

interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
  sampleRate: number;
  channels: number;
}

const VIRTUAL_RE = /blackhole|soundflower|loopback|virtual|vb.?cable|voicemeeter/i;

interface Props {
  selectedDevice: string | null;
  onDeviceChange: (deviceName: string | null) => void;
}

export function AudioModeSelector({ selectedDevice, onDeviceChange }: Props) {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showSetup, setShowSetup] = useState(false);

  const loadDevices = () => {
    setLoading(true);
    window.ironmic?.listAudioDevices?.()
      .then((raw: string) => {
        try { setDevices(JSON.parse(raw) as AudioDevice[]); } catch { setDevices([]); }
      })
      .catch(() => setDevices([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadDevices(); }, []);

  const currentLabel = selectedDevice
    ? devices.find(d => d.name === selectedDevice)?.name ?? selectedDevice
    : 'Default Mic';

  const hasVirtualDevice = devices.some(d => VIRTUAL_RE.test(d.name));
  const isMac = navigator.userAgent.toLowerCase().includes('mac');

  const handleInstalled = () => {
    // Re-fetch device list so the new BlackHole device appears
    loadDevices();
  };

  return (
    <>
      <div className="space-y-1.5">
        <div className="relative">
          <button
            onClick={() => setOpen(o => !o)}
            disabled={loading}
            className="flex items-center gap-2 w-full text-sm px-3 py-2 rounded-lg border border-iron-border bg-iron-surface text-iron-text hover:bg-iron-surface-hover transition-colors"
          >
            <Mic className="w-3.5 h-3.5 text-iron-text-muted shrink-0" />
            <span className="flex-1 text-left truncate text-sm text-iron-text">{currentLabel}</span>
            <ChevronDown className="w-3.5 h-3.5 text-iron-text-muted shrink-0" />
          </button>

          {open && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
              <div className="absolute z-50 top-full mt-1 left-0 right-0 bg-iron-surface border border-iron-border rounded-xl shadow-xl overflow-hidden">
                {/* Default mic */}
                <button
                  onClick={() => { onDeviceChange(null); setOpen(false); }}
                  className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors ${
                    selectedDevice === null
                      ? 'bg-iron-accent/10 text-iron-accent-light'
                      : 'text-iron-text hover:bg-iron-surface-hover'
                  }`}
                >
                  <Mic className="w-3.5 h-3.5 shrink-0" />
                  <span className="flex-1">Default Mic</span>
                  {selectedDevice === null && <span className="text-[10px] text-iron-accent-light">●</span>}
                </button>

                {devices.length > 0 && (
                  <>
                    <div className="border-t border-iron-border/50 mx-2 my-0.5" />
                    {devices.map(device => {
                      const isVirtual = VIRTUAL_RE.test(device.name);
                      return (
                        <button
                          key={device.id}
                          onClick={() => { onDeviceChange(device.name); setOpen(false); }}
                          className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors ${
                            selectedDevice === device.name
                              ? 'bg-iron-accent/10 text-iron-accent-light'
                              : 'text-iron-text hover:bg-iron-surface-hover'
                          }`}
                        >
                          {isVirtual
                            ? <Layers className="w-3.5 h-3.5 text-iron-accent-light shrink-0" />
                            : <Mic className="w-3.5 h-3.5 shrink-0" />}
                          <span className="flex-1 truncate">{device.name}</span>
                          {isVirtual && (
                            <span className="text-[9px] font-medium text-iron-accent-light bg-iron-accent/10 px-1.5 py-0.5 rounded shrink-0">
                              system
                            </span>
                          )}
                          {device.isDefault && !isVirtual && (
                            <span className="text-[10px] text-iron-text-muted shrink-0">default</span>
                          )}
                          {selectedDevice === device.name && (
                            <span className="text-[10px] text-iron-accent-light shrink-0">●</span>
                          )}
                        </button>
                      );
                    })}
                  </>
                )}

                {/* macOS: suggest BlackHole if not found */}
                {isMac && !hasVirtualDevice && (
                  <>
                    <div className="border-t border-iron-border/50 mx-2 my-0.5" />
                    <button
                      onClick={() => { setOpen(false); setShowSetup(true); }}
                      className="w-full text-left px-3 py-2.5 flex items-center gap-2 hover:bg-iron-surface-hover transition-colors"
                    >
                      <Layers className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      <div>
                        <p className="text-[11px] font-medium text-amber-400">Set up system audio…</p>
                        <p className="text-[10px] text-iron-text-muted leading-snug">
                          Install BlackHole to capture all meeting audio
                        </p>
                      </div>
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {/* Inline warning: selected device is a virtual/loopback one.
            BlackHole by itself does NOT capture system audio — audio only flows
            into it if the user has set their system output to a Multi-Output
            Device that includes BlackHole. Without that step Whisper gets
            silence and hallucinates ("Thank you. Thank you."). */}
        {selectedDevice && VIRTUAL_RE.test(selectedDevice) && (
          <div className="text-[10px] text-amber-400/90 bg-amber-500/5 border border-amber-500/20 rounded-md px-2 py-1.5 flex items-start gap-1.5 leading-snug">
            <AlertCircle className="w-2.5 h-2.5 mt-0.5 shrink-0" />
            <div className="space-y-0.5">
              <p className="font-medium">
                Heads up: {selectedDevice} only captures audio that is <em>routed into it</em>.
              </p>
              <p className="text-iron-text-muted">
                If you also want to hear the audio, open{' '}
                <button
                  onClick={() => window.ironmic?.blackholeOpenAudioMidiSetup?.()}
                  className="underline text-amber-400 hover:text-amber-300"
                >
                  Audio MIDI Setup
                </button>
                {' '}and either (a) create a Multi-Output Device (Speakers + BlackHole) and set it as your Mac's system output, or (b) create an Aggregate Device (Mic + BlackHole) to capture both yourself and others.
                {' '}
                <button
                  onClick={() => setShowSetup(true)}
                  className="underline hover:text-amber-300"
                >
                  Open setup guide →
                </button>
              </p>
            </div>
          </div>
        )}

        {/* Success tip when using the mic (no virtual device) — reassures the user */}
        {selectedDevice && !VIRTUAL_RE.test(selectedDevice) && (
          <p className="text-[10px] text-iron-text-muted flex items-center gap-1">
            <Mic className="w-2.5 h-2.5" />
            Capturing your microphone only
          </p>
        )}

        {/* macOS: setup nudge when nothing is capturing system audio */}
        {isMac && !hasVirtualDevice && !selectedDevice && (
          <button
            onClick={() => setShowSetup(true)}
            className="flex items-center gap-1.5 text-[10px] text-amber-400/80 hover:text-amber-400 transition-colors"
          >
            <AlertCircle className="w-2.5 h-2.5" />
            Mic only — install BlackHole to capture other participants
          </button>
        )}
      </div>

      {showSetup && (
        <AudioSetupModal
          onClose={() => setShowSetup(false)}
          onInstalled={handleInstalled}
        />
      )}
    </>
  );
}
