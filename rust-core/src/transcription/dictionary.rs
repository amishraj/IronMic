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
        let words = self.words.read().unwrap();
        if words.is_empty() {
            return None;
        }

        let mut sorted: Vec<&str> = words.iter().map(|s| s.as_str()).collect();
        sorted.sort();

        let prompt = sorted.join(", ");
        info!(
            word_count = words.len(),
            "Built Whisper initial prompt from dictionary"
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
}
