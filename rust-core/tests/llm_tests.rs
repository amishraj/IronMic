use ironmic_core::llm::cleanup::{LlmConfig, LlmEngine, SharedLlmEngine};
use ironmic_core::llm::prompts;
use std::path::PathBuf;

// ── Prompts Tests ──

#[test]
fn system_prompt_contains_cleanup_rules() {
    assert!(prompts::CLEANUP_SYSTEM_PROMPT.contains("Fix grammar"));
    assert!(prompts::CLEANUP_SYSTEM_PROMPT.contains("Remove filler words"));
    assert!(prompts::CLEANUP_SYSTEM_PROMPT.contains("um, uh, like"));
    assert!(prompts::CLEANUP_SYSTEM_PROMPT.contains("Do NOT add information"));
    assert!(prompts::CLEANUP_SYSTEM_PROMPT.contains("Do NOT summarize"));
    assert!(prompts::CLEANUP_SYSTEM_PROMPT.contains("Output ONLY the cleaned text"));
}

#[test]
fn build_cleanup_prompt_includes_transcript() {
    let prompt = prompts::build_cleanup_prompt("um so basically I think we should refactor");
    assert!(prompt.starts_with(prompts::CLEANUP_SYSTEM_PROMPT));
    assert!(prompt.contains("Input transcript:"));
    assert!(prompt.contains("um so basically I think we should refactor"));
}

#[test]
fn build_cleanup_prompt_empty_input() {
    let prompt = prompts::build_cleanup_prompt("");
    assert!(prompt.contains("Input transcript:\n"));
}

// ── LlmConfig Tests ──

#[test]
fn default_config() {
    let config = LlmConfig::default();
    assert!(config.model_path.ends_with("models/mistral-7b-instruct-q4_k_m.gguf"));
    assert!(config.model_path.is_absolute());
    assert_eq!(config.max_tokens, 2048);
    assert!(config.temperature > 0.0 && config.temperature < 1.0);
    assert!(config.n_threads > 0);
    assert_eq!(config.n_gpu_layers, 0);
}

// ── LlmEngine Tests ──

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
    // Without llm feature: missing model falls back to stub (Ok)
    // With llm feature: missing model is a hard error
    #[cfg(feature = "llm")]
    {
        assert!(result.is_err());
        assert!(!engine.is_loaded());
    }
    #[cfg(not(feature = "llm"))]
    {
        assert!(result.is_ok());
        assert!(engine.is_loaded());
    }
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
    let result = engine.polish_text("").unwrap();
    assert!(result.is_empty());
}

#[test]
fn engine_polish_whitespace_returns_empty() {
    let engine = LlmEngine::with_defaults();
    let result = engine.polish_text("   \n  ").unwrap();
    assert!(result.is_empty());
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
fn engine_model_path() {
    let engine = LlmEngine::with_defaults();
    let path = engine.model_path();
    assert!(path.ends_with("models/mistral-7b-instruct-q4_k_m.gguf"));
    assert!(path.is_absolute());
}

// ── SharedLlmEngine Tests ──

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
    let cloned = shared.clone();
    // Both reference the same inner state
    assert!(!shared.is_loaded());
    assert!(!cloned.is_loaded());
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

#[test]
fn shared_engine_polish_without_model() {
    let engine = LlmEngine::with_defaults();
    let shared = SharedLlmEngine::new(engine);
    // Without llm feature + no model: load_model succeeds (stub), polish returns passthrough
    #[cfg(not(feature = "llm"))]
    {
        shared.load_model().unwrap();
        let result = shared.polish_text("test");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "test");
    }
    #[cfg(feature = "llm")]
    {
        let result = shared.polish_text("test");
        assert!(result.is_err());
    }
}
