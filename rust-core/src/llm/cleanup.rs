use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tracing::{info, warn};

use crate::error::IronMicError;
use crate::llm::chat::{ChatMessage, ChatModel};
#[cfg(any(feature = "llm", feature = "llm-bin"))]
use crate::llm::prompts;

/// Default model filename.
const DEFAULT_MODEL_FILENAME: &str = "mistral-7b-instruct-q4_k_m.gguf";

/// Resolve the default model path.
pub fn default_model_path() -> std::path::PathBuf {
    let base = if let Ok(dir) = std::env::var("IRONMIC_MODELS_DIR") {
        std::path::PathBuf::from(dir)
    } else {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        std::path::PathBuf::from(manifest_dir).join("models")
    };
    base.join(DEFAULT_MODEL_FILENAME)
}

/// Configuration for the LLM cleanup engine.
#[derive(Clone, Debug)]
pub struct LlmConfig {
    pub model_path: PathBuf,
    pub max_tokens: u32,
    pub temperature: f32,
    pub n_threads: u32,
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

/// Global shared backend — llama-cpp-2 only allows one init per process.
#[cfg(any(feature = "llm", feature = "llm-bin"))]
static LLAMA_BACKEND: std::sync::LazyLock<
    Result<llama_cpp_2::llama_backend::LlamaBackend, String>,
> = std::sync::LazyLock::new(|| {
    llama_cpp_2::llama_backend::LlamaBackend::init()
        .map_err(|e| format!("{e}"))
});

#[cfg(any(feature = "llm", feature = "llm-bin"))]
fn get_backend() -> Result<&'static llama_cpp_2::llama_backend::LlamaBackend, IronMicError> {
    LLAMA_BACKEND
        .as_ref()
        .map_err(|e| IronMicError::Llm(format!("Failed to init llama backend: {e}")))
}

/// The LLM engine for polishing and chat.
pub struct LlmEngine {
    config: LlmConfig,
    #[cfg(any(feature = "llm", feature = "llm-bin"))]
    loaded: Option<llama_cpp_2::model::LlamaModel>,
    #[cfg(not(any(feature = "llm", feature = "llm-bin")))]
    _loaded: bool,
}

unsafe impl Send for LlmEngine {}

impl LlmEngine {
    pub fn new(config: LlmConfig) -> Self {
        Self {
            config,
            #[cfg(any(feature = "llm", feature = "llm-bin"))]
            loaded: None,
            #[cfg(not(any(feature = "llm", feature = "llm-bin")))]
            _loaded: false,
        }
    }

    pub fn with_defaults() -> Self {
        Self::new(LlmConfig::default())
    }

    pub fn model_exists(&self) -> bool {
        self.config.model_path.exists()
    }

    pub fn model_path(&self) -> &Path {
        &self.config.model_path
    }

    pub fn is_loaded(&self) -> bool {
        #[cfg(any(feature = "llm", feature = "llm-bin"))]
        { self.loaded.is_some() }
        #[cfg(not(any(feature = "llm", feature = "llm-bin")))]
        { self._loaded }
    }

    pub fn load_model(&mut self) -> Result<(), IronMicError> {
        let model_path = &self.config.model_path;

        if !model_path.exists() {
            warn!(path = %model_path.display(), "LLM model file not found");

            #[cfg(any(feature = "llm", feature = "llm-bin"))]
            {
                return Err(IronMicError::Llm(format!(
                    "Model file not found: {}",
                    model_path.display()
                )));
            }

            #[cfg(not(any(feature = "llm", feature = "llm-bin")))]
            {
                self._loaded = true;
                return Ok(());
            }
        }

        info!(path = %model_path.display(), "Loading LLM model");

        #[cfg(any(feature = "llm", feature = "llm-bin"))]
        {
            use llama_cpp_2::model::params::LlamaModelParams;

            let backend = get_backend()?;

            let mut model_params = LlamaModelParams::default();
            model_params = model_params.with_n_gpu_layers(self.config.n_gpu_layers);

            let model = llama_cpp_2::model::LlamaModel::load_from_file(
                backend,
                model_path,
                &model_params,
            )
            .map_err(|e| IronMicError::Llm(format!("Failed to load LLM model: {e}")))?;

            self.loaded = Some(model);
            info!("LLM model loaded successfully");
        }

        #[cfg(not(any(feature = "llm", feature = "llm-bin")))]
        {
            warn!("LLM feature not enabled — model loading is a no-op");
            self._loaded = true;
        }

        Ok(())
    }

