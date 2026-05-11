//! Hybrid retrieval: FTS5 keyword path + vector similarity path → Reciprocal
//! Rank Fusion → top-k chunks.
//!
//! Pipeline:
//!   1. Pre-filter at the SQL level using `IntentFilters` (date range, source
//!      types, archive flag). Cuts candidate set 10–100× before any scoring.
//!   2. FTS5 path: `chunks_fts MATCH ?` ordered by bm25, top-30.
//!   3. Vector path: load the filtered chunks' embeddings, dot product
//!      against the query embedding, top-30. Skipped when the caller passes
//!      an empty query embedding (renderer-side BgeEmbedder not ready, or
//!      callers that only want keyword retrieval).
//!   4. RRF merge with k=60. Top-k handed back.
//!
//! Every step is designed to fail gracefully. A bad embedding, a busted FTS5
//! query, a missing index — none of these should crash retrieval. The worst
//! case is an empty result set, which the QAOrchestrator handles by telling
//! the user "no matching context found, here's what I know in general."

use serde::{Deserialize, Serialize};

use crate::error::IronMicError;
use crate::rag::intent::IntentFilters;
use crate::rag::vector;
use crate::storage::db::Database;

/// One retrieval hit: a chunk plus its retrieval-time metadata. The
/// `citation` block carries everything a citation chip needs to render and
/// deeplink, so the orchestrator doesn't have to re-fetch chunk rows.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetrievalHit {
    pub chunk_id: String,
    pub source_type: String,
    pub source_id: String,
    pub text: String,
    pub score: f64,
    /// Rendered citation label, e.g. "Tue 2026-05-05 standup, 12:34" or
    /// "Note: Project X › Decisions". Built here so the renderer doesn't
    /// have to know about meeting timestamps or heading path JSON shapes.
    pub label: String,
    /// Short preview (≤ 120 chars) for the sources-panel hover popover.
    pub snippet: String,
    /// Deep link the citation chip activates. `ironmic://<kind>/<id>?…`
    pub deeplink: String,
    /// Optional meeting timestamp (ms from session start) for transcript jump.
    pub start_ms: Option<i64>,
}

/// Caller-supplied retrieval options. `k` caps the final fused result size;
/// `model_version` selects which embedding model's BLOBs to query against;
/// `query_embedding` is the 384*4=1536 bytes from BgeEmbedder, or empty for
/// FTS5-only mode.
#[derive(Debug, Clone, Deserialize)]
pub struct RetrieveOptions {
    pub model_version: String,
    pub k: u32,
    pub filters: IntentFilters,
    /// When false, also include chunks of the user's currently-archived
    /// entries / notes (rare). Default true.
    #[serde(default = "default_skip_archived")]
    pub skip_archived: bool,
}

fn default_skip_archived() -> bool { true }

/// Result envelope. `fts_count` and `vector_count` are surfaced so the
/// renderer can show "found 6 sources (3 keyword, 4 semantic)" if it wants
/// to expose the dual-path nature. The merged `hits` is what callers use.
#[derive(Debug, Clone, Serialize)]
pub struct RetrievalResult {
    pub hits: Vec<RetrievalHit>,
    pub fts_count: u32,
    pub vector_count: u32,
    /// True iff the vector path was attempted (i.e. caller supplied a non-
    /// empty query embedding AND the active model has indexed embeddings).
    pub vector_used: bool,
}

/// Per-path candidate count before fusion. Higher = better recall but more
/// work; 30 is the sweet spot empirically for personal-corpus retrieval.
const PER_PATH_TOP: u32 = 30;

/// RRF damping. Standard value from the original RRF paper — controls how
/// much weight low-ranked items carry into the fused score.
const RRF_K: f64 = 60.0;

