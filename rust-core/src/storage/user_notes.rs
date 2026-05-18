//! User-authored notes — first-class SQLite citizens (migration v10).
//!
//! Before v10, notes lived in renderer localStorage (`ironmic-notes` /
//! `ironmic-notebooks`) which precluded full-text search, embeddings,
//! citations, and any kind of cross-machine portability. This module is
//! the storage half of the migration; the renderer half lives in
//! `useNotesStore.ts` and performs a one-shot localStorage→SQLite import
//! guarded by the `notes_migrated_to_sqlite` setting flag.
//!
//! Field shape mirrors the renderer's `Note` / `Notebook` interfaces so the
//! import path is a straight copy.

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::IronMicError;
use crate::storage::db::Database;

/// A user-authored note.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserNote {
    pub id: String,
    pub title: String,
    /// Raw, user-edited text. Source of truth.
    pub content: String,
    /// LLM-polished body, or None if never polished / invalidated by edit.
    pub polished_content: Option<String>,
    /// 'raw' | 'polished' — which version the editor currently renders.
    pub display_mode: String,
    pub notebook_id: Option<String>,
    /// JSON array of tags. Stored as a string to mirror the renderer Note shape
    /// without forcing a JOIN; consumers parse on read.
    pub tags: String,
    pub is_pinned: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// A notebook (folder grouping for notes).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserNotebook {
    pub id: String,
    pub name: String,
    pub color: String,
    pub created_at: String,
}

/// Create payload for a new note. `id` is optional so the renderer can preserve
/// its locally-generated IDs across the bulk import — keeping stable IDs means
/// AIChat's attach-note picker can keep referencing pre-migration notes by id.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NewUserNote {
    pub id: Option<String>,
    pub title: Option<String>,
    pub content: Option<String>,
    pub polished_content: Option<String>,
    pub display_mode: Option<String>,
    pub notebook_id: Option<String>,
    /// JSON array string; defaults to "[]" if absent.
    pub tags: Option<String>,
    pub is_pinned: Option<bool>,
    /// Optional explicit timestamps for bulk import (preserve original created_at).
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

/// Partial update. Each `Option<Option<T>>` field uses outer-Option = "field
/// touched?" / inner-Option = "set to NULL?". `content`, `title` etc. are
/// simpler `Option<T>` because we never want to set them to NULL.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UserNoteUpdate {
    pub title: Option<String>,
    pub content: Option<String>,
    pub polished_content: Option<Option<String>>,
    pub display_mode: Option<String>,
    pub notebook_id: Option<Option<String>>,
    pub tags: Option<String>,
    pub is_pinned: Option<bool>,
}

/// List filter / pagination.
#[derive(Debug, Clone, Default)]
pub struct UserNoteListOptions {
    pub limit: u32,
    pub offset: u32,
    pub notebook_id: Option<String>,
    pub search: Option<String>,
}

const SELECT_COLS: &str =
    "id, title, content, polished_content, display_mode, notebook_id, tags, is_pinned, created_at, updated_at";