    pub fn load_model_from_path(&mut self, path: &Path) -> Result<(), IronMicError> {
        self.unload_model();
        self.config.model_path = path.to_path_buf();
        self.load_model()
    }

    pub fn unload_model(&mut self) {
        #[cfg(any(feature = "llm", feature = "llm-bin"))]
        {
            if self.loaded.is_some() {
                info!("Unloading LLM model");
                self.loaded = None;
            }
        }
        #[cfg(not(any(feature = "llm", feature = "llm-bin")))]
        { self._loaded = false; }
    }

    /// Run inference on a prompt string and return the generated text.
    #[cfg(any(feature = "llm", feature = "llm-bin"))]
    pub fn generate(
        &self,
        prompt: &str,
        max_tokens: u32,
        temperature: f32,
        on_token: Option<&dyn Fn(&str)>,
    ) -> Result<String, IronMicError> {
        use std::num::NonZeroU32;
        use llama_cpp_2::context::params::LlamaContextParams;
        use llama_cpp_2::llama_batch::LlamaBatch;
        use llama_cpp_2::sampling::LlamaSampler;
        use llama_cpp_2::model::AddBos;

        let loaded = self.loaded.as_ref().ok_or_else(|| {
            IronMicError::Llm("LLM model not loaded. Call load_model() first.".into())
        })?;

        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(4096))
            .with_n_threads(self.config.n_threads as i32)
            .with_n_threads_batch(self.config.n_threads as i32);

        let backend = get_backend()?;
        let mut ctx = loaded.new_context(backend, ctx_params)
            .map_err(|e| IronMicError::Llm(format!("Failed to create context: {e}")))?;

        // Tokenize the prompt
        let tokens = loaded.str_to_token(prompt, AddBos::Always)
            .map_err(|e| IronMicError::Llm(format!("Tokenization failed: {e}")))?;

        let n_tokens = tokens.len();
        if n_tokens == 0 {
            return Ok(String::new());
        }

        // Create batch and add prompt tokens
        let mut batch = LlamaBatch::new(ctx.n_batch() as usize, 1);
        let last_idx = (n_tokens - 1) as i32;

        for (i, &token) in tokens.iter().enumerate() {
            let is_last = i as i32 == last_idx;
            batch.add(token, i as i32, &[0], is_last)
                .map_err(|e| IronMicError::Llm(format!("Batch add failed: {e}")))?;
        }

        // Decode the prompt
        ctx.decode(&mut batch)
            .map_err(|e| IronMicError::Llm(format!("Prompt decode failed: {e}")))?;

        // Set up sampler with temperature
        let sampler = LlamaSampler::chain_simple([
            LlamaSampler::temp(temperature),
            LlamaSampler::dist(1234),
        ]);
        let mut sampler = sampler;

        // Generate tokens
        let mut output = String::new();
        let mut n_cur = n_tokens as i32;

        for _ in 0..max_tokens {
            let new_token = sampler.sample(&ctx, -1);

            // Check for end of generation
            if loaded.is_eog_token(new_token) {
                break;
            }

            let piece_bytes = loaded.token_to_piece_bytes(new_token, 128, true, None)
                .map_err(|e| IronMicError::Llm(format!("Token to bytes failed: {e}")))?;
            let piece = String::from_utf8_lossy(&piece_bytes).to_string();

            if let Some(cb) = on_token {
                cb(&piece);
            }
            output.push_str(&piece);

            // Prepare next batch
            batch.clear();
            batch.add(new_token, n_cur, &[0], true)
                .map_err(|e| IronMicError::Llm(format!("Batch add failed: {e}")))?;
            n_cur += 1;

            ctx.decode(&mut batch)
                .map_err(|e| IronMicError::Llm(format!("Decode failed: {e}")))?;
        }

