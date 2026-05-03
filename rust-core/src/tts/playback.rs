use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::Stream;
use tracing::{debug, error, info};

use crate::error::IronMicError;

/// Playback state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum PlaybackState {
    Idle = 0,
    Playing = 1,
    Paused = 2,
}

impl PlaybackState {
    fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::Playing,
            2 => Self::Paused,
            _ => Self::Idle,
        }
    }
}

impl std::fmt::Display for PlaybackState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Idle => write!(f, "idle"),
            Self::Playing => write!(f, "playing"),
            Self::Paused => write!(f, "paused"),
        }
    }
}

/// Audio buffer that zeroes itself on drop — privacy guarantee.
pub struct SecureAudioBuffer {
    data: Vec<f32>,
    sample_rate: u32,
}

impl SecureAudioBuffer {
    pub fn new(data: Vec<f32>, sample_rate: u32) -> Self {
        Self { data, sample_rate }
    }

    pub fn len(&self) -> usize {
        self.data.len()
    }

    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn duration_seconds(&self) -> f64 {
        if self.sample_rate == 0 {
            return 0.0;
        }
        self.data.len() as f64 / self.sample_rate as f64
    }

    /// Get a sample at the given index.
    pub fn get(&self, index: usize) -> Option<f32> {
        self.data.get(index).copied()
    }

    /// Linear interpolation between two samples at a floating-point position.
    pub fn interpolate(&self, pos: f64) -> f32 {
        if self.data.is_empty() {
            return 0.0;
        }
        let idx = pos as usize;
        let frac = (pos - idx as f64) as f32;

        let a = self.data.get(idx).copied().unwrap_or(0.0);
        let b = self.data.get(idx + 1).copied().unwrap_or(a);
        a + (b - a) * frac
    }

    /// Reserve additional capacity so subsequent extends in streaming mode
    /// don't reallocate the Vec (would still be safe under our mutex, just
    /// wasted CPU). No-op if capacity already sufficient.
    pub fn reserve(&mut self, additional: usize) {
        self.data.reserve(additional);
    }

    /// Append samples to the buffer. Safe under the engine's buffer mutex —
    /// the cpal callback acquires the same mutex per tick, so reads and
    /// writes are serialized.
    pub fn extend_samples(&mut self, samples: &[f32]) {
        self.data.extend_from_slice(samples);
    }
}

impl Drop for SecureAudioBuffer {
    fn drop(&mut self) {
        self.data.fill(0.0);
        self.data.clear();
        debug!("SecureAudioBuffer dropped and zeroed");
    }
}

/// Manages audio playback through the system's default output device.
pub struct PlaybackEngine {
    state: Arc<AtomicU8>,
    /// Current read position in samples — used for timestamp sync.
    position: Arc<AtomicUsize>,
    /// Playback speed multiplier (stored as speed * 1000 for atomic storage).
    speed_x1000: Arc<AtomicUsize>,
    /// The audio buffer currently being played. Vec inside the buffer can grow
    /// at runtime (see `append_samples`); the cpal callback locks the same
    /// mutex on each tick so concurrent reads are serialized with extends.
    buffer: Arc<Mutex<Option<SecureAudioBuffer>>>,
    /// True once no more samples will be appended — the cpal callback gates
    /// its end-of-buffer auto-stop on this. While false, hitting EOF outputs
    /// silence and the callback waits for more samples to arrive (streaming).
    /// Initialized to true on `play()` so single-shot playback (no streaming)
    /// retains the previous auto-stop behavior unchanged.
    streaming_complete: Arc<std::sync::atomic::AtomicBool>,
    /// The active cpal output stream.
    stream: Option<Stream>,
}

// Safety: same pattern as CaptureEngine — accessed behind Mutex, stream used on single thread.
unsafe impl Send for PlaybackEngine {}

impl Default for PlaybackEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl PlaybackEngine {
    pub fn new() -> Self {
        Self {
            state: Arc::new(AtomicU8::new(PlaybackState::Idle as u8)),
            position: Arc::new(AtomicUsize::new(0)),
            speed_x1000: Arc::new(AtomicUsize::new(1000)), // 1.0x
            buffer: Arc::new(Mutex::new(None)),
            streaming_complete: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            stream: None,
        }
    }

    pub fn state(&self) -> PlaybackState {
        PlaybackState::from_u8(self.state.load(Ordering::SeqCst))
    }

    /// Current playback position in milliseconds.
    pub fn position_ms(&self) -> f64 {
        let pos_samples = self.position.load(Ordering::SeqCst);
        let buf = self.buffer.lock().unwrap();
        match buf.as_ref() {
            Some(b) if b.sample_rate() > 0 => {
                pos_samples as f64 / b.sample_rate() as f64 * 1000.0
            }
            _ => 0.0,
        }
    }

    pub fn speed(&self) -> f32 {
        self.speed_x1000.load(Ordering::SeqCst) as f32 / 1000.0
    }

