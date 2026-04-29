import { useState, useEffect, useCallback } from 'react';
import { Download, Check, Loader2, HardDrive, AlertCircle, Zap, Cpu, Info, Star, Globe, Gauge, Mic, FolderOpen, RefreshCw, Trash2, RotateCcw } from 'lucide-react';
import { Card, Toggle, Badge, Button } from './ui';
import { ModelImportSection } from './ModelImportBanner';
import { useDictationStore } from '../stores/useDictationStore';
import { useMeetingStore } from '../stores/useMeetingStore';
import { useToastStore } from '../stores/useToastStore';
import { TRANSCRIPTION_ENGINES, DEFAULT_TRANSCRIPTION_ENGINE, type TranscriptionEngineMeta } from '../../shared/constants';

/** True if any mic-owning pipeline is active. Used to lock settings that
 *  would tear down the Whisper engine or audio device mid-recording and
 *  corrupt the in-flight session. */
function useMicBusy(): boolean {
  const dictating = useDictationStore((s) => s.status !== 'idle');
  const meeting = useMeetingStore((s) => s.isGranolaRecording || s.isGranolaStopping);
  return dictating || meeting;
}

interface WhisperModel {
  id: string;
  name: string;
  filename: string;
  sizeBytes: number;
  speedLabel: string;
  accuracyLabel: string;
  description: string;
  downloadUrl: string;
  downloaded: boolean;
}

interface DownloadProgress {
  model: string;
  downloaded: number;
  total: number;
  status: 'downloading' | 'complete' | 'error' | 'fallback' | 'verifying';
  percent: number;
  errorDetail?: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Pull the real error text out of an IPC rejection. Electron wraps handler
 * errors as "Error invoking remote method 'x': Error: <real message>" — the
 * user doesn't care about the wrapper, they just need to know what broke.
 */
function ipcErrorMessage(err: any, fallback: string): string {
  const raw = (err && err.message) ? String(err.message) : fallback;
  const match = raw.match(/Error invoking remote method[^:]*:\s*(?:Error:\s*)?(.*)$/s);
  return (match ? match[1] : raw).trim() || fallback;
}

export function ModelManager() {
  const [models, setModels] = useState<WhisperModel[]>([]);
  const [currentModel, setCurrentModel] = useState('');
  const [gpuAvailable, setGpuAvailable] = useState(false);
  const [gpuEnabled, setGpuEnabled] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const [showGpuInfo, setShowGpuInfo] = useState(false);
  // Incremented after any import to force all sub-sections to re-check downloaded status
  const [refreshKey, setRefreshKey] = useState(0);
  const micBusy = useMicBusy();

  // ── Unified transcription engine state (Phase 1 redesign) ──
  // The active engine is the source of truth for which speech-recognition
  // backend handles dictation + meetings. `engineReadiness` tracks whether
  // each engine's model files are downloaded and ready to use.
  const [activeEngine, setActiveEngine] = useState<string>(DEFAULT_TRANSCRIPTION_ENGINE);
  const [engineReadiness, setEngineReadiness] = useState<Record<string, boolean>>({});
  const [downloadingEngine, setDownloadingEngine] = useState<string | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);

  // ── Model management state (delete / redownload / disk usage / open folder) ──
  // Sizes are populated alongside readiness so the row can show "146 MB" next
  // to "Ready". `moonshineBundleAvailable` tells us whether the installer
  // shipped a bundled copy — only set on packaged builds.
  const [engineSizes, setEngineSizes] = useState<Record<string, number>>({});
  const [moonshineBundleAvailable, setMoonshineBundleAvailable] = useState<boolean | undefined>(undefined);
  const [modelsDir, setModelsDir] = useState<string>('');
  // Tracks which row is currently running a delete/redownload so we can show
  // a spinner on the right button without freezing the rest of the UI.
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const handleAnyImport = () => {
    loadState();
    setRefreshKey(k => k + 1);
  };

