# CLAUDE.md — IronMic: Enterprise Local Voice AI

## Project Overview

IronMic is an open-source, fully-local enterprise voice-to-text AI tool. All processing — speech recognition, LLM text cleanup, and storage — happens entirely on-device. No audio or text ever leaves the machine. Zero network dependency. Zero telemetry.

The user speaks, IronMic transcribes via Whisper, optionally polishes via a local LLM, and either stores the result as a note or copies it to the clipboard for pasting into any application.

**Core Principles:**
- Everything local. No network calls. No cloud. No exceptions.
- Enterprise-grade privacy: audio processed in-memory only, never written to disk as audio files.
- Open source with clean, reviewable architecture.
- Cross-platform from day one: macOS, Windows, Linux.

---

## Architecture

### System Diagram

```
┌─────────────────────────────────────────────────────┐
│                  Electron.js UI                      │
│                                                      │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Note     │  │ Timeline /   │  │ Settings /    │  │
│  │ Editor   │  │ Card Feed    │  │ Preferences   │  │
│  │ (Sidebar)│  │              │  │               │  │
│  └────┬─────┘  └──────┬───────┘  └───────┬───────┘  │
│       │               │                  │           │
│       └───────────┬───┘──────────────────┘           │
│                   │                                  │
│            IPC Bridge (contextBridge)                 │
│                   │                                  │
└───────────────────┼──────────────────────────────────┘
                    │
     ┌──────────────┼──────────────┐
     │     Rust Core (Native Addon) │
     │                              │
     │  ┌────────────────────────┐  │
     │  │  Audio Capture Engine  │  │
     │  │  (cpal / platform API) │  │
     │  └──────────┬─────────────┘  │
     │             │                │
     │  ┌──────────▼─────────────┐  │
     │  │  Whisper.cpp (STT)     │  │
     │  │  via whisper-rs         │  │
     │  └──────────┬─────────────┘  │
     │             │                │
     │  ┌──────────▼─────────────┐  │
     │  │  LLM Cleanup (opt.)    │  │
     │  │  llama.cpp via         │  │
     │  │  llama-cpp-rs          │  │
     │  └──────────┬─────────────┘  │
     │             │                │
     │  ┌──────────▼─────────────┐  │
     │  │  Storage Engine        │  │
     │  │  (SQLite via rusqlite) │  │
     │  └──────────┬─────────────┘  │
     │             │                │
     │  ┌──────────▼─────────────┐  │
     │  │  Clipboard Manager     │  │
     │  │  (arboard crate)       │  │
     │  └────────────────────────┘  │
     │                              │
     │  ┌────────────────────────┐  │
     │  │  Global Hotkey Listener│  │
     │  │  (platform-native)     │  │
     │  └────────────────────────┘  │
     │                              │
     └──────────────────────────────┘
```

### Layer Breakdown

**Layer 1 — Electron.js UI (Renderer Process)**
- Note editor view (sidebar, always-accessible rich text editor for active dictation)
- Timeline / card feed view (scrollable history of all dictations)
- Toggle between editor and timeline views
- Settings panel (hotkey config, LLM toggle, model selection, dictionary management)
- Dictation status indicator (recording / processing / idle)
- Toggle for raw transcript vs. polished output per entry
- Search across all notes and transcription history

**Layer 2 — IPC Bridge**
- Electron contextBridge exposes a typed API from main process to renderer
- Main process spawns and manages the Rust native addon via N-API (napi-rs)
- All heavy computation happens in Rust; Electron never touches audio or models directly

**Layer 3 — Rust Core (Native N-API Addon)**
- Audio capture engine (cpal crate for cross-platform mic access)
- Whisper.cpp integration via whisper-rs for speech-to-text
- llama.cpp integration via llama-cpp-rs for text cleanup/polishing
- SQLite storage via rusqlite for notes, logs, and settings
- Clipboard management via arboard crate
- Global hotkey registration via platform-native APIs
- In-memory audio processing only — raw audio buffers are never persisted to disk

---

## Tech Stack

