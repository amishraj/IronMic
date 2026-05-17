//! `MeetingCaptureEngine` — dual-stream capture for remote-meeting transcription.
//!
//! Owns a microphone stream (cpal, same code path as dictation) AND, on
//! Windows, a system-output loopback stream (WASAPI direct). Each stream
//! writes into its own `AudioRingBuffer` so the recorder can drain them
//! independently, tag segments with their source at capture time, and avoid
//! relying on LLM diarization to tell "You" from "Remote".
//!
//! Dictation, Forge, and the live-streaming meeting path all continue to use
//! the existing single-stream `CaptureEngine`. This engine is meeting-mode-
//! only and is parked behind its own N-API exports.
//!
//! Privacy: both ring buffers zero-on-drop via `AudioRingBuffer::Drop` and
//! both are zeroed after every drain. The loopback path captures audio that
//! the system is already playing through speakers / headphones — no new
//! network surface.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::Stream;
use tracing::{info, warn};

use crate::audio::capture::{
    build_input_stream_for_format, AudioRingBuffer, CaptureEngine, CapturedAudio,
};
use crate::audio::loopback_windows::LoopbackCapture;
use crate::error::IronMicError;

/// How the loopback half of the engine is configured at start time.
#[derive(Debug, Clone)]
pub enum LoopbackMode {
    /// Capture from the system default render endpoint (Windows WASAPI).
    SystemDefault,
    /// Capture from a named render endpoint id (Windows MMDevice id).
    Device(String),
    /// No loopback capture — dictation-only fallback. The engine behaves
    /// like a thin wrapper around the existing single-stream mic capture.
    None,
}

/// Dual capture engine: one mic stream + (optionally) one loopback stream.
pub struct MeetingCaptureEngine {
    recording: Arc<AtomicBool>,
    mic_buffer: Arc<Mutex<AudioRingBuffer>>,
    mic_stream: Option<Stream>,
    mic_device_name: Option<String>,

    loopback_buffer: Arc<Mutex<AudioRingBuffer>>,
    loopback: Option<LoopbackCapture>,
    loopback_mode: LoopbackMode,
}

// Safety: same single-threaded-by-mutex contract as CaptureEngine.
unsafe impl Send for MeetingCaptureEngine {}

impl Default for MeetingCaptureEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl MeetingCaptureEngine {
    pub fn new() -> Self {
        Self {
            recording: Arc::new(AtomicBool::new(false)),
            mic_buffer: Arc::new(Mutex::new(AudioRingBuffer::new())),
            mic_stream: None,
            mic_device_name: None,
            loopback_buffer: Arc::new(Mutex::new(AudioRingBuffer::new())),
            loopback: None,
            loopback_mode: LoopbackMode::None,
        }
    }

    pub fn is_recording(&self) -> bool {
        self.recording.load(Ordering::SeqCst)
    }

    pub fn has_loopback(&self) -> bool {
        self.loopback.is_some()
    }

    /// Start dual capture. The mic stream is mandatory; loopback is
    /// best-effort — if it fails (non-Windows, exclusive-mode-locked
    /// endpoint, missing entitlement, etc.) the engine still starts with
    /// the mic stream and `has_loopback()` will return false. The caller
    /// is expected to surface a warning to the user when this happens.
    pub fn start_dual(
        &mut self,
        mic_device_name: Option<&str>,
        loopback_mode: LoopbackMode,
    ) -> Result<(), IronMicError> {
        if self.is_recording() {
            return Err(IronMicError::AlreadyRecording);
        }

        // ── Mic stream ──
        let host = cpal::default_host();
        let mic_device = match mic_device_name {
            Some(name) => host
                .input_devices()
                .map_err(|e| IronMicError::Audio(e.to_string()))?
                .find(|d| d.name().ok().as_deref() == Some(name))
                .or_else(|| host.default_input_device())
                .ok_or_else(|| {
                    IronMicError::NoDevice(format!(
                        "Mic device '{name}' not found and no default available"
                    ))
                })?,
            None => host
                .default_input_device()
                .ok_or_else(|| IronMicError::NoDevice("No input device available".into()))?,
        };

        let found_name = mic_device.name().unwrap_or_else(|_| "unknown".into());
        info!(device = %found_name, "Meeting dual capture: mic device");
        self.mic_device_name = Some(found_name);

        let (mic_config, mic_format) = CaptureEngine::preferred_config(&mic_device)?;
        info!(
            sample_rate = mic_config.sample_rate.0,
            channels = mic_config.channels,
            ?mic_format,
            "Meeting dual capture: mic config"
        );

        {
            let mut buf = self.mic_buffer.lock().unwrap();
            buf.zero();
            buf.set_format(mic_config.sample_rate.0, mic_config.channels);
        }

        let mic_stream = build_input_stream_for_format(
            &mic_device,
            &mic_config,
            mic_format,
            Arc::clone(&self.mic_buffer),
            Arc::clone(&self.recording),
        )?;

        mic_stream
            .play()
            .map_err(|e| IronMicError::Audio(e.to_string()))?;

        // ── Loopback stream ──
        // Reset the loopback buffer regardless of mode so a previous session's
        // leftover samples can't leak in.
        {
            let mut buf = self.loopback_buffer.lock().unwrap();
            buf.zero();
        }

        let loopback_handle = match &loopback_mode {
            LoopbackMode::None => None,
            LoopbackMode::SystemDefault => {
                match LoopbackCapture::start(Arc::clone(&self.loopback_buffer), None) {
                    Ok(handle) => Some(handle),
                    Err(err) => {
                        warn!(
                            %err,
                            "WASAPI loopback unavailable — meeting will continue with mic only"
                        );
                        None
                    }
                }
            }
            LoopbackMode::Device(id) => {
                match LoopbackCapture::start(
                    Arc::clone(&self.loopback_buffer),
                    Some(id.clone()),
                ) {
                    Ok(handle) => Some(handle),
                    Err(err) => {
                        warn!(
                            device = %id,
                            %err,
                            "WASAPI loopback for named device failed — meeting will continue with mic only"
                        );
                        None
                    }
                }
            }
        };

        self.recording.store(true, Ordering::SeqCst);
        self.mic_stream = Some(mic_stream);
        self.loopback = loopback_handle;
        self.loopback_mode = loopback_mode;

        info!(
            has_loopback = self.loopback.is_some(),
            "MeetingCaptureEngine started"
        );
        Ok(())
    }

