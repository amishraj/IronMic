use chrono::Utc;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::IronMicError;
use crate::storage::db::Database;

/// A single transcribed chunk from a meeting session.
/// Speaker labels are NULL until LLM diarization runs post-meeting.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptSegment {
    pub id: String,
    pub session_id: String,
    pub speaker_label: Option<String>,
    /// Milliseconds from session start_at
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    /// 'meeting' | 'participant:{name}' (Phase 2)
    pub source: String,
    /// NULL for solo; peer UUID for multi-user (Phase 2)
    pub participant_id: Option<String>,
    pub confidence: Option<f64>,
    pub created_at: String,
}

fn read_segment(row: &rusqlite::Row<'_>) -> rusqlite::Result<TranscriptSegment> {
    Ok(TranscriptSegment {
        id: row.get(0)?,
        session_id: row.get(1)?,
        speaker_label: row.get(2)?,
        start_ms: row.get(3)?,
        end_ms: row.get(4)?,
        text: row.get(5)?,
        source: row.get(6)?,
        participant_id: row.get(7)?,
        confidence: row.get(8)?,
        created_at: row.get(9)?,
    })
}

const SELECT_COLS: &str =
    "id, session_id, speaker_label, start_ms, end_ms, text, source, participant_id, confidence, created_at";

impl Database {
    /// Add a new transcript segment for a meeting session.
    pub fn add_transcript_segment(
        &self,
        session_id: &str,
        speaker_label: Option<&str>,
        start_ms: i64,
        end_ms: i64,
        text: &str,
        source: &str,
        participant_id: Option<&str>,
        confidence: Option<f64>,
    ) -> Result<TranscriptSegment, IronMicError> {
        let conn = self.conn();
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO transcript_segments
             (id, session_id, speaker_label, start_ms, end_ms, text, source, participant_id, confidence, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                id, session_id, speaker_label, start_ms, end_ms, text, source,
                participant_id, confidence, now
            ],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to add transcript segment: {e}")))?;

        Ok(TranscriptSegment {
            id,
            session_id: session_id.to_string(),
            speaker_label: speaker_label.map(String::from),
            start_ms,
            end_ms,
            text: text.to_string(),
            source: source.to_string(),
            participant_id: participant_id.map(String::from),
            confidence,
            created_at: now,
        })
    }

    /// List all transcript segments for a session, ordered by start time.
    pub fn list_transcript_segments(
        &self,
        session_id: &str,
    ) -> Result<Vec<TranscriptSegment>, IronMicError> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {SELECT_COLS} FROM transcript_segments WHERE session_id = ?1 ORDER BY start_ms ASC"
            ))
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;

        let segments = stmt
            .query_map([session_id], read_segment)
            .map_err(|e| IronMicError::Storage(format!("Failed to list segments: {e}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| IronMicError::Storage(format!("Failed to collect segments: {e}")))?;

        Ok(segments)
    }

    /// Update the speaker label for a specific segment (called post-diarization).
    pub fn update_segment_speaker(
        &self,
        id: &str,
        speaker_label: &str,
    ) -> Result<(), IronMicError> {
        let conn = self.conn();
        conn.execute(
            "UPDATE transcript_segments SET speaker_label = ?1 WHERE id = ?2",
            rusqlite::params![speaker_label, id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to update segment speaker: {e}")))?;
        Ok(())
    }

    /// Get a single transcript segment by ID.
    pub fn get_transcript_segment(
        &self,
        id: &str,
    ) -> Result<Option<TranscriptSegment>, IronMicError> {
        let conn = self.conn();
        conn.query_row(
            &format!("SELECT {SELECT_COLS} FROM transcript_segments WHERE id = ?1"),
            [id],
            read_segment,
        )
        .optional()
        .map_err(|e| IronMicError::Storage(format!("Failed to get segment: {e}")))
    }

    /// Delete all transcript segments for a session.
    pub fn delete_segments_for_session(&self, session_id: &str) -> Result<u32, IronMicError> {
        let conn = self.conn();
        let count = conn
            .execute(
                "DELETE FROM transcript_segments WHERE session_id = ?1",
                [session_id],
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to delete segments: {e}")))?;
        Ok(count as u32)
    }

    /// Assemble the full transcript text for a session by joining all segments in order.
    pub fn assemble_full_transcript(&self, session_id: &str) -> Result<String, IronMicError> {
        let segments = self.list_transcript_segments(session_id)?;
        let text = segments
            .iter()
            .map(|s| {
                if let Some(ref label) = s.speaker_label {
                    format!("[{label}]: {}", s.text)
                } else {
                    s.text.clone()
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        Ok(text)
    }
}
