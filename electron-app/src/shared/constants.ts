export const DEFAULT_HOTKEY = 'CommandOrControl+Shift+V';
export const APP_NAME = 'IronMic';
export const DB_NAME = 'ironmic.db';

export const WHISPER_MODEL_NAME = 'whisper-large-v3-turbo';
export const LLM_MODEL_NAME = 'mistral-7b-instruct-q4';

/**
 * Default transcription engine for new installs and upgrades from pre-Phase-1.
 *
 * Moonshine Base: ~146 MB ONNX model, ~150 ms latency per dictation chunk on
 * a typical Windows VDI without BLAS/GPU. Beats Whisper Tiny on accuracy
 * (6.65% vs 12.81% WER) at a fraction of Whisper Large v3 Turbo's size.
 * English only — users needing multilingual transcription should switch to
 * a Whisper variant in Settings → Audio → Transcription Engine.
 */
export const DEFAULT_TRANSCRIPTION_ENGINE = 'moonshine-base';

/**
 * Default transcription engine for *meetings* specifically. Meetings process
 * audio in 30 s+ chunks, so first-chunk latency doesn't matter — accuracy does.
 * Whisper Large v3 Turbo wins on accuracy for long-form multi-speaker audio
 * and is the recommended default. Users can override per-meeting via the gear
 * icon in the Meetings toolbar (stored in the `meeting_transcription_engine`
 * SQLite setting), or globally in Settings → Input.
 *
 * On meeting start, MeetingPage swaps `transcription_engine` to this value and
 * restores the prior value on meeting end so dictation reverts to the user's
 * chosen global engine (typically the faster Moonshine Base).
 */
export const DEFAULT_MEETING_TRANSCRIPTION_ENGINE = 'whisper-large-v3-turbo';

/**
 * Registry of supported transcription engines for the Settings UI dropdown.
 * The `id` matches the Rust `EngineKind::as_str()` and is what gets persisted
 * in the SQLite settings table under `transcription_engine`.
 */
export interface TranscriptionEngineMeta {
  id: string;
  label: string;
  /** Sub-label / tagline shown under the name in the dropdown. */
  description: string;
  /** Approximate first-chunk latency on a slow Windows VDI without GPU. */
  latencyHint: string;
  sizeLabel: string;
  /** BCP-47 language code(s). 'en' = English only. */
  languages: string[];
  /** Backend family — affects which other settings apply. */
  family: 'moonshine' | 'whisper';
  /** Model registry keys whose files must all be present to use this engine. */
  modelFileKeys: string[];
}

export const TRANSCRIPTION_ENGINES: TranscriptionEngineMeta[] = [
  {
    id: 'moonshine-base',
    label: 'Moonshine Base',
    description: 'Balanced. Better accuracy than Whisper Tiny at 1/10th the latency. Default.',
    latencyHint: '~150 ms / chunk',
    sizeLabel: '~146 MB',
    languages: ['en'],
    family: 'moonshine',
    modelFileKeys: ['moonshine-base-encoder', 'moonshine-base-decoder', 'moonshine-base-tokenizer'],
  },
  {
    id: 'whisper-base',
    label: 'Whisper Base (multilingual)',
    description: 'For non-English dictation. Slower than Moonshine on machines without BLAS/GPU.',
    latencyHint: '~3–8 s / chunk on VDI',
    sizeLabel: '~147 MB',
    languages: ['multilingual'],
    family: 'whisper',
    modelFileKeys: ['whisper-base'],
  },
  {
    id: 'whisper-small',
    label: 'Whisper Small (multilingual)',
    description: 'Higher accuracy multilingual. Best Whisper option for non-VDI machines.',
    latencyHint: '~5–15 s / chunk on VDI',
    sizeLabel: '~488 MB',
    languages: ['multilingual'],
    family: 'whisper',
    modelFileKeys: ['whisper-small'],
  },
  {
    id: 'whisper-medium',
    label: 'Whisper Medium (multilingual)',
    description: 'High-accuracy multilingual. Slow on CPU.',
    latencyHint: '~10–30 s / chunk on VDI',
    sizeLabel: '~769 MB',
    languages: ['multilingual'],
    family: 'whisper',
    modelFileKeys: ['whisper-medium'],
  },
  {
    id: 'whisper-large-v3-turbo',
    label: 'Whisper Large v3 Turbo (multilingual)',
    description: 'Highest accuracy. Recommended only with GPU acceleration.',
    latencyHint: '~30+ s / chunk on VDI',
    sizeLabel: '~1.5 GB',
    languages: ['multilingual'],
    family: 'whisper',
    modelFileKeys: ['whisper'],
  },
];

export const DEFAULT_SETTINGS = {
  hotkey_record: DEFAULT_HOTKEY,
  llm_cleanup_enabled: 'true',
  default_view: 'timeline',
  theme: 'system',
  whisper_model: WHISPER_MODEL_NAME,
  llm_model: LLM_MODEL_NAME,
  transcription_engine: DEFAULT_TRANSCRIPTION_ENGINE,
} as const;

