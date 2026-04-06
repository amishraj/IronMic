pub mod audio;
pub mod clipboard;
pub mod error;
pub mod hotkey;
pub mod llm;
pub mod storage;
pub mod transcription;
pub mod tts;

#[cfg(feature = "napi-export")]
mod napi_exports {
    use std::sync::Mutex;

    use napi::bindgen_prelude::*;
    use napi_derive::napi;
    use tracing::info;

    use crate::audio::capture::CaptureEngine;
    use crate::audio::processor;
    use crate::llm::cleanup::{LlmConfig, LlmEngine, SharedLlmEngine};
    use crate::transcription::dictionary::Dictionary;
    use crate::transcription::whisper::{SharedWhisperEngine, WhisperConfig, WhisperEngine};

    /// Global capture engine, protected by a mutex.
    static CAPTURE_ENGINE: std::sync::LazyLock<Mutex<CaptureEngine>> =
        std::sync::LazyLock::new(|| Mutex::new(CaptureEngine::new()));

    /// Global whisper engine.
    static WHISPER_ENGINE: std::sync::LazyLock<SharedWhisperEngine> =
        std::sync::LazyLock::new(|| {
            SharedWhisperEngine::new(WhisperEngine::new(
                WhisperConfig::default(),
                Dictionary::new(),
            ))
        });

    /// Global LLM engine.
    static LLM_ENGINE: std::sync::LazyLock<SharedLlmEngine> =
        std::sync::LazyLock::new(|| SharedLlmEngine::new(LlmEngine::with_defaults()));

    /// Initialize the tracing subscriber for structured logging.
    pub(crate) fn init_tracing() {
        use tracing_subscriber::EnvFilter;
        let _ = tracing_subscriber::fmt()
            .with_env_filter(
                EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
            )
            .try_init();
    }

    #[napi]
    pub fn start_recording() -> napi::Result<()> {
        init_tracing();
        info!("startRecording called from N-API");

        let mut engine = CAPTURE_ENGINE
            .lock()
            .map_err(|e| napi::Error::from_reason(format!("Lock poisoned: {e}")))?;

        engine.start().map_err(Into::into)
    }

    #[napi]
    pub fn stop_recording() -> napi::Result<Buffer> {
        info!("stopRecording called from N-API");

        let mut engine = CAPTURE_ENGINE
            .lock()
            .map_err(|e| napi::Error::from_reason(format!("Lock poisoned: {e}")))?;

        let mut captured = engine.stop().map_err(napi::Error::from)?;

        // Process to 16kHz mono PCM for Whisper
        let mut processed =
            processor::prepare_for_whisper(&captured).map_err(napi::Error::from)?;

        // Zero the raw captured audio immediately
        captured.zero();

        // Convert f32 to i16 PCM bytes for the Node.js side
        let pcm_i16 = processor::f32_to_i16_pcm(&processed.samples);

        // Zero processed audio
        processed.samples.fill(0.0);
        processed.samples.clear();

        // Convert i16 samples to bytes (little-endian)
        let mut bytes: Vec<u8> = Vec::with_capacity(pcm_i16.len() * 2);
        for sample in &pcm_i16 {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }

        info!(
            pcm_bytes = bytes.len(),
            duration_seconds = processed.duration_seconds,
            "Returning PCM buffer to Node.js"
        );

        Ok(bytes.into())
    }

    /// Check if currently recording.
    #[napi]
    pub fn is_recording() -> napi::Result<bool> {
        let engine = CAPTURE_ENGINE
            .lock()
            .map_err(|e| napi::Error::from_reason(format!("Lock poisoned: {e}")))?;
        Ok(engine.is_recording())
    }

    /// Force-reset recording to idle state. Used for error recovery.
    #[napi]
    pub fn reset_recording() -> napi::Result<()> {
        info!("resetRecording called from N-API");
        let mut engine = CAPTURE_ENGINE
            .lock()
            .map_err(|e| napi::Error::from_reason(format!("Lock poisoned: {e}")))?;
        engine.force_reset();
        Ok(())
    }

