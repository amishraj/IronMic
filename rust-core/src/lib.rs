pub mod audio;
pub mod clipboard;
pub mod error;
pub mod export;
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

    /// List all available audio input devices.
    /// Returns JSON array of { id, name, isDefault, sampleRate, channels }.
    #[napi]
    pub fn list_audio_devices() -> napi::Result<String> {
        use cpal::traits::{DeviceTrait, HostTrait};

        let host = cpal::default_host();
        let default_name = host
            .default_input_device()
            .and_then(|d| d.name().ok())
            .unwrap_or_default();

        let devices: Vec<serde_json::Value> = host
            .input_devices()
            .map(|devs| {
                devs.filter_map(|d| {
                    let name = d.name().ok()?;
                    let config = d.default_input_config().ok();
                    Some(serde_json::json!({
                        "id": name.clone(),
                        "name": name.clone(),
                        "isDefault": name == default_name,
                        "sampleRate": config.as_ref().map(|c| c.sample_rate().0).unwrap_or(0),
                        "channels": config.as_ref().map(|c| c.channels()).unwrap_or(0),
                    }))
                })
                .collect()
            })
            .unwrap_or_default();

        serde_json::to_string(&devices)
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Get info about the current/default input device.
    #[napi]
    pub fn get_current_audio_device() -> napi::Result<String> {
        use cpal::traits::{DeviceTrait, HostTrait};

        let host = cpal::default_host();
        let device = host.default_input_device();

        let info = match device {
            Some(d) => {
                let name = d.name().unwrap_or_else(|_| "Unknown".into());
                let config = d.default_input_config().ok();
                serde_json::json!({
                    "name": name,
                    "available": true,
                    "sampleRate": config.as_ref().map(|c| c.sample_rate().0).unwrap_or(0),
                    "channels": config.as_ref().map(|c| c.channels()).unwrap_or(0),
                    "sampleFormat": config.as_ref().map(|c| format!("{:?}", c.sample_format())).unwrap_or_default(),
                })
            }
            None => serde_json::json!({
                "name": null,
                "available": false,
                "sampleRate": 0,
                "channels": 0,
                "sampleFormat": null,
            }),
        };

        serde_json::to_string(&info)
            .map_err(|e| napi::Error::from_reason(e.to_string()))
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

    /// Explicitly load the active Whisper model.
    ///
    /// The first transcription on Windows can legitimately spend a long time
    /// mapping a large GGML model before any inference happens. Keeping model
    /// load as a separate call lets Electron warm the model before starting the
    /// chunk loop, instead of timing out and dropping the user's first words.
    #[napi]
    pub fn load_whisper_model() -> napi::Result<()> {
        init_tracing();
        info!("loadWhisperModel called from N-API");
        WHISPER_ENGINE.load_model().map_err(napi::Error::from)
    }

    /// Polish raw transcript text using the local LLM subprocess.
    /// Note: actual LLM inference happens in the ironmic-llm binary.
    /// This stub returns text unchanged — Electron routes through LlmSubprocess instead.
    #[napi]
    pub async fn polish_text(raw_text: String) -> napi::Result<String> {
        // LLM inference moved to ironmic-llm subprocess to avoid ggml symbol collision.
        // This stub preserves the N-API surface for backward compat.
        // Electron's ipc-handlers routes polish through LlmSubprocess when available.
        Ok(raw_text)
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
        let result = store.create(new).map(Into::into).map_err(napi::Error::from)?;

        // Update today's analytics snapshot incrementally
        let analytics = AnalyticsStore::new(DATABASE.clone());
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let _ = analytics.compute_daily_snapshot(&today);

        Ok(result)
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

    // ── Analytics N-API exports ──

    use crate::storage::analytics::AnalyticsStore;

    #[napi]
    pub fn analytics_recompute_today() -> napi::Result<()> {
        init_tracing();
        let store = AnalyticsStore::new(DATABASE.clone());
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        store.compute_daily_snapshot(&today).map_err(napi::Error::from)?;
        Ok(())
    }

    #[napi]
    pub async fn analytics_backfill() -> napi::Result<u32> {
        init_tracing();
        info!("analytics_backfill called from N-API");
        let store = AnalyticsStore::new(DATABASE.clone());
        store.backfill_all().map_err(napi::Error::from)
    }

    #[napi]
    pub fn analytics_get_overview(period: String) -> napi::Result<String> {
        let store = AnalyticsStore::new(DATABASE.clone());
        let stats = store.get_overview(&period).map_err(napi::Error::from)?;
        serde_json::to_string(&stats)
            .map_err(|e| napi::Error::from_reason(format!("JSON serialization failed: {e}")))
    }

    #[napi]
    pub fn analytics_get_daily_trend(from_date: String, to_date: String) -> napi::Result<String> {
        let store = AnalyticsStore::new(DATABASE.clone());
        let trend = store.get_daily_trend(&from_date, &to_date).map_err(napi::Error::from)?;
        serde_json::to_string(&trend)
            .map_err(|e| napi::Error::from_reason(format!("JSON serialization failed: {e}")))
    }

    #[napi]
    pub fn analytics_get_top_words(from_date: String, to_date: String, limit: u32) -> napi::Result<String> {
        let store = AnalyticsStore::new(DATABASE.clone());
        let words = store.get_top_words(&from_date, &to_date, limit).map_err(napi::Error::from)?;
        serde_json::to_string(&words)
            .map_err(|e| napi::Error::from_reason(format!("JSON serialization failed: {e}")))
    }

    #[napi]
    pub fn analytics_get_source_breakdown(from_date: String, to_date: String) -> napi::Result<String> {
        let store = AnalyticsStore::new(DATABASE.clone());
        let breakdown = store.get_source_breakdown(&from_date, &to_date).map_err(napi::Error::from)?;
        serde_json::to_string(&breakdown)
            .map_err(|e| napi::Error::from_reason(format!("JSON serialization failed: {e}")))
    }

    #[napi]
    pub fn analytics_get_vocabulary_richness(from_date: String, to_date: String) -> napi::Result<String> {
        let store = AnalyticsStore::new(DATABASE.clone());
        let richness = store.get_vocabulary_richness(&from_date, &to_date).map_err(napi::Error::from)?;
        serde_json::to_string(&richness)
            .map_err(|e| napi::Error::from_reason(format!("JSON serialization failed: {e}")))
    }

    #[napi]
    pub fn analytics_get_streaks() -> napi::Result<String> {
        let store = AnalyticsStore::new(DATABASE.clone());
        let streaks = store.get_streaks().map_err(napi::Error::from)?;
        serde_json::to_string(&streaks)
            .map_err(|e| napi::Error::from_reason(format!("JSON serialization failed: {e}")))
    }

    #[napi]
    pub fn analytics_get_productivity_comparison() -> napi::Result<String> {
        let store = AnalyticsStore::new(DATABASE.clone());
        let comparison = store.get_productivity_comparison().map_err(napi::Error::from)?;
        serde_json::to_string(&comparison)
            .map_err(|e| napi::Error::from_reason(format!("JSON serialization failed: {e}")))
    }

    #[napi]
    pub fn analytics_get_topic_breakdown(from_date: String, to_date: String) -> napi::Result<String> {
        let store = AnalyticsStore::new(DATABASE.clone());
        let breakdown = store.get_topic_breakdown(&from_date, &to_date).map_err(napi::Error::from)?;
        serde_json::to_string(&breakdown)
            .map_err(|e| napi::Error::from_reason(format!("JSON serialization failed: {e}")))
    }

    #[napi]
    pub fn analytics_get_topic_trends(from_date: String, to_date: String) -> napi::Result<String> {
        let store = AnalyticsStore::new(DATABASE.clone());
        let trends = store.get_topic_trends(&from_date, &to_date).map_err(napi::Error::from)?;
        serde_json::to_string(&trends)
            .map_err(|e| napi::Error::from_reason(format!("JSON serialization failed: {e}")))
    }

    #[napi]
    pub async fn analytics_classify_topics_batch(_batch_size: u32) -> napi::Result<u32> {
        // Topic classification moved to ironmic-llm subprocess.
        // This stub returns 0 — Electron routes through LlmSubprocess instead.
        Ok(0)
    }

    /// Get unclassified entries with their text, for topic classification.
    /// Returns JSON array of [id, text] pairs.
    #[napi]
    pub fn analytics_get_unclassified_entries(limit: u32) -> napi::Result<String> {
        let store = AnalyticsStore::new(DATABASE.clone());
        let entries = store.get_unclassified_entry_ids(limit).map_err(napi::Error::from)?;
        serde_json::to_string(&entries)
            .map_err(|e| napi::Error::from_reason(format!("JSON serialization failed: {e}")))
    }

    /// Save topic classification results for an entry.
    /// topics_json: JSON array of [topic, confidence] pairs.
    #[napi]
    pub fn analytics_save_entry_topics(entry_id: String, topics_json: String) -> napi::Result<()> {
        let topics: Vec<(String, f64)> = serde_json::from_str(&topics_json)
            .map_err(|e| napi::Error::from_reason(format!("Invalid topics JSON: {e}")))?;
        let store = AnalyticsStore::new(DATABASE.clone());
        store.save_entry_topics(&entry_id, &topics).map_err(napi::Error::from)
    }

    #[napi]
    pub fn analytics_get_unclassified_count() -> napi::Result<u32> {
        let store = AnalyticsStore::new(DATABASE.clone());
        store.get_unclassified_count().map_err(napi::Error::from)
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
        downloaded_models, gpu_available,
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

        // LLM runs in separate subprocess — report file status only
        let llm_model_path = crate::llm::cleanup::default_model_path();
        let llm_size = std::fs::metadata(&llm_model_path)
            .map(|m| m.len() as i64)
            .unwrap_or(0);

        JsModelStatus {
            whisper: JsModelInfo {
                loaded: whisper_loaded,
                name: WHISPER_ENGINE.current_model_id(),
                size_bytes: whisper_size,
            },
            llm: JsModelInfo {
                loaded: llm_size > 0,
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

    // ── ML Features: Notifications ──

    #[napi]
    pub fn create_notification(
        source: String,
        source_id: Option<String>,
        notification_type: String,
        title: String,
        body: Option<String>,
    ) -> napi::Result<String> {
        let n = DATABASE
            .create_notification(&source, source_id.as_deref(), &notification_type, &title, body.as_deref())
            .map_err(Into::<napi::Error>::into)?;
        serde_json::to_string(&n).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn list_notifications(limit: u32, offset: u32, unread_only: bool) -> napi::Result<String> {
        let notifications = DATABASE.list_notifications(limit, offset, unread_only).map_err(Into::<napi::Error>::into)?;
        serde_json::to_string(&notifications).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn mark_notification_read(id: String) -> napi::Result<()> {
        DATABASE.mark_notification_read(&id).map_err(Into::into)
    }

    #[napi]
    pub fn notification_act(id: String) -> napi::Result<()> {
        DATABASE.notification_act(&id).map_err(Into::into)
    }

    #[napi]
    pub fn notification_dismiss(id: String) -> napi::Result<()> {
        DATABASE.notification_dismiss(&id).map_err(Into::into)
    }

    #[napi]
    pub fn update_notification_priority(id: String, priority: f64) -> napi::Result<()> {
        DATABASE.update_notification_priority(&id, priority).map_err(Into::into)
    }

    #[napi]
    pub fn log_notification_interaction(
        notification_id: String,
        action: String,
        context_hour: Option<i32>,
        context_day_of_week: Option<i32>,
    ) -> napi::Result<()> {
        DATABASE
            .log_notification_interaction(&notification_id, &action, context_hour, context_day_of_week)
            .map_err(Into::into)
    }

    #[napi]
    pub fn get_notification_interactions(since_date: String) -> napi::Result<String> {
        let interactions = DATABASE.get_notification_interactions(&since_date).map_err(Into::<napi::Error>::into)?;
        serde_json::to_string(&interactions).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_unread_notification_count() -> napi::Result<u32> {
        DATABASE.get_unread_notification_count().map_err(Into::into)
    }

    #[napi]
    pub fn delete_old_notifications(retention_days: u32) -> napi::Result<u32> {
        DATABASE.delete_old_notifications(retention_days).map_err(Into::into)
    }

    // ── ML Features: Action Log ──

    #[napi]
    pub fn log_action(action_type: String, metadata_json: Option<String>) -> napi::Result<()> {
        DATABASE.log_action(&action_type, metadata_json.as_deref()).map_err(Into::into)
    }

    #[napi]
    pub fn query_action_log(
        from_date: String,
        to_date: String,
        action_type_filter: Option<String>,
    ) -> napi::Result<String> {
        let entries = DATABASE
            .query_action_log(&from_date, &to_date, action_type_filter.as_deref())
            .map_err(Into::<napi::Error>::into)?;
        serde_json::to_string(&entries).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_action_counts() -> napi::Result<String> {
        let (total, recent) = DATABASE.get_action_counts().map_err(Into::<napi::Error>::into)?;
        Ok(format!("{{\"total\":{total},\"recent\":{recent}}}"))
    }

    #[napi]
    pub fn delete_old_actions(retention_days: u32) -> napi::Result<u32> {
        DATABASE.delete_old_actions(retention_days).map_err(Into::into)
    }

    // ── ML Features: Workflows ──

    #[napi]
    pub fn create_workflow(
        action_sequence: String,
        trigger_pattern: Option<String>,
        confidence: f64,
        occurrence_count: i32,
    ) -> napi::Result<String> {
        let w = DATABASE
            .create_workflow(&action_sequence, trigger_pattern.as_deref(), confidence, occurrence_count)
            .map_err(Into::<napi::Error>::into)?;
        serde_json::to_string(&w).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn list_workflows(include_dismissed: bool) -> napi::Result<String> {
        let workflows = DATABASE.list_workflows(include_dismissed).map_err(Into::<napi::Error>::into)?;
        serde_json::to_string(&workflows).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn save_workflow(id: String, name: String) -> napi::Result<()> {
        DATABASE.save_workflow(&id, &name).map_err(Into::into)
    }

    #[napi]
    pub fn dismiss_workflow(id: String) -> napi::Result<()> {
        DATABASE.dismiss_workflow(&id).map_err(Into::into)
    }

    #[napi]
    pub fn delete_workflow(id: String) -> napi::Result<()> {
        DATABASE.delete_workflow(&id).map_err(Into::into)
    }

    // ── ML Features: Embeddings ──

    #[napi]
    pub fn store_embedding(
        content_id: String,
        content_type: String,
        embedding_bytes: Buffer,
        model_version: String,
    ) -> napi::Result<()> {
        DATABASE
            .store_embedding(&content_id, &content_type, &embedding_bytes, &model_version)
            .map_err(Into::into)
    }

    #[napi]
    pub fn get_all_embeddings(content_type_filter: Option<String>) -> napi::Result<String> {
        let embeddings = DATABASE
            .get_all_embeddings(content_type_filter.as_deref())
            .map_err(Into::<napi::Error>::into)?;
        // Serialize without raw embedding data — just metadata
        let records: Vec<_> = embeddings
            .iter()
            .map(|e| serde_json::json!({
                "contentId": e.content_id,
                "contentType": e.content_type,
                "embeddedAt": e.embedded_at,
                "modelVersion": e.model_version,
            }))
            .collect();
        serde_json::to_string(&records).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_all_embeddings_with_data(content_type_filter: Option<String>) -> napi::Result<Buffer> {
        let embeddings = DATABASE
            .get_all_embeddings(content_type_filter.as_deref())
            .map_err(Into::<napi::Error>::into)?;
        // Pack as: [content_id_len(u32), content_id_bytes, content_type_len(u32), content_type_bytes, embedding_len(u32), embedding_bytes, ...]
        let mut buf = Vec::new();
        let count = embeddings.len() as u32;
        buf.extend_from_slice(&count.to_le_bytes());
        for e in &embeddings {
            let id_bytes = e.content_id.as_bytes();
            buf.extend_from_slice(&(id_bytes.len() as u32).to_le_bytes());
            buf.extend_from_slice(id_bytes);
            let type_bytes = e.content_type.as_bytes();
            buf.extend_from_slice(&(type_bytes.len() as u32).to_le_bytes());
            buf.extend_from_slice(type_bytes);
            buf.extend_from_slice(&(e.embedding.len() as u32).to_le_bytes());
            buf.extend_from_slice(&e.embedding);
        }
        Ok(Buffer::from(buf))
    }

    #[napi]
    pub fn get_unembedded_entries(limit: u32) -> napi::Result<String> {
        let entries = DATABASE.get_unembedded_entries(limit).map_err(Into::<napi::Error>::into)?;
        let records: Vec<_> = entries
            .iter()
            .map(|(id, text)| serde_json::json!({"id": id, "text": text}))
            .collect();
        serde_json::to_string(&records).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn delete_embedding(content_id: String, content_type: String) -> napi::Result<()> {
        DATABASE.delete_embedding(&content_id, &content_type).map_err(Into::into)
    }

    #[napi]
    pub fn get_embedding_stats() -> napi::Result<String> {
        let stats = DATABASE.get_embedding_stats().map_err(Into::<napi::Error>::into)?;
        let map: std::collections::HashMap<_, _> = stats.into_iter().collect();
        serde_json::to_string(&map).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn delete_all_embeddings() -> napi::Result<u32> {
        DATABASE.delete_all_embeddings().map_err(Into::into)
    }

    // ── ML Features: Model Weights ──

    #[napi]
    pub fn save_ml_weights(
        model_name: String,
        weights_json: String,
        metadata_json: Option<String>,
        training_samples: i32,
    ) -> napi::Result<()> {
        DATABASE
            .save_ml_weights(&model_name, &weights_json, metadata_json.as_deref(), training_samples)
            .map_err(Into::into)
    }

    #[napi]
    pub fn load_ml_weights(model_name: String) -> napi::Result<String> {
        let weights = DATABASE.load_ml_weights(&model_name).map_err(Into::<napi::Error>::into)?;
        match weights {
            Some(w) => serde_json::to_string(&w).map_err(|e| napi::Error::from_reason(e.to_string())),
            None => Ok("null".to_string()),
        }
    }

    #[napi]
    pub fn delete_ml_weights(model_name: String) -> napi::Result<()> {
        DATABASE.delete_ml_weights(&model_name).map_err(Into::into)
    }

    #[napi]
    pub fn get_ml_training_status() -> napi::Result<String> {
        let status = DATABASE.get_ml_training_status().map_err(Into::<napi::Error>::into)?;
        let records: Vec<_> = status
            .iter()
            .map(|(name, samples, version, trained_at)| {
                serde_json::json!({
                    "modelName": name,
                    "trainingSamples": samples,
                    "version": version,
                    "trainedAt": trained_at,
                })
            })
            .collect();
        serde_json::to_string(&records).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn delete_all_ml_data() -> napi::Result<()> {
        DATABASE.delete_all_ml_data().map_err(Into::into)
    }

    // ── ML Features: VAD Training ──

    #[napi]
    pub fn save_vad_training_sample(
        audio_features: String,
        label: String,
        is_user_corrected: bool,
        session_id: Option<String>,
    ) -> napi::Result<()> {
        DATABASE
            .save_vad_training_sample(&audio_features, &label, is_user_corrected, session_id.as_deref())
            .map_err(Into::into)
    }

    #[napi]
    pub fn get_vad_training_samples(limit: u32) -> napi::Result<String> {
        let samples = DATABASE.get_vad_training_samples(limit).map_err(Into::<napi::Error>::into)?;
        serde_json::to_string(&samples).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_vad_sample_count() -> napi::Result<u32> {
        DATABASE.get_vad_sample_count().map_err(Into::into)
    }

    #[napi]
    pub fn delete_all_vad_samples() -> napi::Result<u32> {
        DATABASE.delete_all_vad_samples().map_err(Into::into)
    }

    // ── ML Features: Intent Training ──

    #[napi]
    pub fn save_intent_training_sample(
        transcript: String,
        predicted_intent: Option<String>,
        predicted_entities: Option<String>,
        confidence: Option<f64>,
        entry_id: Option<String>,
    ) -> napi::Result<()> {
        DATABASE
            .save_intent_training_sample(
                &transcript,
                predicted_intent.as_deref(),
                predicted_entities.as_deref(),
                confidence,
                entry_id.as_deref(),
            )
            .map_err(Into::into)
    }

    #[napi]
    pub fn get_intent_training_samples(limit: u32) -> napi::Result<String> {
        let samples = DATABASE.get_intent_training_samples(limit).map_err(Into::<napi::Error>::into)?;
        serde_json::to_string(&samples).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_intent_correction_count() -> napi::Result<u32> {
        DATABASE.get_intent_correction_count().map_err(Into::into)
    }

    #[napi]
    pub fn log_voice_routing(
        active_screen: String,
        detected_intent: String,
        routed_to: String,
        entry_id: Option<String>,
    ) -> napi::Result<()> {
        DATABASE
            .log_voice_routing(&active_screen, &detected_intent, &routed_to, entry_id.as_deref())
            .map_err(Into::into)
    }

    // ── ML Features: Meeting Sessions ──

    #[napi]
    pub fn create_meeting_session() -> napi::Result<String> {
        let session = DATABASE.create_meeting_session().map_err(Into::<napi::Error>::into)?;
        serde_json::to_string(&session).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn end_meeting_session(
        id: String,
        speaker_count: i32,
        summary: Option<String>,
        action_items: Option<String>,
        total_duration_seconds: f64,
        entry_ids: Option<String>,
    ) -> napi::Result<()> {
        DATABASE
            .end_meeting_session(
                &id,
                speaker_count,
                summary.as_deref(),
                action_items.as_deref(),
                total_duration_seconds,
                entry_ids.as_deref(),
            )
            .map_err(Into::into)
    }

    #[napi]
    pub fn get_meeting_session(id: String) -> napi::Result<String> {
        let session = DATABASE.get_meeting_session(&id).map_err(Into::<napi::Error>::into)?;
        match session {
            Some(s) => serde_json::to_string(&s).map_err(|e| napi::Error::from_reason(e.to_string())),
            None => Ok("null".to_string()),
        }
    }

    #[napi]
    pub fn list_meeting_sessions(limit: u32, offset: u32) -> napi::Result<String> {
        let sessions = DATABASE.list_meeting_sessions(limit, offset).map_err(Into::<napi::Error>::into)?;
        serde_json::to_string(&sessions).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn delete_meeting_session(id: String) -> napi::Result<()> {
        DATABASE.delete_meeting_session(&id).map_err(Into::into)
    }

    // ── Meeting Templates ──

    #[napi]
    pub fn create_meeting_template(
        name: String,
        meeting_type: String,
        sections: String,
        llm_prompt: String,
        display_layout: String,
    ) -> napi::Result<String> {
        let template = DATABASE
            .create_meeting_template(&name, &meeting_type, &sections, &llm_prompt, &display_layout)
            .map_err(Into::<napi::Error>::into)?;
        serde_json::to_string(&template).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_meeting_template(id: String) -> napi::Result<String> {
        let template = DATABASE.get_meeting_template(&id).map_err(Into::<napi::Error>::into)?;
        match template {
            Some(t) => serde_json::to_string(&t).map_err(|e| napi::Error::from_reason(e.to_string())),
            None => Ok("null".to_string()),
        }
    }

    #[napi]
    pub fn list_meeting_templates() -> napi::Result<String> {
        let templates = DATABASE.list_meeting_templates().map_err(Into::<napi::Error>::into)?;
        serde_json::to_string(&templates).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn update_meeting_template(
        id: String,
        name: String,
        meeting_type: String,
        sections: String,
        llm_prompt: String,
        display_layout: String,
    ) -> napi::Result<()> {
        DATABASE
            .update_meeting_template(&id, &name, &meeting_type, &sections, &llm_prompt, &display_layout)
            .map_err(Into::into)
    }

    #[napi]
    pub fn delete_meeting_template(id: String) -> napi::Result<()> {
        DATABASE.delete_meeting_template(&id).map_err(Into::into)
    }

    #[napi]
    pub fn create_meeting_session_with_template(
        template_id: Option<String>,
        detected_app: Option<String>,
    ) -> napi::Result<String> {
        let session = DATABASE
            .create_meeting_session_with_template(
                template_id.as_deref(),
                detected_app.as_deref(),
            )
            .map_err(Into::<napi::Error>::into)?;
        serde_json::to_string(&session).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn set_meeting_structured_output(id: String, structured_output: String) -> napi::Result<()> {
        DATABASE
            .set_meeting_structured_output(&id, &structured_output)
            .map_err(Into::into)
    }

    // ── Meeting Recording: Device-Select & Chunk Drain ──

    /// Start recording from a named input device (e.g. "BlackHole 2ch" for system audio).
    /// Falls back to the default input device if the named device is not found.
    /// Uses the same CaptureEngine as regular dictation — no new infrastructure.
    #[napi]
    pub fn start_recording_from_device(device_name: String) -> napi::Result<()> {
        init_tracing();
        info!(device = %device_name, "startRecordingFromDevice called from N-API");
        let mut engine = CAPTURE_ENGINE
            .lock()
            .map_err(|e| napi::Error::from_reason(format!("Lock poisoned: {e}")))?;
        engine.start_from_device(&device_name).map_err(Into::into)
    }

    /// Drain the current recording buffer and return it as 16kHz mono i16 PCM bytes,
    /// WITHOUT stopping the stream. The stream keeps running with zero capture gap.
    /// Used by the meeting chunk loop every 30 seconds.
    #[napi]
    pub fn drain_recording_buffer() -> napi::Result<Buffer> {
        info!("drainRecordingBuffer called from N-API");

        let mut engine = CAPTURE_ENGINE
            .lock()
            .map_err(|e| napi::Error::from_reason(format!("Lock poisoned: {e}")))?;

        let mut captured = engine.drain_chunk().map_err(napi::Error::from)?;

        // Process to 16kHz mono PCM for Whisper (same path as stop_recording)
        let mut processed =
            processor::prepare_for_whisper(&captured).map_err(napi::Error::from)?;

        // Zero the raw captured audio immediately (privacy guarantee)
        captured.zero();

        // Convert f32 to i16 PCM bytes (little-endian) for the Node.js side
        let pcm_i16 = processor::f32_to_i16_pcm(&processed.samples);
        processed.samples.fill(0.0);
        processed.samples.clear();

        let mut bytes: Vec<u8> = Vec::with_capacity(pcm_i16.len() * 2);
        for sample in &pcm_i16 {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }

        info!(
            pcm_bytes = bytes.len(),
            duration_seconds = processed.duration_seconds,
            "Returning drained PCM chunk to Node.js"
        );

        Ok(bytes.into())
    }

    // ── Transcript Segments ──

    /// Add a transcript segment to a meeting session.
    /// Returns the created segment as JSON.
    #[napi]
    pub fn add_transcript_segment(
        session_id: String,
        speaker_label: Option<String>,
        start_ms: i64,
        end_ms: i64,
        text: String,
        source: String,
    ) -> napi::Result<String> {
        let segment = DATABASE
            .add_transcript_segment(
                &session_id,
                speaker_label.as_deref(),
                start_ms,
                end_ms,
                &text,
                &source,
                None,
                None,
            )
            .map_err(Into::<napi::Error>::into)?;
        serde_json::to_string(&segment).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// List all transcript segments for a meeting session, ordered by start time.
    /// Returns a JSON array of TranscriptSegment objects.
    #[napi]
    pub fn list_transcript_segments(session_id: String) -> napi::Result<String> {
        let segments = DATABASE
            .list_transcript_segments(&session_id)
            .map_err(Into::<napi::Error>::into)?;
        serde_json::to_string(&segments).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Update the speaker label for a specific transcript segment.
    /// Called after post-meeting LLM diarization assigns speaker labels.
    #[napi]
    pub fn update_segment_speaker(id: String, speaker_label: String) -> napi::Result<()> {
        DATABASE
            .update_segment_speaker(&id, &speaker_label)
            .map_err(Into::into)
    }

    /// Assemble the full transcript text for a session by joining all segments.
    /// Speaker labels are prefixed if present: "[Speaker 1]: text"
    #[napi]
    pub fn assemble_full_transcript(session_id: String) -> napi::Result<String> {
        DATABASE
            .assemble_full_transcript(&session_id)
            .map_err(Into::into)
    }

    // ── Export / Sharing ──

    #[napi]
    pub fn copy_html_to_clipboard(html: String, fallback_text: String) -> napi::Result<()> {
        crate::clipboard::html::copy_html_to_clipboard(&html, &fallback_text)
            .map_err(Into::into)
    }

    #[napi]
    pub fn export_entry_markdown(id: String) -> napi::Result<String> {
        let store = EntryStore::new(DATABASE.clone());
        let entry = store.get(&id).map_err(Into::<napi::Error>::into)?;
        match entry {
            Some(e) => Ok(crate::export::formatter::entry_to_markdown(&e)),
            None => Err(napi::Error::from_reason(format!("Entry not found: {id}"))),
        }
    }

    #[napi]
    pub fn export_entry_json(id: String) -> napi::Result<String> {
        let store = EntryStore::new(DATABASE.clone());
        let entry = store.get(&id).map_err(Into::<napi::Error>::into)?;
        match entry {
            Some(e) => Ok(crate::export::formatter::entry_to_json(&e)),
            None => Err(napi::Error::from_reason(format!("Entry not found: {id}"))),
        }
    }

    #[napi]
    pub fn export_entry_plain_text(id: String) -> napi::Result<String> {
        let store = EntryStore::new(DATABASE.clone());
        let entry = store.get(&id).map_err(Into::<napi::Error>::into)?;
        match entry {
            Some(e) => Ok(crate::export::formatter::entry_to_plain_text(&e)),
            None => Err(napi::Error::from_reason(format!("Entry not found: {id}"))),
        }
    }

    #[napi]
    pub fn export_meeting_markdown(id: String) -> napi::Result<String> {
        let session = DATABASE.get_meeting_session(&id).map_err(Into::<napi::Error>::into)?;
        match session {
            Some(s) => Ok(crate::export::formatter::meeting_to_markdown(&s)),
            None => Err(napi::Error::from_reason(format!("Meeting not found: {id}"))),
        }
    }

    #[napi]
    pub fn text_to_html(text: String) -> napi::Result<String> {
        Ok(crate::export::formatter::text_to_html(&text))
    }
}
