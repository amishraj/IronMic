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
    pub template_id: Option<String>,
    pub structured_output: Option<String>,
    pub detected_app: Option<String>,
}

fn read_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<MeetingSession> {
    Ok(MeetingSession {
        id: row.get(0)?,
        started_at: row.get(1)?,
        ended_at: row.get(2)?,
        speaker_count: row.get(3)?,
        summary: row.get(4)?,
        action_items: row.get(5)?,
        total_duration_seconds: row.get(6)?,
        entry_ids: row.get(7)?,
        template_id: row.get(8)?,
        structured_output: row.get(9)?,
        detected_app: row.get(10)?,
    })
}

const SELECT_COLS: &str =
    "id, started_at, ended_at, speaker_count, summary, action_items, total_duration_seconds, entry_ids, template_id, structured_output, detected_app";

impl Database {
    pub fn create_meeting_session(&self) -> Result<MeetingSession, IronMicError> {
        self.create_meeting_session_with_template(None, None)
    }

    pub fn create_meeting_session_with_template(
        &self,
        template_id: Option<&str>,
        detected_app: Option<&str>,
    ) -> Result<MeetingSession, IronMicError> {
        let conn = self.conn();
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO meeting_sessions (id, started_at, template_id, detected_app) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![id, now, template_id, detected_app],
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
            template_id: template_id.map(String::from),
            structured_output: None,
            detected_app: detected_app.map(String::from),
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

    pub fn set_meeting_structured_output(
        &self,
        id: &str,
        structured_output: &str,
    ) -> Result<(), IronMicError> {
        let conn = self.conn();
        conn.execute(
            "UPDATE meeting_sessions SET structured_output = ?1 WHERE id = ?2",
            rusqlite::params![structured_output, id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to set structured output: {e}")))?;
        Ok(())
    }

    pub fn get_meeting_session(&self, id: &str) -> Result<Option<MeetingSession>, IronMicError> {
        let conn = self.conn();
        let query = format!("SELECT {SELECT_COLS} FROM meeting_sessions WHERE id = ?1");
        conn.query_row(&query, [id], read_session)
            .optional()
            .map_err(|e| IronMicError::Storage(format!("Failed to get meeting session: {e}")))
    }

    pub fn list_meeting_sessions(
        &self,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<MeetingSession>, IronMicError> {
        let conn = self.conn();
        let query = format!(
            "SELECT {SELECT_COLS} FROM meeting_sessions ORDER BY started_at DESC LIMIT ?1 OFFSET ?2"
        );
        let mut stmt = conn
            .prepare(&query)
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;

        let rows = stmt
            .query_map(rusqlite::params![limit, offset], read_session)
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
