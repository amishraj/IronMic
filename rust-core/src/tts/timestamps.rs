use serde::{Deserialize, Serialize};

/// Word-level timestamp for text highlighting during playback.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WordTimestamp {
    pub word: String,
    pub start_ms: u32,
    pub end_ms: u32,
}

/// Estimate word timestamps by distributing total duration evenly across words.
/// Used as fallback when the TTS engine doesn't provide phoneme-level timing.
pub fn estimate_timestamps(text: &str, total_duration_ms: u32) -> Vec<WordTimestamp> {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() {
        return vec![];
    }

    // Weight words by character length for more natural timing
    let total_chars: usize = words.iter().map(|w| w.len()).sum();
    if total_chars == 0 {
        return vec![];
    }

    let mut timestamps = Vec::with_capacity(words.len());
    let mut cursor_ms: f64 = 0.0;

    for word in &words {
        let word_weight = word.len() as f64 / total_chars as f64;
        let word_duration = total_duration_ms as f64 * word_weight;
        let start = cursor_ms as u32;
        cursor_ms += word_duration;
        let end = cursor_ms as u32;

        timestamps.push(WordTimestamp {
            word: word.to_string(),
            start_ms: start,
            end_ms: end,
        });
    }

    // Ensure last word ends exactly at total duration
    if let Some(last) = timestamps.last_mut() {
        last.end_ms = total_duration_ms;
    }

    timestamps
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_empty() {
        assert!(estimate_timestamps("", 1000).is_empty());
        assert!(estimate_timestamps("   ", 1000).is_empty());
    }

    #[test]
    fn estimate_single_word() {
        let ts = estimate_timestamps("hello", 500);
        assert_eq!(ts.len(), 1);
        assert_eq!(ts[0].word, "hello");
        assert_eq!(ts[0].start_ms, 0);
        assert_eq!(ts[0].end_ms, 500);
    }

    #[test]
    fn estimate_multiple_words() {
        let ts = estimate_timestamps("hello world", 1000);
        assert_eq!(ts.len(), 2);
        assert_eq!(ts[0].start_ms, 0);
        assert!(ts[0].end_ms > 0);
        assert_eq!(ts[1].end_ms, 1000);
        // "hello" and "world" are same length, so roughly equal splits
        assert!((ts[0].end_ms as i32 - 500).abs() < 10);
    }

    #[test]
    fn estimate_weights_by_length() {
        let ts = estimate_timestamps("I extraordinary", 1000);
        assert_eq!(ts.len(), 2);
        // "I" is 1 char, "extraordinary" is 13 chars — "I" should get ~1/14 of duration
        assert!(ts[0].end_ms < 200); // ~71ms for a 1-char word
    }

    #[test]
    fn estimate_contiguous() {
        let ts = estimate_timestamps("one two three four", 2000);
        for i in 1..ts.len() {
            assert_eq!(ts[i].start_ms, ts[i - 1].end_ms);
        }
    }
}
