use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::IronMicError;
use crate::storage::db::Database;

/// An action log entry for workflow discovery.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionLogEntry {
    pub id: String,
    pub action_type: String,
    pub timestamp: String,
    pub hour_of_day: i32,
    pub day_of_week: i32,
    pub metadata_json: Option<String>,
}

impl Database {
    pub fn log_action(
        &self,
        action_type: &str,
        metadata_json: Option<&str>,
    ) -> Result<(), IronMicError> {
        let conn = self.conn();
        let id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let timestamp = now.to_rfc3339();
        let hour_of_day = now.format("%H").to_string().parse::<i32>().unwrap_or(0);
        let day_of_week = now.format("%u").to_string().parse::<i32>().unwrap_or(0); // 1=Monday

        conn.execute(
            "INSERT INTO action_log (id, action_type, timestamp, hour_of_day, day_of_week, metadata_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, action_type, timestamp, hour_of_day, day_of_week, metadata_json],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to log action: {e}")))?;
        Ok(())
    }

    pub fn query_action_log(
        &self,
        from_date: &str,
        to_date: &str,
        action_type_filter: Option<&str>,
    ) -> Result<Vec<ActionLogEntry>, IronMicError> {
        let conn = self.conn();
        let mut results = Vec::new();

        fn read_row(row: &rusqlite::Row) -> rusqlite::Result<ActionLogEntry> {
            Ok(ActionLogEntry {
                id: row.get(0)?,
                action_type: row.get(1)?,
                timestamp: row.get(2)?,
                hour_of_day: row.get(3)?,
                day_of_week: row.get(4)?,
                metadata_json: row.get(5)?,
            })
        }

        if let Some(filter) = action_type_filter {
            let mut stmt = conn
                .prepare(
                    "SELECT id, action_type, timestamp, hour_of_day, day_of_week, metadata_json
                     FROM action_log WHERE timestamp >= ?1 AND timestamp <= ?2 AND action_type = ?3
                     ORDER BY timestamp ASC",
                )
                .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;

            let rows = stmt
                .query_map(rusqlite::params![from_date, to_date, filter], read_row)
                .map_err(|e| IronMicError::Storage(format!("Failed to query action log: {e}")))?;

            for row in rows {
                results.push(
                    row.map_err(|e| IronMicError::Storage(format!("Failed to read action: {e}")))?,
                );
            }
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT id, action_type, timestamp, hour_of_day, day_of_week, metadata_json
                     FROM action_log WHERE timestamp >= ?1 AND timestamp <= ?2
                     ORDER BY timestamp ASC",
                )
                .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;

            let rows = stmt
                .query_map(rusqlite::params![from_date, to_date], read_row)
                .map_err(|e| IronMicError::Storage(format!("Failed to query action log: {e}")))?;

            for row in rows {
                results.push(
                    row.map_err(|e| IronMicError::Storage(format!("Failed to read action: {e}")))?,
                );
            }
        }

        Ok(results)
    }

    pub fn get_action_counts(&self) -> Result<(u32, u32), IronMicError> {
        let conn = self.conn();
        let total: u32 = conn
            .query_row("SELECT COUNT(*) FROM action_log", [], |row| row.get(0))
            .map_err(|e| IronMicError::Storage(format!("Failed to count actions: {e}")))?;

        // Actions in the last 24 hours
        let cutoff = chrono::Utc::now()
            .checked_sub_signed(chrono::Duration::hours(24))
            .unwrap_or_else(Utc::now)
            .to_rfc3339();

        let recent: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM action_log WHERE timestamp >= ?1",
                [&cutoff],
                |row| row.get(0),
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to count recent actions: {e}")))?;

        Ok((total, recent))
    }

    pub fn delete_old_actions(&self, retention_days: u32) -> Result<u32, IronMicError> {
        let conn = self.conn();
        let cutoff = chrono::Utc::now()
            .checked_sub_signed(chrono::Duration::days(retention_days as i64))
            .unwrap_or_else(Utc::now)
            .to_rfc3339();

        let count = conn
            .execute("DELETE FROM action_log WHERE timestamp < ?1", [&cutoff])
            .map_err(|e| IronMicError::Storage(format!("Failed to delete old actions: {e}")))?;
        Ok(count as u32)
    }
}
