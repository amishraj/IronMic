use chrono::Utc;
use uuid::Uuid;

use crate::error::IronMicError;
use crate::storage::db::Database;

/// Dictionary CRUD operations for custom words.
pub struct DictionaryStore {
    db: Database,
}

impl DictionaryStore {
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    /// Add a word to the dictionary.
    pub fn add_word(&self, word: &str) -> Result<(), IronMicError> {
        let word = word.trim();
        if word.is_empty() {
            return Ok(());
        }

        let conn = self.db.conn();
        conn.execute(
            "INSERT OR IGNORE INTO dictionary (id, word, added_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![Uuid::new_v4().to_string(), word, Utc::now().to_rfc3339()],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to add word: {e}")))?;

        Ok(())
    }

    /// Remove a word from the dictionary.
    pub fn remove_word(&self, word: &str) -> Result<(), IronMicError> {
        let conn = self.db.conn();
        conn.execute("DELETE FROM dictionary WHERE word = ?1", [word.trim()])
            .map_err(|e| IronMicError::Storage(format!("Failed to remove word: {e}")))?;
        Ok(())
    }

    /// List all dictionary words, sorted alphabetically.
    pub fn list_words(&self) -> Result<Vec<String>, IronMicError> {
        let conn = self.db.conn();
        let mut stmt = conn
            .prepare("SELECT word FROM dictionary ORDER BY word")
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;

        let words = stmt
            .query_map([], |row| row.get(0))
            .map_err(|e| IronMicError::Storage(format!("Failed to list words: {e}")))?;

        words
            .collect::<Result<Vec<String>, _>>()
            .map_err(|e| IronMicError::Storage(format!("Failed to collect words: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_store() -> DictionaryStore {
        let db = Database::open_in_memory().unwrap();
        DictionaryStore::new(db)
    }

    #[test]
    fn add_and_list() {
        let store = test_store();
        store.add_word("Kubernetes").unwrap();
        store.add_word("gRPC").unwrap();

        let words = store.list_words().unwrap();
        assert_eq!(words.len(), 2);
        assert_eq!(words, vec!["Kubernetes", "gRPC"]);
    }

    #[test]
    fn add_duplicate_ignored() {
        let store = test_store();
        store.add_word("Rust").unwrap();
        store.add_word("Rust").unwrap();

        let words = store.list_words().unwrap();
        assert_eq!(words.len(), 1);
    }

    #[test]
    fn add_empty_ignored() {
        let store = test_store();
        store.add_word("").unwrap();
        store.add_word("   ").unwrap();

        let words = store.list_words().unwrap();
        assert!(words.is_empty());
    }

    #[test]
    fn remove_word() {
        let store = test_store();
        store.add_word("Rust").unwrap();
        store.add_word("Go").unwrap();

        store.remove_word("Rust").unwrap();

        let words = store.list_words().unwrap();
        assert_eq!(words, vec!["Go"]);
    }

    #[test]
    fn remove_nonexistent() {
        let store = test_store();
        store.remove_word("NotHere").unwrap(); // should not error
    }

    #[test]
    fn list_empty() {
        let store = test_store();
        let words = store.list_words().unwrap();
        assert!(words.is_empty());
    }
}
