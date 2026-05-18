import React from 'react';

interface Props {
  onGranted: () => void;
}

/**
 * macOS-only panel shown when the process lacks Accessibility permission.
 * Without AX trust, `enigo`'s `CGEventPost` calls silently fail and the user
 * has no idea why their dictations vanish.
 *
 * We don't trigger the system prompt directly from Rust because that requires
 * a CFDictionary FFI dance that adds dep weight for one call. Opening
 * System Settings via `shell.openExternal` is just as fast for the user and
 * keeps the Rust surface lean.
 */
const ForgeAccessibilityPrompt: React.FC<Props> = ({ onGranted }) => {
  const openPrefs = async () => {
    try {
      await window.ironmic?.openAccessibilityPrefs?.();
    } catch {
      // ignore
    }
  };

  const recheck = async () => {
    try {
      const trusted = await window.ironmic?.isAccessibilityTrusted?.();
      if (trusted) onGranted();
    } catch {
      // ignore
    }
  };

  return (
    <div className="forge-perm forge-drag">
      <div className="forge-perm-title">Accessibility access required</div>
      <div className="forge-perm-body">
        Forge types into other apps via synthetic key events. Grant IronMic
        access in System Settings → Privacy & Security → Accessibility.
      </div>
      <div className="forge-perm-actions forge-no-drag">
        <button type="button" className="forge-perm-action" onClick={openPrefs}>
          Open System Settings
        </button>
        <button type="button" className="forge-perm-action secondary" onClick={recheck}>
          Re-check
        </button>
      </div>
    </div>
  );
};

export default ForgeAccessibilityPrompt;