    /// Transcribe a PCM audio buffer (16kHz mono i16 little-endian) to text.
    #[napi]
    pub async fn transcribe(audio_buffer: Buffer) -> napi::Result<String> {
        init_tracing();
        info!("transcribe called from N-API");

        let whisper = WHISPER_ENGINE.clone();

        // Load model if not already loaded
        if !whisper.is_loaded() {
            whisper.load_model().map_err(napi::Error::from)?;
        }

        // Convert i16 LE bytes back to f32 samples
        let bytes: &[u8] = &audio_buffer;
        if bytes.len() % 2 != 0 {
            return Err(napi::Error::from_reason(
                "Audio buffer must contain 16-bit samples (even byte count)",
            ));
        }

        let mut samples: Vec<f32> = Vec::with_capacity(bytes.len() / 2);
        for chunk in bytes.chunks_exact(2) {
            let sample = i16::from_le_bytes([chunk[0], chunk[1]]);
            samples.push(sample as f32 / i16::MAX as f32);
        }

        let transcript = whisper
            .transcribe(&samples)
            .map_err(napi::Error::from)?;

        // Zero the sample buffer
        samples.fill(0.0);

        Ok(transcript)
    }

    /// Polish raw transcript text using the local LLM.
    #[napi]
    pub async fn polish_text(raw_text: String) -> napi::Result<String> {
        init_tracing();
        info!("polishText called from N-API");

        let llm = LLM_ENGINE.clone();

        // Load model if not already loaded
        if !llm.is_loaded() {
            llm.load_model().map_err(napi::Error::from)?;
        }

        llm.polish_text(&raw_text).map_err(napi::Error::from)
    }

    // ── Storage N-API exports ──

    use crate::storage::db::Database;
    use crate::storage::entries::{EntryStore, EntryUpdate, ListOptions, NewEntry};
    use crate::storage::dictionary::DictionaryStore;
    use crate::storage::settings::SettingsStore;

    static DATABASE: std::sync::LazyLock<Database> = std::sync::LazyLock::new(|| {
        let path = crate::storage::db::default_db_path();
        Database::open(&path).expect("Failed to open database")
    });

    #[napi(object)]
    pub struct JsNewEntry {
        pub raw_transcript: String,
        pub polished_text: Option<String>,
        pub duration_seconds: Option<f64>,
        pub source_app: Option<String>,
    }

    #[napi(object)]
    pub struct JsEntry {
        pub id: String,
        pub created_at: String,
        pub updated_at: String,
        pub raw_transcript: String,
        pub polished_text: Option<String>,
        pub display_mode: String,
        pub duration_seconds: Option<f64>,
        pub source_app: Option<String>,
        pub is_pinned: bool,
        pub is_archived: bool,
        pub tags: Option<String>,
    }

    impl From<crate::storage::entries::Entry> for JsEntry {
        fn from(e: crate::storage::entries::Entry) -> Self {
            Self {
                id: e.id,
                created_at: e.created_at,
                updated_at: e.updated_at,
                raw_transcript: e.raw_transcript,
                polished_text: e.polished_text,
                display_mode: e.display_mode,
                duration_seconds: e.duration_seconds,
                source_app: e.source_app,
                is_pinned: e.is_pinned,
                is_archived: e.is_archived,
                tags: e.tags,
            }
        }
    }

    #[napi(object)]
    pub struct JsListOptions {
        pub limit: u32,
        pub offset: u32,
        pub search: Option<String>,
        pub archived: Option<bool>,
    }

    #[napi(object)]
    pub struct JsEntryUpdate {
        pub raw_transcript: Option<String>,
        pub polished_text: Option<String>,
        pub display_mode: Option<String>,
        pub tags: Option<String>,
        pub source_app: Option<String>,
    }

    #[napi]
    pub fn create_entry(entry: JsNewEntry) -> napi::Result<JsEntry> {
        init_tracing();
        let store = EntryStore::new(DATABASE.clone());
        let new = NewEntry {
            raw_transcript: entry.raw_transcript,
            polished_text: entry.polished_text,
            duration_seconds: entry.duration_seconds,
            source_app: entry.source_app,
        };
        store.create(new).map(Into::into).map_err(Into::into)
    }

    #[napi]
    pub fn get_entry(id: String) -> napi::Result<Option<JsEntry>> {
        let store = EntryStore::new(DATABASE.clone());
        store.get(&id).map(|o| o.map(Into::into)).map_err(Into::into)
    }