### Rust Core
| Concern | Crate / Tool | Purpose |
|---|---|---|
| Audio capture | `cpal` | Cross-platform microphone input |
| Speech-to-text | `whisper-rs` (bindings to whisper.cpp) | Local Whisper inference |
| Text cleanup LLM | `llama-cpp-rs` (bindings to llama.cpp) | Local LLM inference for polishing |
| Database | `rusqlite` | Embedded SQLite for all local storage |
| Clipboard | `arboard` | Cross-platform clipboard read/write |
| N-API bridge | `napi-rs` | Expose Rust functions to Node.js/Electron |
| Serialization | `serde` + `serde_json` | Data exchange between Rust and Electron |
| Error handling | `thiserror` + `anyhow` | Idiomatic Rust error management |
| Logging | `tracing` + `tracing-subscriber` | Structured logging for debugging |
| Audio processing | `hound` or `rubato` | WAV encoding / resampling if needed |

### Electron.js Frontend
| Concern | Library / Tool | Purpose |
|---|---|---|
| Framework | Electron 30+ | Cross-platform desktop shell |
| UI framework | React 18+ | Component-based UI |
| State management | Zustand | Lightweight, minimal boilerplate |
| Styling | Tailwind CSS | Utility-first, consistent design |
| Rich text editor | TipTap (ProseMirror-based) | Note editing with formatting |
| Build tool | Vite | Fast dev server and bundling |
| IPC types | Shared TypeScript interfaces | Type-safe Rust ↔ Electron communication |
| Icons | Lucide React | Clean, consistent iconography |
| Testing | Vitest + Playwright | Unit + E2E testing |

### Models (Bundled)
| Model | Size | Purpose |
|---|---|---|
| `whisper-large-v3-turbo` (GGML) | ~1.5 GB | Speech-to-text transcription |
| `Mistral-7B-Instruct` (Q4_K_M GGUF) | ~4.4 GB | Text cleanup and polishing |

Total bundled model size: ~6 GB. Distributed as part of the installer.

---

## Data Model (SQLite Schema)

```sql
-- All dictation entries
CREATE TABLE entries (
    id TEXT PRIMARY KEY,           -- UUID v4
    created_at TEXT NOT NULL,       -- ISO 8601 timestamp
    updated_at TEXT NOT NULL,       -- ISO 8601 timestamp
    raw_transcript TEXT NOT NULL,   -- Original Whisper output
    polished_text TEXT,             -- LLM-cleaned version (null if cleanup was off)
    display_mode TEXT NOT NULL DEFAULT 'polished', -- 'raw' | 'polished'
    duration_seconds REAL,          -- Length of audio that produced this entry
    source_app TEXT,                -- App that was focused when dictation started (optional metadata)
    is_pinned INTEGER DEFAULT 0,    -- Pin to top of timeline
    is_archived INTEGER DEFAULT 0,  -- Soft delete
    tags TEXT                       -- JSON array of user-assigned tags
);

-- Full-text search index
CREATE VIRTUAL TABLE entries_fts USING fts5(
    raw_transcript,
    polished_text,
    tags,
    content='entries',
    content_rowid='rowid'
);

-- User-defined custom dictionary words
CREATE TABLE dictionary (
    id TEXT PRIMARY KEY,
    word TEXT NOT NULL UNIQUE,
    added_at TEXT NOT NULL
);

-- Application settings
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Default settings inserted on first run
-- hotkey_record: 'CommandOrControl+Shift+V'
-- llm_cleanup_enabled: 'true'
-- default_view: 'timeline'
-- theme: 'system'
-- whisper_model: 'large-v3-turbo'
-- llm_model: 'mistral-7b-instruct-q4'
```

---

## Core User Flows

