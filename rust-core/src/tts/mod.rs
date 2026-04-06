pub mod kokoro;
pub mod playback;
pub mod timestamps;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::error::IronMicError;
use timestamps::WordTimestamp;

/// A TTS voice descriptor.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TtsVoice {
    pub id: String,
    pub name: String,
    pub language: String,
    pub gender: String,
    pub preview_text: String,
}

/// Configuration for the TTS engine.
#[derive(Clone, Debug)]
pub struct TtsConfig {
    pub model_dir: PathBuf,
    pub voice_id: String,
    pub speed: f32,
}

impl Default for TtsConfig {
    fn default() -> Self {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        Self {
            model_dir: PathBuf::from(manifest_dir).join("models"),
            voice_id: "af_heart".to_string(),
            speed: 1.0,
        }
    }
}

/// Result of speech synthesis.
pub struct SynthesisResult {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub timestamps: Vec<WordTimestamp>,
    pub duration_seconds: f64,
}

impl SynthesisResult {
    /// Take the audio samples out, leaving the struct with an empty vec.
    /// The caller is responsible for zeroing the returned data when done.
    pub fn take_samples(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.samples)
    }
}

impl Drop for SynthesisResult {
    fn drop(&mut self) {
        // Privacy: zero any remaining audio data on drop
        self.samples.fill(0.0);
        self.samples.clear();
    }
}

/// Core synthesis trait — future-proofs for alternative engines.
pub trait TtsEngine: Send {
    fn load_model(&mut self) -> Result<(), IronMicError>;
    fn is_loaded(&self) -> bool;
    fn synthesize(&self, text: &str) -> Result<SynthesisResult, IronMicError>;
    fn available_voices(&self) -> Vec<TtsVoice>;
    fn set_voice(&mut self, voice_id: &str) -> Result<(), IronMicError>;
    fn set_speed(&mut self, speed: f32);
    fn model_exists(&self) -> bool;
}
