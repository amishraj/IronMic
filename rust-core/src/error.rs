use thiserror::Error;

#[derive(Error, Debug)]
pub enum IronMicError {
    #[error("Audio error: {0}")]
    Audio(String),

    #[error("No audio device available: {0}")]
    NoDevice(String),

    #[error("Recording is not active")]
    NotRecording,

    #[error("Recording is already active")]
    AlreadyRecording,

    #[error("Audio processing error: {0}")]
    Processing(String),

    #[error("Transcription error: {0}")]
    Transcription(String),

    #[error("LLM error: {0}")]
    Llm(String),

    #[error("Storage error: {0}")]
    Storage(String),

    #[error("TTS error: {0}")]
    Tts(String),

    #[error("Playback error: {0}")]
    Playback(String),

    #[error("Internal error: {0}")]
    Internal(#[from] anyhow::Error),
}

impl From<IronMicError> for napi::Error {
    fn from(e: IronMicError) -> Self {
        napi::Error::from_reason(e.to_string())
    }
}