export const IPC_CHANNELS = {
  // Audio
  START_RECORDING: 'ironmic:start-recording',
  STOP_RECORDING: 'ironmic:stop-recording',
  IS_RECORDING: 'ironmic:is-recording',

  // Streaming dictation (chunked near-real-time transcription)
  DICTATION_STREAM_START: 'ironmic:dictation-stream-start',
  DICTATION_STREAM_STOP: 'ironmic:dictation-stream-stop',
  DICTATION_STREAM_CHUNK: 'ironmic:dictation-stream-chunk',    // main → renderer push (committed)
  DICTATION_STREAM_DRAFT: 'ironmic:dictation-stream-draft',    // main → renderer push (live hypothesis, not persisted)
  DICTATION_STREAM_STATE: 'ironmic:dictation-stream-state',    // main → renderer push
  DICTATION_STREAM_END_OF_TURN: 'ironmic:dictation-stream-end-of-turn', // main → renderer push (silence-driven, ai-chat only)

  // Transcription
  TRANSCRIBE: 'ironmic:transcribe',
  POLISH_TEXT: 'ironmic:polish-text',
  POLISH_TEXT_DETAILED: 'ironmic:polish-text-detailed',
  POLISH_TEXT_LOCAL: 'ironmic:polish-text-local',
  // Generic LLM transport (caller-supplied system prompt). Used by
  // SummaryGenerator / MeetingTemplateEngine / IntentClassifier /
  // MeetingDetector — NOT polish callers (they keep POLISH_TEXT_*).
  // Live summary stays on its own llmSubprocess path for cancellation.
  GENERATE_TEXT: 'ironmic:generate-text',
  GENERATE_TEXT_LOCAL: 'ironmic:generate-text-local',
  // Markdown → { plainText, html, jsonString } projections from the main-side
  // sanitization pipeline. Renderer never imports the pipeline directly.
  CONVERT_MARKDOWN: 'ironmic:convert-markdown',

  // Entries
  CREATE_ENTRY: 'ironmic:create-entry',
  GET_ENTRY: 'ironmic:get-entry',
  UPDATE_ENTRY: 'ironmic:update-entry',
  DELETE_ENTRY: 'ironmic:delete-entry',
  LIST_ENTRIES: 'ironmic:list-entries',
  PIN_ENTRY: 'ironmic:pin-entry',
  ARCHIVE_ENTRY: 'ironmic:archive-entry',

  // Dictionary
  ADD_WORD: 'ironmic:add-word',
  REMOVE_WORD: 'ironmic:remove-word',
  LIST_DICTIONARY: 'ironmic:list-dictionary',
  /** Reload SQLite dictionary into the active engine. Cheap; called on
   *  boot and meeting start as a drift safety net. */
  REFRESH_TRANSCRIPTION_DICTIONARY: 'ironmic:refresh-transcription-dictionary',
  /** main → renderer broadcast fired after addWord/removeWord so
   *  renderer caches (useRecordingStore) refetch their term list. */
  DICTIONARY_CHANGED: 'ironmic:dictionary-changed',

  // Settings
  GET_SETTING: 'ironmic:get-setting',
  SET_SETTING: 'ironmic:set-setting',

  // Clipboard
  COPY_TO_CLIPBOARD: 'ironmic:copy-to-clipboard',

  // Hotkey & Pipeline
  REGISTER_HOTKEY: 'ironmic:register-hotkey',
  GET_PIPELINE_STATE: 'ironmic:get-pipeline-state',
  RESET_PIPELINE_STATE: 'ironmic:reset-pipeline-state',
  GET_MODEL_STATUS: 'ironmic:get-model-status',

  // Models
  DOWNLOAD_MODEL: 'ironmic:download-model',
  GET_DOWNLOAD_PROGRESS: 'ironmic:get-download-progress',

  // Analytics
  ANALYTICS_RECOMPUTE_TODAY: 'ironmic:analytics-recompute-today',
  ANALYTICS_BACKFILL: 'ironmic:analytics-backfill',
  ANALYTICS_GET_OVERVIEW: 'ironmic:analytics-get-overview',
  ANALYTICS_GET_DAILY_TREND: 'ironmic:analytics-get-daily-trend',
  ANALYTICS_GET_TOP_WORDS: 'ironmic:analytics-get-top-words',
  ANALYTICS_GET_SOURCE_BREAKDOWN: 'ironmic:analytics-get-source-breakdown',
  ANALYTICS_GET_VOCABULARY_RICHNESS: 'ironmic:analytics-get-vocabulary-richness',
  ANALYTICS_GET_STREAKS: 'ironmic:analytics-get-streaks',
  ANALYTICS_GET_PRODUCTIVITY_COMPARISON: 'ironmic:analytics-get-productivity-comparison',
  ANALYTICS_GET_TOPIC_BREAKDOWN: 'ironmic:analytics-get-topic-breakdown',
  ANALYTICS_GET_TOPIC_TRENDS: 'ironmic:analytics-get-topic-trends',
  ANALYTICS_CLASSIFY_TOPICS_BATCH: 'ironmic:analytics-classify-topics-batch',
  ANALYTICS_GET_UNCLASSIFIED_COUNT: 'ironmic:analytics-get-unclassified-count',

  // Notifications (ML Feature 3)
  NOTIFICATION_CREATE: 'ironmic:notification-create',
  NOTIFICATION_LIST: 'ironmic:notification-list',
  NOTIFICATION_MARK_READ: 'ironmic:notification-mark-read',
  NOTIFICATION_ACT: 'ironmic:notification-act',
  NOTIFICATION_DISMISS: 'ironmic:notification-dismiss',
  NOTIFICATION_UPDATE_PRIORITY: 'ironmic:notification-update-priority',
  NOTIFICATION_LOG_INTERACTION: 'ironmic:notification-log-interaction',
  NOTIFICATION_GET_INTERACTIONS: 'ironmic:notification-get-interactions',
  NOTIFICATION_GET_UNREAD_COUNT: 'ironmic:notification-get-unread-count',
  NOTIFICATION_DELETE_OLD: 'ironmic:notification-delete-old',

  // Action Log (ML Feature 4)
  ACTION_LOG: 'ironmic:action-log',
  ACTION_LOG_QUERY: 'ironmic:action-log-query',
  ACTION_LOG_GET_COUNTS: 'ironmic:action-log-get-counts',
  ACTION_LOG_DELETE_OLD: 'ironmic:action-log-delete-old',

  // Workflows (ML Feature 4)
  WORKFLOW_CREATE: 'ironmic:workflow-create',
  WORKFLOW_LIST: 'ironmic:workflow-list',
  WORKFLOW_SAVE: 'ironmic:workflow-save',
  WORKFLOW_DISMISS: 'ironmic:workflow-dismiss',
  WORKFLOW_DELETE: 'ironmic:workflow-delete',

  // Embeddings (ML Feature 5)
  EMBEDDING_STORE: 'ironmic:embedding-store',
  EMBEDDING_GET_ALL: 'ironmic:embedding-get-all',
  EMBEDDING_GET_ALL_WITH_DATA: 'ironmic:embedding-get-all-with-data',
  EMBEDDING_GET_UNEMBEDDED: 'ironmic:embedding-get-unembedded',
  EMBEDDING_DELETE: 'ironmic:embedding-delete',
  EMBEDDING_GET_STATS: 'ironmic:embedding-get-stats',
  EMBEDDING_DELETE_ALL: 'ironmic:embedding-delete-all',

  // ML Model Weights
  ML_SAVE_WEIGHTS: 'ironmic:ml-save-weights',
  ML_LOAD_WEIGHTS: 'ironmic:ml-load-weights',
  ML_DELETE_WEIGHTS: 'ironmic:ml-delete-weights',
  ML_GET_TRAINING_STATUS: 'ironmic:ml-get-training-status',
  ML_DELETE_ALL_DATA: 'ironmic:ml-delete-all-data',

  // VAD Training (ML Feature 1)
  VAD_SAVE_SAMPLE: 'ironmic:vad-save-sample',
  VAD_GET_SAMPLES: 'ironmic:vad-get-samples',
  VAD_GET_SAMPLE_COUNT: 'ironmic:vad-get-sample-count',
  VAD_DELETE_ALL_SAMPLES: 'ironmic:vad-delete-all-samples',

  // Intent Training (ML Feature 2)
  INTENT_SAVE_SAMPLE: 'ironmic:intent-save-sample',
  INTENT_GET_SAMPLES: 'ironmic:intent-get-samples',
  INTENT_GET_CORRECTION_COUNT: 'ironmic:intent-get-correction-count',
  INTENT_LOG_ROUTING: 'ironmic:intent-log-routing',

  // Meeting Recording (Granola-style — device-select + chunk drain)
  MEETING_START_RECORDING: 'ironmic:meeting-start-recording',
  MEETING_STOP_RECORDING: 'ironmic:meeting-stop-recording',
  MEETING_GET_CURRENT_SUMMARY: 'ironmic:meeting-get-current-summary',
  MEETING_SET_MIC_MUTED: 'ironmic:meeting-set-mic-muted',      // renderer → main (toggle self-mute)
  MEETING_SEGMENT_READY: 'ironmic:meeting-segment-ready',      // main → renderer push (committed final)
  MEETING_DRAFT_READY: 'ironmic:meeting-draft-ready',          // main → renderer push (live grey hypothesis)
  MEETING_RECORDING_STATE: 'ironmic:meeting-recording-state',  // main → renderer push
  MEETING_LIVE_SUMMARY: 'ironmic:meeting-live-summary',        // main → renderer push (incremental notes)
  MEETING_USER_NOTES_CHANGED: 'ironmic:meeting-user-notes-changed', // renderer → main (fire-and-forget)
  MEETING_USER_NOTES_BROADCAST: 'ironmic:meeting-user-notes-broadcast', // main → renderer push (collaborative Your Notes update)
  START_RECORDING_FROM_DEVICE: 'ironmic:start-recording-from-device',
  DRAIN_RECORDING_BUFFER: 'ironmic:drain-recording-buffer',

  // Transcript Segments
  ADD_TRANSCRIPT_SEGMENT: 'ironmic:add-transcript-segment',
  LIST_TRANSCRIPT_SEGMENTS: 'ironmic:list-transcript-segments',
  UPDATE_SEGMENT_SPEAKER: 'ironmic:update-segment-speaker',
  ASSEMBLE_FULL_TRANSCRIPT: 'ironmic:assemble-full-transcript',

  // Meeting Sessions (ML Feature 1 Bonus)
  MEETING_CREATE: 'ironmic:meeting-create',
  MEETING_END: 'ironmic:meeting-end',
  MEETING_GET: 'ironmic:meeting-get',
  MEETING_LIST: 'ironmic:meeting-list',
  MEETING_DELETE: 'ironmic:meeting-delete',
  MEETING_CREATE_WITH_TEMPLATE: 'ironmic:meeting-create-with-template',
  MEETING_SET_STRUCTURED_OUTPUT: 'ironmic:meeting-set-structured-output',
  /** Read the historical participant roster (host + every joiner with
   *  leftAt timestamps) for a meeting. Returns MeetingParticipant[]. */
  MEETING_GET_PARTICIPANTS: 'ironmic:meeting-get-participants',

  // Meeting Rooms (LAN multi-user collaboration)
  MEETING_ROOM_HOST_START: 'ironmic:meeting-room-host-start',
  MEETING_ROOM_HOST_STOP: 'ironmic:meeting-room-host-stop',
  MEETING_ROOM_HOST_INFO: 'ironmic:meeting-room-host-info',
  MEETING_ROOM_JOIN: 'ironmic:meeting-room-join',
  MEETING_ROOM_LEAVE: 'ironmic:meeting-room-leave',
  MEETING_ROOM_LEAVE_TRANSPORT: 'ironmic:meeting-room-leave-transport',  // renderer-owned finalize
  MEETING_ROOM_BROADCAST_FINAL_SUMMARY: 'ironmic:meeting-room-broadcast-final-summary',
  MEETING_ROOM_PARTICIPANT_FINALIZED: 'ironmic:meeting-room-participant-finalized',
  MEETING_ROOM_STATE: 'ironmic:meeting-room-state',                // main → renderer push
  MEETING_ROOM_PARTICIPANT_UPDATE: 'ironmic:meeting-room-participant-update', // main → renderer push
  MEETING_ROOM_HOST_ENDED: 'ironmic:meeting-room-host-ended',      // main → renderer push (durable last state)
  MEETING_ROOM_TITLE_UPDATE: 'ironmic:meeting-room-title-update',  // main → renderer push (host title sync)
  MEETING_SET_TITLE: 'ironmic:meeting-set-title',                  // host-only invoke
  MEETING_GET_MAX_SEQUENCE: 'ironmic:meeting-get-max-sequence',    // indexed sequence lookup

  // Meeting Templates
  TEMPLATE_CREATE: 'ironmic:template-create',
  TEMPLATE_GET: 'ironmic:template-get',
  TEMPLATE_LIST: 'ironmic:template-list',
  TEMPLATE_UPDATE: 'ironmic:template-update',
  TEMPLATE_DELETE: 'ironmic:template-delete',

  // Export / Sharing
  COPY_HTML_CLIPBOARD: 'ironmic:copy-html-clipboard',
  EXPORT_ENTRY_MARKDOWN: 'ironmic:export-entry-markdown',
  EXPORT_ENTRY_JSON: 'ironmic:export-entry-json',
  EXPORT_ENTRY_PLAIN_TEXT: 'ironmic:export-entry-plain-text',
  EXPORT_MEETING_MARKDOWN: 'ironmic:export-meeting-markdown',
  TEXT_TO_HTML: 'ironmic:text-to-html',
  SAVE_FILE_DIALOG: 'ironmic:save-file-dialog',

  // Audio Input
  LIST_AUDIO_DEVICES: 'ironmic:list-audio-devices',
  GET_CURRENT_AUDIO_DEVICE: 'ironmic:get-current-audio-device',
  CHECK_MIC_PERMISSION: 'ironmic:check-mic-permission',

  // Meeting App Detection
  MEETING_APP_DETECTED: 'ironmic:meeting-app-detected',

  // BlackHole detection & guided install (macOS)
  BLACKHOLE_CHECK: 'ironmic:blackhole-check',
  BLACKHOLE_INSTALL: 'ironmic:blackhole-install',
  BLACKHOLE_OPEN_AUDIO_MIDI_SETUP: 'ironmic:blackhole-open-audio-midi-setup',
  BLACKHOLE_INSTALL_PROGRESS: 'ironmic:blackhole-install-progress',   // main → renderer push

  // Notes collaboration (finished meetings, LAN only)
  MEETING_COLLAB_START: 'ironmic:meeting-collab-start',
  MEETING_COLLAB_STOP: 'ironmic:meeting-collab-stop',
  MEETING_COLLAB_JOIN: 'ironmic:meeting-collab-join',
  MEETING_COLLAB_LEAVE: 'ironmic:meeting-collab-leave',
  MEETING_COLLAB_SAVE_NOTES: 'ironmic:meeting-collab-save-notes',
  MEETING_COLLAB_SEND_DRAFT: 'ironmic:meeting-collab-send-draft',
  MEETING_COLLAB_NOTIFY_SAVED: 'ironmic:meeting-collab-notify-saved',
  MEETING_COLLAB_NOTIFY_DRAFT: 'ironmic:meeting-collab-notify-draft',
  MEETING_COLLAB_STATE: 'ironmic:meeting-collab-state',              // main → renderer push
  MEETING_COLLAB_NOTES_UPDATED: 'ironmic:meeting-collab-notes-updated', // main → renderer push
  MEETING_COLLAB_DRAFT: 'ironmic:meeting-collab-draft',              // main → renderer push
  MEETING_COLLAB_ENDED: 'ironmic:meeting-collab-ended',              // main → renderer push
  MEETING_COLLAB_WELCOME: 'ironmic:meeting-collab-welcome',          // main → renderer push (on join)
  MEETING_COLLAB_FIREWALL_WARNING: 'ironmic:meeting-collab-firewall-warning', // main → renderer push
  MEETING_COLLAB_OPEN_FIREWALL_SETTINGS: 'ironmic:meeting-collab-open-firewall-settings',
  MEETING_COLLAB_REQUEST_FIREWALL_ELEVATION: 'ironmic:meeting-collab-request-firewall-elevation',

  // TF.js Infrastructure
  GET_MODELS_DIR: 'ironmic:get-models-dir',

  // Model management (delete / redownload / disk usage / open folder)
  OPEN_MODELS_DIRECTORY: 'ironmic:open-models-directory',
  GET_ENGINE_DISK_USAGE: 'ironmic:get-engine-disk-usage',
  DELETE_ENGINE_FILES: 'ironmic:delete-engine-files',
  REDOWNLOAD_ENGINE: 'ironmic:redownload-engine',

  // Manual model import
  IMPORT_MODEL: 'ironmic:import-model',
  IMPORT_MODEL_FROM_PATH: 'ironmic:import-model-from-path',
  IMPORT_MULTI_PART_MODEL: 'ironmic:import-multi-part-model',
  OPEN_EXTERNAL: 'ironmic:open-external',

  // Events (main → renderer)
  PIPELINE_STATE_CHANGED: 'ironmic:pipeline-state-changed',
  RECORDING_COMPLETE: 'ironmic:recording-complete',
  MODEL_DOWNLOAD_PROGRESS: 'ironmic:model-download-progress',
  NOTIFICATION_NEW: 'ironmic:notification-new',
  WORKFLOW_DISCOVERED: 'ironmic:workflow-discovered',

  // Debug logs (main → renderer push, gated on debug_audio_logging setting)
  DEBUG_LOG: 'ironmic:debug-log',

  // ── Forge mode (floating-bar dictate-anywhere) ──
  // Toggle the bar window in/out. enterForge hides the main window, creates
  // the always-on-top non-focusable bar; exitForge tears the bar down and
  // restores the main window. Hotkey routing follows `forgeMode` in main.
  FORGE_ENTER: 'ironmic:enter-forge',
  FORGE_EXIT: 'ironmic:exit-forge',

  // Synthetic keystroke / paste-anywhere (Rust enigo).
  FORGE_PASTE_TEXT: 'ironmic:forge-paste-text',
  FORGE_TYPE_TEXT: 'ironmic:forge-type-text',

  // macOS Accessibility check + deep-link to System Settings.
  FORGE_CHECK_ACCESSIBILITY: 'ironmic:forge-check-accessibility',
  FORGE_OPEN_ACCESSIBILITY_PREFS: 'ironmic:forge-open-accessibility-prefs',

  // Forge-specific polish path. Honors AND of (polish_allow_cloud,
  // forge_polish_allow_cloud) — never looser than the global setting.
  FORGE_POLISH_TEXT: 'ironmic:forge-polish-text',

  // Renderer→main handshake fired when a Forge dictation finishes (ok or
  // error) so main can clear `dictationOwner` and accept the next hotkey.
  FORGE_DICTATION_COMPLETE: 'ironmic:forge-dictation-complete',

  // ── Knowledge Q&A (Ask page + retrieval pipeline) ──
  /** Start an ask request; orchestrator emits KNOWLEDGE_ASK_EVENT updates
   *  asynchronously with the requestId we return here. */
  KNOWLEDGE_ASK_START: 'ironmic:knowledge-ask-start',
  /** Cancel the active ask request (single-active-request design). */
  KNOWLEDGE_ASK_CANCEL: 'ironmic:knowledge-ask-cancel',
  /** main → renderer push for each phase: retrieving / retrieved / route-resolved
   *  / streaming / done / error. Renderer correlates by requestId. */
  KNOWLEDGE_ASK_EVENT: 'ironmic:knowledge-ask-event',
  /** Index / re-index operations (background indexer admin). */
  RAG_INDEX_BACKFILL: 'ironmic:rag-index-backfill',
  RAG_GET_INDEX_STATS: 'ironmic:rag-get-index-stats',
  RAG_REBUILD_INDEX: 'ironmic:rag-rebuild-index',

  // ── User Notes (Slice 0 of Knowledge Q&A — replaces localStorage-backed notes) ──
  USER_NOTES_CREATE: 'ironmic:user-notes-create',
  USER_NOTES_GET: 'ironmic:user-notes-get',
  USER_NOTES_UPDATE: 'ironmic:user-notes-update',
  USER_NOTES_DELETE: 'ironmic:user-notes-delete',
  USER_NOTES_LIST: 'ironmic:user-notes-list',
  /** One-shot localStorage→SQLite import; guarded renderer-side by the
   *  `notes_migrated_to_sqlite` settings flag. */
  USER_NOTES_BULK_IMPORT: 'ironmic:user-notes-bulk-import',
  USER_NOTEBOOKS_CREATE: 'ironmic:user-notebooks-create',
  USER_NOTEBOOKS_RENAME: 'ironmic:user-notebooks-rename',
  USER_NOTEBOOKS_DELETE: 'ironmic:user-notebooks-delete',
  USER_NOTEBOOKS_LIST: 'ironmic:user-notebooks-list',
} as const;

