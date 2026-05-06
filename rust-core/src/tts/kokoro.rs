#[cfg(feature = "tts")]
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tracing::{info, warn};

/// Windows process-creation flag that suppresses the console window normally
/// allocated for a console-subsystem child spawned by a GUI parent. Without
/// it, every espeak-ng invocation flashes a black CMD window on screen.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

use crate::error::IronMicError;
use crate::tts::timestamps::estimate_timestamps;
use crate::tts::{SynthesisResult, TtsConfig, TtsEngine, TtsVoice};

/// Model file names / directories.
const MODEL_FILENAME: &str = "kokoro-v1.0-fp16.onnx";
const VOICES_DIR: &str = "voices";
const DEFAULT_VOICE: &str = "af_heart";

/// Kokoro phoneme vocabulary — exact mapping from tokenizer.json.
/// IDs are NOT sequential; there are gaps. PAD = 0.
#[cfg(feature = "tts")]
fn build_vocab() -> HashMap<char, i64> {
    let entries: &[(char, i64)] = &[
        // Punctuation & special
        ('$', 0), (';', 1), (':', 2), (',', 3), ('.', 4), ('!', 5), ('?', 6),
        ('\u{2014}', 9), // — em dash
        ('\u{2026}', 10), // … ellipsis
        ('"', 11), ('(', 12), (')', 13),
        ('\u{201c}', 14), // " left double quote
        ('\u{201d}', 15), // " right double quote
        (' ', 16),
        // Rare diacritics / affricates
        ('\u{0303}', 17), // combining tilde
        ('\u{02A3}', 18), // ʣ
        ('\u{02A5}', 19), // ʥ
        ('\u{02A6}', 20), // ʦ
        ('\u{02A8}', 21), // ʨ
        ('\u{1D5D}', 22), // ᵝ
        ('\u{AB67}', 23), // ꩧ
        // Uppercase letters (sparse — only those used by Kokoro)
        ('A', 24), ('I', 25), ('O', 31), ('Q', 33), ('S', 35), ('T', 36),
        ('W', 39), ('Y', 41),
        ('\u{1D4A}', 42), // ᵊ schwa superscript
        // Lowercase letters
        ('a', 43), ('b', 44), ('c', 45), ('d', 46), ('e', 47), ('f', 48),
        ('h', 50), ('i', 51), ('j', 52), ('k', 53), ('l', 54), ('m', 55),
        ('n', 56), ('o', 57), ('p', 58), ('q', 59), ('r', 60), ('s', 61),
        ('t', 62), ('u', 63), ('v', 64), ('w', 65), ('x', 66), ('y', 67),
        ('z', 68),
        // IPA vowels & consonants
        ('\u{0251}', 69),  // ɑ
        ('\u{0250}', 70),  // ɐ
        ('\u{0252}', 71),  // ɒ
        ('\u{00E6}', 72),  // æ
        ('\u{03B2}', 75),  // β
        ('\u{0254}', 76),  // ɔ
        ('\u{0255}', 77),  // ɕ
        ('\u{00E7}', 78),  // ç
        ('\u{0256}', 80),  // ɖ
        ('\u{00F0}', 81),  // ð
        ('\u{02A4}', 82),  // ʤ
        ('\u{0259}', 83),  // ə
        ('\u{025A}', 85),  // ɚ
        ('\u{025B}', 86),  // ɛ
        ('\u{025C}', 87),  // ɜ
        ('\u{025F}', 90),  // ɟ
        ('\u{0261}', 92),  // ɡ
        ('\u{0265}', 99),  // ɥ
        ('\u{0268}', 101), // ɨ
        ('\u{026A}', 102), // ɪ
        ('\u{029D}', 103), // ʝ
        ('\u{026F}', 110), // ɯ
        ('\u{0270}', 111), // ɰ
        ('\u{014B}', 112), // ŋ
        ('\u{0273}', 113), // ɳ
        ('\u{0272}', 114), // ɲ
        ('\u{0274}', 115), // ɴ
        ('\u{00F8}', 116), // ø
        ('\u{0278}', 118), // ɸ
        ('\u{03B8}', 119), // θ
        ('\u{0153}', 120), // œ
        ('\u{0279}', 123), // ɹ
        ('\u{027E}', 125), // ɾ
        ('\u{027B}', 126), // ɻ
        ('\u{0281}', 128), // ʁ
        ('\u{027D}', 129), // ɽ
        ('\u{0282}', 130), // ʂ
        ('\u{0283}', 131), // ʃ
        ('\u{0288}', 132), // ʈ
        ('\u{02A7}', 133), // ʧ
        ('\u{028A}', 135), // ʊ
        ('\u{028B}', 136), // ʋ
        ('\u{028C}', 138), // ʌ
        ('\u{0263}', 139), // ɣ
        ('\u{0264}', 140), // ɤ
        ('\u{03C7}', 142), // χ
        ('\u{028E}', 143), // ʎ
        ('\u{0292}', 147), // ʒ
        ('\u{0294}', 148), // ʔ
        // Prosody markers
        ('\u{02C8}', 156), // ˈ primary stress
        ('\u{02CC}', 157), // ˌ secondary stress
        ('\u{02D0}', 158), // ː length
        ('\u{02B0}', 162), // ʰ aspiration
        ('\u{02B2}', 164), // ʲ palatalization
        // Tone arrows
        ('\u{2193}', 169), // ↓
        ('\u{2192}', 171), // →
        ('\u{2197}', 172), // ↗
        ('\u{2198}', 173), // ↘
        ('\u{1D7B}', 177), // ᵻ
    ];

    let mut vocab = HashMap::new();
    for &(c, id) in entries {
        vocab.insert(c, id);
    }
    vocab
}

