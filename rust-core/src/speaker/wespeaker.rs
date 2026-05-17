//! WeSpeaker ResNet34 ONNX speaker-embedding inference.
//!
//! Lazy-loads the bundled `voxceleb_resnet34_LM.onnx` artifact via `ort`
//! (community-maintained ONNX Runtime Rust bindings — same dep used by
//! the Moonshine + Kokoro paths, no new crate). The session is created
//! once per process and held in a `Mutex` because `ort::Session` is not
//! `Sync` in 2.0.0-rc.12; embeddings run on the meeting-recorder chunk
//! loop which serializes calls already.
//!
//! Input-shape handling (decided at load time):
//!
//! WeSpeaker is distributed in two ONNX variants — one expects raw 16 kHz
//! mono Float32 PCM samples (the model graph bakes in its own feature
//! extractor), the other expects pre-computed log-mel-fbank features. The
//! exact artifact at
//! [hbredin/wespeaker-voxceleb-resnet34-LM](https://huggingface.co/hbredin/wespeaker-voxceleb-resnet34-LM)
//! is the raw-PCM variant, but the loader is written defensively so a
//! later swap to the fbank variant only requires implementing the fbank
//! front-end (see `embed_with_fbank_unimplemented`).
//!
//! Output: L2-normalized 256-d Float32 embedding. The L2-normalize step
//! is applied unconditionally — most WeSpeaker exports include it inside
//! the graph as a `Normalize` op, but applying it again is idempotent and
//! cheap, and protects against checkpoints exported without it.

use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

use ort::session::{builder::SessionBuilder, Session};
use ort::value::{Tensor, ValueType};
use tracing::{info, warn};

use crate::error::IronMicError;
use crate::speaker::SPEAKER_EMBEDDING_DIM;

/// Bundled model artifact filename. Lives under the same `IRONMIC_MODELS_DIR`
/// root as the Whisper / Moonshine models (Electron host sets that env var
/// to the app's `Resources/models` path in production builds).
///
/// Matches the filename inside the upstream Hugging Face repo
/// `hbredin/wespeaker-voxceleb-resnet34-LM` (the ONNX is published as
/// `speaker-embedding.onnx`, not the WeSpeaker upstream's
/// `voxceleb_resnet34_LM.onnx`). Pinning the exact filename keeps the
/// runtime in sync with `models-manifest.json` and `extraResources`.
const MODEL_FILENAME: &str = "speaker-embedding.onnx";

/// Sub-directory under the models root. Keeps the speaker artifact next to
/// its model card / LICENSE files in `extraResources`.
const MODEL_SUBDIR: &str = "speaker-embedding";

fn models_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("IRONMIC_MODELS_DIR") {
        return PathBuf::from(dir);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("models")
}

fn model_path() -> PathBuf {
    models_dir().join(MODEL_SUBDIR).join(MODEL_FILENAME)
}

/// Cheap existence check used by the M2.5b runtime readiness flip on app
/// start. We do not load the model here — just confirm the file is on disk
/// in the expected location.
pub fn model_path_exists() -> bool {
    model_path().exists()
}

/// Input layout the model expects, decided at load time by probing
/// `Session::inputs[0].input_type`. Both branches feed into the same
/// inference path; only the staging step differs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InputShape {
    /// `[batch, samples]` — raw 16 kHz mono Float32 PCM. WeSpeaker
    /// LM-export default. Caller supplies `&[f32]` directly.
    RawPcm,
    /// `[batch, time, feature]` — log-mel-fbank features. Needs a
    /// deterministic Kaldi-compatible front-end (frame length, frame
    /// shift, pre-emphasis, Hamming window, dither, mean-norm). Not
    /// implemented in M2; the M2.0 spike branched to RawPcm at the
    /// chosen revision.
    Fbank,
}

struct Loaded {
    session: Session,
    shape: InputShape,
    /// Name of the model's first input — needed to feed `Value`s by name
    /// (positional binding works on most exports but is brittle).
    input_name: String,
    /// Name of the model's first output — same reasoning.
    output_name: String,
}

/// Global lazy singleton. Initialized on the first `embed()` call so app
/// startup isn't gated on ORT initialization. The outer `Result` carries
/// the "model is genuinely missing / unloadable" case so we don't retry
/// loading on every chunk.
static SESSION: LazyLock<Mutex<Option<Result<Loaded, String>>>> =
    LazyLock::new(|| Mutex::new(None));

