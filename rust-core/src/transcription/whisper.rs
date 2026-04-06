use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tracing::{info, warn};

use crate::error::IronMicError;
use crate::transcription::dictionary::Dictionary;

/// Default model filename.
const DEFAULT_MODEL_FILENAME: &str = "whisper-large-v3-turbo.bin";

/// Resolve the models directory using compile-time manifest dir.
fn models_dir() -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest_dir).join("models")
}

fn default_model_path() -> PathBuf {
    models_dir().join(DEFAULT_MODEL_FILENAME)
}

/// Available Whisper model variants.
#[derive(Clone, Debug, PartialEq)]
pub struct WhisperModelInfo {
    pub id: String,
    pub name: String,
    pub filename: String,
    pub size_bytes: u64,
    pub speed_label: String,
    pub accuracy_label: String,
    pub description: String,
    pub download_url: String,
}

/// Return the list of all supported Whisper models.
pub fn available_models() -> Vec<WhisperModelInfo> {
    vec![
        WhisperModelInfo {
            id: "large-v3-turbo".into(),
            name: "Large V3 Turbo".into(),
            filename: "whisper-large-v3-turbo.bin".into(),
            size_bytes: 1_600_000_000,
            speed_label: "1x (baseline)".into(),
            accuracy_label: "Best".into(),
            description: "Highest accuracy. Best for important recordings.".into(),
            download_url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin".into(),
        },
        WhisperModelInfo {
            id: "medium".into(),
            name: "Medium".into(),
            filename: "ggml-medium.bin".into(),
            size_bytes: 769_000_000,
            speed_label: "~2x faster".into(),
            accuracy_label: "Very good".into(),
            description: "Great balance of speed and accuracy.".into(),
            download_url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin".into(),
        },
        WhisperModelInfo {
            id: "small".into(),
            name: "Small".into(),
            filename: "ggml-small.bin".into(),
            size_bytes: 488_000_000,
            speed_label: "~4x faster".into(),
            accuracy_label: "Good".into(),
            description: "Fast with solid accuracy. Good for everyday use.".into(),
            download_url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin".into(),
        },
        WhisperModelInfo {
            id: "base".into(),
            name: "Base".into(),
            filename: "ggml-base.bin".into(),
            size_bytes: 147_000_000,
            speed_label: "~8x faster".into(),
            accuracy_label: "Okay".into(),
            description: "Very fast. Best for quick notes or slower hardware.".into(),
            download_url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin".into(),
        },
    ]
}

/// Check which models are downloaded in the models directory.
pub fn downloaded_models() -> Vec<(WhisperModelInfo, bool)> {
    let dir = models_dir();
    available_models()
        .into_iter()
        .map(|m| {
            let exists = dir.join(&m.filename).exists();
            (m, exists)
        })
        .collect()
}

/// Configuration for the Whisper engine.
#[derive(Clone, Debug)]
pub struct WhisperConfig {
    /// Path to the Whisper GGML model file.
    pub model_path: PathBuf,
    /// Language for transcription (e.g., "en"). None = auto-detect.
    pub language: Option<String>,
    /// Whether to translate to English.
    pub translate: bool,
    /// Number of threads to use for inference.
    pub n_threads: u32,
    /// Whether to use GPU (Metal on macOS) acceleration.
    pub use_gpu: bool,
}

impl Default for WhisperConfig {
    fn default() -> Self {
        Self {
            model_path: default_model_path(),
            language: Some("en".to_string()),
            translate: false,
            n_threads: num_cpus(),
            use_gpu: false,
        }
    }
}

fn num_cpus() -> u32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(4)
}

/// Detect whether GPU acceleration is available on this machine.
pub fn gpu_available() -> bool {
    #[cfg(all(target_os = "macos", feature = "metal"))]
    {
        true
    }
    #[cfg(not(all(target_os = "macos", feature = "metal")))]
    {
        false
    }
}

/// The Whisper transcription engine.
pub struct WhisperEngine {
    config: WhisperConfig,
    dictionary: Dictionary,
    #[cfg(feature = "whisper")]
    ctx: Option<whisper_rs::WhisperContext>,
    #[cfg(not(feature = "whisper"))]
    _loaded: bool,
}

unsafe impl Send for WhisperEngine {}

