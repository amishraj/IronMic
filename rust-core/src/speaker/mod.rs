//! Acoustic speaker embeddings for loopback transcript segments.
//!
//! Loads the bundled WeSpeaker ResNet34 ONNX model via the existing `ort`
//! dependency (same runtime as the Moonshine + Kokoro paths — no new
//! third-party crate). Per-segment embeddings feed the
//! [`crate::storage::transcript_segments::SegmentEmbeddingRow`] table; the
//! main-process [`SpeakerClusterer`] (TypeScript) does the actual
//! online/offline clustering.
//!
//! Build gating:
//! - `speaker-diarization` feature compiled in → real `wespeaker::embed`.
//! - Feature absent → stub that returns
//!   [`IronMicError::Unsupported`] so the meeting recorder gracefully
//!   falls through to "Remote" labels.
//!
//! Privacy: input PCM is consumed read-only; any intermediate Float32
//! buffer materialized inside `embed()` is zeroed before return. Callers
//! own zeroing the input Buffer on the JS side (see M2.2 / native-bridge).
//!
//! Threading: `ort::Session` is not `Sync` in 2.0.0-rc.12; the global
//! singleton is wrapped in a `Mutex`. Embeddings run on the meeting-recorder
//! chunk loop (single async path, no parallel embedding), so contention is
//! a non-issue.

#[cfg(feature = "speaker-diarization")]
pub mod wespeaker;

use crate::error::IronMicError;

/// L2-normalized speaker embedding length, in floats. WeSpeaker ResNet34's
/// LM-pooled embedding is 256-dim. Pinned here so callers can size buffers
/// without depending on the (feature-gated) implementation.
pub const SPEAKER_EMBEDDING_DIM: usize = 256;

/// Embed a 16 kHz mono Float32 PCM clip into a 256-d L2-normalized
/// speaker vector.
///
/// The PCM slice is read-only — the caller (JS-side `embedSpeaker`
/// N-API wrapper) is responsible for zeroing the input Buffer. The
/// implementation zeroes any intermediate Float32 vector or feature
/// matrix it materializes before return.
///
/// Returns a `Transcription`-tagged error when the `speaker-diarization`
/// feature is not compiled in, or when the model file is missing on
/// disk. The meeting recorder treats both cases as "skip embedding for
/// this chunk; persist the segment with `speaker_label = null`". The
/// error tag is `Transcription` rather than a dedicated `Unsupported`
/// variant only because `IronMicError` doesn't carry one — the message
/// string carries the real semantics.
pub fn embed(samples: &[f32]) -> Result<Vec<f32>, IronMicError> {
    #[cfg(feature = "speaker-diarization")]
    {
        wespeaker::embed(samples)
    }
    #[cfg(not(feature = "speaker-diarization"))]
    {
        let _ = samples;
        Err(IronMicError::Transcription(
            "speaker-diarization feature not compiled".into(),
        ))
    }
}

/// Whether the speaker-embedding model is available at runtime. Used by
/// the M2.5b runtime readiness check on app start to decide whether to
/// flip `meeting_diarization_mode` from `'off'` to `'embedding'`.
///
/// Returns `false` when the feature is not compiled in OR the model file
/// is missing on disk — the meeting recorder's per-chunk fallback handles
/// the runtime case but the readiness check needs an upfront answer.
pub fn is_available() -> bool {
    #[cfg(feature = "speaker-diarization")]
    {
        wespeaker::model_path_exists()
    }
    #[cfg(not(feature = "speaker-diarization"))]
    {
        false
    }
}
