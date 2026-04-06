import { useEffect } from 'react';
import { useSettingsStore } from '../stores/useSettingsStore';

/**
 * Manages the `dark` class on <html> based on the theme setting.
 * - "dark"   → always dark
 * - "light"  → always light
 * - "system" → follows OS preference via prefers-color-scheme
 */
export function useTheme() {
  const theme = useSettingsStore((s) => s.theme);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');

    function apply() {
      const shouldBeDark =
        theme === 'dark' || (theme === 'system' && mq.matches);

      document.documentElement.classList.toggle('dark', shouldBeDark);
    }

    apply();

    // Re-apply when system preference changes (only matters for "system" mode)
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}