impl WhisperEngine {
    pub fn new(config: WhisperConfig, dictionary: Dictionary) -> Self {
        Self {
            config,
            dictionary,
            #[cfg(feature = "whisper")]
            ctx: None,
            #[cfg(not(feature = "whisper"))]
            _loaded: false,
        }
    }

    pub fn with_defaults() -> Self {
        Self::new(WhisperConfig::default(), Dictionary::new())
    }

    pub fn model_exists(&self) -> bool {
        self.config.model_path.exists()
    }

    pub fn model_path(&self) -> &Path {
        &self.config.model_path
    }

    pub fn config(&self) -> &WhisperConfig {
        &self.config
    }

    pub fn dictionary(&self) -> &Dictionary {
        &self.dictionary
    }

    pub fn dictionary_mut(&mut self) -> &mut Dictionary {
        &mut self.dictionary
    }

    pub fn is_loaded(&self) -> bool {
        #[cfg(feature = "whisper")]
        {
            self.ctx.is_some()
        }
        #[cfg(not(feature = "whisper"))]
        {
            self._loaded
        }
    }

    /// Change the active model. Unloads the current model — call load_model() after.
    pub fn set_model(&mut self, model_id: &str) -> Result<(), IronMicError> {
        let models = available_models();
        let model = models
            .iter()
            .find(|m| m.id == model_id)
            .ok_or_else(|| IronMicError::Audio(format!("Unknown model: {model_id}")))?;

        let new_path = models_dir().join(&model.filename);
        if !new_path.exists() {
            return Err(IronMicError::Audio(format!(
                "Model file not downloaded: {}",
                model.filename
            )));
        }

        // Unload current model
        #[cfg(feature = "whisper")]
        {
            self.ctx = None;
        }
        #[cfg(not(feature = "whisper"))]
        {
            self._loaded = false;
        }

        self.config.model_path = new_path;
        info!(model_id, "Switched Whisper model");
        Ok(())
    }

    /// Enable or disable GPU acceleration. Requires model reload.
    pub fn set_use_gpu(&mut self, use_gpu: bool) {
        self.config.use_gpu = use_gpu;
        // Unload so next transcribe triggers reload with new setting
        #[cfg(feature = "whisper")]
        {
            self.ctx = None;
        }
        #[cfg(not(feature = "whisper"))]
        {
            self._loaded = false;
        }
        info!(use_gpu, "GPU acceleration setting changed");
    }

    /// Load the Whisper model from disk.
    pub fn load_model(&mut self) -> Result<(), IronMicError> {
        let model_path = &self.config.model_path;

        if !model_path.exists() {
            warn!(
                path = %model_path.display(),
                "Whisper model file not found. Production builds must bundle the model."
            );

            #[cfg(feature = "whisper")]
            {
                return Err(IronMicError::Audio(format!(
                    "Model file not found: {}. Download it to this path for development.",
                    model_path.display()
                )));
            }

            #[cfg(not(feature = "whisper"))]
            {
                warn!("Whisper feature not enabled — using stub transcription");
                self._loaded = true;
                return Ok(());
            }
        }

        info!(
            path = %model_path.display(),
            use_gpu = self.config.use_gpu,
            "Loading Whisper model"
        );

        #[cfg(feature = "whisper")]
        {
            use whisper_rs::{WhisperContext, WhisperContextParameters};
            let mut ctx_params = WhisperContextParameters::default();
            ctx_params.use_gpu(self.config.use_gpu);

            let ctx = WhisperContext::new_with_params(
                model_path.to_str().ok_or_else(|| {
                    IronMicError::Audio("Invalid model path encoding".into())
                })?,
                ctx_params,
            )
            .map_err(|e| IronMicError::Audio(format!("Failed to load Whisper model: {e}")))?;

            self.ctx = Some(ctx);
            info!(
                use_gpu = self.config.use_gpu,
                "Whisper model loaded successfully"
            );
        }

        #[cfg(not(feature = "whisper"))]
        {
            warn!("Whisper feature not enabled — model loading is a no-op");
            self._loaded = true;
        }

        Ok(())
    }

