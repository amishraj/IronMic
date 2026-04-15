use chrono::Utc;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::IronMicError;
use crate::storage::db::Database;

/// A meeting template defining structured output format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingTemplate {
    pub id: String,
    pub name: String,
    pub meeting_type: String,
    pub sections: String,
    pub llm_prompt: String,
    pub display_layout: String,
    pub is_builtin: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl Database {
    pub fn create_meeting_template(
        &self,
        name: &str,
        meeting_type: &str,
        sections: &str,
        llm_prompt: &str,
        display_layout: &str,
    ) -> Result<MeetingTemplate, IronMicError> {
        let conn = self.conn();
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO meeting_templates (id, name, meeting_type, sections, llm_prompt, display_layout, is_builtin, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?7)",
            rusqlite::params![id, name, meeting_type, sections, llm_prompt, display_layout, now],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to create template: {e}")))?;

        Ok(MeetingTemplate {
            id,
            name: name.to_string(),
            meeting_type: meeting_type.to_string(),
            sections: sections.to_string(),
            llm_prompt: llm_prompt.to_string(),
            display_layout: display_layout.to_string(),
            is_builtin: false,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn get_meeting_template(&self, id: &str) -> Result<Option<MeetingTemplate>, IronMicError> {
        let conn = self.conn();
        conn.query_row(
            "SELECT id, name, meeting_type, sections, llm_prompt, display_layout, is_builtin, created_at, updated_at
             FROM meeting_templates WHERE id = ?1",
            [id],
            |row| {
                Ok(MeetingTemplate {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    meeting_type: row.get(2)?,
                    sections: row.get(3)?,
                    llm_prompt: row.get(4)?,
                    display_layout: row.get(5)?,
                    is_builtin: row.get::<_, i32>(6)? != 0,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            },
        )
        .optional()
        .map_err(|e| IronMicError::Storage(format!("Failed to get template: {e}")))
    }

    pub fn list_meeting_templates(&self) -> Result<Vec<MeetingTemplate>, IronMicError> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, meeting_type, sections, llm_prompt, display_layout, is_builtin, created_at, updated_at
                 FROM meeting_templates ORDER BY is_builtin DESC, name ASC",
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(MeetingTemplate {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    meeting_type: row.get(2)?,
                    sections: row.get(3)?,
                    llm_prompt: row.get(4)?,
                    display_layout: row.get(5)?,
                    is_builtin: row.get::<_, i32>(6)? != 0,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })
            .map_err(|e| IronMicError::Storage(format!("Failed to list templates: {e}")))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(
                row.map_err(|e| IronMicError::Storage(format!("Failed to read template: {e}")))?,
            );
        }
        Ok(results)
    }

    pub fn update_meeting_template(
        &self,
        id: &str,
        name: &str,
        meeting_type: &str,
        sections: &str,
        llm_prompt: &str,
        display_layout: &str,
    ) -> Result<(), IronMicError> {
        let conn = self.conn();
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "UPDATE meeting_templates SET name = ?1, meeting_type = ?2, sections = ?3,
             llm_prompt = ?4, display_layout = ?5, updated_at = ?6 WHERE id = ?7 AND is_builtin = 0",
            rusqlite::params![name, meeting_type, sections, llm_prompt, display_layout, now, id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to update template: {e}")))?;
        Ok(())
    }

    pub fn delete_meeting_template(&self, id: &str) -> Result<(), IronMicError> {
        let conn = self.conn();
        // Prevent deletion of builtin templates
        conn.execute(
            "DELETE FROM meeting_templates WHERE id = ?1 AND is_builtin = 0",
            [id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to delete template: {e}")))?;
        Ok(())
    }
}
