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
    use tracing::{info, warn};

    use crate::audio::capture::CaptureEngine;
    use crate::audio::processor;
    use crate::transcription::dictionary::Dictionary;
    use crate::transcription::engine::{self, EngineKind};
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
    ///
    /// ort/onnxruntime/transcribe_rs emit *thousands* of INFO log events
    /// during ONNX graph optimization (one per pruned NodeArg, one per
    /// GraphTransformer pass). When the stdout pipe to npm/vite saturates,
    /// each write returns EAGAIN; tracing-subscriber's fmt writer does not
    /// retry/drop gracefully and ultimately panics. That panic fires from a
    /// stack frame that is NOT under our `catch_unwind` shield, so it
    /// propagates across the C FFI boundary and aborts Electron with SIGABRT.
    /// Filter those crates to WARN so the flood never starts.
    pub(crate) fn init_tracing() {
        use tracing_subscriber::EnvFilter;
        let _ = tracing_subscriber::fmt()
            .with_env_filter(
                EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                    EnvFilter::new("info,ort=warn,onnxruntime=warn,transcribe_rs=warn")
                }),
            )
            .try_init();
        install_panic_hook();
    }

    /// Install a process-wide panic hook that logs panic location + payload via
    /// `tracing` and stderr. Without this, a panic inside a sync napi call only
    /// prints the bare panic message to stderr and the user sees an opaque app
    /// crash. With it, we get a "[panic] at file:line: message" line we can find
    /// in `~/Library/Logs/IronMic/` or the Electron stderr.
    fn install_panic_hook() {
        use std::sync::Once;
        static INIT: Once = Once::new();
        INIT.call_once(|| {
            let prev = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                let location = info
                    .location()
                    .map(|l| format!("{}:{}", l.file(), l.line()))
                    .unwrap_or_else(|| "<unknown>".into());
                let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
                    s.to_string()
                } else if let Some(s) = info.payload().downcast_ref::<String>() {
                    s.clone()
                } else {
                    "<non-string panic payload>".into()
                };
                tracing::error!(target: "ironmic-core::panic", "panic at {location}: {payload}");
                eprintln!("[ironmic-core::panic] at {location}: {payload}");
                prev(info);
            }));
        });
    }

    /// Run `f` while catching unwinding panics. Converts a panic into a
    /// `napi::Error` so the host (Electron) sees a normal JS exception instead
    /// of aborting the process. This is the only correct shape for sync napi
    /// functions on stable Rust — without it, `panic!` propagates up the FFI
    /// boundary and triggers SIGABRT in the host.
    pub(crate) fn catch_panic<T>(
        ctx: &'static str,
        f: impl FnOnce() -> napi::Result<T>,
    ) -> napi::Result<T> {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
            Ok(result) => result,
            Err(payload) => {
                let msg = if let Some(s) = payload.downcast_ref::<&str>() {
                    s.to_string()
                } else if let Some(s) = payload.downcast_ref::<String>() {
                    s.clone()
                } else {
                    "<non-string panic payload>".into()
                };
                Err(napi::Error::from_reason(format!(
                    "{ctx} panicked: {msg}. The native engine recovered; check ~/Library/Logs/IronMic/ for the panic backtrace."
                )))
            }
        }
    }

    /// Acquire a mutex lock that recovers from poisoning. A poisoned lock is
    /// not a logic error for our use cases — the playback engine state is
    /// rebuilt on every `play()`, so we'd rather keep going than abort the
    /// process when a previous panic poisoned the lock.
    fn lock_or_recover<'a, T>(m: &'a Mutex<T>) -> std::sync::MutexGuard<'a, T> {
        match m.lock() {
            Ok(g) => g,
            Err(p) => {
                tracing::warn!("Recovered from poisoned mutex");
                p.into_inner()
            }
        }
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

    /// Convert little-endian i16 PCM bytes into f32 samples in [-1, 1].
    /// Shared by `transcribe()` and `transcribe_short()`. Returns an error if
    /// the buffer length is odd (not aligned to i16 boundary).
    fn pcm16_to_f32(bytes: &[u8]) -> napi::Result<Vec<f32>> {
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
        Ok(samples)
    }

    /// Transcribe a PCM audio buffer (16kHz mono i16 little-endian) to text.
    ///
    /// Routes through the active transcription engine selected by
    /// `setTranscriptionEngine()` or by the user's `transcription_engine`
    /// setting. Defaults to Moonshine Base on a fresh install.
    #[napi]
    pub async fn transcribe(audio_buffer: Buffer) -> napi::Result<String> {
        init_tracing();
        info!("transcribe called from N-API");

        let bytes: &[u8] = &audio_buffer;
        let mut samples = pcm16_to_f32(bytes)?;

        let transcript = engine::transcribe_active(&samples, /* short */ false)
            .map_err(napi::Error::from)?;

        // Zero the sample buffer (privacy guarantee — audio leaves no
        // residual heap allocation that could be inspected later).
        samples.fill(0.0);

        Ok(transcript)
    }

    /// Transcribe a SHORT (< 5s) PCM audio buffer (16kHz mono i16 little-endian).
    ///
    /// `short` is a hint that's only honored by the Whisper engine (forces
    /// `single_segment=true` for the dictation streamer's 2.5s chunk loop).
    /// Moonshine ignores it because Moonshine is already short-form-optimized.
    ///
    /// **Do not call from meeting recording** (10–60s chunks) when running on
    /// Whisper — `single_segment` makes long buffers slower. Meeting recorder
    /// uses `transcribe()` instead.
    #[napi]
    pub async fn transcribe_short(audio_buffer: Buffer) -> napi::Result<String> {
        init_tracing();
        info!("transcribeShort called from N-API");

        let bytes: &[u8] = &audio_buffer;
        let mut samples = pcm16_to_f32(bytes)?;

        let transcript = engine::transcribe_active(&samples, /* short */ true)
            .map_err(napi::Error::from)?;

        samples.fill(0.0);

        Ok(transcript)
    }

    // ── Moonshine streaming session API ──────────────────────────────────────
    //
    // These three exports implement the growing-buffer session pattern that
    // eliminates chunk boundary word-cuts in the dictation streamer.
    //
    // Call pattern from JS DictationStreamer.runStreamingSession():
    //   1. moonshineSessionReset()          — start fresh
    //   2. loop: moonshineSessionAppend(buffer) → current hypothesis string
    //   3. moonshineSessionCommit()          → final utterance text, clears buffer
    //
    // Only meaningful when moonshineSessionSupports() returns true (i.e. the
    // active engine is a Moonshine variant compiled with engine-multi feature).
    // Whisper and NullEngine return an error from append/commit; the JS layer
    // checks supports() before entering the session loop.
    //
    // IMPORTANT: These are `async fn` — napi-rs runs them on its thread-pool
    // (not the Node.js event loop) so the synchronous Moonshine ONNX inference
    // inside doesn't block Electron's main thread. This matches the pattern
    // used by the existing `transcribe()` and `transcribe_short()` exports.

    /// Returns true if the active engine supports the session API.
    /// Checked by DictationStreamer before entering runStreamingSession().
    #[napi]
    pub fn moonshine_session_supports() -> bool {
        engine::active_engine_supports_session()
    }

    /// Append a PCM16 audio chunk to the active session buffer and return the
    /// current running hypothesis (full utterance transcribed so far).
    ///
    /// Accepts the same PCM16 Buffer format as `drainRecordingBuffer()` returns
    /// — little-endian i16 at 16 kHz mono. Conversion to f32 happens in Rust.
    ///
    /// Do NOT wrap this call in a JS timeout — the function is strictly
    /// serialized on the session mutex and a JS-side timeout would not cancel
    /// the in-flight inference, leaving the session in a corrupt ordering state.
    #[napi]
    pub async fn moonshine_session_append(audio_buffer: Buffer) -> napi::Result<String> {
        let bytes: &[u8] = &audio_buffer;
        let mut samples = pcm16_to_f32(bytes)?;

        let hypothesis = engine::session_append_active(&samples)
            .map_err(napi::Error::from)?;

        samples.fill(0.0);
        Ok(hypothesis)
    }

    /// Finalize the current session utterance. Transcribes the full accumulated
    /// buffer one final time, zeros + clears it, and returns the final text.
    #[napi]
    pub async fn moonshine_session_commit() -> napi::Result<String> {
        engine::session_commit_active().map_err(napi::Error::from)
    }

    /// Discard the session buffer without emitting text. Zero-cost no-op on
    /// engines that don't implement sessions (Whisper, NullEngine).
    #[napi]
    pub fn moonshine_session_reset() {
        engine::session_reset_active();
    }

    /// Explicitly load the active transcription engine's model.
    ///
    /// Despite the legacy name (kept for Electron compatibility), this loads
    /// whichever engine is currently active — Moonshine, Whisper, etc. The
    /// first transcription on Windows can legitimately spend a long time
    /// mapping a large GGML model before any inference happens. Keeping model
    /// load as a separate call lets Electron warm the model before starting the
    /// chunk loop, instead of timing out and dropping the user's first words.
    ///
    /// Electron should call `setTranscriptionEngine()` first if the user has
    /// a non-default engine setting, then call this to warm it up.
    #[napi]
    pub fn load_whisper_model() -> napi::Result<()> {
        init_tracing();
        info!(
            engine = engine::active_engine_kind().as_str(),
            "loadWhisperModel called from N-API (loads active engine)"
        );
        engine::load_active_engine().map_err(napi::Error::from)
    }

    /// Switch the active transcription engine. Drops the old engine's loaded
    /// model and constructs a fresh one. The new model loads lazily on the
    /// next `transcribe()` call (or eagerly via `loadWhisperModel()`).
    ///
    /// Accepts the kind as a string matching [`EngineKind::as_str`]:
    /// `"moonshine-base"`, `"whisper-large-v3-turbo"`,
    /// `"whisper-medium"`, `"whisper-small"`, `"whisper-base"`.
    #[napi]
    pub fn set_transcription_engine(kind: String) -> napi::Result<()> {
        init_tracing();
        info!(%kind, "setTranscriptionEngine called from N-API");
        let parsed = EngineKind::from_str(&kind).ok_or_else(|| {
            napi::Error::from_reason(format!("Unknown transcription engine kind: '{}'", kind))
        })?;
        engine::set_active_engine(parsed).map_err(napi::Error::from)?;

        // Critical: every engine swap creates a fresh adapter with an empty
        // Dictionary. Re-push the persisted word list so the user's custom
        // vocabulary survives the switch (Moonshine→Whisper, etc.).
        let store = DictionaryStore::new(DATABASE.clone());
        let words = store.list_words().unwrap_or_default();
        let count = words.len();
        engine::replace_active_dictionary(words);
        info!(word_count = count, "Refreshed dictionary on engine switch");
        Ok(())
    }

    /// Return the currently active transcription engine kind as a string.
    #[napi]
    pub fn get_transcription_engine() -> String {
        engine::active_engine_kind().as_str().to_string()
    }

    /// Return a JSON array of available engine kinds for the Settings UI.
    /// Each entry is `{"kind": "...", "isLoaded": bool}`. The `isLoaded`
    /// flag only reflects the *active* engine; other entries report `false`.
    #[napi]
    pub fn list_available_engines() -> String {
        let active = engine::active_engine_kind();
        let active_loaded = engine::is_active_engine_loaded();
        let entries: Vec<serde_json::Value> = EngineKind::all()
            .iter()
            .map(|k| {
                serde_json::json!({
                    "kind": k.as_str(),
                    "isActive": *k == active,
                    "isLoaded": *k == active && active_loaded,
                })
            })
            .collect();
        serde_json::Value::Array(entries).to_string()
    }

    /// Override the Whisper thread count before the model is loaded.
    ///
    /// Call this from Electron *before* `loadWhisperModel()` to apply a
    /// user-configured `whisper_threads` setting. No-op if the model is
    /// already loaded (takes effect on next app start in that case).
    #[napi]
    pub fn set_whisper_n_threads(n: u32) -> napi::Result<()> {
        init_tracing();
        info!(n, "setWhisperNThreads called from N-API");
        WHISPER_ENGINE.set_n_threads(n);
        Ok(())
    }

    /// Return the whisper.cpp system info string (CPU features, backend).
    ///
    /// Electron calls this at startup and logs it via `debugLog('whisper.sysinfo')`
    /// so AVX / AVX-512 issues are visible in the renderer DevTools console without
    /// requiring terminal access. Example output:
    ///   "AVX = 1 | AVX2 = 1 | AVX512 = 0 | F16C = 1 | FP16_VA = 0 | ..."
    #[napi]
    pub fn get_whisper_system_info() -> String {
        #[cfg(feature = "whisper")]
        {
            whisper_rs::print_system_info().to_string()
        }
        #[cfg(not(feature = "whisper"))]
        {
            "whisper feature not compiled".to_string()
        }
    }

    /// Compile-time feature flags of this addon.  Electron reads this at
    /// startup so a stub binary (e.g. Whisper omitted from the Cargo features)
    /// can be detected before the user attempts to dictate.
    #[napi]
    pub fn native_features() -> napi::Result<String> {
        let json = serde_json::json!({
            "whisper": cfg!(feature = "whisper"),
            "metal": cfg!(feature = "metal"),
            "llm": cfg!(feature = "llm"),
            "tts": cfg!(feature = "tts"),
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        });
        serde_json::to_string(&json).map_err(|e| napi::Error::from_reason(e.to_string()))
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
        pub raw_transcript_json: Option<String>,
        pub polished_text_json: Option<String>,
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
        pub raw_transcript_json: Option<String>,
        pub polished_text_json: Option<String>,
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
                raw_transcript_json: e.raw_transcript_json,
                polished_text_json: e.polished_text_json,
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
        pub raw_transcript_json: Option<String>,
        pub polished_text_json: Option<String>,
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
            raw_transcript_json: entry.raw_transcript_json,
            polished_text_json: entry.polished_text_json,
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
            raw_transcript_json: updates.raw_transcript_json,
            polished_text_json: updates.polished_text_json,
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
        store.add_word(&word)?;
        // Best-effort: push to active engine. If the engine mutex is poisoned
        // we still succeed the SQLite write.
        engine::apply_active_dictionary_change(&word, /* removed */ false);
        Ok(())
    }

    #[napi]
    pub fn remove_word(word: String) -> napi::Result<()> {
        let store = DictionaryStore::new(DATABASE.clone());
        store.remove_word(&word)?;
        engine::apply_active_dictionary_change(&word, /* removed */ true);
        Ok(())
    }

    #[napi]
    pub fn list_dictionary() -> napi::Result<Vec<String>> {
        let store = DictionaryStore::new(DATABASE.clone());
        store.list_words().map_err(Into::into)
    }

    /// Read the persisted dictionary from SQLite and push it into the
    /// currently-active transcription engine. Idempotent and cheap. Called by
    /// Electron at app boot (after the engine setting is restored), at
    /// meeting start (drift safety net), and internally on engine switch.
    #[napi]
    pub fn refresh_transcription_dictionary() -> napi::Result<u32> {
        let store = DictionaryStore::new(DATABASE.clone());
        let words = store.list_words().unwrap_or_default();
        let count = words.len() as u32;
        engine::replace_active_dictionary(words);
        info!(word_count = count, "refreshTranscriptionDictionary applied");
        Ok(count)
    }

    /// Transcribe with per-call context terms (e.g. meeting participant
    /// names) layered on top of the stored dictionary. `terms_json` is a
    /// JSON array of strings; an empty array or invalid JSON falls back to
    /// the equivalent of `transcribe()`.
    ///
    /// Whisper merges these into the `initial_prompt`. Moonshine ignores
    /// them (no vocabulary API in transcribe-rs); the renderer applies
    /// fuzzy post-correction instead.
    #[napi]
    pub async fn transcribe_with_context(
        audio_buffer: Buffer,
        terms_json: String,
    ) -> napi::Result<String> {
        init_tracing();
        let context_terms: Vec<String> =
            serde_json::from_str(&terms_json).unwrap_or_default();
        info!(
            terms = context_terms.len(),
            "transcribeWithContext called from N-API"
        );

        let bytes: &[u8] = &audio_buffer;
        let mut samples = pcm16_to_f32(bytes)?;

        let transcript = engine::transcribe_active_with_context(
            &samples,
            /* short */ false,
            &context_terms,
        )
        .map_err(napi::Error::from)?;

        samples.fill(0.0);

        Ok(transcript)
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
                name: llm_model_path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("phi3-mini-q2k")
                    .trim_end_matches(".gguf")
                    .into(),
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
    use crate::tts::playback::{PlaybackEngine, TTS_LEADING_SILENCE_MS};

    static TTS_ENGINE: std::sync::LazyLock<SharedTtsEngine> =
        std::sync::LazyLock::new(|| SharedTtsEngine::new(KokoroEngine::with_defaults()));

    static PLAYBACK_ENGINE: std::sync::LazyLock<Mutex<PlaybackEngine>> =
        std::sync::LazyLock::new(|| Mutex::new(PlaybackEngine::new()));

    /// Cumulative TTS stream state. Each call to `synthesize_text` resets
    /// these and the background thread keeps appending to them as chunks
    /// complete. The renderer polls `tts_get_stream_state` to learn about
    /// new timestamps + total duration without waiting for synthesis to
    /// finish.
    static STREAM_TIMESTAMPS: std::sync::LazyLock<Mutex<Vec<crate::tts::timestamps::WordTimestamp>>> =
        std::sync::LazyLock::new(|| Mutex::new(Vec::new()));
    static STREAM_DURATION_MS: std::sync::atomic::AtomicU64 =
        std::sync::atomic::AtomicU64::new(0);
    static STREAM_CHUNKS_DONE: std::sync::atomic::AtomicU32 =
        std::sync::atomic::AtomicU32::new(0);
    static STREAM_CHUNKS_TOTAL: std::sync::atomic::AtomicU32 =
        std::sync::atomic::AtomicU32::new(0);
    /// Generation counter that lets the background synthesis thread detect
    /// "I've been superseded" — every new call to `synthesize_text` bumps
    /// this and the thread bails as soon as the stored value diverges from
    /// the one it captured at spawn.
    static SYNTH_GENERATION: std::sync::atomic::AtomicU64 =
        std::sync::atomic::AtomicU64::new(0);

    #[napi]
    pub fn synthesize_text(text: String) -> napi::Result<String> {
        init_tracing();
        info!("synthesizeText called, text_len={}", text.len());

        catch_panic("synthesize_text", || {
            if !TTS_ENGINE.is_loaded() {
                TTS_ENGINE.load_model().map_err(napi::Error::from)?;
            }

            #[cfg(feature = "tts")]
            let chunks = crate::tts::kokoro::split_text_for_streaming(&text);
            #[cfg(not(feature = "tts"))]
            let chunks: Vec<String> = vec![text.clone()];

            if chunks.is_empty() {
                return Err(napi::Error::from_reason(
                    "Text produced no chunks to synthesize",
                ));
            }
            info!(chunks = chunks.len(), "Streaming synthesis: split into chunks");

            // Stop any in-flight playback. Bumping SYNTH_GENERATION first so
            // any still-running thread from a previous call exits cleanly
            // when it next checks the counter.
            let my_gen = SYNTH_GENERATION
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                + 1;
            {
                let mut playback = lock_or_recover(&PLAYBACK_ENGINE);
                playback.stop();
            }

            // Reset cumulative stream state.
            STREAM_TIMESTAMPS.lock().unwrap().clear();
            STREAM_DURATION_MS.store(0, std::sync::atomic::Ordering::SeqCst);
            STREAM_CHUNKS_DONE.store(0, std::sync::atomic::Ordering::SeqCst);
            STREAM_CHUNKS_TOTAL.store(chunks.len() as u32, std::sync::atomic::Ordering::SeqCst);

            // Synthesize chunk 1 synchronously so the napi response carries
            // real timestamps + duration AND playback has already started by
            // the time the renderer's polling loop fires its first tick.
            let mut chunk1_idx = 0usize;
            let mut chunk1_result = None;
            for (i, chunk) in chunks.iter().enumerate() {
                match TTS_ENGINE.synthesize_single_chunk(chunk) {
                    Ok(r) => { chunk1_result = Some(r); chunk1_idx = i; break; }
                    Err(e) => {
                        warn!(idx = i, err = %e, "First-chunk synthesis failed; trying next");
                        STREAM_CHUNKS_DONE.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }
                }
            }
            let mut chunk1 = match chunk1_result {
                Some(r) => r,
                None => {
                    // Every chunk failed. Surface the failure cleanly.
                    return Err(napi::Error::from_reason(
                        "Failed to synthesize any chunk of the text",
                    ));
                }
            };

            let sample_rate = chunk1.sample_rate;
            let raw_chunk1_duration_ms = (chunk1.duration_seconds * 1000.0) as u64;
            let raw_chunk1_timestamps = std::mem::take(&mut chunk1.timestamps);
            let chunk1_samples = chunk1.take_samples();

            // play_internal will prepend TTS_LEADING_SILENCE_MS of silence to
            // chunk-1 audio (Windows only; const is 0 elsewhere). Shift the
            // word timestamps + reported duration by the same amount so the
            // renderer's highlight cursor stays aligned with the audio. We
            // build *adjusted* values here and use ONLY those below — never
            // the raw originals — so the two sides cannot drift.
            let chunk1_timestamps: Vec<crate::tts::timestamps::WordTimestamp> =
                raw_chunk1_timestamps
                    .into_iter()
                    .map(|ts| crate::tts::timestamps::WordTimestamp {
                        word: ts.word,
                        start_ms: ts.start_ms + TTS_LEADING_SILENCE_MS as u32,
                        end_ms: ts.end_ms + TTS_LEADING_SILENCE_MS as u32,
                    })
                    .collect();
            let chunk1_duration_ms = raw_chunk1_duration_ms + TTS_LEADING_SILENCE_MS;

            // Seed the cumulative timestamp / duration state with chunk 1.
            STREAM_TIMESTAMPS.lock().unwrap().extend(chunk1_timestamps.clone());
            STREAM_DURATION_MS.store(chunk1_duration_ms, std::sync::atomic::Ordering::SeqCst);
            STREAM_CHUNKS_DONE.fetch_add(1, std::sync::atomic::Ordering::SeqCst);

            // Start playback in streaming mode so cpal won't auto-stop on EOF
            // while later chunks are still being appended.
            {
                let mut playback = lock_or_recover(&PLAYBACK_ENGINE);
                playback
                    .play_streaming(chunk1_samples, sample_rate)
                    .map_err(napi::Error::from)?;
            }

            // Spawn background thread for remaining chunks. It owns a clone
            // of the TTS engine handle and writes into the shared stream
            // state + playback engine as each chunk lands.
            let remaining: Vec<String> = chunks.iter().skip(chunk1_idx + 1).cloned().collect();
            if !remaining.is_empty() {
                let engine = TTS_ENGINE.clone_handle();
                std::thread::spawn(move || {
                    // 200 ms silence between chunks for natural sentence
                    // pauses (espeak --ipa strips punctuation, so this is
                    // our only mechanism for prosodic breaks).
                    let silence: Vec<f32> = vec![0.0f32; (sample_rate as usize) / 5];
                    let silence_ms: u64 = 200;

                    for chunk in remaining {
                        // Cancellation: a newer synthesize_text call has
                        // started, or the user pressed stop. Bail.
                        if SYNTH_GENERATION.load(std::sync::atomic::Ordering::SeqCst) != my_gen {
                            return;
                        }
                        let pb_state = lock_or_recover(&PLAYBACK_ENGINE).state();
                        if pb_state == crate::tts::playback::PlaybackState::Idle {
                            return;
                        }

                        match engine.synthesize_single_chunk(&chunk) {
                            Ok(mut part) => {
                                let part_duration_ms = (part.duration_seconds * 1000.0) as u64;
                                let part_timestamps = std::mem::take(&mut part.timestamps);
                                let part_samples = part.take_samples();

                                // Append silence + new audio. The cpal
                                // callback's mutex serializes with these.
                                {
                                    let playback = lock_or_recover(&PLAYBACK_ENGINE);
                                    let _ = playback.append_samples(silence.clone());
                                    let _ = playback.append_samples(part_samples);
                                }

                                // Offset timestamps by current cumulative
                                // duration BEFORE we add this chunk.
                                let offset_ms = STREAM_DURATION_MS
                                    .load(std::sync::atomic::Ordering::SeqCst)
                                    + silence_ms;
                                let mut ts_lock = STREAM_TIMESTAMPS.lock().unwrap();
                                for ts in part_timestamps {
                                    ts_lock.push(crate::tts::timestamps::WordTimestamp {
                                        word: ts.word,
                                        start_ms: ts.start_ms + offset_ms as u32,
                                        end_ms: ts.end_ms + offset_ms as u32,
                                    });
                                }
                                drop(ts_lock);
                                STREAM_DURATION_MS.fetch_add(
                                    silence_ms + part_duration_ms,
                                    std::sync::atomic::Ordering::SeqCst,
                                );
                            }
                            Err(e) => {
                                warn!(err = %e, "Skipping unreadable chunk during streaming");
                            }
                        }
                        STREAM_CHUNKS_DONE.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }

                    // Last chunk done — release the cpal auto-stop gate so
                    // playback ends naturally when the cursor catches up.
                    if SYNTH_GENERATION.load(std::sync::atomic::Ordering::SeqCst) == my_gen {
                        lock_or_recover(&PLAYBACK_ENGINE).mark_streaming_complete();
                    }
                });
            } else {
                // Single-chunk note — there's no background work, so flip
                // the auto-stop gate immediately. Playback ends when chunk
                // 1's audio is exhausted.
                lock_or_recover(&PLAYBACK_ENGINE).mark_streaming_complete();
            }

            // Return chunk-1 timestamps + duration so the renderer's UI
            // (live caption strip, progress bar) has something to render
            // immediately. The poll loop fetches the cumulative state via
            // tts_get_stream_state and replaces these as more chunks land.
            let response = serde_json::json!({
                "timestamps": chunk1_timestamps,
                "durationMs": chunk1_duration_ms,
                "streaming": !chunks.is_empty() && chunks.len() > 1,
                "chunkCount": chunks.len(),
            });
            Ok(response.to_string())
        })
    }

    /// Cumulative streaming state for the renderer. Returns the full
    /// timestamps array known so far plus current duration; the renderer's
    /// poll loop fetches this each tick to grow the live caption window
    /// as background chunks land.
    #[napi]
    pub fn tts_get_stream_state() -> String {
        let timestamps = STREAM_TIMESTAMPS.lock().unwrap().clone();
        let duration_ms = STREAM_DURATION_MS.load(std::sync::atomic::Ordering::SeqCst);
        let chunks_done = STREAM_CHUNKS_DONE.load(std::sync::atomic::Ordering::SeqCst);
        let chunks_total = STREAM_CHUNKS_TOTAL.load(std::sync::atomic::Ordering::SeqCst);
        let response = serde_json::json!({
            "timestamps": timestamps,
            "durationMs": duration_ms,
            "chunksDone": chunks_done,
            "chunksTotal": chunks_total,
            "complete": chunks_total > 0 && chunks_done >= chunks_total,
        });
        response.to_string()
    }

    #[napi]
    pub fn tts_play() -> napi::Result<()> {
        catch_panic("tts_play", || {
            let mut playback = lock_or_recover(&PLAYBACK_ENGINE);
            playback.resume();
            Ok(())
        })
    }

    #[napi]
    pub fn tts_pause() -> napi::Result<()> {
        catch_panic("tts_pause", || {
            let mut playback = lock_or_recover(&PLAYBACK_ENGINE);
            playback.pause();
            Ok(())
        })
    }

    #[napi]
    pub fn tts_stop() -> napi::Result<()> {
        catch_panic("tts_stop", || {
            let mut playback = lock_or_recover(&PLAYBACK_ENGINE);
            playback.stop();
            Ok(())
        })
    }

    #[napi]
    pub fn tts_get_position() -> f64 {
        let playback = lock_or_recover(&PLAYBACK_ENGINE);
        playback.position_ms()
    }

    #[napi]
    pub fn tts_get_state() -> String {
        let playback = lock_or_recover(&PLAYBACK_ENGINE);
        playback.state().to_string()
    }

    #[napi]
    pub fn tts_set_speed(speed: f64) -> napi::Result<()> {
        catch_panic("tts_set_speed", || {
            let playback = lock_or_recover(&PLAYBACK_ENGINE);
            playback.set_speed(speed as f32);
            TTS_ENGINE.set_speed(speed as f32);
            Ok(())
        })
    }

    #[napi]
    pub fn tts_set_voice(voice_id: String) -> napi::Result<()> {
        catch_panic("tts_set_voice", || {
            TTS_ENGINE.set_voice(&voice_id).map_err(Into::into)
        })
    }

    #[napi]
    pub fn tts_available_voices() -> String {
        let voices = TTS_ENGINE.available_voices();
        serde_json::to_string(&voices).unwrap_or_else(|_| "[]".into())
    }

    #[napi]
    pub fn tts_load_model() -> napi::Result<()> {
        init_tracing();
        catch_panic("tts_load_model", || {
            TTS_ENGINE.load_model().map_err(Into::into)
        })
    }

    /// Validate that an ONNX file at `path` is loadable as a Kokoro TTS model.
    /// Opens a one-shot ort::Session against the path on a local builder — does
    /// NOT touch the global TTS_ENGINE. Used by the import path to accept a
    /// renamed-but-valid Kokoro file before swapping it into the canonical
    /// model location.
    #[napi]
    pub fn tts_validate_model_file(path: String) -> napi::Result<()> {
        init_tracing();
        catch_panic("tts_validate_model_file", || {
        #[cfg(feature = "tts")]
        {
            let p = std::path::Path::new(&path);
            if !p.exists() {
                return Err(napi::Error::from_reason(format!(
                    "Validation file not found: {path}"
                )));
            }
            let n_threads = std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(2);
            let session = ort::session::Session::builder()
                .map_err(|e| napi::Error::from_reason(format!("Session builder error: {e}")))?
                .with_log_level(ort::logging::LogLevel::Warning)
                .map_err(|e| napi::Error::from_reason(format!("Log level config error: {e}")))?
                .with_intra_threads(n_threads)
                .map_err(|e| napi::Error::from_reason(format!("Thread config error: {e}")))?
                .commit_from_file(p)
                .map_err(|e| napi::Error::from_reason(format!(
                    "Not a loadable ONNX model: {e}"
                )))?;

            // Kokoro signature: 3 inputs (tokens int64, style float, speed float)
            // and 1 output (audio float). Reject mismatches before accepting.
            let n_inputs = session.inputs().len();
            let n_outputs = session.outputs().len();
            if n_inputs != 3 || n_outputs < 1 {
                return Err(napi::Error::from_reason(format!(
                    "ONNX signature mismatch: expected Kokoro (3 inputs, ≥1 output), got ({n_inputs} inputs, {n_outputs} outputs). This doesn't look like a Kokoro model."
                )));
            }
            drop(session);
            Ok(())
        }
        #[cfg(not(feature = "tts"))]
        {
            let _ = path;
            Err(napi::Error::from_reason(
                "TTS feature not enabled in this build",
            ))
        }
        })
    }

    #[napi]
    pub fn tts_is_loaded() -> bool {
        TTS_ENGINE.is_loaded()
    }

    #[napi]
    pub fn tts_toggle() -> String {
        match catch_panic("tts_toggle", || {
            let mut playback = lock_or_recover(&PLAYBACK_ENGINE);
            Ok(playback.toggle().to_string())
        }) {
            Ok(s) => s,
            Err(_) => "idle".into(),
        }
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

    /// Replace the entire participant roster on a meeting. JSON is a camelCase
    /// array of `{ id, displayName, isHost, joinedAt, leftAt? }`. Validation
    /// happens server-side (max 32 entries, 64-char display name cap).
    #[napi]
    pub fn set_meeting_participants(id: String, participants_json: String) -> napi::Result<()> {
        DATABASE
            .set_meeting_participants(&id, &participants_json)
            .map_err(Into::into)
    }

    /// Append (or update by id) a single participant. Read-merge-write inside
    /// Rust to avoid races between concurrent join broadcasts.
    #[napi]
    pub fn add_meeting_participant(id: String, participant_json: String) -> napi::Result<()> {
        DATABASE
            .add_meeting_participant(&id, &participant_json)
            .map_err(Into::into)
    }

    /// Stamp `leftAt` on a participant without removing them from the roster.
    /// Idempotent — silently no-ops if the participant id isn't found.
    #[napi]
    pub fn mark_meeting_participant_left(
        id: String,
        participant_id: String,
        left_at: i64,
    ) -> napi::Result<()> {
        DATABASE
            .mark_meeting_participant_left(&id, &participant_id, left_at)
            .map_err(Into::into)
    }

    /// Read the JSON roster string for a meeting (camelCase). Returns "[]" if
    /// the meeting doesn't exist.
    #[napi]
    pub fn get_meeting_participants(id: String) -> napi::Result<String> {
        DATABASE.get_meeting_participants(&id).map_err(Into::into)
    }

    /// Look up the most recent local meeting session linked to a remote (host)
    /// session id, INCLUDING already-ended rows. Used by the participant
    /// rejoin flow to recognize a prior visit. Returns JSON
    /// `{ id, ended_at }` or the literal string `"null"` if none exists.
    #[napi]
    pub fn find_latest_local_session_for_remote(remote_id: String) -> napi::Result<String> {
        let row = DATABASE
            .find_latest_local_session_for_remote(&remote_id)
            .map_err(Into::<napi::Error>::into)?;
        match row {
            Some((id, ended_at)) => serde_json::to_string(&serde_json::json!({
                "id": id,
                "ended_at": ended_at,
            }))
            .map_err(|e| napi::Error::from_reason(e.to_string())),
            None => Ok("null".to_string()),
        }
    }

    /// Returns the largest `Meeting #N` sequence number assigned so far.
    /// Replaces the renderer's full-table `meetingList(9999, 0)` JSON scan
    /// with an indexed lookup. Returns 0 if no meetings have a sequence
    /// number yet.
    #[napi]
    pub fn get_max_meeting_sequence() -> napi::Result<i64> {
        DATABASE.get_max_meeting_sequence().map_err(Into::into)
    }

    /// Reopen a previously-ended meeting session so a rejoining participant
    /// can resume into it. Clears the SQL-level sealed-state columns
    /// (`ended_at`, `summary`, `total_duration_seconds`, `entry_ids`); the JS
    /// caller is responsible for the matching `structured_output` JSON merge.
    #[napi]
    pub fn reopen_meeting_session(id: String) -> napi::Result<()> {
        DATABASE.reopen_meeting_session(&id).map_err(Into::into)
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

    /// Idempotent variant: dedups on (session_id, remote_segment_id). Used by
    /// participant ingest of host-broadcast / welcome-snapshot segments so a
    /// rejoin can replay the snapshot freely. Returns the canonical row
    /// (existing if previously inserted, freshly minted otherwise).
    #[napi]
    pub fn add_transcript_segment_with_remote_id(
        session_id: String,
        speaker_label: Option<String>,
        start_ms: i64,
        end_ms: i64,
        text: String,
        source: String,
        remote_segment_id: String,
    ) -> napi::Result<String> {
        let segment = DATABASE
            .add_transcript_segment_with_remote_id(
                &session_id,
                speaker_label.as_deref(),
                start_ms,
                end_ms,
                &text,
                &source,
                &remote_segment_id,
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
