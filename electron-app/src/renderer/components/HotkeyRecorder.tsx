import { useState, useEffect, useCallback, useRef } from 'react';
import { Keyboard, RotateCcw, AlertTriangle, Check } from 'lucide-react';

const DEFAULT_HOTKEY = 'CommandOrControl+Shift+V';

const KNOWN_HOTKEYS: Record<string, string> = {
  'CommandOrControl+C': 'Copy', 'CommandOrControl+V': 'Paste', 'CommandOrControl+X': 'Cut',
  'CommandOrControl+Z': 'Undo', 'CommandOrControl+Shift+Z': 'Redo', 'CommandOrControl+A': 'Select All',
  'CommandOrControl+S': 'Save', 'CommandOrControl+Q': 'Quit', 'CommandOrControl+W': 'Close Window',
  'CommandOrControl+T': 'New Tab', 'CommandOrControl+N': 'New Window', 'CommandOrControl+P': 'Print',
  'CommandOrControl+F': 'Find', 'CommandOrControl+H': 'Hide', 'CommandOrControl+M': 'Minimize',
  'CommandOrControl+Space': 'Spotlight', 'CommandOrControl+Shift+3': 'Screenshot',
  'CommandOrControl+Shift+4': 'Screenshot Area', 'CommandOrControl+Shift+5': 'Screenshot Options',
};

function eventToAccelerator(e: KeyboardEvent): { keys: string[]; accelerator: string } | null {
  const parts: string[] = [];
  const displayKeys: string[] = [];
  const isMac = navigator.platform.includes('Mac');

  if (e.metaKey || e.ctrlKey) { parts.push('CommandOrControl'); displayKeys.push(isMac ? '⌘' : 'Ctrl'); }
  if (e.altKey) { parts.push('Alt'); displayKeys.push(isMac ? '⌥' : 'Alt'); }
  if (e.shiftKey) { parts.push('Shift'); displayKeys.push(isMac ? '⇧' : 'Shift'); }
  if (parts.length === 0) return null;

  const key = e.key;
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(key)) return { keys: displayKeys, accelerator: '' };

  let keyName: string, displayName: string;
  if (key.length === 1) { keyName = key.toUpperCase(); displayName = key.toUpperCase(); }
  else {
    const map: Record<string, [string, string]> = {
      'ArrowUp': ['Up', '↑'], 'ArrowDown': ['Down', '↓'], 'ArrowLeft': ['Left', '←'],
      'ArrowRight': ['Right', '→'], 'Enter': ['Enter', '↵'], 'Backspace': ['Backspace', '⌫'],
      'Delete': ['Delete', '⌦'], 'Escape': ['Escape', 'Esc'], 'Tab': ['Tab', '⇥'], ' ': ['Space', 'Space'],
      'F1': ['F1', 'F1'], 'F2': ['F2', 'F2'], 'F3': ['F3', 'F3'], 'F4': ['F4', 'F4'],
      'F5': ['F5', 'F5'], 'F6': ['F6', 'F6'], 'F7': ['F7', 'F7'], 'F8': ['F8', 'F8'],
      'F9': ['F9', 'F9'], 'F10': ['F10', 'F10'], 'F11': ['F11', 'F11'], 'F12': ['F12', 'F12'],
    };
    const mapped = map[key];
    if (!mapped) return null;
    keyName = mapped[0]; displayName = mapped[1];
  }

  parts.push(keyName);
  displayKeys.push(displayName);
  return { keys: displayKeys, accelerator: parts.join('+') };
}

function acceleratorToDisplayKeys(accelerator: string): string[] {
  const isMac = navigator.platform.includes('Mac');
  return accelerator.split('+').map((p) => {
    switch (p) {
      case 'CommandOrControl': return isMac ? '⌘' : 'Ctrl';
      case 'Command': return '⌘'; case 'Control': return 'Ctrl';
      case 'Alt': return isMac ? '⌥' : 'Alt'; case 'Shift': return isMac ? '⇧' : 'Shift';
      default: return p;
    }
  });
}

interface HotkeyRecorderProps { value: string; onChange: (accelerator: string) => void; }