    #[napi]
    pub fn update_entry(id: String, updates: JsEntryUpdate) -> napi::Result<JsEntry> {
        let store = EntryStore::new(DATABASE.clone());
        let upd = EntryUpdate {
            raw_transcript: updates.raw_transcript,
            polished_text: updates.polished_text.map(Some),
            display_mode: updates.display_mode,
            tags: updates.tags.map(Some),
            source_app: updates.source_app.map(Some),
        };
        store.update(&id, upd).map(Into::into).map_err(Into::into)
    }

    #[napi]
    pub fn delete_entry(id: String) -> napi::Result<()> {
        let store = EntryStore::new(DATABASE.clone());
        store.delete(&id).map_err(Into::into)
    }

    /// Bulk-tag all entries that have no source_app set.
    #[napi]
    pub fn tag_untagged_entries(source_app: String) -> napi::Result<u32> {
        let store = EntryStore::new(DATABASE.clone());
        store.tag_all_untagged(&source_app)
            .map(|n| n as u32)
            .map_err(Into::into)
    }

    #[napi]
    pub fn list_entries(opts: JsListOptions) -> napi::Result<Vec<JsEntry>> {
        let store = EntryStore::new(DATABASE.clone());
        let list_opts = ListOptions {
            limit: opts.limit,
            offset: opts.offset,
            search: opts.search,
            archived: opts.archived,
        };
        store
            .list(list_opts)
            .map(|v| v.into_iter().map(Into::into).collect())
            .map_err(Into::into)
    }

    #[napi]
    pub fn pin_entry(id: String, pinned: bool) -> napi::Result<()> {
        let store = EntryStore::new(DATABASE.clone());
        store.pin(&id, pinned).map_err(Into::into)
    }

    #[napi]
    pub fn archive_entry(id: String, archived: bool) -> napi::Result<()> {
        let store = EntryStore::new(DATABASE.clone());
        store.archive(&id, archived).map_err(Into::into)
    }

    #[napi]
    pub fn delete_all_entries() -> napi::Result<u32> {
        init_tracing();
        let store = EntryStore::new(DATABASE.clone());
        store.delete_all().map_err(Into::into)
    }

    #[napi]
    pub fn delete_entries_older_than(days: u32) -> napi::Result<u32> {
        init_tracing();
        info!("Deleting entries older than {} days", days);
        let store = EntryStore::new(DATABASE.clone());
        let count = store.delete_older_than(days).map_err(napi::Error::from)?;
        info!("Deleted {} old entries", count);
        Ok(count)
    }

    /// Run auto-cleanup if enabled in settings. Called on app startup.
    #[napi]
    pub fn run_auto_cleanup() -> napi::Result<u32> {
        init_tracing();
        let settings = SettingsStore::new(DATABASE.clone());

        let enabled = settings.get("auto_delete_enabled").map_err(napi::Error::from)?;
        if enabled.as_deref() != Some("true") {
            return Ok(0);
        }

        let days_str = settings.get("auto_delete_days").map_err(napi::Error::from)?;
        let days: u32 = days_str
            .unwrap_or_else(|| "14".into())
            .parse()
            .unwrap_or(14);

        info!("Auto-cleanup: deleting entries older than {} days", days);
        let store = EntryStore::new(DATABASE.clone());
        let count = store.delete_older_than(days).map_err(napi::Error::from)?;
        if count > 0 {
            info!("Auto-cleanup removed {} entries", count);
        }
        Ok(count)
    }

    // ── Dictionary N-API exports ──

    #[napi]
    pub fn add_word(word: String) -> napi::Result<()> {
        let store = DictionaryStore::new(DATABASE.clone());
        store.add_word(&word).map_err(Into::into)
    }

    #[napi]
    pub fn remove_word(word: String) -> napi::Result<()> {
        let store = DictionaryStore::new(DATABASE.clone());
        store.remove_word(&word).map_err(Into::into)
    }

    #[napi]
    pub fn list_dictionary() -> napi::Result<Vec<String>> {
        let store = DictionaryStore::new(DATABASE.clone());
        store.list_words().map_err(Into::into)
    }

    // ── Settings N-API exports ──

