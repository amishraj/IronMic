use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::IronMicError;
use crate::storage::db::Database;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiChatSession {
    pub id: String,
    pub title: String,
    pub provider: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_accessed_at: String,
    pub last_message_preview: Option<String>,
    pub is_pinned: bool,
    pub is_archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiChatMessage {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub provider: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiChatSessionWithMessages {
    #[serde(flatten)]
    pub session: AiChatSession,
    pub messages: Vec<AiChatMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiChatSearchResult {
    #[serde(flatten)]
    pub session: AiChatSession,
    pub snippet: String,
    pub matched_message_id: String,
}

const SELECT_SESSION_COLS: &str =
    "id, title, provider, created_at, updated_at, last_accessed_at, last_message_preview, is_pinned, is_archived";

fn row_to_session(row: &rusqlite::Row) -> rusqlite::Result<AiChatSession> {
    let pinned: i64 = row.get(7)?;
    let archived: i64 = row.get(8)?;
    Ok(AiChatSession {
        id: row.get(0)?,
        title: row.get(1)?,
        provider: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        last_accessed_at: row.get(5)?,
        last_message_preview: row.get(6)?,
        is_pinned: pinned != 0,
        is_archived: archived != 0,
    })
}

fn row_to_message(row: &rusqlite::Row) -> rusqlite::Result<AiChatMessage> {
    Ok(AiChatMessage {
        id: row.get(0)?,
        session_id: row.get(1)?,
        role: row.get(2)?,
        content: row.get(3)?,
        provider: row.get(4)?,
        created_at: row.get(5)?,
    })
}

/// Sanitize a raw user query for FTS5. Wraps each token in double quotes and
/// escapes embedded quotes so things like `AND`, `*`, `:` don't blow up the
/// MATCH parser. Empty / whitespace-only input returns None.
fn sanitize_fts_query(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parts: Vec<String> = trimmed
        .split_whitespace()
        .map(|tok| format!("\"{}\"", tok.replace('"', "\"\"")))
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
    }
}

fn make_preview(content: &str) -> String {
    let collapsed = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > 120 {
        let mut s: String = collapsed.chars().take(117).collect();
        s.push_str("...");
        s
    } else {
        collapsed
    }
}

impl Database {
    /// Create a new chat session. `id`, `created_at`, `updated_at` are optional
    /// — when present (e.g. during the localStorage→SQLite migration) we use
    /// them verbatim to preserve identity and ordering. Idempotent on `id`.
    pub fn ai_chat_create_session(
        &self,
        id: Option<&str>,
        title: &str,
        provider: Option<&str>,
        created_at: Option<&str>,
        updated_at: Option<&str>,
    ) -> Result<AiChatSession, IronMicError> {
        let conn = self.conn();
        let now = Utc::now().to_rfc3339();
        let id = id.map(String::from).unwrap_or_else(|| Uuid::new_v4().to_string());
        let created = created_at.map(String::from).unwrap_or_else(|| now.clone());
        let updated = updated_at.map(String::from).unwrap_or_else(|| now.clone());

        conn.execute(
            "INSERT OR IGNORE INTO ai_chat_sessions
             (id, title, provider, created_at, updated_at, last_accessed_at, last_message_preview, is_pinned, is_archived)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 0, 0)",
            rusqlite::params![id, title, provider, created, updated, now],
        )
        .map_err(|e| IronMicError::Storage(format!("ai_chat_create_session failed: {e}")))?;

        let mut stmt = conn
            .prepare(&format!(
                "SELECT {SELECT_SESSION_COLS} FROM ai_chat_sessions WHERE id = ?1"
            ))
            .map_err(|e| IronMicError::Storage(format!("ai_chat_create_session select prep: {e}")))?;
        let session = stmt
            .query_row([&id], row_to_session)
            .map_err(|e| IronMicError::Storage(format!("ai_chat_create_session select: {e}")))?;
        Ok(session)
    }

    pub fn ai_chat_list_sessions(
        &self,
        limit: u32,
        offset: u32,
        include_archived: bool,
    ) -> Result<Vec<AiChatSession>, IronMicError> {
        let conn = self.conn();
        let sql = if include_archived {
            format!(
                "SELECT {SELECT_SESSION_COLS} FROM ai_chat_sessions
                 ORDER BY is_pinned DESC, updated_at DESC LIMIT ?1 OFFSET ?2"
            )
        } else {
            format!(
                "SELECT {SELECT_SESSION_COLS} FROM ai_chat_sessions
                 WHERE is_archived = 0
                 ORDER BY is_pinned DESC, updated_at DESC LIMIT ?1 OFFSET ?2"
            )
        };
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| IronMicError::Storage(format!("ai_chat_list_sessions prep: {e}")))?;
        let rows = stmt
            .query_map(rusqlite::params![limit, offset], row_to_session)
            .map_err(|e| IronMicError::Storage(format!("ai_chat_list_sessions query: {e}")))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| IronMicError::Storage(format!("ai_chat_list_sessions row: {e}")))?);
        }
        Ok(out)
    }

    /// Fetch a session and all its messages in chronological order. Bumps
    /// `last_accessed_at` to now in the same call so the drawer can surface
    /// recently-viewed sessions if it ever wants that signal.
    pub fn ai_chat_get_session(
        &self,
        id: &str,
    ) -> Result<Option<AiChatSessionWithMessages>, IronMicError> {
        let conn = self.conn();
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE ai_chat_sessions SET last_accessed_at = ?1 WHERE id = ?2",
            rusqlite::params![now, id],
        )
        .map_err(|e| IronMicError::Storage(format!("ai_chat_get_session touch: {e}")))?;

        let mut sess_stmt = conn
            .prepare(&format!(
                "SELECT {SELECT_SESSION_COLS} FROM ai_chat_sessions WHERE id = ?1"
            ))
            .map_err(|e| IronMicError::Storage(format!("ai_chat_get_session prep: {e}")))?;
        let session = match sess_stmt.query_row([id], row_to_session) {
            Ok(s) => s,
            Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
            Err(e) => return Err(IronMicError::Storage(format!("ai_chat_get_session: {e}"))),
        };

        let mut msg_stmt = conn
            .prepare(
                "SELECT id, session_id, role, content, provider, created_at
                 FROM ai_chat_messages WHERE session_id = ?1 ORDER BY created_at ASC, rowid ASC",
            )
            .map_err(|e| IronMicError::Storage(format!("ai_chat_get_session msg prep: {e}")))?;
        let rows = msg_stmt
            .query_map([id], row_to_message)
            .map_err(|e| IronMicError::Storage(format!("ai_chat_get_session msg query: {e}")))?;
        let mut messages = Vec::new();
        for r in rows {
            messages.push(
                r.map_err(|e| IronMicError::Storage(format!("ai_chat_get_session msg row: {e}")))?,
            );
        }
        Ok(Some(AiChatSessionWithMessages { session, messages }))
    }

    pub fn ai_chat_rename_session(&self, id: &str, title: &str) -> Result<(), IronMicError> {
        let conn = self.conn();
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE ai_chat_sessions SET title = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![title, now, id],
        )
        .map_err(|e| IronMicError::Storage(format!("ai_chat_rename_session: {e}")))?;
        Ok(())
    }

    pub fn ai_chat_pin_session(&self, id: &str, pinned: bool) -> Result<(), IronMicError> {
        let conn = self.conn();
        conn.execute(
            "UPDATE ai_chat_sessions SET is_pinned = ?1 WHERE id = ?2",
            rusqlite::params![if pinned { 1 } else { 0 }, id],
        )
        .map_err(|e| IronMicError::Storage(format!("ai_chat_pin_session: {e}")))?;
        Ok(())
    }

    pub fn ai_chat_archive_session(&self, id: &str, archived: bool) -> Result<(), IronMicError> {
        let conn = self.conn();
        conn.execute(
            "UPDATE ai_chat_sessions SET is_archived = ?1 WHERE id = ?2",
            rusqlite::params![if archived { 1 } else { 0 }, id],
        )
        .map_err(|e| IronMicError::Storage(format!("ai_chat_archive_session: {e}")))?;
        Ok(())
    }

    pub fn ai_chat_delete_session(&self, id: &str) -> Result<(), IronMicError> {
        let conn = self.conn();
        conn.execute("DELETE FROM ai_chat_sessions WHERE id = ?1", [id])
            .map_err(|e| IronMicError::Storage(format!("ai_chat_delete_session: {e}")))?;
        Ok(())
    }

    /// Append a message and update the parent session's updated_at +
    /// last_message_preview in the same transaction. Optional `id` /
    /// `created_at` let migration preserve original IDs and timestamps; the
    /// optimistic UI also passes an explicit id so in-memory and DB rows match.
    pub fn ai_chat_append_message(
        &self,
        session_id: &str,
        role: &str,
        content: &str,
        provider: Option<&str>,
        id: Option<&str>,
        created_at: Option<&str>,
    ) -> Result<AiChatMessage, IronMicError> {
        let mut conn = self.conn();
        let tx = conn
            .transaction()
            .map_err(|e| IronMicError::Storage(format!("ai_chat_append_message tx: {e}")))?;
        let now = Utc::now().to_rfc3339();
        let msg_id = id.map(String::from).unwrap_or_else(|| Uuid::new_v4().to_string());
        let created = created_at.map(String::from).unwrap_or_else(|| now.clone());
        let preview = make_preview(content);

        tx.execute(
            "INSERT OR IGNORE INTO ai_chat_messages (id, session_id, role, content, provider, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![msg_id, session_id, role, content, provider, created],
        )
        .map_err(|e| IronMicError::Storage(format!("ai_chat_append_message insert: {e}")))?;

        tx.execute(
            "UPDATE ai_chat_sessions
             SET updated_at = ?1, last_message_preview = ?2
             WHERE id = ?3",
            rusqlite::params![now, preview, session_id],
        )
        .map_err(|e| IronMicError::Storage(format!("ai_chat_append_message touch session: {e}")))?;

        tx.commit()
            .map_err(|e| IronMicError::Storage(format!("ai_chat_append_message commit: {e}")))?;

        Ok(AiChatMessage {
            id: msg_id,
            session_id: session_id.to_string(),
            role: role.to_string(),
            content: content.to_string(),
            provider: provider.map(String::from),
            created_at: created,
        })
    }

    pub fn ai_chat_search_sessions(
        &self,
        query: &str,
        limit: u32,
    ) -> Result<Vec<AiChatSearchResult>, IronMicError> {
        let conn = self.conn();
        let Some(fts) = sanitize_fts_query(query) else {
            return Ok(Vec::new());
        };

        // FTS5 `snippet()` only works when the FTS table is the leftmost
        // referenced source in the SELECT and isn't wrapped in GROUP BY. So
        // we select ranked matches with snippet, then dedupe by session in
        // Rust (FTS rows are already in rank order).
        let sess_cols = SELECT_SESSION_COLS
            .split(", ")
            .map(|c| format!("s.{c}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT {sess_cols},
                    snippet(ai_chat_messages_fts, 0, '<mark>', '</mark>', '…', 12) as snip,
                    m.id as matched_id,
                    m.session_id as msg_session_id
             FROM ai_chat_messages_fts
             JOIN ai_chat_messages m ON m.rowid = ai_chat_messages_fts.rowid
             JOIN ai_chat_sessions s ON s.id = m.session_id
             WHERE ai_chat_messages_fts MATCH ?1
             ORDER BY rank
             LIMIT ?2"
        );

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| IronMicError::Storage(format!("ai_chat_search_sessions prep: {e}")))?;
        // Pull more rows than `limit` since we dedupe by session in Rust.
        let raw_limit = limit.saturating_mul(8).max(limit);
        let rows = stmt
            .query_map(rusqlite::params![fts, raw_limit], |row| {
                let session = row_to_session(row)?;
                let snippet: String = row.get(9)?;
                let matched_id: String = row.get(10)?;
                Ok(AiChatSearchResult {
                    session,
                    snippet,
                    matched_message_id: matched_id,
                })
            })
            .map_err(|e| IronMicError::Storage(format!("ai_chat_search_sessions query: {e}")))?;

        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for r in rows {
            let row = r.map_err(|e| IronMicError::Storage(format!("ai_chat_search_sessions row: {e}")))?;
            if seen.insert(row.session.id.clone()) {
                out.push(row);
                if out.len() >= limit as usize {
                    break;
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_and_get_session() {
        let db = Database::open_in_memory().unwrap();
        let s = db.ai_chat_create_session(None, "Hello", Some("local"), None, None).unwrap();
        let got = db.ai_chat_get_session(&s.id).unwrap().unwrap();
        assert_eq!(got.session.title, "Hello");
        assert_eq!(got.session.provider.as_deref(), Some("local"));
        assert!(got.messages.is_empty());
    }

    #[test]
    fn append_and_list() {
        let db = Database::open_in_memory().unwrap();
        let s = db.ai_chat_create_session(None, "T", None, None, None).unwrap();
        db.ai_chat_append_message(&s.id, "user", "hello world", Some("local"), None, None).unwrap();
        db.ai_chat_append_message(&s.id, "assistant", "hi back", Some("local"), None, None).unwrap();
        let got = db.ai_chat_get_session(&s.id).unwrap().unwrap();
        assert_eq!(got.messages.len(), 2);
        assert_eq!(got.session.last_message_preview.as_deref(), Some("hi back"));
    }

    #[test]
    fn fts_search_with_special_chars() {
        let db = Database::open_in_memory().unwrap();
        let s = db.ai_chat_create_session(None, "Bug log", None, None, None).unwrap();
        db.ai_chat_append_message(&s.id, "user", "the AND operator broke search", None, None, None).unwrap();
        // Raw `AND` must not blow up FTS.
        let results = db.ai_chat_search_sessions("AND operator", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].session.id, s.id);
    }

    #[test]
    fn cascade_delete() {
        let db = Database::open_in_memory().unwrap();
        let s = db.ai_chat_create_session(None, "T", None, None, None).unwrap();
        db.ai_chat_append_message(&s.id, "user", "x", None, None, None).unwrap();
        db.ai_chat_delete_session(&s.id).unwrap();
        let conn = db.conn();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM ai_chat_messages", [], |row| row.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn preserves_id_for_migration() {
        let db = Database::open_in_memory().unwrap();
        let custom_id = "legacy-123";
        let s = db
            .ai_chat_create_session(
                Some(custom_id),
                "old",
                None,
                Some("2024-01-01T00:00:00Z"),
                Some("2024-01-02T00:00:00Z"),
            )
            .unwrap();
        assert_eq!(s.id, custom_id);
        assert_eq!(s.created_at, "2024-01-01T00:00:00Z");
    }

    #[test]
    fn pin_archive_filter() {
        let db = Database::open_in_memory().unwrap();
        let a = db.ai_chat_create_session(None, "A", None, None, None).unwrap();
        let b = db.ai_chat_create_session(None, "B", None, None, None).unwrap();
        db.ai_chat_archive_session(&b.id, true).unwrap();
        let visible = db.ai_chat_list_sessions(50, 0, false).unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].id, a.id);
        let all = db.ai_chat_list_sessions(50, 0, true).unwrap();
        assert_eq!(all.len(), 2);
    }
}
