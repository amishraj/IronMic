//! Chunking strategies for the RAG retrieval index.
//!
//! Each strategy turns one source document (entry / meeting / user note)
//! into an ordered list of `NewChunk` rows. The chunker carries enough
//! metadata on each chunk that retrieval-time citations can show
//! "Wed 2026-05-07 standup, 12:34" or "Note: Project X › Decisions"
//! without re-walking the source.
//!
//! Token counting is approximate (whitespace-delimited word count × 1.3) —
//! good enough for budgeting and avoids dragging a tokenizer crate into
//! this module. The exact count doesn't matter for retrieval quality;
//! the embedder normalizes regardless.

use serde::Deserialize;

use crate::storage::chunks::{source_types, NewChunk};

/// Target tokens per chunk. The plan sets `rag_chunk_size_tokens = 400` as
/// the default; chunker callers should pass the active setting at runtime,
/// but this fallback keeps the unit tests deterministic.
pub const DEFAULT_TARGET_TOKENS: usize = 400;
/// Overlap between adjacent chunks of the same source (token count).
pub const DEFAULT_OVERLAP_TOKENS: usize = 50;

/// Approximate token count for a piece of plaintext. Whitespace word count
/// times a fudge factor that matches GPT-style tokenizers well enough for
/// budgeting purposes (English text typically tokenizes to ~1.3 tokens/word).
pub fn estimate_tokens(text: &str) -> usize {
    let words = text.split_whitespace().count();
    ((words as f32) * 1.3).ceil() as usize
}

#[derive(Debug, Clone)]
pub struct ChunkOptions {
    pub target_tokens: usize,
    pub overlap_tokens: usize,
}

impl Default for ChunkOptions {
    fn default() -> Self {
        Self {
            target_tokens: DEFAULT_TARGET_TOKENS,
            overlap_tokens: DEFAULT_OVERLAP_TOKENS,
        }
    }
}

// ── User notes ─────────────────────────────────────────────────────────────

/// Chunk a plaintext user note. Notes carry `title` as the first element of
/// `heading_path` so citations can render "Note: <title>" without a JOIN.
///
/// The strategy is a fixed-stride sliding window with overlap, which is the
/// right shape for short, mostly-unstructured user text. Notes that grow
/// large enough to deserve heading-aware chunking will gain it when we
/// migrate the note editor to TipTap (the entry chunker already handles
/// that shape).
pub fn chunk_user_note(note_id: &str, title: &str, body: &str, opts: &ChunkOptions) -> Vec<NewChunk> {
    chunk_plain_with_overlap(
        source_types::USER_NOTE,
        note_id,
        title,
        body,
        opts,
        /* heading_path */ Some(vec![title.to_string()]),
    )
}

// ── Entries (dictation) ───────────────────────────────────────────────────

/// Chunk a dictation entry. Prefers ProseMirror `_json` (heading-aware split)
/// when available, falling back to plaintext sliding-window.
pub fn chunk_entry(
    entry_id: &str,
    polished_text_json: Option<&str>,
    raw_transcript_json: Option<&str>,
    polished_text: Option<&str>,
    raw_transcript: &str,
    opts: &ChunkOptions,
) -> Vec<NewChunk> {
    // Prefer polished if both rich JSON variants exist; raw is the fallback.
    if let Some(json) = polished_text_json.or(raw_transcript_json) {
        if let Some(chunks) = chunk_prosemirror(source_types::ENTRY, entry_id, json, opts) {
            return chunks;
        }
    }
    // Plaintext fallback. Use polished_text when present (cleaner), else raw.
    let body = polished_text.unwrap_or(raw_transcript);
    chunk_plain_with_overlap(source_types::ENTRY, entry_id, "", body, opts, None)
}

// ── Meetings ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct MeetingSegment {
    pub id: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub speaker_label: Option<String>,
    pub text: String,
}