    #[napi]
    pub fn get_setting(key: String) -> napi::Result<Option<String>> {
        let store = SettingsStore::new(DATABASE.clone());
        store.get(&key).map_err(Into::into)
    }

    #[napi]
    pub fn set_setting(key: String, value: String) -> napi::Result<()> {
        let store = SettingsStore::new(DATABASE.clone());
        store.set(&key, &value).map_err(Into::into)
    }

    // ── Clipboard N-API export ──

    #[napi]
    pub fn copy_to_clipboard(text: String) -> napi::Result<()> {
        crate::clipboard::manager::copy_to_clipboard(&text).map_err(Into::into)
    }

    // ── Hotkey & Pipeline N-API exports ──

    use crate::hotkey::listener::PipelineStateMachine;

    static PIPELINE_STATE: std::sync::LazyLock<PipelineStateMachine> =
        std::sync::LazyLock::new(PipelineStateMachine::new);

    #[napi]
    pub fn get_pipeline_state() -> String {
        PIPELINE_STATE.current().to_string()
    }

    #[napi]
    pub fn reset_pipeline_state() {
        PIPELINE_STATE.reset();
    }

    /// Register a global hotkey. The actual OS-level registration is handled
    /// by Electron's globalShortcut API — this just stores the accelerator
    /// in settings for persistence.
    #[napi]
    pub fn register_hotkey(accelerator: String) -> napi::Result<()> {
        init_tracing();
        info!("registerHotkey called: {}", accelerator);
        let store = SettingsStore::new(DATABASE.clone());
        store.set("hotkey_record", &accelerator).map_err(Into::into)
    }

    // ── Model Status & Config ──

    use crate::transcription::whisper::{
        available_models, downloaded_models, gpu_available,
    };

    #[napi(object)]
    pub struct JsModelInfo {
        pub loaded: bool,
        pub name: String,
        pub size_bytes: i64,
    }

    #[napi(object)]
    pub struct JsModelStatus {
        pub whisper: JsModelInfo,
        pub llm: JsModelInfo,
    }

    #[napi]
    pub fn get_model_status() -> JsModelStatus {
        let whisper_loaded = WHISPER_ENGINE.is_loaded();
        let whisper_path = WHISPER_ENGINE.model_path();
        let whisper_size = std::fs::metadata(&whisper_path)
            .map(|m| m.len() as i64)
            .unwrap_or(0);

        let llm_loaded = LLM_ENGINE.is_loaded();
        let llm_path = LLM_ENGINE.model_path();
        let llm_size = std::fs::metadata(&llm_path)
            .map(|m| m.len() as i64)
            .unwrap_or(0);

        JsModelStatus {
            whisper: JsModelInfo {
                loaded: whisper_loaded,
                name: WHISPER_ENGINE.current_model_id(),
                size_bytes: whisper_size,
            },
            llm: JsModelInfo {
                loaded: llm_loaded,
                name: "mistral-7b-instruct-q4".into(),
                size_bytes: llm_size,
            },
        }
    }

    // ── Whisper model & GPU config ──

    #[napi(object)]
    pub struct JsWhisperModel {
        pub id: String,
        pub name: String,
        pub filename: String,
        pub size_bytes: f64,
        pub speed_label: String,
        pub accuracy_label: String,
        pub description: String,
        pub download_url: String,
        pub downloaded: bool,
    }

    #[napi]
    pub fn get_available_whisper_models() -> Vec<JsWhisperModel> {
        downloaded_models()
            .into_iter()
            .map(|(m, downloaded)| JsWhisperModel {
                id: m.id,
                name: m.name,
                filename: m.filename,
                size_bytes: m.size_bytes as f64,
                speed_label: m.speed_label,
                accuracy_label: m.accuracy_label,
                description: m.description,
                download_url: m.download_url,
                downloaded,
            })
            .collect()
    }

    #[napi]
    pub fn get_current_whisper_model() -> String {
        WHISPER_ENGINE.current_model_id()
    }

    #[napi]
    pub fn set_whisper_model(model_id: String) -> napi::Result<()> {
        init_tracing();
        info!("Switching Whisper model to: {}", model_id);
        WHISPER_ENGINE.set_model(&model_id).map_err(Into::into)
    }

