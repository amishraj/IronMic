export const DEFAULT_HOTKEY = 'CommandOrControl+Shift+V';
export const APP_NAME = 'IronMic';
export const DB_NAME = 'ironmic.db';

export const WHISPER_MODEL_NAME = 'whisper-large-v3-turbo';
export const LLM_MODEL_NAME = 'mistral-7b-instruct-q4';

export const DEFAULT_SETTINGS = {
  hotkey_record: DEFAULT_HOTKEY,
  llm_cleanup_enabled: 'true',
  default_view: 'timeline',
  theme: 'system',
  whisper_model: WHISPER_MODEL_NAME,
  llm_model: LLM_MODEL_NAME,
} as const;

export const IPC_CHANNELS = {
  // Audio
  START_RECORDING: 'ironmic:start-recording',
  STOP_RECORDING: 'ironmic:stop-recording',
  IS_RECORDING: 'ironmic:is-recording',

  // Transcription
  TRANSCRIBE: 'ironmic:transcribe',
  POLISH_TEXT: 'ironmic:polish-text',

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
  MEETING_SEGMENT_READY: 'ironmic:meeting-segment-ready',      // main → renderer push
  MEETING_RECORDING_STATE: 'ironmic:meeting-recording-state',  // main → renderer push
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

  // Meeting Rooms (LAN multi-user collaboration)
  MEETING_ROOM_HOST_START: 'ironmic:meeting-room-host-start',
  MEETING_ROOM_HOST_STOP: 'ironmic:meeting-room-host-stop',
  MEETING_ROOM_HOST_INFO: 'ironmic:meeting-room-host-info',
  MEETING_ROOM_JOIN: 'ironmic:meeting-room-join',
  MEETING_ROOM_LEAVE: 'ironmic:meeting-room-leave',
  MEETING_ROOM_STATE: 'ironmic:meeting-room-state',                // main → renderer push
  MEETING_ROOM_PARTICIPANT_UPDATE: 'ironmic:meeting-room-participant-update', // main → renderer push

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
  MEETING_COLLAB_STATE: 'ironmic:meeting-collab-state',              // main → renderer push
  MEETING_COLLAB_NOTES_UPDATED: 'ironmic:meeting-collab-notes-updated', // main → renderer push
  MEETING_COLLAB_DRAFT: 'ironmic:meeting-collab-draft',              // main → renderer push
  MEETING_COLLAB_ENDED: 'ironmic:meeting-collab-ended',              // main → renderer push
  MEETING_COLLAB_WELCOME: 'ironmic:meeting-collab-welcome',          // main → renderer push (on join)

  // TF.js Infrastructure
  GET_MODELS_DIR: 'ironmic:get-models-dir',

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
} as const;

// ── Model hosting on GitHub Releases ──

export const MODELS_RELEASE_TAG = 'models-v1';
export const MODELS_BASE_URL = `https://github.com/greenpioneersolutions/IronMic/releases/download/${MODELS_RELEASE_TAG}`;

/** Primary download URLs (GitHub Release assets) */
export const MODEL_URLS: Record<string, string> = {
  whisper: `${MODELS_BASE_URL}/whisper-large-v3-turbo.bin`,
  'whisper-medium': `${MODELS_BASE_URL}/ggml-medium.bin`,
  'whisper-small': `${MODELS_BASE_URL}/ggml-small.bin`,
  'whisper-base': `${MODELS_BASE_URL}/ggml-base.bin`,
  llm: `${MODELS_BASE_URL}/mistral-7b-instruct-q4_k_m.gguf`,
  'llm-chat-llama3': `${MODELS_BASE_URL}/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf`,
  'llm-chat-phi3': `${MODELS_BASE_URL}/Phi-3-mini-4k-instruct-Q4_K_M.gguf`,
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
  llm: 'https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.2-GGUF/resolve/main/mistral-7b-instruct-v0.2.Q4_K_M.gguf',
  'llm-chat-llama3': 'https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
  'llm-chat-phi3': 'https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf',
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
  llm: 'mistral-7b-instruct-q4_k_m.gguf',
  'llm-chat-llama3': 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
  'llm-chat-phi3': 'Phi-3-mini-4k-instruct-q4.gguf',
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
  llm: '3e0039fd0273fcbebb49228943b17831aadd55cbcbf56f0af00499be2040ccf9',
  'llm-chat-llama3': '', // Will be populated when model is uploaded to GitHub Releases
  'llm-chat-phi3': '', // Will be populated when model is uploaded to GitHub Releases
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
  'llm-chat-phi3': [
    'Phi-3-mini-4k-instruct-q4.gguf.part0',
    'Phi-3-mini-4k-instruct-q4.gguf.part1',
  ],
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
    reusesPolishModel: true,
    description: 'Shared with text cleanup — no extra download needed',
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
    sizeLabel: '~2.2 GB',
    modelType: 'phi3',
    reusesPolishModel: false,
    description: 'Smallest and fastest option',
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
