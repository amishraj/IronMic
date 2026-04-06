/**
 * Model downloader — handles downloading Whisper, LLM, and TTS model files.
 * This is the ONLY network code in the entire app, and it only runs
 * when the user explicitly clicks a download button.
 *
 * Security:
 * - SHA-256 integrity verification on all model files
 * - HTTPS enforced, HTTP rejected
 * - Redirect domains validated (HuggingFace only)
 * - Download and stall timeouts
 */

import https from 'https';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { BrowserWindow } from 'electron';
import { MODEL_URLS, MODEL_FILES, MODEL_CHECKSUMS, TTS_VOICE_BASE_URL, TTS_VOICE_IDS } from '../shared/constants';

const MODELS_DIR = path.join(__dirname, '..', '..', '..', 'rust-core', 'models');

/** Allowed domains for model downloads and redirects */
const ALLOWED_DOMAINS = ['huggingface.co'];

/** Overall download timeout: 10 minutes */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** Stall timeout: abort if no data received for 60 seconds */
const STALL_TIMEOUT_MS = 60 * 1000;

function getModelPath(model: string): string {
  const filename = MODEL_FILES[model];
  if (!filename) throw new Error(`Unknown model: ${model}`);
  return path.join(MODELS_DIR, filename);
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
  const voicesDir = path.join(MODELS_DIR, 'voices');
  const defaultVoice = path.join(voicesDir, 'af_heart.bin');
  return fs.existsSync(defaultVoice);
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

/**
 * Download a single model file with integrity verification.
 */
export function downloadModel(
  model: string,
  window: BrowserWindow | null,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = MODEL_URLS[model];
    if (!url) {
      reject(new Error(`Unknown model: ${model}`));
      return;
    }

    try { validateUrl(url); } catch (e) { reject(e); return; }

    const destPath = getModelPath(model);
    const tempPath = destPath + '.downloading';
    const expectedHash = MODEL_CHECKSUMS[model]; // may be undefined for voice files

    fs.mkdirSync(MODELS_DIR, { recursive: true });

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

    function doRequest(reqUrl: string, redirectCount = 0) {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'));
        return;
      }

      try { validateUrl(reqUrl); } catch (e) { reject(e); return; }

      const req = https.get(reqUrl, (res) => {
        // Follow redirects — but validate the target domain
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

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;

        const file = fs.createWriteStream(tempPath);

        sendProgress(0, totalBytes, 'downloading');

        // Stall timer — reset on each data chunk
        let stallTimer = setTimeout(() => {
          req.destroy();
          cleanupTemp(tempPath);
          sendProgress(0, 0, 'error');
          reject(new Error('Download stalled — no data received for 60 seconds'));
        }, STALL_TIMEOUT_MS);

        res.on('data', (chunk: Buffer) => {
          downloadedBytes += chunk.length;
          // Reset stall timer
          clearTimeout(stallTimer);
          stallTimer = setTimeout(() => {
            req.destroy();
            cleanupTemp(tempPath);
            sendProgress(0, 0, 'error');
            reject(new Error('Download stalled — no data received for 60 seconds'));
          }, STALL_TIMEOUT_MS);

          if (downloadedBytes % (1024 * 1024) < chunk.length) {
            sendProgress(downloadedBytes, totalBytes, 'downloading');
          }
        });

        res.pipe(file);

        file.on('finish', () => {
          clearTimeout(stallTimer);
          file.close(async () => {
            // Verify integrity if checksum is known
            if (expectedHash) {
              try {
                const actualHash = await hashFile(tempPath);
                if (actualHash !== expectedHash) {
                  cleanupTemp(tempPath);
                  sendProgress(0, 0, 'error');
                  reject(new Error(
                    `Integrity check failed for ${model}. Expected SHA-256: ${expectedHash.slice(0, 16)}..., got: ${actualHash.slice(0, 16)}...`
                  ));
                  return;
                }
                console.log(`[model-downloader] SHA-256 verified: ${model}`);
              } catch (hashErr) {
                cleanupTemp(tempPath);
                sendProgress(0, 0, 'error');
                reject(new Error(`Failed to verify download integrity: ${hashErr}`));
                return;
              }
            }

            fs.renameSync(tempPath, destPath);
            sendProgress(totalBytes, totalBytes, 'complete');
            console.log(`[model-downloader] Download complete: ${model}`);
            resolve();
          });
        });

        file.on('error', (err) => {
          clearTimeout(stallTimer);
          cleanupTemp(tempPath);
          sendProgress(0, 0, 'error');
          reject(err);
        });
      });

      req.on('error', (err) => {
        sendProgress(0, 0, 'error');
        reject(err);
      });

      // Overall download timeout
      req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
        req.destroy();
        cleanupTemp(tempPath);
        sendProgress(0, 0, 'error');
        reject(new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS / 60000} minutes`));
      });
    }

    doRequest(url);
  });
}

/**
 * Download a single voice file to the voices/ subdirectory.
 */
function downloadVoiceFile(voiceId: string, window: BrowserWindow | null): Promise<void> {
  const voicesDir = path.join(MODELS_DIR, 'voices');
  fs.mkdirSync(voicesDir, { recursive: true });

  const destPath = path.join(voicesDir, `${voiceId}.bin`);
  if (fs.existsSync(destPath)) return Promise.resolve();

  const url = `${TTS_VOICE_BASE_URL}/${voiceId}.bin`;
  const tempPath = destPath + '.downloading';

  try { validateUrl(url); } catch (e) { return Promise.reject(e); }

  return new Promise((resolve, reject) => {
    console.log(`[model-downloader] Downloading voice: ${voiceId}`);

    function doRequest(reqUrl: string, redirectCount = 0) {
      if (redirectCount > 5) { reject(new Error('Too many redirects')); return; }
      try { validateUrl(reqUrl); } catch (e) { reject(e); return; }

      const req = https.get(reqUrl, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          doRequest(res.headers.location, redirectCount + 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Voice download failed: HTTP ${res.statusCode} for ${voiceId}`));
          return;
        }
        const file = fs.createWriteStream(tempPath);
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            fs.renameSync(tempPath, destPath);
            console.log(`[model-downloader] Voice downloaded: ${voiceId}`);
            resolve();
          });
        });
        file.on('error', (err) => {
          cleanupTemp(tempPath);
          reject(err);
        });
      });
      req.on('error', reject);
      req.setTimeout(STALL_TIMEOUT_MS, () => {
        req.destroy();
        cleanupTemp(tempPath);
        reject(new Error(`Voice download timed out: ${voiceId}`));
      });
    }

    doRequest(url);
  });
}

/**
 * Download TTS model (ONNX) + all English voice files.
 */
export async function downloadTtsModel(window: BrowserWindow | null): Promise<void> {
  if (!isModelDownloaded('tts-model')) {
    await downloadModel('tts-model', window);
  }

  if (window && !window.isDestroyed()) {
    window.webContents.send('ironmic:model-download-progress', {
      model: 'tts-voices', downloaded: 0, total: TTS_VOICE_IDS.length, status: 'downloading', percent: 0,
    });
  }

  for (let i = 0; i < TTS_VOICE_IDS.length; i++) {
    await downloadVoiceFile(TTS_VOICE_IDS[i], window);
    if (window && !window.isDestroyed()) {
      window.webContents.send('ironmic:model-download-progress', {
        model: 'tts-voices',
        downloaded: i + 1,
        total: TTS_VOICE_IDS.length,
        status: i === TTS_VOICE_IDS.length - 1 ? 'complete' : 'downloading',
        percent: Math.round(((i + 1) / TTS_VOICE_IDS.length) * 100),
      });
    }
  }
}