fn row_to_note(row: &rusqlite::Row) -> rusqlite::Result<UserNote> {
    Ok(UserNote {
        id: row.get(0)?,
        title: row.get(1)?,
        content: row.get(2)?,
        polished_content: row.get(3)?,
        display_mode: row.get(4)?,
        notebook_id: row.get(5)?,
        tags: row.get(6)?,
        is_pinned: row.get::<_, i32>(7)? != 0,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn row_to_notebook(row: &rusqlite::Row) -> rusqlite::Result<UserNotebook> {
    Ok(UserNotebook {
        id: row.get(0)?,
        name: row.get(1)?,
        color: row.get(2)?,
        created_at: row.get(3)?,
    })
}

fn get_note_with_conn(conn: &Connection, id: &str) -> Result<Option<UserNote>, IronMicError> {
    let mut stmt = conn
        .prepare(&format!("SELECT {SELECT_COLS} FROM user_notes WHERE id = ?1"))
        .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;
    stmt.query_row([id], row_to_note)
        .optional()
        .map_err(|e| IronMicError::Storage(format!("Failed to get user_note: {e}")))
}

/// User notes CRUD store. Mirrors `EntryStore` ergonomics for consistency.
pub struct UserNoteStore {
    db: Database,
}

impl UserNoteStore {
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    /// Create a single note. If `new.id` is provided it's honored (used by the
    /// bulk import); otherwise a fresh UUID is generated.
    pub fn create(&self, new: NewUserNote) -> Result<UserNote, IronMicError> {
        let id = new.id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let now = Utc::now().to_rfc3339();
        let created_at = new.created_at.unwrap_or_else(|| now.clone());
        let updated_at = new.updated_at.unwrap_or_else(|| now.clone());

        let conn = self.db.conn();
        conn.execute(
            "INSERT INTO user_notes
             (id, title, content, polished_content, display_mode, notebook_id, tags, is_pinned, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                id,
                new.title.unwrap_or_default(),
                new.content.unwrap_or_default(),
                new.polished_content,
                new.display_mode.unwrap_or_else(|| "raw".into()),
                new.notebook_id,
                new.tags.unwrap_or_else(|| "[]".into()),
                new.is_pinned.unwrap_or(false) as i32,
                created_at,
                updated_at,
            ],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to create user_note: {e}")))?;

        get_note_with_conn(&conn, &id)?
            .ok_or_else(|| IronMicError::Storage("user_note not found after creation".into()))
    }

    /// Get a single note by id.
    pub fn get(&self, id: &str) -> Result<Option<UserNote>, IronMicError> {
        let conn = self.db.conn();
        get_note_with_conn(&conn, id)
    }

    /// Apply a partial update. Builds a single UPDATE so the round-trip count
    /// is independent of how many fields were supplied.
    pub fn update(&self, id: &str, updates: UserNoteUpdate) -> Result<UserNote, IronMicError> {
        let now = Utc::now().to_rfc3339();
        let conn = self.db.conn();

        let mut sets: Vec<String> = vec!["updated_at = ?1".into()];
        type BoxedSql = Box<dyn rusqlite::types::ToSql>;
        let mut params: Vec<BoxedSql> = vec![Box::new(now)];
        let mut idx: usize = 2;

        macro_rules! push_col {
            ($col:literal, $val:expr) => {{
                sets.push(format!("{} = ?{}", $col, idx));
                params.push(Box::new($val));
                idx += 1;
            }};
        }

        if let Some(v) = updates.title           { push_col!("title", v); }
        if let Some(v) = updates.content         { push_col!("content", v); }
        if let Some(v) = updates.polished_content { push_col!("polished_content", v); }
        if let Some(v) = updates.display_mode    { push_col!("display_mode", v); }
        if let Some(v) = updates.notebook_id     { push_col!("notebook_id", v); }
        if let Some(v) = updates.tags            { push_col!("tags", v); }
        if let Some(v) = updates.is_pinned       { push_col!("is_pinned", v as i32); }

        params.push(Box::new(id.to_string()));
        let sql = format!(
            "UPDATE user_notes SET {} WHERE id = ?{}",
            sets.join(", "),
            idx
        );

        conn.execute(&sql, rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())))
            .map_err(|e| IronMicError::Storage(format!("Failed to update user_note: {e}")))?;

        get_note_with_conn(&conn, id)?
            .ok_or_else(|| IronMicError::Storage("user_note not found after update".into()))
    }

    /// Delete a note by id. Idempotent — no error if the row is absent.
    pub fn delete(&self, id: &str) -> Result<(), IronMicError> {
        let conn = self.db.conn();
        conn.execute("DELETE FROM user_notes WHERE id = ?1", [id])
            .map_err(|e| IronMicError::Storage(format!("Failed to delete user_note: {e}")))?;
        Ok(())
    }

    /// List notes, optionally filtered by notebook and/or FTS5 search.
    pub fn list(&self, opts: UserNoteListOptions) -> Result<Vec<UserNote>, IronMicError> {
        let conn = self.db.conn();

        if let Some(ref search) = opts.search {
            let search_param = format!("{}*", search.replace('"', "\"\""));
            let notebook_filter = match opts.notebook_id.as_deref() {
                Some(_) => "AND u.notebook_id = ?4",
                None => "",
            };
            let aliased_cols: String = SELECT_COLS
                .split(',')
                .map(|c| format!("u.{}", c.trim()))
                .collect::<Vec<_>>()
                .join(", ");
            let query = format!(
                "SELECT {aliased_cols}
                 FROM user_notes u
                 JOIN user_notes_fts ON user_notes_fts.rowid = u.rowid
                 WHERE user_notes_fts MATCH ?1 {notebook_filter}
                 ORDER BY u.is_pinned DESC, u.updated_at DESC
                 LIMIT ?2 OFFSET ?3"
            );
            let mut stmt = conn
                .prepare(&query)
                .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;

            let notes = if let Some(nbid) = opts.notebook_id {
                stmt.query_map(
                    rusqlite::params![search_param, opts.limit, opts.offset, nbid],
                    row_to_note,
                )
            } else {
                stmt.query_map(
                    rusqlite::params![search_param, opts.limit, opts.offset],
                    row_to_note,
                )
            }
            .map_err(|e| IronMicError::Storage(format!("Failed to list user_notes: {e}")))?;

            return notes
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| IronMicError::Storage(format!("Failed to collect user_notes: {e}")));
        }

        let (where_clause, param_count) = match opts.notebook_id {
            Some(_) => ("WHERE notebook_id = ?3", 3),
            None => ("", 0),
        };
        let query = format!(
            "SELECT {SELECT_COLS} FROM user_notes {where_clause}
             ORDER BY is_pinned DESC, updated_at DESC
             LIMIT ?1 OFFSET ?2"
        );
        let mut stmt = conn
            .prepare(&query)
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;

        let notes = if param_count == 3 {
            stmt.query_map(
                rusqlite::params![opts.limit, opts.offset, opts.notebook_id.unwrap()],
                row_to_note,
            )
        } else {
            stmt.query_map(rusqlite::params![opts.limit, opts.offset], row_to_note)
        }
        .map_err(|e| IronMicError::Storage(format!("Failed to list user_notes: {e}")))?;

        notes
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| IronMicError::Storage(format!("Failed to collect user_notes: {e}")))
    }

    /// Bulk-import notes and notebooks in a single transaction. Used by the
    /// renderer's one-shot localStorage→SQLite migration on first launch after
    /// upgrading to v10. Honors caller-supplied IDs so AIChat's attach picker
    /// can keep referencing notes by their original renderer-generated id.
    pub fn bulk_import(
        &self,
        notes: Vec<NewUserNote>,
        notebooks: Vec<UserNotebook>,
    ) -> Result<u32, IronMicError> {
        let conn = self.db.conn();
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| IronMicError::Storage(format!("Failed to begin import tx: {e}")))?;

        let mut imported = 0u32;
        {
            let mut nb_stmt = tx
                .prepare(
                    "INSERT OR IGNORE INTO user_notebooks (id, name, color, created_at)
                     VALUES (?1, ?2, ?3, ?4)",
                )
                .map_err(|e| IronMicError::Storage(format!("Failed to prepare notebook insert: {e}")))?;
            for nb in &notebooks {
                nb_stmt.execute(rusqlite::params![nb.id, nb.name, nb.color, nb.created_at])
                    .map_err(|e| IronMicError::Storage(format!("Failed to import notebook: {e}")))?;
            }

            let mut n_stmt = tx
                .prepare(
                    "INSERT OR IGNORE INTO user_notes
                     (id, title, content, polished_content, display_mode, notebook_id, tags, is_pinned, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                )
                .map_err(|e| IronMicError::Storage(format!("Failed to prepare note insert: {e}")))?;

            let now = Utc::now().to_rfc3339();
            for note in notes {
                let id = note.id.unwrap_or_else(|| Uuid::new_v4().to_string());
                let created_at = note.created_at.unwrap_or_else(|| now.clone());
                let updated_at = note.updated_at.unwrap_or_else(|| now.clone());
                n_stmt
                    .execute(rusqlite::params![
                        id,
                        note.title.unwrap_or_default(),
                        note.content.unwrap_or_default(),
                        note.polished_content,
                        note.display_mode.unwrap_or_else(|| "raw".into()),
                        note.notebook_id,
                        note.tags.unwrap_or_else(|| "[]".into()),
                        note.is_pinned.unwrap_or(false) as i32,
                        created_at,
                        updated_at,
                    ])
                    .map_err(|e| IronMicError::Storage(format!("Failed to import note: {e}")))?;
                imported += 1;
            }
        }

        tx.commit()
            .map_err(|e| IronMicError::Storage(format!("Failed to commit import: {e}")))?;
        Ok(imported)
    }

    // ── Notebook CRUD ──

    pub fn create_notebook(&self, name: &str, color: &str) -> Result<UserNotebook, IronMicError> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let conn = self.db.conn();
        conn.execute(
            "INSERT INTO user_notebooks (id, name, color, created_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![id, name, color, now],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to create notebook: {e}")))?;
        Ok(UserNotebook {
            id,
            name: name.into(),
            color: color.into(),
            created_at: now,
        })
    }

    pub fn rename_notebook(&self, id: &str, name: &str) -> Result<(), IronMicError> {
        let conn = self.db.conn();
        conn.execute(
            "UPDATE user_notebooks SET name = ?1 WHERE id = ?2",
            rusqlite::params![name, id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to rename notebook: {e}")))?;
        Ok(())
    }

    /// Deleting a notebook is non-destructive for the notes: it nulls out
    /// `notebook_id` on the children so notes drop back to "uncategorized"
    /// instead of disappearing. Mirrors the renderer's deleteNotebook semantic
    /// (`useNotesStore.ts:315-325`).
    pub fn delete_notebook(&self, id: &str) -> Result<(), IronMicError> {
        let conn = self.db.conn();
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| IronMicError::Storage(format!("Failed to begin tx: {e}")))?;
        tx.execute(
            "UPDATE user_notes SET notebook_id = NULL, updated_at = ?1 WHERE notebook_id = ?2",
            rusqlite::params![Utc::now().to_rfc3339(), id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to detach notes: {e}")))?;
        tx.execute("DELETE FROM user_notebooks WHERE id = ?1", [id])
            .map_err(|e| IronMicError::Storage(format!("Failed to delete notebook: {e}")))?;
        tx.commit()
            .map_err(|e| IronMicError::Storage(format!("Failed to commit notebook delete: {e}")))?;
        Ok(())
    }

    pub fn list_notebooks(&self) -> Result<Vec<UserNotebook>, IronMicError> {
        let conn = self.db.conn();
        let mut stmt = conn
            .prepare("SELECT id, name, color, created_at FROM user_notebooks ORDER BY created_at ASC")
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;
        let books = stmt
            .query_map([], row_to_notebook)
            .map_err(|e| IronMicError::Storage(format!("Failed to list notebooks: {e}")))?;
        books
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| IronMicError::Storage(format!("Failed to collect notebooks: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_store() -> UserNoteStore {
        let db = Database::open_in_memory().unwrap();
        UserNoteStore::new(db)
    }

    #[test]
    fn create_and_get() {
        let store = test_store();
        let note = store
            .create(NewUserNote {
                title: Some("Hello".into()),
                content: Some("World".into()),
                ..Default::default()
            })
            .unwrap();

        assert!(!note.id.is_empty());
        assert_eq!(note.title, "Hello");
        assert_eq!(note.content, "World");
        assert_eq!(note.display_mode, "raw");
        assert_eq!(note.tags, "[]");
        assert!(!note.is_pinned);

        let fetched = store.get(&note.id).unwrap().unwrap();
        assert_eq!(fetched.id, note.id);
    }

    #[test]
    fn create_honors_supplied_id() {
        let store = test_store();
        let note = store
            .create(NewUserNote {
                id: Some("renderer-local-id-abc".into()),
                title: Some("Imported".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(note.id, "renderer-local-id-abc");
    }

    #[test]
    fn update_content_invalidation_is_callers_problem() {
        // The renderer-side useNotesStore clears polished_content when the user
        // edits `content` — this store doesn't enforce that policy, by design,
        // so bulk imports and IDE re-syncs can update content without losing
        // a hand-curated polished version. The test pins that contract.
        let store = test_store();
        let note = store
            .create(NewUserNote {
                content: Some("original".into()),
                polished_content: Some("Original.".into()),
                ..Default::default()
            })
            .unwrap();

        let updated = store
            .update(
                &note.id,
                UserNoteUpdate {
                    content: Some("edited".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.content, "edited");
        assert_eq!(updated.polished_content.as_deref(), Some("Original."));
    }

    #[test]
    fn delete_is_idempotent() {
        let store = test_store();
        store.delete("nonexistent").unwrap();
        let n = store.create(NewUserNote::default()).unwrap();
        store.delete(&n.id).unwrap();
        store.delete(&n.id).unwrap();
        assert!(store.get(&n.id).unwrap().is_none());
    }

    #[test]
    fn list_pinned_first_then_recent() {
        let store = test_store();
        let _a = store
            .create(NewUserNote {
                title: Some("a".into()),
                ..Default::default()
            })
            .unwrap();
        let b = store
            .create(NewUserNote {
                title: Some("b".into()),
                ..Default::default()
            })
            .unwrap();
        // Pin b
        store
            .update(
                &b.id,
                UserNoteUpdate {
                    is_pinned: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();

        let list = store
            .list(UserNoteListOptions {
                limit: 10,
                offset: 0,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(list[0].title, "b");
    }

    #[test]
    fn list_with_search_uses_fts5() {
        let store = test_store();
        store
            .create(NewUserNote {
                title: Some("Auth migration".into()),
                content: Some("Migrate auth before Q3".into()),
                ..Default::default()
            })
            .unwrap();
        store
            .create(NewUserNote {
                title: Some("Lunch".into()),
                content: Some("Tacos".into()),
                ..Default::default()
            })
            .unwrap();

        let results = store
            .list(UserNoteListOptions {
                limit: 10,
                offset: 0,
                search: Some("auth".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Auth migration");
    }

    #[test]
    fn list_with_notebook_filter() {
        let store = test_store();
        let nb = store.create_notebook("Work", "#000").unwrap();
        store
            .create(NewUserNote {
                title: Some("In notebook".into()),
                notebook_id: Some(nb.id.clone()),
                ..Default::default()
            })
            .unwrap();
        store
            .create(NewUserNote {
                title: Some("Loose".into()),
                ..Default::default()
            })
            .unwrap();

        let filtered = store
            .list(UserNoteListOptions {
                limit: 10,
                offset: 0,
                notebook_id: Some(nb.id),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].title, "In notebook");
    }

    #[test]
    fn bulk_import_preserves_ids_and_timestamps() {
        let store = test_store();
        let notes = vec![
            NewUserNote {
                id: Some("legacy-1".into()),
                title: Some("One".into()),
                created_at: Some("2024-01-01T00:00:00Z".into()),
                updated_at: Some("2024-01-02T00:00:00Z".into()),
                ..Default::default()
            },
            NewUserNote {
                id: Some("legacy-2".into()),
                title: Some("Two".into()),
                ..Default::default()
            },
        ];
        let count = store.bulk_import(notes, vec![]).unwrap();
        assert_eq!(count, 2);

        let one = store.get("legacy-1").unwrap().unwrap();
        assert_eq!(one.title, "One");
        assert_eq!(one.created_at, "2024-01-01T00:00:00Z");

        // Re-running the same import is a no-op thanks to INSERT OR IGNORE.
        let recount = store
            .bulk_import(
                vec![NewUserNote {
                    id: Some("legacy-1".into()),
                    title: Some("Different title — should be ignored".into()),
                    ..Default::default()
                }],
                vec![],
            )
            .unwrap();
        // Note: bulk_import counts attempts, not actual inserts. Verify the
        // existing row's title was *not* overwritten.
        assert_eq!(recount, 1);
        let still_one = store.get("legacy-1").unwrap().unwrap();
        assert_eq!(still_one.title, "One");
    }

    #[test]
    fn notebook_delete_detaches_notes() {
        let store = test_store();
        let nb = store.create_notebook("Temp", "#fff").unwrap();
        let n = store
            .create(NewUserNote {
                title: Some("Inside".into()),
                notebook_id: Some(nb.id.clone()),
                ..Default::default()
            })
            .unwrap();

        store.delete_notebook(&nb.id).unwrap();

        // Note still exists; its notebook_id is now NULL.
        let after = store.get(&n.id).unwrap().unwrap();
        assert!(after.notebook_id.is_none());

        // Notebook is gone.
        let books = store.list_notebooks().unwrap();
        assert!(books.is_empty());
    }
}
