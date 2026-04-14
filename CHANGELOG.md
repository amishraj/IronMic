# Changelog

All notable changes to IronMic will be documented in this file.

## [1.1.3] - 2026-04-13

### Fixed
- **Analytics white screen on fresh install** — The analytics dashboard crashed with a blank white page when no dictation data existed. Each analytics API call now loads independently with safe fallbacks, so one failure doesn't blank the entire page. Added an error boundary that catches Recharts rendering crashes and shows a friendly recovery message.
- **"Self-signed certificate in certificate chain" when downloading models** — Model downloads used Node.js `https` module which doesn't trust the system certificate store. Switched to Electron's `net` module which uses the OS certificate store, fixing downloads on corporate networks, VPNs, and systems with proxy TLS interception. Falls back to Node.js `https` if Electron's net module is unavailable.

---

## [1.1.2] - 2026-04-13

### Fixed
- **Model downloads fail in packaged app** — `ENOENT: no such file or directory, mkdir .../IronMic.app/Contents/Resources/rust-core/models`. The model directory path was resolved at module load time (top-level `const`), but TypeScript import hoisting caused the module to load before `IRONMIC_MODELS_DIR` was set, so it fell back to a path inside the read-only `.app` bundle. Changed to lazy resolution so the env var is read at download time. This fixes all model downloads: Whisper, LLM, chat models (Llama3, Phi3), TTS, and TF.js ML models.

---

## [1.1.1] - 2026-04-13

### Fixed
- **Clippy CI failures** — Renamed `ChatModel::from_str()` to `ChatModel::parse()` to avoid `clippy::should_implement_trait` warning. Flattened manual `if let Some` iterator patterns in analytics top-words and source-breakdown aggregation. Added type alias for complex tuple in analytics recompute.

---

## [1.1.0] - 2026-04-13

### Added — On-Device Machine Learning (TensorFlow.js)

IronMic now includes 5 TensorFlow.js-powered ML features that run entirely on-device. All models are lightweight (<50MB total), all training data stays local, and everything works offline. A new **Voice AI** settings tab provides toggles and thresholds for each feature.

#### Feature 1: Intelligent Voice Activity Detection (3 parts + bonus)

- **Silent Efficiency Layer (VAD)** — Silero VAD model filters silence and background noise before audio reaches Whisper, reducing unnecessary transcription. Uses a dual-pipeline approach: Web Audio API captures real-time frames for VAD classification while Rust/cpal handles the official recording. Configurable sensitivity slider. Energy-based fallback when model is unavailable.
- **Conversational AI Turn Detection** — Detects when you've finished speaking and automatically triggers the transcription pipeline. Three modes: push-to-talk (default, existing behavior), auto-detect (silence timeout triggers stop, default 3s), and always-listening (continuous mic with persistent indicator). Creates a hands-free conversation loop: speak -> auto-transcribe -> AI responds -> TTS reads response -> recording resumes.
- **Context-Aware Voice Routing** — Automatically routes voice input based on your current screen. AI Chat screen routes to conversation, Notes/Editor routes to dictation, command keywords route to intent classification. Voice error recovery: say "no, I meant..." to undo and re-route.
- **Ambient Meeting Mode** — Passive listening with energy-based speaker turn detection. Auto-detects meeting end after sustained silence. Generates summary and action items via local LLM on meeting end. Meeting sessions stored with full transcript segments.

#### Feature 2: Intent Classification + Entity Extraction

- **Voice commands** — After Whisper transcribes, the intent classifier parses commands into structured actions. Supports: search, open_view, navigate, summarize, create_ticket, update_ticket, assign, set_status, add_label, comment.
- **Entity extraction** — Extracts ticket names, assignees, search queries, view names, and other entities from voice commands.
- **Rule-based V1** — Ships with regex pattern matching for immediate use, no model download needed.
- **LLM fallback** — When rule-based confidence is low, falls back to the local LLM for classification.
- **ActionRouter** — Maps classified intents to application actions (navigation, search, summarization, structured entry creation for future integrations).
- **Voice correction** — Say "no, I meant..." or "cancel" to undo the last command and re-classify.