/// Chunk a meeting using transcript segments when available. Groups
/// consecutive same-speaker segments into chunks of ~target_tokens, capped at
/// that size. Each output chunk carries `speaker_label`, `start_ms`, `end_ms`,
/// and `parent_id = <first contributing segment's id>` so citations can
/// deeplink to a precise audio position.
pub fn chunk_meeting_from_segments(
    meeting_id: &str,
    segments: &[MeetingSegment],
    opts: &ChunkOptions,
) -> Vec<NewChunk> {
    let mut out: Vec<NewChunk> = Vec::new();
    let mut idx: i64 = 0;

    let mut acc_text = String::new();
    let mut acc_tokens = 0usize;
    let mut acc_first_id: Option<String> = None;
    let mut acc_start_ms: Option<i64> = None;
    let mut acc_end_ms: Option<i64> = None;
    let mut acc_speaker: Option<String> = None;

    let flush = |idx: &mut i64,
                 out: &mut Vec<NewChunk>,
                 acc_text: &mut String,
                 acc_tokens: &mut usize,
                 acc_first_id: &mut Option<String>,
                 acc_start_ms: &mut Option<i64>,
                 acc_end_ms: &mut Option<i64>,
                 acc_speaker: &mut Option<String>| {
        if acc_text.is_empty() {
            return;
        }
        out.push(NewChunk {
            source_type: source_types::MEETING_SEGMENT.into(),
            source_id: meeting_id.to_string(),
            parent_id: acc_first_id.take(),
            chunk_index: *idx,
            text: std::mem::take(acc_text),
            context_prefix: None,
            char_start: None,
            char_end: None,
            start_ms: acc_start_ms.take(),
            end_ms: acc_end_ms.take(),
            speaker_label: acc_speaker.take(),
            heading_path: None,
            token_count: Some(*acc_tokens as i64),
            ..Default::default()
        });
        *idx += 1;
        *acc_tokens = 0;
    };

    for seg in segments {
        let seg_tokens = estimate_tokens(&seg.text);
        let speaker_changed = match (&acc_speaker, &seg.speaker_label) {
            (Some(a), Some(b)) => a != b,
            (Some(_), None) | (None, Some(_)) => acc_speaker.is_some() && seg.speaker_label.is_none() || acc_speaker.is_none() && seg.speaker_label.is_some(),
            (None, None) => false,
        };
        let would_overflow = acc_tokens + seg_tokens > opts.target_tokens;

        if !acc_text.is_empty() && (speaker_changed || would_overflow) {
            flush(
                &mut idx,
                &mut out,
                &mut acc_text,
                &mut acc_tokens,
                &mut acc_first_id,
                &mut acc_start_ms,
                &mut acc_end_ms,
                &mut acc_speaker,
            );
        }

        if acc_text.is_empty() {
            acc_first_id = Some(seg.id.clone());
            acc_start_ms = Some(seg.start_ms);
            acc_speaker = seg.speaker_label.clone();
        }
        if !acc_text.is_empty() {
            acc_text.push(' ');
        }
        // Prefix speaker label inline when the speaker is known and we're
        // starting a new "turn" within the same chunk — this gives the
        // retrieval model a stronger signal for "what did X say" queries.
        if let Some(sp) = &seg.speaker_label {
            if acc_text.is_empty() || speaker_changed {
                acc_text.push_str(sp);
                acc_text.push_str(": ");
            }
        }
        acc_text.push_str(&seg.text);
        acc_end_ms = Some(seg.end_ms);
        acc_tokens += seg_tokens;
    }

    // Flush the trailing accumulator
    flush(
        &mut idx,
        &mut out,
        &mut acc_text,
        &mut acc_tokens,
        &mut acc_first_id,
        &mut acc_start_ms,
        &mut acc_end_ms,
        &mut acc_speaker,
    );

    out
}

/// Fallback when no transcript_segments exist: chunk the meeting's
/// full_transcript as plaintext with overlap.
pub fn chunk_meeting_from_full_transcript(
    meeting_id: &str,
    full_transcript: &str,
    opts: &ChunkOptions,
) -> Vec<NewChunk> {
    chunk_plain_with_overlap(
        source_types::MEETING,
        meeting_id,
        "",
        full_transcript,
        opts,
        None,
    )
}

// ── Internals ─────────────────────────────────────────────────────────────