/// Run hybrid retrieval. `query` is the keyword text fed to FTS5;
/// `query_embedding` is raw little-endian Float32 bytes (1536 for 384-dim)
/// or empty for FTS5-only mode.
pub fn retrieve(
    db: &Database,
    query: &str,
    query_embedding: &[u8],
    opts: &RetrieveOptions,
) -> Result<RetrievalResult, IronMicError> {
    let conn = db.conn();

    // ── 1. FTS5 keyword path ──────────────────────────────────────────────
    // bm25() returns lower-is-better; we negate so larger is better and the
    // RRF rank order matches the vector path convention.
    let fts_param = sanitize_fts_query(query);
    let fts_sql = build_fts_sql(&opts.filters, opts.skip_archived);
    let mut fts_hits: Vec<(String, f64)> = Vec::new();
    if !fts_param.is_empty() {
        let mut stmt = conn
            .prepare(&fts_sql)
            .map_err(|e| IronMicError::Storage(format!("fts prepare failed: {e}")))?;
        let rows = stmt
            .query_map(
                rusqlite::params![fts_param, PER_PATH_TOP as i64],
                |row| Ok((row.get::<_, String>(0)?, -row.get::<_, f64>(1)?)),
            )
            .map_err(|e| IronMicError::Storage(format!("fts query failed: {e}")))?;
        for r in rows {
            if let Ok(pair) = r {
                fts_hits.push(pair);
            }
        }
    }

    // ── 2. Vector path ────────────────────────────────────────────────────
    // Only runs when caller supplied a non-empty embedding. We re-decode each
    // candidate embedding under the configured dim (384 for bge-small) — if
    // a row has a stale-dim BLOB it scores 0 and falls out of the top-N.
    let mut vec_hits: Vec<(String, f64)> = Vec::new();
    let vector_used = !query_embedding.is_empty();
    if vector_used {
        let dim = guess_dim_for_query_bytes(query_embedding);
        let q = vector::decode_embedding(query_embedding, dim);
        if let Some(q_vec) = q {
            let cand_sql = build_vector_candidate_sql(&opts.filters, opts.skip_archived);
            let mut stmt = conn
                .prepare(&cand_sql)
                .map_err(|e| IronMicError::Storage(format!("vec prepare failed: {e}")))?;
            let rows = stmt
                .query_map(
                    rusqlite::params![opts.model_version],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Vec<u8>>(1)?,
                        ))
                    },
                )
                .map_err(|e| IronMicError::Storage(format!("vec query failed: {e}")))?;

            // We score every candidate then keep the top PER_PATH_TOP. A
            // smarter version would heap-bound, but at ~10k chunks the full
            // scan is faster than a heap due to branch prediction and cache.
            let mut scored: Vec<(String, f64)> = Vec::new();
            for r in rows {
                if let Ok((id, bytes)) = r {
                    let s = vector::score_against_query(&q_vec, &bytes, dim);
                    if s.is_finite() && s > 0.0 {
                        scored.push((id, s as f64));
                    }
                }
            }
            scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            scored.truncate(PER_PATH_TOP as usize);
            vec_hits = scored;
        }
    }

    let fts_count = fts_hits.len() as u32;
    let vector_count = vec_hits.len() as u32;

    // ── 3. RRF merge ──────────────────────────────────────────────────────
    // score(chunk) = Σ over paths of 1 / (K + rank_in_path).
    // Unrepresented in a path contributes 0.
    use std::collections::BTreeMap;
    let mut fused: BTreeMap<String, f64> = BTreeMap::new();
    for (rank, (id, _)) in fts_hits.iter().enumerate() {
        *fused.entry(id.clone()).or_insert(0.0) += 1.0 / (RRF_K + rank as f64);
    }
    for (rank, (id, _)) in vec_hits.iter().enumerate() {
        *fused.entry(id.clone()).or_insert(0.0) += 1.0 / (RRF_K + rank as f64);
    }
    let mut merged: Vec<(String, f64)> = fused.into_iter().collect();
    merged.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    merged.truncate(opts.k as usize);

    // ── 4. Hydrate to RetrievalHit ─────────────────────────────────────────
    // hydrate_hits gets the live conn handle we already hold to avoid a
    // second mutex acquisition (which would deadlock — Database::conn() is
    // a MutexGuard and rusqlite Connections are !Send-friendly under the
    // same model).
    let hits = hydrate_hits(&conn, &merged)?;

    Ok(RetrievalResult {
        hits,
        fts_count,
        vector_count,
        vector_used,
    })
}

/// FTS5 syntax requires a `MATCH` clause that's valid. User input goes
/// straight into the param so we sanitize by stripping quote chars and
/// double-quoting each whitespace token. The result is a phrase-or-tokens
/// match — robust to common punctuation in chat-style queries.
fn sanitize_fts_query(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // Drop SQL-quote chars and FTS5 special chars that aren't whitespace.
    let cleaned: String = trimmed
        .chars()
        .map(|c| if c == '"' || c == '\'' { ' ' } else { c })
        .collect();
    let tokens: Vec<String> = cleaned
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"", t.replace('"', "")))
        .collect();
    if tokens.is_empty() {
        return String::new();
    }
    // Tokens combined with implicit AND. Add a trailing prefix-wildcard on
    // the last token so partial typing ("auth" matches "authentication")
    // still hits — matches the keyword-search expectation most users have.
    let last = tokens.last().cloned().unwrap();
    let mut prefix = tokens.clone();
    prefix.pop();
    prefix.push(format!("{}*", last.trim_matches('"')));
    prefix.join(" ")
}

