<p align="center">
  <img src="assets/icon-256.png" alt="IronMic" width="120" />
</p>

# Security Policy

IronMic is built with security and privacy as foundational architectural constraints — not afterthoughts. This document describes our security model, what we protect against, what we don't, and what you should do to stay secure.

---

## Threat Model

IronMic is a **local-first desktop application**. Your data never leaves your machine during normal operation. The threats we design against are:

| Threat | How we address it |
|--------|-------------------|
| Cloud data breach | Eliminated — no cloud, no accounts, no server |
| Network eavesdropping | Eliminated — all outbound requests blocked |
| Compromised model downloads | SHA-256 integrity verification + HTTPS-only + domain validation |
| Local malware reading your data | Mitigated — recommend full-disk encryption. App-level encryption on roadmap |
| Renderer XSS from AI responses | Mitigated — no raw HTML rendering, markdown sanitized |
| Environment variable leakage | Mitigated — scoped env for AI child processes |
| Unattended device access | Mitigated — configurable session timeout with lock screen |

---

## Network Isolation

IronMic makes **zero network requests** during normal operation. This is enforced at two levels:

### Electron Request Interceptor
All outbound HTTP, HTTPS, and WebSocket requests are blocked before they leave the process. The interceptor runs at app startup, before any window is created:

```
Allowed: file://, devtools://, localhost (dev only), data:, chrome-extension://
Blocked: Everything else — logged and cancelled
```

### Content Security Policy
The renderer enforces a strict CSP via meta tag:
```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
```

`unsafe-inline` for styles is required by the CSS framework (Tailwind). Script execution is restricted to `'self'` only.

### The One Exception: Model Downloads
When you explicitly click "Download" in Settings, the app fetches model files from HuggingFace over HTTPS. This is the **only** network code in the entire application, isolated to a single file (`model-downloader.ts`). See "Model Download Security" below.

---

## Audio Privacy

Your voice data is treated as the most sensitive data in the app:

1. **Memory only.** Mic input is captured into an in-memory ring buffer. Audio is never written to disk — no temp files, no WAV exports, no cache.

2. **Zero on drop.** When audio processing completes (or the app closes, or an error occurs), the buffer is explicitly zeroed:
   ```rust
   self.data.fill(0.0);
   self.data.clear();
   self.data.shrink_to_fit();
   ```
   This applies to:
   - `AudioRingBuffer` (mic capture)
   - `CapturedAudio` (processed audio)
   - `ProcessedAudio` (resampled audio)
   - `SecureAudioBuffer` (TTS playback)

3. **No recording indicator bypass.** Recording only starts when you press the hotkey or mic button. There is no background listening, no wake word, no always-on mic.

---

## Data at Rest

### SQLite Database
Your dictation entries, settings, and dictionary are stored in a single SQLite file at your OS application data directory (e.g., `~/.local/share/IronMic/ironmic.db` on Linux, `~/Library/Application Support/IronMic/` on macOS).

**Current state:** The database is **not encrypted by IronMic** at the application level.

**Recommendation:** Enable full-disk encryption on your operating system:
- **macOS:** FileVault (System Settings > Privacy & Security > FileVault)
- **Windows:** BitLocker (Settings > Privacy & security > Device encryption)
- **Linux:** LUKS (configured at install time)

Application-level encryption via SQLCipher is on our roadmap.

### Local Storage
AI chat sessions and notes are stored in the Electron renderer's `localStorage`, which persists as an unencrypted SQLite file managed by Chromium. The "Clear Sessions on Exit" security setting wipes this data when the app closes.

### What's Stored Where

| Data | Storage | Encrypted |
|------|---------|-----------|
| Dictation entries | SQLite | No (use OS disk encryption) |
| Settings & preferences | SQLite | No |
| Custom dictionary | SQLite | No |
| AI chat sessions | localStorage | No (clearable on exit) |
| Notes & notebooks | localStorage | No (clearable on exit) |
| Theme preference | localStorage | N/A (not sensitive) |
| Audio recordings | **Not stored** | N/A |
| Model files | Filesystem | No (public data) |

---

## Model Download Security

Model files are large binary blobs (90 MB to 4.4 GB) loaded directly into inference engines. A compromised model file is a realistic attack vector — parser bugs in Whisper.cpp, llama.cpp, and ONNX Runtime are not uncommon.

### Protections

1. **HTTPS enforced.** HTTP URLs are rejected outright. All downloads use TLS.

2. **Domain validation.** Downloads and redirects are only permitted to `*.huggingface.co`. Redirects to any other domain are rejected.

3. **SHA-256 integrity verification.** Every model file is verified against a known-good SHA-256 hash after download. If the hash doesn't match, the file is deleted and the download fails with a clear error.

4. **Atomic writes.** Files download to a `.downloading` temp path and are renamed to the final path only after verification passes. Interrupted downloads never leave partial files.

5. **Timeouts.** Downloads abort after 10 minutes total or 60 seconds of no data (stall detection). Temp files are cleaned up.

### Model Sources