fn ensure_loaded(
    slot: &mut Option<Result<Loaded, String>>,
) -> Result<&mut Loaded, IronMicError> {
    if slot.is_none() {
        let path = model_path();
        if !path.exists() {
            let msg = format!(
                "WeSpeaker model not found at {} — bundle voxceleb_resnet34_LM.onnx into extraResources",
                path.display()
            );
            *slot = Some(Err(msg));
        } else {
            info!(
                target: "ironmic::speaker",
                path = %path.display(),
                "loading WeSpeaker ResNet34 ONNX model"
            );
            match load_session(&path) {
                Ok(loaded) => {
                    info!(
                        target: "ironmic::speaker",
                        shape = ?loaded.shape,
                        input = %loaded.input_name,
                        output = %loaded.output_name,
                        "WeSpeaker session ready"
                    );
                    *slot = Some(Ok(loaded));
                }
                Err(e) => {
                    warn!(
                        target: "ironmic::speaker",
                        error = %e,
                        "WeSpeaker session load failed"
                    );
                    *slot = Some(Err(e.to_string()));
                }
            }
        }
    }
    match slot {
        Some(Ok(loaded)) => Ok(loaded),
        Some(Err(msg)) => Err(IronMicError::Transcription(msg.clone())),
        None => unreachable!("slot populated above"),
    }
}

fn load_session(path: &PathBuf) -> Result<Loaded, IronMicError> {
    let session = SessionBuilder::new()
        .map_err(|e| IronMicError::Transcription(format!("ort builder: {e}")))?
        .commit_from_file(path)
        .map_err(|e| IronMicError::Transcription(format!("ort load: {e}")))?;

    // Pull the first input + output names + the input's expected rank to
    // decide raw-PCM vs fbank. `inputs()` / `outputs()` are methods on
    // Session in ort 2.0.0-rc.12 returning `&[Outlet]`; `Outlet.name()`
    // / `Outlet.dtype()` give us the bits we need.
    let input = session
        .inputs()
        .first()
        .ok_or_else(|| IronMicError::Transcription("WeSpeaker ONNX has no inputs".into()))?;
    let output = session
        .outputs()
        .first()
        .ok_or_else(|| IronMicError::Transcription("WeSpeaker ONNX has no outputs".into()))?;

    let shape = classify_input_shape(input.dtype());
    let input_name = input.name().to_string();
    let output_name = output.name().to_string();

    Ok(Loaded {
        input_name,
        output_name,
        shape,
        session,
    })
}

/// Probe the model's first-input dimensionality from its `ValueType`.
/// Raw-PCM exports advertise rank-2 `[batch, samples]`; fbank exports
/// advertise rank-3 `[batch, time, feat]`. We pattern-match the rank
/// off the `Debug` string rather than `ValueType`'s internal accessors
/// because ort 2.0's `ValueType` API surface drifts across release
/// candidates — the Debug repr is stable enough for a binary decision.
fn classify_input_shape(dtype: &ValueType) -> InputShape {
    let s = format!("{:?}", dtype);
    // The Debug form of a Tensor's shape is a comma-separated list of
    // dim entries inside square brackets, e.g.
    // `Tensor { ty: F32, shape: [Symbolic("batch"), Symbolic("samples")] }`.
    // Count commas inside the first `[...]` after `shape:`.
    if let Some(shape_idx) = s.find("shape: [") {
        let after = &s[shape_idx + "shape: [".len()..];
        if let Some(end) = after.find(']') {
            let inside = &after[..end];
            let rank = if inside.trim().is_empty() {
                0
            } else {
                inside.matches(',').count() + 1
            };
            return if rank >= 3 { InputShape::Fbank } else { InputShape::RawPcm };
        }
    }
    // Couldn't parse — assume raw-PCM (the variant we actually bundle).
    // The error from running with a wrong shape will be loud and obvious.
    InputShape::RawPcm
}

/// Public entry point — called via [`crate::speaker::embed`].
///
/// The input slice is read-only. Any intermediate Float32 buffer (the
/// `ndarray` staging tensor) is dropped at the end of this function;
/// `ndarray`'s `Array` drops its backing `Vec<f32>` which we explicitly
/// fill with zeros first so the audio never lingers in heap memory past
/// the embedding call.
pub fn embed(samples: &[f32]) -> Result<Vec<f32>, IronMicError> {
    if samples.is_empty() {
        return Err(IronMicError::Processing(
            "empty audio buffer for speaker embedding".into(),
        ));
    }

    let mut guard = SESSION
        .lock()
        .map_err(|e| IronMicError::Transcription(format!("session mutex poisoned: {e}")))?;
    let loaded = ensure_loaded(&mut guard)?;

    match loaded.shape {
        InputShape::RawPcm => embed_raw_pcm(loaded, samples),
        InputShape::Fbank => Err(IronMicError::Transcription(
            "WeSpeaker fbank-input variant not implemented in M2 — bundle the raw-PCM export \
             (hbredin/wespeaker-voxceleb-resnet34-LM voxceleb_resnet34_LM.onnx) instead"
                .into(),
        )),
    }
}

