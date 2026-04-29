/**
 * Model downloader — handles downloading Whisper, LLM, and TTS model files.
 * This is the ONLY network code in the entire app, and it only runs
 * when the user explicitly clicks a download button.
 *
 * Models are hosted on GitHub Releases (primary) with HuggingFace fallback.
 * Baseline enterprise models are mirrored and bundled.
 * The LLM model is split into multiple parts (exceeds GitHub 2 GB limit).
 *
 * Security:
 * - SHA-256 integrity verification on all model files
 * - HTTPS enforced, HTTP rejected
 * - Redirect domains validated (GitHub + HuggingFace)
 * - Download and stall timeouts
 * - Multi-part reassembly verified against full-file checksum
 */

import https from 'https';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { BrowserWindow, net, session, dialog } from 'electron';
import { execSync } from 'child_process';
import {
  MODEL_URLS, MODEL_FALLBACK_URLS, MODEL_FILES, MODEL_CHECKSUMS,
  MODEL_PARTS, MODELS_BASE_URL, TTS_VOICE_IDS, TFJS_MODELS,
  TRANSCRIPTION_ENGINES,
} from '../shared/constants';

/**
 * Resolve the models directory.
 * Uses IRONMIC_MODELS_DIR (set by main/index.ts) so Electron and Rust agree
 * on the same path.  Falls back to the dev-time relative path.
 */
function resolveModelsDir(): string {
  if (process.env.IRONMIC_MODELS_DIR) {
    return process.env.IRONMIC_MODELS_DIR;
  }
  return path.join(__dirname, '..', '..', '..', 'rust-core', 'models');
}

// NOTE: Do NOT cache resolveModelsDir() as a top-level const.
// Import hoisting causes this module to load BEFORE index.ts sets
// IRONMIC_MODELS_DIR, so the env var would be undefined and the
// fallback path would point inside the read-only .app bundle.
// Every call site must invoke resolveModelsDir() at runtime.

/** Allowed domains for model downloads and redirects */
const ALLOWED_DOMAINS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'huggingface.co', 'xethub.hf.co'];

/** Overall download timeout: 10 minutes */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** Stall timeout: abort if no data received for 60 seconds */
const STALL_TIMEOUT_MS = 60 * 1000;

/**
 * Resolve the proxy URL from settings, env vars, or system config.
 * Priority: app setting > HTTPS_PROXY env > HTTP_PROXY env > no proxy
 */
function resolveProxyUrl(): string | null {
  // 1. App setting (set in Settings > Security > Proxy)
  try {
    // native-bridge may not be loaded yet at import time, so use require
    const nativeBridge = require('./native-bridge');
    const setting = nativeBridge.native?.getSetting?.('proxy_url');
    const enabled = nativeBridge.native?.getSetting?.('proxy_enabled');
    if (enabled === 'true' && setting && setting.trim()) {
      return setting.trim();
    }
  } catch { /* native not available yet */ }

  // 2. Standard env vars (corporate environments often set these)
  return process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || null;
}

/**
 * Configure Electron's session proxy for net.request calls.
 * Only touches the session when a proxy is explicitly configured by the user
 * or the environment — calling setProxy({mode:'system'}) unconditionally can
 * stall for many seconds on Windows boxes that rely on WPAD auto-detection
 * and have no proxy, which looks to users like the download is broken.
 */
async function applySessionProxy(): Promise<void> {
  const proxyUrl = resolveProxyUrl();
  if (!proxyUrl) return;
  console.log(`[model-downloader] Configuring proxy: ${proxyUrl}`);
  await session.defaultSession.setProxy({ proxyRules: proxyUrl });
}

/** Max retries before trying a configured fallback URL */
const MAX_RETRIES = 3;

function getModelPath(model: string): string {
  const filename = MODEL_FILES[model];
  if (!filename) throw new Error(`Unknown model: ${model}`);
  return path.join(resolveModelsDir(), filename);
}

export function isModelDownloaded(model: string): boolean {
  try {
    return fs.existsSync(getModelPath(model));
  } catch {
    return false;
  }
}

export function getModelsStatus() {
  const result: Record<string, { downloaded: boolean; sizeBytes: number }> = {};
  for (const key of Object.keys(MODEL_FILES)) {
    const p = getModelPath(key);
    const exists = fs.existsSync(p);
    result[key] = {
      downloaded: exists,
      sizeBytes: exists ? fs.statSync(p).size : 0,
    };
  }
  return result;
}

/**
 * Check whether all model files required by a transcription engine are present.
 *
 * Moonshine engines need three files (encoder + decoder + tokenizer); Whisper
 * engines need one. Returns false on the first missing file; the UI can use
 * this to gate the engine selector dropdown ("Download required" badge).
 */
export function isTranscriptionEngineReady(engineId: string): boolean {
  const meta = TRANSCRIPTION_ENGINES.find((e) => e.id === engineId);
  if (!meta) return false;
  return meta.modelFileKeys.every((key) => isModelDownloaded(key));
}

/**
 * Download every file required by a transcription engine, sequentially.
 *
 * For Moonshine variants, this fetches encoder + decoder + tokenizer into
 * `models/<engine-id>/`. Idempotent — already-downloaded files are skipped.
 * Throws on the first failure.
 */
export async function downloadTranscriptionEngine(
  engineId: string,
  window: BrowserWindow | null,
): Promise<void> {
  const meta = TRANSCRIPTION_ENGINES.find((e) => e.id === engineId);
  if (!meta) {
    throw new Error(`Unknown transcription engine: ${engineId}`);
  }
  let anyDownloaded = false;
  for (const key of meta.modelFileKeys) {
    if (isModelDownloaded(key)) {
      console.log(`[model-downloader] ${key} already present, skipping`);
      continue;
    }
    anyDownloaded = true;
    console.log(`[model-downloader] Downloading ${key} for engine '${engineId}'`);
    await downloadModel(key, window);
  }
  console.log(`[model-downloader] Engine '${engineId}' fully downloaded`);
  // If all files were already present (no actual download happened), the
  // per-file progress events were never sent — so send a synthetic 'complete'
  // now so the renderer's progress listener fires and refreshes model state.
  if (!anyDownloaded && window && !window.isDestroyed()) {
    window.webContents.send('ironmic:model-download-progress', {
      model: engineId,
      downloaded: 1,
      total: 1,
      status: 'complete',
      percent: 100,
    });
  }
}

export function isTtsModelReady(): boolean {
  if (!isModelDownloaded('tts-model')) return false;
  const voicesDir = path.join(resolveModelsDir(), 'voices');
  const defaultVoice = path.join(voicesDir, 'af_heart.bin');
  return fs.existsSync(defaultVoice);
}