// ── Model hosting on GitHub Releases ──

export const MODELS_RELEASE_TAG = 'models-v1';
export const MODELS_BASE_URL = `https://github.com/greenpioneersolutions/IronMic/releases/download/${MODELS_RELEASE_TAG}`;

// Moonshine ONNX exports — three files (encoder, decoder, tokenizer) for the
// Base variant. Hosted at HuggingFace UsefulSensors/moonshine.
//
// IMPORTANT: the canonical path includes `/float/`. Without it HuggingFace
// returns "Entry not found" — the absence of that segment broke every Moonshine
// download/import link before this fix. Tiny is unavailable upstream
// (its tokenizer.json is 404 even at /float/) and is no longer supported.
const MOONSHINE_HF_BASE = 'https://huggingface.co/UsefulSensors/moonshine/resolve/main/onnx/merged/base/float';

/** Primary download URLs (GitHub Release assets) */
export const MODEL_URLS: Record<string, string> = {
  whisper: `${MODELS_BASE_URL}/whisper-large-v3-turbo.bin`,
  'whisper-medium': `${MODELS_BASE_URL}/ggml-medium.bin`,
  'whisper-small': `${MODELS_BASE_URL}/ggml-small.bin`,
  'whisper-base': `${MODELS_BASE_URL}/ggml-base.bin`,
  // Moonshine Base — HuggingFace is canonical. Bundled with the installer too
  // (electron-builder.config.js extraResources) so the default engine is
  // available with zero network access on first launch.
  'moonshine-base-encoder': `${MOONSHINE_HF_BASE}/encoder_model.onnx`,
  'moonshine-base-decoder': `${MOONSHINE_HF_BASE}/decoder_model_merged.onnx`,
  'moonshine-base-tokenizer': `${MOONSHINE_HF_BASE}/tokenizer.json`,
  llm: `${MODELS_BASE_URL}/mistral-7b-instruct-q4_k_m.gguf`,
  'llm-chat-llama3': `${MODELS_BASE_URL}/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf`,
  'llm-chat-phi3': `${MODELS_BASE_URL}/Phi-3-mini-4k-instruct-Q2_K.gguf`,
  'tts-model': `${MODELS_BASE_URL}/kokoro-v1.0-fp16.onnx`,
  // TF.js ML models (v1.1.0) — tar.gz archives containing model.json + weight shards
  'tfjs-vad-silero': `${MODELS_BASE_URL}/tfjs-vad-silero.tar.gz`,
  'tfjs-intent-classifier': `${MODELS_BASE_URL}/tfjs-intent-classifier.tar.gz`,
  'tfjs-use': `${MODELS_BASE_URL}/tfjs-use.tar.gz`,
  'tfjs-meeting-detector': `${MODELS_BASE_URL}/tfjs-meeting-detector.tar.gz`,
};