  const loadState = async () => {
    try {
      const modelList = await window.ironmic.getAvailableWhisperModels();
      setModels(modelList);
    } catch (err) { console.error('Failed to load whisper models:', err); }

    try {
      const current = await window.ironmic.getCurrentWhisperModel();
      setCurrentModel(current);
    } catch (err) { console.error('Failed to load current model:', err); }

    try {
      const gpuAvail = await window.ironmic.isGpuAvailable();
      setGpuAvailable(gpuAvail);
    } catch (err) { console.error('Failed to check GPU:', err); }

    try {
      const gpuOn = await window.ironmic.isGpuEnabled();
      setGpuEnabled(gpuOn);
    } catch (err) { console.error('Failed to check GPU enabled:', err); }

    // Models directory — surfaced in the UI so users (especially on Windows)
    // don't have to hunt for %APPDATA%\IronMic\models.
    try {
      const dir = await window.ironmic.getModelsDir();
      setModelsDir(dir || '');
    } catch (err) {
      console.warn('[ModelManager] Failed to read models dir:', err);
    }

    // Unified engine state — the active backend across Moonshine + Whisper.
    // Readiness must match what the import section shows ("Ready" vs not).
    // We can't trust listTranscriptionEngines for this: older Rust addons may
    // not expose every kind, and the renderer's `find` would silently default
    // missing kinds to `false`. Probe each engine directly against disk.
    try {
      const active = await window.ironmic.getTranscriptionEngine();
      setActiveEngine(active);
      const usages = await Promise.all(
        TRANSCRIPTION_ENGINES.map(async (meta) => {
          try {
            const usage = await window.ironmic.getEngineDiskUsage(meta.id);
            const allFilesExist = usage.files.length > 0 && usage.files.every((f) => f.exists);
            return {
              id: meta.id,
              ready: allFilesExist,
              size: usage.totalBytes,
              bundledAvailable: usage.bundledAvailable,
            };
          } catch {
            return { id: meta.id, ready: false, size: 0, bundledAvailable: undefined };
          }
        }),
      );
      setEngineReadiness(Object.fromEntries(usages.map((u) => [u.id, u.ready])));
      setEngineSizes(Object.fromEntries(usages.map((u) => [u.id, u.size])));
      const moonshine = usages.find((u) => u.id === 'moonshine-base');
      setMoonshineBundleAvailable(moonshine?.bundledAvailable);
    } catch (err) {
      console.warn('[ModelManager] Failed to load transcription engines:', err);
    }
  };

  /**
   * Switch the active speech recognition model. Downloads the engine's model
   * files first if missing, then persists the `transcription_engine` setting
   * (which the SET_SETTING handler in Rust uses to swap the active engine).
   *
   * Locked out while a recording is in flight — same hazard as the legacy
   * Whisper-only handleSelectModel: the engine layer reloads its model on
   * swap, which would corrupt an in-flight transcription.
   */
  // Download the model files for an engine without changing the active engine.
  // Mirrors the Chat Models / Whisper download flow: clicking "Download" just
  // fetches the files and flips the row to "Switch". Switching is a separate
  // user action (matches the rest of the page).
  const downloadEngine = useCallback(async (engineId: string) => {
    setEngineError(null);
    setDownloadingEngine(engineId);
    try {
      await window.ironmic.downloadTranscriptionEngine(engineId);
      // Synthetic 'complete' from the main process triggers loadState via the
      // existing progress listener, so the row will flip to "Switch" on its own.
    } catch (err: any) {
      console.error('[ModelManager] Engine download failed:', err);
      setEngineError(ipcErrorMessage(err, 'Engine download failed'));
    } finally {
      setDownloadingEngine(null);
    }
  }, []);

  // Switch the active engine. Requires the engine to already be downloaded —
  // the EngineRow only renders the "Switch" button when isReady=true, so this
  // path never has to download. Same lock-out hazard as Whisper model swap:
  // mid-recording reload would corrupt the in-flight transcription.
  const switchEngine = useCallback(async (engineId: string) => {
    setEngineError(null);
    if (engineId === activeEngine) return;
    if (micBusy) {
      useToastStore.getState().show({
        type: 'info',
        message: 'Stop the current recording before changing the speech recognition model.',
        durationMs: 5000,
      });
      return;
    }
    try {
      await window.ironmic.setSetting('transcription_engine', engineId);
      setActiveEngine(engineId);
      if (engineId.startsWith('whisper-')) {
        const id = engineId === 'whisper-large-v3-turbo' ? 'large-v3-turbo' : engineId.replace('whisper-', '');
        setCurrentModel(id);
      }
      loadState();
    } catch (err: any) {
      console.error('[ModelManager] Engine switch failed:', err);
      setEngineError(ipcErrorMessage(err, 'Engine switch failed'));
    }
  }, [activeEngine, micBusy]);