/// Maximum number of unpadded phoneme tokens per synthesis call. Kokoro's
/// model context is 510 tokens before padding; we sit a few below to leave
/// headroom for the 2 PAD tokens and any rounding inside ort's graph.
const MAX_UNPADDED_TOKENS: usize = 500;

/// Approximate source-character budget per chunk. English text phonemizes at
/// roughly 1 phoneme/char, with letter-dense fragments going as high as 5×.
/// 250 chars is conservative for ordinary prose and small enough that even
/// a worst-case acronym-heavy chunk stays well under MAX_UNPADDED_TOKENS.
const CHUNK_CHAR_TARGET: usize = 250;

/// Public re-export so the napi layer can split before orchestrating
/// streaming playback. See split_for_synthesis below.
#[cfg(feature = "tts")]
pub fn split_text_for_streaming(text: &str) -> Vec<String> {
    split_for_synthesis(text)
}

/// Split arbitrary text into chunks for sequential synthesis.
///
/// **One chunk per sentence**, deliberately. The 200ms inter-chunk silence
/// inserted by the playback path is the *only* source of pauses we have —
/// espeak's --ipa mode strips raw punctuation from the phoneme stream, so
/// the model never hears periods or commas as prosodic input. Greedy
/// packing of multiple sentences into a single chunk would erase those
/// pause boundaries and the synthesized speech would run all of them
/// together. Trade-off: more inference calls, but with streaming playback
/// (chunk 1 plays while the rest synthesize) the perceived latency is the
/// time-to-first-audio, not the total synthesis time.
///
/// Strategy:
///   1. Split on sentence-ending punctuation (`.`, `!`, `?`, `\n`, `;`),
///      preserving the punctuation so it shows in the live caption.
///   2. Any single sentence over CHUNK_CHAR_TARGET gets split further on
///      commas, then on whitespace, in chunks of at most CHUNK_CHAR_TARGET.
///
/// Empty/whitespace-only chunks are dropped.
#[cfg(feature = "tts")]
fn split_for_synthesis(text: &str) -> Vec<String> {
    let mut sentences: Vec<String> = Vec::new();
    let mut current = String::new();

    // First pass: split on sentence-ending punctuation, preserving it.
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        current.push(c);
        let is_terminal = matches!(c, '.' | '!' | '?' | '\n' | ';');
        if is_terminal {
            // Greedy: include trailing whitespace in this sentence so the next
            // one starts clean.
            while let Some(&next) = chars.peek() {
                if next.is_whitespace() { current.push(next); chars.next(); } else { break; }
            }
            let trimmed = current.trim().to_string();
            if !trimmed.is_empty() { sentences.push(trimmed); }
            current.clear();
        }
    }
    let trimmed = current.trim().to_string();
    if !trimmed.is_empty() { sentences.push(trimmed); }

    // Second pass: split any oversized sentence further (commas, then words).
    // Sentences that already fit pass through untouched — one chunk apiece.
    let mut chunks: Vec<String> = Vec::new();
    for s in sentences {
        if s.len() <= CHUNK_CHAR_TARGET {
            chunks.push(s);
            continue;
        }
        // Try comma split first — keeps the comma trailing so prosody is
        // preserved within the model's context.
        let comma_parts: Vec<&str> = s.split(',').collect();
        if comma_parts.iter().all(|p| p.len() <= CHUNK_CHAR_TARGET) && comma_parts.len() > 1 {
            for (i, p) in comma_parts.iter().enumerate() {
                let mut piece = p.trim().to_string();
                if piece.is_empty() { continue; }
                if i + 1 < comma_parts.len() { piece.push(','); }
                chunks.push(piece);
            }
            continue;
        }
        // Last resort: word-by-word fill at the char budget.
        let mut buf = String::new();
        for word in s.split_whitespace() {
            if !buf.is_empty() && buf.len() + 1 + word.len() > CHUNK_CHAR_TARGET {
                chunks.push(buf.trim().to_string());
                buf = String::new();
            }
            if !buf.is_empty() { buf.push(' '); }
            buf.push_str(word);
        }
        if !buf.trim().is_empty() { chunks.push(buf.trim().to_string()); }
    }
    chunks
}