### Flow 1: Dictate → Clipboard (Paste Anywhere)
1. User presses global hotkey (`Cmd+Shift+V` / `Ctrl+Shift+V`)
2. Status indicator shows "Recording..." (Electron tray or in-app indicator)
3. Rust core captures audio via cpal into an in-memory ring buffer
4. User presses hotkey again to stop recording
5. Audio buffer is passed to Whisper.cpp → raw transcript produced
6. If LLM cleanup is ON: raw transcript → llama.cpp → polished text produced
7. Final text (polished or raw based on setting) is written to system clipboard via arboard
8. Entry is saved to SQLite (both raw and polished versions)
9. Audio buffer is zeroed and dropped from memory — never persisted
10. User pastes (Cmd+V / Ctrl+V) into any application

### Flow 2: Dictate → Note (In-App)
1. User opens IronMic, navigates to Note Editor view
2. User presses global hotkey or clicks in-app mic button
3. Same recording + transcription pipeline as Flow 1
4. Instead of clipboard, text is inserted directly into the TipTap editor
5. User can continue dictating (append) or edit manually
6. Entry is auto-saved to SQLite on every change

### Flow 3: Browse History (Timeline)
1. User toggles to Timeline view
2. All entries displayed as cards, newest first
3. Each card shows: timestamp, source app (if captured), polished text (or raw), duration
4. User can toggle raw/polished on any individual card
5. User can pin, archive, tag, or delete entries
6. Full-text search bar filters entries in real-time via FTS5

### Flow 4: Toggle Raw vs. Polished
1. On any entry (in timeline or editor), user clicks toggle
2. View switches between raw_transcript and polished_text
3. If entry has no polished_text (cleanup was off when recorded), user can trigger a one-time cleanup by clicking "Polish now" → sends raw_transcript to local LLM → saves result

---

## Rust Core API (N-API Surface)

These are the functions exposed from Rust to Electron via napi-rs:

```typescript
// --- Audio & Transcription ---
startRecording(): void
stopRecording(): Promise<TranscriptionResult>
// TranscriptionResult = { rawTranscript: string, polishedText: string | null, durationSeconds: number }

// --- On-Demand LLM ---
polishText(rawText: string): Promise<string>

// --- Entries CRUD ---
createEntry(entry: NewEntry): Promise<Entry>
getEntry(id: string): Promise<Entry | null>
updateEntry(id: string, updates: Partial<Entry>): Promise<Entry>
deleteEntry(id: string): Promise<void>
listEntries(opts: { limit: number, offset: number, search?: string, archived?: boolean }): Promise<Entry[]>
pinEntry(id: string, pinned: boolean): Promise<void>
archiveEntry(id: string, archived: boolean): Promise<void>

// --- Dictionary ---
addWord(word: string): Promise<void>
removeWord(word: string): Promise<void>
listDictionary(): Promise<string[]>

// --- Settings ---
getSetting(key: string): Promise<string | null>
setSetting(key: string, value: string): Promise<void>

// --- Hotkey ---
registerHotkey(accelerator: string): Promise<void>
onHotkeyPressed(callback: () => void): void

// --- Clipboard ---
copyToClipboard(text: string): Promise<void>

// --- System ---
getModelStatus(): Promise<{ whisper: ModelInfo, llm: ModelInfo }>
// ModelInfo = { loaded: boolean, name: string, sizeBytes: number }
```

---

## Project Structure

