use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::IronMicError;
use crate::storage::db::Database;

/// A notification entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Notification {
    pub id: String,
    pub source: String,
    pub source_id: Option<String>,
    pub notification_type: String,
    pub title: String,
    pub body: Option<String>,
    pub priority: f64,
    pub created_at: String,
    pub read_at: Option<String>,
    pub acted_on_at: Option<String>,
    pub dismissed_at: Option<String>,
    pub response_latency_ms: Option<i64>,
}

/// A notification interaction event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationInteraction {
    pub id: String,
    pub notification_id: String,
    pub action: String,
    pub timestamp: String,
    pub context_hour: Option<i32>,
    pub context_day_of_week: Option<i32>,
}

const SELECT_NOTIFICATION_COLS: &str =
    "id, source, source_id, notification_type, title, body, priority, created_at, read_at, acted_on_at, dismissed_at, response_latency_ms";

fn row_to_notification(row: &rusqlite::Row) -> rusqlite::Result<Notification> {
    Ok(Notification {
        id: row.get(0)?,
        source: row.get(1)?,
        source_id: row.get(2)?,
        notification_type: row.get(3)?,
        title: row.get(4)?,
        body: row.get(5)?,
        priority: row.get(6)?,
        created_at: row.get(7)?,
        read_at: row.get(8)?,
        acted_on_at: row.get(9)?,
        dismissed_at: row.get(10)?,
        response_latency_ms: row.get(11)?,
    })
}

impl Database {
    pub fn create_notification(
        &self,
        source: &str,
        source_id: Option<&str>,
        notification_type: &str,
        title: &str,
        body: Option<&str>,
    ) -> Result<Notification, IronMicError> {
        let conn = self.conn();
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO notifications (id, source, source_id, notification_type, title, body, priority, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0.5, ?7)",
            rusqlite::params![id, source, source_id, notification_type, title, body, now],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to create notification: {e}")))?;

        Ok(Notification {
            id,
            source: source.to_string(),
            source_id: source_id.map(String::from),
            notification_type: notification_type.to_string(),
            title: title.to_string(),
            body: body.map(String::from),
            priority: 0.5,
            created_at: now,
            read_at: None,
            acted_on_at: None,
            dismissed_at: None,
            response_latency_ms: None,
        })
    }

    pub fn list_notifications(
        &self,
        limit: u32,
        offset: u32,
        unread_only: bool,
    ) -> Result<Vec<Notification>, IronMicError> {
        let conn = self.conn();
        let sql = if unread_only {
            format!(
                "SELECT {SELECT_NOTIFICATION_COLS} FROM notifications WHERE read_at IS NULL AND dismissed_at IS NULL ORDER BY priority DESC, created_at DESC LIMIT ?1 OFFSET ?2"
            )
        } else {
            format!(
                "SELECT {SELECT_NOTIFICATION_COLS} FROM notifications ORDER BY priority DESC, created_at DESC LIMIT ?1 OFFSET ?2"
            )
        };

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;

        let rows = stmt
            .query_map(rusqlite::params![limit, offset], row_to_notification)
            .map_err(|e| IronMicError::Storage(format!("Failed to list notifications: {e}")))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(
                row.map_err(|e| IronMicError::Storage(format!("Failed to read notification: {e}")))?,
            );
        }
        Ok(results)
    }

    pub fn mark_notification_read(&self, id: &str) -> Result<(), IronMicError> {
        let conn = self.conn();
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE notifications SET read_at = ?1 WHERE id = ?2 AND read_at IS NULL",
            rusqlite::params![now, id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to mark notification read: {e}")))?;
        Ok(())
    }

    pub fn notification_act(&self, id: &str) -> Result<(), IronMicError> {
        let conn = self.conn();
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE notifications SET acted_on_at = ?1, read_at = COALESCE(read_at, ?1) WHERE id = ?2",
            rusqlite::params![now, id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to mark notification acted: {e}")))?;
        Ok(())
    }

    pub fn notification_dismiss(&self, id: &str) -> Result<(), IronMicError> {
        let conn = self.conn();
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE notifications SET dismissed_at = ?1 WHERE id = ?2",
            rusqlite::params![now, id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to dismiss notification: {e}")))?;
        Ok(())
    }

    pub fn update_notification_priority(&self, id: &str, priority: f64) -> Result<(), IronMicError> {
        let conn = self.conn();
        conn.execute(
            "UPDATE notifications SET priority = ?1 WHERE id = ?2",
            rusqlite::params![priority, id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to update notification priority: {e}")))?;
        Ok(())
    }

    pub fn log_notification_interaction(
        &self,
        notification_id: &str,
        action: &str,
        context_hour: Option<i32>,
        context_day_of_week: Option<i32>,
    ) -> Result<(), IronMicError> {
        let conn = self.conn();
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO notification_interactions (id, notification_id, action, timestamp, context_hour, context_day_of_week)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, notification_id, action, now, context_hour, context_day_of_week],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to log notification interaction: {e}")))?;
        Ok(())
    }

    pub fn get_notification_interactions(
        &self,
        since_date: &str,
    ) -> Result<Vec<NotificationInteraction>, IronMicError> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, notification_id, action, timestamp, context_hour, context_day_of_week
                 FROM notification_interactions WHERE timestamp >= ?1 ORDER BY timestamp DESC",
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;

        let rows = stmt
            .query_map([since_date], |row| {
                Ok(NotificationInteraction {
                    id: row.get(0)?,
                    notification_id: row.get(1)?,
                    action: row.get(2)?,
                    timestamp: row.get(3)?,
                    context_hour: row.get(4)?,
                    context_day_of_week: row.get(5)?,
                })
            })
            .map_err(|e| IronMicError::Storage(format!("Failed to query interactions: {e}")))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(
                row.map_err(|e| IronMicError::Storage(format!("Failed to read interaction: {e}")))?,
            );
        }
        Ok(results)
    }

    pub fn get_unread_notification_count(&self) -> Result<u32, IronMicError> {
        let conn = self.conn();
        conn.query_row(
            "SELECT COUNT(*) FROM notifications WHERE read_at IS NULL AND dismissed_at IS NULL",
            [],
            |row| row.get(0),
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to count unread notifications: {e}")))
    }

    pub fn delete_old_notifications(&self, retention_days: u32) -> Result<u32, IronMicError> {
        let conn = self.conn();
        let cutoff = chrono::Utc::now()
            .checked_sub_signed(chrono::Duration::days(retention_days as i64))
            .unwrap_or_else(Utc::now)
            .to_rfc3339();

        let count = conn
            .execute(
                "DELETE FROM notifications WHERE created_at < ?1",
                [&cutoff],
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to delete old notifications: {e}")))?;
        Ok(count as u32)
    }
}
