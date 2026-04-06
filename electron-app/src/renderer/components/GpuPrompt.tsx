import { useState, useEffect } from 'react';
import { Zap, X } from 'lucide-react';
import { Button } from './ui';

export function GpuPrompt() {
  const [show, setShow] = useState(false);

  useEffect(() => { checkAndShow(); }, []);

  async function checkAndShow() {
    try {
      const [gpuAvailable, gpuEnabled, dismissed] = await Promise.all([
        window.ironmic.isGpuAvailable(),
        window.ironmic.isGpuEnabled(),
        window.ironmic.getSetting('gpu_prompt_dismissed'),
      ]);
      if (!gpuAvailable || gpuEnabled || dismissed === 'true') return;
      setShow(true);
    } catch { /* silently fail */ }
  }

  async function handleEnable() {
    try {
      await window.ironmic.setGpuEnabled(true);
      await window.ironmic.setSetting('gpu_prompt_dismissed', 'true');
    } catch (err) { console.error('Failed to enable GPU:', err); }
    setShow(false);
  }

  async function handleDismiss() {
    await window.ironmic.setSetting('gpu_prompt_dismissed', 'true');
    setShow(false);
  }

  if (!show) return null;

  return (
    <div className="mx-4 mt-3 p-4 bg-iron-warning/5 border border-iron-warning/20 rounded-xl relative animate-slide-up">
      <button onClick={handleDismiss} className="absolute top-3 right-3 p-1 text-iron-text-muted hover:text-iron-text-secondary rounded transition-colors">
        <X className="w-3.5 h-3.5" />
      </button>

      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-iron-warning/10 flex items-center justify-center flex-shrink-0">
          <Zap className="w-5 h-5 text-iron-warning" />
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium text-iron-text">Speed up transcription</p>
          <p className="text-xs text-iron-text-muted mt-0.5">
            Your device supports GPU acceleration — 3-5x faster.
          </p>
          <div className="flex items-center gap-2 mt-2.5">
            <Button size="sm" onClick={handleEnable}>Enable GPU</Button>
            <button onClick={handleDismiss} className="text-xs text-iron-text-muted hover:text-iron-text-secondary transition-colors">Not now</button>
          </div>
        </div>
      </div>
    </div>
  );
}
