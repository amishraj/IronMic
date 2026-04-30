use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, Sample, SampleFormat, Stream, StreamConfig};
use tracing::{debug, error, info, warn};

use crate::error::IronMicError;

/// A ring buffer that holds captured audio samples in memory.
/// On drop, the buffer is explicitly zeroed to ensure audio never persists.
pub struct AudioRingBuffer {
    data: Vec<f32>,
    sample_rate: u32,
    channels: u16,
}

impl Default for AudioRingBuffer {
    fn default() -> Self {
        Self::new()
    }
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

impl Default for CaptureEngine {
    fn default() -> Self {
        Self::new()
    }
}

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

        let (config, format) = Self::preferred_config(&device)?;
        info!(
            sample_rate = config.sample_rate.0,
            channels = config.channels,
            ?format,
            "Recording config"
        );

        {
            let mut buf = self.buffer.lock().unwrap();
            buf.zero();
            buf.set_format(config.sample_rate.0, config.channels);
        }

        let stream = build_input_stream_for_format(
            &device,
            &config,
            format,
            Arc::clone(&self.buffer),
            Arc::clone(&self.recording),
        )?;

        stream
            .play()
            .map_err(|e| IronMicError::Audio(e.to_string()))?;

        self.recording.store(true, Ordering::SeqCst);
        self.stream = Some(stream);

        info!("Recording started");
        Ok(())
    }

    /// Start recording from a named input device (e.g. "BlackHole 2ch" on macOS).
    /// Falls back to the default input device if the named device is not found.
    pub fn start_from_device(&mut self, device_name: &str) -> Result<(), IronMicError> {
        if self.is_recording() {
            return Err(IronMicError::AlreadyRecording);
        }

        use cpal::traits::HostTrait;
        let host = cpal::default_host();

        // Try to find the named device; fall back to default
        let device = host
            .input_devices()
            .map_err(|e| IronMicError::Audio(e.to_string()))?
            .find(|d| d.name().ok().as_deref() == Some(device_name))
            .or_else(|| host.default_input_device())
            .ok_or_else(|| IronMicError::NoDevice(format!("Device '{device_name}' not found and no default available")))?;

        let found_name = device.name().unwrap_or_else(|_| "unknown".into());
        info!(requested = %device_name, using = %found_name, "Using input device");
        self.device_name = Some(found_name);

        let (config, format) = Self::preferred_config(&device)?;
        info!(
            sample_rate = config.sample_rate.0,
            channels = config.channels,
            ?format,
            "Recording config"
        );

        {
            let mut buf = self.buffer.lock().unwrap();
            buf.zero();
            buf.set_format(config.sample_rate.0, config.channels);
        }

        let stream = build_input_stream_for_format(
            &device,
            &config,
            format,
            Arc::clone(&self.buffer),
            Arc::clone(&self.recording),
        )?;

        stream
            .play()
            .map_err(|e| IronMicError::Audio(e.to_string()))?;

        self.recording.store(true, Ordering::SeqCst);
        self.stream = Some(stream);

        info!("Recording started (from named device)");
        Ok(())
    }

    /// Extract the current buffer contents and reset the buffer WITHOUT stopping the stream.
    /// Used by the meeting chunk loop every 30 seconds so the stream keeps running with zero gap.
    /// Caller is responsible for zeroing the returned CapturedAudio when done (privacy guarantee).
    pub fn drain_chunk(&mut self) -> Result<CapturedAudio, IronMicError> {
        if !self.is_recording() {
            return Err(IronMicError::NotRecording);
        }

        let mut buf = self.buffer.lock().unwrap();
        let sample_rate = buf.sample_rate();
        let channels = buf.channels();
        // take() uses mem::take — empties the Vec and transfers ownership to caller
        let samples = buf.take();
        // Re-set format metadata so subsequent push_samples() calls get correct metadata
        buf.set_format(sample_rate, channels);

        info!(
            samples = samples.len(),
            sample_rate,
            channels,
            "Buffer drained (stream still running)"
        );

        Ok(CapturedAudio {
            samples,
            sample_rate,
            channels,
        })
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

    /// Choose the best input config for Whisper transcription.
    ///
    /// Strategy: prefer F32 at a canonical rate close to 48 kHz, then any
    /// format at a canonical rate, then fall back to the first available config
    /// at max rate. Using max rate unconditionally caused problems on Windows
    /// WASAPI devices that report 192 kHz as their max — rubato handles the
    /// resampling but the very high ratio degrades quality. 48 kHz → 16 kHz
    /// (3:1) is the ideal target; 44100 and 96000 also resample cleanly.
    fn preferred_config(device: &Device) -> Result<(StreamConfig, SampleFormat), IronMicError> {
        const PREFERRED_RATES: &[u32] = &[48_000, 44_100, 16_000, 24_000, 96_000, 192_000];

        let supported: Vec<_> = device
            .supported_input_configs()
            .map_err(|e| IronMicError::Audio(e.to_string()))?
            .collect();

        if supported.is_empty() {
            return Err(IronMicError::NoDevice("No supported input configs found".into()));
        }

        // Pass 1: F32 at a preferred rate (best quality, no conversion needed).
        for &rate in PREFERRED_RATES {
            let sr = cpal::SampleRate(rate);
            for cfg in &supported {
                if cfg.sample_format() == SampleFormat::F32
                    && cfg.min_sample_rate() <= sr
                    && cfg.max_sample_rate() >= sr
                {
                    return Ok((cfg.with_sample_rate(sr).into(), SampleFormat::F32));
                }
            }
        }

        // Pass 2: any format at a preferred rate (will be converted to f32 in callback).
        for &rate in PREFERRED_RATES {
            let sr = cpal::SampleRate(rate);
            for cfg in &supported {
                if cfg.min_sample_rate() <= sr && cfg.max_sample_rate() >= sr {
                    let fmt = cfg.sample_format();
                    return Ok((cfg.with_sample_rate(sr).into(), fmt));
                }
            }
        }

        // Fallback: first available config at its max rate.
        let cfg = supported.into_iter().next().unwrap();
        let fmt = cfg.sample_format();
        Ok((cfg.with_max_sample_rate().into(), fmt))
    }
}