export function HotkeyRecorder({ value, onChange }: HotkeyRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [pendingKeys, setPendingKeys] = useState<string[]>([]);
  const [pendingAccelerator, setPendingAccelerator] = useState('');
  const [conflict, setConflict] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const recorderRef = useRef<HTMLDivElement>(null);

  const displayKeys = recording && pendingKeys.length > 0 ? pendingKeys : acceleratorToDisplayKeys(value);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault(); e.stopPropagation();
    const result = eventToAccelerator(e);
    if (!result) return;
    setPendingKeys(result.keys);
    if (result.accelerator) {
      setPendingAccelerator(result.accelerator);
      setConflict(KNOWN_HOTKEYS[result.accelerator] || null);
    } else { setPendingAccelerator(''); setConflict(null); }
  }, [recording]);

  const handleKeyUp = useCallback(() => {
    if (!recording || !pendingAccelerator) return;
    setRecording(false);
    if (pendingAccelerator && !conflict) {
      onChange(pendingAccelerator);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
    setPendingKeys([]); setPendingAccelerator('');
  }, [recording, pendingAccelerator, conflict, onChange]);

  useEffect(() => {
    if (recording) {
      window.addEventListener('keydown', handleKeyDown, true);
      window.addEventListener('keyup', handleKeyUp, true);
    }
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
    };
  }, [recording, handleKeyDown, handleKeyUp]);

  useEffect(() => {
    if (!recording) return;
    const handleClick = (e: MouseEvent) => {
      if (recorderRef.current && !recorderRef.current.contains(e.target as Node)) {
        setRecording(false); setPendingKeys([]); setPendingAccelerator(''); setConflict(null);
      }
    };
    window.addEventListener('mousedown', handleClick);
    return () => window.removeEventListener('mousedown', handleClick);
  }, [recording]);

  return (
    <div className="space-y-2" ref={recorderRef}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Keyboard className="w-4 h-4 text-iron-text-muted" />
          <label className="text-sm font-medium text-iron-text">Recording Hotkey</label>
        </div>
        {saved && (
          <span className="flex items-center gap-1 text-xs text-iron-success">
            <Check className="w-3 h-3" /> Saved
          </span>
        )}
      </div>

      <button
        onClick={() => { setRecording(true); setPendingKeys([]); setPendingAccelerator(''); setConflict(null); }}
        className={`w-full flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl border-2 transition-all duration-200 ${
          recording
            ? 'border-iron-accent/50 bg-iron-accent/5 shadow-glow'
            : 'border-iron-border bg-iron-surface hover:border-iron-border-hover'
        }`}
      >
        {recording && pendingKeys.length === 0 ? (
          <span className="text-sm text-iron-text-muted animate-pulse">Press your key combination...</span>
        ) : (
          <div className="flex items-center gap-2">
            {displayKeys.map((key, i) => (
              <span key={i} className="flex items-center gap-2">
                {i > 0 && <span className="text-iron-text-muted text-xs">+</span>}
                <kbd className={`inline-flex items-center justify-center min-w-[32px] h-8 px-2.5 rounded-lg text-xs font-semibold border shadow-depth-sm ${
                  recording
                    ? 'bg-iron-accent/15 border-iron-accent/30 text-iron-accent-light'
                    : 'bg-iron-surface-hover border-iron-border text-iron-text'
                }`}>
                  {key}
                </kbd>
              </span>
            ))}
          </div>
        )}
      </button>

      {conflict && (
        <div className="flex items-center gap-2 text-xs text-iron-warning bg-iron-warning/10 border border-iron-warning/20 px-3 py-2 rounded-lg">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          Conflicts with <strong>{conflict}</strong>
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-[11px] text-iron-text-muted">
          {recording ? 'Hold modifiers + press a key' : 'Click to record a new shortcut'}
        </p>
        {value !== DEFAULT_HOTKEY && !recording && (
          <button
            onClick={() => { onChange(DEFAULT_HOTKEY); setSaved(true); setTimeout(() => setSaved(false), 2000); }}
            className="flex items-center gap-1 text-[11px] text-iron-text-muted hover:text-iron-text-secondary transition-colors"
          >
            <RotateCcw className="w-3 h-3" /> Reset
          </button>
        )}
      </div>
    </div>
  );
}
