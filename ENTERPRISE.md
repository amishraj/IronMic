# IronMic Enterprise Evaluation Guide

> **Version:** 1.6.0 | **License:** MIT | **Last Updated:** April 2026

---

## Executive Summary

IronMic is a fully-local, open-source voice-to-text platform designed for enterprise environments where data privacy is non-negotiable. All speech recognition, text processing, and storage happens entirely on the user's device. No audio, text, or metadata ever leaves the machine. No cloud services. No telemetry. No network dependency.

IronMic is built for organizations in **regulated industries** (legal, healthcare, finance, government) and **security-conscious enterprises** that cannot use cloud-based dictation services due to compliance requirements, data residency laws, or intellectual property concerns.

### Why IronMic for Enterprise

| Concern | IronMic's Answer |
|---------|-----------------|
| Data residency | All data stays on the local machine. Period. |
| Network exposure | Zero outbound network requests during operation. |
| Compliance (HIPAA, SOC 2, GDPR) | No data leaves the device — nothing to audit externally. |
| Vendor lock-in | Open source (MIT). Full source code available for review. |
| Air-gapped environments | Fully functional with no internet. Models bundled or imported offline. |
| Cost | No per-seat SaaS fees. No API usage charges. One-time deployment. |
| Customization | Open architecture. Extend, modify, or integrate as needed. |

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Security Model](#security-model)
3. [Privacy Guarantees](#privacy-guarantees)
4. [Deployment & Installation](#deployment--installation)
5. [System Requirements](#system-requirements)
6. [Model Management](#model-management)
7. [Feature Set](#feature-set)
8. [On-Device Machine Learning](#on-device-machine-learning)
9. [Data Management](#data-management)
10. [Compliance & Regulatory](#compliance--regulatory)
11. [Integration Capabilities](#integration-capabilities)
12. [Performance Benchmarks](#performance-benchmarks)
13. [Support & Maintenance](#support--maintenance)
14. [Licensing](#licensing)
15. [Roadmap](#roadmap)
16. [FAQ](#faq)
17. [Contact & Resources](#contact--resources)

---

## Architecture Overview

IronMic is a desktop application built on two layers: a **Rust native core** for all heavy computation and a **React/Electron UI** for the user interface. These layers communicate through a typed IPC bridge (napi-rs).

```
┌─────────────────────────────────────────────────────┐
│                  Electron.js UI                      │
│                                                      │
│  React 18 + Zustand + Tailwind CSS + TipTap Editor  │
│  TensorFlow.js ML (Web Worker)                       │
│                                                      │
│            contextBridge (typed IPC)                  │
└──────────────────────┬──────────────────────────────┘
                       │ napi-rs (N-API)
┌──────────────────────▼──────────────────────────────┐
│                Rust Native Core                      │
│                                                      │
│  Audio Capture (cpal)        Whisper.cpp (STT)       │
│  llama.cpp (LLM)             Kokoro ONNX (TTS)      │
│  SQLite (rusqlite)           Clipboard (arboard)     │
│  Audio Playback (cpal)       Hotkey Management       │
└──────────────────────────────────────────────────────┘
```

### Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **UI** | Electron 30+ / React 18 / Zustand / Tailwind CSS | Desktop shell, component UI, state management |
| **Editor** | TipTap (ProseMirror) | Rich text note editing |
| **Bridge** | napi-rs (N-API) | Type-safe Rust-to-Node.js communication |
| **Audio** | cpal + Web Audio API | Cross-platform microphone capture and playback |
| **Speech-to-Text** | whisper-rs (whisper.cpp) | Local Whisper inference with GPU acceleration |
| **Text Processing** | llama-cpp-rs (llama.cpp) | Local LLM for text cleanup, summarization, chat |
| **Text-to-Speech** | ort (ONNX Runtime) + Kokoro 82M | Local neural text-to-speech with 15 voices |
| **On-Device ML** | TensorFlow.js (Web Worker) | VAD, intent classification, semantic search |
| **Storage** | rusqlite (SQLite + FTS5) | All structured data, full-text search |
| **Clipboard** | arboard | Cross-platform clipboard management |

### Codebase Metrics

| Metric | Value |
|--------|-------|
| Rust source files | 40 |
| Rust lines of code | ~9,600 |
| TypeScript/React source files | ~100 |
| TypeScript lines of code | ~20,500 |
| N-API exported functions | ~100 |
| SQLite tables | 20 |
| Rust test count | 225 |
| Total commits | 41+ |
| Current version | 1.5.6 |

---

## Security Model

IronMic's security architecture is built on **hard constraints, not policies**. The guarantees below are enforced by code, not by configuration.

### Network Isolation

IronMic makes **zero outbound network requests** during normal operation. This is enforced at multiple levels:

1. **Electron request interceptor:** All outbound requests are blocked at the Electron session level via `session.defaultSession.webRequest.onBeforeRequest`. Only `file://`, `devtools://`, and `data:` protocols are permitted.

2. **Content Security Policy:** Strict CSP applied to the renderer:
   ```
   default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'
   ```

3. **Rust dependency tree:** The Rust core has no networking crates (`reqwest`, `hyper`, `tokio-net`, etc.) in its dependency tree. There is no code path that could make a network request from the native layer.

4. **Single exception — Model downloads:** Model files are downloaded from HuggingFace over HTTPS, only when explicitly triggered by the user in Settings. This is the only network operation in the entire application. Downloads are:
   - HTTPS-only (HTTP rejected)
   - Domain-validated (`*.huggingface.co` only)
   - SHA-256 integrity verified
   - Timeout-protected (10 min total, 60s stall detection)

**For air-gapped deployments:** Models can be downloaded on a separate machine and imported into IronMic via a file picker. No network access is required.

### Electron Sandbox Configuration

| Setting | Value | Purpose |
|---------|-------|---------|
| `contextIsolation` | `true` | Renderer cannot access preload globals directly |
| `nodeIntegration` | `false` | No `require()` or `process` in renderer |
| `sandbox` | `true` | Chromium OS-level process sandbox |
| `webSecurity` | `true` | Standard web security enforced |

The renderer process is fully sandboxed. All communication with the Rust core passes through ~65 explicitly defined IPC channels via `contextBridge`.

### IPC Input Validation

All IPC calls from the renderer to the main process are validated:

| Channel | Validation |
|---------|-----------|
| Model downloads | Model name checked against known allowlist |
| Settings | Key allowlisted, value length capped |
| AI messages | Prompt length capped at 100,000 characters |
| Audio buffers | Size capped at 100 MB |
| Database queries | Parameterized via rusqlite (no SQL injection) |

### Unsafe Rust Code

The Rust core contains **5 total `unsafe` blocks**, all justified Send trait implementations for thread-safe native handle wrappers. No raw pointer arithmetic, no manual memory management, no FFI without safe wrappers. Full details with code references in [AUDIT.md](AUDIT.md).

### XSS Prevention

All user-generated content is rendered through React's default escaping. Markdown is rendered via `ReactMarkdown` without `rehype-raw`, preventing HTML injection. No `dangerouslySetInnerHTML` usage.

### SQL Injection Protection

All database queries use parameterized statements via rusqlite. No string concatenation in SQL. FTS5 search queries are parameterized through the `MATCH` operator.

### What We Don't Protect Against

Transparency about limitations:

- **Physical access to an unlocked machine** — IronMic relies on the OS session lock. Session timeout is configurable (5m, 15m, 30m, 1h).
- **Root/admin-level malware** — No userspace application can defend against a compromised OS.
- **Supply chain attacks on dependencies** — Mitigated by minimal dependency tree, `cargo audit` / `npm audit` planned for CI.
- **AI CLI binary verification** — The AI assistant wraps locally-installed CLI tools. Binary signature verification is on the roadmap.

For the complete security analysis with code references, see **[SECURITY.md](SECURITY.md)** and **[AUDIT.md](AUDIT.md)**.

---

## Privacy Guarantees

These are architectural constraints — they cannot be bypassed by configuration, misconfiguration, or user error.

### 1. Audio Never Hits Disk

Microphone input is captured into an in-memory ring buffer. After Whisper processes the audio, the buffer is **explicitly zeroed** (`buffer.fill(0.0)`) and dropped. No temporary audio files. No WAV files. No audio cache. The audio exists only in RAM for the duration of processing.

This is verified in the security audit with references to 4 separate `Drop` implementations in the Rust core that enforce zero-on-drop semantics.

### 2. No Telemetry

Zero analytics, crash reporting, usage tracking, or phone-home behavior. The application does not collect, transmit, or store any usage metrics. There is no analytics SDK, no crash reporter, and no feature flag service in the dependency tree.

### 3. Local-Only Storage

All data lives in a single SQLite file in the user's OS application data directory:

| Platform | Location |
|----------|----------|
| macOS | `~/Library/Application Support/ironmic/ironmic.db` |
| Windows | `%APPDATA%\ironmic\ironmic.db` |
| Linux | `~/.local/share/ironmic/ironmic.db` |

The user owns this file completely. It can be backed up, moved, or deleted at any time.

### 4. No Background Listening

Recording only begins when the user explicitly presses the hotkey or clicks the record button. There is no ambient listening, no wake word detection (unless explicitly enabled in the planned accessibility feature), and no always-on microphone access.

### 5. Model Processing Is Local

All ML inference — Whisper (speech-to-text), Mistral (text cleanup), Kokoro (text-to-speech), and TensorFlow.js models (VAD, intent classification, semantic search) — runs entirely on the user's CPU/GPU. No audio or text is sent to any external API for processing.

---

## Deployment & Installation

### Distribution Formats

| Platform | Format | Size (with models) |
|----------|--------|-------------------|
| macOS (Apple Silicon) | `.dmg` | ~200 MB (app) + models separately |
| macOS (Intel) | `.dmg` | ~200 MB (app) + models separately |
| Windows | `.exe` installer | ~200 MB (app) + models separately |
| Linux | `.AppImage` / `.deb` | ~200 MB (app) + models separately |

Models are downloaded separately after installation (~6 GB total for all three models), or imported offline from files.

### Enterprise Deployment Options

#### Option 1: Standard Installation
1. Deploy the installer via MDM (JAMF, Intune, SCCM) or shared network drive.
2. Users download models on first launch via Settings > Models.

#### Option 2: Air-Gapped / Offline Installation
1. Deploy the installer via removable media or internal file share.
2. Pre-download model files on an internet-connected machine.
3. Users import models via Settings > Models > Import from File.
4. No internet access required at any point on the target machine.

#### Option 3: Build from Source
1. Clone the repository: `git clone https://github.com/greenpioneersolutions/IronMic.git`
2. Build the Rust core: `cd rust-core && cargo build --release --features metal,tts`
3. Build the Electron app: `cd electron-app && npm install && npm run build`
4. Package: `npx electron-builder`
5. Full reproducible builds. Verify every dependency yourself.

### Configuration for Enterprise

IronMic's settings are stored in the SQLite database (no external config files to manage). Key settings relevant to enterprise deployment:

| Setting | Default | Enterprise Recommendation |
|---------|---------|--------------------------|
| `clipboard_auto_clear` | Disabled | Enable (15s or 30s) for sensitive environments |
| `session_timeout` | Disabled | Enable (5m or 15m) for shared workstations |
| `clear_sessions_on_exit` | Off | Enable for AI chat data hygiene |
| `ai_data_confirmation` | Off | Enable to require user consent before AI processing |
| `privacy_mode` | Off | Enable to minimize stored metadata |

### HTTP Proxy Support

For corporate networks that require proxy access for model downloads:

- Configure via Settings > Security
- Supports HTTP, HTTPS, and SOCKS5 proxies
- Proxy is only used for model downloads — no other traffic is generated

---

## System Requirements

### Minimum Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| **OS** | macOS 12+, Windows 10+, Ubuntu 22.04+ | macOS 14+, Windows 11, Ubuntu 24.04+ |
| **CPU** | 4 cores, x86_64 or ARM64 | 8+ cores, Apple Silicon or recent Intel/AMD |
| **RAM** | 8 GB | 16 GB |
| **Storage** | 10 GB free | 20 GB free |
| **GPU** | Not required | Metal (macOS) or CUDA (NVIDIA) for faster inference |

### Performance by Hardware

| Hardware | Whisper (30s audio) | LLM Cleanup (200 words) | TTS (100 words) |
|----------|-------------------|------------------------|-----------------|
| MacBook Pro M3 (Metal) | ~1.5s | ~2.5s | ~1.5s |
| MacBook Pro M1 (Metal) | ~2.0s | ~3.5s | ~2.0s |
| Intel i7-13700 (CPU only) | ~3.5s | ~5.0s | ~3.0s |
| Intel i5-1240P (CPU only) | ~5.0s | ~7.0s | ~4.0s |

### Model Storage

| Model | Size | Purpose | Required? |
|-------|------|---------|-----------|
| Whisper large-v3-turbo | ~1.5 GB | Speech recognition | Yes (for core function) |
| Mistral 7B Instruct Q4 | ~4.4 GB | Text cleanup and AI chat | Optional |
| Kokoro 82M | ~163 MB + ~7.5 MB voices | Text-to-speech | Optional |
| TF.js ML models | ~41 MB total | VAD, intent, search, etc. | Bundled (no download) |

**Total storage for all models:** ~6.1 GB

---

## Model Management

### Model Sources and Integrity

All models are sourced from HuggingFace and verified before use:

| Model | Source | Integrity Check |
|-------|--------|----------------|
| Whisper large-v3-turbo | ggerganov/whisper.cpp (HuggingFace) | SHA-256 hash verified |
| Mistral 7B Instruct Q4 | TheBloke/Mistral-7B-Instruct (HuggingFace) | SHA-256 hash verified |
| Kokoro 82M | onnx-community/Kokoro-82M (HuggingFace) | SHA-256 hash verified |

### Model Download Security

1. **HTTPS enforced** — HTTP downloads are rejected at the code level.
2. **Domain validation** — Only `*.huggingface.co` is permitted.
3. **SHA-256 verification** — Every downloaded file is hashed and compared against a known checksum before being accepted.
4. **Atomic writes** — Partial downloads are discarded; only fully verified files are moved to the model directory.
5. **Timeout protection** — 10-minute total timeout, 60-second stall detection.

### Offline Model Import

For environments where internet access is restricted:

1. Download model files on an approved machine.
2. Verify checksums manually (SHA-256 hashes are documented).
3. Transfer to the target machine via approved media.
4. In IronMic: Settings > Models > Import from File.
5. IronMic validates and copies the file to the correct location.

### Multiple Whisper Model Sizes

IronMic supports multiple Whisper model sizes, allowing organizations to balance accuracy vs resource usage:

| Model | Size | Speed | Accuracy |
|-------|------|-------|----------|
| Tiny | ~75 MB | Fastest | Lower |
| Base | ~142 MB | Fast | Moderate |
| Small | ~466 MB | Moderate | Good |
| Medium | ~1.5 GB | Slower | Very Good |
| Large-v3-turbo | ~1.5 GB | Moderate | Best |

---

## Feature Set

### Core Capabilities

| Feature | Description |
|---------|-------------|
| **Voice-to-Clipboard** | Press hotkey, speak, press again. Text appears in clipboard. |
| **Page-Aware Routing** | Voice input routes to active page: dictate, search, listen, notes, timeline. |
| **Whisper STT** | State-of-the-art local speech recognition with GPU acceleration (Metal). |
| **On-Demand LLM Cleanup** | Click to polish any transcript. Removes filler words, fixes grammar. |
| **Custom Dictionary** | Add domain terms, names, and jargon for better transcription. |
| **Rich Text Notes** | TipTap editor with formatting: bold, italic, headings, lists, code. |
| **Timeline View** | Scrollable history of all dictations with search and filtering. |
| **Full-Text Search** | Instant search across all content (SQLite FTS5). |
| **Tags & Organization** | Categorize entries. Pin important items. Archive old ones. |

### Text-to-Speech

| Feature | Description |
|---------|-------------|
| **Kokoro 82M TTS** | Local neural voice engine. No cloud API. |
| **15 English Voices** | American and British accents, male and female. |
| **Speed Control** | 0.5x to 2.0x playback speed. |
| **Word Highlighting** | Words highlight in sync with speech (karaoke-style). |
| **Auto Read-Back** | Optionally read text aloud after dictation completes. |

### AI Assistant

| Feature | Description |
|---------|-------------|
| **Built-In Chat** | Wrapper around GitHub Copilot CLI and Claude Code CLI. |
| **Context-Aware** | Ask questions, refine text, brainstorm with AI. |
| **Privacy-First** | Off by default. Uses your own CLI tools and credentials when enabled. |

### Analytics

| Feature | Description |
|---------|-------------|
| **Dashboard** | Daily word counts, recording time, words per minute, streaks. |
| **Topic Classification** | LLM-powered topic tagging with trend charts. |
| **Vocabulary Richness** | Type-Token Ratio and unique word tracking. |
| **Productivity Comparison** | Period-over-period metrics. |

### Design & Customization

| Feature | Description |
|---------|-------------|
| **Themes** | Dark, Light, and System (auto) theme modes. |
| **Configurable Hotkey** | Visual key recorder with conflict detection. |
| **Enterprise Design** | Clean, professional UI. Inter font. IronMic blue accent. |

---

## On-Device Machine Learning

IronMic v1.1.0 includes 8 TensorFlow.js-powered ML features that run entirely in the renderer process (WebGL GPU or CPU Web Worker). All training data stays in local SQLite.

| Feature | Model Size | Ships with App | Purpose |
|---------|-----------|---------------|---------|
| Voice Activity Detection (VAD) | ~900 KB | Yes | Filter silence/noise before Whisper |
| Turn Detection | ~2 MB | No (trained on-device) | Detect end of speech for hands-free operation |
| Intent Classification | ~5 MB | Yes | Classify voice commands vs dictation |
| Context-Aware Routing | ~3 MB | No (trained on-device) | Route voice input based on active screen |
| Ambient Meeting Mode | ~5 MB | Yes | Detect and transcribe meetings |
| Semantic Search | ~30 MB | Yes | Meaning-based search (USE embeddings) |
| Smart Notifications | ~2 KB | No (trained on-device) | Rank notification importance |
| Workflow Discovery | ~15 KB | No (trained on-device) | Detect repeating action patterns |

**Total bundled model size:** ~41 MB

All ML features are independently toggleable in Settings > Voice AI. Each can be enabled or disabled without affecting the others.

### ML Privacy Guarantees

- All inference runs in the renderer's Web Worker — no network calls.
- VAD training stores audio features (MFCC), never raw audio.
- The action log records action types only, never user content.
- All learned data is stored in local SQLite, deletable per-feature.
- The network blocking function is not modified — no new network access paths.

---

## Data Management

### Storage Architecture

All data is stored in a single SQLite database file with 20 tables:

| Data Category | Tables | Content |
|--------------|--------|---------|
| Core | `entries`, `entries_fts` | Dictation transcripts, full-text index |
| Settings | `settings`, `dictionary` | Key-value config, custom words |
| Analytics | `analytics_snapshots`, `analytics_topics` | Productivity metrics |
| ML: VAD | `vad_training_samples` | Audio features for model tuning |
| ML: Intent | `intent_training_samples`, `voice_routing_log` | Classification data |
| ML: Meetings | `meeting_sessions` | Session metadata, transcripts, summaries |
| ML: Notifications | `notifications`, `notification_interactions` | Alert CRUD, engagement tracking |
| ML: Workflows | `action_log`, `workflows` | Action patterns |
| ML: Search | `embeddings` | 512-dim Float32 vectors |
| ML: Models | `ml_model_weights`, `tfjs_model_metadata` | Serialized model state |

### Data Retention

- **Auto-cleanup:** Configurable automatic deletion of entries older than N days.
- **Manual deletion:** Individual entries, meetings, and ML data can be deleted at any time.
- **Per-feature deletion:** Each ML feature's data can be wiped independently.
- **Full data wipe:** "Delete all data" option clears everything.
- **Database location:** User-accessible in the OS application data directory.

### Data Portability

- **SQLite format:** Standard, widely-supported database format. Readable by any SQLite tool.
- **No proprietary encoding:** All text stored as UTF-8. All timestamps as ISO 8601.
- **Backup:** Copy the SQLite file. That's the entire application state.
- **Migration:** Move the database file between machines to transfer all data.

### Data at Rest Encryption

**Current state:** The SQLite database is not encrypted by IronMic. Data at rest protection relies on OS-level full-disk encryption:

| Platform | Recommendation |
|----------|---------------|
| macOS | Enable FileVault |
| Windows | Enable BitLocker |
| Linux | Enable LUKS |

**Roadmap:** Application-level encryption via SQLCipher is planned, which would encrypt the database file independently of OS-level encryption.

---

## Compliance & Regulatory

### How IronMic Supports Compliance

| Regulation | Relevant Requirement | IronMic's Approach |
|-----------|---------------------|-------------------|
| **HIPAA** | PHI must not be transmitted to unauthorized parties | No data transmission. All processing local. |
| **HIPAA** | Access controls for PHI | Session timeout, clipboard auto-clear. Voice auth planned. |
| **GDPR** | Data minimization | Audio is never stored. Only transcripts persisted. |
| **GDPR** | Right to erasure | Full data deletion available at any time. |
| **GDPR** | Data portability | Standard SQLite format. Exportable. |
| **GDPR** | No automated profiling without consent | All ML features are opt-in, off by default. |
| **SOC 2** | Encryption in transit | No data in transit (no network). |
| **SOC 2** | Encryption at rest | OS-level FDE recommended. SQLCipher planned. |
| **SOC 2** | Access logging | Session logs, audit trail for review sessions (planned). |
| **CCPA** | Consumer data rights | User owns all data. Full delete available. |
| **FERPA** | Student record protection | No data leaves the device. |
| **ITAR** | Export-controlled data handling | Air-gapped operation. No cloud dependency. |
| **FedRAMP** | Federal cloud security | Not applicable — IronMic is not a cloud service. |

### What IronMic Is Not

- **Not a cloud service** — There is no SaaS component, no backend, no API. There is nothing to audit in a cloud environment because there is no cloud environment.
- **Not a SaaS product** — No subscription, no per-seat pricing, no vendor-managed infrastructure.
- **Not a data processor** — IronMic does not process data on behalf of the organization. The organization's data never leaves the organization's hardware.

### Audit Support

IronMic publishes a comprehensive, code-referenced self-audit: **[AUDIT.md](AUDIT.md)**

The audit covers:
- Network isolation verification (with code references)
- Audio zero-on-drop verification (4 Drop implementations)
- Model download integrity (SHA-256 + HTTPS + domain validation)
- Electron sandbox configuration
- IPC input validation
- SQL injection protection
- XSS prevention
- Unsafe Rust code analysis (5 blocks, all justified)
- No-telemetry verification

**We encourage independent security review.** The entire codebase is open source and available for third-party audit.

---

## Integration Capabilities

### Current Integrations

| Integration | Method | Notes |
|------------|--------|-------|
| **System Clipboard** | Native (arboard) | Dictation output copies to clipboard for pasting into any app |
| **Global Hotkey** | Platform-native | Works system-wide, in any application |
| **AI CLI Tools** | Child process wrapper | Wraps Claude Code CLI or GitHub Copilot CLI |
| **File System** | Standard I/O | Export notes, import models, database backup |

### Planned Integrations (Roadmap)

| Integration | Method | Status |
|------------|--------|--------|
| **LAN Transcript Review** | Local HTTP server + WebSocket | Proposed |
| **Voice-to-External Actions** | YAML plugin definitions + webhooks | Proposed |
| **Multi-Device Sync** | Peer-to-peer over LAN (mDNS + TLS) | Proposed |
| **Structured Data Output** | JSON/CSV export via voice | Proposed |

### What IronMic Will Never Integrate With

Consistent with the zero-network architecture:

- No cloud STT services (Google, AWS, Azure)
- No cloud translation APIs
- No telemetry or analytics platforms
- No SSO/OAuth providers (authentication is local)
- No cloud storage (iCloud, OneDrive, Dropbox)

---

## Performance Benchmarks

### Speech-to-Text Latency

Target: < 2 seconds from stop-recording to text-in-clipboard for 30-second dictation.

| Audio Duration | Whisper (Metal GPU) | Whisper (CPU) |
|---------------|--------------------|----|
| 10 seconds | ~0.8s | ~1.5s |
| 30 seconds | ~1.5s | ~3.5s |
| 60 seconds | ~2.5s | ~6.0s |
| 5 minutes | ~8s | ~25s |

### LLM Text Cleanup

| Input Length | Time (Apple Silicon) | Time (Intel CPU) |
|-------------|---------------------|-----------------|
| 50 words | ~1.5s | ~3s |
| 200 words | ~3s | ~5s |
| 500 words | ~5s | ~10s |

### Resource Usage

| State | RAM Usage | CPU Usage |
|-------|----------|-----------|
| Idle | ~200 MB | <1% |
| Recording | ~250 MB | ~5% |
| Transcribing (Whisper) | ~2.5 GB | ~100% (burst) |
| LLM Cleanup | ~4 GB | ~100% (burst) |
| TTS Playback | ~500 MB | ~10% |
| ML Features Active | +50 MB | +2% |

### Application Startup

Target: < 3 seconds to app-ready.

| Component | Load Time |
|-----------|----------|
| Electron shell | ~1s |
| React UI render | ~0.5s |
| SQLite connection | ~50ms |
| TF.js model init | ~1s |
| Whisper model (lazy) | On first use (~2s) |
| LLM model (lazy) | On first use (~3s) |

---

## Support & Maintenance

### Open Source Model

IronMic is open source under the MIT license. Support operates through:

| Channel | URL |
|---------|-----|
| Source Code | [github.com/greenpioneersolutions/IronMic](https://github.com/greenpioneersolutions/IronMic) |
| Issue Tracker | [github.com/greenpioneersolutions/IronMic/issues](https://github.com/greenpioneersolutions/IronMic/issues) |
| Security Reports | security@ironmic.dev |
| Releases | [github.com/greenpioneersolutions/IronMic/releases](https://github.com/greenpioneersolutions/IronMic/releases) |

### Update Process

- Updates are distributed as new release builds on GitHub.
- No auto-update mechanism — updates are manual (intentional for enterprise control).
- Each release includes a changelog and SHA-256 checksums for all artifacts.
- Organizations can pin versions and update on their own schedule.

### Build Reproducibility

IronMic supports deterministic builds:

1. Clone the repository at any tagged release.
2. Build with documented toolchain versions (Rust stable, Node.js 20+).
3. Compare output against published release artifacts.
4. CI/CD pipeline planned for GitHub Actions with automated builds across all platforms.

---

## Licensing

### MIT License

IronMic is released under the **MIT License** — one of the most permissive open-source licenses available.

**You may:**
- Use IronMic commercially without restriction
- Modify the source code for internal use
- Distribute modified versions
- Use in proprietary products
- Sublicense

**You must:**
- Include the original license and copyright notice in copies

**You may not:**
- Hold the authors liable for any damages

### Third-Party Dependencies

| Category | Notable Dependencies | License |
|----------|---------------------|---------|
| **Rust** | whisper-rs, llama-cpp-rs, rusqlite, cpal, arboard, serde | MIT / Apache-2.0 |
| **Node.js** | Electron, React, Zustand, TipTap, Vite, Tailwind CSS | MIT |
| **Models** | Whisper (MIT), Mistral (Apache-2.0), Kokoro (Apache-2.0) | MIT / Apache-2.0 |

All dependencies use permissive licenses (MIT or Apache-2.0). No GPL, AGPL, or copyleft dependencies.

---

## Roadmap

### Planned Security Enhancements

| Feature | Priority | Description |
|---------|----------|-------------|
| SQLCipher encryption | High | Encrypt SQLite database at the application level |
| localStorage encryption | High | Encrypt AI chat session data |
| `cargo audit` in CI | High | Automated dependency vulnerability scanning |
| `npm audit` in CI | High | Node.js dependency vulnerability scanning |
| AI CLI binary verification | Medium | Signature verification for AI CLI tools |
| Full-disk encryption detection | Medium | Warn if OS FDE is not enabled |

### Planned Features (Proposed)

See [ideas/README.md](ideas/README.md) for the complete feature roadmap with 15 proposals. Highlights relevant to enterprise:

| Feature | Enterprise Value |
|---------|-----------------|
| **Speaker Separation** | Label "who said what" in meeting transcripts |
| **Voice Fingerprint Security** | Biometric authentication for shared workstations |
| **Multi-Language Translation** | On-device translation for global teams |
| **Collaborative Transcript Review** | LAN-based transcript review (legal, medical) |
| **Organizational Voice Intelligence** | Knowledge graph for decision tracking |
| **Digest Generation** | Automatic daily briefings and action item tracking |
| **Voice-to-Structured Data** | Voice-driven CRM/expense/inventory data entry |

---

## FAQ

### General

**Q: Does IronMic require an internet connection?**
A: No. IronMic is fully functional without any internet access. The only exception is the initial model download, which can be bypassed by importing model files from a USB drive or network share.

**Q: Does IronMic send any data externally?**
A: No. Zero outbound network requests during operation. This is enforced at the code level, not by configuration. The AUDIT.md provides verification commands you can run yourself.

**Q: Can IronMic be used in air-gapped environments?**
A: Yes. Install via removable media. Import models via file picker. No internet required at any point.

**Q: What happens if the application crashes?**
A: No audio data is lost because audio is never stored to disk — it exists only in memory during processing. SQLite's WAL mode protects against database corruption. Crash recovery resumes from the last clean database state.

### Security

**Q: Is the database encrypted?**
A: Not currently at the application level. We recommend OS-level full-disk encryption (FileVault, BitLocker, LUKS). Application-level encryption via SQLCipher is on the roadmap.

**Q: How are model downloads secured?**
A: HTTPS-only, domain-restricted to `*.huggingface.co`, SHA-256 integrity verified, with timeout protection. For maximum security, download models on an approved machine and import offline.

**Q: Has IronMic been independently audited?**
A: We publish a comprehensive self-audit with code references in [AUDIT.md](AUDIT.md). We welcome and encourage independent third-party security audits.

**Q: What about the AI assistant — does it send data to the cloud?**
A: The AI assistant wraps locally-installed CLI tools (Claude Code or GitHub Copilot). If enabled, those tools use their own authentication and API connections. IronMic itself does not make any API calls. The AI feature is disabled by default and entirely optional.

### Deployment

**Q: Can IronMic be deployed via MDM?**
A: Yes. The `.dmg` (macOS), `.exe` (Windows), and `.deb` (Linux) installers are compatible with standard MDM tools (JAMF, Intune, SCCM). No user interaction required beyond initial model setup.

**Q: Can settings be pre-configured for enterprise deployment?**
A: Settings are stored in the SQLite database. A pre-configured database file can be distributed alongside the installer. Enterprise configuration provisioning is on the roadmap.

**Q: What's the per-seat cost?**
A: Zero. IronMic is MIT-licensed open source. No subscription fees, no per-seat pricing, no usage charges. The only cost is the hardware to run it on and any internal IT effort for deployment and support.

### Compliance

**Q: Is IronMic HIPAA compliant?**
A: IronMic's architecture supports HIPAA compliance by ensuring PHI never leaves the device. However, HIPAA compliance is an organizational responsibility that includes policies, training, and physical security controls that are outside IronMic's scope. Consult your compliance officer.

**Q: Can we get a BAA (Business Associate Agreement)?**
A: A BAA is typically required when a vendor processes or stores PHI on behalf of a covered entity. Since IronMic is self-hosted software that processes data exclusively on your hardware, and the IronMic project never accesses, stores, or transmits your data, a traditional BAA does not apply.

---

## Contact & Resources

| Resource | Link |
|----------|------|
| **Source Code** | [github.com/greenpioneersolutions/IronMic](https://github.com/greenpioneersolutions/IronMic) |
| **Releases** | [github.com/greenpioneersolutions/IronMic/releases](https://github.com/greenpioneersolutions/IronMic/releases) |
| **Security Policy** | [SECURITY.md](SECURITY.md) |
| **Security Audit** | [AUDIT.md](AUDIT.md) |
| **Feature Roadmap** | [ideas/README.md](ideas/README.md) |
| **Architecture** | [CLAUDE.md](CLAUDE.md) |
| **Security Contact** | security@ironmic.dev |
| **License** | [LICENSE](LICENSE) (MIT) |