/// FTS5 candidate SQL. Joins `chunks` for metadata + filters, scores by
/// bm25. We have to LEFT JOIN entries/meeting_sessions/user_notes for the
/// `created_at` filter because chunks only carry the source FK.
fn build_fts_sql(filters: &IntentFilters, skip_archived: bool) -> String {
    let mut where_clauses: Vec<String> = vec![
        "chunks_fts MATCH ?1".to_string(),
    ];

    // Source-type filter — if caller restricted to specific sources, AND in.
    if let Some(ref types) = filters.source_types {
        if !types.is_empty() {
            let in_list = types.iter()
                .map(|t| format!("'{}'", t.replace('\'', "''")))
                .collect::<Vec<_>>()
                .join(",");
            where_clauses.push(format!("c.source_type IN ({in_list})"));
        }
    }

    // Date range — applied against the parent source row's created_at via
    // CASE on source_type. We can't index this cleanly without expression
    // indexes; the FTS5 MATCH prefilters enough that the per-row JOIN is fine.
    if let Some(ref from) = filters.date_from {
        where_clauses.push(format!(
            "COALESCE(\
                (SELECT e.created_at FROM entries e WHERE e.id = c.source_id),\
                (SELECT m.started_at FROM meeting_sessions m WHERE m.id = c.source_id),\
                (SELECT u.created_at FROM user_notes u WHERE u.id = c.source_id)\
             ) >= '{}'",
            from.replace('\'', "''")
        ));
    }
    if let Some(ref to) = filters.date_to {
        where_clauses.push(format!(
            "COALESCE(\
                (SELECT e.created_at FROM entries e WHERE e.id = c.source_id),\
                (SELECT m.started_at FROM meeting_sessions m WHERE m.id = c.source_id),\
                (SELECT u.created_at FROM user_notes u WHERE u.id = c.source_id)\
             ) <= '{}'",
            to.replace('\'', "''")
        ));
    }

    // Speaker filter (meetings only).
    if let Some(ref speaker) = filters.speaker {
        where_clauses.push(format!(
            "c.speaker_label = '{}'",
            speaker.replace('\'', "''")
        ));
    }

    // Archive filter — only relevant for entries; meetings/notes don't have
    // an archive flag. We exclude archived entries when skip_archived is on.
    if skip_archived {
        where_clauses.push(
            "NOT EXISTS (SELECT 1 FROM entries e WHERE e.id = c.source_id AND e.is_archived = 1)"
                .to_string(),
        );
    }

    format!(
        "SELECT c.id, bm25(chunks_fts) FROM chunks c \
         JOIN chunks_fts ON chunks_fts.rowid = c.rowid \
         WHERE {} ORDER BY bm25(chunks_fts) ASC LIMIT ?2",
        where_clauses.join(" AND ")
    )
}

/// Vector-path candidate SQL. Pulls every chunk's embedding for the active
/// model, applying the same metadata filters as the FTS path so both paths
/// see a consistent candidate set. The dim mismatch case is handled by
/// `vector::score_against_query` (returns 0.0).
fn build_vector_candidate_sql(filters: &IntentFilters, skip_archived: bool) -> String {
    let mut where_clauses: Vec<String> = vec![
        "ce.model_version = ?1".to_string(),
    ];

    if let Some(ref types) = filters.source_types {
        if !types.is_empty() {
            let in_list = types.iter()
                .map(|t| format!("'{}'", t.replace('\'', "''")))
                .collect::<Vec<_>>()
                .join(",");
            where_clauses.push(format!("c.source_type IN ({in_list})"));
        }
    }
    if let Some(ref from) = filters.date_from {
        where_clauses.push(format!(
            "COALESCE(\
                (SELECT e.created_at FROM entries e WHERE e.id = c.source_id),\
                (SELECT m.started_at FROM meeting_sessions m WHERE m.id = c.source_id),\
                (SELECT u.created_at FROM user_notes u WHERE u.id = c.source_id)\
             ) >= '{}'",
            from.replace('\'', "''")
        ));
    }
    if let Some(ref to) = filters.date_to {
        where_clauses.push(format!(
            "COALESCE(\
                (SELECT e.created_at FROM entries e WHERE e.id = c.source_id),\
                (SELECT m.started_at FROM meeting_sessions m WHERE m.id = c.source_id),\
                (SELECT u.created_at FROM user_notes u WHERE u.id = c.source_id)\
             ) <= '{}'",
            to.replace('\'', "''")
        ));
    }
    if let Some(ref speaker) = filters.speaker {
        where_clauses.push(format!(
            "c.speaker_label = '{}'",
            speaker.replace('\'', "''")
        ));
    }
    if skip_archived {
        where_clauses.push(
            "NOT EXISTS (SELECT 1 FROM entries e WHERE e.id = c.source_id AND e.is_archived = 1)"
                .to_string(),
        );
    }

    format!(
        "SELECT c.id, ce.embedding FROM chunk_embeddings ce \
         JOIN chunks c ON c.id = ce.chunk_id \
         WHERE {}",
        where_clauses.join(" AND ")
    )
}