/// Convert text to IPA phonemes using espeak-ng, then map to Kokoro token IDs.
/// Adds PAD (0) at start and end as required by the model.
/// Returns (padded_tokens, unpadded_length).
///
/// **Rejects** inputs whose phonemized form exceeds [`MAX_UNPADDED_TOKENS`].
/// The previous behavior was to silently truncate, but truncating mid-cluster
/// with letter-dense input (acronyms, spelled letters) produces a token
/// sequence the decoder sometimes resolves to NaN/Inf — which onnxruntime's
/// Metal backend asserts on, killing the host with SIGTRAP that no Rust panic
/// handler can catch. Refusing the call up-front lets the renderer surface a
/// clean error and chunk the text instead of nuking the engine.
#[cfg(feature = "tts")]
fn phonemize_and_tokenize(text: &str, vocab: &HashMap<char, i64>) -> Result<(Vec<i64>, usize), IronMicError> {
    let phonemes = phonemize_with_espeak(text)?;
    info!(phonemes = %phonemes, "Phonemized text");

    let mut tokens = Vec::new();
    for c in phonemes.chars() {
        if let Some(&id) = vocab.get(&c) {
            tokens.push(id);
        }
        // Skip characters not in vocabulary (e.g., newlines from espeak)
    }

    if tokens.is_empty() {
        return Err(IronMicError::Tts("Text produced no tokens".into()));
    }

    // Hard upper bound: refuse rather than risk an FFI trap. The renderer
    // sanitizer caps source text but phonemizer expansion is unpredictable
    // (acronyms / numbers / spelled letters expand 4–6× per character), so a
    // server-side check here is the only safe guarantee.
    if tokens.len() > MAX_UNPADDED_TOKENS {
        return Err(IronMicError::Tts(format!(
            "Text too long for one read-back: produced {} phoneme tokens (limit {}). Try a shorter passage or break the text into paragraphs.",
            tokens.len(),
            MAX_UNPADDED_TOKENS,
        )));
    }

    let unpadded_len = tokens.len();

    // Add PAD at start and end as required by Kokoro
    tokens.insert(0, 0); // PAD start
    tokens.push(0);       // PAD end

    Ok((tokens, unpadded_len))
}

/// Call espeak-ng to convert English text to IPA phonemes.
#[cfg(feature = "tts")]
fn phonemize_with_espeak(text: &str) -> Result<String, IronMicError> {
    use std::process::Command;

    let mut cmd = Command::new("espeak-ng");
    cmd.args(["--ipa", "-q", "-v", "en-us", text]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                IronMicError::Tts(
                    "espeak-ng not found. Install it with: brew install espeak-ng".into(),
                )
            } else {
                IronMicError::Tts(format!("Failed to run espeak-ng: {e}"))
            }
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(IronMicError::Tts(format!("espeak-ng failed: {stderr}")));
    }

    let ipa = String::from_utf8_lossy(&output.stdout)
        .replace('\n', " ")  // Join multi-line output with spaces
        .replace("  ", " ")
        .trim()
        .to_string();

    Ok(ipa)
}