/**
 * Ensure bundled TTS voices are copied to the models directory.
 * Voices are bundled in the installer at process.resourcesPath/models/voices/.
 * In production, we copy them to userData/models/voices/ on first launch.
 */
export function ensureBundledVoices(): void {
  const destVoicesDir = path.join(resolveModelsDir(), 'voices');
  const defaultVoice = path.join(destVoicesDir, 'af_heart.bin');

  // Already copied
  if (fs.existsSync(defaultVoice)) return;

  // In production, voices are bundled in resources
  if (process.resourcesPath) {
    const bundledDir = path.join(process.resourcesPath, 'models', 'voices');
    if (fs.existsSync(bundledDir)) {
      fs.mkdirSync(destVoicesDir, { recursive: true });
      const files = fs.readdirSync(bundledDir).filter(f => f.endsWith('.bin'));
      for (const file of files) {
        const src = path.join(bundledDir, file);
        const dest = path.join(destVoicesDir, file);
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(src, dest);
        }
      }
      console.log(`[model-downloader] Copied ${files.length} bundled voices`);
    }
  }
}

/**
 * Status returned by {@link ensureBundledMoonshineBase}. The values are
 * stable strings so the main process can log a single line and the UI
 * (renderer) can branch on them later without re-deriving state.
 */
export type MoonshineBundleStatus =
  | 'copied'             // user-data was missing/incomplete; freshly copied from resources
  | 'already-present'    // all 3 files exist in user-data and are non-empty
  | 'incomplete-bundle'  // resources/models/moonshine-base exists but is missing files
  | 'bundle-missing';    // dev mode or unpackaged run — no bundled directory at all

const MOONSHINE_FILES = ['encoder_model.onnx', 'decoder_model_merged.onnx', 'tokenizer.json'];

