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

  // Events (main → renderer)
  PIPELINE_STATE_CHANGED: 'ironmic:pipeline-state-changed',
  RECORDING_COMPLETE: 'ironmic:recording-complete',
  MODEL_DOWNLOAD_PROGRESS: 'ironmic:model-download-progress',
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
  'tts-model': `${MODELS_BASE_URL}/kokoro-v1.0-fp16.onnx`,
};

/** Fallback URLs (HuggingFace) — used if GitHub download fails after retries */
export const MODEL_FALLBACK_URLS: Record<string, string> = {
  whisper: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
  'whisper-medium': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',
  'whisper-small': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
  'whisper-base': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
  llm: 'https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.2-GGUF/resolve/main/mistral-7b-instruct-v0.2.Q4_K_M.gguf',
  'tts-model': 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_fp16.onnx',
};

export const MODEL_FILES: Record<string, string> = {
  whisper: 'whisper-large-v3-turbo.bin',
  'whisper-medium': 'ggml-medium.bin',
  'whisper-small': 'ggml-small.bin',
  'whisper-base': 'ggml-base.bin',
  llm: 'mistral-7b-instruct-q4_k_m.gguf',
  'tts-model': 'kokoro-v1.0-fp16.onnx',
};

/** SHA-256 checksums for model integrity verification */
export const MODEL_CHECKSUMS: Record<string, string> = {
  whisper: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
  // Whisper medium/small/base checksums will be populated by upload-models workflow
  'whisper-medium': '',
  'whisper-small': '',
  'whisper-base': '',
  llm: '3e0039fd0273fcbebb49228943b17831aadd55cbcbf56f0af00499be2040ccf9',
  'tts-model': 'ba4527a874b42b21e35f468c10d326fdff3c7fc8cac1f85e9eb6c0dfc35c334a',
};

/** Models that are split into multiple parts (exceeds GitHub 2 GB per-asset limit) */
export const MODEL_PARTS: Record<string, string[]> = {
  llm: [
    'mistral-7b-instruct-q4_k_m.gguf.part0',
    'mistral-7b-instruct-q4_k_m.gguf.part1',
    'mistral-7b-instruct-q4_k_m.gguf.part2',
  ],
};

/** TTS voices bundled in the installer — no download needed */
export const TTS_VOICE_IDS = [
  'af_heart', 'af_bella', 'af_sarah', 'af_nicole', 'af_sky', 'af_nova',
  'am_adam', 'am_michael', 'am_fenrir',
  'bf_alice', 'bf_emma', 'bf_lily',
  'bm_daniel', 'bm_george', 'bm_lewis',
];