    /// Transcribe PCM audio samples to text.
    pub fn transcribe(&self, samples: &[f32]) -> Result<String, IronMicError> {
        if samples.is_empty() {
            return Err(IronMicError::Processing(
                "No audio samples to transcribe".into(),
            ));
        }

        #[cfg(feature = "whisper")]
        {
            self.transcribe_with_whisper(samples)
        }

        #[cfg(not(feature = "whisper"))]
        {
            self.transcribe_stub(samples)
        }
    }

    #[cfg(feature = "whisper")]
    fn transcribe_with_whisper(&self, samples: &[f32]) -> Result<String, IronMicError> {
        use whisper_rs::FullParams;
        use whisper_rs::SamplingStrategy;

        let ctx = self.ctx.as_ref().ok_or_else(|| {
            IronMicError::Audio("Whisper model not loaded. Call load_model() first.".into())
        })?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });

        params.set_n_threads(self.config.n_threads as i32);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_suppress_blank(true);
        params.set_suppress_non_speech_tokens(true);

        if let Some(ref lang) = self.config.language {
            params.set_language(Some(lang));
        }
        params.set_translate(self.config.translate);

        if let Some(prompt) = self.dictionary.build_whisper_prompt() {
            params.set_initial_prompt(&prompt);
            info!(
                word_count = self.dictionary.len(),
                "Applied dictionary prompt for word boosting"
            );
        }

        info!(
            samples = samples.len(),
            duration_seconds = samples.len() as f64 / 16000.0,
            "Starting Whisper transcription"
        );

        let mut state = ctx.create_state().map_err(|e| {
            IronMicError::Audio(format!("Failed to create Whisper state: {e}"))
        })?;

        state.full(params, samples).map_err(|e| {
            IronMicError::Audio(format!("Whisper transcription failed: {e}"))
        })?;

        let num_segments = state.full_n_segments().map_err(|e| {
            IronMicError::Audio(format!("Failed to get segment count: {e}"))
        })?;

        let mut transcript = String::new();
        for i in 0..num_segments {
            if let Ok(text) = state.full_get_segment_text(i) {
                transcript.push_str(&text);
            }
        }

        let transcript = transcript.trim().to_string();
        info!(
            segments = num_segments,
            chars = transcript.len(),
            "Transcription complete"
        );

        Ok(transcript)
    }

    #[cfg(not(feature = "whisper"))]
    fn transcribe_stub(&self, samples: &[f32]) -> Result<String, IronMicError> {
        if !self._loaded {
            return Err(IronMicError::Audio(
                "Whisper model not loaded. Call load_model() first.".into(),
            ));
        }

        let duration = samples.len() as f64 / 16000.0;
        info!(
            samples = samples.len(),
            duration_seconds = duration,
            "Stub transcription (whisper feature not enabled)"
        );

        Ok(format!(
            "[stub transcription: {:.1}s of audio, {} samples]",
            duration,
            samples.len()
        ))
    }
}

/// A thread-safe wrapper around WhisperEngine for use from N-API.
pub struct SharedWhisperEngine {
    inner: Arc<Mutex<WhisperEngine>>,
}

impl SharedWhisperEngine {
    pub fn new(engine: WhisperEngine) -> Self {
        Self {
            inner: Arc::new(Mutex::new(engine)),
        }
    }

    pub fn load_model(&self) -> Result<(), IronMicError> {
        let mut engine = self.inner.lock().unwrap();
        engine.load_model()
    }

    pub fn is_loaded(&self) -> bool {
        let engine = self.inner.lock().unwrap();
        engine.is_loaded()
    }

    pub fn transcribe(&self, samples: &[f32]) -> Result<String, IronMicError> {
        let engine = self.inner.lock().unwrap();
        engine.transcribe(samples)
    }

    pub fn dictionary(&self) -> Dictionary {
        let engine = self.inner.lock().unwrap();
        engine.dictionary().clone()
    }

    pub fn add_dictionary_word(&self, word: &str) {
        let engine = self.inner.lock().unwrap();
        engine.dictionary().add_word(word);
    }

    pub fn remove_dictionary_word(&self, word: &str) -> bool {
        let engine = self.inner.lock().unwrap();
        engine.dictionary().remove_word(word)
    }

    pub fn model_path(&self) -> PathBuf {
        let engine = self.inner.lock().unwrap();
        engine.model_path().to_path_buf()
    }