        Ok(output.trim().to_string())
    }

    /// Build a chat prompt using the model's built-in template, or fall back to manual formatting.
    #[cfg(any(feature = "llm", feature = "llm-bin"))]
    pub fn build_chat_prompt(&self, messages: &[ChatMessage], model_type: &ChatModel) -> Result<String, IronMicError> {
        use llama_cpp_2::model::LlamaChatMessage;
        use crate::llm::chat::format_chat_prompt;

        let loaded = self.loaded.as_ref().ok_or_else(|| {
            IronMicError::Llm("LLM model not loaded".into())
        })?;

        // Try the model's built-in chat template first
        if let Ok(template) = loaded.chat_template(None) {
            let chat_messages: Vec<LlamaChatMessage> = messages
                .iter()
                .filter_map(|m| LlamaChatMessage::new(m.role.clone(), m.content.clone()).ok())
                .collect();

            if let Ok(prompt) = loaded.apply_chat_template(&template, &chat_messages, true) {
                return Ok(prompt);
            }
        }

        // Fall back to manual template formatting
        Ok(format_chat_prompt(model_type, messages))
    }

    // ── Public API ──

    pub fn chat_complete(
        &self,
        messages: &[ChatMessage],
        model_type: &ChatModel,
        max_tokens: u32,
    ) -> Result<String, IronMicError> {
        if messages.is_empty() {
            return Ok(String::new());
        }

        #[cfg(any(feature = "llm", feature = "llm-bin"))]
        {
            let prompt = self.build_chat_prompt(messages, model_type)?;
            info!(messages_count = messages.len(), prompt_chars = prompt.len(), "Starting LLM chat completion");
            let result = self.generate(&prompt, max_tokens, 0.3, None)?;
            info!(output_chars = result.len(), "LLM chat completion finished");
            Ok(result)
        }

        #[cfg(not(any(feature = "llm", feature = "llm-bin")))]
        {
            let _ = (model_type, max_tokens);
            self.chat_stub(messages)
        }
    }

    pub fn chat_complete_streaming(
        &self,
        messages: &[ChatMessage],
        model_type: &ChatModel,
        max_tokens: u32,
        on_token: Box<dyn Fn(String) -> bool + Send + 'static>,
    ) -> Result<String, IronMicError> {
        if messages.is_empty() {
            return Ok(String::new());
        }

        #[cfg(any(feature = "llm", feature = "llm-bin"))]
        {
            let prompt = self.build_chat_prompt(messages, model_type)?;
            info!(messages_count = messages.len(), prompt_chars = prompt.len(), "Starting LLM streaming chat");
            let callback = move |text: &str| { on_token(text.to_string()); };
            let result = self.generate(&prompt, max_tokens, 0.3, Some(&callback))?;
            info!(output_chars = result.len(), "LLM streaming chat finished");
            Ok(result)
        }

        #[cfg(not(any(feature = "llm", feature = "llm-bin")))]
        {
            let _ = (model_type, max_tokens, on_token);
            self.chat_stub(messages)
        }
    }

    pub fn polish_text(&self, raw_transcript: &str) -> Result<String, IronMicError> {
        if raw_transcript.trim().is_empty() {
            return Ok(String::new());
        }

        #[cfg(any(feature = "llm", feature = "llm-bin"))]
        {
            let prompt = prompts::build_cleanup_prompt(raw_transcript);
            info!(input_chars = raw_transcript.len(), "Starting LLM text cleanup");
            let result = self.generate(&prompt, self.config.max_tokens, self.config.temperature, None)?;
            info!(input_chars = raw_transcript.len(), output_chars = result.len(), "LLM text cleanup complete");
            Ok(result)
        }

        #[cfg(not(any(feature = "llm", feature = "llm-bin")))]
        { self.polish_stub(raw_transcript) }
    }

    #[cfg(not(any(feature = "llm", feature = "llm-bin")))]
    #[allow(unused_variables)]
    fn chat_stub(&self, messages: &[ChatMessage]) -> Result<String, IronMicError> {
        if !self._loaded {
            return Err(IronMicError::Llm("LLM model not loaded".into()));
        }
        let last_user = messages.iter().rev()
            .find(|m| m.role == "user")
            .map(|m| m.content.clone())
            .unwrap_or_default();
        Ok(format!("[LLM stub] Received: {}", last_user))
    }

    #[cfg(not(any(feature = "llm", feature = "llm-bin")))]
    fn polish_stub(&self, raw_transcript: &str) -> Result<String, IronMicError> {
        if !self._loaded {
            return Err(IronMicError::Llm("LLM model not loaded".into()));
        }
        Ok(raw_transcript.to_string())
    }
}