/** Fallback URLs (HuggingFace) — used if GitHub download fails after retries */
export const MODEL_FALLBACK_URLS: Record<string, string> = {
  whisper: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
  'whisper-medium': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',
  'whisper-small': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
  'whisper-base': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
  // Moonshine — fallback identical to primary because HuggingFace IS the canonical host.
  'moonshine-base-encoder': `${MOONSHINE_HF_BASE}/encoder_model.onnx`,
  'moonshine-base-decoder': `${MOONSHINE_HF_BASE}/decoder_model_merged.onnx`,
  'moonshine-base-tokenizer': `${MOONSHINE_HF_BASE}/tokenizer.json`,
  llm: 'https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.2-GGUF/resolve/main/mistral-7b-instruct-v0.2.Q4_K_M.gguf',
  'llm-chat-llama3': 'https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
  'llm-chat-phi3': 'https://huggingface.co/bartowski/Phi-3-mini-4k-instruct-GGUF/resolve/main/Phi-3-mini-4k-instruct-Q2_K.gguf',
  'tts-model': 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_fp16.onnx',
  // TF.js ML models — fallback is same as primary (GitHub only, no HuggingFace equivalent)
  'tfjs-vad-silero': `${MODELS_BASE_URL}/tfjs-vad-silero.tar.gz`,
  'tfjs-intent-classifier': `${MODELS_BASE_URL}/tfjs-intent-classifier.tar.gz`,
  'tfjs-use': `${MODELS_BASE_URL}/tfjs-use.tar.gz`,
  'tfjs-meeting-detector': `${MODELS_BASE_URL}/tfjs-meeting-detector.tar.gz`,
};