/// All available Kokoro voices.
fn kokoro_voices() -> Vec<TtsVoice> {
    vec![
        TtsVoice { id: "af_heart".into(), name: "Heart".into(), language: "en-us".into(), gender: "female".into(), preview_text: "Welcome to IronMic, your local voice assistant.".into() },
        TtsVoice { id: "af_bella".into(), name: "Bella".into(), language: "en-us".into(), gender: "female".into(), preview_text: "Every word you speak stays on your device.".into() },
        TtsVoice { id: "af_sarah".into(), name: "Sarah".into(), language: "en-us".into(), gender: "female".into(), preview_text: "Your privacy is our highest priority.".into() },
        TtsVoice { id: "af_nicole".into(), name: "Nicole".into(), language: "en-us".into(), gender: "female".into(), preview_text: "Dictation has never been this seamless.".into() },
        TtsVoice { id: "af_sky".into(), name: "Sky".into(), language: "en-us".into(), gender: "female".into(), preview_text: "Speak naturally. We handle the rest.".into() },
        TtsVoice { id: "af_nova".into(), name: "Nova".into(), language: "en-us".into(), gender: "female".into(), preview_text: "Fast, accurate, and completely offline.".into() },
        TtsVoice { id: "am_adam".into(), name: "Adam".into(), language: "en-us".into(), gender: "male".into(), preview_text: "Your voice, your words, your control.".into() },
        TtsVoice { id: "am_michael".into(), name: "Michael".into(), language: "en-us".into(), gender: "male".into(), preview_text: "Enterprise-grade speech recognition at your fingertips.".into() },
        TtsVoice { id: "am_fenrir".into(), name: "Fenrir".into(), language: "en-us".into(), gender: "male".into(), preview_text: "No cloud. No network. Just results.".into() },
        TtsVoice { id: "bf_alice".into(), name: "Alice".into(), language: "en-gb".into(), gender: "female".into(), preview_text: "Brilliant speech recognition, entirely on device.".into() },
        TtsVoice { id: "bf_emma".into(), name: "Emma".into(), language: "en-gb".into(), gender: "female".into(), preview_text: "Your thoughts, captured with precision.".into() },
        TtsVoice { id: "bf_lily".into(), name: "Lily".into(), language: "en-gb".into(), gender: "female".into(), preview_text: "Local AI that truly respects your privacy.".into() },
        TtsVoice { id: "bm_daniel".into(), name: "Daniel".into(), language: "en-gb".into(), gender: "male".into(), preview_text: "Speak freely, with complete confidence.".into() },
        TtsVoice { id: "bm_george".into(), name: "George".into(), language: "en-gb".into(), gender: "male".into(), preview_text: "Professional dictation, without compromise.".into() },
        TtsVoice { id: "bm_lewis".into(), name: "Lewis".into(), language: "en-gb".into(), gender: "male".into(), preview_text: "Crystal clear text from your voice.".into() },
    ]
}

/// The Kokoro 82M TTS engine using ort (ONNX Runtime) directly.
pub struct KokoroEngine {
    config: TtsConfig,
    #[cfg(feature = "tts")]
    vocab: HashMap<char, i64>,
    #[cfg(feature = "tts")]
    session: Option<Mutex<ort::session::Session>>,
    #[cfg(not(feature = "tts"))]
    _loaded: bool,
}

unsafe impl Send for KokoroEngine {}

impl KokoroEngine {
    pub fn new(config: TtsConfig) -> Self {
        Self {
            config,
            #[cfg(feature = "tts")]
            vocab: build_vocab(),
            #[cfg(feature = "tts")]
            session: None,
            #[cfg(not(feature = "tts"))]
            _loaded: false,
        }
    }

    pub fn with_defaults() -> Self {
        Self::new(TtsConfig::default())
    }

    fn model_path(&self) -> PathBuf {
        self.config.model_dir.join(MODEL_FILENAME)
    }

    fn voices_dir(&self) -> PathBuf {
        self.config.model_dir.join(VOICES_DIR)
    }

    fn voice_path(&self, voice_id: &str) -> PathBuf {
        self.voices_dir().join(format!("{voice_id}.bin"))
    }
}

impl TtsEngine for KokoroEngine {
    fn model_exists(&self) -> bool {
        self.model_path().exists() && self.voice_path(DEFAULT_VOICE).exists()
    }

    fn is_loaded(&self) -> bool {
        #[cfg(feature = "tts")]
        { self.session.is_some() }
        #[cfg(not(feature = "tts"))]
        { self._loaded }
    }

