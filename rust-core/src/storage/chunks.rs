//! Chunks — retrievable units carved from entries, meetings, transcript
//! segments, and user notes (migration v10).
//!
//! The chunk text is stored alongside its metadata (timestamps, speaker,
//! heading path, etc.) so retrieval can return ready-to-cite snippets without
//! a second JOIN, and so re-chunking never has to run during a query.
//!
//! Embeddings for chunks live in the sibling `chunk_embeddings` table
//! keyed by `(chunk_id, model_version)`; that separation lets multiple
//! embedding models coexist during lazy migrations.

use chrono::Utc;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::IronMicError;
use crate::storage::db::Database;

/// Allowed source_type values. Stored as TEXT but documented here so callers
/// have a single source of truth. Note: these strings are part of the public
/// JSON contract surfaced through N-API and must not change without a migration.
pub mod source_types {
    pub const ENTRY: &str = "entry";
    pub const MEETING: &str = "meeting";
    pub const MEETING_SEGMENT: &str = "meeting_segment";
    pub const USER_NOTE: &str = "user_note";
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chunk {
    pub id: String,
    pub source_type: String,
    pub source_id: String,
    pub parent_id: Option<String>,
    pub chunk_index: i64,
    pub text: String,
    /// One-sentence doc-level context prepended only at embedding time
    /// (Anthropic's "contextual retrieval" technique). NEVER prepended to
    /// `text` when surfacing to the user — that would muddy citations.
    pub context_prefix: Option<String>,
    pub char_start: Option<i64>,
    pub char_end: Option<i64>,
    /// Meeting chunks only: offset within the session timeline.
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    /// Meeting chunks only.
    pub speaker_label: Option<String>,
    /// Notes/entries only: JSON array of breadcrumb headings,
    /// e.g. `["Project X","Decisions"]`.
    pub heading_path: Option<String>,
    pub token_count: Option<i64>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NewChunk {
    /// Optional caller-supplied id (e.g. for tests / replay imports). Defaults
    /// to a fresh UUID v4 when None.
    pub id: Option<String>,
    pub source_type: String,
    pub source_id: String,
    pub parent_id: Option<String>,
    pub chunk_index: i64,
    pub text: String,
    pub context_prefix: Option<String>,
    pub char_start: Option<i64>,
    pub char_end: Option<i64>,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub speaker_label: Option<String>,
    pub heading_path: Option<String>,
    pub token_count: Option<i64>,
}

/// One row of the `chunk_embeddings` table. The `embedding` field is the raw
/// little-endian Float32 byte buffer — `dim * 4` bytes, L2-normalized so a
/// later dot-product equals cosine similarity.
#[derive(Debug, Clone)]
pub struct ChunkEmbedding {
    pub chunk_id: String,
    pub model_version: String,
    pub dim: i64,
    pub embedding: Vec<u8>,
    pub embedded_at: String,
}

const SELECT_COLS: &str =
    "id, source_type, source_id, parent_id, chunk_index, text, context_prefix, char_start, char_end, start_ms, end_ms, speaker_label, heading_path, token_count, created_at";

fn row_to_chunk(row: &rusqlite::Row) -> rusqlite::Result<Chunk> {
    Ok(Chunk {
        id: row.get(0)?,
        source_type: row.get(1)?,
        source_id: row.get(2)?,
        parent_id: row.get(3)?,
        chunk_index: row.get(4)?,
        text: row.get(5)?,
        context_prefix: row.get(6)?,
        char_start: row.get(7)?,
        char_end: row.get(8)?,
        start_ms: row.get(9)?,
        end_ms: row.get(10)?,
        speaker_label: row.get(11)?,
        heading_path: row.get(12)?,
        token_count: row.get(13)?,
        created_at: row.get(14)?,
    })
}

/// Chunk-table stats tuple returned by [`ChunkStore::stats`]:
/// `(by_source_type, total_chunks, indexed_chunks_for_active_model)`.
/// Aliased to keep the public signature readable per
/// `clippy::type_complexity` policy.
pub type ChunkStats = (Vec<(String, i64)>, i64, i64);

pub struct ChunkStore {
    db: Database,
}

impl ChunkStore {
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    /// Replace all chunks for a single source in one transaction. This is the
    /// canonical write path for indexing: callers chunk a document, then call
    /// `replace_for_source` to atomically swap in the new chunk set. Embeddings
    /// for the old chunks cascade-delete via FK.
    pub fn replace_for_source(
        &self,
        source_type: &str,
        source_id: &str,
        chunks: Vec<NewChunk>,
    ) -> Result<Vec<Chunk>, IronMicError> {
        let conn = self.db.conn();
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| IronMicError::Storage(format!("Failed to begin chunk tx: {e}")))?;

        tx.execute(
            "DELETE FROM chunks WHERE source_type = ?1 AND source_id = ?2",
            rusqlite::params![source_type, source_id],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to delete old chunks: {e}")))?;

        let now = Utc::now().to_rfc3339();
        let mut inserted_ids: Vec<String> = Vec::with_capacity(chunks.len());
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO chunks
                     (id, source_type, source_id, parent_id, chunk_index, text, context_prefix,
                      char_start, char_end, start_ms, end_ms, speaker_label, heading_path,
                      token_count, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                )
                .map_err(|e| IronMicError::Storage(format!("Failed to prepare chunk insert: {e}")))?;

            for c in chunks {
                let id = c.id.unwrap_or_else(|| Uuid::new_v4().to_string());
                stmt.execute(rusqlite::params![
                    id,
                    c.source_type,
                    c.source_id,
                    c.parent_id,
                    c.chunk_index,
                    c.text,
                    c.context_prefix,
                    c.char_start,
                    c.char_end,
                    c.start_ms,
                    c.end_ms,
                    c.speaker_label,
                    c.heading_path,
                    c.token_count,
                    now,
                ])
                .map_err(|e| IronMicError::Storage(format!("Failed to insert chunk: {e}")))?;
                inserted_ids.push(id);
            }
        }

        tx.commit()
            .map_err(|e| IronMicError::Storage(format!("Failed to commit chunks: {e}")))?;

        // Re-fetch via the same conn (we still hold the mutex). Reaching for
        // `self.get(id)` here would re-acquire it and deadlock — that's a
        // landmine the v1 of this code stepped on, hence this inline path.
        let mut out: Vec<Chunk> = Vec::with_capacity(inserted_ids.len());
        {
            let mut stmt = conn
                .prepare(&format!("SELECT {SELECT_COLS} FROM chunks WHERE id = ?1"))
                .map_err(|e| IronMicError::Storage(format!("Failed to prepare re-fetch: {e}")))?;
            for id in inserted_ids {
                if let Some(c) = stmt
                    .query_row([&id], row_to_chunk)
                    .optional()
                    .map_err(|e| IronMicError::Storage(format!("Failed to re-fetch chunk: {e}")))?
                {
                    out.push(c);
                }
            }
        }
        Ok(out)
    }

    pub fn get(&self, id: &str) -> Result<Option<Chunk>, IronMicError> {
        let conn = self.db.conn();
        let mut stmt = conn
            .prepare(&format!("SELECT {SELECT_COLS} FROM chunks WHERE id = ?1"))
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;
        stmt.query_row([id], row_to_chunk)
            .optional()
            .map_err(|e| IronMicError::Storage(format!("Failed to get chunk: {e}")))
    }

    /// Return every chunk for one source in `chunk_index` order. Used by the
    /// retrieval layer when a single-doc query wants the whole document.
    pub fn list_for_source(
        &self,
        source_type: &str,
        source_id: &str,
    ) -> Result<Vec<Chunk>, IronMicError> {
        let conn = self.db.conn();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {SELECT_COLS} FROM chunks WHERE source_type = ?1 AND source_id = ?2 ORDER BY chunk_index ASC"
            ))
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;
        let rows = stmt
            .query_map(rusqlite::params![source_type, source_id], row_to_chunk)
            .map_err(|e| IronMicError::Storage(format!("Failed to query chunks: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| IronMicError::Storage(format!("Failed to collect chunks: {e}")))
    }

    /// Delete all chunks for a source. Embeddings cascade via FK. Used when an
    /// entry/meeting/note is removed or when reset_index is invoked.
    pub fn delete_for_source(
        &self,
        source_type: &str,
        source_id: &str,
    ) -> Result<u32, IronMicError> {
        let conn = self.db.conn();
        let count = conn
            .execute(
                "DELETE FROM chunks WHERE source_type = ?1 AND source_id = ?2",
                rusqlite::params![source_type, source_id],
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to delete chunks: {e}")))?;
        Ok(count as u32)
    }

    /// Return up to `limit` chunks that have no embedding for `model_version` yet.
    /// Drives the renderer-side embedder loop: pull, embed, write back via
    /// `store_chunk_embeddings_batch`. Ordered newest-first so freshly-created
    /// content surfaces in search before months-old backlog.
    pub fn list_unembedded(
        &self,
        limit: u32,
        model_version: &str,
    ) -> Result<Vec<(String, String, Option<String>)>, IronMicError> {
        let conn = self.db.conn();
        let mut stmt = conn
            .prepare(
                "SELECT c.id, c.text, c.context_prefix
                 FROM chunks c
                 LEFT JOIN chunk_embeddings ce
                   ON ce.chunk_id = c.id AND ce.model_version = ?1
                 WHERE ce.chunk_id IS NULL
                 ORDER BY c.created_at DESC
                 LIMIT ?2",
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare unembedded query: {e}")))?;
        let rows = stmt
            .query_map(rusqlite::params![model_version, limit], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|e| IronMicError::Storage(format!("Failed to query unembedded: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| IronMicError::Storage(format!("Failed to collect unembedded: {e}")))
    }

    /// Store many chunk embeddings in one transaction. `items` is
    /// `(chunk_id, embedding_bytes)` pairs; `dim` must match `embedding_bytes.len() / 4`.
    pub fn store_chunk_embeddings_batch(
        &self,
        items: &[(String, Vec<u8>)],
        model_version: &str,
        dim: i64,
    ) -> Result<u32, IronMicError> {
        let conn = self.db.conn();
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| IronMicError::Storage(format!("Failed to begin embedding tx: {e}")))?;

        let now = Utc::now().to_rfc3339();
        let mut count = 0u32;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT OR REPLACE INTO chunk_embeddings (chunk_id, model_version, dim, embedding, embedded_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                )
                .map_err(|e| IronMicError::Storage(format!("Failed to prepare embed insert: {e}")))?;

            for (chunk_id, bytes) in items {
                let expected = (dim as usize) * 4;
                if bytes.len() != expected {
                    return Err(IronMicError::Storage(format!(
                        "Embedding byte length {} does not match dim*4={} for chunk {}",
                        bytes.len(),
                        expected,
                        chunk_id
                    )));
                }
                stmt.execute(rusqlite::params![chunk_id, model_version, dim, bytes, now])
                    .map_err(|e| IronMicError::Storage(format!("Failed to insert embedding: {e}")))?;
                count += 1;
            }
        }

        tx.commit()
            .map_err(|e| IronMicError::Storage(format!("Failed to commit embeddings: {e}")))?;
        Ok(count)
    }

    /// Load every (chunk_id, embedding) pair for the active model. Used by the
    /// retrieval layer's flat SIMD cosine. Keep one Vec<(String, Vec<u8>)> in
    /// RAM — at 384 dims that's ~1.6 KB per chunk, ~16 MB for 10k chunks.
    pub fn list_chunk_embeddings(
        &self,
        model_version: &str,
    ) -> Result<Vec<ChunkEmbedding>, IronMicError> {
        let conn = self.db.conn();
        let mut stmt = conn
            .prepare(
                "SELECT chunk_id, model_version, dim, embedding, embedded_at
                 FROM chunk_embeddings WHERE model_version = ?1",
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare query: {e}")))?;
        let rows = stmt
            .query_map([model_version], |row| {
                Ok(ChunkEmbedding {
                    chunk_id: row.get(0)?,
                    model_version: row.get(1)?,
                    dim: row.get(2)?,
                    embedding: row.get(3)?,
                    embedded_at: row.get(4)?,
                })
            })
            .map_err(|e| IronMicError::Storage(format!("Failed to query chunk_embeddings: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| IronMicError::Storage(format!("Failed to collect chunk_embeddings: {e}")))
    }

    /// Stats: count of chunks by source_type, plus indexed count for the active model.
    pub fn stats(
        &self,
        active_model: &str,
    ) -> Result<ChunkStats, IronMicError> {
        let conn = self.db.conn();
        let mut by_source = Vec::new();
        let mut stmt = conn
            .prepare("SELECT source_type, COUNT(*) FROM chunks GROUP BY source_type")
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare stats: {e}")))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|e| IronMicError::Storage(format!("Failed to query stats: {e}")))?;
        for r in rows {
            by_source.push(r.map_err(|e| IronMicError::Storage(format!("Stats row: {e}")))?);
        }
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM chunks", [], |row| row.get(0))
            .map_err(|e| IronMicError::Storage(format!("Failed to count chunks: {e}")))?;
        let indexed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chunk_embeddings WHERE model_version = ?1",
                [active_model],
                |row| row.get(0),
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to count indexed chunks: {e}")))?;

        Ok((by_source, total, indexed))
    }

    /// Wipe everything — used by Settings → "Reset index". Returns the number
    /// of chunks deleted. Embeddings cascade via FK.
    pub fn delete_all(&self) -> Result<u32, IronMicError> {
        let conn = self.db.conn();
        let count = conn
            .execute("DELETE FROM chunks", [])
            .map_err(|e| IronMicError::Storage(format!("Failed to delete all chunks: {e}")))?;
        Ok(count as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> ChunkStore {
        ChunkStore::new(Database::open_in_memory().unwrap())
    }

    fn sample(idx: i64, text: &str) -> NewChunk {
        NewChunk {
            source_type: source_types::USER_NOTE.into(),
            source_id: "n1".into(),
            chunk_index: idx,
            text: text.into(),
            token_count: Some(text.split_whitespace().count() as i64),
            ..Default::default()
        }
    }

    #[test]
    fn replace_for_source_inserts_in_order() {
        let s = store();
        let inserted = s
            .replace_for_source(
                source_types::USER_NOTE,
                "n1",
                vec![sample(0, "first"), sample(1, "second"), sample(2, "third")],
            )
            .unwrap();
        assert_eq!(inserted.len(), 3);

        let listed = s.list_for_source(source_types::USER_NOTE, "n1").unwrap();
        assert_eq!(listed.iter().map(|c| c.text.as_str()).collect::<Vec<_>>(),
                   vec!["first", "second", "third"]);
    }

    #[test]
    fn replace_for_source_atomically_swaps() {
        let s = store();
        s.replace_for_source(source_types::USER_NOTE, "n1", vec![sample(0, "old1"), sample(1, "old2")]).unwrap();
        s.replace_for_source(source_types::USER_NOTE, "n1", vec![sample(0, "new1")]).unwrap();

        let listed = s.list_for_source(source_types::USER_NOTE, "n1").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].text, "new1");
    }

    #[test]
    fn delete_for_source_only_touches_target() {
        let s = store();
        s.replace_for_source(source_types::USER_NOTE, "n1", vec![sample(0, "keep me")]).unwrap();
        s.replace_for_source(source_types::ENTRY, "e1", vec![NewChunk { source_type: source_types::ENTRY.into(), source_id: "e1".into(), chunk_index: 0, text: "delete me".into(), ..Default::default() }]).unwrap();

        s.delete_for_source(source_types::ENTRY, "e1").unwrap();

        assert_eq!(s.list_for_source(source_types::USER_NOTE, "n1").unwrap().len(), 1);
        assert!(s.list_for_source(source_types::ENTRY, "e1").unwrap().is_empty());
    }

    #[test]
    fn unembedded_excludes_chunks_with_active_model_embedding() {
        let s = store();
        let inserted = s
            .replace_for_source(source_types::USER_NOTE, "n1", vec![sample(0, "a"), sample(1, "b")])
            .unwrap();

        // Both unembedded initially.
        let unemb_initial = s.list_unembedded(10, "bge-small-en-v1.5").unwrap();
        assert_eq!(unemb_initial.len(), 2);

        // Embed one of them.
        let bytes = vec![0u8; 384 * 4];
        s.store_chunk_embeddings_batch(&[(inserted[0].id.clone(), bytes)], "bge-small-en-v1.5", 384)
            .unwrap();

        let unemb_after = s.list_unembedded(10, "bge-small-en-v1.5").unwrap();
        assert_eq!(unemb_after.len(), 1);
        assert_eq!(unemb_after[0].0, inserted[1].id);

        // A different model still sees both as unembedded.
        let unemb_other = s.list_unembedded(10, "use-v1").unwrap();
        assert_eq!(unemb_other.len(), 2);
    }

    #[test]
    fn dim_mismatch_rejected() {
        let s = store();
        let inserted = s
            .replace_for_source(source_types::USER_NOTE, "n1", vec![sample(0, "a")])
            .unwrap();
        let bad = vec![0u8; 100]; // not 384*4
        let err = s
            .store_chunk_embeddings_batch(&[(inserted[0].id.clone(), bad)], "bge-small-en-v1.5", 384)
            .unwrap_err();
        match err {
            IronMicError::Storage(msg) => assert!(msg.contains("dim*4")),
            _ => panic!("expected Storage error"),
        }
    }

    #[test]
    fn stats_reports_total_and_indexed() {
        let s = store();
        let inserted = s
            .replace_for_source(source_types::USER_NOTE, "n1", vec![sample(0, "a"), sample(1, "b")])
            .unwrap();
        // Index one.
        s.store_chunk_embeddings_batch(&[(inserted[0].id.clone(), vec![0u8; 384 * 4])], "bge-small-en-v1.5", 384)
            .unwrap();

        let (by_source, total, indexed) = s.stats("bge-small-en-v1.5").unwrap();
        assert_eq!(total, 2);
        assert_eq!(indexed, 1);
        assert_eq!(by_source.len(), 1);
        assert_eq!(by_source[0].0, "user_note");
        assert_eq!(by_source[0].1, 2);
    }
}