    #[napi]
    pub fn is_gpu_available() -> bool {
        gpu_available()
    }

    #[napi]
    pub fn is_gpu_enabled() -> bool {
        WHISPER_ENGINE.use_gpu()
    }

    #[napi]
    pub fn set_gpu_enabled(enabled: bool) -> napi::Result<()> {
        init_tracing();
        info!("Setting GPU acceleration: {}", enabled);
        WHISPER_ENGINE.set_use_gpu(enabled).map_err(Into::into)
    }

    // ── TTS Engine ──

    use crate::tts::kokoro::{KokoroEngine, SharedTtsEngine};
    use crate::tts::playback::PlaybackEngine;
    use crate::tts::TtsEngine as TtsEngineTrait;

    static TTS_ENGINE: std::sync::LazyLock<SharedTtsEngine> =
        std::sync::LazyLock::new(|| SharedTtsEngine::new(KokoroEngine::with_defaults()));

    static PLAYBACK_ENGINE: std::sync::LazyLock<Mutex<PlaybackEngine>> =
        std::sync::LazyLock::new(|| Mutex::new(PlaybackEngine::new()));

    #[napi]
    pub fn synthesize_text(text: String) -> napi::Result<String> {
        init_tracing();
        info!("synthesizeText called, text_len={}", text.len());

        if !TTS_ENGINE.is_loaded() {
            TTS_ENGINE.load_model().map_err(napi::Error::from)?;
        }

        let mut result = TTS_ENGINE.synthesize(&text).map_err(napi::Error::from)?;

        let timestamps = std::mem::take(&mut result.timestamps);
        let duration_ms = (result.duration_seconds * 1000.0) as u64;
        let sample_rate = result.sample_rate;
        let samples = result.take_samples();

        // Start playback
        let mut playback = PLAYBACK_ENGINE.lock().unwrap();
        playback
            .play(samples, sample_rate)
            .map_err(napi::Error::from)?;

        // Return timestamps as JSON
        let response = serde_json::json!({
            "timestamps": timestamps,
            "durationMs": duration_ms,
        });

        Ok(response.to_string())
    }

    #[napi]
    pub fn tts_play() -> napi::Result<()> {
        let mut playback = PLAYBACK_ENGINE.lock().unwrap();
        playback.resume();
        Ok(())
    }

    #[napi]
    pub fn tts_pause() -> napi::Result<()> {
        let mut playback = PLAYBACK_ENGINE.lock().unwrap();
        playback.pause();
        Ok(())
    }

    #[napi]
    pub fn tts_stop() -> napi::Result<()> {
        let mut playback = PLAYBACK_ENGINE.lock().unwrap();
        playback.stop();
        Ok(())
    }

    #[napi]
    pub fn tts_get_position() -> f64 {
        let playback = PLAYBACK_ENGINE.lock().unwrap();
        playback.position_ms()
    }

    #[napi]
    pub fn tts_get_state() -> String {
        let playback = PLAYBACK_ENGINE.lock().unwrap();
        playback.state().to_string()
    }

    #[napi]
    pub fn tts_set_speed(speed: f64) -> napi::Result<()> {
        let playback = PLAYBACK_ENGINE.lock().unwrap();
        playback.set_speed(speed as f32);
        TTS_ENGINE.set_speed(speed as f32);
        Ok(())
    }

    #[napi]
    pub fn tts_set_voice(voice_id: String) -> napi::Result<()> {
        TTS_ENGINE.set_voice(&voice_id).map_err(Into::into)
    }

    #[napi]
    pub fn tts_available_voices() -> String {
        let voices = TTS_ENGINE.available_voices();
        serde_json::to_string(&voices).unwrap_or_else(|_| "[]".into())
    }

    #[napi]
    pub fn tts_load_model() -> napi::Result<()> {
        init_tracing();
        TTS_ENGINE.load_model().map_err(Into::into)
    }

    #[napi]
    pub fn tts_is_loaded() -> bool {
        TTS_ENGINE.is_loaded()
    }

    #[napi]
    pub fn tts_toggle() -> String {
        let mut playback = PLAYBACK_ENGINE.lock().unwrap();
        playback.toggle().to_string()
    }
}