```
IronMic/
├── CLAUDE.md                     # This file
├── LICENSE                        # MIT or Apache-2.0
├── README.md                      # User-facing documentation
│
├── rust-core/                     # Rust native addon
│   ├── Cargo.toml
│   ├── build.rs                   # Build script for whisper.cpp / llama.cpp compilation
│   ├── src/
│   │   ├── lib.rs                 # napi-rs entry point, exports all N-API functions
│   │   ├── audio/
│   │   │   ├── mod.rs
│   │   │   ├── capture.rs         # Mic capture via cpal, ring buffer management
│   │   │   └── processor.rs       # Audio format conversion, resampling for Whisper
│   │   ├── transcription/
│   │   │   ├── mod.rs
│   │   │   ├── whisper.rs         # Whisper.cpp wrapper, model loading, inference
│   │   │   └── dictionary.rs      # Custom dictionary integration for improved accuracy
│   │   ├── llm/
│   │   │   ├── mod.rs
│   │   │   ├── cleanup.rs         # LLM text polishing pipeline
│   │   │   └── prompts.rs         # System prompts for cleanup behavior
│   │   ├── storage/
│   │   │   ├── mod.rs
│   │   │   ├── db.rs              # SQLite connection pool, migrations
│   │   │   ├── entries.rs         # Entry CRUD operations
│   │   │   ├── dictionary.rs      # Dictionary CRUD operations
│   │   │   └── settings.rs        # Settings key-value store
│   │   ├── clipboard/
│   │   │   ├── mod.rs
│   │   │   └── manager.rs         # Clipboard read/write via arboard
│   │   ├── hotkey/
│   │   │   ├── mod.rs
│   │   │   └── listener.rs        # Global hotkey registration + event emission
│   │   └── error.rs               # Unified error types
│   │
│   ├── models/                    # Bundled model weights (git-lfs or separate download)
│   │   ├── whisper-large-v3-turbo.bin
│   │   └── mistral-7b-instruct-q4_k_m.gguf
│   │
│   └── tests/
│       ├── audio_tests.rs
│       ├── transcription_tests.rs
│       ├── llm_tests.rs
│       └── storage_tests.rs
│
├── electron-app/                  # Electron + React frontend
│   ├── package.json
│   ├── electron-builder.config.js # Packaging config for Mac/Win/Linux
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   ├── tsconfig.json
│   │
│   ├── src/
│   │   ├── main/                  # Electron main process
│   │   │   ├── index.ts           # App entry, window creation, tray setup
│   │   │   ├── ipc-handlers.ts    # IPC handlers that bridge to Rust native addon
│   │   │   ├── native-bridge.ts   # Loads and wraps the napi-rs Rust addon
│   │   │   └── tray.ts            # System tray icon and menu
│   │   │
│   │   ├── preload/
│   │   │   └── index.ts           # contextBridge exposing typed API to renderer
│   │   │
│   │   ├── renderer/              # React app
│   │   │   ├── App.tsx            # Root component, view router
│   │   │   ├── main.tsx           # React entry point
│   │   │   ├── index.html
│   │   │   │
│   │   │   ├── components/
│   │   │   │   ├── Layout.tsx             # App shell: sidebar + main content area
│   │   │   │   ├── NoteEditor.tsx         # TipTap rich text editor for active note
│   │   │   │   ├── Timeline.tsx           # Card feed of all dictation entries
│   │   │   │   ├── EntryCard.tsx          # Single entry in timeline view
│   │   │   │   ├── RecordingIndicator.tsx # Visual mic status (idle/recording/processing)
│   │   │   │   ├── SearchBar.tsx          # Full-text search input
│   │   │   │   ├── ViewToggle.tsx         # Switch between editor and timeline
│   │   │   │   ├── RawPolishedToggle.tsx  # Per-entry raw vs polished switch
│   │   │   │   ├── DictionaryManager.tsx  # Add/remove custom words
│   │   │   │   ├── SettingsPanel.tsx      # App configuration UI
│   │   │   │   └── TagManager.tsx         # Tag entries for organization
│   │   │   │
│   │   │   ├── stores/
│   │   │   │   ├── useEntryStore.ts       # Zustand store for entries
│   │   │   │   ├── useRecordingStore.ts   # Zustand store for recording state
│   │   │   │   └── useSettingsStore.ts    # Zustand store for settings
│   │   │   │
│   │   │   ├── hooks/
│   │   │   │   ├── useRustBridge.ts       # Hook wrapping preload API calls
│   │   │   │   ├── useHotkey.ts           # Hook for hotkey status
│   │   │   │   └── useSearch.ts           # Debounced search hook
│   │   │   │
│   │   │   ├── types/
│   │   │   │   └── index.ts               # Shared TypeScript types (Entry, Settings, etc.)
│   │   │   │
│   │   │   └── styles/
│   │   │       └── globals.css            # Tailwind base + custom theme
│   │   │
│   │   └── shared/
│   │       └── constants.ts       # Shared constants (default hotkey, model names, etc.)
│   │
│   └── resources/                 # App icons, tray icons per platform
│       ├── icon.icns
│       ├── icon.ico
│       └── icon.png
│
├── scripts/
│   ├── download-models.sh         # Script to fetch models for development
│   ├── build-rust.sh              # Compile Rust addon for current platform
│   └── package.sh                 # Full build + package for distribution
│
└── .github/
    └── workflows/
        ├── ci.yml                 # Lint, test, build on all platforms
        └── release.yml            # Build and publish release artifacts
```

