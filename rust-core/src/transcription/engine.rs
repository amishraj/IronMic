//! Transcription engine abstraction layer.
//!
//! IronMic supports multiple speech-to-text backends behind a single
//! [`TranscriptionEngine`] trait:
//!
//! - **Moonshine** (Useful Sensors) via `transcribe-rs` — ONNX Runtime path,
//!   purpose-built for short-form on-device speech, ~16× faster than Whisper
//!   on CPU and works on machines without BLAS / GPU acceleration.
//! - **Whisper** (whisper.cpp) via the existing
//!   [`crate::transcription::whisper`] module — kept as the multilingual
//!   fallback and for users who prefer Whisper's accuracy ceiling.
//!
//! The active engine is selected at runtime via [`set_active_engine`] (called
//! from N-API), persisted in the Electron settings store as
//! `transcription_engine`, and applied at app startup before any
//! [`transcribe`] call.
//!
//! # Why a trait instead of just calling each backend directly?
//!
//! The N-API `transcribe()` and `transcribe_short()` exports need to route to
//! whichever backend is active without leaking that knowledge into every call
//! site (capture loop, dictation streamer, meeting recorder). The trait lets
//! us swap engines per session and still expose a single entry point.
//!
//! # Feature gating
//!
//! - `engine-multi` enables the Moonshine adapter.
//! - `whisper` enables the Whisper adapter.
//! - With neither feature, [`active_engine()`] returns a [`NullEngine`] that
//!   errors on transcribe — useful for early-boot states and headless tests.

use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

use tracing::{info, warn};

use crate::error::IronMicError;

/// Resolve the models directory.
///
/// Mirrors the pattern in [`crate::transcription::whisper`] so Moonshine and
/// Whisper models share the same root directory. The Electron host sets
/// `IRONMIC_MODELS_DIR` to the app's `Resources/models` path in production.
fn models_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("IRONMIC_MODELS_DIR") {
        return PathBuf::from(dir);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("models")
}

/// Identifies an engine + model variant.
///
/// String form (used by N-API and the Electron settings store):
/// - `moonshine-base` — ~146 MB, balanced, English only (default; bundled)
/// - `whisper-large-v3-turbo` — 1.5 GB, highest accuracy, multilingual
/// - `whisper-medium`, `whisper-small`, `whisper-base` — multilingual variants
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineKind {
    MoonshineBase,
    WhisperLargeV3Turbo,
    WhisperMedium,
    WhisperSmall,
    WhisperBase,
}

impl EngineKind {
    /// Stable string identifier — matches the value stored in the Electron
    /// settings table under `transcription_engine`.
    pub fn as_str(self) -> &'static str {
        match self {
            EngineKind::MoonshineBase => "moonshine-base",
            EngineKind::WhisperLargeV3Turbo => "whisper-large-v3-turbo",
            EngineKind::WhisperMedium => "whisper-medium",
            EngineKind::WhisperSmall => "whisper-small",
            EngineKind::WhisperBase => "whisper-base",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "moonshine-base" => Some(EngineKind::MoonshineBase),
            "whisper-large-v3-turbo" => Some(EngineKind::WhisperLargeV3Turbo),
            "whisper-medium" => Some(EngineKind::WhisperMedium),
            "whisper-small" => Some(EngineKind::WhisperSmall),
            "whisper-base" => Some(EngineKind::WhisperBase),
            _ => None,
        }
    }

    /// True if this kind is a Moonshine variant (regardless of compile-time
    /// feature flags).
    pub fn is_moonshine(self) -> bool {
        matches!(self, EngineKind::MoonshineBase)
    }

    /// True if this kind is a Whisper variant.
    pub fn is_whisper(self) -> bool {
        !self.is_moonshine()
    }

    /// Return all engine kinds — used by N-API to enumerate available engines
    /// for the Settings UI dropdown.
    pub fn all() -> &'static [EngineKind] {
        &[
            EngineKind::MoonshineBase,
            EngineKind::WhisperLargeV3Turbo,
            EngineKind::WhisperMedium,
            EngineKind::WhisperSmall,
            EngineKind::WhisperBase,
        ]
    }
}

/// The default engine — chosen for new installs. Moonshine Base balances
/// quality and size; users can switch in Settings → Audio → Transcription
/// Engine.
pub const DEFAULT_ENGINE: EngineKind = EngineKind::MoonshineBase;

