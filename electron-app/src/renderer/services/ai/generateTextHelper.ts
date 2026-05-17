/**
 * Thin wrapper around `window.ironmic.generateText` that surfaces a toast when
 * AIManager transparently fell back to a different provider (today: Copilot
 * CLI → local LLM when the binary's stdin probe fails for large prompts).
 *
 * Both summary call sites — SummaryGenerator.callPolish and
 * MeetingTemplateEngine.generateStructuredNotes — should call this helper
 * instead of `window.ironmic.generateText` directly so the toast logic lives
 * in exactly one place.
 *
 * Lives under `services/ai/` rather than `services/meeting/` because
 * MeetingTemplateEngine resides in `services/tfjs/` and a general LLM helper
 * shouldn't depend on the meeting namespace.
 */

import { useToastStore } from '../../stores/useToastStore';

type GenerateOpts = {
  maxTokens?: number;
  temperature?: number;
  forceLocal?: boolean;
};

type GenerateResult = {
  text: string;
  providerUsed: 'claude' | 'copilot' | 'local';
  fallbackUsed?: string;
};

/**
 * Module-level flag — one toast per app process. Rationale: AIManager's cache
 * also lives at process scope, so once Copilot stdin support is known to be
 * broken on the active binary, every subsequent *large-prompt* call quietly
 * falls back. Toasting per-call (or even per-meeting) would just spam.
 *
 * Small argv-eligible prompts on the same binary still try Copilot, but those
 * don't trigger fallbacks either way.
 */
let toastShownThisProcess = false;

/**
 * The user-facing copy. Plain text — `useToastStore` does not render Markdown,
 * so backticks would render literally.
 */
const COPILOT_LARGE_PROMPT_TOAST_MESSAGE =
  "Used local LLM — Copilot CLI on this machine can't accept large prompts. " +
  'Run npm i -g @github/copilot or switch provider in Settings.';

/**
 * Call `window.ironmic.generateText` and surface a toast on transparent
 * provider fallback. Returns the full result so callers can still inspect
 * `providerUsed` / `fallbackUsed` if they want to.
 */
export async function generateTextWithFallbackToast(
  systemPrompt: string,
  userPrompt: string,
  opts?: GenerateOpts,
): Promise<GenerateResult> {
  const ironmic = window.ironmic;
  if (!ironmic?.generateText) {
    throw new Error('generateText IPC not available');
  }
  const result = (await ironmic.generateText(systemPrompt, userPrompt, opts)) as GenerateResult;
  if (
    result.fallbackUsed === 'local-llm-from-copilot-large-prompt' &&
    !toastShownThisProcess
  ) {
    toastShownThisProcess = true;
    try {
      useToastStore.getState().show({
        message: COPILOT_LARGE_PROMPT_TOAST_MESSAGE,
        type: 'info',
        durationMs: 10_000,
      });
    } catch {
      // Toast store is renderer-only; if this helper somehow runs outside
      // the renderer we just skip the toast — the fallback itself already
      // succeeded.
    }
  }
  return result;
}

/**
 * Test-only: reset the once-per-process toast guard. Exposed so unit tests
 * can exercise the toast path repeatedly without bleeding state across tests.
 * Not used by production code.
 */
export function __resetGenerateTextToastFlagForTests(): void {
  toastShownThisProcess = false;
}