    fn load_model(&mut self) -> Result<(), IronMicError> {
        let model_path = self.model_path();
        let default_voice_path = self.voice_path(DEFAULT_VOICE);

        let model_missing = !model_path.exists();
        let voice_missing = !default_voice_path.exists();

        if model_missing || voice_missing {
            warn!(
                model = %model_path.display(),
                voice = %default_voice_path.display(),
                model_missing,
                voice_missing,
                "Kokoro TTS asset(s) not found",
            );

            #[cfg(feature = "tts")]
            {
                let msg = if model_missing && voice_missing {
                    format!(
                        "TTS assets missing. Model not found at {} and default voice not found at {}. Open Settings → Voice Output and click Repair to install both.",
                        model_path.display(),
                        default_voice_path.display(),
                    )
                } else if model_missing {
                    format!(
                        "TTS model not found at {}. Open Settings → Voice Output to download or import the Kokoro model.",
                        model_path.display(),
                    )
                } else {
                    format!(
                        "TTS default voice not found at {}. Open Settings → Voice Output and click Repair to install the voice pack.",
                        default_voice_path.display(),
                    )
                };
                return Err(IronMicError::Tts(msg));
            }
            #[cfg(not(feature = "tts"))]
            {
                warn!("TTS feature not enabled — using stub synthesis");
                self._loaded = true;
                return Ok(());
            }
        }

        info!(model = %model_path.display(), "Loading Kokoro TTS model");

        #[cfg(feature = "tts")]
        {
            let n_threads = std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(4);

            // Log severity: Warning. ort emits thousands of INFO log lines
            // during ONNX graph optimization (one per pruned NodeArg, one per
            // GraphTransformer pass). When stdout is piped to npm/vite, the
            // pipe saturates and tracing-subscriber's writer hits EAGAIN; that
            // path eventually panics across the C FFI boundary and SIGABRTs
            // Electron. Cutting the source is the only reliable fix.
            let session = ort::session::Session::builder()
                .map_err(|e| IronMicError::Tts(format!("Session builder error: {e}")))?
                .with_log_level(ort::logging::LogLevel::Warning)
                .map_err(|e| IronMicError::Tts(format!("Log level config error: {e}")))?
                .with_intra_threads(n_threads)
                .map_err(|e| IronMicError::Tts(format!("Thread config error: {e}")))?
                .commit_from_file(&model_path)
                .map_err(|e| IronMicError::Tts(format!("Failed to load model: {e}")))?;

            self.session = Some(Mutex::new(session));
            info!("Kokoro TTS model loaded successfully");
        }

        #[cfg(not(feature = "tts"))]
        {
            self._loaded = true;
        }

        Ok(())
    }

    fn synthesize(&self, text: &str) -> Result<SynthesisResult, IronMicError> {
        if text.trim().is_empty() {
            return Err(IronMicError::Tts("No text to synthesize".into()));
        }

        #[cfg(feature = "tts")]
        { self.synthesize_with_ort(text) }

        #[cfg(not(feature = "tts"))]
        { self.synthesize_stub(text) }
    }

    fn available_voices(&self) -> Vec<TtsVoice> { kokoro_voices() }

    fn set_voice(&mut self, voice_id: &str) -> Result<(), IronMicError> {
        if !kokoro_voices().iter().any(|v| v.id == voice_id) {
            return Err(IronMicError::Tts(format!("Unknown voice: {voice_id}")));
        }
        self.config.voice_id = voice_id.to_string();
        info!(voice = voice_id, "TTS voice changed");
        Ok(())
    }

    fn set_speed(&mut self, speed: f32) {
        self.config.speed = speed.clamp(0.5, 2.0);
    }
}