#### Feature 3: Adaptive Notification Intelligence

- **In-app notification system** — New notification bell with unread badge, slide-out panel with notification cards. Sources: entry creation, analytics milestones, workflow suggestions, system events.
- **ML-powered ranking** — Small feedforward neural network learns which notifications you engage with vs. ignore. Starts with rule-based heuristics, begins ML ranking after ~50 interactions.
- **On-device training** — Model trains incrementally from your interaction patterns. Weights stored in SQLite. No data leaves the device.
- **Transparency** — Notifications show why they were ranked ("learning your preferences..." indicator during cold-start phase).

#### Feature 4: Auto-Discovered Workflows

- **Action logging** — Transparently logs action types (never content) as you use the app: create entries, search, dictate, use AI chat, play TTS, edit notes, etc.
- **Sequence mining** — Sliding-window algorithm detects repeating action patterns with temporal consistency (same day of week, same hour range).
- **Workflow suggestions** — Discovered patterns surface via the notification system with confidence scores. Users can save, name, dismiss, or edit workflows.
- **Next-action prediction** — Frequency-based predictor suggests what you might do next based on recent action history.

#### Feature 5: On-Device Semantic Search

- **Universal Sentence Encoder** — Generates 512-dimensional embeddings for all content using a ~30MB model running in the ML Web Worker.
- **Cosine similarity search** — Search by meaning, not just keywords. "find everything about authentication" returns semantically related entries even if they don't contain that exact word.
- **Incremental embedding** — New content is embedded on creation. Existing content can be bulk-indexed from Settings.
- **Merged search** — Semantic results combined with existing FTS5 keyword search for comprehensive results.

### Added — Infrastructure

- **TensorFlow.js runtime** — WebGL backend (falls back to CPU) with LRU model cache
- **ML Web Worker** — All TF.js inference runs in a dedicated Web Worker to keep the UI thread free. Typed message protocol with Promise-based client.
- **Web Audio API bridge** — Dual-pipeline audio capture: Web Audio + AudioWorklet for real-time VAD alongside Rust/cpal for Whisper recording
- **SQLite schema v3** — 11 new tables for ML features: vad_training_samples, intent_training_samples, voice_routing_log, meeting_sessions, notifications, notification_interactions, action_log, workflows, embeddings, ml_model_weights, tfjs_model_metadata
- **~50 new IPC channels** — Full CRUD for all ML data through the existing Electron IPC bridge
- **Voice AI settings tab** — Unified controls for all ML features with enable/disable toggles, sensitivity sliders, confidence thresholds, and "Delete all learned data" button
- **Notification UI** — NotificationBell component with unread badge and NotificationPanel slide-out drawer

### Changed

- **useRecordingStore** — Now integrates VAD: starts voice activity detection alongside recording, skips Whisper transcription when insufficient speech detected
- **SettingsPanel** — Added 7th tab (Voice AI) with Brain icon
- **Rust storage layer** — 8 new storage modules with ~40 CRUD functions
- **lib.rs** — ~50 new napi-rs exports for all ML storage operations
- **constants.ts** — ~50 new IPC channel definitions
- **preload/index.ts** — ~50 new typed preload API methods
- **types/index.ts** — New types: Notification, Workflow, MeetingSession, MLModelWeights, TurnDetectionMode, VoiceRoute, VoiceState

### Privacy

- All ML processing runs on-device via TensorFlow.js (renderer process Web Worker)
- VAD training stores MFCC audio features, never raw audio
- Action logging records action types only, never content
- All learned data stored in local SQLite, deletable per-feature or globally
- Total TF.js model bundle: ~46MB (well under 100MB budget)
- No new network calls introduced

---

## [1.0.15] - 2026-04-09

### Added
- **Analytics dashboard** — new analytics page with daily word counts, topic classification via local LLM, vocabulary richness metrics, streaks, and productivity comparison
- **LLM-powered topic classification** — batch processing of entries for topic tagging using local Mistral 7B

