use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::error::IronMicError;
use crate::storage::db::Database;

/// A stored embedding for semantic search.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingRecord {
    pub content_id: String,
    pub content_type: String,
    pub embedded_at: String,
    pub model_version: String,
}

/// An embedding with its raw vector data.
#[derive(Debug, Clone)]
pub struct EmbeddingWithData {
    pub content_id: String,
    pub content_type: String,
    pub embedding: Vec<u8>,
    pub embedded_at: String,
    pub model_version: String,
}

impl Database {
    pub fn store_embedding(
        &self,
        content_id: &str,
        content_type: &str,
        embedding_bytes: &[u8],
        model_version: &str,
    ) -> Result<(), IronMicError> {
        let conn = self.conn();
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT OR REPLACE INTO embeddings (content_id, content_type, embedding, embedded_at, model_version)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![content_id, content_type, embedding_bytes, now, model_version],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to store embedding: {e}")))?;
        Ok(())
    }

    pub fn store_embeddings_batch(
        &self,
        items: &[(String, String, Vec<u8>)],
        model_version: &str,
    ) -> Result<u32, IronMicError> {
        let conn = self.conn();
        let now = Utc::now().to_rfc3339();
        let mut count = 0u32;

        let tx = conn.unchecked_transaction()
            .map_err(|e| IronMicError::Storage(format!("Failed to begin transaction: {e}")))?;

        {
            let mut stmt = tx
                .prepare(
                    "INSERT OR REPLACE INTO embeddings (content_id, content_type, embedding, embedded_at, model_version)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                )
                .map_err(|e| IronMicError::Storage(format!("Failed to prepare insert: {e}")))?;

            for (content_id, content_type, embedding_bytes) in items {
                stmt.execute(rusqlite::params![content_id, content_type, embedding_bytes, now, model_version])
                    .map_err(|e| IronMicError::Storage(format!("Failed to insert embedding: {e}")))?;
                count += 1;
            }
        }

        tx.commit()
            .map_err(|e| IronMicError::Storage(format!("Failed to commit batch: {e}")))?;
        Ok(count)
    }

    pub fn get_all_embeddings(
        &self,
        content_type_filter: Option<&str>,
    ) -> Result<Vec<EmbeddingWithData>, IronMicError> {
        let conn = self.conn();
        let mut results = Vec::new();

        fn read_row(row: &rusqlite::Row) -> rusqlite::Result<EmbeddingWithData> {
            Ok(EmbeddingWithData {
                content_id: row.get(0)?,
                content_type: row.get(1)?,
                embedding: row.get(2)?,
                embedded_at: row.get(3)?,
                model_version: row.get(4)?,
            })
        }

        if let Some(filter) = content_type_filter {
            let mut stmt = conn
                .prepare(
                    "SELECT content_id, content_type, embedding, embedded_at, model_version
                     FROM embeddings WHERE content_type = ?1 ORDER BY embedded_at DESC",
                )
                .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;

            let rows = stmt
                .query_map([filter], read_row)
                .map_err(|e| IronMicError::Storage(format!("Failed to query embeddings: {e}")))?;

            for row in rows {
                results.push(
                    row.map_err(|e| IronMicError::Storage(format!("Failed to read embedding: {e}")))?,
                );
            }
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT content_id, content_type, embedding, embedded_at, model_version
                     FROM embeddings ORDER BY embedded_at DESC",
                )
                .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;

            let rows = stmt
                .query_map([], read_row)
                .map_err(|e| IronMicError::Storage(format!("Failed to query embeddings: {e}")))?;

            for row in rows {
                results.push(
                    row.map_err(|e| IronMicError::Storage(format!("Failed to read embedding: {e}")))?,
                );
            }
        }

        Ok(results)
    }

    pub fn get_unembedded_entries(&self, limit: u32) -> Result<Vec<(String, String)>, IronMicError> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT e.id, COALESCE(e.polished_text, e.raw_transcript)
                 FROM entries e
                 LEFT JOIN embeddings emb ON e.id = emb.content_id AND emb.content_type = 'entry'
                 WHERE emb.content_id IS NULL AND e.is_archived = 0
                 ORDER BY e.created_at DESC
                 LIMIT ?1",
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;

        let rows = stmt
            .query_map([limit], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| IronMicError::Storage(format!("Failed to query unembedded entries: {e}")))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(
                row.map_err(|e| IronMicError::Storage(format!("Failed to read row: {e}")))?,
            );
        }
        Ok(results)
    }

    pub fn delete_embedding(&self, content_id: &str, content_type: &str) -> Result<(), IronMicError> {
        let conn = self.conn();
        conn.execute(
            "DELETE FROM embeddings WHERE content_id = ?1 AND content_type = ?2",
            rusqlite::params![content_id, content_type],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to delete embedding: {e}")))?;
        Ok(())
    }

    pub fn get_embedding_stats(&self) -> Result<Vec<(String, u32)>, IronMicError> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT content_type, COUNT(*) FROM embeddings GROUP BY content_type",
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;

        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
            })
            .map_err(|e| IronMicError::Storage(format!("Failed to query embedding stats: {e}")))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(
                row.map_err(|e| IronMicError::Storage(format!("Failed to read stat: {e}")))?,
            );
        }
        Ok(results)
    }

    pub fn delete_all_embeddings(&self) -> Result<u32, IronMicError> {
        let conn = self.conn();
        let count = conn
            .execute("DELETE FROM embeddings", [])
            .map_err(|e| IronMicError::Storage(format!("Failed to delete embeddings: {e}")))?;
        Ok(count as u32)
    }
}