export const MODEL_FILES: Record<string, string> = {
  whisper: 'whisper-large-v3-turbo.bin',
  'whisper-medium': 'ggml-medium.bin',
  'whisper-small': 'ggml-small.bin',
  'whisper-base': 'ggml-base.bin',
  // Moonshine paths use a subdirectory layout because transcribe-rs's
  // MoonshineModel::load() expects a *directory* containing all three files.
  // The relative-to-models-dir path includes the subdirectory so the download
  // lands in the right place.
  'moonshine-base-encoder': 'moonshine-base/encoder_model.onnx',
  'moonshine-base-decoder': 'moonshine-base/decoder_model_merged.onnx',
  'moonshine-base-tokenizer': 'moonshine-base/tokenizer.json',
  llm: 'mistral-7b-instruct-q4_k_m.gguf',
  'llm-chat-llama3': 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
  'llm-chat-phi3': 'Phi-3-mini-4k-instruct-Q2_K.gguf',
  'tts-model': 'kokoro-v1.0-fp16.onnx',
  // TF.js ML models — tar.gz archives extracted to tfjs/<model-name>/
  'tfjs-vad-silero': 'tfjs-vad-silero.tar.gz',
  'tfjs-intent-classifier': 'tfjs-intent-classifier.tar.gz',
  'tfjs-use': 'tfjs-use.tar.gz',
  'tfjs-meeting-detector': 'tfjs-meeting-detector.tar.gz',
};