/// Unified speech-to-text interface. All concrete engines implement this.
///
/// Engines are stored as `Box<dyn TranscriptionEngine>` in the global
/// [`ENGINE`] cell, so the trait must be `Send`. We do NOT require `Sync`
/// because the engine state (e.g. ONNX Session, whisper.cpp ctx) is mutated
/// during inference; the [`Mutex`] around the trait object provides the
/// synchronization.
pub trait TranscriptionEngine: Send {
    /// The engine kind backing this instance.
    fn kind(&self) -> EngineKind;

    /// Whether the underlying model is loaded into memory. Loading is lazy —
    /// the first `transcribe()` call triggers `load()` if needed.
    fn is_loaded(&self) -> bool;

    /// Eagerly load the model. Safe to call multiple times (no-op if loaded).
    fn load(&mut self) -> Result<(), IronMicError>;

    /// Transcribe 16 kHz mono f32 PCM samples into text.
    ///
    /// `short` is a hint that the caller is processing a streaming dictation
    /// chunk (≤ ~5 s). Whisper uses this to force `single_segment=true`;
    /// Moonshine ignores it (it is already short-form-optimized).
    fn transcribe(
        &mut self,
        samples: &[f32],
        short: bool,
    ) -> Result<String, IronMicError>;

    /// Transcribe with per-call context terms layered onto the stored
    /// dictionary (e.g. meeting participant names). Default impl ignores
    /// `context_terms` and falls through to `transcribe()` — Whisper overrides
    /// this; Moonshine doesn't have a vocabulary API and gets fuzzy
    /// post-correction in the renderer instead.
    fn transcribe_with_context(
        &mut self,
        samples: &[f32],
        short: bool,
        _context_terms: &[String],
    ) -> Result<String, IronMicError> {
        self.transcribe(samples, short)
    }

    /// Replace the engine's stored dictionary with the given word list.
    /// Default impl is a no-op (Moonshine).
    fn replace_dictionary(&mut self, _words: Vec<String>) {}

    /// Apply an incremental change to the stored dictionary. Default no-op.
    fn apply_dictionary_change(&mut self, _word: &str, _removed: bool) {}

    // ── Session API (Moonshine streaming) ────────────────────────────────────
    // Default implementations return "unsupported" so Whisper and NullEngine
    // compile without changes. `session_reset` is a safe no-op on all engines.

    /// Whether this engine supports the growing-buffer session API.
    fn supports_session(&self) -> bool { false }

    /// Append new PCM samples to the in-progress session buffer and return
    /// the current hypothesis (full utterance so far). Lazy-loads the model.
    fn session_append(&mut self, _samples: &[f32]) -> Result<String, IronMicError> {
        Err(IronMicError::Transcription(
            "session_append not supported by this engine".into(),
        ))
    }

    /// Finalize the current session utterance. Returns the final text and
    /// clears (zeros) the session buffer. Lazy-loads the model.
    fn session_commit(&mut self) -> Result<String, IronMicError> {
        Err(IronMicError::Transcription(
            "session_commit not supported by this engine".into(),
        ))
    }

    /// Discard the session buffer without emitting text. Safe to call on any
    /// engine — no-op on engines that don't implement sessions.
    fn session_reset(&mut self) {}
}

// ── Moonshine adapter ─────────────────────────────────────────────────────

#[cfg(feature = "engine-multi")]
mod moonshine_adapter {
    use super::*;
    use transcribe_rs::onnx::moonshine::{MoonshineModel, MoonshineVariant};
    use transcribe_rs::onnx::Quantization;
    use transcribe_rs::{SpeechModel, TranscribeOptions};

    pub struct MoonshineAdapter {
        kind: EngineKind,
        variant: MoonshineVariant,
        model: Option<MoonshineModel>,
        /// Growing audio buffer for the streaming session API. Accumulates
        /// 16 kHz mono f32 samples for the current utterance. Zeroed and
        /// cleared on commit and reset to satisfy IronMic's privacy guarantees.
        session_buffer: Vec<f32>,
    }

    impl MoonshineAdapter {
        pub fn new(kind: EngineKind) -> Self {
            // Only MoonshineBase exists today. The constructor still takes
            // EngineKind to keep the call sites uniform with whisper variants.
            let variant = match kind {
                EngineKind::MoonshineBase => MoonshineVariant::Base,
                _ => MoonshineVariant::Base, // unreachable in practice
            };
            Self {
                kind,
                variant,
                model: None,
                session_buffer: Vec::new(),
            }
        }

        fn model_dir(&self) -> PathBuf {
            // Layout: <models_dir>/moonshine-base/{encoder_model.onnx,
            // decoder_model_merged.onnx, tokenizer.json}
            //
            // transcribe-rs's MoonshineModel::load expects the directory
            // (not a single file path) and looks for the three files inside.
            models_dir().join(self.kind.as_str())
        }
    }

