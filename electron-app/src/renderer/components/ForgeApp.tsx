import React, { useEffect, useState } from 'react';
import ForgeBar from './ForgeBar';
import ForgeAccessibilityPrompt from './ForgeAccessibilityPrompt';
import { useForgeStore } from '../stores/useForgeStore';

declare global {
  interface Window {
    ironmic: any;
  }
}

/**
 * Root of the Forge bar window. On macOS, gates the bar behind a one-time
 * Accessibility permission prompt — without AX trust, every paste silently
 * fails and the user has no idea why.
 */
const ForgeApp: React.FC = () => {
  const [axChecked, setAxChecked] = useState(false);
  const [axTrusted, setAxTrusted] = useState(true);
  const status = useForgeStore((s) => s.status);

  useEffect(() => {
    const isMac = navigator.platform.toLowerCase().includes('mac');
    if (!isMac) {
      setAxChecked(true);
      setAxTrusted(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const trusted = await window.ironmic?.isAccessibilityTrusted?.();
        if (!cancelled) {
          setAxTrusted(trusted !== false);
          setAxChecked(true);
        }
      } catch {
        if (!cancelled) {
          setAxTrusted(false);
          setAxChecked(true);
        }
      }
    })();

    // Re-check periodically so the user doesn't have to relaunch IronMic
    // after granting AX in System Settings.
    const interval = setInterval(async () => {
      try {
        const trusted = await window.ironmic?.isAccessibilityTrusted?.();
        if (!cancelled && trusted) {
          setAxTrusted(true);
        }
      } catch {
        // ignore
      }
    }, 1500);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Subscribe to fields that should drive a window resize:
  //   - status     — recording/stopping/pasting expand the bar to show preview
  //   - lastError  — visible error text needs room to wrap
  //   - toast      — toasts render INSIDE the bar at the bottom; clipped if compact
  const expandedReason = useForgeStore(
    (s) => (s.status !== 'idle' || !!s.lastError || !!s.toast) ? 1 : 0,
  );

  // Theme sync. Initial paint comes from the URL query param (resolved by
  // main process). Subsequent changes arrive via this IPC listener — main
  // has already resolved 'system' → 'light' | 'dark' so we just apply it.
  useEffect(() => {
    const api = (window as any).ironmic;
    if (!api?.onThemeChanged) return;
    const off = api.onThemeChanged((applied: 'light' | 'dark') => {
      const isDark = applied === 'dark';
      document.documentElement.classList.toggle('dark', isDark);
    });
    return () => {
      try { off?.(); } catch { /* ignore */ }
    };
  }, []);

  // Resize the Forge BrowserWindow to match the current view:
  //   - permission panel → 150 px
  //   - recording / error / toast visible → 170 px
  //   - idle bar → 64 px (compact pill)
  useEffect(() => {
    if (!axChecked) return;
    let mode: 'compact' | 'expanded' | 'permission';
    if (!axTrusted) {
      mode = 'permission';
    } else if (expandedReason === 0) {
      mode = 'compact';
    } else {
      mode = 'expanded';
    }
    (window as any).ironmic?.forgeSetWindowMode?.(mode).catch(() => {});
  }, [axChecked, axTrusted, expandedReason]);

  if (!axChecked) {
    return null;
  }

  return axTrusted ? (
    <ForgeBar />
  ) : (
    <ForgeAccessibilityPrompt onGranted={() => setAxTrusted(true)} />
  );
};

export default ForgeApp;
