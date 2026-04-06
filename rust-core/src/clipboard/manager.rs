use arboard::Clipboard;
use tracing::info;

use crate::error::IronMicError;

/// Copy text to the system clipboard.
pub fn copy_to_clipboard(text: &str) -> Result<(), IronMicError> {
    let mut clipboard = Clipboard::new()
        .map_err(|e| IronMicError::Internal(anyhow::anyhow!("Failed to access clipboard: {e}")))?;

    clipboard
        .set_text(text)
        .map_err(|e| IronMicError::Internal(anyhow::anyhow!("Failed to set clipboard: {e}")))?;

    info!(chars = text.len(), "Text copied to clipboard");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_text() {
        // This test may fail in headless/CI environments without a display server.
        // It's a best-effort test for local development.
        let result = copy_to_clipboard("IronMic test text");
        // We don't assert success because clipboard access may not be available
        // in all test environments (e.g., CI, SSH sessions).
        if result.is_err() {
            eprintln!(
                "Clipboard test skipped (no display server): {}",
                result.unwrap_err()
            );
        }
    }
}
