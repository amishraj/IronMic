import { useState, useEffect, useCallback, useRef } from 'react';
import { Lock, Mic } from 'lucide-react';
import iconImg from '../assets/icon-256.png';

interface SessionLockProps {
  timeoutSetting: string; // 'off', '5m', '15m', '30m', '60m'
}

function parseTimeout(setting: string): number | null {
  if (setting === 'off') return null;
  const match = setting.match(/^(\d+)m$/);
  if (!match) return null;
  return parseInt(match[1]) * 60 * 1000;
}

export function SessionLock({ timeoutSetting }: SessionLockProps) {
  const [locked, setLocked] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timeoutMs = parseTimeout(timeoutSetting);

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!timeoutMs) return;
    timerRef.current = setTimeout(() => setLocked(true), timeoutMs);
  }, [timeoutMs]);

  useEffect(() => {
    if (!timeoutMs) {
      setLocked(false);
      return;
    }

    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];
    const handler = () => {
      if (!locked) resetTimer();
    };

    events.forEach((e) => window.addEventListener(e, handler, { passive: true }));
    resetTimer();

    return () => {
      events.forEach((e) => window.removeEventListener(e, handler));
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [timeoutMs, locked, resetTimer]);

  const handleUnlock = () => {
    setLocked(false);
    resetTimer();
  };

  if (!locked) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-iron-bg/95 backdrop-blur-md flex items-center justify-center">
      <div className="text-center">
        <img src={iconImg} alt="IronMic" className="w-20 h-20 mx-auto mb-5 opacity-80" />
        <h2 className="text-lg font-semibold text-iron-text">Session Locked</h2>
        <p className="text-sm text-iron-text-muted mt-1.5 max-w-[280px]">
          IronMic locked after inactivity to protect your data.
        </p>
        <button
          onClick={handleUnlock}
          className="mt-6 px-6 py-2.5 bg-gradient-accent text-white text-sm font-medium rounded-xl hover:shadow-glow transition-all inline-flex items-center gap-2"
        >
          <Mic className="w-4 h-4" />
          Resume Session
        </button>
      </div>
    </div>
  );
}