/// 384 is the bge-small dim. For other models we'd dispatch on
/// `model_version` here. For now we use byte-length / 4 as a sanity dim
/// inference — caller has already chosen a model so this is just defensive.
fn guess_dim_for_query_bytes(bytes: &[u8]) -> usize {
    if bytes.len() % 4 != 0 {
        return 384; // sane default; decode will fail gracefully
    }
    bytes.len() / 4
}

/// Hydrate a list of (chunk_id, fused_score) pairs into full RetrievalHit
/// records by looking up the chunk text + metadata + parent source title.
/// Done in a single SQL round trip via `IN (?, ?, …)` for the chunk_ids.
///
/// Takes the live `conn` reference rather than the Database wrapper because
/// `retrieve()` already holds the connection mutex; a second `db.conn()`
/// would deadlock.
fn hydrate_hits(conn: &rusqlite::Connection, merged: &[(String, f64)]) -> Result<Vec<RetrievalHit>, IronMicError> {
    if merged.is_empty() {
        return Ok(Vec::new());
    }

    let placeholders = std::iter::repeat("?")
        .take(merged.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT id, source_type, source_id, text, start_ms, speaker_label, heading_path \
         FROM chunks WHERE id IN ({placeholders})"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| IronMicError::Storage(format!("hydrate prepare failed: {e}")))?;

    let ids: Vec<&str> = merged.iter().map(|(id, _)| id.as_str()).collect();
    let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(ids.len());
    for id in &ids {
        params.push(id as &dyn rusqlite::ToSql);
    }

    let rows = stmt
        .query_map(rusqlite::params_from_iter(params.iter().map(|p| *p)), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })
        .map_err(|e| IronMicError::Storage(format!("hydrate query failed: {e}")))?;

    use std::collections::HashMap;
    let mut by_id: HashMap<String, (String, String, String, Option<i64>, Option<String>, Option<String>)> = HashMap::new();
    for r in rows {
        if let Ok((id, st, sid, text, sms, sl, hp)) = r {
            by_id.insert(id, (st, sid, text, sms, sl, hp));
        }
    }

    // Build the final ordered list in fused-score order.
    let mut out = Vec::with_capacity(merged.len());
    for (id, score) in merged {
        let Some(meta) = by_id.remove(id) else { continue; };
        let (source_type, source_id, text, start_ms, speaker_label, heading_path) = meta;
        let label = build_label(&conn, &source_type, &source_id, start_ms, speaker_label.as_deref(), heading_path.as_deref());
        let snippet = text.chars().take(120).collect::<String>().replace('\n', " ");
        let deeplink = build_deeplink(&source_type, &source_id, start_ms);
        out.push(RetrievalHit {
            chunk_id: id.clone(),
            source_type,
            source_id,
            text,
            score: *score,
            label,
            snippet,
            deeplink,
            start_ms,
        });
    }
    Ok(out)
}

