use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::IronMicError;
use crate::storage::db::Database;

/// A VAD training sample — stores audio features (NOT raw audio).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VadTrainingSample {
    pub id: String,
    pub created_at: String,
    pub audio_features: String,
    pub label: String,
    pub is_user_corrected: bool,
    pub session_id: Option<String>,
}

impl Database {
    pub fn save_vad_training_sample(
        &self,
        audio_features: &str,
        label: &str,
        is_user_corrected: bool,
        session_id: Option<&str>,
    ) -> Result<(), IronMicError> {
        let conn = self.conn();
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO vad_training_samples (id, created_at, audio_features, label, is_user_corrected, session_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, now, audio_features, label, is_user_corrected as i32, session_id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to save VAD sample: {e}")))?;
        Ok(())
    }

    pub fn get_vad_training_samples(
        &self,
        limit: u32,
    ) -> Result<Vec<VadTrainingSample>, IronMicError> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, created_at, audio_features, label, is_user_corrected, session_id
                 FROM vad_training_samples ORDER BY created_at DESC LIMIT ?1",
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;

        let rows = stmt
            .query_map([limit], |row| {
                Ok(VadTrainingSample {
                    id: row.get(0)?,
                    created_at: row.get(1)?,
                    audio_features: row.get(2)?,
                    label: row.get(3)?,
                    is_user_corrected: row.get::<_, i32>(4)? != 0,
                    session_id: row.get(5)?,
                })
            })
            .map_err(|e| IronMicError::Storage(format!("Failed to query VAD samples: {e}")))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(
                row.map_err(|e| IronMicError::Storage(format!("Failed to read sample: {e}")))?,
            );
        }
        Ok(results)
    }

    pub fn get_vad_sample_count(&self) -> Result<u32, IronMicError> {
        let conn = self.conn();
        conn.query_row(
            "SELECT COUNT(*) FROM vad_training_samples",
            [],
            |row| row.get(0),
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to count VAD samples: {e}")))
    }

    pub fn delete_all_vad_samples(&self) -> Result<u32, IronMicError> {
        let conn = self.conn();
        let count = conn
            .execute("DELETE FROM vad_training_samples", [])
            .map_err(|e| IronMicError::Storage(format!("Failed to delete VAD samples: {e}")))?;
        Ok(count as u32)
    }
}