---

## [1.0.14] - 2026-04-08

### Fixed
- **Hardened release workflow** — merged Rust build and .node copy into a single step to prevent silent failures. Added pre-package verification that fails the build if the native addon or TTS voices are missing.
- **ModelManager resilience** — each IPC call (models, GPU status) now loads independently so one failure doesn't blank the entire Settings > Models section.

---

## [1.0.13] - 2026-04-08

### Fixed
- **Blank Models section in packaged app** — the release workflow built the Rust native addon but never copied it to `ironmic-core.node`, so electron-builder couldn't bundle it. The app fell back to JavaScript stubs with no model functions. Added a copy step that handles macOS (.dylib), Linux (.so), and Windows (.dll) correctly.

---

## [1.0.11] - 2026-04-07

### Changed
- **Models now hosted on GitHub Releases** — all model downloads (Whisper, LLM, TTS) now pull from `models-v1` release assets on the IronMic GitHub repo instead of HuggingFace. Eliminates external supply chain dependency. SHA-256 integrity verification on all files.
- **HuggingFace fallback** — if GitHub download fails after 3 retries, falls back to HuggingFace with a warning. Integrity still verified regardless of source.
- **LLM split-file download** — the 4.4 GB Mistral model is split into 3 parts (~1.5 GB each) on GitHub Releases (2 GB per-asset limit). Automatically reassembled and verified on download.
- **TTS voices bundled in installer** — all 15 English voice files (~7.5 MB total) are now included in the installer. Text-to-speech read-back works immediately without any download.
- **Per-variant Whisper downloads** — users can now download medium, small, and base Whisper models individually from Settings (previously only large-v3-turbo was downloadable).
- **LLM download button** — the Text Cleanup Model section now has a download button with progress tracking.
- **New `upload-models.yml` workflow** — manually-triggered GitHub Actions workflow to fetch models from HuggingFace, verify checksums, split the LLM, and upload all assets to a pinned models release.

---

## [1.0.10] - 2026-04-07

### Fixed
- **Model downloads broken in packaged builds** — model-downloader and all Rust model loaders (Whisper, LLM, TTS) used paths that don't exist in packaged apps (`__dirname` relative traversal and `env!("CARGO_MANIFEST_DIR")` compile-time path). Now uses `IRONMIC_MODELS_DIR` env var set by Electron main process, pointing to the user's app-data directory in production.
- **GPU always reports CPU-only in release builds** — release workflow was missing `--features metal,tts` flag, so Metal GPU support was compiled out. macOS builds now include `metal` feature; all platforms include `tts`.

---

## [1.0.9] - 2026-04-06

### Fixed
- **macOS DMG crash on launch** — Electron Framework failed to load due to code signing Team ID mismatch. Disabled code signing (`identity: null`) for unsigned builds so the main binary and framework signatures are consistent.
- **DictatePage crash** — `Cannot access 'editor' before initialization` error caused by `handleReadBack` callback referencing the TipTap editor before its `useEditor` declaration. Moved callback below the hook.

### Changed
- Added macOS unsigned-app install instructions to README (xattr quarantine removal + right-click Open)
- Removed hardened runtime entitlements from electron-builder config (not applicable without a signing certificate)

---

## [1.0.8] - 2026-04-06

### Added
- **Dictate page read-back** — new "Read Back" button reads editor content aloud via TTS, with pause/resume/stop controls
- **Dictate page persistence** — editor content survives navigation; drafts saved to localStorage automatically and restored on return
- **AI Assist settings tab** — new dedicated settings section for AI assistant configuration
- **AI model selection** — choose your model per provider (GPT-4.1 Mini default/free, GPT-4o, o3-mini, Claude Sonnet 4, Claude Opus 4, Claude Haiku 3.5, and more)
- **AI provider picker** — visual cards for GitHub Copilot and Claude Code CLI with live auth status and refresh
- **AI model passthrough** — selected model sent as `--model` flag to CLI adapters