/** SHA-256 checksums for model integrity verification */
export const MODEL_CHECKSUMS: Record<string, string> = {
  whisper: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
  // Whisper medium/small/base checksums will be populated by upload-models workflow
  'whisper-medium': '',
  'whisper-small': '',
  'whisper-base': '',
  // Moonshine — checksums populated on first verified download (see model-downloader.ts).
  // We deliberately leave these empty initially because the HuggingFace files
  // can be re-uploaded; once we mirror them to the IronMic GitHub Release the
  // hashes will be pinned.
  'moonshine-base-encoder': '',
  'moonshine-base-decoder': '',
  'moonshine-base-tokenizer': '',
  llm: '3e0039fd0273fcbebb49228943b17831aadd55cbcbf56f0af00499be2040ccf9',
  'llm-chat-llama3': '', // Will be populated when model is uploaded to GitHub Releases
  'llm-chat-phi3': '', // Populate after verifying the Q2_K download: sha256sum Phi-3-mini-4k-instruct-Q2_K.gguf
  'tts-model': 'ba4527a874b42b21e35f468c10d326fdff3c7fc8cac1f85e9eb6c0dfc35c334a',
  // TF.js ML models — checksums populated by upload-models workflow
  'tfjs-vad-silero': '',
  'tfjs-intent-classifier': '',
  'tfjs-use': '',
  'tfjs-meeting-detector': '',
};