  const handleOpenFolder = useCallback(async () => {
    setEngineError(null);
    try {
      await window.ironmic.openModelsDirectory();
    } catch (err: any) {
      console.error('[ModelManager] Failed to open models folder:', err);
      setEngineError(ipcErrorMessage(err, 'Failed to open models folder'));
    }
  }, []);

  // Delete an engine's files. For Moonshine Base on a packaged build the
  // bundled copy gets restored automatically — confirm dialog explains that
  // disk usage will not change in that case.
  const deleteEngine = useCallback(async (engineId: string) => {
    if (engineId === activeEngine) {
      useToastStore.getState().show({
        type: 'info',
        message: 'Switch to another engine before deleting this one.',
        durationMs: 4000,
      });
      return;
    }
    const meta = TRANSCRIPTION_ENGINES.find((e) => e.id === engineId);
    if (!meta) return;
    const isMoonshineRestore = engineId === 'moonshine-base' && moonshineBundleAvailable === true;
    const message = isMoonshineRestore
      ? `Restore the bundled copy of ${meta.label}?\n\nThis engine ships with the installer, so the bundled copy will be re-applied automatically and disk usage will not change.`
      : `Delete ${meta.label}? You can re-download it later from this screen.`;
    if (!window.confirm(message)) return;

    setEngineError(null);
    setPendingAction(`delete:${engineId}`);
    try {
      await window.ironmic.deleteEngineFiles(engineId);
      await loadState();
    } catch (err: any) {
      console.error('[ModelManager] Engine delete failed:', err);
      setEngineError(ipcErrorMessage(err, 'Delete failed'));
    } finally {
      setPendingAction(null);
    }
  }, [activeEngine, moonshineBundleAvailable]);

  // Re-download wipes the existing files first, so it shares the active-engine
  // guard with delete. The download itself fires progress events that the
  // existing onModelDownloadProgress listener picks up to refresh state.
  const redownloadEngine = useCallback(async (engineId: string) => {
    if (engineId === activeEngine) {
      useToastStore.getState().show({
        type: 'info',
        message: 'Switch to another engine before re-downloading this one.',
        durationMs: 4000,
      });
      return;
    }
    const meta = TRANSCRIPTION_ENGINES.find((e) => e.id === engineId);
    if (!meta) return;
    if (!window.confirm(`Re-download ${meta.label}? Existing files will be removed first.`)) return;

    setEngineError(null);
    setPendingAction(`redownload:${engineId}`);
    setDownloadingEngine(engineId);
    try {
      await window.ironmic.redownloadEngine(engineId);
      // Synthetic 'complete' progress event triggers loadState via the
      // existing listener; nothing else to do here.
    } catch (err: any) {
      console.error('[ModelManager] Engine re-download failed:', err);
      setEngineError(ipcErrorMessage(err, 'Re-download failed'));
      setDownloadingEngine(null);
    } finally {
      setPendingAction(null);
    }
  }, [activeEngine]);

  useEffect(() => {
    loadState();
    const cleanup = window.ironmic.onModelDownloadProgress((prog: DownloadProgress) => {
      setProgress(prog);
      if (prog.status === 'complete') { setDownloading(null); setProgress(null); loadState(); }
      if (prog.status === 'error') {
        setDownloading(null);
        setError(prog.errorDetail || 'Download failed');
        setDownloadFailed(true);
      }
    });
    return cleanup;
  }, []);

  const handleDownload = async (model: WhisperModel) => {
    setDownloading(model.id);
    setError(null);
    try {
      const downloadKey = model.id === 'large-v3-turbo' ? 'whisper' : `whisper-${model.id}`;
      await window.ironmic.downloadModel(downloadKey);
    } catch (err: any) {
      setError(ipcErrorMessage(err, 'Download failed'));
      setDownloading(null);
      setDownloadFailed(true);
    }
  };

  const handleSelectModel = async (modelId: string) => {
    const model = models.find((m) => m.id === modelId);
    if (!model?.downloaded) return;
    // Lock-out: switching the Whisper model reloads the native engine, which
    // would corrupt any in-flight transcription. Toast instead of silently
    // breaking the user's recording.
    if (micBusy) {
      useToastStore.getState().show({
        type: 'info',
        message: 'Stop the current recording before changing the Whisper model.',
        durationMs: 5000,
      });
      return;
    }
    setSwitching(true);
    setError(null);
    try {
      await window.ironmic.setWhisperModel(modelId);
      setCurrentModel(modelId);
    } catch (err: any) {
      setError(err.message || 'Failed to switch model');
    } finally {
      setSwitching(false);
    }
  };