impl KokoroEngine {
    /// Top-level synthesis: chunk the input so each chunk fits the model's
    /// 510-token context window, run ort once per chunk, and concatenate the
    /// audio with a brief silence between chunks for prosody. Per-chunk
    /// failures are logged and skipped — never propagated — so a single
    /// pathological fragment (acronym, gibberish letter run, oversized
    /// sentence) doesn't kill an otherwise readable note. The whole call only
    /// fails if EVERY chunk failed.
    #[cfg(feature = "tts")]
    fn synthesize_with_ort(&self, text: &str) -> Result<SynthesisResult, IronMicError> {
        let session_mutex = self.session.as_ref().ok_or_else(|| {
            IronMicError::Tts("Model not loaded".into())
        })?;
        // Poison-tolerant: a previous panic that poisoned this lock should
        // not block all future synthesis.
        let mut session = match session_mutex.lock() {
            Ok(g) => g,
            Err(p) => {
                warn!("Recovered from poisoned TTS session mutex");
                p.into_inner()
            }
        };

        info!(text_len = text.len(), voice = %self.config.voice_id, "Starting synthesis");

        let chunks = split_for_synthesis(text);
        if chunks.is_empty() {
            return Err(IronMicError::Tts("Text produced no tokens".into()));
        }
        info!(chunk_count = chunks.len(), "Split input into chunks");

        let sample_rate: u32 = 24000;
        // 200 ms of silence between chunks: long enough to feel like a sentence
        // pause, short enough that long passages don't drag.
        let inter_chunk_silence = (sample_rate as usize) / 5;

        let mut all_audio: Vec<f32> = Vec::new();
        let mut all_timestamps: Vec<crate::tts::timestamps::WordTimestamp> = Vec::new();
        let mut time_offset_ms: u32 = 0;
        let mut succeeded = 0usize;
        let mut last_err: Option<String> = None;

        for (idx, chunk) in chunks.iter().enumerate() {
            match self.synthesize_chunk(&mut session, chunk) {
                Ok(mut part) => {
                    succeeded += 1;
                    let part_duration_ms = (part.duration_seconds * 1000.0) as u32;
                    // Move out of `part` rather than clone — SynthesisResult
                    // implements Drop (zeroes audio for privacy), so the
                    // fields can't be borrow-moved directly. take_samples()
                    // and mem::take leave `part` empty for safe drop.
                    let part_timestamps = std::mem::take(&mut part.timestamps);
                    let part_samples = part.take_samples();
                    for ts in part_timestamps {
                        all_timestamps.push(crate::tts::timestamps::WordTimestamp {
                            word: ts.word,
                            start_ms: ts.start_ms + time_offset_ms,
                            end_ms: ts.end_ms + time_offset_ms,
                        });
                    }
                    all_audio.extend(part_samples);
                    if idx + 1 < chunks.len() {
                        all_audio.extend(std::iter::repeat(0.0f32).take(inter_chunk_silence));
                    }
                    time_offset_ms = time_offset_ms
                        .saturating_add(part_duration_ms)
                        .saturating_add(if idx + 1 < chunks.len() { 200 } else { 0 });
                }
                Err(e) => {
                    let msg = format!("{e}");
                    warn!(
                        chunk_index = idx,
                        chunk_chars = chunk.len(),
                        err = %msg,
                        "Skipping unreadable chunk"
                    );
                    last_err = Some(msg);
                }
            }
        }

        if succeeded == 0 {
            return Err(IronMicError::Tts(format!(
                "Failed to synthesize any chunk of the text. Last error: {}",
                last_err.unwrap_or_else(|| "unknown".into()),
            )));
        }

        let duration_seconds = all_audio.len() as f64 / sample_rate as f64;
        info!(
            samples = all_audio.len(),
            duration_seconds,
            chunks_succeeded = succeeded,
            chunks_total = chunks.len(),
            "Synthesis complete",
        );

        Ok(SynthesisResult {
            samples: all_audio,
            sample_rate,
            timestamps: all_timestamps,
            duration_seconds,
        })
    }

    /// Single-chunk synthesis. Reuses an already-locked session so the chunked
    /// loop above doesn't re-acquire the mutex N times. Returns the same
    /// SynthesisResult shape as the top-level call but only for one chunk.
    #[cfg(feature = "tts")]
    fn synthesize_chunk(
        &self,
        session: &mut ort::session::Session,
        text: &str,
    ) -> Result<SynthesisResult, IronMicError> {
        use ort::value::Tensor;

        let (tokens, unpadded_len) = phonemize_and_tokenize(text, &self.vocab)?;
        let padded_len = tokens.len();

        let input_ids = Tensor::from_array(([1usize, padded_len], tokens))
            .map_err(|e| IronMicError::Tts(format!("Input tensor error: {e}")))?;

        let style_vec = self.load_voice_embedding(unpadded_len)?;
        let style = Tensor::from_array(([1usize, 256usize], style_vec))
            .map_err(|e| IronMicError::Tts(format!("Style tensor error: {e}")))?;

        let speed_tensor = Tensor::from_array(([1usize], vec![self.config.speed]))
            .map_err(|e| IronMicError::Tts(format!("Speed tensor error: {e}")))?;

        let outputs = session.run(ort::inputs![input_ids, style, speed_tensor])
            .map_err(|e| IronMicError::Tts(format!("Inference failed: {e}")))?;

        let output_value = &outputs[0];
        let (_shape, audio_slice) = output_value.try_extract_tensor::<f32>()
            .map_err(|e| IronMicError::Tts(format!("Failed to extract output: {e}")))?;

        let audio: Vec<f32> = audio_slice.to_vec();
        let sample_rate: u32 = 24000;
        let duration_seconds = audio.len() as f64 / sample_rate as f64;
        let duration_ms = (duration_seconds * 1000.0) as u32;
        let timestamps = estimate_timestamps(text, duration_ms);

        Ok(SynthesisResult {
            samples: audio,
            sample_rate,
            timestamps,
            duration_seconds,
        })
    }