    /// Drain both ring buffers WITHOUT stopping either stream. The buffers
    /// keep accumulating with zero capture gap for the next drain window.
    pub fn drain_dual(&mut self) -> Result<DualCaptured, IronMicError> {
        if !self.is_recording() {
            return Err(IronMicError::NotRecording);
        }
        let mic = drain_buffer(&self.mic_buffer)?;
        let loopback = if self.loopback.is_some() {
            Some(drain_buffer(&self.loopback_buffer)?)
        } else {
            None
        };
        Ok(DualCaptured { mic, loopback })
    }

    /// Stop both streams and return the final captured tails. After this
    /// the engine is back in the idle state and `start_dual` can be called
    /// again.
    pub fn stop_dual(&mut self) -> Result<DualCaptured, IronMicError> {
        if !self.is_recording() {
            return Err(IronMicError::NotRecording);
        }

        self.recording.store(false, Ordering::SeqCst);

        // Dropping the cpal stream stops capture.
        self.mic_stream = None;
        // Dropping LoopbackCapture signals its thread to exit and joins it.
        self.loopback = None;

        let mic = drain_buffer(&self.mic_buffer)?;
        let loopback = match self.loopback_mode {
            LoopbackMode::None => None,
            _ => Some(drain_buffer(&self.loopback_buffer)?),
        };

        info!(
            mic_samples = mic.samples.len(),
            loopback_samples = loopback.as_ref().map(|c| c.samples.len()).unwrap_or(0),
            "MeetingCaptureEngine stopped"
        );

        Ok(DualCaptured { mic, loopback })
    }

    /// Force-reset to idle. Used for error recovery.
    pub fn force_reset(&mut self) {
        self.recording.store(false, Ordering::SeqCst);
        self.mic_stream = None;
        self.loopback = None;
        if let Ok(mut buf) = self.mic_buffer.lock() {
            buf.zero();
        }
        if let Ok(mut buf) = self.loopback_buffer.lock() {
            buf.zero();
        }
        self.loopback_mode = LoopbackMode::None;
        info!("MeetingCaptureEngine force-reset to idle");
    }
}

impl Drop for MeetingCaptureEngine {
    fn drop(&mut self) {
        if self.is_recording() {
            self.recording.store(false, Ordering::SeqCst);
            self.mic_stream = None;
            self.loopback = None;
            warn!("MeetingCaptureEngine dropped while recording — streams stopped");
        }
        if let Ok(mut buf) = self.mic_buffer.lock() {
            buf.zero();
        }
        if let Ok(mut buf) = self.loopback_buffer.lock() {
            buf.zero();
        }
    }
}

/// Result of a single drain or stop call. Mirrors `CapturedAudio` (which
/// owns zero-on-drop semantics) for each stream.
pub struct DualCaptured {
    pub mic: CapturedAudio,
    pub loopback: Option<CapturedAudio>,
}

fn drain_buffer(buf: &Arc<Mutex<AudioRingBuffer>>) -> Result<CapturedAudio, IronMicError> {
    let mut guard = buf
        .lock()
        .map_err(|e| IronMicError::Audio(format!("Buffer lock poisoned: {e}")))?;
    let sample_rate = guard.sample_rate();
    let channels = guard.channels();
    let samples = guard.take();
    guard.set_format(sample_rate, channels);
    Ok(CapturedAudio {
        samples,
        sample_rate,
        channels,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_not_recording_initially() {
        let engine = MeetingCaptureEngine::new();
        assert!(!engine.is_recording());
        assert!(!engine.has_loopback());
    }

    #[test]
    fn drain_without_start_errors() {
        let mut engine = MeetingCaptureEngine::new();
        assert!(engine.drain_dual().is_err());
        assert!(engine.stop_dual().is_err());
    }
}
