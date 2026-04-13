use chrono::Utc;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::IronMicError;
use crate::storage::db::Database;

/// A meeting session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingSession {
    pub id: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub speaker_count: i32,
    pub summary: Option<String>,
    pub action_items: Option<String>,
    pub total_duration_seconds: Option<f64>,
    pub entry_ids: Option<String>,
}

impl Database {
    pub fn create_meeting_session(&self) -> Result<MeetingSession, IronMicError> {
        let conn = self.conn();
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO meeting_sessions (id, started_at) VALUES (?1, ?2)",
            rusqlite::params![id, now],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to create meeting session: {e}")))?;

        Ok(MeetingSession {
            id,
            started_at: now,
            ended_at: None,
            speaker_count: 0,
            summary: None,
            action_items: None,
            total_duration_seconds: None,
            entry_ids: None,
        })
    }

    pub fn end_meeting_session(
        &self,
        id: &str,
        speaker_count: i32,
        summary: Option<&str>,
        action_items: Option<&str>,
        total_duration_seconds: f64,
        entry_ids: Option<&str>,
    ) -> Result<(), IronMicError> {
        let conn = self.conn();
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "UPDATE meeting_sessions SET ended_at = ?1, speaker_count = ?2, summary = ?3,
             action_items = ?4, total_duration_seconds = ?5, entry_ids = ?6 WHERE id = ?7",
            rusqlite::params![now, speaker_count, summary, action_items, total_duration_seconds, entry_ids, id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to end meeting session: {e}")))?;
        Ok(())
    }

    pub fn get_meeting_session(&self, id: &str) -> Result<Option<MeetingSession>, IronMicError> {
        let conn = self.conn();
        conn.query_row(
            "SELECT id, started_at, ended_at, speaker_count, summary, action_items, total_duration_seconds, entry_ids
             FROM meeting_sessions WHERE id = ?1",
            [id],
            |row| {
                Ok(MeetingSession {
                    id: row.get(0)?,
                    started_at: row.get(1)?,
                    ended_at: row.get(2)?,
                    speaker_count: row.get(3)?,
                    summary: row.get(4)?,
                    action_items: row.get(5)?,
                    total_duration_seconds: row.get(6)?,
                    entry_ids: row.get(7)?,
                })
            },
        )
        .optional()
        .map_err(|e| IronMicError::Storage(format!("Failed to get meeting session: {e}")))
    }

    pub fn list_meeting_sessions(
        &self,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<MeetingSession>, IronMicError> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, started_at, ended_at, speaker_count, summary, action_items, total_duration_seconds, entry_ids
                 FROM meeting_sessions ORDER BY started_at DESC LIMIT ?1 OFFSET ?2",
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;

        let rows = stmt
            .query_map(rusqlite::params![limit, offset], |row| {
                Ok(MeetingSession {
                    id: row.get(0)?,
                    started_at: row.get(1)?,
                    ended_at: row.get(2)?,
                    speaker_count: row.get(3)?,
                    summary: row.get(4)?,
                    action_items: row.get(5)?,
                    total_duration_seconds: row.get(6)?,
                    entry_ids: row.get(7)?,
                })
            })
            .map_err(|e| IronMicError::Storage(format!("Failed to list meetings: {e}")))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(
                row.map_err(|e| IronMicError::Storage(format!("Failed to read meeting: {e}")))?,
            );
        }
        Ok(results)
    }

    pub fn delete_meeting_session(&self, id: &str) -> Result<(), IronMicError> {
        let conn = self.conn();
        conn.execute("DELETE FROM meeting_sessions WHERE id = ?1", [id])
            .map_err(|e| IronMicError::Storage(format!("Failed to delete meeting: {e}")))?;
        Ok(())
    }
}
