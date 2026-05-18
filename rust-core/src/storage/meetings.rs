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
    /// JSON array of MeetingParticipant — historical roster including
    /// host + every joiner. Entries are NOT removed on disconnect; we
    /// stamp `leftAt` instead. Defaults to "[]" via the v7 migration.
    pub participants: String,
}

/// One participant in a meeting (host or joiner). Serialized as camelCase
/// so the JSON shape on the wire matches the TS `MeetingParticipant` type
/// directly with zero conversion in the IPC layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingParticipant {
    pub id: String,
    pub display_name: String,
    pub is_host: bool,
    pub joined_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left_at: Option<i64>,
}

const MAX_DISPLAY_NAME_LEN: usize = 64;
const MAX_PARTICIPANTS: usize = 32;

fn sanitize_participant(p: &mut MeetingParticipant) {
    let trimmed: String = p.display_name.trim().chars().take(MAX_DISPLAY_NAME_LEN).collect();
    p.display_name = if trimmed.is_empty() {
        "Participant".to_string()
    } else {
        trimmed
    };
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
        participants: row.get(11).unwrap_or_else(|_| "[]".to_string()),
    })
}

const SELECT_COLS: &str =
    "id, started_at, ended_at, speaker_count, summary, action_items, total_duration_seconds, entry_ids, template_id, structured_output, detected_app, participants";

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
            participants: "[]".to_string(),
        })
    }

    /// Replace the entire participant roster for a meeting. Validates and
    /// sanitizes each entry (display-name length cap, max 32 entries).
    pub fn set_meeting_participants(
        &self,
        id: &str,
        participants_json: &str,
    ) -> Result<(), IronMicError> {
        let mut roster: Vec<MeetingParticipant> = serde_json::from_str(participants_json)
            .map_err(|e| IronMicError::Storage(format!("Invalid participants JSON: {e}")))?;
        if roster.len() > MAX_PARTICIPANTS {
            roster.truncate(MAX_PARTICIPANTS);
        }
        for p in roster.iter_mut() {
            sanitize_participant(p);
        }
        let cleaned = serde_json::to_string(&roster).map_err(|e| {
            IronMicError::Storage(format!("Failed to serialize roster: {e}"))
        })?;
        let conn = self.conn();
        conn.execute(
            "UPDATE meeting_sessions SET participants = ?1 WHERE id = ?2",
            rusqlite::params![cleaned, id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to set participants: {e}")))?;
        Ok(())
    }

    /// Append (or update by id) a single participant in the roster. Performs a
    /// transactional read-merge-write so concurrent join events from the
    /// room server don't trample each other.
    pub fn add_meeting_participant(
        &self,
        id: &str,
        participant_json: &str,
    ) -> Result<(), IronMicError> {
        let mut new_p: MeetingParticipant = serde_json::from_str(participant_json)
            .map_err(|e| IronMicError::Storage(format!("Invalid participant JSON: {e}")))?;
        sanitize_participant(&mut new_p);

        let conn = self.conn();
        let current: String = conn
            .query_row(
                "SELECT participants FROM meeting_sessions WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to read participants: {e}")))?;

        let mut roster: Vec<MeetingParticipant> =
            serde_json::from_str(&current).unwrap_or_default();

        if let Some(existing) = roster.iter_mut().find(|p| p.id == new_p.id) {
            // Re-join: clear leftAt and refresh display name.
            existing.display_name = new_p.display_name.clone();
            existing.left_at = None;
            if !existing.is_host {
                existing.is_host = new_p.is_host;
            }
            // joinedAt stays as the original.
        } else if roster.len() < MAX_PARTICIPANTS {
            roster.push(new_p);
        }

        let cleaned = serde_json::to_string(&roster).map_err(|e| {
            IronMicError::Storage(format!("Failed to serialize roster: {e}"))
        })?;
        conn.execute(
            "UPDATE meeting_sessions SET participants = ?1 WHERE id = ?2",
            rusqlite::params![cleaned, id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to add participant: {e}")))?;
        Ok(())
    }

    /// Stamp `leftAt` on a participant without removing them — historical
    /// roster preserves anyone who attended any portion of the meeting.
    pub fn mark_meeting_participant_left(
        &self,
        id: &str,
        participant_id: &str,
        left_at: i64,
    ) -> Result<(), IronMicError> {
        let conn = self.conn();
        let current: String = conn
            .query_row(
                "SELECT participants FROM meeting_sessions WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to read participants: {e}")))?;

        let mut roster: Vec<MeetingParticipant> =
            serde_json::from_str(&current).unwrap_or_default();

        if let Some(existing) = roster.iter_mut().find(|p| p.id == participant_id) {
            existing.left_at = Some(left_at);
        }

        let cleaned = serde_json::to_string(&roster).map_err(|e| {
            IronMicError::Storage(format!("Failed to serialize roster: {e}"))
        })?;
        conn.execute(
            "UPDATE meeting_sessions SET participants = ?1 WHERE id = ?2",
            rusqlite::params![cleaned, id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to mark left: {e}")))?;
        Ok(())
    }

    /// Return the raw JSON roster string (already camelCase per
    /// `MeetingParticipant` serde annotation). Empty string for unknown id.
    pub fn get_meeting_participants(&self, id: &str) -> Result<String, IronMicError> {
        let conn = self.conn();
        let row: Option<String> = conn
            .query_row(
                "SELECT participants FROM meeting_sessions WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| IronMicError::Storage(format!("Failed to get participants: {e}")))?;
        Ok(row.unwrap_or_else(|| "[]".to_string()))
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

    /// Find the most recent local meeting_session linked to the given remote
    /// (host) session id, INCLUDING already-ended rows. Used by the participant
    /// rejoin flow: if a row exists from a prior visit, reuse it instead of
    /// creating a fresh stub. Caller is responsible for `reopen_meeting_session`
    /// when the returned row has a non-null `ended_at`.
    ///
    /// Returns `(id, ended_at)` so the caller can decide whether a reopen is
    /// needed in one round-trip.
    pub fn find_latest_local_session_for_remote(
        &self,
        remote_id: &str,
    ) -> Result<Option<(String, Option<String>)>, IronMicError> {
        let conn = self.conn();
        conn.query_row(
            "SELECT id, ended_at FROM meeting_sessions
             WHERE json_extract(structured_output, '$.linkedRemoteSessionId') = ?1
             ORDER BY started_at DESC LIMIT 1",
            [remote_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|e| IronMicError::Storage(format!("Failed to find linked session: {e}")))
    }

    /// Aggregate over `structured_output.sequence` — replaces the renderer's
    /// O(N) JSON-parse scan with a single indexed query (idx_meetings_sequence).
    /// Returns 0 when no meetings have a sequence number assigned yet (the
    /// caller decides what to do at zero — typically fall back to total count
    /// for the very first run so legacy unnumbered meetings get retroactively
    /// numbered).
    pub fn get_max_meeting_sequence(&self) -> Result<i64, IronMicError> {
        let conn = self.conn();
        // ORDER BY ... LIMIT 1 is more reliable than MAX() at using the
        // expression index — SQLite's planner picks up the index for the
        // ordering directly.
        let value: Option<i64> = conn
            .query_row(
                "SELECT CAST(json_extract(structured_output, '$.sequence') AS INTEGER)
                 FROM meeting_sessions
                 WHERE structured_output IS NOT NULL
                   AND json_extract(structured_output, '$.sequence') IS NOT NULL
                 ORDER BY CAST(json_extract(structured_output, '$.sequence') AS INTEGER) DESC
                 LIMIT 1",
                [],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()
            .map_err(|e| IronMicError::Storage(format!("Failed to get max sequence: {e}")))?
            .flatten();
        Ok(value.unwrap_or(0))
    }

    /// Reopen a previously-ended meeting session so the participant rejoin
    /// flow can resume into the same row. Clears the sealed-state columns
    /// (`ended_at`, `summary`, `total_duration_seconds`, `entry_ids`); the
    /// JS caller is responsible for the analogous `structured_output` JSON
    /// merge (clear `plainSummary` / `sections` / `notebookEntryId`, keep
    /// `title` / `sequence` / `linkedRemoteSessionId` / `userNotes`).
    pub fn reopen_meeting_session(&self, id: &str) -> Result<(), IronMicError> {
        let conn = self.conn();
        conn.execute(
            "UPDATE meeting_sessions
             SET ended_at = NULL,
                 summary = NULL,
                 total_duration_seconds = NULL,
                 entry_ids = NULL
             WHERE id = ?1",
            [id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to reopen meeting: {e}")))?;
        Ok(())
    }
}