    pub fn set_model(&self, model_id: &str) -> Result<(), IronMicError> {
        let mut engine = self.inner.lock().unwrap();
        engine.set_model(model_id)?;
        engine.load_model()
    }

    pub fn set_use_gpu(&self, use_gpu: bool) -> Result<(), IronMicError> {
        let mut engine = self.inner.lock().unwrap();
        engine.set_use_gpu(use_gpu);
        if engine.model_exists() {
            engine.load_model()?;
        }
        Ok(())
    }

    pub fn use_gpu(&self) -> bool {
        let engine = self.inner.lock().unwrap();
        engine.config().use_gpu
    }

    pub fn current_model_id(&self) -> String {
        let engine = self.inner.lock().unwrap();
        let path = engine.model_path();
        let filename = path.file_name().unwrap_or_default().to_string_lossy();
        available_models()
            .iter()
            .find(|m| m.filename == filename.as_ref())
            .map(|m| m.id.clone())
            .unwrap_or_else(|| "large-v3-turbo".into())
    }
}

impl Clone for SharedWhisperEngine {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config() {
        let config = WhisperConfig::default();
        assert_eq!(config.language, Some("en".to_string()));
        assert!(!config.translate);
        assert!(config.n_threads > 0);
        assert!(!config.use_gpu);
    }

    #[test]
    fn engine_not_loaded_initially() {
        let engine = WhisperEngine::with_defaults();
        assert!(!engine.is_loaded());
    }

    #[test]
    fn engine_model_not_found() {
        let mut engine = WhisperEngine::new(
            WhisperConfig {
                model_path: PathBuf::from("/nonexistent/model.bin"),
                ..Default::default()
            },
            Dictionary::new(),
        );
        let result = engine.load_model();
        #[cfg(feature = "whisper")]
        assert!(result.is_err());
        #[cfg(not(feature = "whisper"))]
        assert!(result.is_ok());
    }

    #[test]
    fn engine_transcribe_without_loading_errors() {
        let engine = WhisperEngine::with_defaults();
        let samples = vec![0.0f32; 16000];
        let result = engine.transcribe(&samples);
        assert!(result.is_err());
    }

    #[test]
    fn engine_transcribe_empty_samples_errors() {
        let engine = WhisperEngine::with_defaults();
        let result = engine.transcribe(&[]);
        assert!(result.is_err());
    }

    #[test]
    fn engine_model_exists_false() {
        let config = WhisperConfig {
            model_path: PathBuf::from("/nonexistent/model.bin"),
            ..Default::default()
        };
        let engine = WhisperEngine::new(config, Dictionary::new());
        assert!(!engine.model_exists());
    }

    #[test]
    fn engine_dictionary_integration() {
        let dict = Dictionary::new();
        dict.add_word("IronMic");
        dict.add_word("Kubernetes");

        let engine = WhisperEngine::new(WhisperConfig::default(), dict);
        assert_eq!(engine.dictionary().len(), 2);
    }

    #[test]
    fn shared_engine_clone() {
        let engine = WhisperEngine::with_defaults();
        let shared = SharedWhisperEngine::new(engine);
        let cloned = shared.clone();

        shared.add_dictionary_word("test");
        assert_eq!(cloned.dictionary().len(), 1);
    }

    #[test]
    fn shared_engine_dictionary_ops() {
        let engine = WhisperEngine::with_defaults();
        let shared = SharedWhisperEngine::new(engine);

        shared.add_dictionary_word("Rust");
        shared.add_dictionary_word("Whisper");
        assert_eq!(shared.dictionary().len(), 2);

        assert!(shared.remove_dictionary_word("Rust"));
        assert_eq!(shared.dictionary().len(), 1);
    }

    #[test]
    fn available_models_list() {
        let models = available_models();
        assert!(models.len() >= 4);
        assert_eq!(models[0].id, "large-v3-turbo");
    }

    #[test]
    fn gpu_available_check() {
        // Just ensure it doesn't panic
        let _ = gpu_available();
    }

    #[test]
    fn set_model_unknown_errors() {
        let mut engine = WhisperEngine::with_defaults();
        assert!(engine.set_model("nonexistent-model").is_err());
    }
}
