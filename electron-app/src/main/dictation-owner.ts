/**
 * Single source of truth for "which window owns the current dictation."
 *
 * Why this exists:
 *   The Rust `PipelineStateMachine` exists at rust-core/src/hotkey/listener.rs
 *   but its lifecycle methods (on_hotkey_press / complete_processing) are NOT
 *   wired into the actual recording path today — only getPipelineState /
 *   resetPipelineState are exported. So we cannot rely on it to serialize
 *   Forge vs main hotkey events.
 *
 *   Instead, the Electron main process tracks an authoritative
 *   `DictationOwner` record and dispatches the global hotkey based on it:
 *
 *     - When `null`, route the hotkey to the active window (Forge if
 *       `isForgeMode()` is true, else main) and stamp owner with phase
 *       'recording'.
 *     - When the in-flight owner matches the active mode AND phase is
 *       'recording', allow the recording → processing transition.
 *     - Otherwise reject (different owner, or already processing).
 *
 *   Cleared via `clearForgeOwner` / `clearMainOwner` on completion handshake
 *   from the renderer (see IPC `FORGE_DICTATION_COMPLETE`).
 *
 *   This is a deliberately small, observable record. A future slice may wire
 *   the Rust state machine for real and replace this — until then, this is
 *   the contract.
 */

export type DictationOwnerKind = 'main' | 'forge';
export type DictationPhase = 'recording' | 'processing';

export interface DictationOwner {
  owner: DictationOwnerKind;
  phase: DictationPhase;
  startedAt: number;
}

let current: DictationOwner | null = null;

export function getOwner(): DictationOwner | null {
  return current;
}

/**
 * Decide whether the next hotkey press from the active mode should be
 * dispatched, and if so, what phase transition to record. Mutates internal
 * state on accept.
 *
 * Returns:
 *   { dispatch: true,  phase: 'recording'  } — start a fresh dictation
 *   { dispatch: true,  phase: 'processing' } — stop existing recording
 *   { dispatch: false, reason: string }     — reject (debounce or contention)
 */
export function tryDispatchHotkey(
  activeOwner: DictationOwnerKind,
): { dispatch: true; phase: DictationPhase } | { dispatch: false; reason: string } {
  if (current === null) {
    current = { owner: activeOwner, phase: 'recording', startedAt: Date.now() };
    return { dispatch: true, phase: 'recording' };
  }

  if (current.owner !== activeOwner) {
    return {
      dispatch: false,
      reason: `dictation in flight for ${current.owner} — ignoring ${activeOwner} hotkey`,
    };
  }

  if (current.phase === 'processing') {
    return {
      dispatch: false,
      reason: 'already processing — hotkey debounced',
    };
  }

  // recording → processing transition for the same owner
  current = { ...current, phase: 'processing' };
  return { dispatch: true, phase: 'processing' };
}

export function setForgeOwnerProcessing(): void {
  if (current?.owner === 'forge') {
    current = { ...current, phase: 'processing' };
  }
}

export function clearForgeOwner(): void {
  if (current?.owner === 'forge') {
    current = null;
  }
}

export function clearMainOwner(): void {
  if (current?.owner === 'main') {
    current = null;
  }
}

export function clearOwner(): void {
  current = null;
}
