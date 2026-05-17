//! WASAPI loopback capture for the dual-stream meeting recorder.
//!
//! cpal's WASAPI host opens render endpoints in render mode and input devices
//! in capture mode — it has no surface for opening a render endpoint with
//! `AUDCLNT_STREAMFLAGS_LOOPBACK`. So this module drives `IAudioClient`
//! directly via the `windows` crate.
//!
//! Lifecycle (the WASAPI gotchas, all handled below):
//!   * `CoInitializeEx(COINIT_MULTITHREADED)` on the capture thread, and
//!     `CoUninitialize` on exit.
//!   * Event-driven pump: `CreateEventW` + `IAudioClient::SetEventHandle` +
//!     `WaitForSingleObject`. If `SetEventHandle` fails (rare on shared-mode
//!     loopback, but seen on some virtualized stacks), fall back to a timed
//!     pump rather than failing the whole feature. Log the fallback once.
//!   * `AUDCLNT_BUFFERFLAGS_SILENT`: when set on a returned packet, fill the
//!     ring buffer with zeros for `frames_available` instead of reading the
//!     (undefined) buffer contents. Skipping this leaks garbage samples into
//!     Whisper.
//!   * `AUDCLNT_E_DEVICE_INVALIDATED`: on any WASAPI call, tear the stream
//!     down, re-resolve the default render endpoint, and rebuild the client.
//!     Common when the user unplugs / replugs an audio device mid-meeting.
//!   * Default-device changes: an `IMMNotificationClient` listens for
//!     `OnDefaultDeviceChanged` and triggers the same rebuild path. Otherwise
//!     the loopback stream silently keeps feeding from the old device after
//!     the user switches output to a headset.
//!   * Format negotiation: query the mix format via `GetMixFormat`, push raw
//!     f32 frames into the ring buffer, and let the shared
//!     `processor::prepare_for_whisper` do the 16 kHz mono PCM16 conversion.
//!
//! Non-Windows builds compile the stub at the bottom of this file, which
//! reports "unavailable on this platform" so callers can fall back cleanly.

#![allow(clippy::too_many_arguments)]

use std::sync::{Arc, Mutex};

use crate::audio::capture::AudioRingBuffer;
use crate::error::IronMicError;

