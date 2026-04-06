use chrono::Utc;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::IronMicError;
use crate::storage::db::Database;

/// A dictation entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub created_at: String,
    pub updated_at: String,
    pub raw_transcript: String,
    pub polished_text: Option<String>,
    pub display_mode: String,
    pub duration_seconds: Option<f64>,
    pub source_app: Option<String>,
    pub is_pinned: bool,
    pub is_archived: bool,
    pub tags: Option<String>,
}

/// Parameters for creating a new entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewEntry {
    pub raw_transcript: String,
    pub polished_text: Option<String>,
    pub duration_seconds: Option<f64>,
    pub source_app: Option<String>,
}

/// Parameters for listing entries.
#[derive(Debug, Clone, Default)]
pub struct ListOptions {
    pub limit: u32,
    pub offset: u32,
    pub search: Option<String>,
    pub archived: Option<bool>,
}

/// Partial update fields for an entry.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EntryUpdate {
    pub raw_transcript: Option<String>,
    pub polished_text: Option<Option<String>>,
    pub display_mode: Option<String>,
    pub tags: Option<Option<String>>,
    pub source_app: Option<Option<String>>,
}

fn row_to_entry(row: &rusqlite::Row) -> rusqlite::Result<Entry> {
    Ok(Entry {
        id: row.get(0)?,
        created_at: row.get(1)?,
        updated_at: row.get(2)?,
        raw_transcript: row.get(3)?,
        polished_text: row.get(4)?,
        display_mode: row.get(5)?,
        duration_seconds: row.get(6)?,
        source_app: row.get(7)?,
        is_pinned: row.get::<_, i32>(8)? != 0,
        is_archived: row.get::<_, i32>(9)? != 0,
        tags: row.get(10)?,
    })
}

const SELECT_COLS: &str =
    "id, created_at, updated_at, raw_transcript, polished_text, display_mode, duration_seconds, source_app, is_pinned, is_archived, tags";

fn get_entry_with_conn(conn: &Connection, id: &str) -> Result<Option<Entry>, IronMicError> {
    let mut stmt = conn
        .prepare(&format!("SELECT {SELECT_COLS} FROM entries WHERE id = ?1"))
        .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;

    stmt.query_row([id], row_to_entry)
        .optional()
        .map_err(|e| IronMicError::Storage(format!("Failed to get entry: {e}")))
}

/// Entry CRUD operations.
pub struct EntryStore {
    db: Database,
}

impl EntryStore {
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    /// Create a new entry.
    pub fn create(&self, new: NewEntry) -> Result<Entry, IronMicError> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        let conn = self.db.conn();
        conn.execute(
            "INSERT INTO entries (id, created_at, updated_at, raw_transcript, polished_text, duration_seconds, source_app)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                id, now, now,
                new.raw_transcript, new.polished_text, new.duration_seconds, new.source_app,
            ],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to create entry: {e}")))?;

