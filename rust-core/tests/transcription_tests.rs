use ironmic_core::transcription::dictionary::Dictionary;
use ironmic_core::transcription::whisper::{SharedWhisperEngine, WhisperConfig, WhisperEngine};
use std::path::PathBuf;

// ── Dictionary Tests ──

#[test]
fn dictionary_new_is_empty() {
    let dict = Dictionary::new();
    assert!(dict.is_empty());
    assert_eq!(dict.len(), 0);
    assert_eq!(dict.list_words().len(), 0);
}

#[test]
fn dictionary_add_and_list() {
    let dict = Dictionary::new();
    dict.add_word("Kubernetes");
    dict.add_word("gRPC");
    dict.add_word("PostgreSQL");

    assert_eq!(dict.len(), 3);

    let words = dict.list_words();
    assert_eq!(words, vec!["Kubernetes", "PostgreSQL", "gRPC"]);
}

#[test]
fn dictionary_duplicates_ignored() {
    let dict = Dictionary::new();
    dict.add_word("Rust");
    dict.add_word("Rust");
    dict.add_word("Rust");
    assert_eq!(dict.len(), 1);
}

#[test]
fn dictionary_empty_and_whitespace_ignored() {
    let dict = Dictionary::new();
    dict.add_word("");
    dict.add_word("   ");
    dict.add_word("\t");
    assert!(dict.is_empty());
}

#[test]
fn dictionary_remove() {
    let dict = Dictionary::new();
    dict.add_word("IronMic");
    dict.add_word("Whisper");

    assert!(dict.remove_word("IronMic"));
    assert_eq!(dict.len(), 1);
    assert!(!dict.remove_word("IronMic")); // already removed
}

#[test]
fn dictionary_remove_nonexistent() {
    let dict = Dictionary::new();
    assert!(!dict.remove_word("nothing"));
}

#[test]
fn dictionary_with_words() {
    let dict = Dictionary::with_words(vec![
        "alpha".into(),
        "beta".into(),
        "gamma".into(),
    ]);
    assert_eq!(dict.len(), 3);
}

#[test]
fn dictionary_whisper_prompt_empty() {
    let dict = Dictionary::new();
    assert!(dict.build_whisper_prompt().is_none());
}

#[test]
fn dictionary_whisper_prompt() {
    let dict = Dictionary::new();
    dict.add_word("IronMic");
    dict.add_word("Whisper");

    let prompt = dict.build_whisper_prompt().unwrap();
    assert!(prompt.contains("IronMic"));
    assert!(prompt.contains("Whisper"));
    // Should be comma-separated
    assert!(prompt.contains(", "));
}

#[test]
fn dictionary_clone_shares_state() {
    let dict = Dictionary::new();
    let cloned = dict.clone();

    dict.add_word("shared");
    assert_eq!(cloned.len(), 1);
}

// ── WhisperEngine Tests ──

#[test]
fn whisper_engine_defaults() {
    let engine = WhisperEngine::with_defaults();
    assert!(!engine.is_loaded());
    // model_exists depends on whether the model file is on disk — don't assert either way
}

#[test]
fn whisper_engine_custom_config() {
    let config = WhisperConfig {
        model_path: PathBuf::from("/tmp/test-model.bin"),
        language: Some("fr".into()),
        translate: true,
        n_threads: 2,
        use_gpu: false,
    };
    let engine = WhisperEngine::new(config.clone(), Dictionary::new());
    assert_eq!(engine.model_path(), PathBuf::from("/tmp/test-model.bin"));
    assert!(!engine.is_loaded());
}

#[test]
fn whisper_engine_load_missing_model() {
    let config = WhisperConfig {
        model_path: PathBuf::from("/nonexistent/path/model.bin"),
        ..Default::default()
    };
    let mut engine = WhisperEngine::new(config, Dictionary::new());
    let result = engine.load_model();
    #[cfg(feature = "whisper")]
    {
        assert!(result.is_err());
        assert!(!engine.is_loaded());
    }
    #[cfg(not(feature = "whisper"))]
    {
        assert!(result.is_ok());
        assert!(engine.is_loaded());
    }
}

#[test]
fn whisper_engine_transcribe_without_model() {
    let engine = WhisperEngine::with_defaults();
    let samples = vec![0.0f32; 16000];
    let result = engine.transcribe(&samples);
    assert!(result.is_err());
}

#[test]
fn whisper_engine_transcribe_empty_samples() {
    let engine = WhisperEngine::with_defaults();
    let result = engine.transcribe(&[]);
    assert!(result.is_err());
}

#[test]
fn whisper_engine_dictionary_access() {
    let dict = Dictionary::new();
    dict.add_word("test");
    let engine = WhisperEngine::new(WhisperConfig::default(), dict);
    assert_eq!(engine.dictionary().len(), 1);
}

#[test]
fn whisper_engine_dictionary_mutation() {
    let mut engine = WhisperEngine::with_defaults();
    engine.dictionary_mut().add_word("mutated");
    // The dictionary is cloned internally, so the original isn't affected
    // but the engine's reference is updated
    let _ = engine.dictionary().len(); // just checking no panic
}

// ── SharedWhisperEngine Tests ──

#[test]
fn shared_whisper_engine_basic() {
    let engine = WhisperEngine::with_defaults();
    let shared = SharedWhisperEngine::new(engine);
    assert!(!shared.is_loaded());
}

#[test]
fn shared_whisper_engine_dictionary_ops() {
    let engine = WhisperEngine::with_defaults();
    let shared = SharedWhisperEngine::new(engine);

    shared.add_dictionary_word("Kubernetes");
    shared.add_dictionary_word("Docker");

    let dict = shared.dictionary();
    assert_eq!(dict.len(), 2);

    assert!(shared.remove_dictionary_word("Docker"));
    assert_eq!(shared.dictionary().len(), 1);
}

#[test]
fn shared_whisper_engine_clone_shares_state() {
    let engine = WhisperEngine::with_defaults();
    let shared = SharedWhisperEngine::new(engine);
    let cloned = shared.clone();

    shared.add_dictionary_word("shared_word");
    assert_eq!(cloned.dictionary().len(), 1);
}

#[test]
fn shared_whisper_engine_model_path() {
    let engine = WhisperEngine::with_defaults();
    let shared = SharedWhisperEngine::new(engine);
    let path = shared.model_path();
    assert!(path.ends_with("models/whisper-large-v3-turbo.bin"));
    assert!(path.is_absolute());
}

#[test]
fn shared_whisper_engine_load_missing() {
    let engine = WhisperEngine::with_defaults();
    let shared = SharedWhisperEngine::new(engine);
    let result = shared.load_model();
    #[cfg(feature = "whisper")]
    assert!(result.is_err());
    #[cfg(not(feature = "whisper"))]
    assert!(result.is_ok());
}
