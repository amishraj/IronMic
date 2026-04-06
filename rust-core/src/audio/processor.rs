use rubato::{FftFixedIn, Resampler};
use tracing::{debug, info};

use crate::audio::capture::CapturedAudio;
use crate::error::IronMicError;

/// Target format for Whisper: 16kHz mono PCM f32
const WHISPER_SAMPLE_RATE: u32 = 16000;
/// Processed audio ready for Whisper inference.
pub struct ProcessedAudio {
    /// 16kHz mono f32 PCM samples
    pub samples: Vec<f32>,
    /// Duration in seconds
    pub duration_seconds: f64,
}

impl Drop for ProcessedAudio {
    fn drop(&mut self) {
        // Privacy: zero audio data on drop
        self.samples.fill(0.0);
        self.samples.clear();
        debug!("ProcessedAudio dropped and zeroed");
    }
}

/// Convert captured audio to 16kHz mono PCM for Whisper.
pub fn prepare_for_whisper(captured: &CapturedAudio) -> Result<ProcessedAudio, IronMicError> {
    let src_rate = captured.sample_rate;
    let src_channels = captured.channels;

    if captured.samples.is_empty() {
        return Err(IronMicError::Processing("No audio samples to process".into()));
    }

    info!(
        src_rate,
        src_channels,
        src_samples = captured.samples.len(),
        "Processing audio for Whisper"
    );

    // Step 1: Convert to mono if needed
    let mono = if src_channels > 1 {
        downmix_to_mono(&captured.samples, src_channels)
    } else {
        captured.samples.clone()
    };

    // Step 2: Resample to 16kHz if needed
    let resampled = if src_rate != WHISPER_SAMPLE_RATE {
        resample(&mono, src_rate, WHISPER_SAMPLE_RATE)?
    } else {
        mono
    };

    let duration_seconds = resampled.len() as f64 / WHISPER_SAMPLE_RATE as f64;

    info!(
        output_samples = resampled.len(),
        duration_seconds, "Audio processing complete"
    );

    Ok(ProcessedAudio {
        samples: resampled,
        duration_seconds,
    })
}

/// Downmix interleaved multi-channel audio to mono by averaging channels.
fn downmix_to_mono(samples: &[f32], channels: u16) -> Vec<f32> {
    let ch = channels as usize;
    let frame_count = samples.len() / ch;
    let mut mono = Vec::with_capacity(frame_count);

    for frame in 0..frame_count {
        let offset = frame * ch;
        let mut sum = 0.0f32;
        for c in 0..ch {
            sum += samples[offset + c];
        }
        mono.push(sum / ch as f32);
    }

    debug!(
        input_samples = samples.len(),
        output_samples = mono.len(),
        channels,
        "Downmixed to mono"
    );
    mono
}

/// Resample audio from src_rate to dst_rate using rubato.
fn resample(samples: &[f32], src_rate: u32, dst_rate: u32) -> Result<Vec<f32>, IronMicError> {
    if samples.is_empty() {
        return Ok(Vec::new());
    }

    let chunk_size = 1024;

    let mut resampler = FftFixedIn::<f32>::new(
        src_rate as usize,
        dst_rate as usize,
        chunk_size,
        2, // sub-chunks for interpolation
        1, // mono channel
    )
    .map_err(|e| IronMicError::Processing(format!("Failed to create resampler: {e}")))?;

    let mut output = Vec::new();

    // Process in chunks
    let mut pos = 0;
    while pos < samples.len() {
        let end = (pos + chunk_size).min(samples.len());
        let mut chunk = samples[pos..end].to_vec();

        // Pad last chunk if needed
        if chunk.len() < chunk_size {
            chunk.resize(chunk_size, 0.0);
        }

        let result = resampler
            .process(&[chunk], None)
            .map_err(|e| IronMicError::Processing(format!("Resample error: {e}")))?;

        if !result.is_empty() {
            output.extend_from_slice(&result[0]);
        }

        pos += chunk_size;
    }

    // Trim output to expected length
    let expected_len = (samples.len() as f64 * dst_rate as f64 / src_rate as f64) as usize;
    output.truncate(expected_len);

    debug!(
        src_rate,
        dst_rate,
        input_samples = samples.len(),
        output_samples = output.len(),
        "Resampled audio"
    );

    Ok(output)
}

