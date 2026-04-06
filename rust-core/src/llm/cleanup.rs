use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tracing::{info, warn};

use crate::error::IronMicError;
#[cfg(feature = "llm")]
use crate::llm::prompts;

/// Default model filename.
const DEFAULT_MODEL_FILENAME: &str = "mistral-7b-instruct-q4_k_m.gguf";

/// Resolve the default model path using compile-time manifest dir.
fn default_model_path() -> std::path::PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    std::path::PathBuf::from(manifest_dir).join("models").join(DEFAULT_MODEL_FILENAME)
}

/// Configuration for the LLM cleanup engine.
#[derive(Clone, Debug)]
pub struct LlmConfig {
    /// Path to the GGUF model file.
    pub model_path: PathBuf,
    /// Maximum number of tokens to generate.
    pub max_tokens: u32,
    /// Temperature for sampling (lower = more deterministic).
    pub temperature: f32,
    /// Number of threads for inference.
    pub n_threads: u32,
    /// Number of GPU layers to offload (0 = CPU only).
    pub n_gpu_layers: u32,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            model_path: default_model_path(),
            max_tokens: 2048,
            temperature: 0.1,
            n_threads: num_cpus(),
            n_gpu_layers: 0,
        }
    }
}

fn num_cpus() -> u32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(4)
}

/// The LLM cleanup engine for polishing raw transcripts.
///
/// When compiled with the `llm` feature, this wraps llama-cpp-rs for real inference.
/// Without the feature, it provides a stub that passes through the raw text.
pub struct LlmEngine {
    config: LlmConfig,
    #[cfg(feature = "llm")]
    model: Option<llama_cpp_rs::LlamaModel>,
    #[cfg(not(feature = "llm"))]
    _loaded: bool,
}

unsafe impl Send for LlmEngine {}

impl LlmEngine {
    /// Create a new LlmEngine with the given configuration.
    pub fn new(config: LlmConfig) -> Self {
        Self {
            config,
            #[cfg(feature = "llm")]
            model: None,
            #[cfg(not(feature = "llm"))]
            _loaded: false,
        }
    }

    /// Create an LlmEngine with default configuration.
    pub fn with_defaults() -> Self {
        Self::new(LlmConfig::default())
    }

    /// Check if the model file exists at the configured path.
    pub fn model_exists(&self) -> bool {
        self.config.model_path.exists()
    }

    /// Get the configured model path.
    pub fn model_path(&self) -> &Path {
        &self.config.model_path
    }

    /// Check if the model is loaded and ready for inference.
    pub fn is_loaded(&self) -> bool {
        #[cfg(feature = "llm")]
        {
            self.model.is_some()
        }
        #[cfg(not(feature = "llm"))]
        {
            self._loaded
        }
    }

    /// Load the LLM model from disk.
    pub fn load_model(&mut self) -> Result<(), IronMicError> {
        let model_path = &self.config.model_path;

        if !model_path.exists() {
            warn!(
                path = %model_path.display(),
                "LLM model file not found. Production builds must bundle the model."
            );

            #[cfg(feature = "llm")]
            {
                return Err(IronMicError::Llm(format!(
                    "Model file not found: {}. Download it to this path for development.",
                    model_path.display()
                )));
            }

            #[cfg(not(feature = "llm"))]
            {
                warn!("LLM feature not enabled — using stub polish (passthrough)");
                self._loaded = true;
                return Ok(());
            }
        }

        info!(path = %model_path.display(), "Loading LLM model");

        #[cfg(feature = "llm")]
        {
            use llama_cpp_rs::{LlamaModel, LlamaParams};
            let mut params = LlamaParams::default();
            params.n_gpu_layers = self.config.n_gpu_layers as i32;

            let model = LlamaModel::load_from_file(
                model_path.to_str().ok_or_else(|| {
                    IronMicError::Llm("Invalid model path encoding".into())
                })?,
                params,
            )
            .map_err(|e| IronMicError::Llm(format!("Failed to load LLM model: {e}")))?;

            self.model = Some(model);
            info!("LLM model loaded successfully");
        }

        #[cfg(not(feature = "llm"))]
        {
            warn!("LLM feature not enabled — model loading is a no-op");
            self._loaded = true;
        }

        Ok(())
    }

    /// Polish raw transcript text using the local LLM.
    ///
    /// Returns the cleaned-up version of the text.
    pub fn polish_text(&self, raw_transcript: &str) -> Result<String, IronMicError> {
        if raw_transcript.trim().is_empty() {
            return Ok(String::new());
        }

        #[cfg(feature = "llm")]
        {
            self.polish_with_llm(raw_transcript)
        }

        #[cfg(not(feature = "llm"))]
        {
            self.polish_stub(raw_transcript)
        }
    }