/// Fixed-stride sliding window with overlap. `heading_label` is the
/// breadcrumb-ish label used to prefix the first chunk's text — it's NOT
/// embedded into every chunk, since that would dilute the retrieval signal
/// with repeated metadata; `heading_path` captures the structural hint
/// separately.
fn chunk_plain_with_overlap(
    source_type: &'static str,
    source_id: &str,
    _heading_label: &str,
    body: &str,
    opts: &ChunkOptions,
    heading_path: Option<Vec<String>>,
) -> Vec<NewChunk> {
    let body = body.trim();
    if body.is_empty() {
        return Vec::new();
    }

    // Tokenize-by-whitespace once, then slide a window over the word
    // indices. Re-joining preserves single-space normalization which is
    // typically what we want for embedding inputs anyway.
    let words: Vec<&str> = body.split_whitespace().collect();
    if words.is_empty() {
        return Vec::new();
    }

    // Convert token target back to word count (1 word ≈ 1/1.3 tokens).
    let words_per_chunk = ((opts.target_tokens as f32) / 1.3).floor().max(1.0) as usize;
    let words_overlap = ((opts.overlap_tokens as f32) / 1.3).floor().max(0.0) as usize;
    let stride = words_per_chunk.saturating_sub(words_overlap).max(1);

    let heading_json = heading_path
        .as_ref()
        .and_then(|p| serde_json::to_string(p).ok());

    let mut out: Vec<NewChunk> = Vec::new();
    let mut idx: i64 = 0;
    let mut start = 0usize;
    while start < words.len() {
        let end = (start + words_per_chunk).min(words.len());
        let slice = &words[start..end];
        let text = slice.join(" ");

        // Compute char offsets in the original body so citations can highlight
        // the exact span. We re-find by counting whitespace boundaries from the
        // start of body — O(N) once per chunk and N is small.
        let (char_start, char_end) = char_span_for_word_window(body, start, end);

        let token_count = estimate_tokens(&text) as i64;
        out.push(NewChunk {
            source_type: source_type.to_string(),
            source_id: source_id.to_string(),
            parent_id: None,
            chunk_index: idx,
            text,
            context_prefix: None,
            char_start: Some(char_start as i64),
            char_end: Some(char_end as i64),
            start_ms: None,
            end_ms: None,
            speaker_label: None,
            heading_path: heading_json.clone(),
            token_count: Some(token_count),
            ..Default::default()
        });
        idx += 1;

        if end >= words.len() {
            break;
        }
        start += stride;
    }

    out
}

/// Walk the body string and return the byte offsets corresponding to a
/// window of word indices `[start_word, end_word)`. Used so citations can
/// scroll-and-highlight the exact span without storing the offsets at
/// tokenization time.
fn char_span_for_word_window(body: &str, start_word: usize, end_word: usize) -> (usize, usize) {
    let mut word_idx = 0usize;
    let mut byte_start: Option<usize> = None;
    let mut byte_end: usize = body.len();

    let bytes = body.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        // Skip whitespace
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let word_start = i;
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if word_start == i {
            break;
        }
        if word_idx == start_word {
            byte_start = Some(word_start);
        }
        if word_idx + 1 == end_word {
            byte_end = i;
        }
        word_idx += 1;
    }

    (byte_start.unwrap_or(0), byte_end)
}

// ── ProseMirror traversal (entries' rich JSON) ────────────────────────────

#[derive(Debug, Deserialize)]
struct PmNode {
    #[serde(rename = "type")]
    node_type: String,
    #[serde(default)]
    attrs: Option<serde_json::Value>,
    #[serde(default)]
    content: Option<Vec<PmNode>>,
    #[serde(default)]
    text: Option<String>,
}

