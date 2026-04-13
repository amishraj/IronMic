use chrono::Utc;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::error::IronMicError;
use crate::storage::db::Database;

/// Stored ML model weights.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MLModelWeights {
    pub model_name: String,
    pub weights_json: String,
    pub metadata_json: Option<String>,
    pub trained_at: String,
    pub training_samples: i32,
    pub version: i32,
}

/// TF.js model metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TFJSModelMetadata {
    pub model_id: String,
    pub version: String,
    pub size_bytes: i64,
    pub last_loaded_at: Option<String>,
    pub personal_fine_tune_version: i32,
    pub accuracy_score: Option<f64>,
}

impl Database {
    pub fn save_ml_weights(
        &self,
        model_name: &str,
        weights_json: &str,
        metadata_json: Option<&str>,
        training_samples: i32,
    ) -> Result<(), IronMicError> {
        let conn = self.conn();
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO ml_model_weights (model_name, weights_json, metadata_json, trained_at, training_samples, version)
             VALUES (?1, ?2, ?3, ?4, ?5, 1)
             ON CONFLICT(model_name) DO UPDATE SET
                weights_json = ?2, metadata_json = ?3, trained_at = ?4, training_samples = ?5,
                version = version + 1",
            rusqlite::params![model_name, weights_json, metadata_json, now, training_samples],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to save ML weights: {e}")))?;
        Ok(())
    }

    pub fn load_ml_weights(&self, model_name: &str) -> Result<Option<MLModelWeights>, IronMicError> {
        let conn = self.conn();
        conn.query_row(
            "SELECT model_name, weights_json, metadata_json, trained_at, training_samples, version
             FROM ml_model_weights WHERE model_name = ?1",
            [model_name],
            |row| {
                Ok(MLModelWeights {
                    model_name: row.get(0)?,
                    weights_json: row.get(1)?,
                    metadata_json: row.get(2)?,
                    trained_at: row.get(3)?,
                    training_samples: row.get(4)?,
                    version: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|e| IronMicError::Storage(format!("Failed to load ML weights: {e}")))
    }

    pub fn delete_ml_weights(&self, model_name: &str) -> Result<(), IronMicError> {
        let conn = self.conn();
        conn.execute(
            "DELETE FROM ml_model_weights WHERE model_name = ?1",
            [model_name],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to delete ML weights: {e}")))?;
        Ok(())
    }

    pub fn get_ml_training_status(&self) -> Result<Vec<(String, i32, i32, String)>, IronMicError> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT model_name, training_samples, version, trained_at
                 FROM ml_model_weights ORDER BY model_name",
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;

        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i32>(1)?,
                    row.get::<_, i32>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| IronMicError::Storage(format!("Failed to query training status: {e}")))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(
                row.map_err(|e| IronMicError::Storage(format!("Failed to read row: {e}")))?,
            );
        }
        Ok(results)
    }

    pub fn save_tfjs_model_metadata(
        &self,
        model_id: &str,
        version: &str,
        size_bytes: i64,
    ) -> Result<(), IronMicError> {
        let conn = self.conn();
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO tfjs_model_metadata (model_id, version, size_bytes, last_loaded_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(model_id) DO UPDATE SET
                version = ?2, size_bytes = ?3, last_loaded_at = ?4",
            rusqlite::params![model_id, version, size_bytes, now],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to save model metadata: {e}")))?;
        Ok(())
    }

    pub fn get_tfjs_model_metadata(
        &self,
        model_id: &str,
    ) -> Result<Option<TFJSModelMetadata>, IronMicError> {
        let conn = self.conn();
        conn.query_row(
            "SELECT model_id, version, size_bytes, last_loaded_at, personal_fine_tune_version, accuracy_score
             FROM tfjs_model_metadata WHERE model_id = ?1",
            [model_id],
            |row| {
                Ok(TFJSModelMetadata {
                    model_id: row.get(0)?,
                    version: row.get(1)?,
                    size_bytes: row.get(2)?,
                    last_loaded_at: row.get(3)?,
                    personal_fine_tune_version: row.get(4)?,
                    accuracy_score: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|e| IronMicError::Storage(format!("Failed to get model metadata: {e}")))
    }

    pub fn delete_all_ml_data(&self) -> Result<(), IronMicError> {
        let conn = self.conn();
        conn.execute_batch(
            "DELETE FROM ml_model_weights;
             DELETE FROM tfjs_model_metadata;
             DELETE FROM vad_training_samples;
             DELETE FROM intent_training_samples;
             DELETE FROM voice_routing_log;
             DELETE FROM notification_interactions;
             DELETE FROM action_log;
             DELETE FROM workflows;
             DELETE FROM embeddings;",
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to delete all ML data: {e}")))?;
        Ok(())
    }
}
