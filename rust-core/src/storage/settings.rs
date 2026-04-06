use rusqlite::OptionalExtension;

use crate::error::IronMicError;
use crate::storage::db::Database;

/// Settings key-value store operations.
pub struct SettingsStore {
    db: Database,
}

impl SettingsStore {
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    /// Get a setting value by key.
    pub fn get(&self, key: &str) -> Result<Option<String>, IronMicError> {
        let conn = self.db.conn();
        let result = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| IronMicError::Storage(format!("Failed to get setting: {e}")))?;

        Ok(result)
    }

    /// Set a setting value. Creates or updates.
    pub fn set(&self, key: &str, value: &str) -> Result<(), IronMicError> {
        let conn = self.db.conn();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to set setting: {e}")))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_store() -> SettingsStore {
        let db = Database::open_in_memory().unwrap();
        SettingsStore::new(db)
    }

    #[test]
    fn get_default_settings() {
        let store = test_store();
        let hotkey = store.get("hotkey_record").unwrap().unwrap();
        assert_eq!(hotkey, "CommandOrControl+Shift+V");
    }

    #[test]
    fn get_nonexistent() {
        let store = test_store();
        assert!(store.get("nonexistent_key").unwrap().is_none());
    }

    #[test]
    fn set_and_get() {
        let store = test_store();
        store.set("custom_key", "custom_value").unwrap();
        let val = store.get("custom_key").unwrap().unwrap();
        assert_eq!(val, "custom_value");
    }

    #[test]
    fn set_overwrites() {
        let store = test_store();
        store.set("theme", "dark").unwrap();
        let val = store.get("theme").unwrap().unwrap();
        assert_eq!(val, "dark");
    }

    #[test]
    fn set_creates_new() {
        let store = test_store();
        store.set("new_setting", "new_value").unwrap();
        let val = store.get("new_setting").unwrap().unwrap();
        assert_eq!(val, "new_value");
    }
}