/// Thread-safe wrapper around LlmEngine for use from N-API.
pub struct SharedLlmEngine {
    inner: Arc<Mutex<LlmEngine>>,
}

impl SharedLlmEngine {
    pub fn new(engine: LlmEngine) -> Self {
        Self { inner: Arc::new(Mutex::new(engine)) }
    }

    pub fn load_model(&self) -> Result<(), IronMicError> {
        self.inner.lock().unwrap().load_model()
    }

    pub fn is_loaded(&self) -> bool {
        self.inner.lock().unwrap().is_loaded()
    }

    pub fn polish_text(&self, raw_transcript: &str) -> Result<String, IronMicError> {
        self.inner.lock().unwrap().polish_text(raw_transcript)
    }

    pub fn model_path(&self) -> PathBuf {
        self.inner.lock().unwrap().model_path().to_path_buf()
    }

    pub fn load_model_from_path(&self, path: &Path) -> Result<(), IronMicError> {
        self.inner.lock().unwrap().load_model_from_path(path)
    }

    pub fn unload_model(&self) {
        self.inner.lock().unwrap().unload_model();
    }

    pub fn chat_complete(
        &self,
        messages: &[ChatMessage],
        model_type: &ChatModel,
        max_tokens: u32,
    ) -> Result<String, IronMicError> {
        self.inner.lock().unwrap().chat_complete(messages, model_type, max_tokens)
    }

    pub fn chat_complete_streaming(
        &self,
        messages: &[ChatMessage],
        model_type: &ChatModel,
        max_tokens: u32,
        on_token: Box<dyn Fn(String) -> bool + Send + 'static>,
    ) -> Result<String, IronMicError> {
        self.inner.lock().unwrap().chat_complete_streaming(messages, model_type, max_tokens, on_token)
    }
}

impl Clone for SharedLlmEngine {
    fn clone(&self) -> Self {
        Self { inner: Arc::clone(&self.inner) }
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
        #[cfg(any(feature = "llm", feature = "llm-bin"))]
        assert!(result.is_err());
        #[cfg(not(any(feature = "llm", feature = "llm-bin")))]
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
            model_path: PathBuf::from("/nonexistent/model.gguf"),
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
        #[cfg(any(feature = "llm", feature = "llm-bin"))]
        assert!(result.is_err());
        #[cfg(not(any(feature = "llm", feature = "llm-bin")))]
        assert!(result.is_ok());
    }

    #[test]
    fn chat_complete_empty_messages() {
        let engine = LlmEngine::with_defaults();
        let result = engine.chat_complete(&[], &ChatModel::Mistral, 100);
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[test]
    fn chat_complete_without_loading_errors() {
        let engine = LlmEngine::with_defaults();
        let messages = vec![ChatMessage { role: "user".into(), content: "Hello".into() }];
        let result = engine.chat_complete(&messages, &ChatModel::Mistral, 100);
        assert!(result.is_err());
    }

    #[test]
    fn unload_model_resets_state() {
        let mut engine = LlmEngine::with_defaults();
        engine.unload_model();
        assert!(!engine.is_loaded());
    }

    #[test]
    fn load_model_from_bad_path_errors() {
        let mut engine = LlmEngine::with_defaults();
        let result = engine.load_model_from_path(Path::new("/nonexistent/model.gguf"));
        #[cfg(any(feature = "llm", feature = "llm-bin"))]
        assert!(result.is_err());
        #[cfg(not(any(feature = "llm", feature = "llm-bin")))]
        assert!(result.is_ok());
    }

    #[test]
    fn shared_engine_chat_complete() {
        let engine = LlmEngine::with_defaults();
        let shared = SharedLlmEngine::new(engine);
        let result = shared.chat_complete(&[], &ChatModel::Llama3, 100);
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }
}