function allFilesPresent(dir: string): boolean {
  for (const f of MOONSHINE_FILES) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) return false;
    try {
      if (fs.statSync(p).size === 0) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Ensure bundled Moonshine Base ONNX files are copied to the models directory.
 *
 * Moonshine Base is the default transcription engine and ships with the
 * installer (see electron-builder.config.js extraResources). On first launch
 * we copy the three files from process.resourcesPath/models/moonshine-base/
 * to the writable userData models dir so the Rust loader (which reads from
 * IRONMIC_MODELS_DIR) can open them.
 *
 * Idempotent and re-entrant: returns a {@link MoonshineBundleStatus} so the
 * caller can log exactly what happened. Verifies *all three* files are present
 * and non-empty in user data; checking only the decoder sentinel hid partial
 * directories that then failed at engine load time.
 */
export function ensureBundledMoonshineBase(): MoonshineBundleStatus {
  const destDir = path.join(resolveModelsDir(), 'moonshine-base');
  if (allFilesPresent(destDir)) return 'already-present';

  // Dev mode: no resourcesPath, files come from rust-core/models directly.
  if (!process.resourcesPath) return 'bundle-missing';

  const bundledDir = path.join(process.resourcesPath, 'models', 'moonshine-base');
  if (!fs.existsSync(bundledDir)) return 'bundle-missing';
  if (!allFilesPresent(bundledDir)) return 'incomplete-bundle';

  fs.mkdirSync(destDir, { recursive: true });
  let copied = 0;
  for (const file of MOONSHINE_FILES) {
    const src = path.join(bundledDir, file);
    const dest = path.join(destDir, file);
    // Re-copy if missing OR present-but-empty (covers a previous half-write).
    let needsCopy = !fs.existsSync(dest);
    if (!needsCopy) {
      try { needsCopy = fs.statSync(dest).size === 0; } catch { needsCopy = true; }
    }
    if (!needsCopy) continue;
    fs.copyFileSync(src, dest);
    copied += 1;
  }
  if (copied > 0) {
    console.log(`[model-downloader] Copied ${copied} bundled Moonshine Base files to ${destDir}`);
  }
  return 'copied';
}

export type BaselineLlmBundleStatus =
  | 'copied'
  | 'already-present'
  | 'bundle-missing';

/**
 * Ensure bundled Phi-3 Mini is copied to the writable models directory.
 *
 * The baseline enterprise build includes this GGUF in app resources so local
 * cleanup/chat works without HuggingFace or any first-run download.
 */
export function ensureBundledPhi3Mini(): BaselineLlmBundleStatus {
  const rel = MODEL_FILES['llm-chat-phi3'];
  if (!rel) return 'bundle-missing';

  const destPath = path.join(resolveModelsDir(), rel);
  try {
    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
      return 'already-present';
    }
  } catch { /* fall through and try bundled copy */ }

  if (!process.resourcesPath) return 'bundle-missing';

  const bundledPath = path.join(process.resourcesPath, 'models', rel);
  if (!fs.existsSync(bundledPath)) return 'bundle-missing';
  try {
    if (fs.statSync(bundledPath).size === 0) return 'bundle-missing';
  } catch {
    return 'bundle-missing';
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(bundledPath, destPath);
  console.log(`[model-downloader] Copied bundled Phi-3 Mini to ${destPath}`);
  return 'copied';
}

/**
 * True when the packaged app shipped with all 3 Moonshine Base files in
 * `process.resourcesPath/models/moonshine-base/`. False in dev mode and on
 * installers that lost their bundled copy. The renderer uses this to decide
 * whether "Delete" should read "Restore bundled copy" instead.
 */
export function isMoonshineBundleAvailable(): boolean {
  if (!process.resourcesPath) return false;
  const bundledDir = path.join(process.resourcesPath, 'models', 'moonshine-base');
  if (!fs.existsSync(bundledDir)) return false;
  return allFilesPresent(bundledDir);
}

/** Validate a URL is HTTPS and points to an allowed domain */
function validateUrl(url: string): void {
  if (!url.startsWith('https://')) {
    throw new Error(`Insecure download URL rejected (HTTP not allowed): ${url}`);
  }
  const parsed = new URL(url);
  const isAllowed = ALLOWED_DOMAINS.some(
    (d) => parsed.hostname === d || parsed.hostname.endsWith('.' + d)
  );
  if (!isAllowed) {
    throw new Error(`Download from untrusted domain rejected: ${parsed.hostname}`);
  }
}

/** Compute SHA-256 hash of a file */
function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** Cleanup temp file silently */
function cleanupTemp(tempPath: string) {
  try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
}

type ProgressCallback = (downloaded: number, total: number, status: string) => void;

/**
 * Download a single file from a URL to a destination path.
 * Uses Electron's net module which trusts the system certificate store
 * (fixes "self-signed certificate in certificate chain" on corporate networks).
 * Falls back to Node.js https if net module is unavailable (e.g. before app ready).
 * Handles redirects, stall detection, and timeouts.
 */
async function downloadFile(
  url: string,
  destPath: string,
  onProgress?: ProgressCallback,
  bytesOffset = 0,
  totalOverride = 0,
): Promise<void> {
  // Apply proxy configuration before starting download
  try { await applySessionProxy(); } catch (e) {
    console.warn('[model-downloader] Failed to configure proxy:', e);
  }

  const proxyUrl = resolveProxyUrl();

  return new Promise((resolve, reject) => {
    function doRequest(reqUrl: string, redirectCount = 0) {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'));
        return;
      }

      try { validateUrl(reqUrl); } catch (e) { reject(e); return; }

      // Use Electron's net module (trusts system cert store + respects session proxy)
      // Fall back to Node.js https otherwise
      const useElectronNet = net && typeof net.request === 'function';

      if (useElectronNet) {
        const request = net.request({ url: reqUrl, redirect: 'manual' });

        request.on('redirect', (statusCode, _method, redirectUrl) => {
          console.log(`[model-downloader] Redirect (${statusCode}) → ${new URL(redirectUrl).hostname}`);
          try { validateUrl(redirectUrl); } catch (e) { reject(e); return; }
          doRequest(redirectUrl, redirectCount + 1);
        });

        request.on('response', (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`Download failed: HTTP ${res.statusCode}`));
            return;
          }

          const contentLength = parseInt(res.headers['content-length'] as string || '0', 10);
          const totalBytes = totalOverride || (bytesOffset + contentLength);
          let downloadedBytes = bytesOffset;
          const file = fs.createWriteStream(destPath);

          if (onProgress) onProgress(downloadedBytes, totalBytes, 'downloading');

          let stallTimer = setTimeout(() => {
            request.abort();
            cleanupTemp(destPath);
            if (onProgress) onProgress(0, 0, 'error');
            reject(new Error('Download stalled — no data received for 60 seconds'));
          }, STALL_TIMEOUT_MS);

          res.on('data', (chunk: Buffer) => {
            downloadedBytes += chunk.length;
            file.write(chunk);
            clearTimeout(stallTimer);
            stallTimer = setTimeout(() => {
              request.abort();
              cleanupTemp(destPath);
              if (onProgress) onProgress(0, 0, 'error');
              reject(new Error('Download stalled — no data received for 60 seconds'));
            }, STALL_TIMEOUT_MS);
            if (downloadedBytes % (1024 * 1024) < chunk.length) {
              if (onProgress) onProgress(downloadedBytes, totalBytes, 'downloading');
            }
          });

          res.on('end', () => {
            clearTimeout(stallTimer);
            file.end(() => resolve());
          });

          res.on('error', (err: Error) => {
            clearTimeout(stallTimer);
            file.destroy();
            cleanupTemp(destPath);
            if (onProgress) onProgress(0, 0, 'error');
            reject(err);
          });
        });

        request.on('error', (err: Error) => {
          if (onProgress) onProgress(0, 0, 'error');
          reject(err);
        });

        // Overall timeout
        setTimeout(() => {
          request.abort();
          cleanupTemp(destPath);
          if (onProgress) onProgress(0, 0, 'error');
          reject(new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS / 60000} minutes`));
        }, DOWNLOAD_TIMEOUT_MS);

        request.end();
      } else {
        // Fallback: Node.js https (for pre-app-ready or testing)
        // Note: proxy is only supported via Electron's net module (above).
        // The Node.js fallback does not proxy — it's only used pre-app-ready.
        if (proxyUrl) {
          console.warn('[model-downloader] Proxy configured but Node.js fallback does not support it. Use Electron net path.');
        }
        const req = https.get(reqUrl, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const redirectUrl = res.headers.location;
            console.log(`[model-downloader] Redirect → ${new URL(redirectUrl).hostname}`);
            doRequest(redirectUrl, redirectCount + 1);
            return;
          }

          if (res.statusCode !== 200) {
            reject(new Error(`Download failed: HTTP ${res.statusCode}`));
            return;
          }

          const contentLength = parseInt(res.headers['content-length'] || '0', 10);
          const totalBytes = totalOverride || (bytesOffset + contentLength);
          let downloadedBytes = bytesOffset;
          const file = fs.createWriteStream(destPath);

          if (onProgress) onProgress(downloadedBytes, totalBytes, 'downloading');

          let stallTimer = setTimeout(() => {
            req.destroy();
            cleanupTemp(destPath);
            if (onProgress) onProgress(0, 0, 'error');
            reject(new Error('Download stalled — no data received for 60 seconds'));
          }, STALL_TIMEOUT_MS);

          res.on('data', (chunk: Buffer) => {
            downloadedBytes += chunk.length;
            clearTimeout(stallTimer);
            stallTimer = setTimeout(() => {
              req.destroy();
              cleanupTemp(destPath);
              if (onProgress) onProgress(0, 0, 'error');
              reject(new Error('Download stalled — no data received for 60 seconds'));
            }, STALL_TIMEOUT_MS);
            if (downloadedBytes % (1024 * 1024) < chunk.length) {
              if (onProgress) onProgress(downloadedBytes, totalBytes, 'downloading');
            }
          });

          res.pipe(file);

          file.on('finish', () => {
            clearTimeout(stallTimer);
            file.close(() => resolve());
          });

          file.on('error', (err) => {
            clearTimeout(stallTimer);
            cleanupTemp(destPath);
            if (onProgress) onProgress(0, 0, 'error');
            reject(err);
          });
        });

        req.on('error', (err) => {
          if (onProgress) onProgress(0, 0, 'error');
          reject(err);
        });

        req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
          req.destroy();
          cleanupTemp(destPath);
          if (onProgress) onProgress(0, 0, 'error');
          reject(new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS / 60000} minutes`));
        });
      }
    }

    doRequest(url);
  });
}

/**
 * Download a single file with retry + optional fallback.
 */
async function downloadWithFallback(
  url: string,
  fallbackUrl: string | undefined,
  destPath: string,
  onProgress?: ProgressCallback,
  bytesOffset = 0,
  totalOverride = 0,
): Promise<{ usedFallback: boolean }> {
  let primaryError: string = '';
  let fallbackError: string = '';

  // Try primary URL up to MAX_RETRIES times
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await downloadFile(url, destPath, onProgress, bytesOffset, totalOverride);
      return { usedFallback: false };
    } catch (err: any) {
      primaryError = err.message || 'Unknown error';
      console.warn(`[model-downloader] Primary attempt ${attempt}/${MAX_RETRIES} failed: ${primaryError}`);
    }
  }

  // Try fallback if available
  if (fallbackUrl) {
    console.log(`[model-downloader] Trying fallback source...`);
    if (onProgress) onProgress(0, 0, 'fallback');
    try {
      await downloadFile(fallbackUrl, destPath, onProgress, bytesOffset, totalOverride);
      return { usedFallback: true };
    } catch (err: any) {
      fallbackError = err.message || 'Unknown error';
      console.error(`[model-downloader] Fallback also failed: ${fallbackError}`);
    }
  }

  // Both failed — build a detailed error message with URLs tried
  const lines = [`Primary: ${url}`, `  Error: ${primaryError}`];
  if (fallbackUrl) {
    lines.push(`Fallback: ${fallbackUrl}`, `  Error: ${fallbackError}`);
  } else {
    lines.push('No fallback URL configured.');
  }
  throw new Error(`Download failed.\n${lines.join('\n')}`);
}