    impl TranscriptionEngine for MoonshineAdapter {
        fn kind(&self) -> EngineKind {
            self.kind
        }

        fn is_loaded(&self) -> bool {
            self.model.is_some()
        }

        fn load(&mut self) -> Result<(), IronMicError> {
            if self.model.is_some() {
                return Ok(());
            }
            let dir = self.model_dir();
            info!(
                target: "ironmic::engine::moonshine",
                kind = self.kind.as_str(),
                dir = %dir.display(),
                "loading Moonshine model"
            );
            let model = MoonshineModel::load(&dir, self.variant, &Quantization::default())
                .map_err(|e| {
                    IronMicError::Transcription(format!(
                        "Moonshine load failed ({}): {}",
                        self.kind.as_str(),
                        e
                    ))
                })?;
            self.model = Some(model);
            info!(
                target: "ironmic::engine::moonshine",
                kind = self.kind.as_str(),
                "Moonshine model loaded"
            );
            Ok(())
        }

        fn transcribe(
            &mut self,
            samples: &[f32],
            _short: bool,
        ) -> Result<String, IronMicError> {
            // `short` is intentionally ignored — Moonshine is already
            // short-form-optimized (≤30 s training window).
            self.load()?;
            let model = self.model.as_mut().expect("model loaded above");
            let result = model
                .transcribe(samples, &TranscribeOptions::default())
                .map_err(|e| {
                    IronMicError::Transcription(format!("Moonshine inference failed: {}", e))
                })?;
            Ok(result.text)
        }

        fn supports_session(&self) -> bool { true }

        fn session_append(&mut self, new_samples: &[f32]) -> Result<String, IronMicError> {
            self.load()?;
            self.session_buffer.extend_from_slice(new_samples);
            let model = self.model.as_mut().expect("model loaded above");
            let result = model
                .transcribe(&self.session_buffer, &TranscribeOptions::default())
                .map_err(|e| {
                    IronMicError::Transcription(format!("Moonshine session_append failed: {}", e))
                })?;
            Ok(result.text)
        }

        fn session_commit(&mut self) -> Result<String, IronMicError> {
            self.load()?;
            let model = self.model.as_mut().expect("model loaded above");
            let result = model
                .transcribe(&self.session_buffer, &TranscribeOptions::default())
                .map_err(|e| {
                    IronMicError::Transcription(format!("Moonshine session_commit failed: {}", e))
                })?;
            // Zero before clearing — audio privacy guarantee.
            self.session_buffer.fill(0.0);
            self.session_buffer.clear();
            Ok(result.text)
        }

        fn session_reset(&mut self) {
            self.session_buffer.fill(0.0);
            self.session_buffer.clear();
        }
    }
}

#[cfg(feature = "engine-multi")]
use moonshine_adapter::MoonshineAdapter;

// ── Whisper adapter ───────────────────────────────────────────────────────

#[cfg(feature = "whisper")]
mod whisper_adapter {
    use super::*;
    use crate::transcription::dictionary::Dictionary;
    use crate::transcription::whisper::{WhisperConfig, WhisperEngine};

    pub struct WhisperAdapter {
        kind: EngineKind,
        engine: WhisperEngine,
    }

    impl WhisperAdapter {
        pub fn new(kind: EngineKind) -> Self {
            // The kind selects which model file the engine should load. We
            // map kind → model id, then call set_model() so the file path
            // is resolved consistently with the existing model registry.
            let model_id = match kind {
                EngineKind::WhisperLargeV3Turbo => "large-v3-turbo",
                EngineKind::WhisperMedium => "medium",
                EngineKind::WhisperSmall => "small",
                EngineKind::WhisperBase => "base",
                _ => "large-v3-turbo", // unreachable
            };
            let mut engine = WhisperEngine::new(WhisperConfig::default(), Dictionary::new());
            // Best-effort: if set_model fails (e.g. unknown id), we fall back
            // to the default model_path from WhisperConfig.
            if let Err(e) = engine.set_model(model_id) {
                warn!(
                    target: "ironmic::engine::whisper",
                    %e,
                    model_id,
                    "set_model failed; using default whisper model path"
                );
            }
            Self { kind, engine }
        }
    }

    impl TranscriptionEngine for WhisperAdapter {
        fn kind(&self) -> EngineKind {
            self.kind
        }

        fn is_loaded(&self) -> bool {
            self.engine.is_loaded()
        }

