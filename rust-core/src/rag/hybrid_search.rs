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

    // ── 2.5 Recent-activity fallback ──────────────────────────────────────
    //
    // When both FTS5 and the vector path come up empty — typical for casual
    // natural-language queries that have nothing distinctive to anchor on
    // ("what did I do?", "summarize my notes"), or temporal queries where
    // the keyword "yesterday" doesn't literally appear in any chunk — we
    // fall back to "most recent chunks within the filter window". Better
    // than handing the model a context-less prompt. The retrieved chunks
    // are still scoped by `opts.filters.date_from / date_to / source_types`
    // when present (so "yesterday" + temporal intent + Temporal date filter
    // still narrows to actual yesterday content).
    if fts_hits.is_empty() && vec_hits.is_empty() {
        let recent_sql = build_recent_fallback_sql(&opts.filters, opts.skip_archived);
        if let Ok(mut stmt) = conn.prepare(&recent_sql) {
            // Single bound param: the LIMIT. Rust string-formatted the WHERE
            // clause; user input doesn't reach the SQL bytes (filters come
            // from intent classifier output, escaped where needed).
            let rows = stmt.query_map([opts.k as i64], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            });
            if let Ok(rows) = rows {
                for r in rows.flatten() {
                    // Synthesize a low-but-positive score so RRF still merges
                    // these in rank order behind any (zero) real hits.
                    let (id, created_at) = r;
                    // Score = inverse of position in ORDER BY, normalized down
                    // so a real FTS hit on a future query always outranks
                    // a fallback chunk. Using created_at as a tie-breaker
                    // happens implicitly via the SQL ORDER BY.
                    let _ = created_at;
                    fts_hits.push((id, 0.001));
                }
            }
        }
    }

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

/// Common English stopwords that should be stripped from FTS5 queries.
/// These are conversational noise — "what did I X" / "tell me about Y" —
/// not signal. Keeping them in the query (combined with the old implicit
/// AND join) was the dominant reason retrieval returned 0 hits for
/// natural-language questions: every chunk that didn't happen to contain
/// "what" AND "did" AND "I" was rejected.
const STOPWORDS: &[&str] = &[
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "do", "does", "did", "doing", "have", "has", "had", "having",
    "i", "me", "my", "mine", "we", "us", "our", "you", "your", "yours",
    "he", "she", "it", "they", "them", "their",
    "this", "that", "these", "those",
    "what", "when", "where", "who", "whom", "which", "why", "how",
    "and", "or", "but", "if", "then", "else", "of", "in", "on", "at",
    "to", "from", "by", "for", "with", "about", "as", "than",
    "can", "could", "would", "should", "will", "shall", "may", "might",
    "tell", "show", "give", "find", "search", "look", "say", "said",
    "please", "thanks", "hi", "hello",
];

fn is_stopword(token: &str) -> bool {
    STOPWORDS.binary_search(&token).is_ok()
        // Linear fallback if STOPWORDS isn't sorted (it isn't — we keep it
        // readable rather than alphabetic). Cheap enough at ~70 items.
        || STOPWORDS.iter().any(|w| *w == token)
}

