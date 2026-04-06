use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use tracing::info;

use crate::error::IronMicError;

/// Schema version for migration tracking.
const SCHEMA_VERSION: u32 = 1;

/// Get the platform-appropriate app data directory for IronMic.
pub fn app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("IronMic")
}

/// Get the default database file path.
pub fn default_db_path() -> PathBuf {
    app_data_dir().join("ironmic.db")
}

/// A thread-safe database connection wrapper.
pub struct Database {
    conn: Arc<Mutex<Connection>>,
    path: PathBuf,
}

impl Database {
    /// Open (or create) the database at the given path.
    pub fn open(path: &Path) -> Result<Self, IronMicError> {
        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                IronMicError::Storage(format!("Failed to create data directory: {e}"))
            })?;
        }

        let conn = Connection::open(path)
            .map_err(|e| IronMicError::Storage(format!("Failed to open database: {e}")))?;

        // Enable WAL mode for better concurrent performance
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(|e| IronMicError::Storage(format!("Failed to set pragmas: {e}")))?;

        info!(path = %path.display(), "Database opened");

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
            path: path.to_path_buf(),
        };

        db.run_migrations()?;

        Ok(db)
    }

    /// Open an in-memory database (for testing).
    pub fn open_in_memory() -> Result<Self, IronMicError> {
        let conn = Connection::open_in_memory()
            .map_err(|e| IronMicError::Storage(format!("Failed to open in-memory db: {e}")))?;

        conn.execute_batch("PRAGMA foreign_keys=ON;")
            .map_err(|e| IronMicError::Storage(format!("Failed to set pragmas: {e}")))?;

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
            path: PathBuf::from(":memory:"),
        };

        db.run_migrations()?;

        Ok(db)
    }

    /// Get a locked reference to the connection.
    pub fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap()
    }

    /// Get the database file path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Run all database migrations.
    fn run_migrations(&self) -> Result<(), IronMicError> {
        let conn = self.conn();

        // Create version tracking table
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER NOT NULL
            );",
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to create version table: {e}")))?;

        let current_version: u32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_version",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        if current_version >= SCHEMA_VERSION {
            info!(version = current_version, "Database schema is up to date");
            return Ok(());
        }

        info!(
            current = current_version,
            target = SCHEMA_VERSION,
            "Running database migrations"
        );

        if current_version < 1 {
            self.migrate_v1(&conn)?;
        }

        // Update version
        conn.execute(
            "INSERT INTO schema_version (version) VALUES (?1)",
            [SCHEMA_VERSION],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to update schema version: {e}")))?;

        info!(version = SCHEMA_VERSION, "Database migrations complete");
        Ok(())
    }

    /// Migration v1: Create all initial tables.
    fn migrate_v1(&self, conn: &Connection) -> Result<(), IronMicError> {
        conn.execute_batch(
            "
            -- All dictation entries
            CREATE TABLE IF NOT EXISTS entries (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                raw_transcript TEXT NOT NULL,
                polished_text TEXT,
                display_mode TEXT NOT NULL DEFAULT 'polished',
                duration_seconds REAL,
                source_app TEXT,
                is_pinned INTEGER DEFAULT 0,
                is_archived INTEGER DEFAULT 0,
                tags TEXT
            );

            -- Full-text search index
            CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
                raw_transcript,
                polished_text,
                tags,
                content='entries',
                content_rowid='rowid'
            );

            -- Triggers to keep FTS index in sync
            CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
                INSERT INTO entries_fts(rowid, raw_transcript, polished_text, tags)
                VALUES (new.rowid, new.raw_transcript, new.polished_text, new.tags);
            END;

            CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
                INSERT INTO entries_fts(entries_fts, rowid, raw_transcript, polished_text, tags)
                VALUES ('delete', old.rowid, old.raw_transcript, old.polished_text, old.tags);
            END;

            CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
                INSERT INTO entries_fts(entries_fts, rowid, raw_transcript, polished_text, tags)
                VALUES ('delete', old.rowid, old.raw_transcript, old.polished_text, old.tags);
                INSERT INTO entries_fts(rowid, raw_transcript, polished_text, tags)
                VALUES (new.rowid, new.raw_transcript, new.polished_text, new.tags);
            END;

            -- User-defined custom dictionary words
            CREATE TABLE IF NOT EXISTS dictionary (
                id TEXT PRIMARY KEY,
                word TEXT NOT NULL UNIQUE,
                added_at TEXT NOT NULL
            );

            -- Application settings
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            -- Default settings
            INSERT OR IGNORE INTO settings (key, value) VALUES ('hotkey_record', 'CommandOrControl+Shift+V');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('llm_cleanup_enabled', 'true');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('default_view', 'timeline');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('theme', 'system');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('whisper_model', 'large-v3-turbo');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('llm_model', 'mistral-7b-instruct-q4');
            ",
        )
        .map_err(|e| IronMicError::Storage(format!("Migration v1 failed: {e}")))?;

        info!("Migration v1 applied: created entries, dictionary, settings tables");
        Ok(())
    }
}

impl Clone for Database {
    fn clone(&self) -> Self {
        Self {
            conn: Arc::clone(&self.conn),
            path: self.path.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_in_memory() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(db.path(), Path::new(":memory:"));
    }

    #[test]
    fn schema_created() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();

        // Check tables exist
        let count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='entries'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);

        let count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='dictionary'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);

        let count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='settings'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn default_settings_inserted() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();

        let hotkey: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key='hotkey_record'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(hotkey, "CommandOrControl+Shift+V");

        let cleanup: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key='llm_cleanup_enabled'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cleanup, "true");
    }

    #[test]
    fn idempotent_migrations() {
        let db = Database::open_in_memory().unwrap();
        // Running migrations again should be a no-op
        db.run_migrations().unwrap();
    }

    #[test]
    fn clone_shares_connection() {
        let db = Database::open_in_memory().unwrap();
        let cloned = db.clone();

        // Both should see the same data
        let conn1 = db.conn();
        conn1
            .execute(
                "INSERT INTO settings (key, value) VALUES ('test_key', 'test_value')",
                [],
            )
            .unwrap();
        drop(conn1);

        let conn2 = cloned.conn();
        let val: String = conn2
            .query_row(
                "SELECT value FROM settings WHERE key='test_key'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(val, "test_value");
    }
}
