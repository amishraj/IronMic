<p align="center">
  <img src="assets/icon-256.png" alt="IronMic" width="100" />
</p>

<h1 align="center">IronMic Security Self-Audit</h1>

<p align="center">
  <em>Verifiable, code-referenced audit of every security claim we make.</em><br/>
  Last updated: April 2026
</p>

---

## Why This Document Exists

We claim IronMic is private, local-first, and secure. This document exists so you can **verify those claims yourself**. Every section below links to the exact file and line number in our source code that implements the behavior we describe.

We encourage you to:
1. Read this audit and follow the code references.
2. Run the app and test the claims.
3. If you don't trust our self-audit, **hire your own security professional** to review this codebase. We welcome it. We have nothing to hide.

This is not marketing. This is accountability.

---

## Table of Contents

- [1. Network Isolation](#1-network-isolation)
- [2. Audio Privacy (Zero-on-Drop)](#2-audio-privacy-zero-on-drop)
- [3. Model Download Security](#3-model-download-security)
- [4. Model Source Verification](#4-model-source-verification)
- [5. Electron Sandbox & Isolation](#5-electron-sandbox--isolation)
- [6. Content Security Policy](#6-content-security-policy)
- [7. IPC Input Validation](#7-ipc-input-validation)
- [8. AI Data Flow & Environment Scoping](#8-ai-data-flow--environment-scoping)
- [9. Log Redaction](#9-log-redaction)
- [10. SQL Injection Protection](#10-sql-injection-protection)
- [11. XSS Prevention](#11-xss-prevention)
- [12. Clipboard Security](#12-clipboard-security)
- [13. Session Timeout & Lock](#13-session-timeout--lock)
- [14. Data Wipe on Exit](#14-data-wipe-on-exit)
- [15. Rust Unsafe Code Audit](#15-rust-unsafe-code-audit)
- [16. No Telemetry Verification](#16-no-telemetry-verification)
- [17. Known Limitations](#17-known-limitations)
- [18. How to Verify This Yourself](#18-how-to-verify-this-yourself)

---

## 1. Network Isolation

**Claim:** IronMic makes zero outbound network requests during normal operation.

**Proof:** [`electron-app/src/main/index.ts`](electron-app/src/main/index.ts), lines 46-65.

The function `blockAllNetworkRequests()` intercepts every outbound request at the Electron session level. It uses an explicit **allowlist** — only these URL prefixes are permitted:

| Allowed | Purpose |
|---------|---------|
| `devtools://` | Chrome DevTools (development only) |
| `file://` | Loading local renderer HTML |
| `http://localhost` | Vite dev server (development only) |
| `ws://localhost` | Vite HMR WebSocket (development only) |
| `data:` | Inline data URIs (base64 images, etc.) |
| `chrome-extension://` | Internal Chromium extensions |

**Everything else is blocked and logged:**
```typescript
console.warn(`[security] Blocked network request: ${url}`);
callback({ cancel: true });
```

This function runs at app startup (line 84), before any window is created.

**How to verify:** Open DevTools in the running app. Go to the Network tab. You will see zero outbound requests. Try navigating to any external URL from the console — it will be blocked.

---

## 2. Audio Privacy (Zero-on-Drop)

**Claim:** Mic audio is never written to disk. All audio buffers are explicitly zeroed when they're no longer needed.

**Proof:** Four separate Rust types implement the `Drop` trait with explicit memory zeroing:

### AudioRingBuffer (mic capture)
[`rust-core/src/audio/capture.rs`](rust-core/src/audio/capture.rs), lines 85-92:
```rust
impl Drop for AudioRingBuffer {
    fn drop(&mut self) {
        self.data.fill(0.0);    // Zero all samples
        self.data.clear();       // Release memory
        self.data.shrink_to_fit();
    }
}
```

### CapturedAudio (recorded clip)
[`rust-core/src/audio/capture.rs`](rust-core/src/audio/capture.rs), lines 275-280:
```rust
impl Drop for CapturedAudio {
    fn drop(&mut self) {
        self.samples.fill(0.0);
        self.samples.clear();
    }
}
```

### ProcessedAudio (resampled for Whisper)
[`rust-core/src/audio/processor.rs`](rust-core/src/audio/processor.rs), lines 17-24:
```rust
impl Drop for ProcessedAudio {
    fn drop(&mut self) {
        self.samples.fill(0.0);
        self.samples.clear();
    }
}
```

### SecureAudioBuffer (TTS playback)
[`rust-core/src/tts/playback.rs`](rust-core/src/tts/playback.rs), lines 88-94:
```rust
impl Drop for SecureAudioBuffer {
    fn drop(&mut self) {
        self.data.fill(0.0);
        self.data.clear();
    }
}
```

**How to verify:** Search the Rust codebase for `fs::write`, `File::create`, or any file I/O involving audio data. You will find none. Audio exists only in `Vec<f32>` buffers that are zeroed on drop.

---

## 3. Model Download Security

**Claim:** All model downloads are integrity-verified, HTTPS-only, and domain-restricted.

### 3a. SHA-256 Checksums

**Proof:** [`electron-app/src/shared/constants.ts`](electron-app/src/shared/constants.ts), lines 77-81:

```typescript
export const MODEL_CHECKSUMS: Record<string, string> = {
  whisper: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
  llm:     '3e0039fd0273fcbebb49228943b17831aadd55cbcbf56f0af00499be2040ccf9',
  'tts-model': 'ba4527a874b42b21e35f468c10d326fdff3c7fc8cac1f85e9eb6c0dfc35c334a',
};
```

After download, the file is hashed before being accepted. [`electron-app/src/main/model-downloader.ts`](electron-app/src/main/model-downloader.ts), lines 81-89 (hash function) and lines 193-210 (verification):

```typescript
function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
```

If the hash doesn't match, the file is deleted:
```typescript
if (actualHash !== expectedHash) {
  cleanupTemp(tempPath);
  reject(new Error(`Integrity check failed for ${model}.`));
}
```

### 3b. HTTPS Enforcement

**Proof:** [`electron-app/src/main/model-downloader.ts`](electron-app/src/main/model-downloader.ts), lines 67-78:

```typescript
function validateUrl(url: string): void {
  if (!url.startsWith('https://')) {
    throw new Error(`Insecure download URL rejected (HTTP not allowed): ${url}`);
  }
  // ...domain check...
}
```

HTTP URLs are rejected outright. Every download uses Node.js `https` module exclusively.

### 3c. Domain Restriction

**Proof:** Same file, line 23 and lines 67-78:

```typescript
const ALLOWED_DOMAINS = ['huggingface.co'];
```

Only `huggingface.co` and its subdomains (like `cdn-lfs.huggingface.co`) are accepted. Redirect targets are also validated — a redirect to any non-HuggingFace domain is rejected.

### 3d. Download Timeouts

**Proof:** Same file:
- Overall timeout: 10 minutes (line 28)
- Stall timeout: 60 seconds of no data (implemented in the download function with `setTimeout` reset on each data chunk)
- Temp files cleaned up on timeout or failure

**How to verify:** Change a checksum in `constants.ts` to a wrong value, attempt a download, and confirm it fails with an integrity error.

---

## 4. Model Source Verification

**Claim:** All models come from well-known, trusted open-source repositories.

We download from three HuggingFace repositories. Here is our due diligence on each:

### Whisper large-v3-turbo (Speech Recognition)

| Field | Value |
|-------|-------|
| **Repository** | [`ggerganov/whisper.cpp`](https://huggingface.co/ggerganov/whisper.cpp) |
| **Author** | Georgi Gerganov — creator of [llama.cpp](https://github.com/ggerganov/llama.cpp) and [whisper.cpp](https://github.com/ggerganov/whisper.cpp) |
| **Community likes** | 1,354+ |
| **License** | MIT |
| **Base model** | OpenAI Whisper large-v3-turbo, converted to GGML format |
| **Download URL** | `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin` |
| **Our SHA-256** | `1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69` |
| **File size** | ~1.5 GB |

Georgi Gerganov is the author of the two most widely used C++ inference engines in the world (llama.cpp and whisper.cpp). This repository is the canonical source for GGML-format Whisper models.

### Mistral 7B Instruct Q4_K_M (Text Cleanup)

| Field | Value |
|-------|-------|
| **Repository** | [`TheBloke/Mistral-7B-Instruct-v0.2-GGUF`](https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.2-GGUF) |
| **Author** | TheBloke — the most prolific GGUF quantization contributor on HuggingFace |
| **Downloads** | 59,000+ |
| **Community likes** | 503+ |
| **License** | Apache 2.0 |
| **Base model** | Mistral AI's official Mistral-7B-Instruct-v0.2 |
| **Download URL** | `https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.2-GGUF/resolve/main/mistral-7b-instruct-v0.2.Q4_K_M.gguf` |
| **Our SHA-256** | `3e0039fd0273fcbebb49228943b17831aadd55cbcbf56f0af00499be2040ccf9` |
| **File size** | ~4.4 GB |

TheBloke is the most trusted name in GGUF quantizations, with hundreds of model conversions used across the open-source AI community. The base model comes from Mistral AI, a well-funded French AI company.

### Kokoro 82M v1.0 fp16 (Text-to-Speech)

| Field | Value |
|-------|-------|
| **Repository** | [`onnx-community/Kokoro-82M-v1.0-ONNX`](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) |
| **Author** | onnx-community — official ONNX community organization |
| **Downloads** | 86,800+ |
| **Community likes** | 207+ |
| **License** | Apache 2.0 |
| **Base model** | hexgrad/Kokoro-82M, converted to ONNX format |
| **Download URL** | `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_fp16.onnx` |
| **Our SHA-256** | `ba4527a874b42b21e35f468c10d326fdff3c7fc8cac1f85e9eb6c0dfc35c334a` |
| **File size** | ~163 MB |

The onnx-community organization is the official ONNX-format conversion hub. Kokoro is a well-regarded small TTS model with 15+ English voices.

### Voice Files

We download 15 individual voice files from the same Kokoro repository's `voices/` directory. Each is ~500 KB. These are raw float32 voice embeddings, not executable code.

**How to verify:** Click any repository link above. Check the author, download count, license, and community engagement yourself.

---

## 5. Electron Sandbox & Isolation

**Claim:** The renderer process is sandboxed and isolated from Node.js.

**Proof:** [`electron-app/src/main/index.ts`](electron-app/src/main/index.ts), lines 24-28:

```typescript
webPreferences: {
  preload: path.join(__dirname, '..', 'preload', 'index.js'),
  contextIsolation: true,   // Renderer cannot access preload globals
  nodeIntegration: false,    // No require() or process in renderer
  sandbox: true,             // Chromium sandbox enabled
},
```

| Setting | Value | What it prevents |
|---------|-------|-----------------|
| `contextIsolation` | `true` | Renderer cannot touch the preload scope |
| `nodeIntegration` | `false` | No `require()`, no `process`, no `fs` in renderer |
| `sandbox` | `true` | Renderer runs in Chromium's OS-level sandbox |

The renderer communicates with the main process **exclusively** through the contextBridge preload API. See [`electron-app/src/preload/index.ts`](electron-app/src/preload/index.ts), line 113:

```typescript
contextBridge.exposeInMainWorld('ironmic', api);
```

---

## 6. Content Security Policy

**Claim:** A strict CSP restricts what the renderer can load and execute.

**Proof:** [`electron-app/src/renderer/index.html`](electron-app/src/renderer/index.html), line 6:

```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';" />
```

| Directive | Value | Effect |
|-----------|-------|--------|
| `default-src` | `'self'` | All resources must come from the app itself |
| `script-src` | `'self'` | No inline scripts, no external scripts |
| `style-src` | `'self' 'unsafe-inline'` | Styles from app + inline (required by Tailwind CSS) |

**Note:** `'unsafe-inline'` for styles is a known compromise required by CSS-in-JS frameworks. It does not affect script execution. After removing `rehype-raw` (see section 11), there is no path for injecting executable inline content.

---

## 7. IPC Input Validation

**Claim:** High-risk IPC channels validate their inputs before processing.

**Proof:** [`electron-app/src/main/ipc-handlers.ts`](electron-app/src/main/ipc-handlers.ts), lines 13-36.

Validation constants:
```typescript
const MAX_PROMPT_LENGTH = 100_000;        // 100K char cap on AI prompts
const MAX_SETTING_VALUE_LENGTH = 1_000;    // 1K char cap on setting values
const MAX_AUDIO_BUFFER_SIZE = 100 * 1024 * 1024;  // 100 MB cap on audio
const VALID_PROVIDERS: AIProvider[] = ['copilot', 'claude'];
```

Settings keys are restricted to a known allowlist of 17 keys (lines 21-32).

### Validated Channels

| Channel | Validation | Lines |
|---------|-----------|-------|
| `transcribe` | Buffer type check + 100MB size cap | 45-54 |
| `set-setting` | Key allowlist + 1K value length | 92-100 |
| `download-model` | Model name checked against `MODEL_FILES` | 106-115 |
| `ai:send-message` | Prompt 100K cap + provider enum check | 158-166 |

---

## 8. AI Data Flow & Environment Scoping

**Claim:** When using the AI assistant, only the minimum necessary environment variables are passed to the CLI subprocess. Your other secrets are not leaked.

**Proof:** [`electron-app/src/main/ai/AIManager.ts`](electron-app/src/main/ai/AIManager.ts), lines 112-126:

```typescript
const scopedEnv: Record<string, string> = { TERM: 'dumb' };

// System essentials only
for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TMPDIR',
                    'XDG_DATA_HOME', 'XDG_CONFIG_HOME']) {
  if (process.env[key]) scopedEnv[key] = process.env[key]!;
}

// Provider-specific auth only
if (provider === 'claude' && process.env.ANTHROPIC_API_KEY) {
  scopedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
}
if (provider === 'copilot') {
  if (process.env.GH_TOKEN) scopedEnv.GH_TOKEN = process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) scopedEnv.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
}
```

Variables **NOT passed** to child processes: `AWS_SECRET_ACCESS_KEY`, `DATABASE_URL`, `OPENAI_API_KEY`, `STRIPE_SECRET_KEY`, or any other secret in your shell environment.

---

## 9. Log Redaction

**Claim:** User prompt text is never written to console logs.

**Proof:** [`electron-app/src/main/ai/AIManager.ts`](electron-app/src/main/ai/AIManager.ts), line 103:

```typescript
console.log(`[ai] Sending to ${provider}: ${binary} [${args.length} args, prompt_length=${prompt.length}]`);
```

The log records the **provider name**, **binary path**, **argument count**, and **prompt length** — never the prompt content itself. Stderr from CLIs is only logged in development mode (lines 145-147).

---

## 10. SQL Injection Protection

**Claim:** All database queries use parameterized statements.

**Proof:** [`rust-core/src/storage/entries.rs`](rust-core/src/storage/entries.rs). Every query uses `rusqlite::params![]`:

```rust
// Line 101 — INSERT
rusqlite::params![id, now, now, new.raw_transcript, new.polished_text, ...]

// Line 126 — UPDATE
rusqlite::params![raw, now, id]

// Line 199 — FTS search (properly escaped)
let search_param = format!("{}*", search.replace('"', "\"\""));
```

No user input is ever concatenated into SQL strings. The `rusqlite` crate enforces parameterized queries at the type level.

---

## 11. XSS Prevention

**Claim:** AI responses cannot inject executable HTML into the renderer.

**Proof:** [`electron-app/src/renderer/components/AIChat.tsx`](electron-app/src/renderer/components/AIChat.tsx), lines 8-9:

```typescript
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
```

The `rehype-raw` plugin (which allows raw HTML passthrough) was **removed** as part of security hardening. Only `remark-gfm` is used, which renders standard GitHub-Flavored Markdown (bold, code, tables, lists) without allowing HTML tags.

An AI response containing `<img onerror="alert(1)">` renders as escaped text, not an executable element.

---

## 12. Clipboard Security

**Claim:** Clipboard contents can be automatically cleared after a configurable timeout.

**Proof:** [`electron-app/src/renderer/stores/useRecordingStore.ts`](electron-app/src/renderer/stores/useRecordingStore.ts), lines 76-85:

```typescript
await api.copyToClipboard(finalText);
const autoClear = await api.getSetting('security_clipboard_auto_clear');
if (autoClear && autoClear !== 'off') {
  const seconds = parseInt(autoClear);
  if (seconds > 0) {
    setTimeout(() => api.copyToClipboard('').catch(() => {}), seconds * 1000);
  }
}
```

Available timeouts: 15s, 30s, 60s, 120s, or off. Configurable in Settings > Security.

---

## 13. Session Timeout & Lock

**Claim:** The app can lock after inactivity to protect unattended machines.

**Proof:** [`electron-app/src/renderer/components/SessionLock.tsx`](electron-app/src/renderer/components/SessionLock.tsx), lines 21-45.

Monitored events: `mousemove`, `mousedown`, `keydown`, `touchstart`, `scroll`.

When no activity is detected for the configured duration, a full-screen lock overlay blocks access. The user must click "Resume Session" to continue. Available timeouts: 5m, 15m, 30m, 1hr, or off.

---

## 14. Data Wipe on Exit

**Claim:** AI chat sessions and notes can be wiped when the app closes.

**Proof:** [`electron-app/src/main/index.ts`](electron-app/src/main/index.ts), lines 117-127:

```typescript
app.on('will-quit', () => {
  const clearOnExit = native.getSetting('security_clear_on_exit');
  if (clearOnExit === 'true' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(`
      localStorage.removeItem('ironmic-ai-sessions');
      localStorage.removeItem('ironmic-notes');
      localStorage.removeItem('ironmic-notebooks');
    `);
  }
});
```

When "Clear Sessions on Exit" is enabled in Settings > Security, all AI chat history, notes, and notebooks are permanently deleted from `localStorage` on quit.

---

## 15. Rust Unsafe Code Audit

**Claim:** All `unsafe` blocks are justified and limited to `Send` trait implementations.

IronMic's Rust codebase contains **5 total `unsafe` blocks**. None contain raw pointer operations, FFI calls, or memory manipulation. All are `unsafe impl Send` declarations:

| File | Line | Type | Justification |
|------|------|------|---------------|
| [`audio/capture.rs`](rust-core/src/audio/capture.rs) | 105 | `unsafe impl Send for CaptureEngine` | cpal Stream is !Send but accessed behind Mutex on single thread |
| [`transcription/whisper.rs`](rust-core/src/transcription/whisper.rs) | 148 | `unsafe impl Send for WhisperEngine` | whisper-rs context accessed behind Mutex |
| [`llm/cleanup.rs`](rust-core/src/llm/cleanup.rs) | 64 | `unsafe impl Send for LlmEngine` | llama-cpp model accessed behind Mutex |
| [`tts/kokoro.rs`](rust-core/src/tts/kokoro.rs) | 208 | `unsafe impl Send for KokoroEngine` | ONNX session accessed behind Mutex |
| [`tts/playback.rs`](rust-core/src/tts/playback.rs) | 110 | `unsafe impl Send for PlaybackEngine` | cpal output stream accessed behind Mutex |

**Pattern:** Each engine wraps a non-Send FFI type (cpal stream, whisper context, ONNX session) in a `Mutex`. The `unsafe impl Send` is safe because the Mutex guarantees single-threaded access.

**How to verify:** Run `grep -rn "unsafe" rust-core/src/` — you will find exactly these 5 lines, no others.

---

## 16. No Telemetry Verification

**Claim:** IronMic has zero telemetry, analytics, or crash reporting.

**How to verify:**

1. Search for analytics libraries:
   ```
   grep -r "analytics\|telemetry\|sentry\|amplitude\|mixpanel\|segment\|hotjar\|posthog" electron-app/package.json
   ```
   Result: no matches.

2. Search for tracking code:
   ```
   grep -rn "fetch\|XMLHttpRequest\|navigator.sendBeacon" electron-app/src/renderer/
   ```
   Result: no matches (only `WebFetch` in markdown rendering, which is a React component name, not a network call).

3. Check the network blocker (section 1): even if tracking code existed, all outbound requests are blocked.

---

## 17. Known Limitations

We believe in transparency. Here is what we **don't** currently protect:

| Limitation | Status | Mitigation |
|-----------|--------|------------|
| SQLite database is not encrypted at rest | Planned (SQLCipher) | Use OS-level disk encryption (FileVault/BitLocker) |
| localStorage is not encrypted | Planned | "Clear Sessions on Exit" setting available |
| AI CLI binaries are not signature-verified | Accepted risk | If attacker can modify binaries, machine is already compromised |
| CSP allows `unsafe-inline` styles | Required by Tailwind | Script execution is still `'self'` only |
| ~38 Mutex `.lock().unwrap()` calls in Rust | Planned fix | Poisoned mutex → panic (DoS), not data corruption |

---

## 18. How to Verify This Yourself

### Quick verification (5 minutes)

```bash
# 1. Clone the repo
git clone https://github.com/greenpioneersolutions/IronMic.git && cd IronMic

# 2. Verify no network calls (search for fetch/http in renderer)
grep -rn "fetch\|XMLHttpRequest\|http\." electron-app/src/renderer/ | grep -v node_modules | grep -v ".css"

# 3. Verify audio zeroing
grep -rn "fill(0.0)" rust-core/src/

# 4. Verify SHA-256 checksums exist
grep -n "MODEL_CHECKSUMS" electron-app/src/shared/constants.ts

# 5. Verify sandbox is enabled
grep -n "sandbox" electron-app/src/main/index.ts

# 6. Verify no unsafe memory operations
grep -rn "unsafe" rust-core/src/ | grep -v "unsafe impl Send"

# 7. Count all unsafe blocks
grep -c "unsafe" rust-core/src/**/*.rs
```

### Full verification (hire a professional)

If your organization requires independent security validation, we recommend engaging a third-party security auditor. Provide them with:

1. This document as a starting point
2. Full source code access
3. Our [SECURITY.md](SECURITY.md) for the threat model and security settings reference

We are confident in our codebase and welcome scrutiny.

---

<p align="center">
  <em>IronMic takes your privacy seriously. If you find an issue, please report it responsibly via our <a href="SECURITY.md">security policy</a>.</em>
</p>