/** Models that are split into multiple parts (exceeds GitHub 2 GB per-asset limit) */
export const MODEL_PARTS: Record<string, string[]> = {
  llm: [
    'mistral-7b-instruct-q4_k_m.gguf.part0',
    'mistral-7b-instruct-q4_k_m.gguf.part1',
    'mistral-7b-instruct-q4_k_m.gguf.part2',
  ],
  'llm-chat-llama3': [
    'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf.part0',
    'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf.part1',
    'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf.part2',
  ],
  // llm-chat-phi3 is Q2_K (~1.41 GB), a single file — no part splitting needed
};

// ── Chat LLM model registry for AI Assist ──

export interface ChatLlmModelMeta {
  /** Key used in MODEL_FILES / MODEL_URLS for download. */
  id: string;
  label: string;
  sizeLabel: string;
  /** Instruct-template type passed to Rust: "mistral" | "llama3" | "phi3" */
  modelType: string;
  /** If true, this model shares the file with the text-polish "llm" model. */
  reusesPolishModel: boolean;
  description: string;
  /** Whether this model is compatible with the current llama.cpp version. */
  compatible: boolean;
}

export const CHAT_LLM_MODELS: ChatLlmModelMeta[] = [
  {
    id: 'llm',
    label: 'Mistral 7B Instruct',
    sizeLabel: '~4.4 GB',
    modelType: 'mistral',
    reusesPolishModel: false,
    description: 'Higher-quality option — download separately',
    compatible: true,
  },
  {
    id: 'llm-chat-llama3',
    label: 'Llama 3.1 8B Instruct',
    sizeLabel: '~4.7 GB',
    modelType: 'llama3',
    reusesPolishModel: false,
    description: 'Strong instruction following, multilingual',
    compatible: true,
  },
  {
    id: 'llm-chat-phi3',
    label: 'Phi-3 Mini 3.8B',
    sizeLabel: '~1.4 GB',
    modelType: 'phi3',
    reusesPolishModel: true,
    description: 'Bundled — no download needed. Shared with text cleanup.',
    compatible: true,
  },
];

// ── TF.js ML model registry ──

export interface TFJSModelMeta {
  /** Key used in MODEL_FILES / MODEL_URLS for download. */
  id: string;
  label: string;
  sizeLabel: string;
  /** Feature this model powers */
  feature: string;
  /** Directory name under tfjs/ where the model is extracted */
  dirName: string;
  /** Whether this model ships with the app (vs trained on-device) */
  bundled: boolean;
  description: string;
}

export const TFJS_MODELS: TFJSModelMeta[] = [
  {
    id: 'tfjs-vad-silero',
    label: 'Silero VAD',
    sizeLabel: '~900 KB',
    feature: 'Voice Activity Detection',
    dirName: 'vad-silero',
    bundled: true,
    description: 'Filters silence and noise before Whisper transcription',
  },
  {
    id: 'tfjs-intent-classifier',
    label: 'Intent Classifier',
    sizeLabel: '~5 MB',
    feature: 'Voice Commands',
    dirName: 'intent-classifier',
    bundled: true,
    description: 'Classifies voice input as commands (search, navigate, create)',
  },
  {
    id: 'tfjs-use',
    label: 'Universal Sentence Encoder',
    sizeLabel: '~30 MB',
    feature: 'Semantic Search',
    dirName: 'use',
    bundled: true,
    description: 'Generates text embeddings for meaning-based search',
  },
  {
    id: 'tfjs-meeting-detector',
    label: 'Meeting Detector',
    sizeLabel: '~5 MB',
    feature: 'Ambient Meeting Mode',
    dirName: 'meeting-detector',
    bundled: true,
    description: 'Detects meeting start/end and speaker turns',
  },
];

/** TTS voices bundled in the installer — no download needed */
export const TTS_VOICE_IDS = [
  'af_heart', 'af_bella', 'af_sarah', 'af_nicole', 'af_sky', 'af_nova',
  'am_adam', 'am_michael', 'am_fenrir',
  'bf_alice', 'bf_emma', 'bf_lily',
  'bm_daniel', 'bm_george', 'bm_lewis',
];