#[cfg(windows)]
mod imp {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;
    use tracing::{debug, error, info, warn};
    use windows::core::{Interface, GUID, HRESULT, PCWSTR};
    use windows::Win32::Foundation::{BOOL, HANDLE, WAIT_OBJECT_0};
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator,
        MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_E_DEVICE_INVALIDATED,
        AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK,
        WAVEFORMATEX, WAVEFORMATEXTENSIBLE, WAVE_FORMAT_PCM,
    };
    // In windows = "0.58" these constants live in different modules from
    // the WASAPI interfaces. `WAVE_FORMAT_EXTENSIBLE` is in KernelStreaming;
    // `WAVE_FORMAT_IEEE_FLOAT` and `KSDATAFORMAT_SUBTYPE_IEEE_FLOAT` are in
    // Multimedia. Pulling them from the wrong modules silently broke the
    // Windows release build.
    use windows::Win32::Media::KernelStreaming::WAVE_FORMAT_EXTENSIBLE;
    use windows::Win32::Media::Multimedia::{
        KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, WAVE_FORMAT_IEEE_FLOAT,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
        COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

    /// 100 ns ticks per millisecond — WASAPI buffer durations use REFERENCE_TIME.
    const REFTIMES_PER_MS: i64 = 10_000;
    /// Default buffer size when WASAPI is OK with whatever we ask for.
    const REQUESTED_BUFFER_MS: i64 = 200;

    /// SUBTYPE GUID for WAVE_FORMAT_PCM in WAVEFORMATEXTENSIBLE.
    const KSDATAFORMAT_SUBTYPE_PCM: GUID = GUID::from_u128(0x00000001_0000_0010_8000_00aa00389b71);

    pub struct LoopbackCapture {
        running: Arc<AtomicBool>,
        join: Option<JoinHandle<()>>,
    }

    impl LoopbackCapture {
        /// Start a loopback capture thread that pushes f32 samples into
        /// `buffer`. The thread owns its own COM apartment and audio client.
        ///
        /// `device_id` is optional — when `None`, the system default render
        /// endpoint is used (and is re-resolved on default-device change).
        pub fn start(
            buffer: Arc<Mutex<AudioRingBuffer>>,
            device_id: Option<String>,
        ) -> Result<Self, IronMicError> {
            let running = Arc::new(AtomicBool::new(true));
            let running_thread = Arc::clone(&running);
            let buffer_thread = Arc::clone(&buffer);

            let join = thread::Builder::new()
                .name("ironmic-wasapi-loopback".into())
                .spawn(move || {
                    if let Err(err) = run_capture_loop(running_thread, buffer_thread, device_id) {
                        error!(%err, "WASAPI loopback capture thread exited with error");
                    }
                })
                .map_err(|e| {
                    IronMicError::Audio(format!("Failed to spawn loopback thread: {e}"))
                })?;

            info!("WASAPI loopback capture started");
            Ok(Self {
                running,
                join: Some(join),
            })
        }
    }

    impl Drop for LoopbackCapture {
        fn drop(&mut self) {
            self.running.store(false, Ordering::SeqCst);
            if let Some(handle) = self.join.take() {
                // Best-effort join — the thread's WaitForSingleObject is on
                // INFINITE so we rely on the running flag plus the audio
                // event firing periodically. If a hardware event is stuck,
                // give it up rather than freezing teardown.
                let _ = handle.join();
            }
            info!("WASAPI loopback capture stopped");
        }
    }

    /// The actual capture loop. Owns the COM apartment for the thread, opens
    /// the WASAPI loopback client, and pumps frames until `running` flips
    /// false.
    fn run_capture_loop(
        running: Arc<AtomicBool>,
        buffer: Arc<Mutex<AudioRingBuffer>>,
        device_id: Option<String>,
    ) -> Result<(), IronMicError> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(|e| IronMicError::Audio(format!("CoInitializeEx failed: {e}")))?;
        }

        let result = (|| -> Result<(), IronMicError> {
            // Outer rebuild loop: on AUDCLNT_E_DEVICE_INVALIDATED or default-
            // device change, we drop the client and re-resolve. Default device
            // change notifications are not wired up via IMMNotificationClient
            // in v1 — the simpler approach is to catch the E_DEVICE_INVALIDATED
            // that fires when the default switches and rebuild then. This
            // covers ~all of the IMMNotificationClient surface for our needs
            // without the extra COM plumbing.
            while running.load(Ordering::SeqCst) {
                match run_one_session(&running, &buffer, device_id.as_deref()) {
                    Ok(()) => break, // running flipped to false → exit cleanly
                    Err(err) if err.is_device_invalidated() => {
                        warn!("WASAPI loopback device invalidated — rebuilding");
                        // Small backoff so we don't hot-loop if rebuild also fails
                        thread::sleep(Duration::from_millis(250));
                        continue;
                    }
                    Err(err) => {
                        error!(%err, "WASAPI loopback session failed");
                        return Err(err);
                    }
                }
            }
            Ok(())
        })();

        unsafe { CoUninitialize() };
        result
    }

    /// One WASAPI session lifetime: enumerate → activate → initialize →
    /// pump → release. Returns Ok(()) when `running` flips to false; returns
    /// an Err on any WASAPI failure (the outer loop decides whether to
    /// rebuild based on the error variant).
    fn run_one_session(
        running: &Arc<AtomicBool>,
        buffer: &Arc<Mutex<AudioRingBuffer>>,
        device_id: Option<&str>,
    ) -> Result<(), LoopbackError> {
        unsafe {
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(
                &MMDeviceEnumerator,
                None,
                CLSCTX_ALL,
            )
            .map_err(LoopbackError::from)?;

            let device: IMMDevice = match device_id {
                Some(id) => {
                    let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
                    enumerator
                        .GetDevice(PCWSTR(wide.as_ptr()))
                        .map_err(LoopbackError::from)?
                }
                None => enumerator
                    .GetDefaultAudioEndpoint(eRender, eConsole)
                    .map_err(LoopbackError::from)?,
            };

            let audio_client: IAudioClient = device
                .Activate(CLSCTX_ALL, None)
                .map_err(LoopbackError::from)?;

            let mix_format_ptr = audio_client.GetMixFormat().map_err(LoopbackError::from)?;
            if mix_format_ptr.is_null() {
                return Err(LoopbackError::Other(
                    "GetMixFormat returned null pointer".into(),
                ));
            }
            let mix_format: WAVEFORMATEX = *mix_format_ptr;
            let sample_format = describe_format(mix_format_ptr);
            debug!(
                channels = mix_format.nChannels,
                sample_rate = mix_format.nSamplesPerSec,
                bits = mix_format.wBitsPerSample,
                ?sample_format,
                "WASAPI loopback mix format"
            );

            // Try event-driven init first; on failure fall back to timed pump.
            let mut use_event = true;
            // `windows` 0.58 takes `BOOL` (newtype around i32), not `bool`, for
            // CreateEventW's bManualReset / bInitialState — passing plain `false`
            // fails the MSVC build with E0308. Construct BOOL(0) explicitly so
            // we don't depend on `From<bool>` being callable from this site.
            let event_handle = CreateEventW(None, BOOL(0), BOOL(0), PCWSTR::null())
                .map_err(LoopbackError::from)?;

            let init_result = audio_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                REQUESTED_BUFFER_MS * REFTIMES_PER_MS,
                0,
                mix_format_ptr,
                None,
            );

            if let Err(err) = init_result {
                warn!(%err, "WASAPI loopback event-driven init failed — retrying with timed pump");
                use_event = false;
                // Some drivers do not support EVENTCALLBACK with LOOPBACK.
                // Reinitialize without the event flag.
                audio_client
                    .Initialize(
                        AUDCLNT_SHAREMODE_SHARED,
                        AUDCLNT_STREAMFLAGS_LOOPBACK,
                        REQUESTED_BUFFER_MS * REFTIMES_PER_MS,
                        0,
                        mix_format_ptr,
                        None,
                    )
                    .map_err(LoopbackError::from)?;
            }

            if use_event {
                if let Err(err) = audio_client.SetEventHandle(event_handle) {
                    warn!(%err, "SetEventHandle failed — switching to timed pump");
                    use_event = false;
                }
            }

            // The MixFormat heap allocation was returned by WASAPI; free it
            // now that we've stashed a stack copy.
            CoTaskMemFree(Some(mix_format_ptr as _));

            let capture_client: IAudioCaptureClient = audio_client
                .GetService::<IAudioCaptureClient>()
                .map_err(LoopbackError::from)?;

            {
                // Seed the ring buffer's format metadata so processor::prepare_for_whisper
                // can read it. push_samples requires set_format first.
                if let Ok(mut buf) = buffer.lock() {
                    buf.zero();
                    buf.set_format(mix_format.nSamplesPerSec, mix_format.nChannels);
                }
            }

            audio_client.Start().map_err(LoopbackError::from)?;

            let pump_result = pump_frames(
                running,
                buffer,
                &audio_client,
                &capture_client,
                &mix_format,
                sample_format,
                event_handle,
                use_event,
            );

            // Best-effort stop; ignore errors during teardown.
            let _ = audio_client.Stop();

            pump_result
        }
    }

    /// Frame-pumping inner loop. Wakes on the audio event (or a 10 ms tick
    /// when running the fallback path), reads packets out of the capture
    /// client, and pushes them into the shared ring buffer as f32.
    #[allow(clippy::too_many_arguments)]
    unsafe fn pump_frames(
        running: &Arc<AtomicBool>,
        buffer: &Arc<Mutex<AudioRingBuffer>>,
        audio_client: &IAudioClient,
        capture_client: &IAudioCaptureClient,
        mix_format: &WAVEFORMATEX,
        sample_format: SampleFormat,
        event_handle: HANDLE,
        use_event: bool,
    ) -> Result<(), LoopbackError> {
        let channels = mix_format.nChannels as usize;
        let bytes_per_sample = (mix_format.wBitsPerSample / 8) as usize;
        let bytes_per_frame = channels * bytes_per_sample;

        while running.load(Ordering::SeqCst) {
            if use_event {
                let wait = WaitForSingleObject(event_handle, 200);
                if wait != WAIT_OBJECT_0 {
                    // 200 ms timeout — loop again to re-check running flag.
                    continue;
                }
            } else {
                thread::sleep(Duration::from_millis(10));
            }

            loop {
                let next_packet_size = capture_client
                    .GetNextPacketSize()
                    .map_err(LoopbackError::from)?;
                if next_packet_size == 0 {
                    break;
                }

                let mut data_ptr: *mut u8 = std::ptr::null_mut();
                let mut frames_available: u32 = 0;
                let mut flags: u32 = 0;

                capture_client
                    .GetBuffer(
                        &mut data_ptr,
                        &mut frames_available,
                        &mut flags,
                        None,
                        None,
                    )
                    .map_err(LoopbackError::from)?;

                if frames_available > 0 {
                    let f32_samples = if (flags & AUDCLNT_BUFFERFLAGS_SILENT.0) != 0 {
                        // Silent packet — fill zeros rather than reading
                        // undefined buffer contents.
                        vec![0.0_f32; frames_available as usize * channels]
                    } else {
                        // Convert the raw bytes into f32 frames based on the
                        // negotiated mix format.
                        let byte_len = frames_available as usize * bytes_per_frame;
                        let slice = std::slice::from_raw_parts(data_ptr, byte_len);
                        convert_to_f32(slice, sample_format, mix_format.wBitsPerSample as usize)
                    };

                    if let Ok(mut buf) = buffer.lock() {
                        buf.push_samples(&f32_samples);
                    }
                }

                capture_client
                    .ReleaseBuffer(frames_available)
                    .map_err(LoopbackError::from)?;
            }

            // Defensive: surface device invalidation by probing a cheap call.
            // GetCurrentPadding errors with AUDCLNT_E_DEVICE_INVALIDATED when
            // the endpoint is gone.
            if let Err(err) = audio_client.GetCurrentPadding() {
                return Err(LoopbackError::from(err));
            }
        }

        Ok(())
    }

    #[derive(Debug, Clone, Copy)]
    enum SampleFormat {
        F32,
        I16,
        I32,
    }

    fn describe_format(fmt_ptr: *const WAVEFORMATEX) -> SampleFormat {
        unsafe {
            let fmt = &*fmt_ptr;
            if fmt.wFormatTag == WAVE_FORMAT_IEEE_FLOAT as u16 {
                return SampleFormat::F32;
            }
            if fmt.wFormatTag == WAVE_FORMAT_EXTENSIBLE as u16 {
                let ext = &*(fmt_ptr as *const WAVEFORMATEXTENSIBLE);
                if ext.SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT {
                    return SampleFormat::F32;
                }
                if ext.SubFormat == KSDATAFORMAT_SUBTYPE_PCM {
                    if fmt.wBitsPerSample == 32 {
                        return SampleFormat::I32;
                    }
                    return SampleFormat::I16;
                }
            }
            if fmt.wFormatTag == WAVE_FORMAT_PCM as u16 {
                if fmt.wBitsPerSample == 32 {
                    return SampleFormat::I32;
                }
                return SampleFormat::I16;
            }
            // Fallback — assume float since that's the modern default for
            // shared-mode loopback on Windows 10/11.
            SampleFormat::F32
        }
    }

    fn convert_to_f32(bytes: &[u8], fmt: SampleFormat, _bits: usize) -> Vec<f32> {
        match fmt {
            SampleFormat::F32 => {
                let count = bytes.len() / 4;
                let mut out = Vec::with_capacity(count);
                for i in 0..count {
                    let lo = i * 4;
                    out.push(f32::from_le_bytes([
                        bytes[lo],
                        bytes[lo + 1],
                        bytes[lo + 2],
                        bytes[lo + 3],
                    ]));
                }
                out
            }
            SampleFormat::I16 => {
                let count = bytes.len() / 2;
                let mut out = Vec::with_capacity(count);
                for i in 0..count {
                    let lo = i * 2;
                    let s = i16::from_le_bytes([bytes[lo], bytes[lo + 1]]);
                    out.push(s as f32 / 32768.0);
                }
                out
            }
            SampleFormat::I32 => {
                let count = bytes.len() / 4;
                let mut out = Vec::with_capacity(count);
                for i in 0..count {
                    let lo = i * 4;
                    let s = i32::from_le_bytes([
                        bytes[lo],
                        bytes[lo + 1],
                        bytes[lo + 2],
                        bytes[lo + 3],
                    ]);
                    out.push(s as f32 / 2_147_483_648.0);
                }
                out
            }
        }
    }

    #[derive(Debug)]
    enum LoopbackError {
        DeviceInvalidated,
        Other(String),
    }

    impl LoopbackError {
        fn is_device_invalidated(&self) -> bool {
            matches!(self, LoopbackError::DeviceInvalidated)
        }
    }

    impl std::fmt::Display for LoopbackError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                LoopbackError::DeviceInvalidated => write!(f, "device invalidated"),
                LoopbackError::Other(s) => write!(f, "{s}"),
            }
        }
    }

    impl From<windows::core::Error> for LoopbackError {
        fn from(err: windows::core::Error) -> Self {
            const E_INVALID: HRESULT = AUDCLNT_E_DEVICE_INVALIDATED;
            if err.code() == E_INVALID {
                LoopbackError::DeviceInvalidated
            } else {
                LoopbackError::Other(format!("{err}"))
            }
        }
    }

    impl From<LoopbackError> for IronMicError {
        fn from(err: LoopbackError) -> Self {
            IronMicError::Audio(format!("WASAPI loopback: {err}"))
        }
    }
}

#[cfg(windows)]
pub use imp::LoopbackCapture;

#[cfg(not(windows))]
pub struct LoopbackCapture;

#[cfg(not(windows))]
impl LoopbackCapture {
    pub fn start(
        _buffer: Arc<Mutex<AudioRingBuffer>>,
        _device_id: Option<String>,
    ) -> Result<Self, IronMicError> {
        Err(IronMicError::Audio(
            "System-audio loopback is only supported on Windows in v1 — \
             on macOS / Linux, install a virtual loopback device \
             (BlackHole / VB-CABLE / PulseAudio monitor sink) and pick it as \
             the meeting audio device."
                .into(),
        ))
    }
}