/**
 * Concatenate multiple part files into a single file via streaming.
 */
async function concatenateParts(partPaths: string[], destPath: string): Promise<void> {
  const writeStream = fs.createWriteStream(destPath);
  for (const partPath of partPaths) {
    await new Promise<void>((resolve, reject) => {
      const readStream = fs.createReadStream(partPath);
      readStream.pipe(writeStream, { end: false });
      readStream.on('end', resolve);
      readStream.on('error', reject);
    });
  }
  writeStream.end();
  await new Promise<void>((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });
}

/**
 * Download a multi-part model (e.g., LLM split into chunks).
 * Downloads each part, concatenates, verifies SHA-256, cleans up parts.
 */
async function downloadMultiPartModel(
  model: string,
  window: BrowserWindow | null,
): Promise<void> {
  const parts = MODEL_PARTS[model];
  const destPath = getModelPath(model);
  const expectedHash = MODEL_CHECKSUMS[model];

  fs.mkdirSync(resolveModelsDir(), { recursive: true });

  // Calculate total expected size from all parts for progress
  // We estimate based on the known model size
  const partPaths: string[] = [];
  let downloadedTotal = 0;
  const estimatedTotals: Record<string, number> = {
    llm: 4_400_000_000,
    'llm-chat-llama3': 4_700_000_000,
    'llm-chat-phi3': 2_200_000_000,
  };
  const estimatedTotal = estimatedTotals[model] || 4_400_000_000;

  function sendProgress(downloaded: number, total: number, status: string, errorDetail?: string) {
    if (window && !window.isDestroyed()) {
      window.webContents.send('ironmic:model-download-progress', {
        model,
        downloaded,
        total,
        status,
        percent: total > 0 ? Math.round((downloaded / total) * 100) : 0,
        errorDetail: errorDetail || undefined,
      });
    }
  }

  console.log(`[model-downloader] Starting multi-part download: ${model} (${parts.length} parts)`);
  sendProgress(0, estimatedTotal, 'downloading');

  // Download each part
  for (let i = 0; i < parts.length; i++) {
    const partFilename = parts[i];
    const partUrl = `${MODELS_BASE_URL}/${partFilename}`;
    const partPath = path.join(resolveModelsDir(), partFilename);
    partPaths.push(partPath);

    const partProgress: ProgressCallback = (downloaded, total, status) => {
      if (status === 'downloading') {
        sendProgress(downloadedTotal + (downloaded - downloadedTotal), estimatedTotal, 'downloading');
      }
    };

    // No fallback for individual parts — if configured, fallback is for the
    // whole model rather than one shard.
    try {
      await downloadFile(partUrl, partPath, partProgress);
      const partSize = fs.statSync(partPath).size;
      downloadedTotal += partSize;
      sendProgress(downloadedTotal, estimatedTotal, 'downloading');
      console.log(`[model-downloader] Part ${i + 1}/${parts.length} complete (${partFilename})`);
    } catch (err: any) {
      const partError = err.message || 'Unknown error';
      // Clean up any downloaded parts
      for (const p of partPaths) { cleanupTemp(p); }

      // Try configured fallback for the whole file
      const fallbackUrl = MODEL_FALLBACK_URLS[model];
      if (fallbackUrl) {
        console.log(`[model-downloader] Part download failed, trying fallback for full file...`);
        sendProgress(0, 0, 'fallback');
        const tempPath = destPath + '.downloading';
        try {
          await downloadFile(fallbackUrl, tempPath, (d, t, s) => sendProgress(d, t, s));
        } catch (fbErr: any) {
          cleanupTemp(tempPath);
          throw new Error(
            `Download failed.\nPrimary: ${partUrl}\n  Error: ${partError}\nFallback: ${fallbackUrl}\n  Error: ${fbErr.message || 'Unknown error'}`
          );
        }

        // Verify
        if (expectedHash) {
          const actualHash = await hashFile(tempPath);
          if (actualHash !== expectedHash) {
            cleanupTemp(tempPath);
            throw new Error(`Integrity check failed for ${model} (fallback).`);
          }
        }
        fs.renameSync(tempPath, destPath);
        sendProgress(estimatedTotal, estimatedTotal, 'complete');
        console.log(`[model-downloader] Download complete via fallback: ${model}`);
        return;
      }
      throw new Error(
        `Download failed.\nPrimary: ${partUrl}\n  Error: ${partError}\nNo fallback URL configured.`
      );
    }
  }

  // Concatenate parts into final file
  console.log(`[model-downloader] Concatenating ${parts.length} parts...`);
  sendProgress(downloadedTotal, estimatedTotal, 'verifying');

  const tempPath = destPath + '.assembling';
  await concatenateParts(partPaths, tempPath);

  // Verify integrity of the assembled file
  if (expectedHash) {
    const actualHash = await hashFile(tempPath);
    if (actualHash !== expectedHash) {
      cleanupTemp(tempPath);
      for (const p of partPaths) { cleanupTemp(p); }
      sendProgress(0, 0, 'error');
      throw new Error(
        `Integrity check failed for ${model}. Expected SHA-256: ${expectedHash.slice(0, 16)}..., got: ${actualHash.slice(0, 16)}...`
      );
    }
    console.log(`[model-downloader] SHA-256 verified: ${model}`);
  }

  // Move assembled file to final location and clean up parts
  fs.renameSync(tempPath, destPath);
  for (const p of partPaths) { cleanupTemp(p); }

  sendProgress(estimatedTotal, estimatedTotal, 'complete');
  console.log(`[model-downloader] Multi-part download complete: ${model}`);
}

/**
 * Download a model file with integrity verification.
 * Routes multi-part models to the split-file downloader.
 */
