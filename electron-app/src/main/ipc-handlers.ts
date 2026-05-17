/**
 * IPC handlers that bridge renderer requests to the Rust native addon.
 * Security: input validation on high-risk channels.
 */

import { ipcMain, BrowserWindow, shell, systemPreferences, nativeTheme } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { IPC_CHANNELS, MODEL_FILES, TRANSCRIPTION_ENGINES } from '../shared/constants';
import { native } from './native-bridge';
import { notifyDictionaryChanged } from './dictionary-cache';
import { downloadModel, downloadTtsModel, getModelsStatus, isTtsModelReady, getTtsReadiness, ensureBundledVoices, invalidateEspeakCache, importModelFile, getImportableModels, importModelFromPath, importMultiPartModel, downloadTranscriptionEngine, isTranscriptionEngineReady, importMoonshineEngine, ensureBundledMoonshineBase, isMoonshineBundleAvailable } from './model-downloader';
import { aiManager } from './ai/AIManager';
import { getChatModelPath } from './ai/LocalLLMAdapter';
import { llmSubprocess } from './ai/LlmSubprocess';
import type { AIProvider } from './ai/types';
import { meetingRecorder } from './meeting-recorder';
import { liveSummarizer } from './live-summarizer';
import { dictationStreamer } from './dictation-streamer';
import { meetingRoomServer } from './meeting-room-server';
import { meetingRoomClient } from './meeting-room-client';
import { meetingNotesCollabServer } from './meeting-notes-collab-server';
import { meetingNotesCollabClient } from './meeting-notes-collab-client';
import { checkBlackHoleInstalled, installBlackHole, openAudioMidiSetup, broadcastInstallProgress } from './blackhole-setup';
import { audioStream } from './audio-stream-manager';
import { debugLog, invalidateDebugLogCache } from './debug-log';
import { computeRmsPcm16 } from './transcribe-clean';
import { markdownToProjections } from './utils/markdownPipeline';
import { execFile } from 'child_process';
import {
  enterForgeMode,
  exitForgeMode,
  openAccessibilityPrefs,
  isForgeMode,
  setForgeWindowMode,
} from './forge-window';
import {
  clearForgeOwner,
  setForgeOwnerProcessing,
} from './dictation-owner';

// ── Input validation helpers ──

const MAX_PROMPT_LENGTH = 100_000;
const MAX_SETTING_VALUE_LENGTH = 1_000;
const MAX_AUDIO_BUFFER_SIZE = 100 * 1024 * 1024; // 100 MB
const VALID_PROVIDERS: AIProvider[] = ['copilot', 'claude', 'local'];

const ALLOWED_SETTING_KEYS = new Set([
  'hotkey_record', 'llm_cleanup_enabled', 'default_view', 'theme',
  'whisper_model', 'llm_model', 'ai_enabled',
  'ai_provider', 'ai_model', 'ai_local_model',
  'tts_auto_readback', 'tts_voice', 'tts_speed', 'tts_enabled',
  'auto_delete_enabled', 'auto_delete_days',
  'security_clipboard_auto_clear', 'security_session_timeout',
  'security_clear_on_exit', 'security_ai_data_confirm', 'security_privacy_mode',
  'migration_tag_ai_done',
  'migration_auto_detect_default_v2',
  'analytics_backfill_done',
  // ML Feature settings (v1.1.0)
  'vad_enabled', 'vad_sensitivity', 'vad_web_audio_enabled',
  'turn_detection_enabled', 'turn_detection_timeout_ms', 'turn_detection_mode',
  'voice_routing_enabled', 'meeting_mode_enabled',
  'intent_classification_enabled', 'intent_llm_fallback',
  'ml_notifications_enabled', 'ml_notifications_threshold', 'ml_notifications_retention_days',
  'ml_workflows_enabled', 'ml_workflows_confidence',
  'ml_semantic_search_enabled',
  // Network / proxy (v1.1.8)
  'proxy_url', 'proxy_enabled',
  // Meeting templates (v1.3.0)
  'meeting_auto_detect_enabled', 'meeting_default_template',
  // Meeting recording / Granola mode (v1.5.0)
  'meeting_audio_device', 'meeting_chunk_interval_s', 'meeting_display_name',
  // Collaboration (v1.6.0)
  'meeting_collab_display_name',
  // Notebooks — JSON array of {id,name,createdAt}
  'notebooks',
  // Debug toggle for the audio pipeline log channel (renderer DevTools)
  'debug_audio_logging',
  // One-time discoverability flag: 'true' once the close-to-tray hint
  // notification has been shown. Persisted so the hint never re-fires.
  // Read/written from main process (not via this IPC), but listed here
  // so a future "reset onboarding" admin tool can clear it via setSetting.
  'tray_hint_shown',
  // Whisper thread count override — default is min(4, num_cpus).
  // Reduce on VDI / shared machines if first-transcription hangs.
  'whisper_threads',
  // Phase 1 engine swap: which transcription engine is active.
  // Values: 'moonshine-base' (default, bundled) | 'whisper-base' |
  // 'whisper-small' | 'whisper-medium' | 'whisper-large-v3-turbo'.
  // Persisted in SQLite, but every launch overrides this to 'moonshine-base'
  // (see main/index.ts engine-startup block) — so user switches via this
  // setting last only for the current session.
  'transcription_engine',
  // Per-meeting engine preference (default 'whisper-large-v3-turbo' —
  // accuracy over latency since meetings process 30 s+ chunks). MeetingPage
  // reads this on meeting start and writes the existing `transcription_engine`
  // key so the native swap happens via the same path as the Settings UI.
  // Same value set as `transcription_engine`.
  'meeting_transcription_engine',
  // Polish provider preference. 'true' enables cloud polish via authenticated
  // Claude/Copilot CLIs; default 'false' keeps polish strictly on-device.
  // The renderer Settings panel surfaces this with a privacy warning + confirm.
  // Note: this setting now also gates non-polish AI tasks (meeting summaries,
  // template generation, intent classification, meeting detection) via
  // generateText. Settings UI copy reflects the broader scope.
  'polish_allow_cloud',
  // Format mode for polished output and meeting summaries. 'rich' (default)
  // produces structured markdown rendered as TipTap content; 'plain' falls
  // back to the legacy flat-text behavior. Seeded by migration v10.
  'polish_format_mode',
  // Developer features escape hatch. 'true' surfaces legacy/experimental
  // controls (e.g. Solo meeting mode). Default 'false'.
  'dev_features_enabled',
  // ── Forge mode (v1.7.0) ──
  // forge_persist_history     — 'true'/'false'. Save Forge dictations to
  //                             entries table. Default 'false' for privacy
  //                             (Forge dictations may include passwords,
  //                             private chat, sensitive replies).
  // forge_polish_enabled      — 'true'/'false'. Run LLM polish before paste.
  //                             Default 'false' for latency.
  // forge_polish_allow_cloud  — 'true'/'false'. Cloud polish in Forge requires
  //                             the AND of (polish_allow_cloud,
  //                             forge_polish_allow_cloud). Global is upper
  //                             bound; Forge can be stricter, never looser.
  // forge_paste_method        — 'paste' (default) | 'type'. 'type' is the
  //                             char-by-char fallback for paste-blocking apps.
  // forge_clipboard_restore   — 'true' (default) / 'false'. Restore prior
  //                             text on the clipboard ~500ms after paste.
  // forge_bar_position        — last-known bar position, JSON {x,y} or
  //                             'top-right' (default).
  'forge_persist_history',
  'forge_polish_enabled',
  'forge_polish_allow_cloud',
  'forge_paste_method',
  'forge_clipboard_restore',
  'forge_bar_position',
  // Auto-paste toggle exposed in the Forge bar's gear icon.
  // 'true' (default): final transcript is auto-pasted at the OS cursor.
  // 'false': transcript is copied to clipboard only — user pastes manually.
  'forge_auto_paste_enabled',
  // Voice Chat cloud opt-in (v1.8.x). Default 'false'. When 'true' AND the
  // selected provider is authenticated, the conversational loop may auto-send
  // raw mic transcripts to Claude/Copilot. Otherwise Voice Chat is local-only.
  'voice_chat_allow_cloud',
  // ── Knowledge Q&A (v13 / RAG layer) ──
  // knowledge_qa_enabled         — master toggle for the Ask page.
  // knowledge_qa_allow_cloud     — separate cloud opt-in for Q&A (intended
  //                                for the future automatic-retrieval gate;
  //                                manual attachment in AIChat doesn't use it).
  // knowledge_qa_default_provider— 'auto' | 'local' | 'claude' | 'copilot'.
  //                                Overrides ai_provider for Ask only.
  // embedding_active_model       — embedding model id. Drives query-time
  //                                filtering of chunk_embeddings rows so
  //                                multiple models can coexist during a
  //                                lazy re-embedding migration.
  // rag_chunk_size_tokens        — target chunk size for the chunker.
  // rag_chunk_overlap_tokens     — overlap between adjacent chunks.
  // rag_contextual_prefix_enabled — best-effort doc-context prefix
  //                                injection at embed time.
  // rag_topic_k_local            — retrieval k for local-LLM route.
  // rag_topic_k_cloud            — retrieval k for cloud route (larger).
  // notes_migrated_to_sqlite     — one-shot flag flipped by useNotesStore's
  //                                renderer-side migration after a successful
  //                                localStorage → SQLite import. Renderer
  //                                checks this on each boot to skip re-runs.
  'knowledge_qa_enabled',
  'knowledge_qa_allow_cloud',
  'knowledge_qa_default_provider',
  'embedding_active_model',
  'rag_chunk_size_tokens',
  'rag_chunk_overlap_tokens',
  'rag_contextual_prefix_enabled',
  'rag_topic_k_local',
  'rag_topic_k_cloud',
  'notes_migrated_to_sqlite',
  // One-shot UI dismissal flags. These are renderer-driven booleans that
  // suppress an onboarding banner / prompt once the user has acknowledged it.
  // 'true' = dismissed.
  'gpu_prompt_dismissed',
]);

function assertString(val: unknown, name: string): asserts val is string {
  if (typeof val !== 'string') throw new Error(`${name} must be a string`);
}

function assertMaxLength(val: string, max: number, name: string): void {
  if (val.length > max) throw new Error(`${name} exceeds maximum length (${max})`);
}

// ── Model management helpers ──
// Resolve the user-data models dir the same way model-downloader does. Reading
// the env var directly avoids exporting a private path resolver.
function resolveModelsDirForIpc(): string {
  return process.env.IRONMIC_MODELS_DIR || '';
}

interface EngineFileEntry {
  /** Relative path under the models dir (e.g. "moonshine-base/encoder_model.onnx") */
  relativePath: string;
  /** Absolute filesystem path, or '' if the models dir is not yet set */
  absolutePath: string;
}

function getEngineFiles(engineId: string): EngineFileEntry[] {
  const meta = TRANSCRIPTION_ENGINES.find((e) => e.id === engineId);
  if (!meta) throw new Error(`Unknown engine: ${engineId}`);
  const modelsDir = resolveModelsDirForIpc();
  return meta.modelFileKeys.map((key) => {
    const rel = MODEL_FILES[key];
    if (!rel) throw new Error(`Engine ${engineId} references unknown model file key: ${key}`);
    return {
      relativePath: rel,
      absolutePath: modelsDir ? path.join(modelsDir, rel) : '',
    };
  });
}

function assertEngineNotActive(engineId: string, action: string): void {
  let active: string;
  try {
    active = native.getTranscriptionEngine();
  } catch (err: any) {
    throw new Error(`Cannot ${action}: failed to read active engine (${err?.message ?? err})`);
  }
  if (engineId === active) {
    throw new Error(
      `Cannot ${action} the active engine. Switch to another engine in Settings first.`,
    );
  }
}

function deleteEngineFilesImpl(engineId: string): { deleted: number; restoredBundle: boolean } {
  assertEngineNotActive(engineId, 'delete');
  const files = getEngineFiles(engineId);
  let deleted = 0;
  for (const f of files) {
    if (!f.absolutePath) continue;
    try {
      if (fs.existsSync(f.absolutePath)) {
        fs.unlinkSync(f.absolutePath);
        deleted += 1;
      }
    } catch (err) {
      console.warn(`[model-mgmt] Failed to delete ${f.absolutePath}:`, err);
    }
  }
  // For the bundled default engine, immediately restore from app resources
  // so packaged builds don't leave the user without a working engine.
  let restoredBundle = false;
  if (engineId === 'moonshine-base') {
    try {
      const status = ensureBundledMoonshineBase();
      restoredBundle = status === 'copied';
    } catch (err) {
      console.warn('[model-mgmt] Failed to restore bundled Moonshine after delete:', err);
    }
  }
  return { deleted, restoredBundle };
}