  const handleGpuToggle = async () => {
    // Lock-out: toggling GPU reloads the Whisper backend. Same hazard as
    // swapping the model — can't do it mid-session.
    if (micBusy) {
      useToastStore.getState().show({
        type: 'info',
        message: 'Stop the current recording before toggling GPU acceleration.',
        durationMs: 5000,
      });
      return;
    }
    setError(null);
    try {
      await window.ironmic.setGpuEnabled(!gpuEnabled);
      setGpuEnabled(!gpuEnabled);
    } catch (err: any) {
      setError(err.message || 'Failed to toggle GPU');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <HardDrive className="w-4 h-4 text-iron-text-muted" />
        <h3 className="text-sm font-semibold text-iron-text">AI Models</h3>
      </div>

      {error && (
        <div className="flex items-start gap-2 text-xs text-iron-danger bg-iron-danger/10 border border-iron-danger/20 px-3 py-2 rounded-lg">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <div className="whitespace-pre-wrap break-all">
            {error}
            <p className="mt-1.5 text-iron-text-muted font-medium">
              You can import model files manually using the import sections below each model category.
            </p>
          </div>
        </div>
      )}

      {/* GPU Acceleration */}
      {gpuAvailable && (
        <Card variant="default" padding="md" className="border-iron-warning/20 bg-iron-warning/5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Zap className="w-5 h-5 text-iron-warning" />
              <div>
                <p className="text-sm font-medium text-iron-text">GPU Acceleration</p>
                <p className="text-xs text-iron-text-muted mt-0.5">Metal — 3-5x faster transcription</p>
              </div>
            </div>
            <Toggle checked={gpuEnabled} onChange={handleGpuToggle} variant="warning" />
          </div>
        </Card>
      )}

      {!gpuAvailable && (
        <Card variant="default" padding="md">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Cpu className="w-5 h-5 text-iron-text-muted" />
              <div>
                <p className="text-sm font-medium text-iron-text-secondary">CPU Mode</p>
                <p className="text-xs text-iron-text-muted">GPU acceleration not available on this device</p>
              </div>
            </div>
            <button
              onClick={() => setShowGpuInfo(!showGpuInfo)}
              className="flex items-center gap-1 text-[11px] text-iron-accent-light hover:underline"
            >
              <Info className="w-3 h-3" />
              Learn why
            </button>
          </div>
          {showGpuInfo && (
            <div className="mt-3 pt-3 border-t border-iron-border/50 text-xs text-iron-text-muted space-y-2">
              <p>GPU acceleration requires <strong className="text-iron-text">all three</strong> of the following:</p>
              <ul className="list-disc list-inside space-y-1 ml-1">
                <li><strong className="text-iron-text">macOS with Apple Silicon</strong> (M1/M2/M3/M4) — Metal is Apple's GPU framework and only works on macOS.</li>
                <li><strong className="text-iron-text">Metal feature compiled in</strong> — The app must be built with the <code className="bg-iron-surface-active px-1 py-0.5 rounded">metal</code> Cargo feature flag. Pre-built releases from GitHub include this, but custom builds may not.</li>
                <li><strong className="text-iron-text">Whisper model downloaded</strong> — The speech recognition model must be present for GPU inference.</li>
              </ul>
              <p className="pt-1"><strong className="text-iron-text">Common reasons GPU is unavailable:</strong></p>
              <ul className="list-disc list-inside space-y-1 ml-1">
                <li><strong>Windows or Linux</strong> — Metal is macOS-only. CUDA support (NVIDIA GPUs) is planned but not yet available.</li>
                <li><strong>Intel Mac</strong> — Metal acceleration is only supported on Apple Silicon (M-series) chips.</li>
                <li><strong>Custom build without metal flag</strong> — If you built from source, ensure you ran: <code className="bg-iron-surface-active px-1 py-0.5 rounded">cargo build --release --features metal,tts</code></li>
              </ul>
              <p className="pt-1">CPU mode still works well — transcription takes a few extra seconds but accuracy is identical.</p>
            </div>
          )}
        </Card>
      )}

      {/* ── Speech Recognition Model (unified — Moonshine + Whisper) ── */}
      <SpeechRecognitionModelSection
        activeEngine={activeEngine}
        engineReadiness={engineReadiness}
        engineSizes={engineSizes}
        moonshineBundleAvailable={moonshineBundleAvailable}
        modelsDir={modelsDir}
        downloadingEngine={downloadingEngine}
        engineError={engineError}
        pendingAction={pendingAction}
        onSwitch={switchEngine}
        onDownload={downloadEngine}
        onDelete={deleteEngine}
        onRedownload={redownloadEngine}
        onOpenFolder={handleOpenFolder}
        onImported={handleAnyImport}
        downloadFailed={downloadFailed}
      />

      {/* ── Text Cleanup Model ── */}
      <div className="space-y-2">
        <LlmModelRow refreshKey={refreshKey} onImported={handleAnyImport} />
      </div>

      {/* ── Chat Models ── */}
      <ChatModelsSection refreshKey={refreshKey} onImported={handleAnyImport} />
    </div>
  );
}

function SpeechRecognitionModelSection({
  activeEngine,
  engineReadiness,
  engineSizes,
  moonshineBundleAvailable,
  modelsDir,
  downloadingEngine,
  engineError,
  pendingAction,
  onSwitch,
  onDownload,
  onDelete,
  onRedownload,
  onOpenFolder,
  onImported,
  downloadFailed,
}: {
  activeEngine: string;
  engineReadiness: Record<string, boolean>;
  engineSizes: Record<string, number>;
  moonshineBundleAvailable: boolean | undefined;
  modelsDir: string;
  downloadingEngine: string | null;
  engineError: string | null;
  pendingAction: string | null;
  onSwitch: (engineId: string) => void;
  onDownload: (engineId: string) => void;
  onDelete: (engineId: string) => void;
  onRedownload: (engineId: string) => void;
  onOpenFolder: () => void;
  onImported: () => void;
  downloadFailed: boolean;
}) {
  const moonshineEngines = TRANSCRIPTION_ENGINES.filter((e) => e.family === 'moonshine');
  const whisperEngines = TRANSCRIPTION_ENGINES.filter((e) => e.family === 'whisper');
  const activeMeta = TRANSCRIPTION_ENGINES.find((e) => e.id === activeEngine);
  // Only call the engine "Active" if its files are actually on disk. Without
  // this guard, the chip lies on dev/unpackaged builds where the bundle copy
  // hasn't run, and on stub builds where getTranscriptionEngine() always
  // reports moonshine-base. Startup also force-overwrites the persisted
  // setting to moonshine-base every launch (main/index.ts) — surface that
  // policy in the tooltip so the user isn't confused when their Whisper
  // selection resets between runs.
  const activeReady = !!activeMeta && engineReadiness[activeMeta.id] === true;
  const activeChipTitle = 'Active for this session — Moonshine Base is restored as the default on next launch.';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">
          Speech Recognition Model
        </p>
        {activeMeta && activeReady ? (
          <span
            title={activeChipTitle}
            className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/20"
          >
            {activeMeta.label} — Active
          </span>
        ) : activeMeta ? (
          <span
            title="The selected engine's model files aren't available on disk. Download it below to make it active."
            className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-iron-warning/10 text-iron-warning border border-iron-warning/20"
          >
            {activeMeta.label} — Not ready
          </span>
        ) : null}
      </div>
      <p className="text-xs text-iron-text-muted">
        The engine that turns your voice into text. Used for dictation and meeting transcription.
      </p>

      {/* Models folder location — surfaces where files actually live so users
          (especially on Windows) can find them without hunting through AppData. */}
      {modelsDir && (
        <Card variant="default" padding="md">
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-medium text-iron-text-muted uppercase tracking-wider">
                Models folder
              </p>
              <p
                className="text-xs font-mono text-iron-text-secondary truncate mt-0.5"
                title={modelsDir}
              >
                {modelsDir}
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              icon={<FolderOpen className="w-3 h-3" />}
              onClick={onOpenFolder}
            >
              Open folder
            </Button>
          </div>
        </Card>
      )}

      {engineError && (
        <div className="flex items-start gap-2 text-xs text-iron-danger bg-iron-danger/10 border border-iron-danger/20 px-3 py-2 rounded-lg">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <div className="whitespace-pre-wrap break-all">{engineError}</div>
        </div>
      )}

      {/* Moonshine group */}
      <div className="flex items-center gap-2 pt-1">
        <Zap className="w-3 h-3 text-iron-accent" />
        <p className="text-[11px] font-medium text-iron-text-muted">
          Moonshine — fast, English only. No GPU required.
        </p>
      </div>
      {moonshineEngines.map((meta) => (
        <EngineRow
          key={meta.id}
          meta={meta}
          isActive={meta.id === activeEngine}
          isReady={engineReadiness[meta.id] ?? false}
          sizeBytes={engineSizes[meta.id] ?? 0}
          bundledAvailable={meta.id === 'moonshine-base' ? moonshineBundleAvailable : undefined}
          isDownloading={downloadingEngine === meta.id}
          isDefault={meta.id === DEFAULT_TRANSCRIPTION_ENGINE}
          pendingAction={pendingAction}
          onSwitch={() => onSwitch(meta.id)}
          onDownload={() => onDownload(meta.id)}
          onDelete={() => onDelete(meta.id)}
          onRedownload={() => onRedownload(meta.id)}
        />
      ))}

      {/* Whisper group */}
      <div className="flex items-center gap-2 pt-2">
        <Globe className="w-3 h-3 text-iron-text-muted" />
        <p className="text-[11px] font-medium text-iron-text-muted">
          Whisper — multilingual. Slower on CPU without GPU/BLAS.
        </p>
      </div>
      {whisperEngines.map((meta) => (
        <EngineRow
          key={meta.id}
          meta={meta}
          isActive={meta.id === activeEngine}
          isReady={engineReadiness[meta.id] ?? false}
          sizeBytes={engineSizes[meta.id] ?? 0}
          bundledAvailable={undefined}
          isDownloading={downloadingEngine === meta.id}
          isDefault={false}
          pendingAction={pendingAction}
          onSwitch={() => onSwitch(meta.id)}
          onDownload={() => onDownload(meta.id)}
          onDelete={() => onDelete(meta.id)}
          onRedownload={() => onRedownload(meta.id)}
        />
      ))}

      <ModelImportSection
        sectionLabel="Speech Recognition"
        filter="whisper"
        onImported={onImported}
        highlightOnError={downloadFailed}
      />
    </div>
  );
}