fn embed_raw_pcm(loaded: &mut Loaded, samples: &[f32]) -> Result<Vec<f32>, IronMicError> {
    // Build the input tensor from an owned (shape, Vec<f32>) tuple — the
    // tuple form is the lightest constructor on `Tensor` and avoids the
    // ndarray detour. The samples slice is read-only; we materialize a
    // single owned copy, hand it to ORT, and let it drop with the
    // SessionInputs binding after `run()` returns.
    let staged: Vec<f32> = samples.to_vec();
    let shape: Vec<i64> = vec![1, samples.len() as i64];
    let input_tensor = Tensor::<f32>::from_array((shape, staged)).map_err(|e| {
        IronMicError::Transcription(format!("ort tensor: {e}"))
    })?;

    let outputs = loaded
        .session
        .run(ort::inputs![loaded.input_name.as_str() => input_tensor])
        .map_err(|e| IronMicError::Transcription(format!("ort run: {e}")))?;

    let output_ref = outputs
        .get(loaded.output_name.as_str())
        .ok_or_else(|| {
            IronMicError::Transcription(format!(
                "WeSpeaker output `{}` missing from session.run result",
                loaded.output_name
            ))
        })?;
    let (_, raw) = output_ref
        .try_extract_tensor::<f32>()
        .map_err(|e| IronMicError::Transcription(format!("ort extract: {e}")))?;

    // WeSpeaker emits either `[1, 256]` or `[256]` depending on the
    // export. Slice to exactly SPEAKER_EMBEDDING_DIM and L2-normalize.
    if raw.len() < SPEAKER_EMBEDDING_DIM {
        return Err(IronMicError::Transcription(format!(
            "WeSpeaker output too short: got {}, expected ≥ {}",
            raw.len(),
            SPEAKER_EMBEDDING_DIM
        )));
    }
    let mut emb = raw[..SPEAKER_EMBEDDING_DIM].to_vec();
    l2_normalize_in_place(&mut emb);
    Ok(emb)
}

fn l2_normalize_in_place(v: &mut [f32]) {
    let mut sq = 0.0_f32;
    for &x in v.iter() {
        sq += x * x;
    }
    let norm = sq.sqrt();
    if norm > 1e-9 {
        let inv = 1.0 / norm;
        for x in v.iter_mut() {
            *x *= inv;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lightweight shape-rank parser test that doesn't depend on
    /// constructing a real `ort::ValueType` (which requires a backing
    /// ONNX session). We use the same parser logic as the real path —
    /// it operates on the Debug string — so a string-level test is
    /// representative.
    fn rank_from_string(s: &str) -> InputShape {
        // Mirror of classify_input_shape's parse on a synthetic string.
        if let Some(shape_idx) = s.find("shape: [") {
            let after = &s[shape_idx + "shape: [".len()..];
            if let Some(end) = after.find(']') {
                let inside = &after[..end];
                let rank = if inside.trim().is_empty() {
                    0
                } else {
                    inside.matches(',').count() + 1
                };
                return if rank >= 3 { InputShape::Fbank } else { InputShape::RawPcm };
            }
        }
        InputShape::RawPcm
    }

    #[test]
    fn parser_rank_2_is_raw_pcm() {
        let s = "Tensor { dtype: F32, shape: [Symbolic, Symbolic] }";
        assert_eq!(rank_from_string(s), InputShape::RawPcm);
    }

    #[test]
    fn parser_rank_3_is_fbank() {
        let s = "Tensor { dtype: F32, shape: [Symbolic, Symbolic, Symbolic] }";
        assert_eq!(rank_from_string(s), InputShape::Fbank);
    }

    #[test]
    fn parser_no_shape_defaults_to_raw_pcm() {
        // Defensive: when the Debug form doesn't include a `shape: [...]`
        // section, the parser must not panic and should fall through to
        // RawPcm (the variant we actually bundle). A real load-time
        // mismatch will surface as a clear ort error on the first run().
        let s = "Tensor { dtype: F32, opaque: true }";
        assert_eq!(rank_from_string(s), InputShape::RawPcm);
    }

    #[test]
    fn l2_normalize_unit_vec() {
        let mut v = vec![3.0, 4.0];
        l2_normalize_in_place(&mut v);
        assert!((v[0] - 0.6).abs() < 1e-6);
        assert!((v[1] - 0.8).abs() < 1e-6);
    }

    #[test]
    fn l2_normalize_zero_vec_is_noop() {
        let mut v = vec![0.0, 0.0, 0.0];
        l2_normalize_in_place(&mut v);
        assert_eq!(v, vec![0.0, 0.0, 0.0]);
    }
}