    /// Real LLM polishing via llama-cpp-rs.
    #[cfg(feature = "llm")]
    fn polish_with_llm(&self, raw_transcript: &str) -> Result<String, IronMicError> {
        use llama_cpp_rs::SessionParams;

        let model = self.model.as_ref().ok_or_else(|| {
            IronMicError::Llm("LLM model not loaded. Call load_model() first.".into())
        })?;

        let prompt = prompts::build_cleanup_prompt(raw_transcript);

        info!(
            input_chars = raw_transcript.len(),
            "Starting LLM text cleanup"
        );

        let mut session_params = SessionParams::default();
        session_params.n_ctx = 4096;

        let mut session = model
            .create_session(session_params)
            .map_err(|e| IronMicError::Llm(format!("Failed to create LLM session: {e}")))?;

        session
            .advance_context(&prompt)
            .map_err(|e| IronMicError::Llm(format!("Failed to set context: {e}")))?;

        let mut output = String::new();
        let max_tokens = self.config.max_tokens as usize;

        for _ in 0..max_tokens {
            let token = session
                .start_completing()
                .map_err(|e| IronMicError::Llm(format!("Completion error: {e}")))?;

            if let Some(text) = token {
                output.push_str(&text);
            } else {
                break;
            }
        }

        let polished = output.trim().to_string();
        info!(
            input_chars = raw_transcript.len(),
            output_chars = polished.len(),
            "LLM text cleanup complete"
        );

        Ok(polished)
    }

    /// Stub polishing when LLM feature is not enabled.
    /// Returns the raw transcript as-is with a note.
    #[cfg(not(feature = "llm"))]
    fn polish_stub(&self, raw_transcript: &str) -> Result<String, IronMicError> {
        if !self._loaded {
            return Err(IronMicError::Llm(
                "LLM model not loaded. Call load_model() first.".into(),
            ));
        }

        info!(
            input_chars = raw_transcript.len(),
            "Stub polish (llm feature not enabled)"
        );

        // In stub mode, return the raw text unchanged
        Ok(raw_transcript.to_string())
    }
}

/// Thread-safe wrapper around LlmEngine for use from N-API.
pub struct SharedLlmEngine {
    inner: Arc<Mutex<LlmEngine>>,
}

impl SharedLlmEngine {
    pub fn new(engine: LlmEngine) -> Self {
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

    pub fn polish_text(&self, raw_transcript: &str) -> Result<String, IronMicError> {
        let engine = self.inner.lock().unwrap();
        engine.polish_text(raw_transcript)
    }

    pub fn model_path(&self) -> PathBuf {
        let engine = self.inner.lock().unwrap();
        engine.model_path().to_path_buf()
    }
}

impl Clone for SharedLlmEngine {
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
        let config = LlmConfig::default();
        assert_eq!(config.model_path, default_model_path());
        assert_eq!(config.max_tokens, 2048);
        assert!(config.temperature > 0.0);
        assert!(config.n_threads > 0);
    }

    #[test]
    fn engine_not_loaded_initially() {
        let engine = LlmEngine::with_defaults();
        assert!(!engine.is_loaded());
    }

    #[test]
    fn engine_model_not_found() {
        let mut engine = LlmEngine::new(LlmConfig {
            model_path: PathBuf::from("/nonexistent/model.gguf"),
            ..Default::default()
        });
        let result = engine.load_model();
        #[cfg(feature = "llm")]
        assert!(result.is_err());
        #[cfg(not(feature = "llm"))]
        assert!(result.is_ok());
    }

    #[test]
    fn engine_polish_without_loading_errors() {
        let engine = LlmEngine::with_defaults();
        let result = engine.polish_text("test text");
        assert!(result.is_err());
    }

    #[test]
    fn engine_polish_empty_returns_empty() {
        let engine = LlmEngine::with_defaults();
        let result = engine.polish_text("");
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[test]
    fn engine_polish_whitespace_returns_empty() {
        let engine = LlmEngine::with_defaults();
        let result = engine.polish_text("   \n\t  ");
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[test]
    fn engine_model_exists_with_bad_path() {
        let engine = LlmEngine::new(LlmConfig {
            model_path: std::path::PathBuf::from("/nonexistent/model.gguf"),
            ..Default::default()
        });
        assert!(!engine.model_exists());
    }

    #[test]
    fn shared_engine_basic() {
        let engine = LlmEngine::with_defaults();
        let shared = SharedLlmEngine::new(engine);
        assert!(!shared.is_loaded());
    }

    #[test]
    fn shared_engine_clone_shares_state() {
        let engine = LlmEngine::with_defaults();
        let shared = SharedLlmEngine::new(engine);
        let _cloned = shared.clone();
        assert!(!shared.is_loaded());
    }

    #[test]
    fn shared_engine_model_path() {
        let engine = LlmEngine::with_defaults();
        let shared = SharedLlmEngine::new(engine);
        let path = shared.model_path();
        assert!(path.ends_with("models/mistral-7b-instruct-q4_k_m.gguf"));
        assert!(path.is_absolute());
    }

    #[test]
    fn shared_engine_load_missing() {
        let engine = LlmEngine::with_defaults();
        let shared = SharedLlmEngine::new(engine);
        let result = shared.load_model();
        #[cfg(feature = "llm")]
        assert!(result.is_err());
        #[cfg(not(feature = "llm"))]
        assert!(result.is_ok());
    }
}