        get_entry_with_conn(&conn, &id)?
            .ok_or_else(|| IronMicError::Storage("Entry not found after creation".into()))
    }

    /// Get an entry by ID.
    pub fn get(&self, id: &str) -> Result<Option<Entry>, IronMicError> {
        let conn = self.db.conn();
        get_entry_with_conn(&conn, id)
    }

    /// Update an entry.
    pub fn update(&self, id: &str, updates: EntryUpdate) -> Result<Entry, IronMicError> {
        let now = Utc::now().to_rfc3339();
        let conn = self.db.conn();

        if let Some(ref raw) = updates.raw_transcript {
            conn.execute(
                "UPDATE entries SET raw_transcript = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![raw, now, id],
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to update entry: {e}")))?;
        }

        if let Some(ref polished) = updates.polished_text {
            conn.execute(
                "UPDATE entries SET polished_text = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![polished, now, id],
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to update entry: {e}")))?;
        }

        if let Some(ref mode) = updates.display_mode {
            conn.execute(
                "UPDATE entries SET display_mode = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![mode, now, id],
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to update entry: {e}")))?;
        }

        if let Some(ref tags) = updates.tags {
            conn.execute(
                "UPDATE entries SET tags = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![tags, now, id],
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to update entry: {e}")))?;
        }

        if let Some(ref source_app) = updates.source_app {
            conn.execute(
                "UPDATE entries SET source_app = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![source_app, now, id],
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to update entry: {e}")))?;
        }

        // Always bump timestamp
        conn.execute(
            "UPDATE entries SET updated_at = ?1 WHERE id = ?2",
            rusqlite::params![now, id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to update entry: {e}")))?;

        get_entry_with_conn(&conn, id)?
            .ok_or_else(|| IronMicError::Storage("Entry not found after update".into()))
    }

    /// Bulk-set source_app on all entries that currently have it NULL.
    /// Returns the number of entries updated.
    pub fn tag_all_untagged(&self, source_app: &str) -> Result<usize, IronMicError> {
        let conn = self.db.conn();
        let count = conn.execute(
            "UPDATE entries SET source_app = ?1 WHERE source_app IS NULL",
            [source_app],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to bulk-tag entries: {e}")))?;
        Ok(count)
    }

    /// Delete an entry.
    pub fn delete(&self, id: &str) -> Result<(), IronMicError> {
        let conn = self.db.conn();
        conn.execute("DELETE FROM entries WHERE id = ?1", [id])
            .map_err(|e| IronMicError::Storage(format!("Failed to delete entry: {e}")))?;
        Ok(())
    }

    /// List entries with pagination, search, and archive filtering.
    pub fn list(&self, opts: ListOptions) -> Result<Vec<Entry>, IronMicError> {
        let conn = self.db.conn();

        if let Some(ref search) = opts.search {
            let search_param = format!("{}*", search.replace('"', "\"\""));
            let archived_filter = match opts.archived {
                Some(true) => "AND e.is_archived = 1",
                Some(false) => "AND e.is_archived = 0",
                None => "",
            };
            let query = format!(
                "SELECT e.id, e.created_at, e.updated_at, e.raw_transcript, e.polished_text,
                        e.display_mode, e.duration_seconds, e.source_app, e.is_pinned, e.is_archived, e.tags
                 FROM entries e
                 JOIN entries_fts ON entries_fts.rowid = e.rowid
                 WHERE entries_fts MATCH ?1 {archived_filter}
                 ORDER BY e.is_pinned DESC, e.created_at DESC
                 LIMIT ?2 OFFSET ?3"
            );

            let mut stmt = conn
                .prepare(&query)
                .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;

            let entries = stmt
                .query_map(
                    rusqlite::params![search_param, opts.limit, opts.offset],
                    row_to_entry,
                )
                .map_err(|e| IronMicError::Storage(format!("Failed to list entries: {e}")))?;

            return entries
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| IronMicError::Storage(format!("Failed to collect entries: {e}")));
        }

        let archived_filter = match opts.archived {
            Some(true) => "WHERE is_archived = 1",
            Some(false) => "WHERE is_archived = 0",
            None => "",
        };

        let query = format!(
            "SELECT {SELECT_COLS} FROM entries {archived_filter}
             ORDER BY is_pinned DESC, created_at DESC
             LIMIT ?1 OFFSET ?2"
        );

        let mut stmt = conn
            .prepare(&query)
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;

        let entries = stmt
            .query_map(rusqlite::params![opts.limit, opts.offset], row_to_entry)
            .map_err(|e| IronMicError::Storage(format!("Failed to list entries: {e}")))?;

        entries
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| IronMicError::Storage(format!("Failed to collect entries: {e}")))
    }

    /// Pin or unpin an entry.
    pub fn pin(&self, id: &str, pinned: bool) -> Result<(), IronMicError> {
        let conn = self.db.conn();
        conn.execute(
            "UPDATE entries SET is_pinned = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![pinned as i32, Utc::now().to_rfc3339(), id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to pin entry: {e}")))?;
        Ok(())
    }

    /// Archive or unarchive an entry.
    pub fn archive(&self, id: &str, archived: bool) -> Result<(), IronMicError> {
        let conn = self.db.conn();
        conn.execute(
            "UPDATE entries SET is_archived = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![archived as i32, Utc::now().to_rfc3339(), id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to archive entry: {e}")))?;
        Ok(())
    }

    /// Delete all entries older than `days` days. Returns the number deleted.
    pub fn delete_older_than(&self, days: u32) -> Result<u32, IronMicError> {
        let cutoff = Utc::now() - chrono::Duration::days(days as i64);
        let cutoff_str = cutoff.to_rfc3339();

        let conn = self.db.conn();
        let count = conn
            .execute(
                "DELETE FROM entries WHERE created_at < ?1",
                [&cutoff_str],
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to delete old entries: {e}")))?;

        Ok(count as u32)
    }

    /// Delete all entries. Returns the number deleted.
    pub fn delete_all(&self) -> Result<u32, IronMicError> {
        let conn = self.db.conn();
        let count = conn
            .execute("DELETE FROM entries", [])
            .map_err(|e| IronMicError::Storage(format!("Failed to delete all entries: {e}")))?;
        Ok(count as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_store() -> EntryStore {
        let db = Database::open_in_memory().unwrap();
        EntryStore::new(db)
    }

    fn sample_entry() -> NewEntry {
        NewEntry {
            raw_transcript: "Hello world this is a test".into(),
            polished_text: Some("Hello world, this is a test.".into()),
            duration_seconds: Some(2.5),
            source_app: Some("VSCode".into()),
        }
    }

    #[test]
    fn create_and_get() {
        let store = test_store();
        let entry = store.create(sample_entry()).unwrap();
        assert!(!entry.id.is_empty());
        assert_eq!(entry.raw_transcript, "Hello world this is a test");
        assert_eq!(entry.display_mode, "polished");
        assert!(!entry.is_pinned);
        assert!(!entry.is_archived);

        let fetched = store.get(&entry.id).unwrap().unwrap();
        assert_eq!(fetched.id, entry.id);
    }

    #[test]
    fn get_nonexistent() {
        let store = test_store();
        assert!(store.get("nonexistent-id").unwrap().is_none());
    }

    #[test]
    fn update_entry() {
        let store = test_store();
        let entry = store.create(sample_entry()).unwrap();

        let updated = store
            .update(
                &entry.id,
                EntryUpdate {
                    raw_transcript: Some("Updated transcript".into()),
                    display_mode: Some("raw".into()),
                    ..Default::default()
                },
            )
            .unwrap();

        assert_eq!(updated.raw_transcript, "Updated transcript");
        assert_eq!(updated.display_mode, "raw");
    }

    #[test]
    fn delete_entry() {
        let store = test_store();
        let entry = store.create(sample_entry()).unwrap();
        store.delete(&entry.id).unwrap();
        assert!(store.get(&entry.id).unwrap().is_none());
    }

    #[test]
    fn list_entries() {
        let store = test_store();
        for i in 0..5 {
            store
                .create(NewEntry {
                    raw_transcript: format!("Entry {i}"),
                    polished_text: None,
                    duration_seconds: Some(1.0),
                    source_app: None,
                })
                .unwrap();
        }

        let entries = store
            .list(ListOptions { limit: 10, offset: 0, ..Default::default() })
            .unwrap();
        assert_eq!(entries.len(), 5);
    }

    #[test]
    fn list_with_pagination() {
        let store = test_store();
        for i in 0..5 {
            store
                .create(NewEntry {
                    raw_transcript: format!("Entry {i}"),
                    polished_text: None,
                    duration_seconds: None,
                    source_app: None,
                })
                .unwrap();
        }

        let page1 = store.list(ListOptions { limit: 2, offset: 0, ..Default::default() }).unwrap();
        let page2 = store.list(ListOptions { limit: 2, offset: 2, ..Default::default() }).unwrap();
        assert_eq!(page1.len(), 2);
        assert_eq!(page2.len(), 2);
    }

    #[test]
    fn list_with_archive_filter() {
        let store = test_store();
        let e1 = store.create(sample_entry()).unwrap();
        let _e2 = store.create(sample_entry()).unwrap();

        store.archive(&e1.id, true).unwrap();

        let active = store.list(ListOptions { limit: 10, offset: 0, archived: Some(false), ..Default::default() }).unwrap();
        assert_eq!(active.len(), 1);

        let archived = store.list(ListOptions { limit: 10, offset: 0, archived: Some(true), ..Default::default() }).unwrap();
        assert_eq!(archived.len(), 1);
    }

    #[test]
    fn fts_search() {
        let store = test_store();
        store.create(NewEntry { raw_transcript: "Kubernetes deployment strategy".into(), polished_text: None, duration_seconds: None, source_app: None }).unwrap();
        store.create(NewEntry { raw_transcript: "React component testing".into(), polished_text: None, duration_seconds: None, source_app: None }).unwrap();

        let results = store.list(ListOptions { limit: 10, offset: 0, search: Some("Kubernetes".into()), ..Default::default() }).unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].raw_transcript.contains("Kubernetes"));
    }

    #[test]
    fn pin_and_unpin() {
        let store = test_store();
        let entry = store.create(sample_entry()).unwrap();

        store.pin(&entry.id, true).unwrap();
        assert!(store.get(&entry.id).unwrap().unwrap().is_pinned);

        store.pin(&entry.id, false).unwrap();
        assert!(!store.get(&entry.id).unwrap().unwrap().is_pinned);
    }

    #[test]
    fn archive_and_unarchive() {
        let store = test_store();
        let entry = store.create(sample_entry()).unwrap();

        store.archive(&entry.id, true).unwrap();
        assert!(store.get(&entry.id).unwrap().unwrap().is_archived);

        store.archive(&entry.id, false).unwrap();
        assert!(!store.get(&entry.id).unwrap().unwrap().is_archived);
    }

    #[test]
    fn pinned_entries_first() {
        let store = test_store();
        let e1 = store.create(NewEntry { raw_transcript: "First".into(), polished_text: None, duration_seconds: None, source_app: None }).unwrap();
        let _e2 = store.create(NewEntry { raw_transcript: "Second".into(), polished_text: None, duration_seconds: None, source_app: None }).unwrap();

        store.pin(&e1.id, true).unwrap();

        let entries = store.list(ListOptions { limit: 10, offset: 0, ..Default::default() }).unwrap();
        assert!(entries[0].is_pinned);
    }
}