### Changed
- AI enable toggle moved from General settings to dedicated AI Assist tab
- AI chat uses saved provider/model preferences instead of always auto-picking

---

## [1.0.6] - 2026-04-06

### Fixed
- Fix `cargo clippy --no-default-features -- -D warnings` (9 warnings)
  - Gate TTS-only code behind `#[cfg(feature = "tts")]`
  - Add `Default` impls for AudioRingBuffer, CaptureEngine, PlaybackEngine
  - Remove unused imports across lib.rs, kokoro.rs, playback.rs
- Fix `cargo test --no-default-features` (gate vocab test behind tts feature)
- Fix electron-builder packaging: 1024x1024 icon (was 256, below 512 minimum)
- Fix CI/release: run full `npm run build` (main + preload + renderer), not just vite
- Fix electron-builder auto-publish demanding GH_TOKEN (`--publish never`)
- Fix Linux .deb build: add author email for maintainer field
- Add macOS entitlements.mac.plist for hardened runtime (mic access, JIT)

### Added
- GitHub Releases workflow via `softprops/action-gh-release`
- Download section in README with link to Releases page
- `scripts/release.sh` — automated release script with version bumps, security scan, build verification, and git tag/push

---

## [1.0.0] - 2026-04-06

### Core Features
- **Voice-to-text transcription** via Whisper large-v3-turbo running locally through whisper.cpp
- **Text cleanup** via local Mistral 7B LLM — removes filler words, fixes grammar, polishes raw transcriptions
- **Text-to-speech** via Kokoro 82M ONNX — 15 English voices (American + British), word-level highlighting
- **Global hotkey** (Cmd+Shift+V / Ctrl+Shift+V) — record from anywhere, text copied to clipboard automatically
- **100% local processing** — no network calls, no cloud, no telemetry, no accounts

### Application
- **Dictate page** — TipTap rich text editor with voice input, full formatting toolbar, auto-save
- **Timeline** — scrollable card feed of all dictations with raw/polished toggle, pin, archive, delete
- **AI Assistant** — chat interface with session persistence, conversational voice mode, note attachment
- **Listen page** — text-to-speech with karaoke-style word highlighting, speed control, multiple voices
- **Notes** — notebook organization with tags, rich text editing, search
- **Search** — universal full-text search across dictations, AI sessions, and notes
- **Settings** — tabbed panel (General, Speech, Models, Data, Security) with model downloads and configuration

### Privacy & Security
- All audio processed in-memory only — never written to disk, buffers zeroed on drop
- Electron sandbox enabled with contextIsolation and nodeIntegration disabled
- SHA-256 checksum verification for all model downloads with domain-restricted HTTPS
- IPC input validation on all high-risk channels (buffer size limits, setting allowlists, prompt caps)
- Scoped environment variables for AI CLI child processes — no credential leakage
- XSS prevention — rehype-raw removed from AI markdown rendering
- Console log redaction — user content never logged in production
- Session timeout with configurable idle detection
- Clipboard auto-clear option
- Clear-on-exit option for sensitive data

### UI/UX
- Dark, light, and system theme support via CSS variable system
- Animated mic shield with state-based visuals (idle/recording/processing/success)
- Expandable sidebar navigation with grouped sections
- Toast notification system for cross-page feedback
- Welcome page with guided first-time setup and inline search
- Recording error recovery with auto-retry and force-reset

### Architecture
- Rust native addon via napi-rs (N-API) with feature-gated compilation
- cpal for cross-platform audio capture and output
- SQLite via rusqlite with FTS5 full-text search
- React 18 + Vite + Tailwind CSS frontend
- Zustand state management (7 stores)
- Electron 33 with IPC bridge via contextBridge

### Documentation
- SECURITY.md — comprehensive security policy and threat model
- AUDIT.md — code-referenced self-audit with 18 verified sections
- CLAUDE.md — full architecture reference and development guide
- README.md — user-facing documentation with quick start guide