/// FTS5 syntax requires a `MATCH` clause that's valid. User input goes
/// straight into the param so we sanitize by stripping quote chars and
/// double-quoting each whitespace token. The result is an OR-joined
/// tokens match with stopwords removed and a prefix-wildcard on the
/// last real keyword — robust to chat-style natural-language queries.
///
/// We switched from implicit AND to explicit OR after observing that
/// "what did I dictate yesterday" produced zero FTS5 matches because no
/// chunk contained ALL of those words. With OR + stopword strip, that
/// query effectively becomes `"dictate" OR "yesterday*"` which actually
/// hits dictation chunks containing either term.
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
    // Lowercase + filter stopwords + double-quote so FTS5 treats each as
    // a literal term. Drop tokens shorter than 2 chars (typo noise).
    let mut tokens: Vec<String> = cleaned
        .split_whitespace()
        .map(|t| t.trim_end_matches(|c: char| !c.is_alphanumeric()).to_lowercase())
        .filter(|t| !t.is_empty() && t.len() >= 2 && !is_stopword(t))
        .map(|t| format!("\"{t}\""))
        .collect();
    if tokens.is_empty() {
        // After stopword strip we have nothing left — happens for queries
        // like "what did I do?". Caller's recent-activity fallback handles
        // this case: empty FTS query ⇒ empty FTS path ⇒ fallback engages.
        return String::new();
    }
    // Prefix-wildcard the last real keyword so partial typing ("auth"
    // matches "authentication") and trailing-noun typos still hit.
    let last = tokens.last().cloned().unwrap();
    let last_inner = last.trim_matches('"').to_string();
    *tokens.last_mut().unwrap() = format!("{}*", last_inner);
    // Explicit OR join — see the doc comment for why.
    tokens.join(" OR ")
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

    // Date range — applied against EITHER created_at OR updated_at on the
    // parent source row. A note created May 9 but edited May 10 should
    // show up in a "yesterday" query for May 10: matching only on
    // created_at would miss it. Conversely, a note created May 10 but
    // never re-edited should match a May 10 query via created_at. The
    // OR makes the filter inclusive in both directions.
    //
    // Meetings only have started_at; user_notes carries both. The
    // sub-SELECT pattern compiles to the same indexed lookup as a single
    // COALESCE — SQLite re-runs it but the FTS5 MATCH prefilters enough
    // that the per-row JOIN cost is amortized.
    let date_in_range = |bound: &str, op: &str| -> String {
        format!(
            "(COALESCE(\
                (SELECT e.created_at FROM entries e WHERE e.id = c.source_id),\
                (SELECT m.started_at FROM meeting_sessions m WHERE m.id = c.source_id),\
                (SELECT u.created_at FROM user_notes u WHERE u.id = c.source_id)\
             ) {op} '{bound}' \
             OR COALESCE(\
                (SELECT e.updated_at FROM entries e WHERE e.id = c.source_id),\
                (SELECT m.ended_at FROM meeting_sessions m WHERE m.id = c.source_id),\
                (SELECT u.updated_at FROM user_notes u WHERE u.id = c.source_id)\
             ) {op} '{bound}')",
            bound = bound.replace('\'', "''"),
            op = op,
        )
    };
    if let Some(ref from) = filters.date_from {
        where_clauses.push(date_in_range(from, ">="));
    }
    if let Some(ref to) = filters.date_to {
        where_clauses.push(date_in_range(to, "<="));
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

/// Recent-activity fallback SQL. Used when keyword + vector both return
/// no hits — gives the LLM SOMETHING current to ground on instead of a
/// bare prompt. Returns (chunk_id, source_created_at) ordered most-recent
/// first, scoped by the same date / source_type / archive filters as the
/// real retrieval paths so a Temporal intent ("yesterday") still gets
/// yesterday-only content even when no chunk text literally says
/// "yesterday".
fn build_recent_fallback_sql(filters: &IntentFilters, skip_archived: bool) -> String {
    let mut where_clauses: Vec<String> = vec!["1=1".to_string()];
    // For the "ORDER BY recency" we use MAX(created_at, updated_at) so a
    // note edited today appears before one created today but unedited
    // since. For the date-range filter we use OR over both, same as the
    // FTS / vector paths — see build_fts_sql for the rationale.
    let coalesced_max = "COALESCE(\
        (SELECT MAX(e.created_at, e.updated_at) FROM entries e WHERE e.id = c.source_id),\
        (SELECT MAX(m.started_at, COALESCE(m.ended_at, m.started_at)) FROM meeting_sessions m WHERE m.id = c.source_id),\
        (SELECT MAX(u.created_at, u.updated_at) FROM user_notes u WHERE u.id = c.source_id)\
     )";
    let date_in_range = |bound: &str, op: &str| -> String {
        format!(
            "(COALESCE(\
                (SELECT e.created_at FROM entries e WHERE e.id = c.source_id),\
                (SELECT m.started_at FROM meeting_sessions m WHERE m.id = c.source_id),\
                (SELECT u.created_at FROM user_notes u WHERE u.id = c.source_id)\
             ) {op} '{bound}' \
             OR COALESCE(\
                (SELECT e.updated_at FROM entries e WHERE e.id = c.source_id),\
                (SELECT m.ended_at FROM meeting_sessions m WHERE m.id = c.source_id),\
                (SELECT u.updated_at FROM user_notes u WHERE u.id = c.source_id)\
             ) {op} '{bound}')",
            bound = bound.replace('\'', "''"),
            op = op,
        )
    };

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
        where_clauses.push(date_in_range(from, ">="));
    }
    if let Some(ref to) = filters.date_to {
        where_clauses.push(date_in_range(to, "<="));
    }
    if let Some(ref speaker) = filters.speaker {
        where_clauses.push(format!("c.speaker_label = '{}'", speaker.replace('\'', "''")));
    }
    if skip_archived {
        where_clauses.push(
            "NOT EXISTS (SELECT 1 FROM entries e WHERE e.id = c.source_id AND e.is_archived = 1)".to_string()
        );
    }

    format!(
        "SELECT c.id, {coalesced_max} AS most_recent \
         FROM chunks c \
         WHERE {} \
         ORDER BY most_recent DESC NULLS LAST \
         LIMIT ?1",
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
    // Same created_at-OR-updated_at expansion as the FTS5 path — see
    // build_fts_sql for the rationale.
    let date_in_range = |bound: &str, op: &str| -> String {
        format!(
            "(COALESCE(\
                (SELECT e.created_at FROM entries e WHERE e.id = c.source_id),\
                (SELECT m.started_at FROM meeting_sessions m WHERE m.id = c.source_id),\
                (SELECT u.created_at FROM user_notes u WHERE u.id = c.source_id)\
             ) {op} '{bound}' \
             OR COALESCE(\
                (SELECT e.updated_at FROM entries e WHERE e.id = c.source_id),\
                (SELECT m.ended_at FROM meeting_sessions m WHERE m.id = c.source_id),\
                (SELECT u.updated_at FROM user_notes u WHERE u.id = c.source_id)\
             ) {op} '{bound}')",
            bound = bound.replace('\'', "''"),
            op = op,
        )
    };
    if let Some(ref from) = filters.date_from {
        where_clauses.push(date_in_range(from, ">="));
    }
    if let Some(ref to) = filters.date_to {
        where_clauses.push(date_in_range(to, "<="));
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
/// Format an RFC3339 string as "Tue May 5" — falls back to a literal label
/// if parsing fails so we never produce an empty date.
fn short_date_from_rfc(s: Option<&str>, fallback: &str) -> String {
    s.and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
        .map(|dt| dt.format("%a %b %-d").to_string())
        .unwrap_or_else(|| fallback.to_string())
}

/// Parse a user-tags JSON array and pull out a `__notebook__:<id>`
/// row's id portion. Returns None if there's no notebook tag. Used in
/// the entry label to surface "in notebook X".
fn parse_notebook_id_from_tags(tags_json: Option<&str>) -> Option<String> {
    let raw = tags_json?;
    let parsed: Vec<String> = serde_json::from_str(raw).ok()?;
    for t in parsed {
        if let Some(rest) = t.strip_prefix("__notebook__:") {
            if !rest.is_empty() && rest != "default" {
                return Some(rest.to_string());
            }
        }
    }
    None
}

/// Parse a user-tags JSON array and pull out a `__title__:<name>`
/// row. Entries store their user-facing title in tags rather than a
/// dedicated column.
fn parse_title_from_tags(tags_json: Option<&str>) -> Option<String> {
    let raw = tags_json?;
    let parsed: Vec<String> = serde_json::from_str(raw).ok()?;
    for t in parsed {
        if let Some(rest) = t.strip_prefix("__title__:") {
            if !rest.is_empty() {
                return Some(rest.to_string());
            }
        }
    }
    None
}

/// Build the citation label for one retrieved chunk. The label is the
/// human-readable string the LLM sees in the prompt's `[1] <label> —
/// <text>` block AND what the renderer's Sources panel displays.
///
/// Each source-type variant surfaces the metadata the model needs to
/// reason about WHEN and WHERE this chunk came from:
///   - entry: title (from tags) · created date · "edited <date>" iff updated_at differs · notebook
///   - meeting: weekday + date · duration · speaker count · in-meeting timestamp + speaker
///   - user_note: title · heading breadcrumb · "edited <date>" iff updated_at differs
///
/// Anything not present in the source row is silently omitted (no empty
/// "Edited" stubs). The label is bounded to a sensible width so a long
/// notebook title or heading path doesn't blow up the prompt-context block.
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
            // Get meeting metadata: started_at, ended_at, speaker_count.
            // duration is computed locally if the addon hasn't backfilled
            // `total_duration_seconds` for older sessions.
            let row: Option<(Option<String>, Option<String>, Option<i64>)> = conn
                .query_row(
                    "SELECT started_at, ended_at, speaker_count FROM meeting_sessions WHERE id = ?1",
                    [source_id],
                    |row| Ok((row.get(0).ok(), row.get(1).ok(), row.get(2).ok().flatten())),
                )
                .ok();
            let (started_at, ended_at, speaker_count) = row.unwrap_or((None, None, None));
            let date_part = short_date_from_rfc(started_at.as_deref(), "Meeting");
            // Total meeting duration (rough — "53m") if we can compute it.
            let duration_part = match (started_at.as_deref(), ended_at.as_deref()) {
                (Some(s), Some(e)) => {
                    let start = chrono::DateTime::parse_from_rfc3339(s).ok();
                    let end = chrono::DateTime::parse_from_rfc3339(e).ok();
                    match (start, end) {
                        (Some(s), Some(e)) => {
                            let secs = (e - s).num_seconds().max(0);
                            if secs >= 60 { format!(" · {}m", secs / 60) } else { String::new() }
                        }
                        _ => String::new(),
                    }
                }
                _ => String::new(),
            };
            let speakers_part = speaker_count
                .filter(|n| *n > 0)
                .map(|n| format!(" · {n} speakers"))
                .unwrap_or_default();
            // In-meeting timestamp + speaker for the specific chunk.
            let time_part = start_ms
                .map(|ms| format!(" — {}m{:02}s", ms / 60_000, (ms % 60_000) / 1000))
                .unwrap_or_default();
            let speaker_part = speaker_label
                .map(|s| format!(" · {s}"))
                .unwrap_or_default();
            format!("Meeting {date_part}{duration_part}{speakers_part}{time_part}{speaker_part}")
        }
        s if s == st::USER_NOTE => {
            // user_notes-table content: title, created_at, updated_at.
            let row: Option<(Option<String>, Option<String>, Option<String>)> = conn
                .query_row(
                    "SELECT title, created_at, updated_at FROM user_notes WHERE id = ?1",
                    [source_id],
                    |row| Ok((row.get(0).ok().flatten(), row.get(1).ok(), row.get(2).ok().flatten())),
                )
                .ok();
            let (title, created_at, updated_at) = row.unwrap_or((None, None, None));
            let title = title.unwrap_or_else(|| "Note".to_string());
            let heading_tail = heading_path
                .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
                .map(|v| v.into_iter().skip(1).collect::<Vec<_>>().join(" › "))
                .filter(|s| !s.is_empty())
                .map(|s| format!(" › {s}"))
                .unwrap_or_default();
            // "edited" stamp only surfaces when updated_at differs from
            // created_at meaningfully (>= 60s gap). For un-edited notes
            // the bare created date is enough.
            let edited_part = edited_marker(created_at.as_deref(), updated_at.as_deref());
            format!("Note: {title}{heading_tail}{edited_part}")
        }
        s if s == st::ENTRY => {
            // entries-table content (DictatePage notes): we surface
            // (a) the user-set title from tags (entries don't have a dedicated
            //     column for this — title lives in tags as __title__:)
            // (b) the source date — created_at
            // (c) an "edited <date>" marker if updated_at differs
            // (d) the parent notebook id from tags (rendered as #nb so the
            //     model knows the org context)
            let row: Option<(Option<String>, Option<String>, Option<String>)> = conn
                .query_row(
                    "SELECT created_at, updated_at, tags FROM entries WHERE id = ?1",
                    [source_id],
                    |row| Ok((row.get(0).ok(), row.get(1).ok().flatten(), row.get(2).ok().flatten())),
                )
                .ok();
            let (created_at, updated_at, tags_json) = row.unwrap_or((None, None, None));
            let date_part = short_date_from_rfc(created_at.as_deref(), "Note");
            let title_part = parse_title_from_tags(tags_json.as_deref())
                .filter(|t| !t.is_empty())
                .map(|t| format!(": {t}"))
                .unwrap_or_default();
            let edited_part = edited_marker(created_at.as_deref(), updated_at.as_deref());
            let notebook_part = parse_notebook_id_from_tags(tags_json.as_deref())
                .map(|nb| format!(" · in {nb}"))
                .unwrap_or_default();
            format!("Note{title_part} · {date_part}{edited_part}{notebook_part}")
        }
        _ => "Source".to_string(),
    }
}