export async function downloadModel(
  model: string,
  window: BrowserWindow | null,
): Promise<void> {
  function sendProgress(downloaded: number, total: number, status: string, errorDetail?: string) {
    if (window && !window.isDestroyed()) {
      window.webContents.send('ironmic:model-download-progress', {
        model,
        downloaded,
        total,
        status,
        percent: total > 0 ? Math.round((downloaded / total) * 100) : 0,
        errorDetail: errorDetail || undefined,
      });
    }
  }

  try {
    // Multi-part model (e.g., LLM)
    if (MODEL_PARTS[model]) {
      return await downloadMultiPartModel(model, window);
    }

    // Single-file model
    const url = MODEL_URLS[model];
    if (!url) {
      throw new Error(`Unknown model: ${model}`);
    }

    const destPath = getModelPath(model);
    const tempPath = destPath + '.downloading';
    const expectedHash = MODEL_CHECKSUMS[model];
    const fallbackUrl = MODEL_FALLBACK_URLS[model];

    // Ensure both the models root and the *parent dir of destPath* exist.
    // The latter matters for models like Moonshine that live in a
    // subdirectory (e.g. `moonshine-base/encoder_model.onnx`) — without
    // this, createWriteStream throws ENOENT on the missing subdir.
    fs.mkdirSync(resolveModelsDir(), { recursive: true });
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    console.log(`[model-downloader] Starting download: ${model}`);
    console.log(`[model-downloader] Destination: ${destPath}`);
    if (expectedHash) console.log(`[model-downloader] Expected SHA-256: ${expectedHash.slice(0, 16)}...`);

    const { usedFallback } = await downloadWithFallback(
      url, fallbackUrl, tempPath, sendProgress,
    );

    if (usedFallback) {
      console.log(`[model-downloader] Downloaded ${model} from fallback source`);
    }

    // Verify integrity
    if (expectedHash) {
      const actualHash = await hashFile(tempPath);
      if (actualHash !== expectedHash) {
        cleanupTemp(tempPath);
        throw new Error(
          `Integrity check failed for ${model}.\nExpected: ${expectedHash.slice(0, 16)}...\nGot: ${actualHash.slice(0, 16)}...`
        );
      }
      console.log(`[model-downloader] SHA-256 verified: ${model}`);
    }

    fs.renameSync(tempPath, destPath);
    sendProgress(0, 0, 'complete');
    console.log(`[model-downloader] Download complete: ${model}`);
  } catch (err: any) {
    // Always send the full error through the progress event so the UI can display it
    const errorMsg = err.message || 'Download failed';
    sendProgress(0, 0, 'error', errorMsg);
    throw err;
  }
}

/**
 * Download TTS model (ONNX). Voices are bundled in the installer.
 */
export async function downloadTtsModel(window: BrowserWindow | null): Promise<void> {
  // Ensure bundled voices are in place
  ensureBundledVoices();

  // Download the ONNX model if not present
  if (!isModelDownloaded('tts-model')) {
    await downloadModel('tts-model', window);
  } else {
    // Already downloaded, signal complete
    if (window && !window.isDestroyed()) {
      window.webContents.send('ironmic:model-download-progress', {
        model: 'tts-model', downloaded: 1, total: 1, status: 'complete', percent: 100,
      });
    }
  }
}

// ── TF.js ML Model Management ──

/**
 * Check if a TF.js model is downloaded and extracted.
 * TF.js models live in MODELS_DIR/tfjs/<dirName>/model.json.
 */
export function isTFJSModelReady(modelId: string): boolean {
  const meta = TFJS_MODELS.find(m => m.id === modelId);
  if (!meta) return false;
  const modelJson = path.join(resolveModelsDir(), 'tfjs', meta.dirName, 'model.json');
  return fs.existsSync(modelJson);
}

/**
 * Get status of all TF.js models.
 */
export function getTFJSModelsStatus(): Record<string, { downloaded: boolean; dirName: string }> {
  const result: Record<string, { downloaded: boolean; dirName: string }> = {};
  for (const meta of TFJS_MODELS) {
    result[meta.id] = {
      downloaded: isTFJSModelReady(meta.id),
      dirName: meta.dirName,
    };
  }
  return result;
}

/**
 * Download a TF.js model (tar.gz) and extract it to tfjs/<dirName>/.
 */
export async function downloadTFJSModel(
  modelId: string,
  window: BrowserWindow | null,
): Promise<void> {
  const meta = TFJS_MODELS.find(m => m.id === modelId);
  if (!meta) throw new Error(`Unknown TF.js model: ${modelId}`);

  if (isTFJSModelReady(modelId)) {
    if (window && !window.isDestroyed()) {
      window.webContents.send('ironmic:model-download-progress', {
        model: modelId, downloaded: 1, total: 1, status: 'complete', percent: 100,
      });
    }
    return;
  }

  // Download the tar.gz
  await downloadModel(modelId, window);

  // Extract to tfjs/<dirName>/
  const tarPath = getModelPath(modelId);
  const extractDir = path.join(resolveModelsDir(), 'tfjs', meta.dirName);

  fs.mkdirSync(extractDir, { recursive: true });

  try {
    execSync(`tar xzf "${tarPath}" -C "${extractDir}"`, { timeout: 30000 });
    console.log(`[model-downloader] Extracted TF.js model to ${extractDir}`);
  } catch (err: any) {
    // Clean up partial extraction
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error(`Failed to extract TF.js model ${modelId}: ${err.message}`);
  }

  // Verify model.json exists after extraction
  const modelJson = path.join(extractDir, 'model.json');
  if (!fs.existsSync(modelJson)) {
    throw new Error(`TF.js model ${modelId} extracted but model.json not found`);
  }
}

/**
 * Ensure all bundled TF.js models are extracted from the installer resources.
 * Similar to ensureBundledVoices() — copies from resourcesPath on first launch.
 */
export function ensureBundledTFJSModels(): void {
  if (!process.resourcesPath) return;

  const bundledDir = path.join(process.resourcesPath, 'ml-models');
  if (!fs.existsSync(bundledDir)) return;

  const destTfjsDir = path.join(resolveModelsDir(), 'tfjs');
  fs.mkdirSync(destTfjsDir, { recursive: true });

  for (const meta of TFJS_MODELS) {
    const destModelDir = path.join(destTfjsDir, meta.dirName);
    const destModelJson = path.join(destModelDir, 'model.json');

    // Skip if already extracted
    if (fs.existsSync(destModelJson)) continue;

    // Check if bundled tar.gz exists
    const bundledTar = path.join(bundledDir, `${meta.id}.tar.gz`);
    if (fs.existsSync(bundledTar)) {
      fs.mkdirSync(destModelDir, { recursive: true });
      try {
        execSync(`tar xzf "${bundledTar}" -C "${destModelDir}"`, { timeout: 30000 });
        console.log(`[model-downloader] Extracted bundled TF.js model: ${meta.id}`);
      } catch (err) {
        console.warn(`[model-downloader] Failed to extract bundled ${meta.id}:`, err);
      }
    }

    // Also check for pre-extracted directory in resources
    const bundledExtracted = path.join(bundledDir, meta.dirName);
    if (fs.existsSync(bundledExtracted) && !fs.existsSync(destModelJson)) {
      fs.mkdirSync(destModelDir, { recursive: true });
      const files = fs.readdirSync(bundledExtracted);
      for (const file of files) {
        fs.copyFileSync(path.join(bundledExtracted, file), path.join(destModelDir, file));
      }
      console.log(`[model-downloader] Copied bundled TF.js model: ${meta.id} (${files.length} files)`);
    }
  }
}