/**
 * Per-voice download metadata for the Kokoro 82M voice pack. Bundled in the
 * installer (see electron-builder.config.js extraResources) and copied into
 * userData on first launch by ensureBundledVoices(). When a user lands without
 * bundled voices (dev clone, partial install) the Repair flow downloads them
 * from Hugging Face. URLs resolve to onnx-community/Kokoro-82M-v1.0-ONNX/voices.
 *
 * Each .bin file is float32 [510, 256] = 522,240 bytes. Hashes pinned against
 * the bundled installer copy; if upstream rotates them this list must update
 * in lockstep.
 */
export interface TtsVoiceMeta {
  id: string;
  url: string;
  sha256: string;
  sizeBytes: number;
}

const KOKORO_VOICE_BASE = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices';
const KOKORO_VOICE_SIZE = 522240;

export const TTS_VOICES: TtsVoiceMeta[] = [
  { id: 'af_bella',   url: `${KOKORO_VOICE_BASE}/af_bella.bin`,   sha256: 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b', sizeBytes: KOKORO_VOICE_SIZE },
  { id: 'af_heart',   url: `${KOKORO_VOICE_BASE}/af_heart.bin`,   sha256: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b', sizeBytes: KOKORO_VOICE_SIZE },
  { id: 'af_nicole',  url: `${KOKORO_VOICE_BASE}/af_nicole.bin`,  sha256: 'cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a', sizeBytes: KOKORO_VOICE_SIZE },
  { id: 'af_nova',    url: `${KOKORO_VOICE_BASE}/af_nova.bin`,    sha256: '18778272caa0d0eebaea251c35fd635f038434f9eee5e691d02a174bd328414f', sizeBytes: KOKORO_VOICE_SIZE },
  { id: 'af_sarah',   url: `${KOKORO_VOICE_BASE}/af_sarah.bin`,   sha256: '4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a', sizeBytes: KOKORO_VOICE_SIZE },
  { id: 'af_sky',     url: `${KOKORO_VOICE_BASE}/af_sky.bin`,     sha256: '4435255c9744f3f31659e0d714ab7689bf65d9e77ec1cce060f083912614f0b9', sizeBytes: KOKORO_VOICE_SIZE },
  { id: 'am_adam',    url: `${KOKORO_VOICE_BASE}/am_adam.bin`,    sha256: '162b035ed91cfc48b6046982184c645f72edcdd1b82843347f605d7bf7b15716', sizeBytes: KOKORO_VOICE_SIZE },
  { id: 'am_fenrir',  url: `${KOKORO_VOICE_BASE}/am_fenrir.bin`,  sha256: 'c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43', sizeBytes: KOKORO_VOICE_SIZE },
  { id: 'am_michael', url: `${KOKORO_VOICE_BASE}/am_michael.bin`, sha256: '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1', sizeBytes: KOKORO_VOICE_SIZE },
  { id: 'bf_alice',   url: `${KOKORO_VOICE_BASE}/bf_alice.bin`,   sha256: '08afa6ba24da61ea5e8efa139e5aadc938d83f0a6da5a900adaf763ac1da5573', sizeBytes: KOKORO_VOICE_SIZE },
  { id: 'bf_emma',    url: `${KOKORO_VOICE_BASE}/bf_emma.bin`,    sha256: '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73', sizeBytes: KOKORO_VOICE_SIZE },
  { id: 'bf_lily',    url: `${KOKORO_VOICE_BASE}/bf_lily.bin`,    sha256: '5e0ee32ebe64a467124976b14e69590746f1c4ce41a12b587a50c862edfea335', sizeBytes: KOKORO_VOICE_SIZE },
  { id: 'bm_daniel',  url: `${KOKORO_VOICE_BASE}/bm_daniel.bin`,  sha256: '6b3194bbceffb746733cbc22c8f593dd44e401a71d53895a2dca891bc595a1e8', sizeBytes: KOKORO_VOICE_SIZE },
  { id: 'bm_george',  url: `${KOKORO_VOICE_BASE}/bm_george.bin`,  sha256: 'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc', sizeBytes: KOKORO_VOICE_SIZE },
  { id: 'bm_lewis',   url: `${KOKORO_VOICE_BASE}/bm_lewis.bin`,   sha256: 'b8f671cef828c30e66fdf0b0756a76bba58f6bb3398cbbf27058642acbcedb97', sizeBytes: KOKORO_VOICE_SIZE },
];

export const KOKORO_DEFAULT_VOICE_ID = 'af_heart';

/**
 * Pinned SHA-256 of the canonical kokoro-v1.0-fp16.onnx model. Used by the
 * import path to fast-accept a renamed-but-identical Kokoro file before
 * falling back to structural validation. Sourced from MODEL_CHECKSUMS.
 */
export const KOKORO_ONNX_SHA256 = 'ba4527a874b42b21e35f468c10d326fdff3c7fc8cac1f85e9eb6c0dfc35c334a';

/** Platform-specific install hint for the espeak-ng phonemizer. */
export function getEspeakInstallHint(platform: NodeJS.Platform | string = process.platform): string {
  switch (platform) {
    case 'darwin':
      return 'Install with: brew install espeak-ng';
    case 'win32':
      return 'Download the eSpeak NG installer from https://github.com/espeak-ng/espeak-ng/releases/latest';
    default:
      return 'Install with: sudo apt install espeak-ng (or your distro equivalent)';
  }
}
