/**
 * Model downloader — handles downloading Whisper, LLM, and TTS model files.
 * This is the ONLY network code in the entire app, and it only runs
 * when the user explicitly clicks a download button.
 *
 * Models are hosted on GitHub Releases (primary) with HuggingFace fallback.
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
import { BrowserWindow } from 'electron';
import { execSync } from 'child_process';
import {
  MODEL_URLS, MODEL_FALLBACK_URLS, MODEL_FILES, MODEL_CHECKSUMS,
  MODEL_PARTS, MODELS_BASE_URL, TTS_VOICE_IDS, TFJS_MODELS,
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
const ALLOWED_DOMAINS = ['github.com', 'objects.githubusercontent.com', 'huggingface.co', 'xethub.hf.co'];

/** Overall download timeout: 10 minutes */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** Stall timeout: abort if no data received for 60 seconds */
const STALL_TIMEOUT_MS = 60 * 1000;

/** Max retries before falling back to HuggingFace */
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
 * Handles redirects, stall detection, and timeouts.
 */
function downloadFile(
  url: string,
  destPath: string,
  onProgress?: ProgressCallback,
  bytesOffset = 0,
  totalOverride = 0,
): Promise<void> {
  return new Promise((resolve, reject) => {
    function doRequest(reqUrl: string, redirectCount = 0) {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'));
        return;
      }

      try { validateUrl(reqUrl); } catch (e) { reject(e); return; }

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

    doRequest(url);
  });
}

/**
 * Download a single file with retry + HuggingFace fallback.
 */
async function downloadWithFallback(
  url: string,
  fallbackUrl: string | undefined,
  destPath: string,
  onProgress?: ProgressCallback,
  bytesOffset = 0,
  totalOverride = 0,
): Promise<{ usedFallback: boolean }> {
  let lastError: Error | null = null;

  // Try primary URL up to MAX_RETRIES times
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await downloadFile(url, destPath, onProgress, bytesOffset, totalOverride);
      return { usedFallback: false };
    } catch (err: any) {
      lastError = err;
      console.warn(`[model-downloader] Primary download attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
    }
  }

  // Try fallback if available
  if (fallbackUrl) {
    console.log(`[model-downloader] Trying fallback source (HuggingFace)...`);
    if (onProgress) onProgress(0, 0, 'fallback');
    try {
      await downloadFile(fallbackUrl, destPath, onProgress, bytesOffset, totalOverride);
      return { usedFallback: true };
    } catch (err: any) {
      console.error(`[model-downloader] Fallback also failed: ${err.message}`);
      throw new Error(`Download failed from all sources. Last error: ${err.message}`);
    }
  }

  throw lastError || new Error('Download failed');
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
  // Rough estimate: use known size from constants or 0
  const estimatedTotal = 4_400_000_000; // ~4.4 GB for LLM

  function sendProgress(downloaded: number, total: number, status: string) {
    if (window && !window.isDestroyed()) {
      window.webContents.send('ironmic:model-download-progress', {
        model,
        downloaded,
        total,
        status,
        percent: total > 0 ? Math.round((downloaded / total) * 100) : 0,
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

    // No fallback for individual parts — fallback is for the whole model
    // (HuggingFace has the full file, not parts)
    try {
      await downloadFile(partUrl, partPath, partProgress);
      const partSize = fs.statSync(partPath).size;
      downloadedTotal += partSize;
      sendProgress(downloadedTotal, estimatedTotal, 'downloading');
      console.log(`[model-downloader] Part ${i + 1}/${parts.length} complete (${partFilename})`);
    } catch (err: any) {
      // Clean up any downloaded parts
      for (const p of partPaths) { cleanupTemp(p); }

      // Try HuggingFace fallback for the whole file
      const fallbackUrl = MODEL_FALLBACK_URLS[model];
      if (fallbackUrl) {
        console.log(`[model-downloader] Part download failed, trying HuggingFace fallback for full file...`);
        sendProgress(0, 0, 'fallback');
        const tempPath = destPath + '.downloading';
        await downloadFile(fallbackUrl, tempPath, (d, t, s) => sendProgress(d, t, s));

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
      throw err;
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
  // Multi-part model (e.g., LLM)
  if (MODEL_PARTS[model]) {
    return downloadMultiPartModel(model, window);
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

  fs.mkdirSync(resolveModelsDir(), { recursive: true });

  console.log(`[model-downloader] Starting download: ${model}`);
  console.log(`[model-downloader] Destination: ${destPath}`);
  if (expectedHash) console.log(`[model-downloader] Expected SHA-256: ${expectedHash.slice(0, 16)}...`);

  function sendProgress(downloaded: number, total: number, status: string) {
    if (window && !window.isDestroyed()) {
      window.webContents.send('ironmic:model-download-progress', {
        model,
        downloaded,
        total,
        status,
        percent: total > 0 ? Math.round((downloaded / total) * 100) : 0,
      });
    }
  }

  const { usedFallback } = await downloadWithFallback(
    url, fallbackUrl, tempPath, sendProgress,
  );

  if (usedFallback) {
    console.log(`[model-downloader] Downloaded ${model} from fallback source (HuggingFace)`);
  }

  // Verify integrity
  if (expectedHash) {
    try {
      const actualHash = await hashFile(tempPath);
      if (actualHash !== expectedHash) {
        cleanupTemp(tempPath);
        sendProgress(0, 0, 'error');
        throw new Error(
          `Integrity check failed for ${model}. Expected SHA-256: ${expectedHash.slice(0, 16)}..., got: ${actualHash.slice(0, 16)}...`
        );
      }
      console.log(`[model-downloader] SHA-256 verified: ${model}`);
    } catch (hashErr: any) {
      if (hashErr.message.includes('Integrity check failed')) throw hashErr;
      cleanupTemp(tempPath);
      sendProgress(0, 0, 'error');
      throw new Error(`Failed to verify download integrity: ${hashErr}`);
    }
  }

  fs.renameSync(tempPath, destPath);
  sendProgress(0, 0, 'complete');
  console.log(`[model-downloader] Download complete: ${model}`);
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
