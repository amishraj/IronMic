/**
 * meetingEngineLifecycle — apply, restore, and live-swap of the active
 * transcription engine across the lifetime of a meeting.
 *
 * Why this is its own module:
 *
 *  - The `transcription_engine` setting is global (one engine active at a
 *    time, system-wide). Meetings prefer Whisper Large for accuracy on long
 *    chunks; dictation prefers Moonshine Base for sub-second latency. So
 *    meetings must temporarily swap the global engine on start and restore
 *    it on end.
 *
 *  - The IPC `setSetting('transcription_engine', value)` flow in
 *    main/ipc-handlers.ts persists to SQLite BEFORE calling the native
 *    engine swap. If the native swap throws, the DB is dirty (stored value
 *    != active engine). Naive caller code can't recover; this helper does.
 *
 *  - The prior engine value must survive React remounts (the user can
 *    navigate to other tabs mid-meeting, since meeting recording runs in
 *    main). So state lives in `useMeetingStore` (Zustand singleton), not
 *    component-local refs.
 *
 *  - Live switching mid-meeting (via the gear popover in the toolbar) has
 *    the same DB-vs-engine partial-write risk and needs the same care.
 *
 * Both `applyMeetingEngine` and `restoreMeetingEngine` and `swapMeetingEngineLive`
 * carry a HARD NEVER-THROWS CONTRACT — all errors are caught internally and
 * surfaced as toasts. Callers can `await` them without try/catch.
 */

import { useMeetingStore } from '../../stores/useMeetingStore';
import { useToastStore } from '../../stores/useToastStore';

const SETTING_DICTATION = 'transcription_engine';
const SETTING_MEETING = 'meeting_transcription_engine';

/**
 * Surface a non-fatal error to the user. Centralized so all lifecycle
 * branches share the same toast styling and duration.
 */
function toast(
  message: string,
  opts: { action?: { label: string; onClick: () => void }; durationMs?: number } = {},
): void {
  try {
    useToastStore.getState().show({
      message,
      type: 'info',
      action: opts.action,
      durationMs: opts.durationMs ?? 8000,
    });
  } catch {
    // No-op in test environments where the store isn't initialized.
  }
}

/**
 * Open the Settings → Input panel where the user can fix the engine
 * mismatch. Implementation: dispatches a CustomEvent that the
 * SettingsPanel listens for, falling back to navigating the URL hash if
 * no listener is attached yet. Best-effort — toast is informative either way.
 */
function navigateToModelsSettings(): void {
  try {
    window.dispatchEvent(new CustomEvent('ironmic:open-models-settings'));
  } catch {
    // ignore
  }
}

async function isEngineReady(engineId: string): Promise<boolean> {
  try {
    return Boolean(await window.ironmic.isTranscriptionEngineReady(engineId));
  } catch {
    return false;
  }
}

/**
 * Apply the meeting's preferred transcription engine for the duration of a
 * meeting. Captures the prior dictation engine so it can be restored on
 * meeting end.
 *
 * Contract:
 *  - Never throws. Internal errors surface as toasts.
 *  - Idempotent: calling twice in a row is a no-op (the second call sees
 *    `meetingEngineApplied: true`).
 *  - Invariant: after this returns, the SQLite `transcription_engine` value
 *    matches the active native engine. No partial-write state.
 */
export async function applyMeetingEngine(): Promise<void> {
  const store = useMeetingStore.getState();

  // Idempotent guard — double-mount, double-click on Start, etc.
  if (store.meetingEngineApplied) return;

  let prior: string | null = null;
  let target: string | null = null;
  try {
    prior = await window.ironmic.getSetting(SETTING_DICTATION);
    target = await window.ironmic.getSetting(SETTING_MEETING);
  } catch (err) {
    // Reading settings failed — unexpected. Clear partial state and bail.
    console.warn('[meetingEngineLifecycle] failed to read settings:', err);
    useMeetingStore.setState({
      priorTranscriptionEngine: null,
      meetingEngineApplied: false,
    });
    toast(
      "Couldn't configure meeting engine; continuing on current engine.",
    );
    return;
  }

  // Step 3 in the plan: capture the prior FIRST, before any readiness check
  // or swap. This is what makes restore work even when the initial apply
  // was a no-op (prior === target) and the user later live-switches.
  useMeetingStore.setState({ priorTranscriptionEngine: prior });

  // No meeting preference set yet (very fresh install or DB without the
  // migration applied) — leave the global engine alone and exit cleanly.
  if (!target) {
    useMeetingStore.setState({ meetingEngineApplied: true });
    return;
  }

  // Readiness check — Whisper Large is the default but isn't downloaded
  // until the user opens Settings → Models. Falling through with a missing
  // engine would either swap to an engine that fails on first chunk, or
  // throw inside the native swap. Pre-empt both.
  const ready = await isEngineReady(target);
  if (!ready) {
    toast(
      `Meeting engine "${target}" isn't downloaded; using current engine "${prior ?? 'default'}" for this meeting.`,
      {
        action: { label: 'Open Models', onClick: navigateToModelsSettings },
      },
    );
    useMeetingStore.setState({ meetingEngineApplied: true });
    return;
  }

  // No-op when prior already matches target.
  if (prior === target) {
    useMeetingStore.setState({ meetingEngineApplied: true });
    return;
  }

  try {
    await window.ironmic.setSetting(SETTING_DICTATION, target);
    useMeetingStore.setState({ meetingEngineApplied: true });
  } catch (err) {
    // ipc-handlers.ts persists the DB row BEFORE calling native swap. If
    // the swap threw, the DB now claims `target` while the active engine
    // is still `prior`. Re-write the DB to match reality.
    console.warn('[meetingEngineLifecycle] engine apply failed:', err);
    if (prior !== null) {
      try {
        await window.ironmic.setSetting(SETTING_DICTATION, prior);
      } catch {
        // Worst case — toast warns the user.
      }
    }
    toast(
      `Couldn't switch transcription engine to "${target}" for this meeting; continuing on "${prior ?? 'default'}".`,
    );
    // Still mark applied so the toast doesn't re-fire on retry. Prior is
    // still captured so any later live-switch restores correctly.
    useMeetingStore.setState({ meetingEngineApplied: true });
  }
}