        fn load(&mut self) -> Result<(), IronMicError> {
            if self.engine.is_loaded() {
                return Ok(());
            }
            info!(
                target: "ironmic::engine::whisper",
                kind = self.kind.as_str(),
                "loading Whisper model"
            );
            self.engine.load_model()
        }

        fn transcribe(
            &mut self,
            samples: &[f32],
            short: bool,
        ) -> Result<String, IronMicError> {
            self.load()?;
            if short {
                self.engine.transcribe_short(samples)
            } else {
                self.engine.transcribe(samples)
            }
        }

        fn transcribe_with_context(
            &mut self,
            samples: &[f32],
            short: bool,
            context_terms: &[String],
        ) -> Result<String, IronMicError> {
            self.load()?;
            self.engine.transcribe_with_context(samples, short, context_terms)
        }

        fn replace_dictionary(&mut self, words: Vec<String>) {
            self.engine.dictionary_mut().replace_words(words);
        }

        fn apply_dictionary_change(&mut self, word: &str, removed: bool) {
            let dict = self.engine.dictionary_mut();
            if removed {
                dict.remove_word(word);
            } else {
                dict.add_word(word);
            }
        }
    }
}

#[cfg(feature = "whisper")]
use whisper_adapter::WhisperAdapter;

// ── Null engine (no transcription features compiled in) ──────────────────

/// Fallback engine used when neither `engine-multi` nor `whisper` is
/// compiled in (e.g. CI builds without ML). Always errors on transcribe.
pub struct NullEngine {
    requested_kind: EngineKind,
}

impl TranscriptionEngine for NullEngine {
    fn kind(&self) -> EngineKind {
        self.requested_kind
    }

    fn is_loaded(&self) -> bool {
        false
    }

    fn load(&mut self) -> Result<(), IronMicError> {
        Err(IronMicError::Transcription(format!(
            "Engine '{}' is not available — neither engine-multi nor whisper feature compiled",
            self.requested_kind.as_str()
        )))
    }

    fn transcribe(
        &mut self,
        _samples: &[f32],
        _short: bool,
    ) -> Result<String, IronMicError> {
        self.load()?;
        unreachable!("load() always errors on NullEngine")
    }
}

// ── Factory + global cell ─────────────────────────────────────────────────

/// Build the engine for a given kind. Falls back to [`NullEngine`] if the
/// corresponding feature isn't compiled in, so the registry is always in a
/// safe state and the user gets a clear error rather than a panic.
fn build_engine(kind: EngineKind) -> Box<dyn TranscriptionEngine> {
    if kind.is_moonshine() {
        #[cfg(feature = "engine-multi")]
        {
            return Box::new(MoonshineAdapter::new(kind));
        }
        #[cfg(not(feature = "engine-multi"))]
        {
            warn!(
                target: "ironmic::engine",
                requested = kind.as_str(),
                "engine-multi feature not compiled; using NullEngine"
            );
            return Box::new(NullEngine { requested_kind: kind });
        }
    }

    // Whisper variant
    #[cfg(feature = "whisper")]
    {
        Box::new(WhisperAdapter::new(kind))
    }
    #[cfg(not(feature = "whisper"))]
    {
        warn!(
            target: "ironmic::engine",
            requested = kind.as_str(),
            "whisper feature not compiled; using NullEngine"
        );
        Box::new(NullEngine { requested_kind: kind })
    }
}

/// Global active engine. Initialized lazily on first access with
/// [`DEFAULT_ENGINE`]. Replaced wholesale by [`set_active_engine`] when the
/// user picks a different engine in Settings.
static ENGINE: LazyLock<Mutex<Box<dyn TranscriptionEngine>>> =
    LazyLock::new(|| Mutex::new(build_engine(DEFAULT_ENGINE)));

/// Switch the active engine. Drops the previous engine (releasing its model
/// memory) and constructs a fresh one for the new kind. Subsequent
/// [`transcribe`] calls will lazy-load the new model.
///
/// Idempotent: setting the same kind twice is a no-op (we keep the existing
/// loaded model rather than reloading). Any in-progress session buffer is
/// zeroed and cleared before the old engine is replaced.
pub fn set_active_engine(kind: EngineKind) -> Result<(), IronMicError> {
    let mut slot = ENGINE.lock().map_err(|e| {
        IronMicError::Transcription(format!("engine mutex poisoned: {}", e))
    })?;
    if slot.kind() == kind {
        info!(
            target: "ironmic::engine",
            kind = kind.as_str(),
            "set_active_engine: same kind, no-op"
        );
        return Ok(());
    }
    info!(
        target: "ironmic::engine",
        from = slot.kind().as_str(),
        to = kind.as_str(),
        "swapping active transcription engine"
    );
    // Zero any in-progress session buffer on the outgoing engine before drop.
    slot.session_reset();
    *slot = build_engine(kind);
    Ok(())
}

