/**
 * InputSettings — Microphone and audio input configuration page.
 * Shows device info, permission status, level meter, and test recording.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, MicOff, RefreshCw, CheckCircle, AlertTriangle, XCircle, Volume2, Play, Square, Info } from 'lucide-react';
import { Card, Badge } from './ui';

interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
  sampleRate: number;
  channels: number;
}

interface DeviceInfo {
  name: string | null;
  available: boolean;
  sampleRate: number;
  channels: number;
  sampleFormat: string | null;
}

export function InputSettings() {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [currentDevice, setCurrentDevice] = useState<DeviceInfo | null>(null);
  const [micPermission, setMicPermission] = useState<string>('checking');
  const [refreshing, setRefreshing] = useState(false);

  // Level meter state
  const [monitoring, setMonitoring] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [peakLevel, setPeakLevel] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Test recording
  const [testRecording, setTestRecording] = useState(false);
  const [testAudioUrl, setTestAudioUrl] = useState<string | null>(null);
  const [testAudioBytes, setTestAudioBytes] = useState<number>(0);
  const [testPlaybackError, setTestPlaybackError] = useState<string | null>(null);
  const [testPlaying, setTestPlaying] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    loadDeviceInfo();
    return () => stopMonitoring();
  }, []);

  async function loadDeviceInfo() {
    setRefreshing(true);
    try {
      const [devicesJson, deviceJson, perm] = await Promise.all([
        window.ironmic.listAudioDevices(),
        window.ironmic.getCurrentAudioDevice(),
        window.ironmic.checkMicPermission(),
      ]);
      setDevices(JSON.parse(devicesJson));
      setCurrentDevice(JSON.parse(deviceJson));
      setMicPermission(perm);
    } catch (err) {
      console.error('[InputSettings] Failed to load device info:', err);
    }
    setRefreshing(false);
  }

  const startMonitoring = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      streamRef.current = stream;

      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);
      analyserRef.current = analyser;

      setMonitoring(true);
      setMicPermission('granted');

      // Start animation loop for level meter
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(dataArray);
        // Compute RMS-like level from frequency data
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i] * dataArray[i];
        }
        const rms = Math.sqrt(sum / dataArray.length) / 255;
        setAudioLevel(rms);
        setPeakLevel(prev => Math.max(prev * 0.995, rms)); // Slow peak decay
        animFrameRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (err: any) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setMicPermission('denied');
      } else {
        console.error('[InputSettings] Failed to start monitoring:', err);
      }
    }
  }, []);

  const stopMonitoring = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    setMonitoring(false);
    setAudioLevel(0);
    setPeakLevel(0);
  }, []);

  const startTestRecording = useCallback(async () => {
    // Clean up previous test
    if (testAudioUrl) {
      URL.revokeObjectURL(testAudioUrl);
      setTestAudioUrl(null);
    }

    try {
      let stream = streamRef.current;
      if (!stream) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        streamRef.current = stream;
      }

      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        const url = URL.createObjectURL(blob);
        setTestAudioUrl(url);
        setTestAudioBytes(blob.size);
        setTestPlaybackError(null);
        setTestRecording(false);
      };

      recorder.start();
      setTestRecording(true);

      // Auto-stop after 5 seconds
      setTimeout(() => {
        if (recorder.state === 'recording') {
          recorder.stop();
        }
      }, 5000);
    } catch (err) {
      console.error('[InputSettings] Test recording failed:', err);
      setTestRecording(false);
    }
  }, [testAudioUrl]);

  const stopTestRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const playTestRecording = useCallback(() => {
    if (!testAudioUrl) return;
    const audio = new Audio(testAudioUrl);
    audioElRef.current = audio;
    setTestPlaybackError(null);
    setTestPlaying(true);
    audio.onended = () => setTestPlaying(false);
    audio.onerror = () => {
      setTestPlaying(false);
      setTestPlaybackError('Playback failed. Check the app console for CSP or codec errors.');
    };
    const p = audio.play();
    if (p && typeof p.catch === 'function') {
      p.catch((e: any) => {
        setTestPlaying(false);
        setTestPlaybackError(`Playback rejected: ${e?.message || e}`);
      });
    }
  }, [testAudioUrl]);

  const stopPlayback = useCallback(() => {
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current = null;
    }
    setTestPlaying(false);
  }, []);

  const permissionIcon = micPermission === 'granted'
    ? <CheckCircle className="w-4 h-4 text-green-400" />
    : micPermission === 'denied' || micPermission === 'restricted'
    ? <XCircle className="w-4 h-4 text-red-400" />
    : micPermission === 'not-determined'
    ? <AlertTriangle className="w-4 h-4 text-amber-400" />
    : <div className="w-4 h-4 border-2 border-iron-accent border-t-transparent rounded-full animate-spin" />;

  const permissionLabel = micPermission === 'granted' ? 'Granted'
    : micPermission === 'denied' ? 'Denied'
    : micPermission === 'restricted' ? 'Restricted'
    : micPermission === 'not-determined' ? 'Not Yet Requested'
    : 'Checking...';

  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-iron-text flex items-center gap-2">
            <Mic className="w-5 h-5 text-iron-text-muted" />
            Audio Input
          </h2>
          <p className="text-xs text-iron-text-muted mt-0.5">Microphone, permissions, and input testing</p>
        </div>
        <button
          onClick={loadDeviceInfo}
          disabled={refreshing}
          className="flex items-center gap-1.5 text-[11px] text-iron-accent-light hover:underline"
        >
          <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Microphone Permission */}
      <Card variant={micPermission === 'denied' ? 'highlighted' : 'default'} padding="md">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {permissionIcon}
            <div>
              <p className="text-sm font-medium text-iron-text">Microphone Permission</p>
              <p className="text-xs text-iron-text-muted mt-0.5">
                {micPermission === 'granted'
                  ? 'IronMic has access to your microphone'
                  : micPermission === 'denied'
                  ? 'Microphone access denied — go to System Settings > Privacy > Microphone to grant access'
                  : micPermission === 'not-determined'
                  ? 'Click "Test Mic" below to trigger the permission prompt'
                  : 'Checking microphone access...'}
              </p>
            </div>
          </div>
          <Badge variant={micPermission === 'granted' ? 'success' : micPermission === 'denied' ? 'danger' : 'default'}>
            {permissionLabel}
          </Badge>
        </div>
      </Card>

      {/* Current Device */}
      <Card variant="default" padding="md">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Volume2 className="w-4 h-4 text-iron-text-muted" />
            <p className="text-sm font-medium text-iron-text">Active Input Device</p>
          </div>
          {currentDevice?.available ? (
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <p className="text-iron-text-muted">Device</p>
                <p className="text-iron-text font-medium mt-0.5">{currentDevice.name}</p>
              </div>
              <div>
                <p className="text-iron-text-muted">Sample Rate</p>
                <p className="text-iron-text font-medium mt-0.5">{(currentDevice.sampleRate / 1000).toFixed(1)} kHz</p>
              </div>
              <div>
                <p className="text-iron-text-muted">Channels</p>
                <p className="text-iron-text font-medium mt-0.5">{currentDevice.channels === 1 ? 'Mono' : currentDevice.channels === 2 ? 'Stereo' : `${currentDevice.channels}ch`}</p>
              </div>
              <div>
                <p className="text-iron-text-muted">Format</p>
                <p className="text-iron-text font-medium mt-0.5">{currentDevice.sampleFormat || 'Auto'}</p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-red-400">No input device detected. Check that a microphone is connected.</p>
          )}
        </div>
      </Card>

      {/* All Devices */}
      {devices.length > 1 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">
            Available Input Devices ({devices.length})
          </p>
          {devices.map(d => (
            <div
              key={d.id}
              className={`flex items-center justify-between px-3 py-2 rounded-lg text-xs border ${
                d.isDefault
                  ? 'bg-iron-accent/5 border-iron-accent/20 text-iron-accent-light'
                  : 'bg-iron-surface border-iron-border text-iron-text-secondary'
              }`}
            >
              <div className="flex items-center gap-2">
                <Mic className="w-3 h-3" />
                <span className="font-medium">{d.name}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-iron-text-muted">
                  {(d.sampleRate / 1000).toFixed(0)}kHz · {d.channels}ch
                </span>
                {d.isDefault && <Badge variant="accent">Default</Badge>}
              </div>
            </div>
          ))}
          <p className="text-[10px] text-iron-text-muted flex items-center gap-1 mt-1">
            <Info className="w-3 h-3" />
            IronMic uses your system default input device. Change it in your OS audio settings.
          </p>
        </div>
      )}

      {/* Level Meter & Test */}
      <Card variant="default" padding="md">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-iron-text">Microphone Test</p>
            <button
              onClick={monitoring ? stopMonitoring : startMonitoring}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
                monitoring
                  ? 'bg-red-500/15 text-red-400 border border-red-500/20 hover:bg-red-500/25'
                  : 'bg-iron-accent/15 text-iron-accent-light border border-iron-accent/20 hover:bg-iron-accent/25'
              }`}
            >
              {monitoring ? <MicOff className="w-3 h-3" /> : <Mic className="w-3 h-3" />}
              {monitoring ? 'Stop Monitor' : 'Start Monitor'}
            </button>
          </div>

          {/* Level meter bars */}
          <div className="space-y-2">
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px] text-iron-text-muted">
                <span>Level</span>
                <span>{monitoring ? `${(audioLevel * 100).toFixed(0)}%` : '—'}</span>
              </div>
              <div className="w-full h-3 bg-iron-surface-active rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-75"
                  style={{
                    width: `${audioLevel * 100}%`,
                    background: audioLevel > 0.8 ? '#ef4444' : audioLevel > 0.5 ? '#f59e0b' : '#22c55e',
                  }}
                />
              </div>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px] text-iron-text-muted">
                <span>Peak</span>
                <span>{monitoring ? `${(peakLevel * 100).toFixed(0)}%` : '—'}</span>
              </div>
              <div className="w-full h-1.5 bg-iron-surface-active rounded-full overflow-hidden">
                <div
                  className="h-full bg-iron-accent rounded-full transition-all duration-150"
                  style={{ width: `${peakLevel * 100}%` }}
                />
              </div>
            </div>
          </div>

          {monitoring && audioLevel < 0.01 && (
            <p className="text-[11px] text-amber-400 flex items-center gap-1.5">
              <AlertTriangle className="w-3 h-3" />
              No audio detected. Check that your microphone is not muted.
            </p>
          )}

          {/* Test recording */}
          <div className="pt-2 border-t border-iron-border/50 space-y-2">
            <p className="text-xs text-iron-text-muted">
              Record a short clip (up to 5 seconds) and play it back to verify audio quality.
            </p>
            <div className="flex items-center gap-2">
              {!testRecording ? (
                <button
                  onClick={startTestRecording}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-iron-accent/15 text-iron-accent-light rounded-lg border border-iron-accent/20 hover:bg-iron-accent/25 transition-all"
                >
                  <Mic className="w-3 h-3" />
                  Record Test Clip
                </button>
              ) : (
                <button
                  onClick={stopTestRecording}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-red-500/15 text-red-400 rounded-lg border border-red-500/20 hover:bg-red-500/25 transition-all"
                >
                  <Square className="w-3 h-3" />
                  Stop Recording
                </button>
              )}
              {testAudioUrl && !testRecording && (
                testPlaying ? (
                  <button
                    onClick={stopPlayback}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-iron-surface text-iron-text-secondary rounded-lg border border-iron-border hover:bg-iron-surface-hover transition-all"
                  >
                    <Square className="w-3 h-3" />
                    Stop
                  </button>
                ) : (
                  <button
                    onClick={playTestRecording}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-iron-surface text-iron-text-secondary rounded-lg border border-iron-border hover:bg-iron-surface-hover transition-all"
                  >
                    <Play className="w-3 h-3" />
                    Play Back
                  </button>
                )
              )}
            </div>
            {testRecording && (
              <p className="text-[11px] text-red-400 animate-pulse flex items-center gap-1.5">
                <Mic className="w-3 h-3" />
                Recording... (auto-stops in 5s)
              </p>
            )}
            {!testRecording && testAudioUrl && (
              <p className="text-[11px] text-iron-text-muted">
                Captured {(testAudioBytes / 1024).toFixed(1)} KB.{' '}
                {testAudioBytes < 1024 && (
                  <span className="text-amber-400">Clip is suspiciously small — the mic likely captured silence.</span>
                )}
              </p>
            )}
            {testPlaybackError && (
              <p className="text-[11px] text-red-400 flex items-center gap-1.5">
                <AlertTriangle className="w-3 h-3" />
                {testPlaybackError}
              </p>
            )}
          </div>
        </div>
      </Card>

      {/* Tips */}
      <Card variant="default" padding="md">
        <div className="flex items-start gap-2.5">
          <Info className="w-4 h-4 text-iron-text-muted flex-shrink-0 mt-0.5" />
          <div className="text-xs text-iron-text-muted leading-relaxed space-y-1.5">
            <p><strong className="text-iron-text">For best transcription quality:</strong></p>
            <ul className="list-disc list-inside space-y-0.5 ml-1">
              <li>Use a dedicated microphone or headset rather than built-in laptop mic</li>
              <li>Keep the level meter in the green zone (30-70%) — too quiet loses words, too loud distorts</li>
              <li>Reduce background noise where possible</li>
              <li>Speak at a normal pace, about 12 inches from the mic</li>
              <li>The test clip plays back exactly what IronMic hears — if it sounds clear, transcription will be accurate</li>
            </ul>
          </div>
        </div>
      </Card>
    </>
  );
}