---

## LLM Cleanup Prompt

The local LLM uses this system prompt for the text polishing pass:

```
You are a text cleanup assistant. You receive raw speech-to-text transcriptions and produce clean, polished text.

Rules:
- Fix grammar, punctuation, and spelling errors
- Remove filler words (um, uh, like, you know, so, basically)
- Remove false starts and repeated phrases
- Preserve the speaker's original meaning, tone, and intent exactly
- Maintain the speaker's vocabulary level — do not make it sound more formal or less formal than intended
- Keep technical terms, proper nouns, and jargon exactly as spoken
- Format lists, paragraphs, and structure naturally based on content
- Do NOT add information that wasn't spoken
- Do NOT summarize or shorten — keep the full content
- Output ONLY the cleaned text, nothing else — no preamble, no explanation

Input transcript:
{raw_transcript}
```

---

## Global Hotkey Behavior

| State | Hotkey Press | Result |
|---|---|---|
| Idle | Press | Start recording. Status → "Recording" |
| Recording | Press | Stop recording. Begin transcription pipeline. Status → "Processing" |
| Processing | Press | Ignored (debounced) |

Default hotkey: `CommandOrControl+Shift+V`

After processing completes:
- Text is copied to clipboard automatically
- Entry is saved to SQLite
- Status returns to "Idle"
- A subtle notification or sound confirms completion

---

## Privacy & Security Guarantees

These are hard architectural constraints, not policies:

1. **No network calls.** The app makes zero HTTP/HTTPS/WebSocket requests. No DNS lookups. Electron's `session.defaultSession.webRequest` blocks all outbound requests as a safety net. The Rust core has no networking crates in its dependency tree.

2. **Audio never hits disk.** Mic input is captured into an in-memory ring buffer. After Whisper processes it, the buffer is explicitly zeroed (`buffer.fill(0)`) and dropped. No temp files.

3. **No telemetry.** No analytics, no crash reporting, no usage tracking. The app is fully air-gapped by design.

4. **Local-only storage.** All data lives in a single SQLite file in the user's app data directory. The user owns it completely.

5. **Auditable dependency tree.** Minimal crate dependencies, all reviewed. No proc-macros from unknown sources. `cargo audit` in CI.

6. **Reproducible builds.** CI builds are deterministic and verifiable. Users can build from source.

---

## Development Workflow

### Prerequisites
- Rust stable (latest) + cargo
- Node.js 20+ + npm
- CMake (for whisper.cpp / llama.cpp compilation)
- Platform-specific:
  - macOS: Xcode Command Line Tools
  - Windows: Visual Studio Build Tools (C++ workload)
  - Linux: `build-essential`, `libasound2-dev` (ALSA for cpal), `libsqlite3-dev`

### Dev Commands
```bash
# Clone and setup
git clone https://github.com/greenpioneersolutions/IronMic.git
cd IronMic

# Download models (dev convenience — in release they're bundled)
./scripts/download-models.sh

# Build Rust native addon
cd rust-core
cargo build --release
cd ..

# Install Electron app dependencies
cd electron-app
npm install

# Run in development (hot-reload for Electron, Rust addon pre-built)
npm run dev

# Run tests
cd ../rust-core && cargo test
cd ../electron-app && npm test

# Package for distribution
./scripts/package.sh
```

---

## Build Slicing Plan (Implementation Order)

