# IronMic — Ideas & Feature Roadmap

A collection of 15 feature proposals for IronMic, each documented as a standalone design document with full architecture, database schemas, implementation phases, and success metrics. Every feature preserves IronMic's core principle: **everything local, nothing leaves the device.**

---

## At a Glance

| # | Feature | Impact | Feasibility | Status |
|---|---------|--------|-------------|--------|
| 1 | [Ambient Context Engine](#1-ambient-context-engine) | High | High | Proposed |
| 2 | [Live Coaching & Communication Analytics](#2-live-coaching--communication-analytics) | High | High | Proposed |
| 3 | [Multi-Device Mesh](#3-multi-device-mesh) | High | Medium | Proposed |
| 4 | [Offline Meeting Copilot](#4-offline-meeting-copilot) | Very High | Medium | Proposed |
| 5 | [Organizational Voice Intelligence](#5-organizational-voice-intelligence) | Very High | Medium | Proposed |
| 6 | [Programmable Voice Macros](#6-programmable-voice-macros) | High | High | Proposed |
| 7 | [Speaker Separation & Voice Identity](#7-speaker-separation--voice-identity) | Very High | Medium | Proposed |
| 8 | [Voice-Driven Workspace Automation](#8-voice-driven-workspace-automation) | Medium | Medium | Proposed |
| 9 | [Voice Fingerprint Security](#9-voice-fingerprint-security) | Medium | Medium | Proposed |
| 10 | [Voice-to-Structured Data](#10-voice-to-structured-data) | High | High | Proposed |
| 11 | [Voice-Powered Accessibility Layer](#11-voice-powered-accessibility-layer) | Very High | Low | Proposed |
| 12 | [Multi-Language Dictation & Translation](#12-multi-language-dictation--translation) | Very High | High | Proposed |
| 13 | [Voice Journal & Mood/Sentiment Tracking](#13-voice-journal--moodsentiment-tracking) | Medium | High | Proposed |
| 14 | [Audio Summarization & Digest Generation](#14-audio-summarization--digest-generation) | High | High | Proposed |
| 15 | [Collaborative Transcript Review](#15-collaborative-transcript-review) | High | Medium | Proposed |

**Impact** reflects how much value the feature delivers to users and how it differentiates IronMic from alternatives. **Feasibility** reflects implementation complexity, new dependency count, and platform risk.

---

## Feature Summaries

### 1. Ambient Context Engine

**[Read full proposal](ambient-context-engine.md)**

Passively detects the active application (VS Code, Gmail, Slack, Terminal, etc.) and automatically adapts dictation behavior to match. When you dictate in a code editor, IronMic formats output as docstrings. In email, it structures a professional message. In a terminal, it generates shell commands.

- **How it works:** Platform-native window detection (AXUIElement on macOS, Win32 on Windows, xdotool on Linux) polls the active window every 500ms. A rule-based classifier maps the app to a context category, selects an LLM prompt template, and boosts domain-specific Whisper vocabulary.
- **New dependencies:** 0-1 Rust crates (platform-specific window APIs)
- **New models:** None (optional 5KB TF.js classifier for edge cases)

| Impact | Feasibility |
|--------|-------------|
| **High** — Transforms IronMic from "a tool you paste from" into "a tool that understands where you're pasting to." Every dictation becomes more useful without any user effort. | **High** — Mostly rule-based classification with existing LLM. Window detection APIs are well-documented. The heaviest work is covering edge cases across 3 platforms. |

---

### 2. Live Coaching & Communication Analytics

**[Read full proposal](live-coaching-and-communication-analytics.md)**

Provides real-time communication feedback during meetings (talk-to-listen ratio, speaking pace, filler word frequency) and post-meeting scorecards. Over time, builds a personal communication dashboard with weekly trends, peer comparisons, and LLM-generated coaching suggestions.

- **How it works:** Leverages existing VAD and turn detection to compute speaking metrics in real-time. A filler word detector (regex on transcript + optional TF.js classifier) runs on each transcription chunk. The local LLM generates post-meeting insights by analyzing the full transcript against historical baselines.
- **New dependencies:** 0 (uses existing TF.js + LLM infrastructure)
- **New models:** Optional filler word classifier (~1MB TF.js)

| Impact | Feasibility |
|--------|-------------|
| **High** — Unique differentiator. No other local-first tool offers communication coaching. High value for sales teams, managers, and anyone who presents frequently. | **High** — Builds almost entirely on existing VAD, turn detection, and analytics infrastructure. The core metrics (talk ratio, WPM, filler count) are straightforward computations on data IronMic already produces. |

---

### 3. Multi-Device Mesh

**[Read full proposal](multi-device-mesh.md)**

Peer-to-peer synchronization of IronMic data across multiple devices on the same local network. Devices discover each other via mDNS, pair via QR code or PIN, and sync settings, dictionary, entries, and meetings over TLS-encrypted connections. No cloud, no internet, no intermediary server.

- **How it works:** mDNS service advertisement for discovery. TLS-encrypted TCP connections for data transfer. Vector clocks for conflict resolution. Delta-based sync to minimize bandwidth. Selective sync (choose what data types to sync).
- **New dependencies:** mDNS crate, TLS crate, CRDT/vector clock logic
- **New models:** None

| Impact | Feasibility |
|--------|-------------|
| **High** — Solves a real pain point for users with multiple machines. Maintains the zero-cloud promise while enabling multi-device workflows. Enterprise-friendly (no firewall exceptions for external services). | **Medium** — Distributed sync is inherently complex. Conflict resolution with CRDTs requires careful design. mDNS reliability varies across networks (corporate firewalls often block it). Cross-platform testing across 3 OSes adds significant QA surface. |

---

### 4. Offline Meeting Copilot

**[Read full proposal](offline-meeting-copilot.md)**

A real-time contextual recall system that runs during meetings. As the transcript grows, IronMic extracts entities and keywords, searches the historical corpus of past meetings and notes, and surfaces relevant context in a non-intrusive sidebar. Also generates pre-meeting briefing cards summarizing previous instances of recurring meetings.

- **How it works:** A streaming extraction pipeline runs on each transcription chunk (~5s intervals), pulling keywords and entities. These are used to query FTS5 and semantic search (USE embeddings) against the full historical corpus. Relevance-scored results appear in a sidebar with source citations.
- **New dependencies:** 0 (uses existing FTS5 + USE embeddings)
- **New models:** None

| Impact | Feasibility |
|--------|-------------|
| **Very High** — This is a "killer feature" for knowledge workers. Having past context surface automatically during meetings eliminates the "what did we decide last time?" problem. The pre-meeting briefing alone saves 10+ minutes of manual prep per recurring meeting. | **Medium** — The real-time extraction-and-retrieval pipeline must complete within the transcription interval (~5s). Entity extraction quality depends heavily on LLM accuracy. Semantic search recall needs tuning to avoid surfacing irrelevant results. The UX challenge is showing enough context without overwhelming the user during a live meeting. |

---

### 5. Organizational Voice Intelligence

**[Read full proposal](organizational-voice-intelligence.md)**

Builds a personal knowledge graph from the accumulated corpus of dictations, meetings, and AI conversations. Extracts entities (people, projects, decisions, commitments, dates) and their relationships into a queryable graph. Users ask natural language questions: "What commitments did I make to Sarah this quarter?" and get structured, time-aware answers with source citations.

- **How it works:** The local LLM extracts entities and relationships from transcripts in batch (background processing). Entities are stored in a graph-like SQLite schema with relationship edges. A natural language query interface routes questions through the LLM, which generates SQLite queries against the knowledge graph and synthesizes answers from the results.
- **New dependencies:** 0 (uses existing LLM + SQLite)
- **New models:** None

| Impact | Feasibility |
|--------|-------------|
| **Very High** — Turns months of voice data into a searchable organizational memory. The ability to query "what did we decide about X" across all meetings is transformational for anyone managing multiple projects or teams. | **Medium** — Entity extraction from conversational speech is imperfect. The knowledge graph schema must handle ambiguity (same project called different names). The LLM-to-SQL pipeline requires careful prompt engineering to generate correct queries. Building up a useful graph requires enough historical data — first-week users won't see much value. |

---

### 6. Programmable Voice Macros

**[Read full proposal](programmable-voice-macros.md)**

A YAML-based macro system that lets users define custom voice-triggered workflows. A macro is a named pipeline: a voice trigger phrase activates a sequence of steps that query data, transform it with the local LLM, format the output, and deliver it to clipboard, files, or notes. Built-in macros ship for common workflows (weekly summary, daily standup, meeting prep, action item roundup).

- **How it works:** The intent classifier detects a "macro" intent, fuzzy-matches the transcript against registered trigger phrases, and executes the matching macro's step sequence. Steps include data queries, LLM transforms, formatting, filtering, and output actions. Execution is sandboxed with resource limits.
- **New dependencies:** `js-yaml`, `ajv` (schema validation), `string-similarity`
- **New models:** None

| Impact | Feasibility |
|--------|-------------|
| **High** — Enables power users to build custom voice-automated workflows without code. The built-in macros (weekly summary, standup update) provide immediate value. Import/export enables team sharing. | **High** — The execution engine is a straightforward step-by-step pipeline using existing IPC calls. YAML parsing and variable interpolation are well-understood patterns. The main complexity is the visual macro editor UI and robust error handling for user-defined steps. |

---

### 7. Speaker Separation & Voice Identity

**[Read full proposal](speaker-separation-and-voice-identity.md)**

Real speaker diarization using an ECAPA-TDNN embedding model to identify who said what in meetings. Users enroll their voice once, and subsequent meetings automatically label "You" vs named contacts vs unknown speakers. Unknown speakers can be named post-meeting, and their voice identity persists across all future meetings.

- **How it works:** An ONNX-based ECAPA-TDNN model (~30MB) extracts 192-dimensional speaker embeddings from 2-second audio segments. During meetings, the diarizer clusters embeddings into speaker groups. Enrolled speaker embeddings are matched via cosine similarity to label known speakers. Contact profiles accumulate meeting history and topic statistics.
- **New dependencies:** ECAPA-TDNN ONNX model (~30MB)
- **New models:** Speaker embedding model (~30MB, runs on existing ONNX Runtime)

| Impact | Feasibility |
|--------|-------------|
| **Very High** — Speaker-labeled meeting transcripts are dramatically more useful than unlabeled ones. Persistent voice identity across meetings enables contact-level analytics and context. This is a prerequisite for several other features (voice auth, coaching per-contact). | **Medium** — Diarization accuracy in noisy, overlapping-speech environments is a known hard problem. The ECAPA-TDNN model requires careful audio preprocessing (SNR filtering, segment boundary detection). Cross-microphone consistency (laptop mic vs USB headset) affects embedding reliability. Enrollment UX must be frictionless to drive adoption. |

---

### 8. Voice-Driven Workspace Automation

**[Read full proposal](voice-driven-workspace-automation.md)**

A plugin/action execution layer that maps voice commands to parameterized operations on external tools. "Create Jira tickets for each action item from this meeting." IronMic classifies the intent, extracts parameters via the local LLM, and executes sandboxed actions with explicit user approval. Plugins are defined in YAML with webhook, file write, and clipboard actions.

- **How it works:** Voice commands are classified by the intent classifier, then routed to a plugin executor that matches the intent to registered action definitions. The LLM extracts structured parameters from the transcript. Actions are previewed for user approval before execution. Audit logging tracks all external actions.
- **New dependencies:** 0-1 npm packages (webhook client)
- **New models:** None

| Impact | Feasibility |
|--------|-------------|
| **Medium** — Powerful for power users who live in multiple tools, but the value depends on having the right plugins configured. The explicit-approval model adds friction that limits "magic" feel. The network call requirement (webhooks) tensions with IronMic's zero-network principle. | **Medium** — The action execution framework is straightforward, but the value of the system depends on the quality and breadth of available plugins. Each integration target (Jira, Slack, etc.) requires its own YAML definition and testing. The security model (webhook allowlisting, sandbox, audit trail) adds significant surface area. |

---

### 9. Voice Fingerprint Security

**[Read full proposal](voice-fingerprint-security.md)**

Biometric voice authentication that verifies the speaker's identity before allowing transcription. Enrollment captures a voiceprint (mathematical embedding, not audio). Anti-spoofing detects replay attacks via spectral analysis. Supports continuous re-verification during sessions, PIN fallback, multi-user profiles with data isolation, and enterprise provisioning with encrypted profile export/import.

- **How it works:** The same ECAPA-TDNN model from speaker separation extracts a voiceprint during enrollment. Before each dictation, a 2-second audio sample is compared against the enrolled embedding via cosine similarity. Anti-spoofing heuristics (spectral flatness, high-frequency energy, reverb estimation) detect replay attacks. A session state machine manages locked/authenticated/challenged states.
- **New dependencies:** `bcrypt`/`argon2`, `aes-gcm`, `hmac` + `sha2` (Rust crates)
- **New models:** Shares ECAPA-TDNN with speaker separation

| Impact | Feasibility |
|--------|-------------|
| **Medium** — High value for shared workstations (call centers, hospitals) and regulated industries (legal, finance). Lower value for single-user personal machines. The enterprise provisioning angle opens new deployment scenarios. | **Medium** — Depends on speaker separation being implemented first (shared model). Anti-spoofing is heuristic-based and may produce false positives in noisy environments. Voice changes (illness, aging) require threshold tuning. Biometric consent has legal implications (BIPA, GDPR Article 9) that need careful UX. |

---

### 10. Voice-to-Structured Data

**[Read full proposal](voice-to-structured-data.md)**

Transforms free-form voice input into machine-readable structured records (JSON, CSV, markdown). Users define schemas with typed fields (currency, date, enum, email, etc.), then dictate data naturally. The local LLM extracts field values from the transcript, validates against constraints, and outputs clean structured data. Supports batch row-by-row data entry.

- **How it works:** Users create schemas in a visual builder or YAML. When dictating with a schema active, the LLM receives the transcript + schema definition and extracts values into a structured JSON object. Type-specific validators check constraints (amount > 0, email format, enum membership). A confirmation UI shows extracted fields for review before output.
- **New dependencies:** `ajv` (JSON Schema validation, shared with macros)
- **New models:** None

| Impact | Feasibility |
|--------|-------------|
| **High** — Unlocks voice input for structured workflows: expense tracking, CRM data entry, inventory logging, time tracking. Huge time savings for field workers, sales reps, and anyone who currently types structured data from verbal information. | **High** — The LLM handles the hard part (natural language → structured extraction). Schema validation is a solved problem. The main risk is extraction accuracy for complex schemas with many fields, but the confirmation UI catches errors before output. |

---

### 11. Voice-Powered Accessibility Layer

**[Read full proposal](voice-accessibility-layer.md)**

System-wide hands-free computer operation. Navigate the OS, click buttons, fill forms, manage windows, scroll, type, and invoke keyboard shortcuts — all by voice. Bridges to the OS accessibility tree (AXUIElement on macOS, UI Automation on Windows, AT-SPI on Linux) to enumerate and target UI elements. Supports numbered hint overlays for disambiguation, wake word detection for hands-free activation, and custom voice shortcuts.

- **How it works:** Platform-native APIs enumerate visible UI elements (role, label, bounds). Voice commands are parsed by a rule-based grammar with LLM fallback for ambiguous inputs. Element targeting uses fuzzy label matching with ordinal and role-aware resolution. Actions are simulated via platform APIs (AXPerformAction, SendInput, xdotool). A transparent overlay window renders numbered hints for disambiguation.
- **New dependencies:** 2-3 Rust crates (platform accessibility APIs), wake word ONNX model (~200KB)
- **New models:** Keyword spotter for wake word (~200KB ONNX)

| Impact | Feasibility |
|--------|-------------|
| **Very High** — Positions IronMic as a full assistive technology platform, replacing expensive proprietary solutions (Dragon NaturallySpeaking, Talon Voice). Life-changing for users with motor disabilities or RSI. Also valuable for any hands-free workflow. | **Low** — The most technically ambitious idea in this collection. Each platform's accessibility API has different capabilities and limitations. Wayland on Linux severely restricts window inspection. Complex web apps (React, canvas-based UIs) often have poor accessibility tree coverage. The command grammar must handle infinite variation in how users phrase actions. Cross-platform testing and edge case coverage is enormous. |

---

### 12. Multi-Language Dictation & Translation

**[Read full proposal](multilingual-translation.md)**

Dictate in any of Whisper's 99 supported languages with auto-detection. On-device translation via the local LLM converts transcripts between languages. User-defined glossaries ensure domain terminology translates correctly. Side-by-side original + translated views. Optional language learning mode with grammar correction feedback.

- **How it works:** Whisper's `language` parameter is exposed for explicit language selection or auto-detection. After transcription, the local Mistral LLM translates via a structured prompt with glossary injection. Entries store both source and translated text. Cross-lingual semantic search uses a multilingual USE model variant.
- **New dependencies:** `whatlang` Rust crate (text-based language detection)
- **New models:** Multilingual USE replaces English-only USE (+70MB net)

| Impact | Feasibility |
|--------|-------------|
| **Very High** — Opens IronMic to the global market. Bilingual professionals, international teams, translators, and language learners all benefit. Local translation of sensitive content (legal, medical) is a compelling differentiator vs cloud translation services. | **High** — Whisper already supports 99 languages natively. The LLM translation quality for major language pairs is good, though less common pairs may be rough. The main work is UI (language selector, side-by-side view, glossary manager) and extending the pipeline to pass language parameters through. No new heavy models required. |

---

### 13. Voice Journal & Mood/Sentiment Tracking

**[Read full proposal](voice-journal-sentiment-tracking.md)**

A dedicated journaling mode with automatic sentiment analysis and emotional trend tracking. Dictate daily entries, and IronMic classifies mood using a lightweight TF.js sentiment model and LLM emotional analysis. Visualize emotional patterns with calendar heat maps, mood trend charts, theme correlations, and AI-generated weekly reflections. Journaling prompts encourage consistent practice.

- **How it works:** A TF.js bidirectional LSTM (~2MB) provides instant numeric sentiment scores (valence/arousal). The local LLM extracts specific moods, themes, gratitude items, and a mood arc summary. An insight engine detects correlations (exercise → higher mood), temporal patterns (Mondays are worst), and trends over time. Weekly reflections are LLM-generated summaries.
- **New dependencies:** Sentiment LSTM model (~2MB TF.js), possibly a charting library
- **New models:** Sentiment classifier (~2MB, ships with app)

| Impact | Feasibility |
|--------|-------------|
| **Medium** — Extends IronMic into the personal wellness space. High engagement potential (streaks, prompts, reflections), but it's a niche use case compared to core productivity features. Strongest as a complement to the main dictation/meeting workflow rather than a standalone draw. | **High** — The infrastructure is largely in place: dictation pipeline, LLM analysis, analytics framework, TTS for read-back. The new work is the journal entry type, sentiment model integration, mood visualizations, and insight engine. The TF.js sentiment model is small and well-understood. |

---

### 14. Audio Summarization & Digest Generation

**[Read full proposal](digest-generation.md)**

Automatically generates daily briefings and weekly digests that compress all dictation entries, meetings, AI chats, and journal entries into key takeaways, decisions, action items, and open questions. Scheduled generation (7 AM daily, Sunday evening weekly) with notification. On-demand custom digests by topic or date range. Action item tracking with carried-forward detection and stale item flagging.

- **How it works:** A digest aggregator queries all content sources for the target period. If the content exceeds the LLM context window, hierarchical summarization splits content into chunks, summarizes each, then synthesizes a final digest. An action item extractor identifies tasks and tracks them across digests. Scheduled generation runs in the background.
- **New dependencies:** `node-cron` or equivalent (scheduling)
- **New models:** None

| Impact | Feasibility |
|--------|-------------|
| **High** — Transforms IronMic from information capture to information surfacing. The morning briefing alone saves 10-15 minutes of timeline scrolling. Action item tracking with carried-forward detection ensures nothing falls through the cracks. Particularly valuable for busy professionals managing multiple projects. | **High** — All heavy lifting uses existing infrastructure (SQLite queries, LLM summarization, notifications). The hierarchical summarization approach is well-documented in the LLM literature. The scheduling component is the only new dependency. The main risk is LLM summarization quality — important details may be lost in compression. |

---

### 15. Collaborative Transcript Review

**[Read full proposal](collaborative-transcript-review.md)**

A lightweight local HTTP + WebSocket server that shares a single transcript for review with others on the same network. Reviewers open a URL in any browser to view, annotate, suggest corrections, and approve sections. Real-time cursor presence, threaded comments, change tracking with accept/reject workflow, and a full audit log. Token-based access with configurable expiration. No cloud, no accounts, no installation required for reviewers.

- **How it works:** IronMic's Electron main process runs a lightweight HTTP server (Express/Fastify) on a configurable LAN port. A self-contained React review client is served as static assets. WebSocket connections enable real-time sync of cursors, annotations, and corrections. The author controls the session lifecycle: create, pause, finalize, revoke.
- **New dependencies:** `express` or `fastify`, `ws` (WebSocket)
- **New models:** None

| Impact | Feasibility |
|--------|-------------|
| **High** — Unlocks professional use cases that require transcript review: legal depositions, medical dictation, journalism, meeting minutes approval. The zero-install reviewer experience (just a browser URL) removes adoption friction. The LAN-only model fits enterprise security requirements. | **Medium** — Running an HTTP server inside Electron is unconventional and adds attack surface. WebSocket-based real-time sync with conflict resolution (concurrent annotations on the same text span) needs careful implementation. The self-contained review client must work across browsers without any of IronMic's Electron/Tailwind dependencies. TLS support for sensitive content adds complexity. |

---

## Impact vs Feasibility Matrix

```
                         FEASIBILITY
                    Low      Medium     High
                ┌──────────┬──────────┬──────────┐
     Very High  │ 11       │ 4, 5, 7  │ 12       │
                │          │          │          │
  I    High     │          │ 3, 15    │ 1, 2,    │
  M             │          │          │ 6, 10, 14│
  P    Medium   │          │ 8, 9     │ 13       │
  A             │          │          │          │
  C    Low      │          │          │          │
  T             │          │          │          │
                └──────────┴──────────┴──────────┘

Legend:
 1  Ambient Context Engine          9  Voice Fingerprint Security
 2  Live Coaching & Analytics      10  Voice-to-Structured Data
 3  Multi-Device Mesh              11  Voice Accessibility Layer
 4  Offline Meeting Copilot        12  Multi-Language & Translation
 5  Organizational Intelligence    13  Voice Journal & Sentiment
 6  Programmable Voice Macros      14  Digest Generation
 7  Speaker Separation             15  Collaborative Transcript Review
 8  Workspace Automation
```

---

## Suggested Implementation Priority

Based on the impact/feasibility analysis, a recommended implementation order:

### Tier 1 — High Impact, High Feasibility (build first)
1. **Multi-Language Dictation & Translation** (#12) — Opens the global market with minimal new infrastructure.
2. **Digest Generation** (#14) — Immediate daily value for every user. Uses only existing LLM.
3. **Ambient Context Engine** (#1) — Makes every dictation better automatically. Mostly rule-based.
4. **Live Coaching & Communication Analytics** (#2) — Unique differentiator built on existing VAD/turn detection.

### Tier 2 — Very High Impact, Medium Feasibility (build next)
5. **Speaker Separation & Voice Identity** (#7) — Prerequisite for voice auth and per-contact coaching.
6. **Offline Meeting Copilot** (#4) — Killer meeting feature using existing search infrastructure.
7. **Organizational Voice Intelligence** (#5) — Builds on speaker separation + accumulated data.

### Tier 3 — High Impact, Various Feasibility (build when ready)
8. **Programmable Voice Macros** (#6) — Power-user feature, benefits from having Tier 1-2 as data sources.
9. **Voice-to-Structured Data** (#10) — Extends IronMic into data entry workflows.
10. **Collaborative Transcript Review** (#15) — Opens professional/enterprise use cases.
11. **Multi-Device Mesh** (#3) — High value but high complexity. Benefits from stable feature set.

### Tier 4 — Specialized or Dependent (build last)
12. **Voice Fingerprint Security** (#9) — Depends on speaker separation (#7). Enterprise-focused.
13. **Voice-Driven Workspace Automation** (#8) — Requires external network calls, niche audience.
14. **Voice Journal & Mood/Sentiment Tracking** (#13) — Complementary feature, not core.
15. **Voice-Powered Accessibility Layer** (#11) — Highest impact potential but lowest feasibility. Massive cross-platform effort. Consider as a dedicated initiative.

---

## How to Read These Proposals

Each document follows a consistent structure:

| Section | What's in it |
|---------|-------------|
| **Overview** | What the feature is, why it matters, how it builds on existing IronMic capabilities |
| **What This Enables** | Concrete user scenarios with example inputs and outputs |
| **Architecture** | ASCII system diagrams, component trees, data flow diagrams |
| **Technical Detail** | Implementation specifics (varies by feature) |
| **Database Schema** | New SQL tables, indexes, and settings table entries |
| **Integration** | How the feature connects to existing IronMic systems |
| **Privacy Considerations** | How the feature maintains zero-network, zero-telemetry guarantees |
| **Implementation Phases** | 4-6 phased delivery plan with concrete deliverables |
| **Performance** | Operation timing tables and memory budget |
| **N-API Surface** | TypeScript function signatures for Rust ↔ Electron bridge |
| **New Files** | Tables listing new files and modifications to existing files |
| **Open Questions** | 5-7 unresolved design decisions |
| **Dependencies** | What's needed and what already exists in the project |
| **Success Metrics** | Measurable goals for the feature |

---

## Contributing

To propose a new idea, create a markdown file in this directory following the structure above. At minimum, include:

1. A clear **Overview** explaining the what and why
2. **What This Enables** with concrete user scenarios
3. An **Architecture** section showing where it fits in IronMic's stack
4. **Privacy Considerations** proving zero-network compliance
5. **Implementation Phases** with deliverables per phase

The bar for ideas is high — each proposal should be specific enough that an engineer could start building from it.