// ── Manual Model Import ──

/** Map of accepted filenames → model IDs for import validation */
/**
 * Known importable model files.
 * Download URLs default to GitHub Releases (same as auto-download primary).
 * For multi-part models, parts[] points to GitHub Release shards.
 */
const IMPORTABLE_FILES: Record<string, { modelId: string; label: string; downloadUrl: string }> = {
  // Whisper — single files on GitHub Releases
  'whisper-large-v3-turbo.bin': { modelId: 'whisper', label: 'Whisper Large V3 Turbo', downloadUrl: `${MODELS_BASE_URL}/whisper-large-v3-turbo.bin` },
  'ggml-large-v3-turbo.bin': { modelId: 'whisper', label: 'Whisper Large V3 Turbo', downloadUrl: `${MODELS_BASE_URL}/whisper-large-v3-turbo.bin` },
  'ggml-medium.bin': { modelId: 'whisper-medium', label: 'Whisper Medium', downloadUrl: `${MODELS_BASE_URL}/ggml-medium.bin` },
  'ggml-small.bin': { modelId: 'whisper-small', label: 'Whisper Small', downloadUrl: `${MODELS_BASE_URL}/ggml-small.bin` },
  'ggml-base.bin': { modelId: 'whisper-base', label: 'Whisper Base', downloadUrl: `${MODELS_BASE_URL}/ggml-base.bin` },
  // LLM — multi-part on GitHub Releases. Single-file imports are still accepted
  // if the user obtains a complete GGUF through an approved mirror.
  'mistral-7b-instruct-v0.2.Q4_K_M.gguf': { modelId: 'llm', label: 'Mistral 7B Instruct Q4', downloadUrl: 'https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.2-GGUF/resolve/main/mistral-7b-instruct-v0.2.Q4_K_M.gguf' },
  'mistral-7b-instruct-q4_k_m.gguf': { modelId: 'llm', label: 'Mistral 7B Instruct Q4', downloadUrl: 'https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.2-GGUF/resolve/main/mistral-7b-instruct-v0.2.Q4_K_M.gguf' },
  'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf': { modelId: 'llm-chat-llama3', label: 'Llama 3.1 8B Instruct', downloadUrl: 'https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf' },
  'Phi-3-mini-4k-instruct-q4.gguf': { modelId: 'llm-chat-phi3', label: 'Phi-3 Mini', downloadUrl: 'https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf' },
  // TTS — single file on GitHub Releases
  'kokoro-v1.0-fp16.onnx': { modelId: 'tts-model', label: 'Kokoro 82M TTS', downloadUrl: `${MODELS_BASE_URL}/kokoro-v1.0-fp16.onnx` },
  'model_fp16.onnx': { modelId: 'tts-model', label: 'Kokoro 82M TTS', downloadUrl: `${MODELS_BASE_URL}/kokoro-v1.0-fp16.onnx` },
};

/** Info returned to the UI about importable models */
interface ImportableModelInfo {
  modelId: string;
  label: string;
  filename: string;
  downloadUrl: string;
  downloaded: boolean;
  /** If the model is multi-part on GitHub, these are the individual part URLs */
  parts?: { filename: string; url: string }[];
  /**
   * Marks Moonshine engines, which import as a *set* of 3 files (encoder +
   * decoder + tokenizer) rather than a single file or numeric .partN chunks.
   * The renderer routes these to importMoonshineEngine() instead of the
   * generic single/multi-part import.
   */
  isMoonshine?: boolean;
}

/** Get the list of importable models with their download URLs (for UI display) */
export function getImportableModels(): ImportableModelInfo[] {
  const seen = new Set<string>();
  const result: ImportableModelInfo[] = [];

  for (const [filename, info] of Object.entries(IMPORTABLE_FILES)) {
    if (seen.has(info.modelId)) continue;
    seen.add(info.modelId);

    const expectedFile = MODEL_FILES[info.modelId];
    const downloaded = expectedFile
      ? fs.existsSync(path.join(resolveModelsDir(), expectedFile))
      : false;

    // Check if this model has parts on GitHub Releases
    const modelParts = MODEL_PARTS[info.modelId];
    let parts: { filename: string; url: string }[] | undefined;
    if (modelParts) {
      parts = modelParts.map(partFilename => ({
        filename: partFilename,
        url: `${MODELS_BASE_URL}/${partFilename}`,
      }));
    }

    result.push({
      modelId: info.modelId,
      label: info.label,
      filename: expectedFile || filename,
      downloadUrl: info.downloadUrl,
      downloaded,
      parts,
    });
  }

  // Moonshine engines aren't in IMPORTABLE_FILES because each engine ships as
  // 3 separate files (encoder + decoder + tokenizer). Surface them here with
  // parts[] populated so the UI can render the 3 download links and route to
  // the dedicated importMoonshineEngine() handler.
  for (const meta of TRANSCRIPTION_ENGINES) {
    if (meta.family !== 'moonshine') continue;
    const downloaded = isTranscriptionEngineReady(meta.id);
    const parts = meta.modelFileKeys.map((key) => ({
      filename: MODEL_FILES[key] ?? key,
      url: MODEL_URLS[key] ?? '',
    }));
    result.push({
      modelId: meta.id,
      label: meta.label,
      filename: `${meta.id}/ (3 files)`,
      downloadUrl: '',
      downloaded,
      parts,
      isMoonshine: true,
    });
  }

  return result;
}

/**
 * Import a model file from a user-selected path.
 * Opens a file dialog, validates the file, copies it to the models directory.
 * Returns the model ID and label if successful, null if cancelled.
 */
