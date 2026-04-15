use arboard::Clipboard;
use tracing::info;

use crate::error::IronMicError;

/// Copy HTML to the system clipboard with a plain-text fallback.
/// When pasted into rich-text apps (Slack, Docs, email), the HTML is used.
/// When pasted into plain-text contexts, the fallback text is used.
pub fn copy_html_to_clipboard(html: &str, fallback_text: &str) -> Result<(), IronMicError> {
    let mut clipboard = Clipboard::new()
        .map_err(|e| IronMicError::Internal(anyhow::anyhow!("Failed to access clipboard: {e}")))?;

    clipboard
        .set_html(html, Some(fallback_text))
        .map_err(|e| IronMicError::Internal(anyhow::anyhow!("Failed to set HTML clipboard: {e}")))?;

    info!(
        html_len = html.len(),
        text_len = fallback_text.len(),
        "HTML copied to clipboard"
    );
    Ok(())
}