/// Build a cpal input stream that writes f32 samples into the shared ring
/// buffer regardless of the device's native sample format. Dispatches on
/// SampleFormat so I16 / U16 devices (common on Windows WASAPI laptop and USB
/// mics) are converted to f32 inside the audio callback before being pushed.
fn build_input_stream_for_format(
    device: &Device,
    config: &StreamConfig,
    format: SampleFormat,
    buffer: Arc<Mutex<AudioRingBuffer>>,
    recording: Arc<AtomicBool>,
) -> Result<Stream, IronMicError> {
    let err_callback = |err: cpal::StreamError| {
        error!(%err, "Audio stream error");
    };

    macro_rules! input_stream {
        ($t:ty) => {{
            let buffer = Arc::clone(&buffer);
            let recording = Arc::clone(&recording);
            device.build_input_stream(
                config,
                move |data: &[$t], _: &cpal::InputCallbackInfo| {
                    if recording.load(Ordering::SeqCst) {
                        if let Ok(mut buf) = buffer.lock() {
                            // Sample::to_sample::<f32>() handles I16/U16/F32/I32 etc.
                            let converted: Vec<f32> =
                                data.iter().map(|s| s.to_sample::<f32>()).collect();
                            buf.push_samples(&converted);
                        }
                    }
                },
                err_callback,
                None,
            )
        }};
    }

    let stream_result = match format {
        SampleFormat::F32 => input_stream!(f32),
        SampleFormat::I16 => input_stream!(i16),
        SampleFormat::U16 => input_stream!(u16),
        SampleFormat::I32 => input_stream!(i32),
        SampleFormat::I8 => input_stream!(i8),
        SampleFormat::U8 => input_stream!(u8),
        other => {
            return Err(IronMicError::Audio(format!(
                "Unsupported input sample format: {:?}",
                other
            )));
        }
    };
    stream_result.map_err(|e| IronMicError::Audio(e.to_string()))
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