| Model | Source | Size |
|-------|--------|------|
| Whisper large-v3-turbo | `huggingface.co/ggerganov/whisper.cpp` | ~1.5 GB |
| Mistral 7B Instruct Q4 | `huggingface.co/TheBloke/Mistral-7B-Instruct-v0.2-GGUF` | ~4.4 GB |
| Kokoro 82M TTS (fp16) | `huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX` | ~163 MB |
| Kokoro voice files (15) | Same repo, `voices/` directory | ~500 KB each |

---

## AI Assistant Security

The AI chat feature wraps **locally-installed CLI tools** (Claude Code CLI or GitHub Copilot CLI). IronMic does not make API calls itself.

### Data Flow
```
Your message text → local CLI binary → CLI's own cloud API (using your credentials)
```

IronMic does not:
- Store your AI provider credentials
- Make any API calls on your behalf
- Send data to any server other than what the CLI does on its own

### Environment Scoping
When spawning AI CLI processes, IronMic passes a **scoped environment** — only the variables the CLI needs to function:

| Variable | Purpose |
|----------|---------|
| `PATH`, `HOME`, `SHELL`, `LANG` | System essentials |
| `ANTHROPIC_API_KEY` | Claude CLI auth (only when using Claude) |
| `GH_TOKEN` / `GITHUB_TOKEN` | Copilot CLI auth (only when using Copilot) |

Other environment variables (AWS keys, database URLs, other secrets) are **not passed** to child processes.

### Log Redaction
Prompt text is never written to console logs. Logs show only metadata (provider name, argument count, prompt length). Stderr output from CLIs is only logged in development mode.

---

## Electron Security Configuration

| Setting | Value | Purpose |
|---------|-------|---------|
| `contextIsolation` | `true` | Renderer cannot access Node.js APIs directly |
| `nodeIntegration` | `false` | No `require()` or `process` in renderer |
| `sandbox` | `true` | Renderer runs in Chromium's sandbox |
| `preload` | Typed IPC bridge | Only ~60 specific IPC channels exposed |

The renderer communicates with the main process exclusively through a typed `contextBridge` API. There is no direct filesystem, network, or process access from the renderer.

### IPC Input Validation
High-risk IPC channels validate their inputs:
- **Model downloads:** Model name checked against known list
- **Settings:** Key checked against allowlist, value length capped
- **AI messages:** Prompt length capped at 100,000 characters, provider validated
- **Transcription:** Audio buffer size capped at 100 MB

---

## Clipboard Security

When dictation completes, the text is copied to your system clipboard. The **Clipboard Auto-Clear** setting (in Settings > Security) can automatically wipe the clipboard after 15 seconds, 30 seconds, 1 minute, or 2 minutes.

By default, auto-clear is off. If you work with sensitive content, we recommend enabling it.

---

## Session Security

The **Session Timeout** setting (in Settings > Security) locks the app after a period of inactivity. When locked, a full-screen overlay blocks access until you click "Resume Session."

Available timeouts: 5 minutes, 15 minutes, 30 minutes, 1 hour, or off.

---

## SQL Injection Protection

All database operations use parameterized queries via `rusqlite`. No user input is ever concatenated into SQL strings. Full-text search queries are properly escaped.

---

## What We Don't Protect Against

Being transparent about limitations is part of good security:

1. **Physical access to an unlocked machine.** If someone can sit at your computer, they can read the SQLite database, localStorage files, or memory. The session timeout helps, but is not a substitute for OS-level security.

2. **Malware with root/admin access.** If malware has elevated privileges on your machine, it can read process memory, intercept keystrokes, and access any file. No application can fully defend against this.

3. **Compromised AI CLI tools.** If the Claude or Copilot CLI binary on your machine is replaced with a malicious version, IronMic will execute it. We validate the binary path but do not verify binary signatures.

4. **Supply chain attacks on dependencies.** Our Rust and npm dependencies could theoretically contain vulnerabilities. We minimize dependencies and review major ones, but do not audit every transitive dependency.

---

## Security Settings Reference

All security settings are in **Settings > Security**:

| Setting | Options | Default | Description |
|---------|---------|---------|-------------|
| Clipboard Auto-Clear | Off, 15s, 30s, 1m, 2m | Off | Wipe clipboard after copying dictation |
| Session Timeout | Off, 5m, 15m, 30m, 1hr | Off | Lock app after idle period |
| Clear Sessions on Exit | On/Off | Off | Wipe AI chats and notes when app closes |
| AI Data Confirmation | On/Off | Off | Require confirmation before sending text to AI |
| Privacy Mode | On/Off | Off | Hide dictation text, show only metadata |

---

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public GitHub issue.
2. Email: security@ironmic.dev (or open a private security advisory on GitHub).
3. Include: description, reproduction steps, and impact assessment.
4. We will respond within 48 hours and aim to fix critical issues within 7 days.

---

## Roadmap

Planned security improvements:

- [ ] SQLCipher database encryption with OS keychain key management
- [ ] localStorage encryption for chat sessions and notes
- [ ] Full-disk encryption detection with warning in Security settings
- [ ] Mutex poison handling to prevent cascade denial-of-service in Rust
- [ ] Binary signature verification for AI CLI tools
- [ ] `cargo audit` and `npm audit` in CI pipeline
