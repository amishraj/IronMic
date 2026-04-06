use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

use tracing::{debug, info, warn};

/// The application state machine for the recording pipeline.
///
/// State transitions:
///   Idle + hotkey → Recording
///   Recording + hotkey → Processing
///   Processing + hotkey → ignored (debounced)
///   Processing complete → Idle
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum PipelineState {
    Idle = 0,
    Recording = 1,
    Processing = 2,
}

impl PipelineState {
    fn from_u8(v: u8) -> Self {
        match v {
            0 => Self::Idle,
            1 => Self::Recording,
            2 => Self::Processing,
            _ => Self::Idle,
        }
    }
}

impl std::fmt::Display for PipelineState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Idle => write!(f, "idle"),
            Self::Recording => write!(f, "recording"),
            Self::Processing => write!(f, "processing"),
        }
    }
}

/// Manages the pipeline state machine with atomic transitions.
#[derive(Clone)]
pub struct PipelineStateMachine {
    state: Arc<AtomicU8>,
}

impl PipelineStateMachine {
    pub fn new() -> Self {
        Self {
            state: Arc::new(AtomicU8::new(PipelineState::Idle as u8)),
        }
    }

    pub fn current(&self) -> PipelineState {
        PipelineState::from_u8(self.state.load(Ordering::SeqCst))
    }

    /// Attempt a state transition based on a hotkey press.
    /// Returns the new state, or None if the press was ignored.
    pub fn on_hotkey_press(&self) -> Option<PipelineState> {
        let current = self.current();
        match current {
            PipelineState::Idle => {
                self.state
                    .store(PipelineState::Recording as u8, Ordering::SeqCst);
                info!("State: Idle → Recording");
                Some(PipelineState::Recording)
            }
            PipelineState::Recording => {
                self.state
                    .store(PipelineState::Processing as u8, Ordering::SeqCst);
                info!("State: Recording → Processing");
                Some(PipelineState::Processing)
            }
            PipelineState::Processing => {
                debug!("Hotkey press ignored — currently processing");
                None
            }
        }
    }

    /// Transition from Processing back to Idle (called when pipeline completes).
    pub fn complete_processing(&self) {
        let prev = self.state.swap(PipelineState::Idle as u8, Ordering::SeqCst);
        if prev == PipelineState::Processing as u8 {
            info!("State: Processing → Idle");
        } else {
            warn!(
                prev_state = PipelineState::from_u8(prev).to_string(),
                "complete_processing called from unexpected state"
            );
        }
    }

    /// Force reset to Idle (error recovery).
    pub fn reset(&self) {
        self.state
            .store(PipelineState::Idle as u8, Ordering::SeqCst);
        info!("State reset to Idle");
    }
}

impl Default for PipelineStateMachine {
    fn default() -> Self {
        Self::new()
    }
}

/// Parse a hotkey accelerator string into a human-readable description.
/// Examples: "CommandOrControl+Shift+V" → "⌘+Shift+V" (macOS) or "Ctrl+Shift+V" (other)
pub fn format_accelerator(accelerator: &str) -> String {
    if cfg!(target_os = "macos") {
        accelerator.replace("CommandOrControl", "⌘").replace("Command", "⌘")
    } else {
        accelerator.replace("CommandOrControl", "Ctrl")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_state_is_idle() {
        let sm = PipelineStateMachine::new();
        assert_eq!(sm.current(), PipelineState::Idle);
    }

    #[test]
    fn idle_to_recording() {
        let sm = PipelineStateMachine::new();
        let result = sm.on_hotkey_press();
        assert_eq!(result, Some(PipelineState::Recording));
        assert_eq!(sm.current(), PipelineState::Recording);
    }

    #[test]
    fn recording_to_processing() {
        let sm = PipelineStateMachine::new();
        sm.on_hotkey_press(); // → Recording
        let result = sm.on_hotkey_press();
        assert_eq!(result, Some(PipelineState::Processing));
        assert_eq!(sm.current(), PipelineState::Processing);
    }

    #[test]
    fn processing_ignores_hotkey() {
        let sm = PipelineStateMachine::new();
        sm.on_hotkey_press(); // → Recording
        sm.on_hotkey_press(); // → Processing
        let result = sm.on_hotkey_press();
        assert_eq!(result, None);
        assert_eq!(sm.current(), PipelineState::Processing);
    }

    #[test]
    fn complete_processing_returns_to_idle() {
        let sm = PipelineStateMachine::new();
        sm.on_hotkey_press(); // → Recording
        sm.on_hotkey_press(); // → Processing
        sm.complete_processing();
        assert_eq!(sm.current(), PipelineState::Idle);
    }

    #[test]
    fn full_cycle() {
        let sm = PipelineStateMachine::new();

        // Cycle 1
        assert_eq!(sm.on_hotkey_press(), Some(PipelineState::Recording));
        assert_eq!(sm.on_hotkey_press(), Some(PipelineState::Processing));
        assert_eq!(sm.on_hotkey_press(), None); // ignored
        sm.complete_processing();
        assert_eq!(sm.current(), PipelineState::Idle);

        // Cycle 2
        assert_eq!(sm.on_hotkey_press(), Some(PipelineState::Recording));
        assert_eq!(sm.on_hotkey_press(), Some(PipelineState::Processing));
        sm.complete_processing();
        assert_eq!(sm.current(), PipelineState::Idle);
    }

    #[test]
    fn reset_to_idle() {
        let sm = PipelineStateMachine::new();
        sm.on_hotkey_press(); // → Recording
        sm.reset();
        assert_eq!(sm.current(), PipelineState::Idle);
    }

    #[test]
    fn clone_shares_state() {
        let sm = PipelineStateMachine::new();
        let cloned = sm.clone();
        sm.on_hotkey_press(); // → Recording
        assert_eq!(cloned.current(), PipelineState::Recording);
    }

    #[test]
    fn state_display() {
        assert_eq!(PipelineState::Idle.to_string(), "idle");
        assert_eq!(PipelineState::Recording.to_string(), "recording");
        assert_eq!(PipelineState::Processing.to_string(), "processing");
    }

    #[test]
    fn format_accelerator_macos() {
        if cfg!(target_os = "macos") {
            assert_eq!(format_accelerator("CommandOrControl+Shift+V"), "⌘+Shift+V");
        }
    }

    #[test]
    fn format_accelerator_generic() {
        if !cfg!(target_os = "macos") {
            assert_eq!(
                format_accelerator("CommandOrControl+Shift+V"),
                "Ctrl+Shift+V"
            );
        }
    }
}