export async function importModelFile(
  window: BrowserWindow | null,
): Promise<{ modelId: string; label: string } | null> {
  const dialogWindow = window || BrowserWindow.getFocusedWindow();

  const result = await dialog.showOpenDialog(dialogWindow!, {
    title: 'Import Model File',
    message: 'Select a model file (.bin, .gguf, .onnx) from your browser, release asset, or company mirror',
    filters: [
      { name: 'Model Files', extensions: ['bin', 'gguf', 'onnx'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const sourcePath = result.filePaths[0];
  const sourceFilename = path.basename(sourcePath);

  // Try to match the filename to a known model
  const match = IMPORTABLE_FILES[sourceFilename];
  if (!match) {
    // Try fuzzy matching — check if filename contains a known pattern
    let fuzzyMatch: { modelId: string; label: string; downloadUrl: string } | null = null;
    for (const [knownFile, info] of Object.entries(IMPORTABLE_FILES)) {
      if (sourceFilename.toLowerCase().includes(knownFile.toLowerCase().replace(/\.[^.]+$/, ''))) {
        fuzzyMatch = info;
        break;
      }
    }
    if (!fuzzyMatch) {
      throw new Error(
        `Unrecognized model file: ${sourceFilename}\n\nExpected one of:\n${Object.keys(IMPORTABLE_FILES).filter((_, i, arr) => i === arr.indexOf(arr[i])).join('\n')}`
      );
    }
    // Use fuzzy match
    return await copyModelFile(sourcePath, fuzzyMatch.modelId, fuzzyMatch.label);
  }

  return await copyModelFile(sourcePath, match.modelId, match.label);
}

async function copyModelFile(
  sourcePath: string,
  modelId: string,
  label: string,
): Promise<{ modelId: string; label: string }> {
  const destFilename = MODEL_FILES[modelId];
  if (!destFilename) {
    throw new Error(`No destination filename configured for model: ${modelId}`);
  }

  const modelsDir = resolveModelsDir();
  fs.mkdirSync(modelsDir, { recursive: true });

  const destPath = path.join(modelsDir, destFilename);

  // Verify the source file exists and has reasonable size
  const stats = fs.statSync(sourcePath);
  if (stats.size < 1024) {
    throw new Error(`File is too small (${stats.size} bytes) — this doesn't look like a valid model file.`);
  }

  // Copy the file (streaming to handle large files)
  console.log(`[model-import] Copying ${label} (${(stats.size / 1048576).toFixed(0)} MB) to ${destPath}`);
  await new Promise<void>((resolve, reject) => {
    const readStream = fs.createReadStream(sourcePath);
    const writeStream = fs.createWriteStream(destPath);
    readStream.pipe(writeStream);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
    readStream.on('error', reject);
  });

  console.log(`[model-import] Successfully imported: ${label}`);
  return { modelId, label };
}

/**
 * Import a multi-part model from user-selected files.
 * Opens a file dialog allowing multiple file selection. Sorts the parts
 * by their .partN suffix, concatenates them in order, and copies the
 * assembled file to the models directory.
 *
 * Works with any part naming scheme: .part0/.part1/.part2, .partaa/.partab, etc.
 * Falls back to alphabetical sort if no numeric suffix is found.
 */
export async function importMultiPartModel(
  window: BrowserWindow | null,
): Promise<{ modelId: string; label: string; partCount: number } | null> {
  const dialogWindow = window || BrowserWindow.getFocusedWindow();

  const result = await dialog.showOpenDialog(dialogWindow!, {
    title: 'Import Multi-Part Model',
    message: 'Select ALL part files for the model (e.g. model.gguf.part0, model.gguf.part1, model.gguf.part2)',
    filters: [
      { name: 'Model Part Files', extensions: ['part0', 'part1', 'part2', 'part3', 'part4', 'part5', 'part6', 'part7', 'part8', 'part9'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile', 'multiSelections'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const filePaths = result.filePaths;

  if (filePaths.length === 1) {
    throw new Error(
      `Only 1 file selected. Multi-part import requires all parts.\n\n` +
      `If you have a single complete model file, use "Choose File & Import" instead.`
    );
  }

  // Sort by part number: extract .partN suffix, sort numerically
  const sorted = [...filePaths].sort((a, b) => {
    const numA = extractPartNumber(a);
    const numB = extractPartNumber(b);
    if (numA !== null && numB !== null) return numA - numB;
    return a.localeCompare(b);
  });

  // Derive the base model filename by stripping the .partN suffix from the first file
  const firstName = path.basename(sorted[0]);
  const baseFilename = firstName.replace(/\.part\d+$/, '');

  if (!baseFilename || baseFilename === firstName) {
    throw new Error(
      `Could not determine model name from: ${firstName}\n\n` +
      `Expected files named like: model.gguf.part0, model.gguf.part1, ...`
    );
  }

  // Try to match to a known model
  const match = IMPORTABLE_FILES[baseFilename];
  let modelId: string;
  let label: string;

  if (match) {
    modelId = match.modelId;
    label = match.label;
  } else {
    // Try fuzzy matching
    let fuzzyMatch: { modelId: string; label: string } | null = null;
    for (const [knownFile, info] of Object.entries(IMPORTABLE_FILES)) {
      if (baseFilename.toLowerCase().includes(knownFile.toLowerCase().replace(/\.[^.]+$/, ''))) {
        fuzzyMatch = info;
        break;
      }
    }
    if (fuzzyMatch) {
      modelId = fuzzyMatch.modelId;
      label = fuzzyMatch.label;
    } else {
      // Unknown model — use the filename
      const ext = path.extname(baseFilename).toLowerCase();
      modelId = ext === '.bin' ? 'whisper' : ext === '.onnx' ? 'tts-model' : 'llm';
      label = `Custom model (${baseFilename})`;
    }
  }

  // Verify we have the expected number of parts if this is a known multi-part model
  const expectedParts = MODEL_PARTS[modelId];
  if (expectedParts && sorted.length !== expectedParts.length) {
    throw new Error(
      `Expected ${expectedParts.length} parts for ${label}, but you selected ${sorted.length} files.\n\n` +
      `Required parts:\n${expectedParts.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}`
    );
  }

  // Verify all files exist and have reasonable size
  let totalSize = 0;
  for (const fp of sorted) {
    const stats = fs.statSync(fp);
    if (stats.size < 1024) {
      throw new Error(`Part file too small (${stats.size} bytes): ${path.basename(fp)}`);
    }
    totalSize += stats.size;
  }

  // Determine destination
  const destFilename = MODEL_FILES[modelId] || baseFilename;
  const modelsDir = resolveModelsDir();
  fs.mkdirSync(modelsDir, { recursive: true });
  const destPath = path.join(modelsDir, destFilename);
  const tempPath = destPath + '.assembling';

  // Concatenate parts
  console.log(`[model-import] Assembling ${sorted.length} parts for ${label} (${(totalSize / 1048576).toFixed(0)} MB total)`);
  await concatenateParts(sorted, tempPath);

  // Verify checksum if available
  const expectedHash = MODEL_CHECKSUMS[modelId];
  if (expectedHash) {
    console.log(`[model-import] Verifying SHA-256 for ${label}...`);
    const actualHash = await hashFile(tempPath);
    if (actualHash !== expectedHash) {
      cleanupTemp(tempPath);
      throw new Error(
        `Integrity check failed for ${label}.\n\n` +
        `Expected SHA-256: ${expectedHash.slice(0, 16)}...\n` +
        `Got: ${actualHash.slice(0, 16)}...\n\n` +
        `The parts may be corrupted or in the wrong order. Try downloading them again.`
      );
    }
    console.log(`[model-import] SHA-256 verified: ${label}`);
  }

  // Move to final location
  fs.renameSync(tempPath, destPath);
  console.log(`[model-import] Successfully assembled and imported: ${label} (${sorted.length} parts → ${destFilename})`);

  return { modelId, label, partCount: sorted.length };
}

/** Extract the numeric part number from a filename like "model.gguf.part2" → 2 */
function extractPartNumber(filePath: string): number | null {
  const match = path.basename(filePath).match(/\.part(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Import a model from a known file path, targeted to a specific section.
 * The section hint helps validate the file is going to the right place.
 */
export async function importModelFromPath(
  filePath: string,
  sectionFilter: string,
): Promise<{ modelId: string; label: string }> {
  const sourceFilename = path.basename(filePath);

  // Try to match the filename to a known model
  const match = IMPORTABLE_FILES[sourceFilename];
  if (match) {
    return await copyModelFile(filePath, match.modelId, match.label);
  }

  // Try fuzzy matching
  let fuzzyMatch: { modelId: string; label: string; downloadUrl: string } | null = null;
  for (const [knownFile, info] of Object.entries(IMPORTABLE_FILES)) {
    if (sourceFilename.toLowerCase().includes(knownFile.toLowerCase().replace(/\.[^.]+$/, ''))) {
      fuzzyMatch = info;
      break;
    }
  }
  if (fuzzyMatch) {
    return await copyModelFile(filePath, fuzzyMatch.modelId, fuzzyMatch.label);
  }

  // Unrecognized file — infer the model ID from the section filter and file extension
  const ext = path.extname(sourceFilename).toLowerCase();
  let modelId: string;
  let label: string;

  if (sectionFilter === 'whisper' || ext === '.bin') {
    modelId = 'whisper';
    label = `Custom Whisper model (${sourceFilename})`;
  } else if (sectionFilter === 'tts' || ext === '.onnx') {
    modelId = 'tts-model';
    label = `Custom TTS model (${sourceFilename})`;
  } else if (sectionFilter === 'chat') {
    modelId = 'llm-chat-llama3';
    label = `Custom chat model (${sourceFilename})`;
  } else {
    modelId = 'llm';
    label = `Custom LLM model (${sourceFilename})`;
  }

  return await copyModelFile(filePath, modelId, label);
}

/**
 * Import a Moonshine engine (3 files: encoder + decoder + tokenizer).
 *
 * Moonshine ships as a directory of three artifacts that must be co-located.
 * The user downloads them from the release/mirror links shown in the import UI,
 * then picks all three at once in a multi-select dialog. We classify each
 * file by name and copy it to the engine's subdirectory (e.g.
 * `models/moonshine-base/encoder_model.onnx`). The destination filenames are
 * canonicalized so the Rust loader finds them regardless of how the user
 * named the source files.
 *
 * Returns null if the dialog was cancelled. Throws with a clear message if
 * the selection is missing one of the three roles or contains the wrong
 * count.
 */
export async function importMoonshineEngine(
  window: BrowserWindow | null,
  engineId: string,
): Promise<{ modelId: string; label: string; fileCount: number } | null> {
  const meta = TRANSCRIPTION_ENGINES.find((e) => e.id === engineId);
  if (!meta || meta.family !== 'moonshine') {
    throw new Error(`Not a Moonshine engine: ${engineId}`);
  }

  const dialogWindow = window || BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(dialogWindow!, {
    title: `Import ${meta.label}`,
    message:
      'Select all 3 files: the encoder .onnx, the decoder .onnx, and tokenizer.json',
    filters: [
      { name: 'Moonshine files', extensions: ['onnx', 'json'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile', 'multiSelections'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  // Classify each picked file by filename. Encoder/decoder distinction relies
  // on the substring — both end in .onnx, so we can't use extension alone.
  let encoderSrc: string | null = null;
  let decoderSrc: string | null = null;
  let tokenizerSrc: string | null = null;

  for (const p of result.filePaths) {
    const lower = path.basename(p).toLowerCase();
    if (lower.endsWith('.json') && lower.includes('tokenizer')) {
      tokenizerSrc = p;
    } else if (lower.endsWith('.onnx') && lower.includes('encoder')) {
      encoderSrc = p;
    } else if (lower.endsWith('.onnx') && lower.includes('decoder')) {
      decoderSrc = p;
    }
  }

  const missing: string[] = [];
  if (!encoderSrc) missing.push('encoder_model.onnx');
  if (!decoderSrc) missing.push('decoder_model_merged.onnx');
  if (!tokenizerSrc) missing.push('tokenizer.json');
  if (missing.length > 0) {
    throw new Error(
      `Could not identify all 3 Moonshine files in your selection. Missing: ${missing.join(', ')}.\n\n` +
        `File names must contain "encoder", "decoder", or "tokenizer" so we can route each one correctly. ` +
        `Download them from the links in the import section above.`,
    );
  }

  // Final destination paths (canonical names so the Rust loader finds them).
  const modelsDir = resolveModelsDir();
  const engineDir = path.join(modelsDir, engineId);
  fs.mkdirSync(engineDir, { recursive: true });

  const copies: Array<{ src: string; dest: string }> = [
    { src: encoderSrc!, dest: path.join(engineDir, 'encoder_model.onnx') },
    { src: decoderSrc!, dest: path.join(engineDir, 'decoder_model_merged.onnx') },
    { src: tokenizerSrc!, dest: path.join(engineDir, 'tokenizer.json') },
  ];

  for (const { src, dest } of copies) {
    const stats = fs.statSync(src);
    if (stats.size < 256) {
      throw new Error(`File ${path.basename(src)} is too small (${stats.size} bytes) — likely truncated.`);
    }
    await new Promise<void>((resolve, reject) => {
      const rs = fs.createReadStream(src);
      const ws = fs.createWriteStream(dest);
      rs.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
      rs.on('error', reject);
    });
    console.log(`[model-import] Moonshine: copied ${path.basename(src)} → ${dest}`);
  }

  console.log(`[model-import] Successfully imported ${meta.label} (${copies.length} files)`);
  return { modelId: engineId, label: meta.label, fileCount: copies.length };
}