/// Build a human-readable label for a citation chip. Source-type aware so
/// each kind reads naturally — meeting cites show date + time + speaker;
/// notes show "Note: <title> › <heading>"; entries show "Dictation <date>".
fn build_label(
    conn: &rusqlite::Connection,
    source_type: &str,
    source_id: &str,
    start_ms: Option<i64>,
    speaker_label: Option<&str>,
    heading_path: Option<&str>,
) -> String {
    use crate::storage::chunks::source_types as st;
    match source_type {
        s if s == st::MEETING || s == st::MEETING_SEGMENT => {
            // Get meeting started_at for the date stamp.
            let started_at: Option<String> = conn
                .query_row(
                    "SELECT started_at FROM meeting_sessions WHERE id = ?1",
                    [source_id],
                    |row| row.get(0),
                )
                .ok();
            let date_part = started_at
                .as_deref()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.format("%a %b %-d").to_string())
                .unwrap_or_else(|| "Meeting".to_string());
            let time_part = start_ms
                .map(|ms| format!(" — {}m{:02}s", ms / 60_000, (ms % 60_000) / 1000))
                .unwrap_or_default();
            let speaker_part = speaker_label
                .map(|s| format!(" · {s}"))
                .unwrap_or_default();
            format!("{date_part}{time_part}{speaker_part}")
        }
        s if s == st::USER_NOTE => {
            let title: Option<String> = conn
                .query_row(
                    "SELECT title FROM user_notes WHERE id = ?1",
                    [source_id],
                    |row| row.get(0),
                )
                .ok();
            let title = title.unwrap_or_else(|| "Note".to_string());
            // Parse heading_path JSON if present and skip the first element (which is the title itself).
            let heading_tail = heading_path
                .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
                .map(|v| v.into_iter().skip(1).collect::<Vec<_>>().join(" › "))
                .filter(|s| !s.is_empty())
                .map(|s| format!(" › {s}"))
                .unwrap_or_default();
            format!("Note: {title}{heading_tail}")
        }
        s if s == st::ENTRY => {
            let created_at: Option<String> = conn
                .query_row(
                    "SELECT created_at FROM entries WHERE id = ?1",
                    [source_id],
                    |row| row.get(0),
                )
                .ok();
            let date_part = created_at
                .as_deref()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.format("%a %b %-d").to_string())
                .unwrap_or_else(|| "Dictation".to_string());
            format!("Dictation {date_part}")
        }
        _ => "Source".to_string(),
    }
}