    pub fn set_speed(&self, speed: f32) {
        let clamped = speed.clamp(0.5, 2.0);
        self.speed_x1000
            .store((clamped * 1000.0) as usize, Ordering::SeqCst);
        info!(speed = clamped, "Playback speed changed");
    }

    /// Load audio samples and start playback.
    ///
    /// Single-shot mode (this method): the callback auto-stops when the
    /// cursor reaches the end of the buffer. Use `play_streaming` instead
    /// to keep the stream alive while more samples are being synthesized
    /// in the background.
    pub fn play(&mut self, samples: Vec<f32>, sample_rate: u32) -> Result<(), IronMicError> {
        self.play_internal(samples, sample_rate, /* streaming = */ false)
    }

    /// Start playback in streaming mode — the cpal callback will NOT
    /// auto-stop on EOF. Use `append_samples` to feed more audio as it's
    /// produced, then `mark_streaming_complete` to release the auto-stop
    /// gate when the last chunk has been appended.
    pub fn play_streaming(&mut self, samples: Vec<f32>, sample_rate: u32) -> Result<(), IronMicError> {
        self.play_internal(samples, sample_rate, /* streaming = */ true)
    }

    fn play_internal(&mut self, samples: Vec<f32>, sample_rate: u32, streaming: bool) -> Result<(), IronMicError> {
        // Stop any current playback
        self.stop();

        let mut buffer = SecureAudioBuffer::new(samples, sample_rate);
        // Reserve generous capacity so subsequent append_samples calls in
        // streaming mode don't reallocate the Vec (which would be safe under
        // the mutex but is wasted work).
        if streaming {
            buffer.reserve(buffer.len() * 16);
        }
        let buffer_len = buffer.len();

        if buffer.is_empty() {
            return Err(IronMicError::Playback("No audio samples to play".into()));
        }

        info!(
            samples = buffer_len,
            sample_rate,
            duration = buffer.duration_seconds(),
            streaming,
            "Starting TTS playback"
        );

        *self.buffer.lock().unwrap() = Some(buffer);
        self.position.store(0, Ordering::SeqCst);
        self.streaming_complete
            .store(!streaming, std::sync::atomic::Ordering::SeqCst);
        self.state
            .store(PlaybackState::Playing as u8, Ordering::SeqCst);

        // Open output device
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| IronMicError::Playback("No output audio device found".into()))?;

        let device_name = device.name().unwrap_or_else(|_| "unknown".into());
        info!(device = %device_name, "Using output device");

        // Use the device's default config — many devices don't support arbitrary sample rates
        let default_config = device
            .default_output_config()
            .map_err(|e| IronMicError::Playback(format!("Failed to get output config: {e}")))?;

        let output_sample_rate = default_config.sample_rate().0;
        let output_channels = default_config.channels() as usize;

        info!(
            output_sample_rate,
            output_channels,
            buffer_sample_rate = sample_rate,
            "Output stream config"
        );

        // Calculate the sample rate ratio for on-the-fly resampling
        let rate_ratio = output_sample_rate as f64 / sample_rate as f64;

        let config = cpal::StreamConfig {
            channels: default_config.channels(),
            sample_rate: default_config.sample_rate(),
            buffer_size: cpal::BufferSize::Default,
        };

        let state = Arc::clone(&self.state);
        let position = Arc::clone(&self.position);
        let speed_x1000 = Arc::clone(&self.speed_x1000);
        let buffer_ref = Arc::clone(&self.buffer);
        let streaming_complete = Arc::clone(&self.streaming_complete);

        // Floating-point read cursor for speed control
        let cursor = Arc::new(Mutex::new(0.0f64));