function EngineRow({
  meta,
  isActive,
  isReady,
  sizeBytes,
  bundledAvailable,
  isDownloading,
  isDefault,
  pendingAction,
  onSwitch,
  onDownload,
  onDelete,
  onRedownload,
}: {
  meta: TranscriptionEngineMeta;
  isActive: boolean;
  isReady: boolean;
  sizeBytes: number;
  bundledAvailable: boolean | undefined;
  isDownloading: boolean;
  isDefault: boolean;
  pendingAction: string | null;
  onSwitch: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onRedownload: () => void;
}) {
  // For Moonshine on a packaged build, "Delete" can't actually free disk
  // space — the bundled copy is restored automatically on next launch.
  // Surface that as "Restore bundled copy" so the action matches reality.
  const isMoonshineBundled = meta.id === 'moonshine-base' && bundledAvailable === true;
  const deleteLabel = isMoonshineBundled ? 'Restore bundled copy' : 'Delete';
  const deleteIcon = isMoonshineBundled ? <RotateCcw className="w-3 h-3" /> : <Trash2 className="w-3 h-3" />;
  const deletePending = pendingAction === `delete:${meta.id}`;
  const redownloadPending = pendingAction === `redownload:${meta.id}`;

  return (
    <Card variant="default" padding="md">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium text-iron-text">{meta.label}</p>
            <span className="text-[10px] text-iron-text-muted">{meta.sizeLabel}</span>
            {isReady && sizeBytes > 0 && (
              <span className="text-[10px] text-iron-text-muted">· {formatBytes(sizeBytes)} on disk</span>
            )}
            {isDefault && !isActive && (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-iron-surface-active text-iron-text-secondary">
                <Star className="w-2.5 h-2.5" />
                Default
              </span>
            )}
          </div>
          <p className="text-xs text-iron-text-muted mt-0.5">
            {meta.description} · {meta.latencyHint} · {meta.languages[0] === 'multilingual' ? '99 languages' : 'English only'}
          </p>
        </div>
        <div className="ml-1 flex-shrink-0 flex items-center gap-1.5">
          {isActive && isReady ? (
            <Badge variant="success">Active</Badge>
          ) : isActive && !isReady ? (
            // The persisted setting points at this engine but the files are
            // missing — show Download instead of a misleading "Active" badge.
            <Button size="sm" icon={<Download className="w-3 h-3" />} onClick={onDownload}>
              Download
            </Button>
          ) : isDownloading ? (
            <Loader2 className="w-4 h-4 animate-spin text-iron-accent" />
          ) : isReady ? (
            <Button size="sm" onClick={onSwitch}>Switch</Button>
          ) : (
            <Button size="sm" icon={<Download className="w-3 h-3" />} onClick={onDownload}>
              Download
            </Button>
          )}
          {/* Re-download / Delete buttons appear for downloaded, non-active engines.
              They're hidden for the active engine because the model is loaded
              into Rust memory and removing files mid-flight would crash on the
              next transcription. The user is told to switch first. */}
          {isReady && !isActive && !isDownloading && (
            <>
              <button
                type="button"
                onClick={onRedownload}
                disabled={redownloadPending}
                title="Re-download (delete and fetch again)"
                className="p-1.5 rounded text-iron-text-muted hover:text-iron-text hover:bg-iron-surface-active disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {redownloadPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              </button>
              <button
                type="button"
                onClick={onDelete}
                disabled={deletePending}
                title={deleteLabel}
                className="p-1.5 rounded text-iron-text-muted hover:text-iron-danger hover:bg-iron-danger/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {deletePending ? <Loader2 className="w-3 h-3 animate-spin" /> : deleteIcon}
              </button>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

function ChatModelsSection({ refreshKey, onImported }: { refreshKey: number; onImported: () => void }) {
  const [localModels, setLocalModels] = useState<any[]>([]);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadFailed, setDownloadFailed] = useState(false);

  const loadStatus = async () => {
    try {
      const statuses = await window.ironmic.aiGetLocalModelStatus?.();
      if (statuses) setLocalModels(statuses);
    } catch { /* ignore if not available */ }
  };

  // Re-fetch when refreshKey changes (triggered by import in any section)
  useEffect(() => {
    loadStatus();
  }, [refreshKey]);

  useEffect(() => {
    loadStatus();
    const cleanup = window.ironmic.onModelDownloadProgress((prog: DownloadProgress) => {
      if (!prog.model?.startsWith('llm')) return;
      if (prog.model === 'llm' && downloading !== 'llm') return;
      setProgress(prog);
      if (prog.status === 'complete') { setDownloading(null); setProgress(null); setError(null); loadStatus(); }
      if (prog.status === 'error') {
        setDownloading(null);
        setError(prog.errorDetail || `Download failed for ${prog.model}`);
        setDownloadFailed(true);
      }
    });
    return cleanup;
  }, [downloading]);

  const handleDownload = async (modelId: string) => {
    setDownloading(modelId);
    setError(null);
    try {
      await window.ironmic.downloadModel(modelId);
    } catch (err: any) {
      setError(ipcErrorMessage(err, `Download failed for ${modelId}`));
      setDownloading(null);
      setDownloadFailed(true);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">
          AI Assist Chat Models
        </p>
        {localModels.some((m: any) => m.downloaded) && (
          <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/20">
            {localModels.filter((m: any) => m.downloaded).map((m: any) => m.label).join(', ')}
          </span>
        )}
      </div>
      <p className="text-xs text-iron-text-muted">
        Local LLMs for the AI Assist chat feature. Download or import a model to use it as an on-device AI.
      </p>
      {error && (
        <div className="flex items-start gap-2 text-xs text-iron-danger bg-iron-danger/10 border border-iron-danger/20 px-3 py-2 rounded-lg">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <div className="whitespace-pre-wrap break-all">
            {error}
            <p className="mt-1.5 text-iron-text-muted font-medium">
              Use the import section below to add model files manually.
            </p>
          </div>
        </div>
      )}
      {localModels.map((m: any) => {
        const isDownloading = downloading === m.id;
        return (
          <Card key={m.id} variant="default" padding="md">
            <div className="flex items-start justify-between">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-iron-text">{m.label}</p>
                  <span className="text-[10px] text-iron-text-muted">{m.sizeLabel}</span>
                </div>
                <p className="text-xs text-iron-text-muted mt-0.5">{m.description}</p>
              </div>
              <div className="ml-3 flex-shrink-0">
                {m.downloaded ? (
                  <Badge variant="success">Ready</Badge>
                ) : isDownloading ? (
                  <Loader2 className="w-4 h-4 animate-spin text-iron-accent" />
                ) : (
                  <Button size="sm" icon={<Download className="w-3 h-3" />} onClick={() => handleDownload(m.id)}>
                    Download
                  </Button>
                )}
              </div>
            </div>
            {isDownloading && progress && (
              <div className="mt-2.5">
                <div className="w-full h-1 bg-iron-surface-active rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-accent rounded-full transition-all duration-300"
                    style={{ width: `${progress.percent}%` }}
                  />
                </div>
                <p className="text-[10px] text-iron-text-muted mt-1">
                  {progress.status === 'fallback'
                    ? 'Primary source unavailable, trying fallback...'
                    : progress.status === 'verifying'
                    ? 'Verifying integrity...'
                    : `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)} (${progress.percent}%)`}
                </p>
              </div>
            )}
          </Card>
        );
      })}

      {/* Always-visible import for Chat models */}
      <ModelImportSection
        sectionLabel="Chat"
        filter="chat"
        onImported={() => { loadStatus(); onImported(); }}
        highlightOnError={downloadFailed}
      />
    </div>
  );
}

function LlmModelRow({ refreshKey, onImported }: { refreshKey: number; onImported: () => void }) {
  const [status, setStatus] = useState<any>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadFailed, setDownloadFailed] = useState(false);

  const loadStatus = () => window.ironmic.getModelStatus().then(setStatus);

  useEffect(() => { loadStatus(); }, [refreshKey]);

  useEffect(() => {
    loadStatus();
    const cleanup = window.ironmic.onModelDownloadProgress((prog: DownloadProgress) => {
      if (prog.model !== 'llm') return;
      setProgress(prog);
      if (prog.status === 'complete') { setDownloading(false); setProgress(null); loadStatus(); }
      if (prog.status === 'error') {
        setDownloading(false);
        setError(prog.errorDetail || 'Download failed');
        setDownloadFailed(true);
      }
    });
    return cleanup;
  }, []);

  const size = status?.files?.llm?.sizeBytes || status?.llm?.sizeBytes || 0;
  const downloaded = size > 0;

  const handleDownload = async () => {
    setDownloading(true);
    setError(null);
    try {
      await window.ironmic.downloadModel('llm');
    } catch (err: any) {
      setError(ipcErrorMessage(err, 'Download failed'));
      setDownloading(false);
      setDownloadFailed(true);
    }
  };

  return (
    <>
    <div className="flex items-center justify-between">
      <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">
        Text Cleanup Model
      </p>
      {downloaded && (
        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/20">
          Mistral 7B — Ready
        </span>
      )}
    </div>
    <Card variant="default" padding="md">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-iron-text">Mistral 7B Instruct Q4</p>
          <p className="text-xs text-iron-text-muted mt-0.5">
            Removes filler words, fixes grammar. Optional (~4.4 GB).
          </p>
          {downloaded && <p className="text-[11px] text-iron-text-muted mt-1">{formatBytes(size)}</p>}
          {error && (
            <div className="text-[11px] text-iron-danger mt-1 whitespace-pre-wrap break-all">
              {error}
              <p className="mt-1 text-iron-text-muted font-medium">
                Use the import section below to add the model file manually.
              </p>
            </div>
          )}
        </div>
        <div className="ml-3 flex-shrink-0">
          {downloaded ? (
            <Badge variant="success">Ready</Badge>
          ) : downloading ? (
            <Loader2 className="w-4 h-4 animate-spin text-iron-accent" />
          ) : (
            <Button size="sm" icon={<Download className="w-3 h-3" />} onClick={handleDownload}>
              Download
            </Button>
          )}
        </div>
      </div>
      {downloading && progress && (
        <div className="mt-2.5">
          <div className="w-full h-1 bg-iron-surface-active rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-accent rounded-full transition-all duration-300"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
          <p className="text-[10px] text-iron-text-muted mt-1">
            {progress.status === 'fallback'
              ? 'Primary source unavailable, trying fallback...'
              : progress.status === 'verifying'
              ? 'Assembling and verifying integrity...'
              : `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)} (${progress.percent}%)`}
          </p>
        </div>
      )}
    </Card>

    {/* Always-visible import for LLM */}
    <ModelImportSection
      sectionLabel="Text Cleanup"
      filter="llm"
      onImported={() => { loadStatus(); onImported(); }}
      highlightOnError={downloadFailed}
    />
    </>
  );
}
