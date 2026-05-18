use std::collections::HashSet;
use std::sync::{Arc, RwLock};

use tracing::{debug, info};

/// Manages a custom dictionary of domain-specific words to boost
/// Whisper's recognition accuracy.
///
/// Words in this dictionary are used to build an initial prompt that
/// primes Whisper to recognize these terms correctly.
#[derive(Clone)]
pub struct Dictionary {
    words: Arc<RwLock<HashSet<String>>>,
}

impl Dictionary {
    pub fn new() -> Self {
        Self {
            words: Arc::new(RwLock::new(HashSet::new())),
        }
    }

    /// Create a dictionary pre-populated with words.
    pub fn with_words(words: Vec<String>) -> Self {
        let dict = Self::new();
        {
            let mut set = dict.words.write().unwrap();
            for word in words {
                set.insert(word);
            }
        }
        dict
    }

    /// Add a word to the dictionary.
    pub fn add_word(&self, word: &str) {
        let word = word.trim().to_string();
        if word.is_empty() {
            return;
        }
        let mut words = self.words.write().unwrap();
        if words.insert(word.clone()) {
            debug!(word = %word, "Added word to dictionary");
        }
    }

    /// Remove a word from the dictionary.
    pub fn remove_word(&self, word: &str) -> bool {
        let mut words = self.words.write().unwrap();
        let removed = words.remove(word.trim());
        if removed {
            debug!(word = %word, "Removed word from dictionary");
        }
        removed
    }

    /// Replace the entire word set in one lock acquisition. Used by
    /// `engine::replace_active_dictionary` after the N-API layer reads
    /// the persisted word list from SQLite.
    pub fn replace_words(&self, words: Vec<String>) {
        let mut set = self.words.write().unwrap();
        set.clear();
        for word in words {
            let trimmed = word.trim();
            if !trimmed.is_empty() {
                set.insert(trimmed.to_string());
            }
        }
    }

    /// List all words in the dictionary.
    pub fn list_words(&self) -> Vec<String> {
        let words = self.words.read().unwrap();
        let mut sorted: Vec<String> = words.iter().cloned().collect();
        sorted.sort();
        sorted
    }

    /// Returns the number of words in the dictionary.
    pub fn len(&self) -> usize {
        self.words.read().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.words.read().unwrap().is_empty()
    }

    /// Build an initial prompt string containing all dictionary words.
    /// Whisper uses this prompt to bias recognition toward these terms.
    ///
    /// The prompt is a comma-separated list of words, which helps Whisper
    /// understand the expected vocabulary without being too prescriptive.
    pub fn build_whisper_prompt(&self) -> Option<String> {
        self.build_whisper_prompt_with_extras(&[])
    }

    /// Build an initial prompt that combines the stored dictionary with
    /// per-call `extra_terms` (e.g. meeting participant names). The merge
    /// order prioritizes `extra_terms` first, then dictionary words; longer
    /// terms come earlier within each group; ~200 char cap protects against
    /// pathological inputs (Whisper's prompt is bounded by token budget).
    ///
    /// Returns `None` only when the combined deduped set is empty.
    pub fn build_whisper_prompt_with_extras(&self, extra_terms: &[String]) -> Option<String> {
        let dict_words = self.words.read().unwrap();
        if dict_words.is_empty() && extra_terms.is_empty() {
            return None;
        }

        const PROMPT_CHAR_BUDGET: usize = 200;

        let mut seen: HashSet<String> = HashSet::new();
        let mut ordered: Vec<String> = Vec::new();

        let mut extras_sorted: Vec<&str> =
            extra_terms.iter().map(|s| s.as_str()).filter(|s| !s.is_empty()).collect();
        extras_sorted.sort_by(|a, b| b.len().cmp(&a.len()).then(a.cmp(b)));

        let mut dict_sorted: Vec<&str> = dict_words.iter().map(|s| s.as_str()).collect();
        dict_sorted.sort_by(|a, b| b.len().cmp(&a.len()).then(a.cmp(b)));

        for term in extras_sorted.into_iter().chain(dict_sorted) {
            let key = term.to_lowercase();
            if seen.insert(key) {
                ordered.push(term.to_string());
            }
        }

        let mut prompt = String::new();
        for term in &ordered {
            let sep_len = if prompt.is_empty() { 0 } else { 2 };
            if prompt.len() + sep_len + term.len() > PROMPT_CHAR_BUDGET {
                break;
            }
            if !prompt.is_empty() {
                prompt.push_str(", ");
            }
            prompt.push_str(term);
        }

        if prompt.is_empty() {
            return None;
        }

        info!(
            word_count = ordered.len(),
            extras_count = extra_terms.len(),
            chars = prompt.len(),
            "Built Whisper initial prompt"
        );
        Some(prompt)
    }
}