/// Return the active engine kind without locking long.
pub fn active_engine_kind() -> EngineKind {
    ENGINE.lock().map(|e| e.kind()).unwrap_or(DEFAULT_ENGINE)
}

/// Eagerly load the active engine's model. Called from N-API
/// `load_whisper_model` so model load happens on app startup rather than at
/// first dictation chunk.
pub fn load_active_engine() -> Result<(), IronMicError> {
    let mut slot = ENGINE.lock().map_err(|e| {
        IronMicError::Transcription(format!("engine mutex poisoned: {}", e))
    })?;
    slot.load()
}

/// Whether the active engine has its model loaded.
pub fn is_active_engine_loaded() -> bool {
    ENGINE
        .lock()
        .map(|e| e.is_loaded())
        .unwrap_or(false)
}

/// Run inference through the active engine. Lazy-loads the model if needed.
///
/// This is the single entry point used by the N-API `transcribe()` and
/// `transcribe_short()` exports.
pub fn transcribe_active(samples: &[f32], short: bool) -> Result<String, IronMicError> {
    let mut slot = ENGINE.lock().map_err(|e| {
        IronMicError::Transcription(format!("engine mutex poisoned: {}", e))
    })?;
    slot.transcribe(samples, short)
}

/// Run inference with per-call context terms (e.g. meeting participant names).
/// Whisper layers them onto the stored dictionary in the initial prompt;
/// Moonshine ignores them.
pub fn transcribe_active_with_context(
    samples: &[f32],
    short: bool,
    context_terms: &[String],
) -> Result<String, IronMicError> {
    let mut slot = ENGINE.lock().map_err(|e| {
        IronMicError::Transcription(format!("engine mutex poisoned: {}", e))
    })?;
    slot.transcribe_with_context(samples, short, context_terms)
}

/// Replace the active engine's stored dictionary in one lock acquisition.
/// Called by N-API `refreshTranscriptionDictionary` after reading the
/// persisted word list from SQLite. Whisper applies; Moonshine no-ops.
pub fn replace_active_dictionary(words: Vec<String>) {
    if let Ok(mut slot) = ENGINE.lock() {
        slot.replace_dictionary(words);
    }
}

/// Push a single add/remove into the active engine's dictionary. Called by
/// N-API `add_word`/`remove_word` after the SQLite mutation succeeds.
pub fn apply_active_dictionary_change(word: &str, removed: bool) {
    if let Ok(mut slot) = ENGINE.lock() {
        slot.apply_dictionary_change(word, removed);
    }
}

// ── Session API helpers (used by lib.rs N-API exports) ───────────────────────

/// Returns true if the active engine supports the growing-buffer session API.
pub fn active_engine_supports_session() -> bool {
    ENGINE.lock().map(|e| e.supports_session()).unwrap_or(false)
}

/// Append PCM samples to the active engine's session buffer and return the
/// current hypothesis. Only meaningful when [`active_engine_supports_session`]
/// returns true.
pub fn session_append_active(samples: &[f32]) -> Result<String, IronMicError> {
    let mut slot = ENGINE.lock().map_err(|e| {
        IronMicError::Transcription(format!("engine mutex poisoned: {}", e))
    })?;
    slot.session_append(samples)
}

/// Finalize the active session utterance. Returns final text, zeros + clears
/// the session buffer.
pub fn session_commit_active() -> Result<String, IronMicError> {
    let mut slot = ENGINE.lock().map_err(|e| {
        IronMicError::Transcription(format!("engine mutex poisoned: {}", e))
    })?;
    slot.session_commit()
}

/// Discard the session buffer without emitting text. No-op on engines that
/// don't support sessions.
pub fn session_reset_active() {
    if let Ok(mut slot) = ENGINE.lock() {
        slot.session_reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_kind_roundtrip() {
        for k in EngineKind::all() {
            assert_eq!(EngineKind::from_str(k.as_str()), Some(*k));
        }
        assert_eq!(EngineKind::from_str("does-not-exist"), None);
    }

    #[test]
    fn engine_kind_is_moonshine() {
        assert!(EngineKind::MoonshineBase.is_moonshine());
        assert!(!EngineKind::WhisperBase.is_moonshine());
        assert!(EngineKind::WhisperBase.is_whisper());
    }
}