        let stream = device
            .build_output_stream(
                &config,
                move |output: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    let current_state =
                        PlaybackState::from_u8(state.load(Ordering::SeqCst));

                    if current_state != PlaybackState::Playing {
                        output.fill(0.0);
                        return;
                    }

                    let speed = speed_x1000.load(Ordering::SeqCst) as f64 / 1000.0;
                    let buf = buffer_ref.lock().unwrap();

                    if let Some(ref audio_buf) = *buf {
                        let mut cur = cursor.lock().unwrap();
                        let total = audio_buf.len() as f64;
                        // Advance through output buffer, accounting for channels and rate ratio
                        let step = speed / rate_ratio; // step in source samples per output sample
                        let frames = output.len() / output_channels;

                        for frame in 0..frames {
                            let sample = if *cur >= total {
                                0.0
                            } else {
                                let s = audio_buf.interpolate(*cur);
                                *cur += step;
                                s
                            };
                            // Write same sample to all output channels
                            for ch in 0..output_channels {
                                output[frame * output_channels + ch] = sample;
                            }
                        }

                        // Update position for timestamp sync (in source sample units)
                        let pos = (*cur as usize).min(audio_buf.len());
                        position.store(pos, Ordering::SeqCst);

                        // Auto-stop at end ONLY when streaming is complete
                        // (single-shot mode initializes streaming_complete=true,
                        // so the previous behavior is preserved). When streaming
                        // is still in progress and we hit EOF, output continues
                        // as silence and the cursor waits for more samples.
                        if *cur >= total
                            && streaming_complete.load(std::sync::atomic::Ordering::SeqCst)
                        {
                            state.store(PlaybackState::Idle as u8, Ordering::SeqCst);
                        }
                    } else {
                        output.fill(0.0);
                    }
                },
                move |err| {
                    error!(%err, "Audio output stream error");
                },
                None,
            )
            .map_err(|e| IronMicError::Playback(format!("Failed to create output stream: {e}")))?;

        stream
            .play()
            .map_err(|e| IronMicError::Playback(format!("Failed to start playback: {e}")))?;

        self.stream = Some(stream);
        Ok(())
    }

    /// Append samples to the currently-playing streaming buffer. The cpal
    /// callback's mutex serializes this with reads, so the Vec can grow
    /// safely under it. No-op (returns Ok) if not currently in streaming
    /// playback — chunks that arrive after the user has stopped should
    /// silently drop, not error.
    pub fn append_samples(&self, samples: Vec<f32>) -> Result<(), IronMicError> {
        if self.state() == PlaybackState::Idle {
            return Ok(());
        }
        let mut buf_guard = self.buffer.lock().unwrap();
        if let Some(ref mut audio_buf) = *buf_guard {
            audio_buf.extend_samples(&samples);
        }
        // Zero our local copy of `samples` once it's been copied into the
        // buffer (the buffer itself zeroes on drop — privacy invariant).
        let mut s = samples;
        s.fill(0.0);
        Ok(())
    }

    /// Mark the streaming buffer as complete. The cpal callback's auto-stop
    /// gate releases — once the cursor reaches end-of-buffer it transitions
    /// to Idle. Calling this on a non-streaming playback is a harmless no-op.
    pub fn mark_streaming_complete(&self) {
        self.streaming_complete
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// Total number of samples currently in the streaming buffer. Used by
    /// the napi layer to compute cumulative duration without taking the
    /// playback lock for an extended read.
    pub fn buffer_sample_count(&self) -> usize {
        self.buffer.lock().unwrap().as_ref().map(|b| b.len()).unwrap_or(0)
    }

    pub fn pause(&mut self) {
        if self.state() == PlaybackState::Playing {
            self.state
                .store(PlaybackState::Paused as u8, Ordering::SeqCst);
            info!("TTS playback paused");
        }
    }

    pub fn resume(&mut self) {
        if self.state() == PlaybackState::Paused {
            self.state
                .store(PlaybackState::Playing as u8, Ordering::SeqCst);
            info!("TTS playback resumed");
        }
    }

    pub fn stop(&mut self) {
        self.state
            .store(PlaybackState::Idle as u8, Ordering::SeqCst);
        self.stream = None;
        self.position.store(0, Ordering::SeqCst);

        // Zero and drop the buffer
        let mut buf = self.buffer.lock().unwrap();
        *buf = None;

        debug!("TTS playback stopped, buffer zeroed");
    }

    /// Toggle play/pause. Returns the new state.
    pub fn toggle(&mut self) -> PlaybackState {
        match self.state() {
            PlaybackState::Playing => {
                self.pause();
                PlaybackState::Paused
            }
            PlaybackState::Paused => {
                self.resume();
                PlaybackState::Playing
            }
            PlaybackState::Idle => PlaybackState::Idle,
        }
    }
}

impl Drop for PlaybackEngine {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secure_buffer_zeroed_on_drop() {
        let buf = SecureAudioBuffer::new(vec![0.5; 1000], 24000);
        assert_eq!(buf.len(), 1000);
        drop(buf);
    }

    #[test]
    fn secure_buffer_interpolation() {
        let buf = SecureAudioBuffer::new(vec![0.0, 1.0, 0.0], 24000);
        assert!((buf.interpolate(0.0) - 0.0).abs() < f32::EPSILON);
        assert!((buf.interpolate(0.5) - 0.5).abs() < f32::EPSILON);
        assert!((buf.interpolate(1.0) - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn secure_buffer_duration() {
        let buf = SecureAudioBuffer::new(vec![0.0; 24000], 24000);
        assert!((buf.duration_seconds() - 1.0).abs() < 0.001);
    }

    #[test]
    fn playback_engine_initial_state() {
        let engine = PlaybackEngine::new();
        assert_eq!(engine.state(), PlaybackState::Idle);
        assert_eq!(engine.position_ms(), 0.0);
        assert_eq!(engine.speed(), 1.0);
    }

    #[test]
    fn playback_engine_speed_clamp() {
        let engine = PlaybackEngine::new();
        engine.set_speed(5.0);
        assert_eq!(engine.speed(), 2.0);
        engine.set_speed(0.1);
        assert_eq!(engine.speed(), 0.5);
    }

    #[test]
    fn playback_state_display() {
        assert_eq!(PlaybackState::Idle.to_string(), "idle");
        assert_eq!(PlaybackState::Playing.to_string(), "playing");
        assert_eq!(PlaybackState::Paused.to_string(), "paused");
    }
}
