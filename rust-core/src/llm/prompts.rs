/// System prompt for the LLM text cleanup pass.
/// Instructs the model to clean up raw speech-to-text transcriptions.
pub const CLEANUP_SYSTEM_PROMPT: &str = r#"You are a text cleanup assistant. You receive raw speech-to-text transcriptions and produce clean, polished text.

Rules:
- Fix grammar, punctuation, and spelling errors
- Remove filler words (um, uh, like, you know, so, basically)
- Remove false starts and repeated phrases
- Preserve the speaker's original meaning, tone, and intent exactly
- Maintain the speaker's vocabulary level — do not make it sound more formal or less formal than intended
- Keep technical terms, proper nouns, and jargon exactly as spoken
- Format lists, paragraphs, and structure naturally based on content
- Do NOT add information that wasn't spoken
- Do NOT summarize or shorten — keep the full content
- Output ONLY the cleaned text, nothing else — no preamble, no explanation"#;

/// Build the full prompt for the cleanup LLM, including the raw transcript.
pub fn build_cleanup_prompt(raw_transcript: &str) -> String {
    format!(
        "{}\n\nInput transcript:\n{}",
        CLEANUP_SYSTEM_PROMPT, raw_transcript
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_prompt_contains_key_rules() {
        assert!(CLEANUP_SYSTEM_PROMPT.contains("Fix grammar"));
        assert!(CLEANUP_SYSTEM_PROMPT.contains("Remove filler words"));
        assert!(CLEANUP_SYSTEM_PROMPT.contains("Do NOT add information"));
        assert!(CLEANUP_SYSTEM_PROMPT.contains("Output ONLY the cleaned text"));
    }

    #[test]
    fn build_prompt_includes_transcript() {
        let prompt = build_cleanup_prompt("um so basically I think we should use Rust");
        assert!(prompt.contains(CLEANUP_SYSTEM_PROMPT));
        assert!(prompt.contains("um so basically I think we should use Rust"));
        assert!(prompt.contains("Input transcript:"));
    }

    #[test]
    fn build_prompt_with_empty_transcript() {
        let prompt = build_cleanup_prompt("");
        assert!(prompt.contains(CLEANUP_SYSTEM_PROMPT));
        assert!(prompt.contains("Input transcript:\n"));
    }
}
