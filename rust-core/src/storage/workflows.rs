use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::IronMicError;
use crate::storage::db::Database;

/// A discovered workflow pattern.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workflow {
    pub id: String,
    pub name: Option<String>,
    pub action_sequence: String,
    pub trigger_pattern: Option<String>,
    pub confidence: f64,
    pub occurrence_count: i32,
    pub first_seen_at: String,
    pub last_seen_at: String,
    pub is_saved: bool,
    pub is_dismissed: bool,
}

const SELECT_WORKFLOW_COLS: &str =
    "id, name, action_sequence, trigger_pattern, confidence, occurrence_count, first_seen_at, last_seen_at, is_saved, is_dismissed";

fn row_to_workflow(row: &rusqlite::Row) -> rusqlite::Result<Workflow> {
    Ok(Workflow {
        id: row.get(0)?,
        name: row.get(1)?,
        action_sequence: row.get(2)?,
        trigger_pattern: row.get(3)?,
        confidence: row.get(4)?,
        occurrence_count: row.get(5)?,
        first_seen_at: row.get(6)?,
        last_seen_at: row.get(7)?,
        is_saved: row.get::<_, i32>(8)? != 0,
        is_dismissed: row.get::<_, i32>(9)? != 0,
    })
}

impl Database {
    pub fn create_workflow(
        &self,
        action_sequence: &str,
        trigger_pattern: Option<&str>,
        confidence: f64,
        occurrence_count: i32,
    ) -> Result<Workflow, IronMicError> {
        let conn = self.conn();
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO workflows (id, action_sequence, trigger_pattern, confidence, occurrence_count, first_seen_at, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            rusqlite::params![id, action_sequence, trigger_pattern, confidence, occurrence_count, now],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to create workflow: {e}")))?;

        Ok(Workflow {
            id,
            name: None,
            action_sequence: action_sequence.to_string(),
            trigger_pattern: trigger_pattern.map(String::from),
            confidence,
            occurrence_count,
            first_seen_at: now.clone(),
            last_seen_at: now,
            is_saved: false,
            is_dismissed: false,
        })
    }

    pub fn list_workflows(&self, include_dismissed: bool) -> Result<Vec<Workflow>, IronMicError> {
        let conn = self.conn();
        let sql = if include_dismissed {
            format!("SELECT {SELECT_WORKFLOW_COLS} FROM workflows ORDER BY confidence DESC, last_seen_at DESC")
        } else {
            format!("SELECT {SELECT_WORKFLOW_COLS} FROM workflows WHERE is_dismissed = 0 ORDER BY confidence DESC, last_seen_at DESC")
        };

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;

        let rows = stmt
            .query_map([], row_to_workflow)
            .map_err(|e| IronMicError::Storage(format!("Failed to list workflows: {e}")))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(
                row.map_err(|e| IronMicError::Storage(format!("Failed to read workflow: {e}")))?,
            );
        }
        Ok(results)
    }

    pub fn save_workflow(&self, id: &str, name: &str) -> Result<(), IronMicError> {
        let conn = self.conn();
        conn.execute(
            "UPDATE workflows SET name = ?1, is_saved = 1 WHERE id = ?2",
            rusqlite::params![name, id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to save workflow: {e}")))?;
        Ok(())
    }

    pub fn dismiss_workflow(&self, id: &str) -> Result<(), IronMicError> {
        let conn = self.conn();
        conn.execute(
            "UPDATE workflows SET is_dismissed = 1 WHERE id = ?1",
            [id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to dismiss workflow: {e}")))?;
        Ok(())
    }

    pub fn delete_workflow(&self, id: &str) -> Result<(), IronMicError> {
        let conn = self.conn();
        conn.execute("DELETE FROM workflows WHERE id = ?1", [id])
            .map_err(|e| IronMicError::Storage(format!("Failed to delete workflow: {e}")))?;
        Ok(())
    }

    pub fn update_workflow_occurrence(
        &self,
        id: &str,
        confidence: f64,
        occurrence_count: i32,
    ) -> Result<(), IronMicError> {
        let conn = self.conn();
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE workflows SET confidence = ?1, occurrence_count = ?2, last_seen_at = ?3 WHERE id = ?4",
            rusqlite::params![confidence, occurrence_count, now, id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to update workflow: {e}")))?;
        Ok(())
    }
}