    /// Load a voice embedding from the individual voice .bin file.
    /// Each voice file is raw float32, shape [510, 256].
    /// Index by unpadded token count to get the [256] style vector.
    #[cfg(feature = "tts")]
    fn load_voice_embedding(&self, unpadded_len: usize) -> Result<Vec<f32>, IronMicError> {
        let voice_path = self.voice_path(&self.config.voice_id);

        if !voice_path.exists() {
            // Fall back to the default voice only if it actually exists on disk.
            // Silently substituting a missing fallback would yield a confusing
            // "Failed to read voice file" downstream.
            let fallback_path = self.voice_path(DEFAULT_VOICE);
            if self.config.voice_id != DEFAULT_VOICE && fallback_path.exists() {
                warn!(
                    voice = %self.config.voice_id,
                    selected = %voice_path.display(),
                    fallback = %fallback_path.display(),
                    "Selected voice not found, using default voice as fallback",
                );
                return load_voice_file(&fallback_path, unpadded_len);
            }
            return Err(IronMicError::Tts(format!(
                "TTS voice '{}' not found at {}. Default voice fallback also missing at {}. Open Settings → Voice Output and click Repair to install voices.",
                self.config.voice_id,
                voice_path.display(),
                fallback_path.display(),
            )));
        }

        load_voice_file(&voice_path, unpadded_len)
    }

    #[cfg(not(feature = "tts"))]
    fn synthesize_stub(&self, text: &str) -> Result<SynthesisResult, IronMicError> {
        if !self._loaded {
            return Err(IronMicError::Tts("TTS model not loaded".into()));
        }

        let sample_rate: u32 = 24000;
        let duration = (text.len() as f64 * 0.06).max(0.5);
        let num_samples = (sample_rate as f64 * duration) as usize;

        let freq = 440.0f32;
        let samples: Vec<f32> = (0..num_samples)
            .map(|i| {
                let t = i as f32 / sample_rate as f32;
                (2.0 * std::f32::consts::PI * freq * t).sin() * 0.5
            })
            .collect();

        let duration_ms = (duration * 1000.0) as u32;
        let timestamps = estimate_timestamps(text, duration_ms);

        Ok(SynthesisResult { samples, sample_rate, timestamps, duration_seconds: duration })
    }
}

/// Load a voice embedding from an individual voice .bin file.
/// Each file is raw little-endian float32, shape [510, 256] (522,240 bytes).
/// Index by min(token_len, 509) to get the [256] style vector for the given length.
#[cfg(feature = "tts")]
fn load_voice_file(path: &std::path::Path, token_len: usize) -> Result<Vec<f32>, IronMicError> {
    let data = std::fs::read(path)
        .map_err(|e| IronMicError::Tts(format!("Failed to read voice file: {e}")))?;

    let num_floats = data.len() / 4;
    let num_rows = num_floats / 256;

    if num_rows == 0 || data.len() % 4 != 0 {
        return Err(IronMicError::Tts(format!(
            "Invalid voice file: {} bytes (expected multiple of 1024)", data.len()
        )));
    }

    // Reinterpret bytes as f32 (little-endian)
    let floats: Vec<f32> = data
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect();

    // Index by token_len, clamped to valid range
    let row_idx = token_len.min(num_rows - 1);
    let start = row_idx * 256;
    let end = start + 256;

    if end > floats.len() {
        return Err(IronMicError::Tts("Voice embedding index out of bounds".into()));
    }

    Ok(floats[start..end].to_vec())
}

/// Thread-safe wrapper for N-API access.
pub struct SharedTtsEngine {
    inner: Arc<Mutex<KokoroEngine>>,
}

impl SharedTtsEngine {
    pub fn new(engine: KokoroEngine) -> Self {
        Self { inner: Arc::new(Mutex::new(engine)) }
    }

    pub fn load_model(&self) -> Result<(), IronMicError> {
        self.inner.lock().unwrap().load_model()
    }

    pub fn is_loaded(&self) -> bool {
        self.inner.lock().unwrap().is_loaded()
    }

    pub fn model_exists(&self) -> bool {
        self.inner.lock().unwrap().model_exists()
    }

    pub fn synthesize(&self, text: &str) -> Result<SynthesisResult, IronMicError> {
        self.inner.lock().unwrap().synthesize(text)
    }