/// Produce " · edited <date>" iff updated_at is meaningfully later than
/// created_at (>= 60 seconds gap, to ignore the same-transaction write).
/// Returns empty string when not surfaced.
fn edited_marker(created: Option<&str>, updated: Option<&str>) -> String {
    let (Some(c), Some(u)) = (created, updated) else { return String::new(); };
    let c_dt = chrono::DateTime::parse_from_rfc3339(c).ok();
    let u_dt = chrono::DateTime::parse_from_rfc3339(u).ok();
    let (Some(c_dt), Some(u_dt)) = (c_dt, u_dt) else { return String::new(); };
    let gap = (u_dt - c_dt).num_seconds();
    if gap < 60 { return String::new(); }
    format!(" · edited {}", u_dt.format("%a %b %-d"))
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
    fn sanitize_fts_query_strips_stopwords_and_uses_or() {
        // Single keyword: prefix-wildcard, no OR separator needed.
        assert_eq!(sanitize_fts_query("auth"), "auth*");
        // Stopwords ("what", "did", "i") get dropped; "dictate" and
        // "yesterday" survive; OR joins them. "yesterday" is last so it
        // gets the prefix wildcard.
        let q = sanitize_fts_query("what did I dictate yesterday");
        assert!(q.contains("dictate"), "expected 'dictate' in: {q}");
        assert!(q.contains("yesterday"), "expected 'yesterday' in: {q}");
        assert!(q.contains(" OR "), "expected OR-joined query, got: {q}");
        // All-stopword input collapses to empty so the recent-activity
        // fallback engages downstream.
        assert_eq!(sanitize_fts_query("what did I do?"), "");
        // Pure whitespace stays empty.
        assert_eq!(sanitize_fts_query("   "), "");
        // Short tokens (< 2 chars) get filtered as typo noise.
        let q2 = sanitize_fts_query("a b authentication");
        assert!(q2.contains("authentication"));
        assert!(!q2.contains("\"a\""));
        assert!(!q2.contains("\"b\""));
    }

    #[test]
    fn empty_query_falls_back_to_recent_activity_not_error() {
        // Contract change: an effectively-empty query (whitespace, or only
        // stopwords) used to return zero hits. With the recent-activity
        // fallback it now surfaces the user's most recent content —
        // strictly better UX for chat-style natural-language queries that
        // don't have keyword anchors. Empty corpus would still return zero.
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
        // Hits come from the fallback path, NOT the FTS path.
        assert_eq!(result.fts_count, 0);
        assert_eq!(result.vector_count, 0);
        assert!(result.hits.len() >= 1, "fallback should surface recent content");
    }

    #[test]
    fn empty_corpus_returns_zero_hits() {
        // The fallback can only surface content that actually exists. With
        // no seeded chunks the result is still empty — the orchestrator's
        // "no context found" branch is what handles this UX-side.
        let db = setup();
        let opts = RetrieveOptions {
            model_version: "bge-small-en-v1.5".into(),
            k: 10,
            filters: IntentFilters::default(),
            skip_archived: true,
        };
        let result = retrieve(&db, "anything", &[], &opts).unwrap();
        assert_eq!(result.hits.len(), 0);
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
    fn fallback_returns_recent_chunks_when_keyword_misses() {
        // Seed two notes with non-overlapping content, then query for
        // something that doesn't literally appear in either. With the
        // old AND-join + no fallback we'd return zero hits; now the
        // recent-activity fallback should surface both notes ordered
        // by their parent's created_at descending.
        let db = setup();
        seed_user_note(&db, "n1", "Lunch");
        seed_chunks(&db, "n1", vec!["tacos and pizza"]);
        seed_user_note(&db, "n2", "Coffee");
        seed_chunks(&db, "n2", vec!["espresso double shot"]);

        let opts = RetrieveOptions {
            model_version: "bge-small-en-v1.5".into(),
            k: 10,
            filters: IntentFilters::default(),
            skip_archived: true,
        };
        // "yesterday" is a stopword-free keyword that won't match either
        // chunk literally — the fallback should still surface them.
        let result = retrieve(&db, "yesterday", &[], &opts).unwrap();
        assert!(result.hits.len() >= 1,
                "expected fallback to surface at least one chunk when keyword misses, got {}",
                result.hits.len());
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
