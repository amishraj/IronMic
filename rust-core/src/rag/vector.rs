//! Vector math for retrieval.
//!
//! Two responsibilities:
//!   1. Decode the BLOB embeddings stored in `chunk_embeddings.embedding`
//!      (raw little-endian Float32 bytes) into searchable f32 slices.
//!   2. Score a query embedding against a list of candidate embeddings via
//!      dot product (== cosine similarity, since BgeEmbedder L2-normalizes
//!      both sides).
//!
//! The implementation is intentionally a tight scalar loop rather than
//! `wide`/SIMD intrinsics. Reasoning: at 384-dim × ~10k vectors we expect
//! ~5–15 ms per query on the scalar path; that's well inside the 50 ms
//! retrieval budget and avoids a `wide` dependency. If we ever exceed
//! ~50k chunks per user and budget pressure shows up, SIMD becomes a
//! one-function swap-in here — no callers change.

/// Decode a raw embedding blob into an owned `Vec<f32>`. Validates that the
/// byte length matches `dim * 4`; returns `None` for malformed rows so a
/// single corrupt embedding can't poison the whole search.
pub fn decode_embedding(bytes: &[u8], dim: usize) -> Option<Vec<f32>> {
    if bytes.len() != dim * 4 {
        return None;
    }
    let mut out = Vec::with_capacity(dim);
    for chunk in bytes.chunks_exact(4) {
        out.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Some(out)
}

/// Dot product of two equal-length slices. Returns 0.0 on length mismatch
/// rather than panicking — keeps a corrupt embedding from crashing the
/// retrieval round-trip.
pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    let mut acc = 0.0f32;
    for i in 0..a.len() {
        acc += a[i] * b[i];
    }
    acc
}

/// Compute cosine similarity by decoding a stored embedding and dotting it
/// against an already-decoded query vector. Caller is responsible for
/// ensuring the query is L2-normalized; with BgeEmbedder this is automatic.
/// We also normalize the candidate defensively in case the BLOB came from a
/// model that didn't normalize, so the score is a true cosine in [-1, 1]
/// regardless of source. The normalization cost is negligible compared to
/// the dot product.
pub fn score_against_query(query: &[f32], candidate_bytes: &[u8], dim: usize) -> f32 {
    let Some(cand) = decode_embedding(candidate_bytes, dim) else {
        return 0.0;
    };
    let dot_q_c = dot(query, &cand);
    let cand_norm_sq: f32 = cand.iter().map(|x| x * x).sum();
    if cand_norm_sq <= f32::EPSILON {
        return 0.0;
    }
    let cand_norm = cand_norm_sq.sqrt();
    // Query is assumed normalized; if it isn't the score scales by its norm
    // which is consistent across all candidates and doesn't affect ranking.
    dot_q_c / cand_norm
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(v: &[f32]) -> Vec<u8> {
        let mut out = Vec::with_capacity(v.len() * 4);
        for x in v {
            out.extend_from_slice(&x.to_le_bytes());
        }
        out
    }

    #[test]
    fn decode_roundtrips_clean_bytes() {
        let v = vec![0.1f32, -0.5, 1.0, 2.5];
        let bytes = encode(&v);
        let decoded = decode_embedding(&bytes, 4).unwrap();
        for (a, b) in v.iter().zip(decoded.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }

    #[test]
    fn decode_rejects_wrong_length() {
        let bytes = vec![0u8; 13];
        assert!(decode_embedding(&bytes, 4).is_none(), "byte len 13 should fail dim=4");
    }

    #[test]
    fn dot_handles_length_mismatch() {
        let a = vec![1.0f32, 2.0];
        let b = vec![1.0f32, 2.0, 3.0];
        assert_eq!(dot(&a, &b), 0.0);
    }

    #[test]
    fn score_identical_vectors_is_one() {
        let v = vec![1.0f32 / 2.0_f32.sqrt(), 1.0f32 / 2.0_f32.sqrt()]; // normalized
        let bytes = encode(&v);
        let score = score_against_query(&v, &bytes, 2);
        assert!((score - 1.0).abs() < 1e-6, "expected 1.0, got {score}");
    }

    #[test]
    fn score_orthogonal_vectors_is_zero() {
        let q = vec![1.0f32, 0.0];
        let c = vec![0.0f32, 1.0];
        let bytes = encode(&c);
        let score = score_against_query(&q, &bytes, 2);
        assert!(score.abs() < 1e-6);
    }

    #[test]
    fn score_corrupt_bytes_returns_zero_not_panic() {
        let q = vec![1.0f32, 0.0];
        let bytes = vec![0u8; 7];
        let score = score_against_query(&q, &bytes, 2);
        assert_eq!(score, 0.0);
    }
}
