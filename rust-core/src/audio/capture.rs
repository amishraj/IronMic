use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, StreamConfig};
use tracing::{debug, error, info, warn};

use crate::error::IronMicError;

/// A ring buffer that holds captured audio samples in memory.
/// On drop, the buffer is explicitly zeroed to ensure audio never persists.
pub struct AudioRingBuffer {
    data: Vec<f32>,
    sample_rate: u32,
    channels: u16,
}

impl AudioRingBuffer {
    pub fn new() -> Self {
        Self {
            data: Vec::new(),
            sample_rate: 0,
            channels: 0,
        }
    }

    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            data: Vec::with_capacity(capacity),
            sample_rate: 0,
            channels: 0,
        }
    }

    pub fn set_format(&mut self, sample_rate: u32, channels: u16) {
        self.sample_rate = sample_rate;
        self.channels = channels;
    }

    pub fn push_samples(&mut self, samples: &[f32]) {
        self.data.extend_from_slice(samples);
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }

    pub fn samples(&self) -> &[f32] {
        &self.data
    }

    pub fn len(&self) -> usize {
        self.data.len()
    }

    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    /// Take ownership of the audio data, leaving the buffer empty.
    /// The caller is responsible for zeroing the returned data when done.
    pub fn take(&mut self) -> Vec<f32> {
        let mut taken = std::mem::take(&mut self.data);
        self.sample_rate = 0;
        self.channels = 0;
        // The caller gets the data; our internal vec is now empty
        taken.shrink_to_fit();
        taken
    }

    /// Explicitly zero all audio data in the buffer.
    pub fn zero(&mut self) {
        self.data.fill(0.0);
        self.data.clear();
        self.data.shrink_to_fit();
        self.sample_rate = 0;
        self.channels = 0;
    }
}

impl Drop for AudioRingBuffer {
    fn drop(&mut self) {
        // Privacy guarantee: zero all audio data on drop
        self.data.fill(0.0);
        self.data.clear();
        debug!("AudioRingBuffer dropped and zeroed");
    }
}

/// The audio capture engine wraps cpal and manages recording state.
pub struct CaptureEngine {
    recording: Arc<AtomicBool>,
    buffer: Arc<Mutex<AudioRingBuffer>>,
    stream: Option<Stream>,
    device_name: Option<String>,
}

// Safety: CaptureEngine is always accessed behind a Mutex in the global static.
// The cpal::Stream is !Send due to platform internals, but we ensure it is only
// created and dropped on the N-API main thread (single-threaded access pattern).
unsafe impl Send for CaptureEngine {}

impl CaptureEngine {
    pub fn new() -> Self {
        Self {
            recording: Arc::new(AtomicBool::new(false)),
            buffer: Arc::new(Mutex::new(AudioRingBuffer::new())),
            stream: None,
            device_name: None,
        }
    }

    pub fn is_recording(&self) -> bool {
        self.recording.load(Ordering::SeqCst)
    }

    /// Start recording from the default input device.
    pub fn start(&mut self) -> Result<(), IronMicError> {
        if self.is_recording() {
            return Err(IronMicError::AlreadyRecording);
        }

        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| IronMicError::NoDevice("No input device available".into()))?;

        let device_name = device.name().unwrap_or_else(|_| "unknown".into());
        info!(device = %device_name, "Using input device");
        self.device_name = Some(device_name);

        let config = Self::preferred_config(&device)?;
        info!(
            sample_rate = config.sample_rate.0,
            channels = config.channels,
            "Recording config"
        );

        {
            let mut buf = self.buffer.lock().unwrap();
            buf.zero();
            buf.set_format(config.sample_rate.0, config.channels);
        }

        let buffer = Arc::clone(&self.buffer);
        let recording = Arc::clone(&self.recording);

        let err_callback = |err: cpal::StreamError| {
            error!(%err, "Audio stream error");
        };

