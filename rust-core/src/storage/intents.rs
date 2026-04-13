use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::IronMicError;
use crate::storage::db::Database;

/// An intent classification training sample.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntentTrainingSample {
    pub id: String,
    pub created_at: String,
    pub transcript: String,
    pub predicted_intent: Option<String>,
    pub predicted_entities: Option<String>,
    pub corrected_intent: Option<String>,
    pub corrected_entities: Option<String>,
    pub confidence: Option<f64>,
    pub entry_id: Option<String>,
}

/// A voice routing log entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceRoutingEntry {
    pub id: String,
    pub created_at: String,
    pub active_screen: String,
    pub detected_intent: String,
    pub routed_to: String,
    pub was_correct: bool,
    pub entry_id: Option<String>,
}

impl Database {
    pub fn save_intent_training_sample(
        &self,
        transcript: &str,
        predicted_intent: Option<&str>,
        predicted_entities: Option<&str>,
        confidence: Option<f64>,
        entry_id: Option<&str>,
    ) -> Result<(), IronMicError> {
        let conn = self.conn();
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO intent_training_samples (id, created_at, transcript, predicted_intent, predicted_entities, confidence, entry_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![id, now, transcript, predicted_intent, predicted_entities, confidence, entry_id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to save intent sample: {e}")))?;
        Ok(())
    }

    pub fn correct_intent_sample(
        &self,
        id: &str,
        corrected_intent: &str,
        corrected_entities: Option<&str>,
    ) -> Result<(), IronMicError> {
        let conn = self.conn();
        conn.execute(
            "UPDATE intent_training_samples SET corrected_intent = ?1, corrected_entities = ?2 WHERE id = ?3",
            rusqlite::params![corrected_intent, corrected_entities, id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to correct intent sample: {e}")))?;
        Ok(())
    }

    pub fn get_intent_training_samples(
        &self,
        limit: u32,
    ) -> Result<Vec<IntentTrainingSample>, IronMicError> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, created_at, transcript, predicted_intent, predicted_entities,
                        corrected_intent, corrected_entities, confidence, entry_id
                 FROM intent_training_samples ORDER BY created_at DESC LIMIT ?1",
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;

        let rows = stmt
            .query_map([limit], |row| {
                Ok(IntentTrainingSample {
                    id: row.get(0)?,
                    created_at: row.get(1)?,
                    transcript: row.get(2)?,
                    predicted_intent: row.get(3)?,
                    predicted_entities: row.get(4)?,
                    corrected_intent: row.get(5)?,
                    corrected_entities: row.get(6)?,
                    confidence: row.get(7)?,
                    entry_id: row.get(8)?,
                })
            })
            .map_err(|e| IronMicError::Storage(format!("Failed to query intent samples: {e}")))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(
                row.map_err(|e| IronMicError::Storage(format!("Failed to read sample: {e}")))?,
            );
        }
        Ok(results)
    }

    pub fn get_intent_correction_count(&self) -> Result<u32, IronMicError> {
        let conn = self.conn();
        conn.query_row(
            "SELECT COUNT(*) FROM intent_training_samples WHERE corrected_intent IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to count corrections: {e}")))
    }

    pub fn log_voice_routing(
        &self,
        active_screen: &str,
        detected_intent: &str,
        routed_to: &str,
        entry_id: Option<&str>,
    ) -> Result<(), IronMicError> {
        let conn = self.conn();
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO voice_routing_log (id, created_at, active_screen, detected_intent, routed_to, entry_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, now, active_screen, detected_intent, routed_to, entry_id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to log voice routing: {e}")))?;
        Ok(())
    }

    pub fn correct_voice_routing(&self, id: &str) -> Result<(), IronMicError> {
        let conn = self.conn();
        conn.execute(
            "UPDATE voice_routing_log SET was_correct = 0 WHERE id = ?1",
            [id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to correct routing: {e}")))?;
        Ok(())
    }

    pub fn delete_all_intent_samples(&self) -> Result<u32, IronMicError> {
        let conn = self.conn();
        let count = conn
            .execute("DELETE FROM intent_training_samples", [])
            .map_err(|e| IronMicError::Storage(format!("Failed to delete intent samples: {e}")))?;
        Ok(count as u32)
    }

    pub fn delete_all_routing_logs(&self) -> Result<u32, IronMicError> {
        let conn = self.conn();
        let count = conn
            .execute("DELETE FROM voice_routing_log", [])
            .map_err(|e| IronMicError::Storage(format!("Failed to delete routing logs: {e}")))?;
        Ok(count as u32)
    }
}