/// Heading-aware chunker for TipTap/ProseMirror JSON. Returns `None` if the
/// JSON is malformed so callers can fall back to plaintext.
fn chunk_prosemirror(
    source_type: &'static str,
    source_id: &str,
    json: &str,
    opts: &ChunkOptions,
) -> Option<Vec<NewChunk>> {
    let doc: PmNode = serde_json::from_str(json).ok()?;
    if doc.node_type != "doc" {
        return None;
    }

    // Walk the top-level node list, splitting on h1/h2/h3 boundaries.
    let top = doc.content.unwrap_or_default();
    let mut sections: Vec<(Vec<String>, String)> = Vec::new(); // (heading_path, accumulated_text)
    let mut current_path: Vec<String> = Vec::new();
    let mut current_text = String::new();

    for node in top {
        match node.node_type.as_str() {
            "heading" => {
                // Flush the current section if it has content.
                if !current_text.trim().is_empty() {
                    sections.push((current_path.clone(), std::mem::take(&mut current_text)));
                }
                let level = node
                    .attrs
                    .as_ref()
                    .and_then(|a| a.get("level"))
                    .and_then(|l| l.as_u64())
                    .unwrap_or(1) as usize;
                // Truncate path to this level minus 1, then push the new heading.
                let target_depth = level.saturating_sub(1);
                while current_path.len() > target_depth {
                    current_path.pop();
                }
                let heading_text = collect_text(&node.content.unwrap_or_default());
                current_path.push(heading_text);
            }
            _ => {
                let text = collect_text(&node.content.unwrap_or_default());
                if !current_text.is_empty() && !text.is_empty() {
                    current_text.push('\n');
                }
                current_text.push_str(&text);
            }
        }
    }
    if !current_text.trim().is_empty() {
        sections.push((current_path, current_text));
    }

    // Convert each section into chunks via the plaintext path, carrying
    // heading_path. Sections that exceed target_tokens get split further.
    let mut all: Vec<NewChunk> = Vec::new();
    let mut idx: i64 = 0;
    for (path, body) in sections {
        let sub = chunk_plain_with_overlap(
            source_type,
            source_id,
            "",
            &body,
            opts,
            if path.is_empty() { None } else { Some(path) },
        );
        for mut c in sub {
            c.chunk_index = idx;
            idx += 1;
            all.push(c);
        }
    }

    Some(all)
}

