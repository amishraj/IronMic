import { useState, useEffect } from 'react';
import { Mic, ChevronDown } from 'lucide-react';

interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
  sampleRate: number;
  channels: number;
}

interface Props {
  selectedDevice: string | null;
  onDeviceChange: (deviceName: string | null) => void;
}

export function AudioModeSelector({ selectedDevice, onDeviceChange }: Props) {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    window.ironmic?.listAudioDevices?.()
      .then((raw: string) => {
        try {
          setDevices(JSON.parse(raw) as AudioDevice[]);
        } catch {
          setDevices([]);
        }
      })
      .catch(() => setDevices([]))
      .finally(() => setLoading(false));
  }, []);

  const currentLabel = selectedDevice
    ? devices.find(d => d.name === selectedDevice)?.name ?? selectedDevice
    : 'Default Mic';

  // Check if BlackHole or any virtual audio device is available
  const hasVirtualDevice = devices.some(d =>
    /blackhole|soundflower|loopback|virtual|vb-cable|voicemeeter/i.test(d.name)
  );

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 transition-colors"
        disabled={loading}
      >
        <Mic className="w-3.5 h-3.5 text-gray-500" />
        <span className="text-gray-700 max-w-[160px] truncate">{currentLabel}</span>
        <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
      </button>

      {open && (
        <div className="absolute z-50 top-full mt-1 left-0 w-64 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
          {/* Default mic option */}
          <button
            className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center gap-2 ${selectedDevice === null ? 'text-blue-600 font-medium' : 'text-gray-700'}`}
            onClick={() => { onDeviceChange(null); setOpen(false); }}
          >
            <Mic className="w-3.5 h-3.5 shrink-0" />
            <span>Default Mic</span>
            {selectedDevice === null && <span className="ml-auto text-xs text-blue-400">●</span>}
          </button>

          {/* Device list */}
          {devices.length > 0 && (
            <>
              <div className="border-t border-gray-100 mx-2 my-1" />
              {devices.map(device => (
                <button
                  key={device.id}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center gap-2 ${selectedDevice === device.name ? 'text-blue-600 font-medium' : 'text-gray-700'}`}
                  onClick={() => { onDeviceChange(device.name); setOpen(false); }}
                >
                  <Mic className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate flex-1">{device.name}</span>
                  {device.isDefault && (
                    <span className="text-xs text-gray-400 shrink-0">system</span>
                  )}
                  {selectedDevice === device.name && (
                    <span className="ml-1 text-xs text-blue-400 shrink-0">●</span>
                  )}
                </button>
              ))}
            </>
          )}

          {/* BlackHole hint if no virtual device found */}
          {!hasVirtualDevice && (
            <div className="border-t border-gray-100 px-3 py-2 bg-amber-50">
              <p className="text-xs text-amber-700 leading-snug">
                To capture all meeting audio, install{' '}
                <button
                  className="underline font-medium"
                  onClick={() => {
                    window.ironmic?.openExternal?.('https://existential.audio/blackhole/');
                    setOpen(false);
                  }}
                >
                  BlackHole
                </button>{' '}
                and select it here.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Close dropdown on outside click */}
      {open && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setOpen(false)}
        />
      )}
    </div>
  );
}