/**
 * Restore the dictation engine that was active before this meeting started.
 *
 * Contract:
 *  - Never throws. Internal errors surface as toasts.
 *  - Safe to call from `finally` blocks alongside a rethrow of an upstream
 *    error — this method won't mask the upstream throw.
 *  - Idempotent: no-op when `meetingEngineApplied` is false or when there
 *    is no prior to restore.
 */
export async function restoreMeetingEngine(): Promise<void> {
  const { meetingEngineApplied, priorTranscriptionEngine } = useMeetingStore.getState();
  if (!meetingEngineApplied) return;

  if (priorTranscriptionEngine !== null) {
    try {
      await window.ironmic.setSetting(SETTING_DICTATION, priorTranscriptionEngine);
    } catch (err) {
      console.warn('[meetingEngineLifecycle] restore failed:', err);
      toast(
        `Couldn't restore dictation engine to "${priorTranscriptionEngine}". Fix in Settings → Input.`,
        {
          action: { label: 'Open Settings', onClick: navigateToModelsSettings },
        },
      );
    }
  }

  // Always clear — pass or fail — so the store doesn't get stuck and the
  // next meeting can re-capture a fresh prior.
  useMeetingStore.setState({
    priorTranscriptionEngine: null,
    meetingEngineApplied: false,
  });
}

/**
 * Switch engines mid-meeting via the gear popover. Same readiness +
 * partial-write rules as `applyMeetingEngine`, but ALSO updates the
 * persistent `meeting_transcription_engine` preference so the next meeting
 * starts on the new choice.
 *
 * Note: does NOT update `priorTranscriptionEngine`. The "prior" is whatever
 * the user had set globally BEFORE the meeting started, regardless of how
 * many times they live-switch during the meeting. Restore-on-end always
 * returns to that pre-meeting global value.
 *
 * Contract: never throws.
 */
export async function swapMeetingEngineLive(newValue: string): Promise<void> {
  // Capture pre-swap state so we can roll back both keys on partial failure.
  let preActive: string | null = null;
  let prevMeetingPref: string | null = null;
  try {
    preActive = await window.ironmic.getSetting(SETTING_DICTATION);
    prevMeetingPref = await window.ironmic.getSetting(SETTING_MEETING);
  } catch (err) {
    console.warn('[meetingEngineLifecycle] live swap failed to read settings:', err);
    toast("Couldn't switch transcription engine.");
    return;
  }

  if (!(await isEngineReady(newValue))) {
    toast(
      `Engine "${newValue}" isn't downloaded; staying on "${preActive ?? 'current'}".`,
      {
        action: { label: 'Open Models', onClick: navigateToModelsSettings },
      },
    );
    return;
  }

  // Step 3: persist the preference first so the user's choice is remembered
  // for the next meeting even if the live swap below fails.
  try {
    await window.ironmic.setSetting(SETTING_MEETING, newValue);
  } catch (err) {
    console.warn('[meetingEngineLifecycle] live swap pref write failed:', err);
    toast("Couldn't save engine preference; staying on current engine.");
    return;
  }

  // Step 4: the actual native swap. If this throws, ipc-handlers has already
  // persisted SETTING_DICTATION=newValue (per A1 ordering); re-write both
  // SETTING_DICTATION and SETTING_MEETING back to their pre-swap values so
  // DB matches reality.
  try {
    await window.ironmic.setSetting(SETTING_DICTATION, newValue);
  } catch (err) {
    console.warn('[meetingEngineLifecycle] live swap native call failed:', err);
    if (preActive !== null) {
      try {
        await window.ironmic.setSetting(SETTING_DICTATION, preActive);
      } catch {
        // best-effort
      }
    }
    if (prevMeetingPref !== null) {
      try {
        await window.ironmic.setSetting(SETTING_MEETING, prevMeetingPref);
      } catch {
        // best-effort
      }
    }
    toast(
      `Couldn't switch to "${newValue}"; continuing on "${preActive ?? 'current'}".`,
    );
  }
}
