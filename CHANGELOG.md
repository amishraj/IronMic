# Changelog

All notable changes to IronMic will be documented in this file.

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
