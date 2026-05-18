//! macOS Accessibility-permission checks for Forge keystroke posting.
//!
//! Posting synthetic key events on macOS requires the host process to be
//! "trusted" by Accessibility (System Settings → Privacy & Security →
//! Accessibility). Without trust, `enigo`'s `CGEventPost` calls silently
//! fail — the user dictates, the bar shows success, but no text appears.
//!
//! `AXIsProcessTrusted()` is a non-prompting check (suitable for a
//! background guard). To prompt the user, the renderer opens
//! `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`
//! via `shell.openExternal` — this avoids needing a CFDictionary FFI here.

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

/// Whether the host process is trusted to post synthetic key events.
/// Non-prompting — safe to call on every Forge dictation as a guard.
pub fn is_trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}