export function registerIpcHandlers(): void {
  // Audio — all callers must go through audioStream for exclusive ownership.
  ipcMain.handle(IPC_CHANNELS.START_RECORDING, () => {
    audioStream.acquire('dictation');
    try {
      native.startRecording();
      debugLog('capture.start', { owner: 'dictation', success: true });
    } catch (err: any) {
      debugLog('capture.start', { owner: 'dictation', success: false, error: err?.message ?? String(err) });
      audioStream.release('dictation');
      throw err;
    }
  });
  ipcMain.handle(IPC_CHANNELS.STOP_RECORDING, () => {
    try {
      const buf = native.stopRecording();
      debugLog('capture.drained', {
        owner: 'dictation',
        chunkIndex: 0,
        byteLength: buf.length,
        rms: computeRmsPcm16(buf),
        isFinal: true,
        path: 'stopRecording',
      });
      return buf;
    } finally {
      audioStream.release('dictation');
    }
  });
  ipcMain.handle(IPC_CHANNELS.IS_RECORDING, () => native.isRecording());
  // reset-recording: clears both the Rust pipeline state and the ownership
  // flag so a stuck stream can be recovered without restarting the app.
  ipcMain.handle('ironmic:reset-recording', () => {
    audioStream.forceReset();
    if (typeof native.addon.resetRecording === 'function') {
      native.addon.resetRecording();
    } else if (typeof native.addon.resetPipelineState === 'function') {
      native.addon.resetPipelineState();
    }
  });

  // Transcription — validate buffer size, convert Uint8Array to Buffer (sandbox sends Uint8Array)
  ipcMain.handle(IPC_CHANNELS.TRANSCRIBE, async (_e, audioBuffer: any) => {
    if (!Buffer.isBuffer(audioBuffer) && !(audioBuffer instanceof Uint8Array)) {
      throw new Error('audioBuffer must be a Buffer or Uint8Array');
    }
    if (audioBuffer.length > MAX_AUDIO_BUFFER_SIZE) {
      throw new Error(`Audio buffer too large: ${audioBuffer.length} bytes (max ${MAX_AUDIO_BUFFER_SIZE})`);
    }
    const buf = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
    const start = Date.now();
    const engineKind = (() => {
      try { return native.getTranscriptionEngine?.() ?? 'unknown'; }
      catch { return 'unknown'; }
    })();
    debugLog('whisper.in', { engine: engineKind, owner: 'single-shot', byteLength: buf.length, durationSec: buf.length / 2 / 16000 });
    try {
      const text = await native.transcribe(buf);
      debugLog('whisper.raw', { engine: engineKind, owner: 'single-shot', rawText: text, length: text?.length ?? 0, latencyMs: Date.now() - start });
      return text;
    } catch (err: any) {
      debugLog('whisper.error', { engine: engineKind, owner: 'single-shot', message: err?.message ?? String(err), latencyMs: Date.now() - start });
      throw err;
    }
  });
  // Polish dispatcher used by both POLISH_TEXT and POLISH_TEXT_DETAILED.
  // Reads polish_allow_cloud from settings and routes via aiManager. Default
  // is strictly local — cloud is only considered when the setting is the
  // explicit string 'true' (auth state alone never enables it).
  const dispatchPolish = async (
    rawText: string,
    requireModel: boolean,
  ): Promise<{ text: string; providerUsed: AIProvider }> => {
    let allowCloud = false;
    try {
      allowCloud = native.getSetting('polish_allow_cloud') === 'true';
    } catch { /* setting absent → default false */ }
    try {
      return await aiManager.polish(rawText, { allowCloud });
    } catch (err: any) {
      // Renderer pattern-matches the "Cleanup model not downloaded" wording.
      // When the caller doesn't require the model (legacy dictation auto-
      // cleanup, meeting fallback), gracefully return the input unchanged.
      if (!requireModel && err?.message?.includes('Cleanup model not downloaded')) {
        return { text: rawText, providerUsed: 'local' };
      }
      throw err;
    }
  };

  // Backward-compat: existing callers (Forge polish, useNotesStore, the
  // local Notes "Polish now" button) expect a string return. Phase 1
  // migrated SummaryGenerator / MeetingTemplateEngine / IntentClassifier /
  // MeetingDetector to generateText. The remaining string consumers want
  // the plainText projection — once Phase 4's prompts emit markdown,
  // returning result.text directly would leak `## headings` and `**bold**`
  // syntax into clipboards / Forge pastes / plain-text fields.
  ipcMain.handle(IPC_CHANNELS.POLISH_TEXT, async (
    _e,
    rawText: string,
    opts?: { requireModel?: boolean },
  ) => {
    const result = await dispatchPolish(rawText, !!opts?.requireModel);
    try {
      return markdownToProjections(result.text).plainText;
    } catch {
      // Pipeline failure → fall back to verbatim text (matches old behavior).
      return result.text;
    }
  });

  // New channel for the toggle-driven polish flow.
  //
  // Returns the full projection set so callers that persist entries can
  // store both polished_text (plain) and polished_text_json (rich).
  // Renderer-facing contract is strings only — `jsonString` not `json`.
  // The markdown projection is the LLM output; cloud + local converge on
  // markdown going forward (Phase 4 lands the prompts that exploit this).
  ipcMain.handle(IPC_CHANNELS.POLISH_TEXT_DETAILED, async (
    _e,
    rawText: string,
    opts?: { requireModel?: boolean },
  ) => {
    const result = await dispatchPolish(rawText, !!opts?.requireModel);
    // The polish pass already returns text. In Phase 4 the prompt instructs
    // the model to emit markdown; today's prompt instructs plain text. Either
    // way, we run the result through the markdown pipeline so callers always
    // get all three projections — plain markdown becomes a single-paragraph
    // ProseMirror doc (no harm), formatted markdown becomes structured.
    let projections;
    try {
      projections = markdownToProjections(result.text);
    } catch {
      // If the pipeline somehow fails (e.g. malformed LLM output), fall back
      // to the raw text in all three slots so callers don't crash.
      projections = {
        plainText: result.text,
        html: '',
        json: { type: 'doc', content: [] },
      };
    }
    return {
      // markdown is the verbatim LLM output (stable contract for callers
      // that want it for export / round-trip).
      markdown: result.text,
      plainText: projections.plainText,
      html: projections.html,
      jsonString: JSON.stringify(projections.json),
      providerUsed: result.providerUsed,
      // Back-compat: keep `text` so existing callers reading `.text` still work
      // until they migrate. Equal to `plainText` to avoid markdown bleed.
      text: projections.plainText,
    };
  });

  // Strictly local-only polish. Used by callers (e.g. AI title generation)
  // that must never route to a cloud provider regardless of the user's
  // polish_allow_cloud setting. Returns only the plainText projection to
  // match POLISH_TEXT and preserve "string consumers never see markdown".
  ipcMain.handle(IPC_CHANNELS.POLISH_TEXT_LOCAL, async (
    _e,
    rawText: string,
    opts?: { requireModel?: boolean },
  ) => {
    const requireModel = !!opts?.requireModel;
    try {
      const result = await aiManager.polish(rawText, { allowCloud: false });
      try {
        return markdownToProjections(result.text).plainText;
      } catch {
        return result.text;
      }
    } catch (err: any) {
      if (!requireModel && err?.message?.includes('Cleanup model not downloaded')) {
        return rawText;
      }
      throw err;
    }
  });

  // ── Generic LLM transport (caller owns the system prompt) ──
  // Used by SummaryGenerator, MeetingTemplateEngine, IntentClassifier,
  // MeetingDetector, etc. — anything that needs an LLM completion that ISN'T
  // a polish pass. Live summary stays on its own llmSubprocess path because
  // it needs abort-signal cancellation that this wrapper doesn't provide.
  //
  // Renderer-supplied opts can only NARROW permissions:
  //   - forceLocal: true → bypass cloud regardless of polish_allow_cloud
  //   - maxTokens, temperature → clamped here, never trusted verbatim
  // Cloud allowance always read from main-process settings, never opts.
  const clamp = (n: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, n));
  const dispatchGenerate = async (
    systemPrompt: string,
    userPrompt: string,
    opts: { forceLocal?: boolean; maxTokens?: number; temperature?: number } | undefined,
  ): Promise<{ text: string; providerUsed: AIProvider; fallbackUsed?: string }> => {
    if (typeof systemPrompt !== 'string' || typeof userPrompt !== 'string') {
      throw new Error('generateText requires string system and user prompts');
    }
    if (systemPrompt.length + userPrompt.length > MAX_PROMPT_LENGTH) {
      throw new Error(
        `generateText prompts too long: ${systemPrompt.length + userPrompt.length} chars (max ${MAX_PROMPT_LENGTH})`,
      );
    }
    const maxTokens = clamp(Number(opts?.maxTokens ?? 1024), 1, 4096);
    const temperature = clamp(Number(opts?.temperature ?? 0.2), 0, 1);
    let allowCloud = false;
    if (!opts?.forceLocal) {
      try {
        allowCloud = native.getSetting('polish_allow_cloud') === 'true';
      } catch { /* setting absent → default false */ }
    }
    return aiManager.generate(systemPrompt, userPrompt, { allowCloud, maxTokens, temperature });
  };

  ipcMain.handle(IPC_CHANNELS.GENERATE_TEXT, async (
    _e,
    systemPrompt: string,
    userPrompt: string,
    opts?: { forceLocal?: boolean; maxTokens?: number; temperature?: number },
  ) => {
    const result = await dispatchGenerate(systemPrompt, userPrompt, opts);
    // `fallbackUsed` flags transparent provider fallback (e.g. Copilot CLI
    // failed stdin probe → local). Renderer reads it to surface a one-time
    // toast without forcing a hard error path.
    return {
      text: result.text,
      providerUsed: result.providerUsed,
      ...(result.fallbackUsed ? { fallbackUsed: result.fallbackUsed } : {}),
    };
  });

  // Strictly local generic transport. Same shape as GENERATE_TEXT but with
  // forceLocal pinned on, for callers (e.g. AI title generation) that must
  // never touch cloud regardless of user setting.
  ipcMain.handle(IPC_CHANNELS.GENERATE_TEXT_LOCAL, async (
    _e,
    systemPrompt: string,
    userPrompt: string,
    opts?: { maxTokens?: number; temperature?: number },
  ) => {
    const result = await dispatchGenerate(systemPrompt, userPrompt, {
      ...opts,
      forceLocal: true,
    });
    return {
      text: result.text,
      providerUsed: result.providerUsed,
      ...(result.fallbackUsed ? { fallbackUsed: result.fallbackUsed } : {}),
    };
  });

  // Markdown → { plainText, html, jsonString } projections.
  // Renderer never imports the pipeline directly — it goes through this IPC
  // so sanitize-html and Marked's HTML-dropping tokenizer run in main, where
  // they can be audited as a single security-relevant codepath. Renderer
  // consumes the strings: html for `dangerouslySetInnerHTML`, jsonString
  // for `editor.commands.setContent(JSON.parse(jsonString))`.
  ipcMain.handle(IPC_CHANNELS.CONVERT_MARKDOWN, async (_e, md: string) => {
    if (typeof md !== 'string') {
      throw new Error('convertMarkdown requires a string input');
    }
    if (md.length > MAX_PROMPT_LENGTH) {
      throw new Error(`convertMarkdown markdown too long: ${md.length} chars (max ${MAX_PROMPT_LENGTH})`);
    }
    const { plainText, html, json } = markdownToProjections(md);
    // Crossing the IPC boundary: object → string. Renderer types declare
    // jsonString, never object — see the `convertMarkdown` typing in the
    // global Window.ironmic interface.
    return { plainText, html, jsonString: JSON.stringify(json) };
  });

  // ── Processing state tracking (for quit-confirmation) ──
  // Renderer fires this when it starts/stops LLM note generation so the main
  // process can intercept window close and warn about in-flight work.
  let activeNotesGeneratingCount = 0;
  ipcMain.on('ironmic:notify-processing-state', (_e, isActive: boolean) => {
    activeNotesGeneratingCount = Math.max(0, activeNotesGeneratingCount + (isActive ? 1 : -1));
  });
  // Expose the counter so index.ts can read it in the before-close hook.
  (global as any).__ironmicActiveGeneratingCount = () => activeNotesGeneratingCount;

  // Entries. CREATE / UPDATE both schedule a chunk refresh so RAG retrieval
  // sees freshly-edited content on the next Search query — without this,
  // the chunks table held content from the previous edit and queries like
  // "what's in my note about X" would miss X if X was added recently.
  // Fire-and-forget (the chunk op runs in Rust under the SQLite mutex) so
  // we don't block the user-visible save. DELETE cascades to remove old
  // chunks for the dropped source.
  const scheduleChunkRefresh = (id: string) => {
    queueMicrotask(() => {
      try {
        native.addon.ragChunkEntry?.(id);
      } catch (err) {
        console.warn(`[ipc] chunk refresh for entry ${id} failed:`, err);
      }
    });
  };
  ipcMain.handle(IPC_CHANNELS.CREATE_ENTRY, (_e, entry) => {
    const created = native.createEntry(entry);
    if (created?.id) scheduleChunkRefresh(created.id);
    return created;
  });
  ipcMain.handle(IPC_CHANNELS.GET_ENTRY, (_e, id: string) => native.getEntry(id));
  ipcMain.handle(IPC_CHANNELS.UPDATE_ENTRY, (_e, id: string, updates) => {
    const updated = native.updateEntry(id, updates);
    // Only re-chunk when the body or polished text changed — tag / pin /
    // archive flips don't affect chunk content and would just waste work.
    const bodyChanged =
      updates?.rawTranscript !== undefined
      || updates?.polishedText !== undefined
      || updates?.rawTranscriptJson !== undefined
      || updates?.polishedTextJson !== undefined;
    if (bodyChanged) scheduleChunkRefresh(id);
    return updated;
  });
  ipcMain.handle(IPC_CHANNELS.DELETE_ENTRY, (_e, id: string) => {
    // Drop the entry's chunks first so a delete followed immediately by a
    // search doesn't surface ghost chunks for the just-removed entry.
    try {
      native.addon.ragDeleteChunksForSource?.('entry', id);
    } catch (err) {
      console.warn(`[ipc] chunk delete for entry ${id} failed:`, err);
    }
    return native.deleteEntry(id);
  });
  ipcMain.handle('ironmic:tag-untagged-entries', (_e, sourceApp: string) =>
    native.addon.tagUntaggedEntries(sourceApp)
  );
  ipcMain.handle(IPC_CHANNELS.LIST_ENTRIES, (_e, opts) => native.listEntries(opts));
  ipcMain.handle(IPC_CHANNELS.PIN_ENTRY, (_e, id: string, pinned: boolean) =>
    native.pinEntry(id, pinned)
  );
  ipcMain.handle(IPC_CHANNELS.ARCHIVE_ENTRY, (_e, id: string, archived: boolean) =>
    native.archiveEntry(id, archived)
  );
  ipcMain.handle('ironmic:delete-all-entries', () => native.addon.deleteAllEntries());
  ipcMain.handle('ironmic:delete-entries-older-than', (_e, days: number) =>
    native.addon.deleteEntriesOlderThan(days)
  );
  ipcMain.handle('ironmic:run-auto-cleanup', () => native.addon.runAutoCleanup());

  // User notes (Slice 0 — replaces localStorage-backed useNotesStore). All
  // routes are simple addon pass-throughs; the optimistic-cache + queued-write
  // semantic lives renderer-side so the UI stays synchronous.
  //
  // RAG: every mutation schedules a chunk refresh so Knowledge Q&A retrieval
  // sees the latest content on the next Search query. Fire-and-forget — the
  // chunker runs under the same SQLite mutex but in a separate microtask so
  // it doesn't block the user-visible save. DELETE drops the source's chunks
  // up front so a delete-then-search doesn't surface ghost rows.
  const scheduleUserNoteChunkRefresh = (id: string) => {
    queueMicrotask(() => {
      try {
        native.addon.ragChunkUserNote?.(id);
      } catch (err) {
        console.warn(`[ipc] chunk refresh for user_note ${id} failed:`, err);
      }
    });
  };
  ipcMain.handle(IPC_CHANNELS.USER_NOTES_CREATE, (_e, note) => {
    const created = native.addon.userNotesCreate(note);
    try {
      const parsed = typeof created === 'string' ? JSON.parse(created) : created;
      if (parsed?.id) scheduleUserNoteChunkRefresh(parsed.id);
    } catch { /* ignore parse errors — best-effort */ }
    return created;
  });
  ipcMain.handle(IPC_CHANNELS.USER_NOTES_GET, (_e, id: string) => native.addon.userNotesGet(id));
  ipcMain.handle(IPC_CHANNELS.USER_NOTES_UPDATE, (_e, id: string, updates: any) => {
    const updated = native.addon.userNotesUpdate(id, updates);
    // Re-chunk only when content-bearing fields changed. Title / pin / tags
    // toggles don't move retrieval; skip them so rapid typing doesn't queue
    // a chunker call on every keystroke (the renderer's per-id write queue
    // already coalesces fast, but this is belt-and-suspenders).
    const bodyChanged =
      updates?.title !== undefined
      || updates?.content !== undefined
      || updates?.polishedContent !== undefined;
    if (bodyChanged) scheduleUserNoteChunkRefresh(id);
    return updated;
  });
  ipcMain.handle(IPC_CHANNELS.USER_NOTES_DELETE, (_e, id: string) => {
    try {
      native.addon.ragDeleteChunksForSource?.('user_note', id);
    } catch (err) {
      console.warn(`[ipc] chunk delete for user_note ${id} failed:`, err);
    }
    return native.addon.userNotesDelete(id);
  });
  ipcMain.handle(IPC_CHANNELS.USER_NOTES_LIST, (_e, opts: any) =>
    native.addon.userNotesList(opts)
  );
  ipcMain.handle(IPC_CHANNELS.USER_NOTES_BULK_IMPORT, (_e, payloadJson: string) =>
    native.addon.userNotesBulkImport(payloadJson)
  );
  ipcMain.handle(IPC_CHANNELS.USER_NOTEBOOKS_CREATE, (_e, name: string, color: string) =>
    native.addon.userNotebooksCreate(name, color)
  );
  ipcMain.handle(IPC_CHANNELS.USER_NOTEBOOKS_RENAME, (_e, id: string, name: string) =>
    native.addon.userNotebooksRename(id, name)
  );
  ipcMain.handle(IPC_CHANNELS.USER_NOTEBOOKS_DELETE, (_e, id: string) =>
    native.addon.userNotebooksDelete(id)
  );
  ipcMain.handle(IPC_CHANNELS.USER_NOTEBOOKS_LIST, () => native.addon.userNotebooksList());

  // Knowledge Q&A (Ask page). The orchestrator owns the full flow —
  // intent classification → hybrid retrieval → prompt assembly →
  // AIManager dispatch — and emits phase events back to the renderer.
  // Single-active-request semantics; a new start cancels any prior.
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_ASK_START, async (e, query: string, options: any) => {
    const { knowledgeAsk } = await import('./rag/QAOrchestrator');
    const win = BrowserWindow.fromWebContents(e.sender);
    return knowledgeAsk(query, options, win);
  });
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_ASK_CANCEL, async () => {
    const { cancelKnowledgeAsk } = await import('./rag/QAOrchestrator');
    cancelKnowledgeAsk();
  });
  // Background indexer admin. Used by Settings → Knowledge Q&A controls
  // and by the renderer-side IndexerService when it runs the initial
  // backfill pass after a v13 install. Each chunk_* call is idempotent.
  ipcMain.handle(IPC_CHANNELS.RAG_INDEX_BACKFILL, async (_e, sourceType: string, batchSize: number) => {
    const limit = Math.min(Math.max(batchSize || 25, 1), 100);
    const idsJson = native.addon.ragListUnchunkedSources?.(sourceType, limit);
    if (!idsJson) return 0;
    const ids: string[] = JSON.parse(idsJson);
    let total = 0;
    for (const id of ids) {
      try {
        if (sourceType === 'entry') total += native.addon.ragChunkEntry?.(id) ?? 0;
        else if (sourceType === 'user_note') total += native.addon.ragChunkUserNote?.(id) ?? 0;
        else if (sourceType === 'meeting') total += native.addon.ragChunkMeeting?.(id) ?? 0;
      } catch (err) {
        console.warn(`[rag] backfill chunk failed for ${sourceType} ${id}:`, err);
      }
    }
    return total;
  });
  ipcMain.handle(IPC_CHANNELS.RAG_GET_INDEX_STATS, () => native.addon.ragGetIndexStats?.());
  ipcMain.handle(IPC_CHANNELS.RAG_REBUILD_INDEX, () => native.addon.ragRebuildIndex?.());
  // Direct single-source chunking — used by IndexerService.markDirty when a
  // freshly-created entry/meeting/note needs chunks before the next backfill
  // sweep. Each is idempotent (replace_for_source semantics in Rust).
  ipcMain.handle('ironmic:rag-chunk-entry', (_e, id: string) => native.addon.ragChunkEntry?.(id));
  ipcMain.handle('ironmic:rag-chunk-meeting', (_e, id: string) => native.addon.ragChunkMeeting?.(id));
  ipcMain.handle('ironmic:rag-chunk-user-note', (_e, id: string) => native.addon.ragChunkUserNote?.(id));
  // Direct retrieval / intent classification, exposed for the AI Chat
  // Search-mode toggle. The original design routed everything through
  // knowledge:ask-start (QAOrchestrator), but merging Ask into AI Chat
  // means the renderer now constructs prompts itself and just needs
  // primitive retrieval + intent ops. queryEmbedding is a Uint8Array from
  // the renderer; electron's IPC serializer carries it through verbatim,
  // and the Rust N-API receives it as a Buffer.
  ipcMain.handle('ironmic:rag-classify-intent', (_e, query: string) => native.addon.ragClassifyIntent?.(query));
  ipcMain.handle('ironmic:rag-retrieve-hybrid', (_e, query: string, queryEmbedding: Uint8Array, optionsJson: string) => {
    // Convert Uint8Array to Buffer for the N-API call. Empty buffer is fine
    // (FTS5-only retrieval); Rust skips the vector path when len == 0.
    const buf = Buffer.from(queryEmbedding ?? new Uint8Array());
    return native.addon.ragRetrieveHybrid?.(query, buf, optionsJson);
  });

  // Dictionary. After a mutation, broadcast `dictionary-changed` so any
  // renderer/main caches re-fetch their term list (used by transcript
  // post-correction). The Rust addon already pushes the change into the
  // active engine; this is the JS-side cache invalidation.
  function broadcastDictionaryChanged(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.webContents.send(IPC_CHANNELS.DICTIONARY_CHANGED);
      } catch {
        /* renderer may be closing — ignore */
      }
    }
  }
  ipcMain.handle(IPC_CHANNELS.ADD_WORD, (_e, word: string) => {
    native.addWord(word);
    notifyDictionaryChanged();
    broadcastDictionaryChanged();
  });
  ipcMain.handle(IPC_CHANNELS.REMOVE_WORD, (_e, word: string) => {
    native.removeWord(word);
    notifyDictionaryChanged();
    broadcastDictionaryChanged();
  });
  ipcMain.handle(IPC_CHANNELS.LIST_DICTIONARY, () => native.listDictionary());
  ipcMain.handle(IPC_CHANNELS.REFRESH_TRANSCRIPTION_DICTIONARY, () =>
    native.refreshTranscriptionDictionary(),
  );

  // Settings — validate key allowlist and value length
  ipcMain.handle(IPC_CHANNELS.GET_SETTING, (_e, key: string) => {
    assertString(key, 'key');
    return native.getSetting(key);
  });
  ipcMain.handle(IPC_CHANNELS.SET_SETTING, (_e, key: string, value: string) => {
    assertString(key, 'key');
    assertString(value, 'value');
    if (!ALLOWED_SETTING_KEYS.has(key)) {
      throw new Error(`Unknown setting key: ${key}`);
    }
    // `notebooks` stores a JSON array and can exceed the default 1KB cap as
    // the user adds more notebooks. Give it headroom.
    const maxLen = key === 'notebooks' ? 64_000 : MAX_SETTING_VALUE_LENGTH;
    assertMaxLength(value, maxLen, 'setting value');
    const result = native.setSetting(key, value);
    // The debug-log helper caches the toggle state to avoid a SQLite hit on
    // every audio chunk; invalidate when the user flips it in Settings.
    if (key === 'debug_audio_logging') invalidateDebugLogCache();
    // When the user picks a different transcription engine, push the change
    // to Rust immediately so the next dictate/meeting chunk uses the new
    // engine. The model itself loads lazily on the first transcribe call.
    if (key === 'transcription_engine') {
      try {
        native.setTranscriptionEngine(value);
        debugLog('engine.swap', { kind: value });
      } catch (err: any) {
        debugLog('engine.swap', { kind: value, error: err?.message ?? String(err) });
        throw err;
      }
      // If a meeting is currently recording, the MeetingRecorder's
      // `streamingMode` was fixed at meeting start. Without an explicit
      // mode transition here, the recorder would keep running the old
      // path against the new engine — manifesting as
      // "session_append not supported by this engine" when switching to
      // Whisper, or silent/missing chunks when switching to Moonshine.
      // handleEngineSwap performs the streaming↔chunked transition and
      // pushes a fresh state event so the renderer's UI mode reflects
      // reality. Fire-and-forget; method never throws.
      try {
        if (meetingRecorder.isActive()) {
          void meetingRecorder.handleEngineSwap(value);
        }
      } catch (err) {
        console.warn('[ipc] meetingRecorder.handleEngineSwap failed:', err);
      }
    }
    return result;
  });

  // ── Transcription engine management (Phase 1) ──
  // Renderer queries the available engines + their download status to render
  // the dropdown in InputSettings. Returns: Array<{ kind, isActive, isLoaded, isReady }>
  // where isReady = "all required model files are downloaded".
  ipcMain.handle('ironmic:list-transcription-engines', () => {
    const fromRust = native.listAvailableEngines();
    return fromRust.map((entry) => ({
      ...entry,
      isReady: isTranscriptionEngineReady(entry.kind),
    }));
  });
  ipcMain.handle('ironmic:get-transcription-engine', () => native.getTranscriptionEngine());
  // Download all model files for an engine (e.g. Moonshine = encoder + decoder + tokenizer).
  ipcMain.handle('ironmic:download-transcription-engine', async (_e, engineId: string) => {
    assertString(engineId, 'engineId');
    const window = BrowserWindow.getFocusedWindow();
    return downloadTranscriptionEngine(engineId, window);
  });
  ipcMain.handle('ironmic:is-transcription-engine-ready', (_e, engineId: string) => {
    assertString(engineId, 'engineId');
    return isTranscriptionEngineReady(engineId);
  });

  // Clipboard
  ipcMain.handle(IPC_CHANNELS.COPY_TO_CLIPBOARD, (_e, text: string) =>
    native.copyToClipboard(text)
  );

  // Hotkey & Pipeline
  ipcMain.handle(IPC_CHANNELS.REGISTER_HOTKEY, (_e, accelerator: string) =>
    native.registerHotkey(accelerator)
  );
  ipcMain.handle(IPC_CHANNELS.GET_PIPELINE_STATE, () => native.getPipelineState());
  ipcMain.handle(IPC_CHANNELS.RESET_PIPELINE_STATE, () => native.resetPipelineState());
  ipcMain.handle(IPC_CHANNELS.GET_MODEL_STATUS, () => ({
    ...native.getModelStatus(),
    files: getModelsStatus(),
  }));

  // Model downloads — validate model name against known list.
  ipcMain.handle(IPC_CHANNELS.DOWNLOAD_MODEL, (_e, model: string) => {
    assertString(model, 'model');
    if (model !== 'tts' && !MODEL_FILES[model]) {
      throw new Error(`Unknown model: ${model}`);
    }
    const window = BrowserWindow.getFocusedWindow();
    if (model === 'tts') {
      return downloadTtsModel(window);
    }
    return downloadModel(model, window);
  });
  ipcMain.handle('ironmic:is-tts-model-ready', () => isTtsModelReady());
  // Structured readiness — preferred over the boolean above. Accepts an
  // optional voice ID so the renderer can report selectedVoicePresent. Each
  // call clears the espeak-ng probe cache so a freshly-installed phonemizer
  // (e.g. user just ran `brew install espeak-ng` and clicked Repair) is
  // picked up without an app restart. The probe itself is sub-millisecond.
  ipcMain.handle('ironmic:tts-get-readiness', (_e, voiceId?: string) => {
    invalidateEspeakCache();
    return getTtsReadiness(voiceId);
  });

  // Whisper model & GPU config
  ipcMain.handle('ironmic:get-available-whisper-models', () => native.addon.getAvailableWhisperModels());
  ipcMain.handle('ironmic:get-current-whisper-model', () => native.addon.getCurrentWhisperModel());
  ipcMain.handle('ironmic:set-whisper-model', (_e, modelId: string) => native.addon.setWhisperModel(modelId));
  ipcMain.handle('ironmic:is-gpu-available', () => native.addon.isGpuAvailable());
  ipcMain.handle('ironmic:is-gpu-enabled', () => native.addon.isGpuEnabled());
  ipcMain.handle('ironmic:set-gpu-enabled', (_e, enabled: boolean) => native.addon.setGpuEnabled(enabled));

  // ── Analytics ──
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_RECOMPUTE_TODAY, () => native.addon.analyticsRecomputeToday());
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_BACKFILL, () => native.addon.analyticsBackfill());
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_OVERVIEW, (_e, period: string) => {
    assertString(period, 'period');
    return native.addon.analyticsGetOverview(period);
  });
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_DAILY_TREND, (_e, from: string, to: string) => {
    assertString(from, 'from');
    assertString(to, 'to');
    return native.addon.analyticsGetDailyTrend(from, to);
  });
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_TOP_WORDS, (_e, from: string, to: string, limit: number) => {
    assertString(from, 'from');
    assertString(to, 'to');
    return native.addon.analyticsGetTopWords(from, to, limit);
  });
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_SOURCE_BREAKDOWN, (_e, from: string, to: string) => {
    assertString(from, 'from');
    assertString(to, 'to');
    return native.addon.analyticsGetSourceBreakdown(from, to);
  });
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_VOCABULARY_RICHNESS, (_e, from: string, to: string) => {
    assertString(from, 'from');
    assertString(to, 'to');
    return native.addon.analyticsGetVocabularyRichness(from, to);
  });
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_STREAKS, () => native.addon.analyticsGetStreaks());
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_PRODUCTIVITY_COMPARISON, () => native.addon.analyticsGetProductivityComparison());
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_TOPIC_BREAKDOWN, (_e, from: string, to: string) => {
    assertString(from, 'from');
    assertString(to, 'to');
    return native.addon.analyticsGetTopicBreakdown(from, to);
  });
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_TOPIC_TRENDS, (_e, from: string, to: string) => {
    assertString(from, 'from');
    assertString(to, 'to');
    return native.addon.analyticsGetTopicTrends(from, to);
  });
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_CLASSIFY_TOPICS_BATCH, async (_e, batchSize: number) => {
    if (!llmSubprocess.isAvailable()) {
      throw new Error('LLM subprocess not available');
    }

    // Get unclassified entries (id + text pairs) from Rust
    const entriesJson: string = native.addon.analyticsGetUnclassifiedEntries(batchSize);
    const entries: Array<[string, string]> = JSON.parse(entriesJson);
    if (entries.length === 0) return 0;

    const modelPath = getChatModelPath('llm');
    const TOPIC_PROMPT = `You are a topic classifier. Given a transcription, output 1 to 3 topic categories that best describe the content.

Choose from broad, reusable categories such as:
- Software Development
- Meeting Notes
- Personal Thoughts
- Email Draft
- Creative Writing
- Project Planning
- Technical Discussion
- Documentation
- Code Review
- Business Strategy
- Data Analysis
- Design
- Customer Support
- General

Output ONLY a JSON array of strings, nothing else.
Example output: ["Software Development", "Code Review"]
If the text is too short or unclear, output: ["General"]`;

    let classified = 0;
    for (const [entryId, text] of entries) {
      try {
        // Truncate to ~500 words
        const truncated = text.split(/\s+/).slice(0, 500).join(' ');
        const response = await llmSubprocess.chatComplete({
          modelPath,
          modelType: 'mistral',
          messages: [
            { role: 'user', content: `${TOPIC_PROMPT}\n\nTranscription:\n${truncated}` },
          ],
          maxTokens: 128,
          temperature: 0.1,
        });

        // Parse topics from LLM response
        const topics = parseTopicResponse(response);
        const topicsJson = JSON.stringify(topics);
        native.addon.analyticsSaveEntryTopics(entryId, topicsJson);
        classified++;
      } catch (err) {
        console.warn(`[analytics] Failed to classify entry ${entryId}:`, err);
        // Save as General on failure so we don't retry forever
        native.addon.analyticsSaveEntryTopics(entryId, JSON.stringify([["General", 0.5]]));
        classified++;
      }
    }
    return classified;
  });
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_UNCLASSIFIED_COUNT, () =>
    native.addon.analyticsGetUnclassifiedCount()
  );

  // ── TTS ──
  // Pre-flight readiness gate: every synth call routes through here, including
  // the SettingsPanel preview button which bypasses the renderer-side store.
  // Reaching the Rust engine in a non-ready state produced silent crashes
  // (panic in cpal / ort / poisoned mutex). Now we throw a structured JS error
  // that the renderer surfaces as a real toast.
  ipcMain.handle('ironmic:synthesize-text', (_e, text: string) => {
    const r = getTtsReadiness();
    if (!r.ready) {
      let detail: string;
      if (!r.espeakAvailable) {
        detail = `espeak-ng phonemizer not installed. ${r.espeakHint || ''}`.trim();
      } else if (!r.modelPresent && !r.voicesPresent) {
        detail = `TTS assets missing. Model: ${r.modelPath}; voices: ${r.voicesDir}. Open Settings → Voice Output and click Repair.`;
      } else if (!r.modelPresent) {
        detail = `TTS model missing at ${r.modelPath}. Open Settings → Voice Output to download.`;
      } else {
        detail = `TTS voice pack incomplete (${r.missingVoices.length} of 15 missing) at ${r.voicesDir}. Open Settings → Voice Output and click Repair.`;
      }
      throw new Error(detail);
    }
    return native.addon.synthesizeText(text);
  });
  ipcMain.handle('ironmic:tts-play', () => native.addon.ttsPlay());
  ipcMain.handle('ironmic:tts-pause', () => native.addon.ttsPause());
  ipcMain.handle('ironmic:tts-stop', () => native.addon.ttsStop());
  ipcMain.handle('ironmic:tts-get-position', () => native.addon.ttsGetPosition());
  ipcMain.handle('ironmic:tts-get-state', () => native.addon.ttsGetState());
  ipcMain.handle('ironmic:tts-set-speed', (_e, speed: number) => native.addon.ttsSetSpeed(speed));
  ipcMain.handle('ironmic:tts-set-voice', (_e, voiceId: string) => native.addon.ttsSetVoice(voiceId));
  ipcMain.handle('ironmic:tts-available-voices', () => native.addon.ttsAvailableVoices());
  ipcMain.handle('ironmic:tts-load-model', () => native.addon.ttsLoadModel());
  ipcMain.handle('ironmic:tts-is-loaded', () => native.addon.ttsIsLoaded());
  // Cumulative streaming state — timestamps + duration grow as background
  // chunks land. Renderer polls this each animation frame alongside
  // ttsGetPosition so the live caption fills in word-by-word as new chunks
  // are synthesized.
  ipcMain.handle('ironmic:tts-get-stream-state', () => native.addon.ttsGetStreamState());
  ipcMain.handle('ironmic:tts-toggle', () => native.addon.ttsToggle());

  // ── AI Chat ──
  ipcMain.handle('ai:get-auth-state', () => aiManager.getAuthState());
  ipcMain.handle('ai:refresh-auth', (_e, provider?: AIProvider) => aiManager.refreshAuth(provider));
  ipcMain.handle('ai:pick-provider', () => aiManager.pickProvider());
  ipcMain.handle('ai:send-message', async (
    _e,
    prompt: string,
    provider: AIProvider,
    model?: string,
    sessionId?: string | null,
    priorMessages?: Array<{ role: string; content: string }>,
  ) => {
    assertString(prompt, 'prompt');
    assertString(provider, 'provider');
    assertMaxLength(prompt, MAX_PROMPT_LENGTH, 'AI prompt');
    if (!VALID_PROVIDERS.includes(provider)) {
      throw new Error(`Invalid AI provider: ${provider}`);
    }
    if (model !== undefined && model !== null) {
      assertString(model, 'model');
      assertMaxLength(model, 100, 'model');
    }
    if (sessionId !== undefined && sessionId !== null) {
      assertString(sessionId, 'sessionId');
      assertMaxLength(sessionId, 100, 'sessionId');
    }
    // priorMessages is bounded by the renderer (last N up to MAX_HISTORY) so
    // we don't enforce structure here beyond runtime tolerance.
    const window = BrowserWindow.getFocusedWindow();
    return aiManager.sendMessage(prompt, provider, window, model || undefined, 'chat', sessionId ?? null, priorMessages);
  });
  ipcMain.handle('ai:get-models', async (_e, provider?: AIProvider) => {
    if (provider) return aiManager.getModels(provider);
    return aiManager.getAllModels();
  });
  // Catalog probe — explicit user action only. This is the only AI IPC route
  // that may shell out to enumerate models. `force: true` bypasses the
  // adapter's TTL cache (used for a hard-refresh affordance).
  ipcMain.handle('ai:refresh-models', async (_e, provider?: AIProvider, opts?: { force?: boolean }) => {
    return aiManager.refreshModels(provider, opts ?? {});
  });
  ipcMain.handle('ai:cancel', () => aiManager.cancel());
  ipcMain.handle('ai:reset-session', (_e, sessionId?: string | null) =>
    aiManager.resetSession(sessionId ?? null),
  );
  ipcMain.handle('ai:local-model-status', () => aiManager.getLocalModelStatuses());

  // ── ML Features: Notifications ──

  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_CREATE, (_e, source: string, sourceId: string | null, type: string, title: string, body?: string) =>
    native.addon.createNotification(source, sourceId, type, title, body ?? null)
  );
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_LIST, (_e, limit: number, offset: number, unreadOnly: boolean) =>
    native.addon.listNotifications(limit, offset, unreadOnly)
  );
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_MARK_READ, (_e, id: string) => native.addon.markNotificationRead(id));
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_ACT, (_e, id: string) => native.addon.notificationAct(id));
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_DISMISS, (_e, id: string) => native.addon.notificationDismiss(id));
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_UPDATE_PRIORITY, (_e, id: string, priority: number) =>
    native.addon.updateNotificationPriority(id, priority)
  );
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_LOG_INTERACTION, (_e, notificationId: string, action: string, hour?: number, dow?: number) =>
    native.addon.logNotificationInteraction(notificationId, action, hour ?? null, dow ?? null)
  );
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_GET_INTERACTIONS, (_e, sinceDate: string) =>
    native.addon.getNotificationInteractions(sinceDate)
  );
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_GET_UNREAD_COUNT, () => native.addon.getUnreadNotificationCount());
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_DELETE_OLD, (_e, days: number) => native.addon.deleteOldNotifications(days));

  // ── AI Chat Persistence (v1.8.x) ──

  ipcMain.handle('ironmic:ai-chat-create-session', (_e, id: string | null, title: string, provider: string | null, createdAt?: string, updatedAt?: string) =>
    native.addon.aiChatCreateSession(id, title, provider, createdAt ?? null, updatedAt ?? null)
  );
  ipcMain.handle('ironmic:ai-chat-list-sessions', (_e, limit: number, offset: number, includeArchived: boolean) =>
    native.addon.aiChatListSessions(limit, offset, includeArchived)
  );
  ipcMain.handle('ironmic:ai-chat-get-session', (_e, id: string) =>
    native.addon.aiChatGetSession(id)
  );
  ipcMain.handle('ironmic:ai-chat-rename-session', (_e, id: string, title: string) =>
    native.addon.aiChatRenameSession(id, title)
  );
  ipcMain.handle('ironmic:ai-chat-pin-session', (_e, id: string, pinned: boolean) =>
    native.addon.aiChatPinSession(id, pinned)
  );
  ipcMain.handle('ironmic:ai-chat-archive-session', (_e, id: string, archived: boolean) =>
    native.addon.aiChatArchiveSession(id, archived)
  );
  ipcMain.handle('ironmic:ai-chat-delete-session', (_e, id: string) =>
    native.addon.aiChatDeleteSession(id)
  );
  ipcMain.handle('ironmic:ai-chat-append-message', (_e, sessionId: string, role: string, content: string, provider: string | null, id?: string, createdAt?: string) =>
    native.addon.aiChatAppendMessage(sessionId, role, content, provider, id ?? null, createdAt ?? null)
  );
  ipcMain.handle('ironmic:ai-chat-search-sessions', (_e, query: string, limit: number) =>
    native.addon.aiChatSearchSessions(query, limit)
  );

  // ── ML Features: Action Log ──

  ipcMain.handle(IPC_CHANNELS.ACTION_LOG, (_e, actionType: string, metadataJson?: string) =>
    native.addon.logAction(actionType, metadataJson ?? null)
  );
  ipcMain.handle(IPC_CHANNELS.ACTION_LOG_QUERY, (_e, from: string, to: string, filter?: string) =>
    native.addon.queryActionLog(from, to, filter ?? null)
  );
  ipcMain.handle(IPC_CHANNELS.ACTION_LOG_GET_COUNTS, () => native.addon.getActionCounts());
  ipcMain.handle(IPC_CHANNELS.ACTION_LOG_DELETE_OLD, (_e, days: number) => native.addon.deleteOldActions(days));

  // ── ML Features: Workflows ──

  ipcMain.handle(IPC_CHANNELS.WORKFLOW_CREATE, (_e, seq: string, pattern: string | null, conf: number, count: number) =>
    native.addon.createWorkflow(seq, pattern, conf, count)
  );
  ipcMain.handle(IPC_CHANNELS.WORKFLOW_LIST, (_e, includeDismissed: boolean) => native.addon.listWorkflows(includeDismissed));
  ipcMain.handle(IPC_CHANNELS.WORKFLOW_SAVE, (_e, id: string, name: string) => native.addon.saveWorkflow(id, name));
  ipcMain.handle(IPC_CHANNELS.WORKFLOW_DISMISS, (_e, id: string) => native.addon.dismissWorkflow(id));
  ipcMain.handle(IPC_CHANNELS.WORKFLOW_DELETE, (_e, id: string) => native.addon.deleteWorkflow(id));

  // ── ML Features: Embeddings ──

  ipcMain.handle(IPC_CHANNELS.EMBEDDING_STORE, (_e, contentId: string, contentType: string, embeddingBytes: Buffer, modelVersion: string) =>
    native.addon.storeEmbedding(contentId, contentType, embeddingBytes, modelVersion)
  );
  ipcMain.handle(IPC_CHANNELS.EMBEDDING_GET_ALL, (_e, filter?: string) => native.addon.getAllEmbeddings(filter ?? null));
  ipcMain.handle(IPC_CHANNELS.EMBEDDING_GET_ALL_WITH_DATA, (_e, filter?: string) => native.addon.getAllEmbeddingsWithData(filter ?? null));
  ipcMain.handle(IPC_CHANNELS.EMBEDDING_GET_UNEMBEDDED, (_e, limit: number) => native.addon.getUnembeddedEntries(limit));
  ipcMain.handle(IPC_CHANNELS.EMBEDDING_DELETE, (_e, contentId: string, contentType: string) =>
    native.addon.deleteEmbedding(contentId, contentType)
  );
  ipcMain.handle(IPC_CHANNELS.EMBEDDING_GET_STATS, () => native.addon.getEmbeddingStats());
  ipcMain.handle(IPC_CHANNELS.EMBEDDING_DELETE_ALL, () => native.addon.deleteAllEmbeddings());

  // ── ML Features: Model Weights ──

  ipcMain.handle(IPC_CHANNELS.ML_SAVE_WEIGHTS, (_e, name: string, weightsJson: string, metaJson: string | null, samples: number) =>
    native.addon.saveMlWeights(name, weightsJson, metaJson, samples)
  );
  ipcMain.handle(IPC_CHANNELS.ML_LOAD_WEIGHTS, (_e, name: string) => native.addon.loadMlWeights(name));
  ipcMain.handle(IPC_CHANNELS.ML_DELETE_WEIGHTS, (_e, name: string) => native.addon.deleteMlWeights(name));
  ipcMain.handle(IPC_CHANNELS.ML_GET_TRAINING_STATUS, () => native.addon.getMlTrainingStatus());
  ipcMain.handle(IPC_CHANNELS.ML_DELETE_ALL_DATA, () => native.addon.deleteAllMlData());

  // ── ML Features: VAD Training ──

  ipcMain.handle(IPC_CHANNELS.VAD_SAVE_SAMPLE, (_e, features: string, label: string, corrected: boolean, sessionId?: string) =>
    native.addon.saveVadTrainingSample(features, label, corrected, sessionId ?? null)
  );
  ipcMain.handle(IPC_CHANNELS.VAD_GET_SAMPLES, (_e, limit: number) => native.addon.getVadTrainingSamples(limit));
  ipcMain.handle(IPC_CHANNELS.VAD_GET_SAMPLE_COUNT, () => native.addon.getVadSampleCount());
  ipcMain.handle(IPC_CHANNELS.VAD_DELETE_ALL_SAMPLES, () => native.addon.deleteAllVadSamples());

  // ── ML Features: Intent Training ──

  ipcMain.handle(IPC_CHANNELS.INTENT_SAVE_SAMPLE, (_e, transcript: string, intent?: string, entities?: string, conf?: number, entryId?: string) =>
    native.addon.saveIntentTrainingSample(transcript, intent ?? null, entities ?? null, conf ?? null, entryId ?? null)
  );
  ipcMain.handle(IPC_CHANNELS.INTENT_GET_SAMPLES, (_e, limit: number) => native.addon.getIntentTrainingSamples(limit));
  ipcMain.handle(IPC_CHANNELS.INTENT_GET_CORRECTION_COUNT, () => native.addon.getIntentCorrectionCount());
  ipcMain.handle(IPC_CHANNELS.INTENT_LOG_ROUTING, (_e, screen: string, intent: string, route: string, entryId?: string) =>
    native.addon.logVoiceRouting(screen, intent, route, entryId ?? null)
  );

  // ── ML Features: Meeting Sessions ──

  ipcMain.handle(IPC_CHANNELS.MEETING_CREATE, () => native.addon.createMeetingSession());
  // RAG: re-chunk on every mutation that changes meeting content. MEETING_END
  // seals the summary + transcript; MEETING_SET_STRUCTURED_OUTPUT lands the
  // generated notes (rerun on every regenerate); MEETING_SET_TITLE updates the
  // citation label. Fire-and-forget — chunker runs in a microtask so it
  // doesn't block the user-visible save.
  const scheduleMeetingChunkRefresh = (id: string) => {
    queueMicrotask(() => {
      try {
        native.addon.ragChunkMeeting?.(id);
      } catch (err) {
        console.warn(`[ipc] chunk refresh for meeting ${id} failed:`, err);
      }
    });
  };
  ipcMain.handle(IPC_CHANNELS.MEETING_END, (_e, id: string, speakers: number, summary?: string, items?: string, duration?: number, entryIds?: string) => {
    const r = native.addon.endMeetingSession(id, speakers, summary ?? null, items ?? null, duration ?? 0, entryIds ?? null);
    scheduleMeetingChunkRefresh(id);
    return r;
  });
  ipcMain.handle(IPC_CHANNELS.MEETING_GET, (_e, id: string) => native.addon.getMeetingSession(id));
  ipcMain.handle(IPC_CHANNELS.MEETING_LIST, (_e, limit: number, offset: number) => native.addon.listMeetingSessions(limit, offset));
  ipcMain.handle(IPC_CHANNELS.MEETING_DELETE, (_e, id: string) => {
    try {
      native.addon.ragDeleteChunksForSource?.('meeting', id);
    } catch (err) {
      console.warn(`[ipc] chunk delete for meeting ${id} failed:`, err);
    }
    return native.addon.deleteMeetingSession(id);
  });
  ipcMain.handle(IPC_CHANNELS.MEETING_GET_PARTICIPANTS, (_e, id: string) =>
    native.getMeetingParticipants(id),
  );

  // ── TF.js Infrastructure ──

  ipcMain.handle(IPC_CHANNELS.GET_MODELS_DIR, () => {
    return process.env.IRONMIC_MODELS_DIR || '';
  });

  // ── Model management (delete / redownload / disk usage / open folder) ──

  // Open the models folder in Finder/Explorer. Create it first since it may
  // not exist on a fresh install before any download has happened.
  ipcMain.handle(IPC_CHANNELS.OPEN_MODELS_DIRECTORY, async () => {
    const dir = resolveModelsDirForIpc();
    if (!dir) throw new Error('Models directory is not configured');
    fs.mkdirSync(dir, { recursive: true });
    const result = await shell.openPath(dir);
    if (result) throw new Error(result); // shell.openPath returns '' on success
    return { ok: true, path: dir };
  });

  ipcMain.handle(IPC_CHANNELS.GET_ENGINE_DISK_USAGE, (_e, engineId: string) => {
    assertString(engineId, 'engineId');
    const files = getEngineFiles(engineId);
    let totalBytes = 0;
    const entries = files.map((f) => {
      let bytes = 0;
      let exists = false;
      if (f.absolutePath) {
        try {
          const st = fs.statSync(f.absolutePath);
          if (st.isFile()) {
            bytes = st.size;
            exists = true;
          }
        } catch { /* missing file → bytes=0, exists=false */ }
      }
      totalBytes += bytes;
      return { relativePath: f.relativePath, bytes, exists };
    });
    const result: {
      totalBytes: number;
      files: Array<{ relativePath: string; bytes: number; exists: boolean }>;
      bundledAvailable?: boolean;
    } = { totalBytes, files: entries };
    if (engineId === 'moonshine-base') {
      result.bundledAvailable = isMoonshineBundleAvailable();
    }
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.DELETE_ENGINE_FILES, (_e, engineId: string) => {
    assertString(engineId, 'engineId');
    return deleteEngineFilesImpl(engineId);
  });

  // Re-download begins by deleting the existing files, so it must also reject
  // when invoked against the active engine — re-using deleteEngineFilesImpl
  // gives us that guard for free.
  ipcMain.handle(IPC_CHANNELS.REDOWNLOAD_ENGINE, async (_e, engineId: string) => {
    assertString(engineId, 'engineId');
    deleteEngineFilesImpl(engineId);
    const window = BrowserWindow.getFocusedWindow();
    return downloadTranscriptionEngine(engineId, window);
  });

  // ── Manual Model Import ──

  // After a successful Whisper-model import we reload the engine and clear
  // any "model missing" banner the renderer may be showing. Without this, the
  // user has to restart the app for the just-imported model to actually be
  // picked up — which is exactly the failure mode that makes "I uploaded the
  // model but dictation still doesn't work" feel unsolvable.
  const isWhisperModel = (modelId?: string) => !!modelId && (modelId === 'whisper-large-v3-turbo' || modelId.startsWith('whisper-'));
  const refreshWhisperAfterImport = (result: any) => {
    if (!result || !isWhisperModel(result.modelId)) return result;
    void Promise.resolve().then(() => {
      try {
        native.loadWhisperModel();
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            // Empty payload acts as "clear the banner" when the renderer sees
            // permanent === false and message blank.
            win.webContents.send('ironmic:whisper-load-failed', { message: '', permanent: false });
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('ironmic:whisper-load-failed', { message, permanent: false });
          }
        }
      }
    });
    return result;
  };

  // After a TTS-model import we (1) defensively stop any in-flight playback
  // before swapping the engine, (2) idempotently copy bundled voices, and
  // (3) await ttsLoadModel so a load failure becomes the import failure.
  // Throws on engine load failure — surfaces the precise Rust error (now
  // path-bearing) through the existing import error path. We do NOT trigger
  // voice downloads here; if voices are still missing the next readiness
  // check surfaces the Repair CTA.
  const isTtsModel = (modelId?: string) => modelId === 'tts-model';
  const refreshTtsAfterImport = async (result: any) => {
    if (!result || !isTtsModel(result.modelId)) return result;
    try {
      try { native.addon.ttsStop(); } catch { /* ignore — playback may not be active */ }
      ensureBundledVoices();
      native.addon.ttsLoadModel();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`TTS engine reload failed after import: ${message}`);
    }
    return result;
  };

  ipcMain.handle(IPC_CHANNELS.IMPORT_MODEL, async () => {
    const window = BrowserWindow.getFocusedWindow();
    return refreshWhisperAfterImport(await refreshTtsAfterImport(await importModelFile(window)));
  });
  ipcMain.handle('ironmic:get-importable-models', () => {
    return JSON.stringify(getImportableModels());
  });
  ipcMain.handle(IPC_CHANNELS.IMPORT_MODEL_FROM_PATH, async (_event, filePath: string, sectionFilter: string) => {
    return refreshWhisperAfterImport(await refreshTtsAfterImport(await importModelFromPath(filePath, sectionFilter)));
  });
  ipcMain.handle(IPC_CHANNELS.IMPORT_MULTI_PART_MODEL, async () => {
    const window = BrowserWindow.getFocusedWindow();
    return refreshWhisperAfterImport(await refreshTtsAfterImport(await importMultiPartModel(window)));
  });
  // Moonshine engines: same end-to-end flow as Whisper import — open dialog,
  // copy files, then reload the active engine so the user can `Switch` to it
  // without restarting the app.
  ipcMain.handle('ironmic:import-moonshine-engine', async (_e, engineId: string) => {
    assertString(engineId, 'engineId');
    const window = BrowserWindow.getFocusedWindow();
    const result = await importMoonshineEngine(window, engineId);
    if (result) {
      // If the user is already on this engine, reload it so the freshly-imported
      // files take effect immediately. Otherwise leave their current engine alone.
      try {
        const active = native.getTranscriptionEngine();
        if (active === engineId) native.loadWhisperModel();
      } catch (err) {
        console.warn('[ipc] Engine reload after Moonshine import failed:', err);
      }
    }
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.OPEN_EXTERNAL, (_event, url: string) => {
    // Only allow opening known model download domains
    try {
      const parsed = new URL(url);
      const allowed = ['huggingface.co', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'existential.audio', 'vb-audio.com'];
      if (allowed.some(d => parsed.hostname === d || parsed.hostname.endsWith('.' + d))) {
        const { shell } = require('electron');
        shell.openExternal(url);
      }
    } catch { /* ignore invalid URLs */ }
  });

  // ── Audio Input ──

  ipcMain.handle(IPC_CHANNELS.LIST_AUDIO_DEVICES, () => {
    return native.listAudioDevices();
  });
  ipcMain.handle(IPC_CHANNELS.GET_CURRENT_AUDIO_DEVICE, () => {
    return native.getCurrentAudioDevice();
  });
  ipcMain.handle(IPC_CHANNELS.CHECK_MIC_PERMISSION, async () => {
    // systemPreferences.getMediaAccessStatus('microphone') works on both
    // macOS and Windows (Electron 17+). On Windows it reflects the
    // Settings > Privacy > Microphone toggle. Hardcoding 'granted' here
    // hid real denial states on Windows.
    const { systemPreferences } = require('electron');
    if ((process.platform === 'darwin' || process.platform === 'win32')
        && typeof systemPreferences.getMediaAccessStatus === 'function') {
      return systemPreferences.getMediaAccessStatus('microphone');
    }
    return 'granted';
  });

  // ── Meeting Templates ──

  ipcMain.handle(IPC_CHANNELS.TEMPLATE_CREATE, (_event, name: string, meetingType: string, sections: string, llmPrompt: string, displayLayout: string) => {
    return native.createMeetingTemplate(name, meetingType, sections, llmPrompt, displayLayout);
  });
  ipcMain.handle(IPC_CHANNELS.TEMPLATE_GET, (_event, id: string) => {
    return native.getMeetingTemplate(id);
  });
  ipcMain.handle(IPC_CHANNELS.TEMPLATE_LIST, () => {
    return native.listMeetingTemplates();
  });
  ipcMain.handle(IPC_CHANNELS.TEMPLATE_UPDATE, (_event, id: string, name: string, meetingType: string, sections: string, llmPrompt: string, displayLayout: string) => {
    return native.updateMeetingTemplate(id, name, meetingType, sections, llmPrompt, displayLayout);
  });
  ipcMain.handle(IPC_CHANNELS.TEMPLATE_DELETE, (_event, id: string) => {
    return native.deleteMeetingTemplate(id);
  });
  ipcMain.handle(IPC_CHANNELS.MEETING_CREATE_WITH_TEMPLATE, (_event, templateId: string | null, detectedApp: string | null) => {
    return native.createMeetingSessionWithTemplate(templateId ?? undefined, detectedApp ?? undefined);
  });
  ipcMain.handle(IPC_CHANNELS.MEETING_SET_STRUCTURED_OUTPUT, (_event, id: string, structuredOutput: string) => {
    const r = native.setMeetingStructuredOutput(id, structuredOutput);
    // Structured output carries the AI-generated sections that drive most
    // Knowledge Q&A meeting hits; re-chunk so the next retrieval reflects
    // the new content (e.g. after a "Regenerate notes" run).
    scheduleMeetingChunkRefresh(id);
    return r;
  });

  // ── Meeting Recording (Granola-style chunk loop) ──

  ipcMain.handle(IPC_CHANNELS.MEETING_START_RECORDING, async (_event, sessionId: string, deviceName?: string | null, chunkIntervalS?: number, hostDisplayName?: string | null) => {
    assertString(sessionId, 'sessionId');
    // If the renderer didn't pass an interval, read the user's configured value
    // from settings; fall back to 15s. Clamp to [10, 60] — shorter hurts Whisper
    // accuracy, longer hurts the live-summary cadence.
    let interval = chunkIntervalS;
    if (typeof interval !== 'number' || !Number.isFinite(interval)) {
      try {
        const stored = native.getSetting('meeting_chunk_interval_s');
        const parsed = stored ? parseInt(stored, 10) : NaN;
        interval = Number.isFinite(parsed) ? parsed : 15;
      } catch {
        interval = 15;
      }
    }
    interval = Math.max(10, Math.min(60, Math.round(interval)));
    await meetingRecorder.startMeetingRecording(sessionId, deviceName, interval, hostDisplayName ?? null);
    // Kick off the live-summary stream for this session.
    try { liveSummarizer.start(sessionId); }
    catch (err) { console.warn('[ipc] liveSummarizer.start failed:', err); }
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_STOP_RECORDING, async () => {
    // Order matters:
    //   1. Stop the recorder first — this processes the final chunk and
    //      emits one last segment via the listener, which the LiveSummarizer
    //      picks up. Also runs diarization on the transcript.
    //   2. Flush the summarizer — waits for any in-flight pass to complete
    //      AND does one final pass covering the last segment + user notes.
    //   3. Only then actually stop() the summarizer (teardown).
    const recorderResult = await meetingRecorder.stopMeetingRecording();
    let liveSummary = '';
    let liveInsufficient = false;
    try {
      const flushed = await liveSummarizer.flush();
      liveSummary = flushed.summary;
      liveInsufficient = flushed.insufficient;
    } catch (err) {
      console.warn('[ipc] liveSummarizer.flush failed:', err);
    } finally {
      try { liveSummarizer.stop(); } catch { /* noop */ }
    }
    return { ...recorderResult, liveSummary, liveInsufficient };
  });

  // Returns the live recording state so the renderer can resync after a
  // component remount (e.g. navigate away mid-meeting → navigate back).
  ipcMain.handle('ironmic:get-meeting-recording-state', () =>
    meetingRecorder.getState(),
  );

  // Self-mute toggle for the active meeting. The renderer passes the
  // sessionId it thinks is active so we can reject stale events from a
  // previous meeting. Recorder validates against its internal state.sessionId.
  ipcMain.handle(IPC_CHANNELS.MEETING_SET_MIC_MUTED, (_event, sessionId: string, muted: boolean) => {
    assertString(sessionId, 'sessionId');
    if (typeof muted !== 'boolean') throw new Error('muted must be a boolean');
    meetingRecorder.setMicMuted(sessionId, muted);
  });

  // ── Streaming dictation (near-real-time, chunked) ──
  // Wrapped in try/catch so the renderer always gets a structured error
  // instead of the opaque "Error invoking remote method" wrapper. Forge
  // mode in particular needs the underlying cause visible in the bar.
  ipcMain.handle(IPC_CHANNELS.DICTATION_STREAM_START, async (_evt, rawOpts?: { source?: string }) => {
    // Whitelist source from untrusted renderer input; default 'notes' to
    // preserve legacy callers that pass nothing.
    const ALLOWED: ReadonlyArray<'notes' | 'forge' | 'ai-chat'> = ['notes', 'forge', 'ai-chat'];
    const source = (rawOpts && ALLOWED.includes(rawOpts.source as any))
      ? (rawOpts.source as 'notes' | 'forge' | 'ai-chat')
      : 'notes';
    const opts = { source };
    try {
      return await dictationStreamer.start(opts);
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.error('[ipc] dictation-stream-start failed:', msg, err?.stack);
      // Recovery: if the streamer thinks it's already active but isn't
      // really, try to reset and start once more before surfacing the error.
      if (msg.includes('already active')) {
        try {
          await dictationStreamer.stop().catch(() => {});
          if (typeof native.addon?.resetPipelineState === 'function') {
            native.addon.resetPipelineState();
          }
          return await dictationStreamer.start(opts);
        } catch (retryErr: any) {
          throw new Error(`stream-start (retry): ${retryErr?.message || retryErr}`);
        }
      }
      throw new Error(`stream-start: ${msg}`);
    }
  });
  ipcMain.handle(IPC_CHANNELS.DICTATION_STREAM_STOP, async () => {
    try {
      return await dictationStreamer.stop();
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.error('[ipc] dictation-stream-stop failed:', msg, err?.stack);
      throw new Error(`stream-stop: ${msg}`);
    }
  });

  // Fire-and-forget: renderer tells the summarizer that user notes changed.
  // The summarizer debounces and will re-run, picking up the new notes from
  // the DB (YourNotesPanel persists them via meetingSetStructuredOutput first).
  // ALSO: when this machine is part of a collaborative meeting room, route
  // the latest html through the room transport so participants stay in sync.
  ipcMain.on(IPC_CHANNELS.MEETING_USER_NOTES_CHANGED, (_e, sessionId: string) => {
    if (typeof sessionId !== 'string' || !sessionId) return;
    try { liveSummarizer.notifyUserNotesChanged(sessionId); }
    catch (err) { console.warn('[ipc] notifyUserNotesChanged failed:', err); }

    // Read the freshly-persisted html out of the host DB and forward through
    // whichever transport this machine is on. Read errors / missing rows
    // short-circuit silently — solo mode and pre-room-start typing are valid.
    let html = '';
    try {
      const raw = native.addon.getMeetingSession(sessionId);
      if (raw && raw !== 'null') {
        const session = JSON.parse(raw);
        const structuredRaw = session?.structured_output;
        if (typeof structuredRaw === 'string') {
          const structured = JSON.parse(structuredRaw);
          if (typeof structured?.userNotes === 'string') html = structured.userNotes;
        }
      }
    } catch { /* solo mode, no notes yet — fine */ }

    try {
      if (meetingRoomServer.isActive() && meetingRoomServer.getInfo().sessionId === sessionId) {
        meetingRoomServer.applyHostNotesUpdate(html);
      } else if (meetingRoomClient.isConnected() && meetingRoomClient.getInfo().sessionId === sessionId) {
        meetingRoomClient.sendNotesUpdate(html);
      }
    } catch (err) {
      console.warn('[ipc] notes-update transport failed:', (err as Error)?.message);
    }
  });

  // ── Meeting Room (LAN multi-user collaboration) ──

  ipcMain.handle(IPC_CHANNELS.MEETING_ROOM_HOST_START, async (_e, sessionId: string, hostName: string, templateId?: string | null) => {
    assertString(sessionId, 'sessionId');
    return meetingRoomServer.start({
      sessionId,
      hostName: hostName ?? 'Host',
      templateId: templateId ?? null,
    });
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_ROOM_HOST_STOP, async () => {
    await meetingRoomServer.stop();
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_ROOM_HOST_INFO, async () => {
    return meetingRoomServer.getInfo();
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_ROOM_JOIN, async (_e, opts: {
    hostIp: string;
    hostPort: number;
    roomCode: string;
    displayName: string;
    deviceName?: string | null;
  }) => {
    assertString(opts?.hostIp, 'hostIp');
    assertString(opts?.roomCode, 'roomCode');
    assertString(opts?.displayName, 'displayName');
    if (typeof opts.hostPort !== 'number') throw new Error('hostPort must be a number');
    return meetingRoomClient.connect(opts);
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_ROOM_LEAVE, async () => {
    await meetingRoomClient.disconnect();
    return { ok: true };
  });

  // Transport-only leave: closes WebSocket but PRESERVES the participant's
  // localSessionId / lastSummary / lastTitle so the renderer's
  // finalizeAndExitMeeting can use them. Renderer MUST follow up with
  // MEETING_ROOM_PARTICIPANT_FINALIZED once finalize is done. Renderer-driven
  // finalize replaces the legacy MEETING_ROOM_LEAVE flow that double-stopped
  // the recorder.
  ipcMain.handle(IPC_CHANNELS.MEETING_ROOM_LEAVE_TRANSPORT, async () => {
    await meetingRoomClient.disconnectTransport();
    return { ok: true };
  });

  // Renderer signals "I'm done finalizing the local mirror session — you can
  // wipe the durable client state now". 30-second watchdog in MeetingRoomClient
  // handles the case where this never arrives (renderer crash).
  ipcMain.handle(IPC_CHANNELS.MEETING_ROOM_PARTICIPANT_FINALIZED, async () => {
    meetingRoomClient.participantFinalized();
    return { ok: true };
  });

  // Host-only: explicit final-summary broadcast just before stop(). The
  // host renderer awaits meetingStopRecording() (which flushes the live
  // summarizer), then fires this so participants see the final summary
  // BEFORE the meeting_ended packet arrives. meeting_ended also carries
  // it as a durable fallback.
  ipcMain.handle(IPC_CHANNELS.MEETING_ROOM_BROADCAST_FINAL_SUMMARY, async (_e, sessionId: string, summary: string) => {
    assertString(sessionId, 'sessionId');
    if (typeof summary !== 'string' || summary.trim().length === 0) return { ok: false };
    meetingRoomServer.broadcastFinalSummary(sessionId, summary);
    return { ok: true };
  });

  // Set the live meeting title (host-only authority).
  // Accept paths:
  //   (a) solo mode  — server NOT active, client NOT connected
  //   (b) host mode  — server.isActive() && server.sessionId === sessionId
  // Reject path:
  //   (c) participant — client.isConnected()  → 403 (UI is also disabled, but
  //                                              this is the security boundary)
  ipcMain.handle(IPC_CHANNELS.MEETING_SET_TITLE, async (_e, sessionId: string, title: string | null) => {
    assertString(sessionId, 'sessionId');
    const safeTitle = typeof title === 'string' ? title : null;

    const serverActive = meetingRoomServer.isActive();
    const serverInfo = serverActive ? meetingRoomServer.getInfo() : null;
    const isHost = serverActive && serverInfo?.sessionId === sessionId;
    const isParticipant = meetingRoomClient.isConnected();
    const isSolo = !serverActive && !isParticipant;

    if (!isHost && !isSolo) {
      throw new Error('Only the host (or solo user) may set the meeting title');
    }

    if (isHost) {
      // Host path: server owns persistence + broadcast.
      meetingRoomServer.setTitle(safeTitle);
    } else {
      // Solo path: write directly to structured_output, no broadcast.
      try {
        let merged: Record<string, unknown> = {};
        const raw = native.addon.getMeetingSession(sessionId);
        if (raw && raw !== 'null') {
          const session = JSON.parse(raw);
          const structuredRaw = session?.structured_output;
          if (typeof structuredRaw === 'string') {
            const parsed = JSON.parse(structuredRaw);
            if (parsed && typeof parsed === 'object') merged = parsed as Record<string, unknown>;
          }
        }
        if (safeTitle === null || safeTitle.length === 0) {
          // Treat blank as "no authored title" — clear both fields so
          // resolveMeetingTitle falls back to Meeting #N.
          delete merged.title;
          delete (merged as any).titleSource;
        } else {
          merged.title = safeTitle.slice(0, 256);
          // Live edit during recording is always user-authored.
          (merged as any).titleSource = 'user';
        }
        native.setMeetingStructuredOutput(sessionId, JSON.stringify(merged));
      } catch (err) {
        console.warn('[ipc] MEETING_SET_TITLE solo persist failed:', err);
      }
    }
    // Title is the most visible citation label in RAG results — re-chunk so
    // the next retrieval shows the updated label. Both paths (host server
    // broadcast and solo direct write) bottom out at structured_output, but
    // the host path bypasses MEETING_SET_STRUCTURED_OUTPUT's hook, so we
    // schedule here unconditionally.
    scheduleMeetingChunkRefresh(sessionId);
    return { ok: true };
  });

  // Indexed sequence lookup — replaces the renderer's full-table JSON scan
  // on every meeting-create.
  ipcMain.handle(IPC_CHANNELS.MEETING_GET_MAX_SEQUENCE, async () => {
    return native.getMaxMeetingSequence();
  });

  // ── Transcript Segments ──
  // These handlers fall back to in-memory storage (meetingRecorder) when the
  // transcript_segments SQLite table is not yet available in the compiled addon.

  ipcMain.handle(IPC_CHANNELS.ADD_TRANSCRIPT_SEGMENT, (_event, sessionId: string, speakerLabel: string | null, startMs: number, endMs: number, text: string, source: string) => {
    assertString(sessionId, 'sessionId');
    assertString(text, 'text');
    if (typeof native.addon.addTranscriptSegment === 'function') {
      return native.addon.addTranscriptSegment(sessionId, speakerLabel, startMs, endMs, text, source);
    }
    return JSON.stringify({ id: `seg-${Date.now()}`, session_id: sessionId, speaker_label: speakerLabel, start_ms: startMs, end_ms: endMs, text, source, participant_id: null, confidence: null, created_at: new Date().toISOString() });
  });

  ipcMain.handle(IPC_CHANNELS.LIST_TRANSCRIPT_SEGMENTS, (_event, sessionId: string) => {
    assertString(sessionId, 'sessionId');
    if (typeof native.addon.listTranscriptSegments === 'function') {
      return native.addon.listTranscriptSegments(sessionId);
    }
    // Fall back to in-memory segments from the meeting recorder
    return JSON.stringify(meetingRecorder.getSegments().filter(s => s.session_id === sessionId));
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_SEGMENT_SPEAKER, (_event, id: string, speakerLabel: string) => {
    assertString(id, 'id');
    assertString(speakerLabel, 'speakerLabel');
    if (typeof native.addon.updateSegmentSpeaker === 'function') {
      return native.addon.updateSegmentSpeaker(id, speakerLabel);
    }
  });

  ipcMain.handle(IPC_CHANNELS.ASSEMBLE_FULL_TRANSCRIPT, (_event, sessionId: string) => {
    assertString(sessionId, 'sessionId');
    if (typeof native.addon.assembleFullTranscript === 'function') {
      return native.addon.assembleFullTranscript(sessionId);
    }
    // Fall back to assembling from in-memory segments
    return meetingRecorder.getSegments()
      .filter(s => s.session_id === sessionId)
      .sort((a, b) => a.start_ms - b.start_ms)
      .map(s => s.text)
      .join('\n\n');
  });

  ipcMain.handle(IPC_CHANNELS.START_RECORDING_FROM_DEVICE, (_event, deviceName: string) => {
    assertString(deviceName, 'deviceName');
    if (typeof native.addon.startRecordingFromDevice === 'function') {
      return native.addon.startRecordingFromDevice(deviceName);
    }
    // Fall back to default mic
    return native.addon.startRecording();
  });

  // ── Export / Sharing ──

  ipcMain.handle(IPC_CHANNELS.COPY_HTML_CLIPBOARD, (_event, html: string, fallbackText: string) => {
    return native.copyHtmlToClipboard(html, fallbackText);
  });
  ipcMain.handle(IPC_CHANNELS.EXPORT_ENTRY_MARKDOWN, (_event, id: string) => {
    return native.exportEntryMarkdown(id);
  });
  ipcMain.handle(IPC_CHANNELS.EXPORT_ENTRY_JSON, (_event, id: string) => {
    return native.exportEntryJson(id);
  });
  ipcMain.handle(IPC_CHANNELS.EXPORT_ENTRY_PLAIN_TEXT, (_event, id: string) => {
    return native.exportEntryPlainText(id);
  });
  ipcMain.handle(IPC_CHANNELS.EXPORT_MEETING_MARKDOWN, (_event, id: string) => {
    return native.exportMeetingMarkdown(id);
  });
  ipcMain.handle(IPC_CHANNELS.TEXT_TO_HTML, (_event, text: string) => {
    return native.textToHtml(text);
  });
  ipcMain.handle(IPC_CHANNELS.SAVE_FILE_DIALOG, async (_event, content: string, defaultName: string, filtersJson: string) => {
    const { dialog } = require('electron');
    const fs = require('fs');
    const filters = JSON.parse(filtersJson);
    const result = await dialog.showSaveDialog({
      defaultPath: defaultName,
      filters,
    });
    if (result.canceled || !result.filePath) return false;
    await fs.promises.writeFile(result.filePath, content, 'utf-8');
    return true;
  });

  // ── BlackHole (macOS system audio capture) ──

  ipcMain.handle(IPC_CHANNELS.BLACKHOLE_CHECK, async (_e, deviceListJson?: string) => {
    return checkBlackHoleInstalled(deviceListJson);
  });

  ipcMain.handle(IPC_CHANNELS.BLACKHOLE_INSTALL, async () => {
    // Run installation; stream progress via push events back to renderer.
    await installBlackHole((progress) => {
      broadcastInstallProgress(progress);
    });
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.BLACKHOLE_OPEN_AUDIO_MIDI_SETUP, () => {
    openAudioMidiSetup();
    return { ok: true };
  });

  // ── Notes Collaboration (finished meetings, LAN) ──

  ipcMain.handle(IPC_CHANNELS.MEETING_COLLAB_START, async (
    _e,
    sessionId: string,
    hostName: string,
    notes: string,
    version?: number,
  ) => {
    assertString(sessionId, 'sessionId');
    return meetingNotesCollabServer.start({ sessionId, hostName: hostName ?? 'Host', notes, version });
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_COLLAB_STOP, async () => {
    await meetingNotesCollabServer.stop();
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_COLLAB_NOTIFY_SAVED, (_e, notes: string, savedBy: string) => {
    assertString(notes, 'notes');
    meetingNotesCollabServer.notifyNotesSaved(notes, savedBy ?? 'Host');
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_COLLAB_NOTIFY_DRAFT, (_e, content: string, senderName: string) => {
    assertString(content, 'content');
    meetingNotesCollabServer.notifyDraft(content, senderName ?? 'Host');
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_COLLAB_JOIN, async (_e, opts: {
    hostIp: string;
    hostPort: number;
    sessionCode: string;
    displayName: string;
  }) => {
    assertString(opts?.hostIp, 'hostIp');
    assertString(opts?.sessionCode, 'sessionCode');
    assertString(opts?.displayName, 'displayName');
    if (typeof opts.hostPort !== 'number') throw new Error('hostPort must be a number');
    return meetingNotesCollabClient.connect(opts);
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_COLLAB_LEAVE, async () => {
    await meetingNotesCollabClient.disconnect();
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_COLLAB_SAVE_NOTES, (_e, content: string) => {
    assertString(content, 'content');
    meetingNotesCollabClient.saveNotes(content);
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_COLLAB_SEND_DRAFT, (_e, content: string) => {
    meetingNotesCollabClient.sendDraft(content);
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_COLLAB_OPEN_FIREWALL_SETTINGS, () => {
    meetingNotesCollabServer.openMacFirewallSettings();
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.MEETING_COLLAB_REQUEST_FIREWALL_ELEVATION, async () => {
    return meetingNotesCollabServer.requestMacFirewallElevation();
  });

  // ── Forge mode handlers ─────────────────────────────────────────────────
  // The Forge bar is a separate BrowserWindow; main owns the lifecycle. The
  // Rust engine (audio capture, STT, dictionary) runs in this same process
  // and is shared with main — Forge is a thin client of the same pipeline.

  ipcMain.handle(IPC_CHANNELS.FORGE_ENTER, () => {
    const main = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.id !== undefined,
    );
    enterForgeMode(main || null);
  });

  ipcMain.handle(IPC_CHANNELS.FORGE_EXIT, () => {
    // The first non-Forge window is the main window. We can't import it
    // directly without a circular dep with index.ts, so we look it up.
    const main = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.getTitle() === 'IronMic',
    );
    exitForgeMode(main || null);
  });

  // Single source of truth for AX gating — uses macOS's refreshing
  // AXIsProcessTrustedWithOptions via Electron's bridge. Returns true on
  // non-mac platforms.
  const isAxTrustedNow = (): boolean => {
    if (process.platform !== 'darwin') return true;
    try {
      return systemPreferences.isTrustedAccessibilityClient(false);
    } catch {
      return false;
    }
  };

  /**
   * Post Cmd+V on macOS via AppleScript / System Events. PRIMARY paste path
   * on macOS — `enigo`'s CGEventPost path drops the modifier flag in race
   * conditions and the receiving app sees a plain "v" character. AppleScript
   * routes through `System Events`, which builds the synthetic event with
   * the modifier baked in correctly.
   *
   * Requires Accessibility permission for the running process — same gate
   * that the AX check uses.
   */
  const pasteViaAppleScript = (): Promise<{ ok: true } | { ok: false; error: string }> => {
    return new Promise((resolve) => {
      execFile(
        '/usr/bin/osascript',
        ['-e', 'tell application "System Events" to keystroke "v" using command down'],
        { timeout: 2000 },
        (err, _stdout, stderr) => {
          if (err) {
            const msg = stderr?.toString().trim() || err.message || 'osascript failed';
            resolve({ ok: false, error: msg });
            return;
          }
          resolve({ ok: true });
        },
      );
    });
  };

  /**
   * Windows equivalent: post Ctrl+V via PowerShell + WScript.Shell SendKeys.
   * SendKeys uses Windows' high-level keyboard automation which handles
   * modifier flags reliably (^ = Ctrl). We use this as the PRIMARY path
   * on Windows for parity with the AppleScript path on macOS, with `enigo`
   * (`SendInput`) as the fallback. SendInput on Windows is generally fine
   * but SendKeys has decades of compatibility with apps that intercept
   * raw input (Office, Teams, some banking sites).
   *
   * Note: SendKeys cannot inject into elevated windows from a non-elevated
   * process — same UIPI rule applies to enigo's SendInput, so this isn't
   * a regression.
   */
  const pasteViaSendKeys = (): Promise<{ ok: true } | { ok: false; error: string }> => {
    return new Promise((resolve) => {
      // Powershell -NoProfile keeps cold-start under ~150ms on warm machines.
      // The SendKeys "^v" syntax is unambiguous and doesn't need quoting tricks.
      const script =
        "$ws = New-Object -ComObject WScript.Shell; Start-Sleep -Milliseconds 30; $ws.SendKeys('^v')";
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: 3000, windowsHide: true },
        (err, _stdout, stderr) => {
          if (err) {
            const msg = stderr?.toString().trim() || err.message || 'powershell failed';
            resolve({ ok: false, error: msg });
            return;
          }
          resolve({ ok: true });
        },
      );
    });
  };

  ipcMain.handle(
    IPC_CHANNELS.FORGE_PASTE_TEXT,
    async (_e, text: string, restoreClipboard: boolean) => {
      assertString(text, 'text');
      assertMaxLength(text, 100_000, 'text');
      if (!isAxTrustedNow()) {
        console.warn('[forge] paste blocked — AX not granted');
        return { ok: false, error: 'accessibility-required' };
      }

      // ── 1. Capture prior clipboard text (for restore) ───────────────────
      const { clipboard } = require('electron') as typeof import('electron');
      let prior: string | null = null;
      if (restoreClipboard) {
        try {
          const t = clipboard.readText();
          if (t && typeof t === 'string') prior = t;
        } catch {
          // ignore — best-effort restore
        }
      }

      // ── 2. Write transcript to clipboard ────────────────────────────────
      try {
        clipboard.writeText(text);
      } catch (err: any) {
        return { ok: false, error: `clipboard.write: ${err?.message || err}` };
      }

      // Brief settle so the OS pasteboard generation count propagates to
      // any apps that sample asynchronously (Electron, Chromium-based).
      await new Promise((r) => setTimeout(r, 30));

      // ── 3. Trigger paste ────────────────────────────────────────────────
      // Per-platform primary path (the OS's blessed automation API) with
      // Rust+enigo as the universal fallback:
      //   macOS:   osascript "System Events keystroke v using command down"
      //   Windows: PowerShell WScript.Shell SendKeys "^v"
      //   Linux:   enigo (xdotool/Wayland virtual-keyboard underneath)
      let pasteOk = false;
      let pasteError: string | null = null;

      if (process.platform === 'darwin') {
        const r = await pasteViaAppleScript();
        if (r.ok) pasteOk = true;
        else pasteError = `applescript: ${r.error}`;
      } else if (process.platform === 'win32') {
        const r = await pasteViaSendKeys();
        if (r.ok) pasteOk = true;
        else pasteError = `sendkeys: ${r.error}`;
      }

      if (!pasteOk) {
        // Primary path failed (or Linux) — fall back to Rust + enigo.
        if (typeof native.addon?.pasteText === 'function') {
          try {
            // restoreClipboard=false: we already captured prior text in
            // step 1 and will restore in step 4. Don't double-handle.
            native.addon.pasteText(text, false);
            pasteOk = true;
          } catch (err: any) {
            const msg = err?.message || String(err);
            pasteError = pasteError ? `${pasteError}; enigo: ${msg}` : `enigo: ${msg}`;
          }
        } else if (!pasteError) {
          pasteError = 'paste-unavailable: rebuild rust-core with --features forge';
        }
      }

      // ── 4. Restore prior clipboard after a delay ────────────────────────
      if (pasteOk && prior !== null) {
        setTimeout(() => {
          try { clipboard.writeText(prior!); } catch { /* ignore */ }
        }, 500);
      }

      if (pasteOk) return { ok: true };
      console.warn('[forge] paste failed:', pasteError);
      return { ok: false, error: pasteError || 'unknown paste error' };
    },
  );

  ipcMain.handle(IPC_CHANNELS.FORGE_TYPE_TEXT, async (_e, text: string) => {
    assertString(text, 'text');
    assertMaxLength(text, 100_000, 'text');
    if (!isAxTrustedNow()) {
      console.warn('[forge] type blocked — AX not granted');
      return { ok: false, error: 'accessibility-required' };
    }
    try {
      if (typeof native.addon?.typeText !== 'function') {
        throw new Error('Forge type not available — rebuild rust-core with --features forge');
      }
      native.addon.typeText(text);
      return { ok: true };
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.warn('[forge] typeText threw:', msg);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(IPC_CHANNELS.FORGE_CHECK_ACCESSIBILITY, () => {
    if (process.platform !== 'darwin') return true;
    // Electron's `systemPreferences.isTrustedAccessibilityClient(prompt)` is
    // a thin wrapper around macOS's `AXIsProcessTrustedWithOptions` that
    // correctly handles Electron's bundle ID + code signature edge cases.
    // Calling it with prompt=false also triggers a TCC re-evaluation, so
    // grants applied while the process is running propagate without the
    // user having to relaunch IronMic.
    try {
      return systemPreferences.isTrustedAccessibilityClient(false);
    } catch (err) {
      console.warn('[forge] AX check via systemPreferences failed:', err);
      // Fall back to the Rust addon path if it's compiled in.
      if (typeof native.addon?.isAccessibilityTrusted === 'function') {
        try { return !!native.addon.isAccessibilityTrusted(); } catch { /* ignore */ }
      }
      return false;
    }
  });

  ipcMain.handle(IPC_CHANNELS.FORGE_OPEN_ACCESSIBILITY_PREFS, async () => {
    await openAccessibilityPrefs();
  });

  // Resize the bar between compact (64 px), expanded (150 px while
  // recording — shows live transcript preview), and the macOS permission
  // panel size. Renderer calls this when status or AX trust changes.
  // Accepts the legacy 'bar' alias for compact for safety.
  ipcMain.handle(
    'ironmic:forge-set-window-mode',
    (_e, mode: 'compact' | 'expanded' | 'permission' | 'bar') => {
      const normalized: 'compact' | 'expanded' | 'permission' =
        mode === 'permission' ? 'permission' : mode === 'expanded' ? 'expanded' : 'compact';
      setForgeWindowMode(normalized);
    },
  );

  // Forge polish — DIFFERENT from POLISH_TEXT. Cloud is allowed only when
  // BOTH global polish_allow_cloud AND forge_polish_allow_cloud are 'true'.
  // The global setting remains the upper bound; Forge can be stricter than
  // main but never looser. Honors `forge_polish_enabled` as a hard gate.
  ipcMain.handle(IPC_CHANNELS.FORGE_POLISH_TEXT, async (_e, rawText: string) => {
    assertString(rawText, 'rawText');
    assertMaxLength(rawText, MAX_PROMPT_LENGTH, 'rawText');

    let polishEnabled = false;
    let globalAllowCloud = false;
    let forgeAllowCloud = false;
    try { polishEnabled = native.getSetting('forge_polish_enabled') === 'true'; } catch {}
    try { globalAllowCloud = native.getSetting('polish_allow_cloud') === 'true'; } catch {}
    try { forgeAllowCloud = native.getSetting('forge_polish_allow_cloud') === 'true'; } catch {}

    if (!polishEnabled) {
      // Polish off — return text unchanged. Forge falls back to corrected
      // text on the renderer side.
      return rawText;
    }

    const allowCloud = globalAllowCloud && forgeAllowCloud;
    try {
      const result = await aiManager.polish(rawText, { allowCloud });
      return result.text;
    } catch (err: any) {
      // Renderer expects a string back. On failure, fall back to raw text.
      if (err?.message?.includes('Cleanup model not downloaded')) {
        return rawText;
      }
      throw err;
    }
  });

  // Renderer→main handshake fired on success or error so main can clear the
  // dictation owner and accept the next hotkey. Sent as `send` (no return)
  // since the renderer doesn't need to wait.
  ipcMain.on(IPC_CHANNELS.FORGE_DICTATION_COMPLETE, (_e, error?: string | null) => {
    if (error) {
      console.warn('[forge] dictation completed with error:', error);
    }
    clearForgeOwner();
  });

  // Theme sync across windows. Centralizes resolution: when a renderer
  // calls broadcastTheme(setting), main resolves 'system' → light/dark via
  // Electron's nativeTheme and broadcasts the APPLIED value. Renderers
  // never have to do system-resolution themselves — that's prone to flake
  // on transparent BrowserWindows.
  const resolveApplied = (setting: string): 'light' | 'dark' => {
    if (setting === 'dark') return 'dark';
    if (setting === 'light') return 'light';
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  };

  const broadcastApplied = (applied: 'light' | 'dark'): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        w.webContents.send('ironmic:theme-changed', applied);
      }
    }
  };

  ipcMain.handle('ironmic:broadcast-theme', (_e, theme: string) => {
    broadcastApplied(resolveApplied(theme));
  });

  // When the OS prefers-color-scheme flips (user toggles dark mode in
  // Control Center / System Settings) AND we're on the 'system' setting,
  // re-broadcast so all windows update.
  nativeTheme.on('updated', () => {
    let setting: string | null = null;
    try { setting = native.getSetting('theme'); } catch { /* ignore */ }
    if (setting && setting !== 'system') return; // explicit theme — ignore OS flip
    broadcastApplied(nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  });

  // Suppress unused-import lint: setForgeOwnerProcessing / isForgeMode are
  // referenced from main/index.ts; importing them here keeps the module
  // graph honest (one place wires Forge IPC, one place dispatches hotkeys).
  void setForgeOwnerProcessing;
  void isForgeMode;

  console.log('[ipc-handlers] All IPC handlers registered');
}

/** Parse LLM topic classification response into [topic, confidence] pairs. */
function parseTopicResponse(response: string): Array<[string, number]> {
  const trimmed = response.trim();

  // Find JSON array in response
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      const topics: string[] = JSON.parse(trimmed.slice(start, end + 1));
      return topics.filter((t) => typeof t === 'string' && t.length > 0).map((t) => [t, 1.0]);
    } catch { /* fall through */ }
  }

  return [['General', 1.0]];
}