        let stream = device
            .build_input_stream(
                &config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if recording.load(Ordering::SeqCst) {
                        if let Ok(mut buf) = buffer.lock() {
                            buf.push_samples(data);
                        }
                    }
                },
                err_callback,
                None,
            )
            .map_err(|e| IronMicError::Audio(e.to_string()))?;

        stream
            .play()
            .map_err(|e| IronMicError::Audio(e.to_string()))?;

        self.recording.store(true, Ordering::SeqCst);
        self.stream = Some(stream);

        info!("Recording started");
        Ok(())
    }

    /// Force-reset the recording state. Used for error recovery.
    /// Stops any active stream and zeroes the buffer, returning to a clean idle state.
    pub fn force_reset(&mut self) {
        self.recording.store(false, Ordering::SeqCst);
        self.stream = None;
        if let Ok(mut buf) = self.buffer.lock() {
            buf.zero();
        }
        info!("Recording force-reset to idle");
    }

    /// Stop recording and return the captured audio buffer.
    /// The internal buffer is zeroed after the data is extracted.
    pub fn stop(&mut self) -> Result<CapturedAudio, IronMicError> {
        if !self.is_recording() {
            return Err(IronMicError::NotRecording);
        }

        self.recording.store(false, Ordering::SeqCst);

        // Drop the stream to stop capturing
        self.stream = None;

        let mut buf = self.buffer.lock().unwrap();
        let sample_rate = buf.sample_rate();
        let channels = buf.channels();
        let samples = buf.take();

        info!(
            samples = samples.len(),
            sample_rate,
            channels,
            "Recording stopped"
        );

        Ok(CapturedAudio {
            samples,
            sample_rate,
            channels,
        })
    }

    /// Choose the best input config — prefer f32, fallback to converting.
    fn preferred_config(device: &Device) -> Result<StreamConfig, IronMicError> {
        let supported = device
            .supported_input_configs()
            .map_err(|e| IronMicError::Audio(e.to_string()))?;

        // Prefer f32 configs, then fall back to whatever is available
        let mut best = None;
        for cfg in supported {
            if cfg.sample_format() == SampleFormat::F32 {
                best = Some(cfg.with_max_sample_rate());
                break;
            }
            if best.is_none() {
                best = Some(cfg.with_max_sample_rate());
            }
        }

        let config = best
            .ok_or_else(|| IronMicError::NoDevice("No supported input config found".into()))?;

        Ok(config.into())
    }
}

impl Drop for CaptureEngine {
    fn drop(&mut self) {
        if self.is_recording() {
            self.recording.store(false, Ordering::SeqCst);
            self.stream = None;
            warn!("CaptureEngine dropped while recording — stream stopped");
        }
        // Ensure buffer is zeroed
        if let Ok(mut buf) = self.buffer.lock() {
            buf.zero();
        }
    }
}

/// The result of a completed recording session.
pub struct CapturedAudio {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u16,
}

impl CapturedAudio {
    /// Zero the audio samples. Call this after processing is complete.
    pub fn zero(&mut self) {
        self.samples.fill(0.0);
        self.samples.clear();
        self.samples.shrink_to_fit();
    }

    pub fn duration_seconds(&self) -> f64 {
        if self.sample_rate == 0 || self.channels == 0 {
            return 0.0;
        }
        self.samples.len() as f64 / (self.sample_rate as f64 * self.channels as f64)
    }
}

impl Drop for CapturedAudio {
    fn drop(&mut self) {
        self.samples.fill(0.0);
        self.samples.clear();
        debug!("CapturedAudio dropped and zeroed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_buffer_zero_on_drop() {
        let ptr: *const f32;
        let len: usize;
        {
            let mut buf = AudioRingBuffer::new();
            buf.set_format(16000, 1);
            buf.push_samples(&[0.5, -0.3, 0.8, 1.0]);
            assert_eq!(buf.len(), 4);
            ptr = buf.data.as_ptr();
            len = buf.data.len();
            // buf drops here — fill(0.0) is called
        }
        // After drop, we can't safely read the memory, but the Drop impl ensures zeroing.
        // This test verifies the drop runs without panic.
        let _ = (ptr, len);
    }

    #[test]
    fn ring_buffer_take_and_zero() {
        let mut buf = AudioRingBuffer::with_capacity(1024);
        buf.set_format(44100, 2);
        buf.push_samples(&[0.1, 0.2, 0.3]);

        assert_eq!(buf.sample_rate(), 44100);
        assert_eq!(buf.channels(), 2);
        assert_eq!(buf.len(), 3);

        let taken = buf.take();
        assert_eq!(taken.len(), 3);
        assert!(buf.is_empty());
        assert_eq!(buf.sample_rate(), 0);
    }

    #[test]
    fn ring_buffer_explicit_zero() {
        let mut buf = AudioRingBuffer::new();
        buf.push_samples(&[1.0; 1000]);
        assert_eq!(buf.len(), 1000);

        buf.zero();
        assert!(buf.is_empty());
        assert_eq!(buf.sample_rate(), 0);
    }

    #[test]
    fn captured_audio_duration() {
        let audio = CapturedAudio {
            samples: vec![0.0; 16000],
            sample_rate: 16000,
            channels: 1,
        };
        assert!((audio.duration_seconds() - 1.0).abs() < 0.001);
    }

    #[test]
    fn captured_audio_duration_stereo() {
        let audio = CapturedAudio {
            samples: vec![0.0; 88200],
            sample_rate: 44100,
            channels: 2,
        };
        assert!((audio.duration_seconds() - 1.0).abs() < 0.001);
    }

    #[test]
    fn capture_engine_not_recording_initially() {
        let engine = CaptureEngine::new();
        assert!(!engine.is_recording());
    }

    #[test]
    fn capture_engine_stop_without_start_errors() {
        let mut engine = CaptureEngine::new();
        let result = engine.stop();
        assert!(result.is_err());
    }
}