### Slice 1 — Rust Core: Audio Capture
- Set up Cargo project with napi-rs scaffolding
- Implement mic capture via cpal (cross-platform)
- In-memory ring buffer with explicit zeroing on drop
- N-API exports: `startRecording()`, `stopRecording()` returning raw PCM buffer
- Unit tests for capture start/stop and buffer management
- **Deliverable:** Rust addon that can record audio from mic and return a buffer to Node.js

### Slice 2 — Rust Core: Whisper Transcription
- Integrate whisper-rs with bundled model
- Model loading on startup (async, report progress)
- Accept PCM buffer → return transcript string
- Custom dictionary word boosting
- N-API export: `transcribe(audioBuffer) → string`
- **Deliverable:** Speak into mic → get text back in Node.js

### Slice 3 — Rust Core: LLM Text Cleanup
- Integrate llama-cpp-rs with bundled Mistral model
- Implement cleanup prompt pipeline
- N-API export: `polishText(rawText) → string`
- Toggle support (can be skipped if user preference is off)
- **Deliverable:** Raw transcript in → polished text out, all local

### Slice 4 — Rust Core: Storage + Clipboard
- SQLite setup with rusqlite, schema migrations
- Full CRUD for entries, dictionary, settings
- Clipboard write via arboard
- FTS5 search index for entries
- N-API exports: all CRUD operations + `copyToClipboard()`
- **Deliverable:** Entries can be saved, queried, searched, and text copied to clipboard

### Slice 5 — Rust Core: Global Hotkey
- Platform-native global hotkey registration
- Event callback to Electron main process via napi-rs
- State machine: Idle → Recording → Processing → Idle
- **Deliverable:** Press hotkey anywhere on OS → triggers recording pipeline

### Slice 6 — Electron Shell + IPC Bridge
- Electron main process setup with Vite + React
- contextBridge preload script with full typed API
- Main process loads Rust addon and wires IPC handlers
- System tray with status icon
- **Deliverable:** Electron app boots, loads Rust addon, IPC works end-to-end

### Slice 7 — UI: Recording + Clipboard Flow
- RecordingIndicator component (idle / recording / processing states)
- Hotkey triggers recording via IPC → transcription → clipboard
- Visual + audio feedback on completion
- Settings panel for hotkey configuration and LLM toggle
- **Deliverable:** Full dictate → clipboard flow working in the app

### Slice 8 — UI: Timeline View
- Timeline component with EntryCard list
- Display entries newest-first with timestamp, duration, source app
- Raw/polished toggle per card
- Pin, archive, delete actions
- "Polish now" button for entries that don't have polished_text
- **Deliverable:** Scrollable history of all dictations

### Slice 9 — UI: Note Editor View
- TipTap rich text editor integration
- Dictate-to-editor flow (text inserted at cursor instead of clipboard)
- Auto-save to SQLite
- View toggle between Editor and Timeline
- **Deliverable:** Notion-like note-taking powered by voice

### Slice 10 — UI: Search, Tags, Dictionary
- SearchBar with debounced FTS5 queries
- Tag management on entries
- Dictionary manager UI (add/remove custom words)
- **Deliverable:** Full organization and findability features

### Slice 11 — Polish, Packaging, CI
- Electron-builder config for Mac (.dmg), Windows (.exe/.msi), Linux (.AppImage/.deb)
- Bundle models into installer
- GitHub Actions CI: lint, test, build all platforms
- README, LICENSE, contributing guide
- **Deliverable:** Downloadable, installable app with CI pipeline

---

## Non-Goals (For Now)

- Admin console / central policy management
- Team/multi-user features
- Cloud sync
- Mobile apps (iOS/Android)
- Real-time streaming transcription (we do batch after stop)
- Plugin/extension system

---

## Success Metrics

- **Latency:** < 2 seconds from stop-recording to text-in-clipboard for a 30-second dictation
- **Accuracy:** Whisper large-v3-turbo word error rate competitive with cloud STT services
- **Memory:** < 4 GB RAM usage during active transcription + LLM pass
- **Install size:** < 8 GB including bundled models
- **Startup:** < 3 seconds to app-ready (models pre-loaded in background)