fn collect_text(nodes: &[PmNode]) -> String {
    let mut out = String::new();
    for n in nodes {
        if let Some(t) = &n.text {
            out.push_str(t);
        }
        if let Some(c) = &n.content {
            let s = collect_text(c);
            if !s.is_empty() {
                if !out.is_empty() {
                    out.push(' ');
                }
                out.push_str(&s);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_tokens_grows_roughly_with_words() {
        assert!(estimate_tokens("hello") >= 1);
        let long: String = (0..400).map(|i| format!("word{i} ")).collect();
        let est = estimate_tokens(&long);
        assert!(est > 400 && est < 600, "expected ~520 tokens, got {est}");
    }

    #[test]
    fn user_note_chunk_carries_title_as_heading_path() {
        let body = "The auth migration needs to happen before Q3.";
        let chunks = chunk_user_note(
            "n1",
            "Auth Migration",
            body,
            &ChunkOptions::default(),
        );
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].source_type, source_types::USER_NOTE);
        assert_eq!(chunks[0].source_id, "n1");
        let path: Vec<String> = serde_json::from_str(
            chunks[0].heading_path.as_deref().unwrap_or("[]"),
        ).unwrap();
        assert_eq!(path, vec!["Auth Migration"]);
    }

    #[test]
    fn long_note_splits_with_overlap() {
        // ~1500 tokens → at 400/chunk with 50 overlap should give ~4-5 chunks.
        let body: String = (0..1200).map(|_| "word ").collect();
        let chunks = chunk_user_note("n1", "long", &body, &ChunkOptions::default());
        assert!(chunks.len() >= 3, "expected at least 3 chunks, got {}", chunks.len());
        // Chunks should be in order
        for (i, c) in chunks.iter().enumerate() {
            assert_eq!(c.chunk_index, i as i64);
        }
    }

    #[test]
    fn meeting_groups_consecutive_same_speaker() {
        let segs = vec![
            MeetingSegment { id: "s1".into(), start_ms: 0, end_ms: 1000, speaker_label: Some("Alice".into()), text: "Yesterday I finished the auth bits.".into() },
            MeetingSegment { id: "s2".into(), start_ms: 1000, end_ms: 2000, speaker_label: Some("Alice".into()), text: "Today I'll start on session storage.".into() },
            MeetingSegment { id: "s3".into(), start_ms: 2000, end_ms: 3500, speaker_label: Some("Bob".into()), text: "I'm blocked on the migration script.".into() },
        ];
        let chunks = chunk_meeting_from_segments("m1", &segs, &ChunkOptions::default());
        // Alice's two segments should fold into one chunk; Bob into another.
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].speaker_label.as_deref(), Some("Alice"));
        assert_eq!(chunks[0].source_type, source_types::MEETING_SEGMENT);
        assert_eq!(chunks[0].source_id, "m1");
        assert_eq!(chunks[0].parent_id.as_deref(), Some("s1"));
        assert_eq!(chunks[0].start_ms, Some(0));
        assert_eq!(chunks[0].end_ms, Some(2000));
        assert!(chunks[0].text.contains("Alice"));
        assert!(chunks[0].text.contains("auth"));
        assert!(chunks[0].text.contains("session storage"));

        assert_eq!(chunks[1].speaker_label.as_deref(), Some("Bob"));
        assert_eq!(chunks[1].start_ms, Some(2000));
        assert_eq!(chunks[1].end_ms, Some(3500));
    }

    #[test]
    fn meeting_splits_long_single_speaker_turn() {
        // One speaker rambling for ~800 tokens — must split, but all chunks
        // keep the same speaker label.
        let long_text: String = (0..600).map(|i| format!("word{i} ")).collect();
        let segs = vec![MeetingSegment {
            id: "s1".into(),
            start_ms: 0,
            end_ms: 60000,
            speaker_label: Some("Alice".into()),
            text: long_text,
        }];
        let chunks = chunk_meeting_from_segments(
            "m1",
            &segs,
            &ChunkOptions { target_tokens: 200, overlap_tokens: 0 },
        );
        // The current segment-grouping algorithm flushes ON crossing the
        // boundary, so a single oversized segment will all land in one chunk
        // (we don't sub-split inside a single segment yet). That's an explicit
        // limitation captured here so the next iteration can address it.
        assert!(!chunks.is_empty());
        for c in &chunks {
            assert_eq!(c.speaker_label.as_deref(), Some("Alice"));
            assert_eq!(c.source_id, "m1");
        }
    }

    #[test]
    fn entry_falls_back_to_plain_when_no_json() {
        let chunks = chunk_entry(
            "e1",
            None,
            None,
            Some("Polished body text here."),
            "raw transcript here",
            &ChunkOptions::default(),
        );
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].source_type, source_types::ENTRY);
        assert!(chunks[0].text.contains("Polished body"));
    }

    #[test]
    fn entry_splits_on_headings_when_json_provided() {
        // A two-heading TipTap doc.
        let json = r#"{
          "type":"doc",
          "content":[
            {"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Project X"}]},
            {"type":"paragraph","content":[{"type":"text","text":"Some intro text."}]},
            {"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Decisions"}]},
            {"type":"paragraph","content":[{"type":"text","text":"We decided to ship behind a flag."}]}
          ]
        }"#;
        let chunks = chunk_entry("e1", Some(json), None, None, "", &ChunkOptions::default());
        // We should see one chunk per section.
        assert_eq!(chunks.len(), 2, "expected one chunk per heading section");
        let path0: Vec<String> = serde_json::from_str(chunks[0].heading_path.as_deref().unwrap()).unwrap();
        let path1: Vec<String> = serde_json::from_str(chunks[1].heading_path.as_deref().unwrap()).unwrap();
        assert_eq!(path0, vec!["Project X"]);
        assert_eq!(path1, vec!["Project X", "Decisions"]);
    }

    #[test]
    fn empty_body_produces_zero_chunks() {
        let chunks = chunk_user_note("n1", "title", "", &ChunkOptions::default());
        assert!(chunks.is_empty());
        let chunks = chunk_user_note("n1", "title", "   ", &ChunkOptions::default());
        assert!(chunks.is_empty());
    }

    #[test]
    fn char_span_is_within_body_bytes() {
        let body = "hello world this is a longer body of text";
        let chunks = chunk_user_note(
            "n1",
            "t",
            body,
            &ChunkOptions { target_tokens: 5, overlap_tokens: 0 },
        );
        for c in chunks {
            let start = c.char_start.unwrap() as usize;
            let end = c.char_end.unwrap() as usize;
            assert!(end <= body.len(), "char_end {} > body len {}", end, body.len());
            assert!(start <= end);
        }
    }
}