    /// Synthesize a SINGLE pre-split chunk. Used by the streaming napi
    /// orchestrator which splits the full text up-front and feeds chunks one
    /// at a time, starting playback after the first lands. Skips the inner
    /// chunking that `synthesize` does, so the caller can interleave playback
    /// with synthesis. Holds the inner mutex across the ort.run call (same
    /// behavior as the non-streaming path).
    #[cfg(feature = "tts")]
    pub fn synthesize_single_chunk(&self, text: &str) -> Result<SynthesisResult, IronMicError> {
        let mut engine = self.inner.lock().unwrap();
        // The session lives inside KokoroEngine — we have to take a transient
        // mut borrow of the session via the engine. synthesize_chunk requires
        // &mut Session, so we lock the inner session mutex here.
        let session_mutex = engine
            .session
            .as_ref()
            .ok_or_else(|| IronMicError::Tts("Model not loaded".into()))?;
        // Same poison-tolerant lock pattern as synthesize_with_ort.
        let mut session_guard = match session_mutex.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        // Re-borrow engine immutably for synthesize_chunk's & receiver — we
        // only need mut on the session, not the engine itself.
        let result = engine.synthesize_chunk(&mut session_guard, text)?;
        drop(session_guard);
        drop(engine);
        Ok(result)
    }

    /// Clone the underlying Arc<Mutex<KokoroEngine>> handle so a background
    /// thread can synthesize chunks while the napi call has already returned.
    pub fn clone_handle(&self) -> Self {
        Self { inner: Arc::clone(&self.inner) }
    }

    pub fn available_voices(&self) -> Vec<TtsVoice> {
        self.inner.lock().unwrap().available_voices()
    }

    pub fn set_voice(&self, voice_id: &str) -> Result<(), IronMicError> {
        self.inner.lock().unwrap().set_voice(voice_id)
    }

    pub fn set_speed(&self, speed: f32) {
        self.inner.lock().unwrap().set_speed(speed)
    }

    pub fn voice_id(&self) -> String {
        self.inner.lock().unwrap().config.voice_id.clone()
    }

    pub fn speed(&self) -> f32 {
        self.inner.lock().unwrap().config.speed
    }
}

impl Clone for SharedTtsEngine {
    fn clone(&self) -> Self {
        Self { inner: Arc::clone(&self.inner) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config() {
        let config = TtsConfig::default();
        assert_eq!(config.voice_id, "af_heart");
        assert_eq!(config.speed, 1.0);
    }

    #[test]
    fn engine_not_loaded_initially() {
        let engine = KokoroEngine::with_defaults();
        assert!(!engine.is_loaded());
    }

    #[test]
    fn engine_synthesize_without_loading_errors() {
        let engine = KokoroEngine::with_defaults();
        assert!(engine.synthesize("test").is_err());
    }

    #[test]
    fn engine_synthesize_empty_text_errors() {
        let engine = KokoroEngine::with_defaults();
        assert!(engine.synthesize("").is_err());
    }

    #[test]
    fn voices_list() {
        let voices = kokoro_voices();
        assert!(voices.len() >= 10);
    }

    #[test]
    #[cfg(feature = "tts")]
    fn vocab_has_correct_ids() {
        let vocab = build_vocab();
        // Verify key IPA symbols have correct IDs (not sequential)
        assert_eq!(vocab[&'ə'], 83);  // schwa
        assert_eq!(vocab[&'ɪ'], 102); // near-close near-front
        assert_eq!(vocab[&'ˈ'], 156); // primary stress
        assert_eq!(vocab[&' '], 16);  // space
        assert_eq!(vocab[&'a'], 43);  // lowercase a
        assert_eq!(vocab[&'.'], 4);   // period
    }

    #[test]
    fn set_voice_valid() {
        let mut engine = KokoroEngine::with_defaults();
        assert!(engine.set_voice("am_adam").is_ok());
    }

    #[test]
    fn set_voice_invalid() {
        let mut engine = KokoroEngine::with_defaults();
        assert!(engine.set_voice("nonexistent").is_err());
    }

    #[test]
    fn set_speed_clamps() {
        let mut engine = KokoroEngine::with_defaults();
        engine.set_speed(5.0);
        assert_eq!(engine.config.speed, 2.0);
    }

    #[test]
    fn shared_engine_basic() {
        let shared = SharedTtsEngine::new(KokoroEngine::with_defaults());
        assert!(!shared.is_loaded());
        assert_eq!(shared.voice_id(), "af_heart");
    }
}