/// Convert f32 samples [-1.0, 1.0] to i16 PCM for Whisper.
pub fn f32_to_i16_pcm(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|&s| {
            let clamped = s.clamp(-1.0, 1.0);
            (clamped * i16::MAX as f32) as i16
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmix_stereo_to_mono() {
        // Stereo: L=1.0, R=-1.0 for each frame → mono should be 0.0
        let stereo = vec![1.0f32, -1.0, 0.5, 0.5, -0.5, 0.3];
        let mono = downmix_to_mono(&stereo, 2);
        assert_eq!(mono.len(), 3);
        assert!((mono[0] - 0.0).abs() < f32::EPSILON);
        assert!((mono[1] - 0.5).abs() < f32::EPSILON);
        assert!((mono[2] - (-0.1)).abs() < 0.001);
    }

    #[test]
    fn mono_passthrough() {
        let mono_input = vec![0.1, 0.2, 0.3];
        let result = downmix_to_mono(&mono_input, 1);
        assert_eq!(result, mono_input);
    }

    #[test]
    fn f32_to_i16_conversion() {
        let samples = vec![0.0, 1.0, -1.0, 0.5];
        let pcm = f32_to_i16_pcm(&samples);
        assert_eq!(pcm[0], 0);
        assert_eq!(pcm[1], i16::MAX);
        assert_eq!(pcm[2], -i16::MAX);
        assert!((pcm[3] - i16::MAX / 2).abs() <= 1);
    }

    #[test]
    fn f32_to_i16_clamps() {
        let samples = vec![2.0, -2.0];
        let pcm = f32_to_i16_pcm(&samples);
        assert_eq!(pcm[0], i16::MAX);
        assert_eq!(pcm[1], -i16::MAX);
    }

    #[test]
    fn resample_same_rate_passthrough() {
        let samples = vec![0.1; 2048];
        let result = resample(&samples, 16000, 16000).unwrap();
        // Same rate: output should be same length
        assert_eq!(result.len(), samples.len());
    }

    #[test]
    fn resample_downsample() {
        // 48kHz → 16kHz should produce ~1/3 the samples
        let samples = vec![0.5; 4800];
        let result = resample(&samples, 48000, 16000).unwrap();
        let expected = 1600;
        // Allow some tolerance due to resampler filter
        assert!(
            (result.len() as i64 - expected as i64).unsigned_abs() < 100,
            "Expected ~{expected} samples, got {}",
            result.len()
        );
    }

    #[test]
    fn prepare_for_whisper_mono_16k() {
        let captured = CapturedAudio {
            samples: vec![0.3; 16000],
            sample_rate: 16000,
            channels: 1,
        };
        let processed = prepare_for_whisper(&captured).unwrap();
        assert_eq!(processed.samples.len(), 16000);
        assert!((processed.duration_seconds - 1.0).abs() < 0.01);
    }

    #[test]
    fn prepare_for_whisper_stereo_48k() {
        // 1 second of 48kHz stereo = 96000 interleaved samples
        let captured = CapturedAudio {
            samples: vec![0.2; 96000],
            sample_rate: 48000,
            channels: 2,
        };
        let processed = prepare_for_whisper(&captured).unwrap();
        // Should be ~16000 samples (1 second at 16kHz mono)
        let expected = 16000;
        assert!(
            (processed.samples.len() as i64 - expected as i64).unsigned_abs() < 200,
            "Expected ~{expected} samples, got {}",
            processed.samples.len()
        );
    }

    #[test]
    fn prepare_for_whisper_empty_errors() {
        let captured = CapturedAudio {
            samples: vec![],
            sample_rate: 16000,
            channels: 1,
        };
        assert!(prepare_for_whisper(&captured).is_err());
    }

    #[test]
    fn processed_audio_zeroed_on_drop() {
        let processed = ProcessedAudio {
            samples: vec![0.5; 1000],
            duration_seconds: 1.0,
        };
        drop(processed);
        // Drop impl zeros and clears — test verifies no panic
    }
}