impl Default for Dictionary {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_dictionary_is_empty() {
        let dict = Dictionary::new();
        assert!(dict.is_empty());
        assert_eq!(dict.len(), 0);
    }

    #[test]
    fn add_and_list_words() {
        let dict = Dictionary::new();
        dict.add_word("Kubernetes");
        dict.add_word("gRPC");
        dict.add_word("PostgreSQL");

        let words = dict.list_words();
        assert_eq!(words.len(), 3);
        // list_words returns sorted
        assert_eq!(words, vec!["Kubernetes", "PostgreSQL", "gRPC"]);
    }

    #[test]
    fn add_duplicate_word() {
        let dict = Dictionary::new();
        dict.add_word("Kubernetes");
        dict.add_word("Kubernetes");
        assert_eq!(dict.len(), 1);
    }

    #[test]
    fn add_empty_word_ignored() {
        let dict = Dictionary::new();
        dict.add_word("");
        dict.add_word("   ");
        assert!(dict.is_empty());
    }

    #[test]
    fn remove_word() {
        let dict = Dictionary::new();
        dict.add_word("Rust");
        assert!(dict.remove_word("Rust"));
        assert!(dict.is_empty());
    }

    #[test]
    fn remove_nonexistent_word() {
        let dict = Dictionary::new();
        assert!(!dict.remove_word("NotHere"));
    }

    #[test]
    fn with_words_constructor() {
        let dict = Dictionary::with_words(vec![
            "IronMic".into(),
            "Whisper".into(),
            "llama".into(),
        ]);
        assert_eq!(dict.len(), 3);
    }

    #[test]
    fn build_whisper_prompt_empty() {
        let dict = Dictionary::new();
        assert!(dict.build_whisper_prompt().is_none());
    }

    #[test]
    fn build_whisper_prompt_with_words() {
        let dict = Dictionary::new();
        dict.add_word("Kubernetes");
        dict.add_word("gRPC");

        let prompt = dict.build_whisper_prompt().unwrap();
        assert!(prompt.contains("Kubernetes"));
        assert!(prompt.contains("gRPC"));
        assert!(prompt.contains(", "));
    }

    #[test]
    fn build_whisper_prompt_with_extras_orders_extras_first() {
        let dict = Dictionary::with_words(vec!["alpha".into(), "beta".into()]);
        let prompt = dict
            .build_whisper_prompt_with_extras(&["Alice".into(), "Bob".into()])
            .unwrap();
        let alice_pos = prompt.find("Alice").unwrap();
        let alpha_pos = prompt.find("alpha").unwrap();
        assert!(alice_pos < alpha_pos, "names should come before dict words: {prompt}");
    }

    #[test]
    fn build_whisper_prompt_with_extras_dedupes_case_insensitive() {
        let dict = Dictionary::with_words(vec!["Alice".into()]);
        let prompt = dict
            .build_whisper_prompt_with_extras(&["alice".into(), "Bob".into()])
            .unwrap();
        let occurrences = prompt.matches("lice").count();
        assert_eq!(occurrences, 1, "dedup should fold Alice/alice: {prompt}");
        assert!(prompt.contains("Bob"));
    }

    #[test]
    fn build_whisper_prompt_with_extras_respects_char_cap() {
        let dict = Dictionary::with_words(
            (0..50).map(|i| format!("longword{:04}", i)).collect(),
        );
        let prompt = dict.build_whisper_prompt_with_extras(&[]).unwrap();
        assert!(prompt.len() <= 200, "prompt exceeded 200 chars: {}", prompt.len());
    }

    #[test]
    fn build_whisper_prompt_with_extras_empty_returns_none() {
        let dict = Dictionary::new();
        assert!(dict.build_whisper_prompt_with_extras(&[]).is_none());
    }

    #[test]
    fn build_whisper_prompt_with_extras_orders_longest_first_within_group() {
        let dict = Dictionary::new();
        let prompt = dict
            .build_whisper_prompt_with_extras(&["Bo".into(), "Alexandra".into(), "Ed".into()])
            .unwrap();
        let alex_pos = prompt.find("Alexandra").unwrap();
        let bo_pos = prompt.find("Bo").unwrap();
        assert!(alex_pos < bo_pos, "longest first: {prompt}");
    }
}
