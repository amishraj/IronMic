//! Synthetic keystroke / "paste anywhere" for Forge mode.
//!
//! Forge needs to deliver transcribed text to whatever app currently owns the
//! OS keyboard cursor (Outlook, Teams, Chrome, native Notes, etc.). The flow:
//!
//!   1. Optionally capture the user's prior clipboard text.
//!   2. Write the transcript to the system clipboard.
//!   3. Simulate Cmd+V (macOS) / Ctrl+V (Windows, Linux X11/Wayland).
//!   4. After ~500 ms, restore the prior clipboard text — unless a newer
//!      paste superseded ours (monotonic token cancellation).
//!
//! Clipboard restore is text-only: `arboard` does not preserve images, files,
//! or rich formats. If the user had non-text on the clipboard before paste,
//! `prior` is `None` and the dictated transcript stays on the clipboard
//! until the user's next copy.
//!
//! On macOS, the process must hold Accessibility permission to post synthetic
//! key events. We pre-flight via `is_accessibility_trusted()` and surface a
//! distinct error so the renderer can route the user to System Settings.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use arboard::Clipboard;
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use thiserror::Error;
use tracing::{debug, info, warn};

#[cfg(target_os = "macos")]
mod macos;
// `macos::is_trusted` is no longer called here — the TS side gates on
// `systemPreferences.isTrustedAccessibilityClient()` which uses macOS's
// refreshing `AXIsProcessTrustedWithOptions`. Keeping the module present
// (compiled) keeps the FFI link stable for future re-introduction.
#[cfg(target_os = "macos")]
#[allow(dead_code)]
fn _keep_macos_module_referenced() -> bool { macos::is_trusted() }

// NOTE: Accessibility-permission gating lives in the Electron main process
// via `systemPreferences.isTrustedAccessibilityClient()` (which calls macOS's
// refreshing `AXIsProcessTrustedWithOptions`). We deliberately do NOT gate
// here on `AXIsProcessTrusted()` because that API returns a stale cached
// value at process start and produces false negatives even when the user
// has granted access. The TS-side check is the source of truth.

#[derive(Debug, Error)]
pub enum KeystrokeError {
    #[error("Clipboard access failed: {0}")]
    Clipboard(String),

    #[error("Input simulation failed: {0}")]
    Input(String),

    #[error("Accessibility permission required (macOS)")]
    AccessibilityRequired,

    #[error("Empty text")]
    EmptyText,
}

/// Monotonically-increasing token used to cancel pending clipboard restores
/// when a second paste fires before the first restore window elapses.
static RESTORE_TOKEN: AtomicU64 = AtomicU64::new(0);

fn next_restore_token() -> u64 {
    RESTORE_TOKEN.fetch_add(1, Ordering::SeqCst).wrapping_add(1)
}

fn current_restore_token() -> u64 {
    RESTORE_TOKEN.load(Ordering::SeqCst)
}

/// On macOS, returns whether the process is trusted by Accessibility (i.e.
/// allowed to post synthetic key events). On other platforms, always `true`.
pub fn is_accessibility_trusted() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::is_trusted()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Paste `text` at the OS keyboard cursor. Optionally restores the prior
/// clipboard contents (text only) ~500 ms later.
pub fn paste_text(text: &str, restore_clipboard: bool) -> Result<(), KeystrokeError> {
    if text.is_empty() {
        return Err(KeystrokeError::EmptyText);
    }

    let prior: Option<String> = if restore_clipboard {
        Clipboard::new()
            .ok()
            .and_then(|mut cb| cb.get_text().ok())
    } else {
        None
    };

    {
        let mut cb = Clipboard::new().map_err(|e| KeystrokeError::Clipboard(e.to_string()))?;
        cb.set_text(text.to_string())
            .map_err(|e| KeystrokeError::Clipboard(e.to_string()))?;
    }

    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| KeystrokeError::Input(format!("init: {e}")))?;

    let modifier = if cfg!(target_os = "macos") {
        Key::Meta
    } else {
        Key::Control
    };

    // Some apps (Electron, Chromium-based) sample the pasteboard generation
    // count asynchronously; a tiny gap before the synthetic Cmd/Ctrl+V keeps
    // them from pasting the OLD clipboard contents.
    std::thread::sleep(Duration::from_millis(20));

    enigo
        .key(modifier, Direction::Press)
        .map_err(|e| KeystrokeError::Input(format!("modifier press: {e}")))?;
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| KeystrokeError::Input(format!("v click: {e}")))?;
    enigo
        .key(modifier, Direction::Release)
        .map_err(|e| KeystrokeError::Input(format!("modifier release: {e}")))?;

    info!(
        chars = text.len(),
        will_restore = prior.is_some(),
        "Forge paste posted"
    );

    if let Some(prior_text) = prior {
        let token = next_restore_token();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(500));
            if current_restore_token() != token {
                debug!("Forge clipboard restore cancelled (newer paste superseded)");
                return;
            }
            match Clipboard::new() {
                Ok(mut cb) => {
                    if let Err(e) = cb.set_text(prior_text) {
                        warn!("Forge clipboard restore failed: {e}");
                    } else {
                        debug!("Forge clipboard restored");
                    }
                }
                Err(e) => warn!("Forge clipboard restore: cannot open clipboard: {e}"),
            }
        });
    }

    Ok(())
}

/// Type `text` character-by-character at the OS keyboard cursor. Slower than
/// `paste_text` but works in apps that intercept Cmd/Ctrl+V (some banking
/// sites, certain terminal modes). Does not touch the clipboard.
pub fn type_text(text: &str) -> Result<(), KeystrokeError> {
    if text.is_empty() {
        return Err(KeystrokeError::EmptyText);
    }

    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| KeystrokeError::Input(format!("init: {e}")))?;

    enigo
        .text(text)
        .map_err(|e| KeystrokeError::Input(format!("type: {e}")))?;

    info!(chars = text.len(), "Forge type posted ({} chars)", text.len());
    Ok(())
}
