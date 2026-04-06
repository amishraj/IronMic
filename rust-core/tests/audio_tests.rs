use ironmic_core::audio::capture::{AudioRingBuffer, CaptureEngine, CapturedAudio};
use ironmic_core::audio::processor::{f32_to_i16_pcm, prepare_for_whisper};

// ── Ring Buffer Tests ──

#[test]
fn ring_buffer_starts_empty() {
    let buf = AudioRingBuffer::new();
    assert!(buf.is_empty());
    assert_eq!(buf.len(), 0);
    assert_eq!(buf.sample_rate(), 0);
    assert_eq!(buf.channels(), 0);
}

#[test]
fn ring_buffer_push_and_read() {
    let mut buf = AudioRingBuffer::new();
    buf.set_format(44100, 2);
    buf.push_samples(&[0.1, 0.2, 0.3, 0.4]);
    assert_eq!(buf.len(), 4);
    assert_eq!(buf.samples(), &[0.1, 0.2, 0.3, 0.4]);
    assert_eq!(buf.sample_rate(), 44100);
    assert_eq!(buf.channels(), 2);
}

#[test]
fn ring_buffer_with_capacity() {
    let buf = AudioRingBuffer::with_capacity(8192);
    assert!(buf.is_empty());
}

#[test]
fn ring_buffer_take_returns_data_and_clears() {
    let mut buf = AudioRingBuffer::new();
    buf.set_format(16000, 1);
    buf.push_samples(&[0.5, -0.5, 0.25]);

    let data = buf.take();
    assert_eq!(data.len(), 3);
    assert_eq!(data, vec![0.5, -0.5, 0.25]);
    assert!(buf.is_empty());
    assert_eq!(buf.sample_rate(), 0);
    assert_eq!(buf.channels(), 0);
}

#[test]
fn ring_buffer_zero_clears_completely() {
    let mut buf = AudioRingBuffer::new();
    buf.set_format(48000, 2);
    buf.push_samples(&[1.0; 5000]);
    assert_eq!(buf.len(), 5000);

    buf.zero();
    assert!(buf.is_empty());
    assert_eq!(buf.sample_rate(), 0);
}

#[test]
fn ring_buffer_multiple_pushes_accumulate() {
    let mut buf = AudioRingBuffer::new();
    buf.set_format(16000, 1);
    buf.push_samples(&[0.1, 0.2]);
    buf.push_samples(&[0.3, 0.4]);
    buf.push_samples(&[0.5]);
    assert_eq!(buf.len(), 5);
    assert_eq!(buf.samples(), &[0.1, 0.2, 0.3, 0.4, 0.5]);
}

#[test]
fn ring_buffer_drop_does_not_panic() {
    let mut buf = AudioRingBuffer::new();
    buf.push_samples(&[0.5; 10000]);
    drop(buf);
}

// ── CaptureEngine Tests ──

#[test]
fn engine_starts_idle() {
    let engine = CaptureEngine::new();
    assert!(!engine.is_recording());
}

#[test]
fn engine_stop_without_start_is_error() {
    let mut engine = CaptureEngine::new();
    let result = engine.stop();
    assert!(result.is_err());
    assert!(result.is_err());
}

#[test]
fn engine_drop_while_idle_does_not_panic() {
    let engine = CaptureEngine::new();
    drop(engine);
}

// ── CapturedAudio Tests ──

#[test]
fn captured_audio_duration_mono() {
    let audio = CapturedAudio {
        samples: vec![0.0; 32000],
        sample_rate: 16000,
        channels: 1,
    };
    assert!((audio.duration_seconds() - 2.0).abs() < 0.001);
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
fn captured_audio_duration_empty() {
    let audio = CapturedAudio {
        samples: vec![],
        sample_rate: 0,
        channels: 0,
    };
    assert_eq!(audio.duration_seconds(), 0.0);
}

#[test]
fn captured_audio_zero() {
    let mut audio = CapturedAudio {
        samples: vec![0.8; 1000],
        sample_rate: 16000,
        channels: 1,
    };
    audio.zero();
    assert!(audio.samples.is_empty());
}

// ── Processor Tests ──

#[test]
fn prepare_for_whisper_mono_16k_passthrough() {
    let captured = CapturedAudio {
        samples: vec![0.3; 16000],
        sample_rate: 16000,
        channels: 1,
    };
    let processed = prepare_for_whisper(&captured).unwrap();
    // Already in target format — should pass through
    assert_eq!(processed.samples.len(), 16000);
    assert!((processed.duration_seconds - 1.0).abs() < 0.01);
}

#[test]
fn prepare_for_whisper_downmixes_stereo() {
    // 1 second of 16kHz stereo = 32000 interleaved samples
    let captured = CapturedAudio {
        samples: vec![0.4; 32000],
        sample_rate: 16000,
        channels: 2,
    };
    let processed = prepare_for_whisper(&captured).unwrap();
    // After downmix: 16000 mono samples, no resampling needed
    assert_eq!(processed.samples.len(), 16000);
}

#[test]
fn prepare_for_whisper_resamples_48k_to_16k() {
    // 1 second of 48kHz mono = 48000 samples
    let captured = CapturedAudio {
        samples: vec![0.2; 48000],
        sample_rate: 48000,
        channels: 1,
    };
    let processed = prepare_for_whisper(&captured).unwrap();
    // Should be ~16000 samples
    let diff = (processed.samples.len() as i64 - 16000).unsigned_abs();
    assert!(
        diff < 200,
        "Expected ~16000 samples, got {}",
        processed.samples.len()
    );
}

#[test]
fn prepare_for_whisper_stereo_48k() {
    // 1 second of 48kHz stereo = 96000 interleaved samples
    let captured = CapturedAudio {
        samples: vec![0.1; 96000],
        sample_rate: 48000,
        channels: 2,
    };
    let processed = prepare_for_whisper(&captured).unwrap();
    let diff = (processed.samples.len() as i64 - 16000).unsigned_abs();
    assert!(
        diff < 200,
        "Expected ~16000 samples, got {}",
        processed.samples.len()
    );
}

#[test]
fn prepare_for_whisper_rejects_empty() {
    let captured = CapturedAudio {
        samples: vec![],
        sample_rate: 44100,
        channels: 1,
    };
    assert!(prepare_for_whisper(&captured).is_err());
}

#[test]
fn f32_to_i16_basic() {
    let pcm = f32_to_i16_pcm(&[0.0, 1.0, -1.0]);
    assert_eq!(pcm[0], 0);
    assert_eq!(pcm[1], i16::MAX);
    assert_eq!(pcm[2], -i16::MAX);
}

#[test]
fn f32_to_i16_clamps_out_of_range() {
    let pcm = f32_to_i16_pcm(&[5.0, -5.0]);
    assert_eq!(pcm[0], i16::MAX);
    assert_eq!(pcm[1], -i16::MAX);
}