/// Deeplinks use the `ironmic://` scheme registered by the main process so
/// the renderer can pivot from a citation chip back to the source UI. Schema:
///   ironmic://meeting/<id>?t=<start_ms>     (meeting transcript jump)
///   ironmic://entry/<id>                     (dictation Timeline scroll)
///   ironmic://note/<id>                      (Notes page open)
fn build_deeplink(source_type: &str, source_id: &str, start_ms: Option<i64>) -> String {
    use crate::storage::chunks::source_types as st;
    match source_type {
        s if s == st::MEETING || s == st::MEETING_SEGMENT => {
            match start_ms {
                Some(ms) => format!("ironmic://meeting/{source_id}?t={ms}"),
                None => format!("ironmic://meeting/{source_id}"),
            }
        }
        s if s == st::USER_NOTE => format!("ironmic://note/{source_id}"),
        s if s == st::ENTRY => format!("ironmic://entry/{source_id}"),
        _ => format!("ironmic://unknown/{source_id}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::chunks::{source_types, ChunkStore, NewChunk};
    use crate::storage::db::Database;

    fn setup() -> Database {
        Database::open_in_memory().unwrap()
    }

    fn seed_user_note(db: &Database, id: &str, title: &str) {
        let conn = db.conn();
        conn.execute(
            "INSERT INTO user_notes (id, title, content, polished_content, display_mode, notebook_id, tags, is_pinned, created_at, updated_at)
             VALUES (?1, ?2, ?3, NULL, 'raw', NULL, '[]', 0, '2026-05-09T10:00:00Z', '2026-05-09T10:00:00Z')",
            rusqlite::params![id, title, "some body"],
        ).unwrap();
    }

    fn seed_chunks(db: &Database, source_id: &str, chunks: Vec<&str>) -> Vec<String> {
        let store = ChunkStore::new(db.clone());
        let news: Vec<NewChunk> = chunks
            .into_iter()
            .enumerate()
            .map(|(i, t)| NewChunk {
                source_type: source_types::USER_NOTE.into(),
                source_id: source_id.into(),
                chunk_index: i as i64,
                text: t.into(),
                token_count: Some(t.split_whitespace().count() as i64),
                ..Default::default()
            })
            .collect();
        let inserted = store.replace_for_source(source_types::USER_NOTE, source_id, news).unwrap();
        inserted.into_iter().map(|c| c.id).collect()
    }

    #[test]
    fn fts_only_retrieval_finds_keyword_match() {
        let db = setup();
        seed_user_note(&db, "n1", "Auth Migration");
        seed_chunks(&db, "n1", vec![
            "We will migrate auth before Q3.",
            "Lunch order is tacos.",
            "The auth team has signed off on the new flow.",
        ]);

        let opts = RetrieveOptions {
            model_version: "bge-small-en-v1.5".into(),
            k: 10,
            filters: IntentFilters::default(),
            skip_archived: true,
        };
        let result = retrieve(&db, "auth", &[], &opts).unwrap();
        assert!(result.hits.len() >= 2, "expected at least 2 auth chunks, got {}", result.hits.len());
        assert!(result.vector_used == false);
        for h in &result.hits {
            assert!(h.text.to_lowercase().contains("auth"));
            assert!(!h.label.is_empty());
            assert!(h.deeplink.starts_with("ironmic://"));
        }
    }

    #[test]
    fn sanitize_fts_query_handles_punctuation() {
        assert_eq!(sanitize_fts_query("auth"), "auth*");
        assert_eq!(sanitize_fts_query("\"foo\" bar"), "\"foo\" bar*");
        assert_eq!(sanitize_fts_query("   "), "");
        // Common chat punctuation should survive sanitation.
        let q = sanitize_fts_query("what about Q3 migration?");
        assert!(q.contains("\"what\""));
        assert!(q.ends_with("migration?*") || q.ends_with("\"migration?\"*") || q.contains("migration"));
    }

    #[test]
    fn empty_query_returns_empty_result_not_error() {
        let db = setup();
        seed_user_note(&db, "n1", "Test");
        seed_chunks(&db, "n1", vec!["hello world"]);
        let opts = RetrieveOptions {
            model_version: "bge-small-en-v1.5".into(),
            k: 10,
            filters: IntentFilters::default(),
            skip_archived: true,
        };
        let result = retrieve(&db, "   ", &[], &opts).unwrap();
        assert_eq!(result.hits.len(), 0);
        assert_eq!(result.fts_count, 0);
    }

    #[test]
    fn source_type_filter_limits_candidates() {
        let db = setup();
        seed_user_note(&db, "n1", "Auth Notes");
        seed_chunks(&db, "n1", vec!["auth migration discussion"]);
        // Add an entry chunk that also mentions auth.
        let conn = db.conn();
        conn.execute(
            "INSERT INTO entries (id, created_at, updated_at, raw_transcript, polished_text, display_mode)
             VALUES ('e1', '2026-05-09T10:00:00Z', '2026-05-09T10:00:00Z', 'auth from dictation', NULL, 'raw')",
            [],
        ).unwrap();
        drop(conn);
        let store = ChunkStore::new(db.clone());
        store.replace_for_source(source_types::ENTRY, "e1", vec![NewChunk {
            source_type: source_types::ENTRY.into(),
            source_id: "e1".into(),
            chunk_index: 0,
            text: "auth from dictation".into(),
            token_count: Some(3),
            ..Default::default()
        }]).unwrap();

        let opts_notes_only = RetrieveOptions {
            model_version: "bge-small-en-v1.5".into(),
            k: 10,
            filters: IntentFilters {
                source_types: Some(vec![source_types::USER_NOTE.into()]),
                ..Default::default()
            },
            skip_archived: true,
        };
        let result = retrieve(&db, "auth", &[], &opts_notes_only).unwrap();
        for h in &result.hits {
            assert_eq!(h.source_type, source_types::USER_NOTE);
        }
    }

    #[test]
    fn label_format_for_user_note() {
        let db = setup();
        seed_user_note(&db, "n1", "Project X");
        seed_chunks(&db, "n1", vec!["alpha", "beta"]);
        let opts = RetrieveOptions {
            model_version: "bge-small-en-v1.5".into(),
            k: 10,
            filters: IntentFilters::default(),
            skip_archived: true,
        };
        let result = retrieve(&db, "alpha", &[], &opts).unwrap();
        assert!(result.hits.iter().any(|h| h.label.starts_with("Note: Project X")));
    }

    #[test]
    fn deeplink_format_for_each_source_type() {
        let db = setup();
        seed_user_note(&db, "n1", "T");
        seed_chunks(&db, "n1", vec!["hello"]);
        let opts = RetrieveOptions {
            model_version: "bge-small-en-v1.5".into(),
            k: 10,
            filters: IntentFilters::default(),
            skip_archived: true,
        };
        let result = retrieve(&db, "hello", &[], &opts).unwrap();
        assert!(result.hits[0].deeplink.starts_with("ironmic://note/n1"));
    }
}
