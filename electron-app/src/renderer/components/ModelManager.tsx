import { useState, useEffect } from 'react';
import { Download, Check, Loader2, HardDrive, AlertCircle, Zap, Cpu } from 'lucide-react';
import { Card, Toggle, Badge, Button } from './ui';
import { ModelImportBanner } from './ModelImportBanner';

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

export function ModelManager() {
  const [models, setModels] = useState<WhisperModel[]>([]);
  const [currentModel, setCurrentModel] = useState('');
  const [gpuAvailable, setGpuAvailable] = useState(false);
  const [gpuEnabled, setGpuEnabled] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);

  const loadState = async () => {
    // Load each piece independently so one failure doesn't blank the whole section
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
  };

  useEffect(() => {
    loadState();
    const cleanup = window.ironmic.onModelDownloadProgress((prog: DownloadProgress) => {
      setProgress(prog);
      if (prog.status === 'complete') { setDownloading(null); setProgress(null); loadState(); }
      if (prog.status === 'error') { setDownloading(null); setError(prog.errorDetail || 'Download failed'); setShowImport(true); }
    });
    return cleanup;
  }, []);

  const handleDownload = async (model: WhisperModel) => {
    setDownloading(model.id);
    setError(null);
    try {
      // Map model ID to download key: "large-v3-turbo" → "whisper", others → "whisper-{id}"
      const downloadKey = model.id === 'large-v3-turbo' ? 'whisper' : `whisper-${model.id}`;
      await window.ironmic.downloadModel(downloadKey);
    } catch (err: any) {
      setError(err.message || 'Download failed');
      setDownloading(null);
      setShowImport(true);
    }
  };

  const handleSelectModel = async (modelId: string) => {
    const model = models.find((m) => m.id === modelId);
    if (!model?.downloaded) return;
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
          <span className="whitespace-pre-wrap break-all">{error}</span>
        </div>
      )}

      <ModelImportBanner
        visible={showImport}
        onDismiss={() => setShowImport(false)}
        onImported={loadState}
        filter="all"
      />

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
          <div className="flex items-center gap-3">
            <Cpu className="w-5 h-5 text-iron-text-muted" />
            <div>
              <p className="text-sm font-medium text-iron-text-secondary">CPU Mode</p>
              <p className="text-xs text-iron-text-muted">GPU acceleration not available on this device</p>
            </div>
          </div>
        </Card>
      )}

      {/* Whisper Model Picker */}
      <div className="space-y-2">
        <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">
          Speech Recognition Model
        </p>

        {models.map((model) => {
          const isActive = model.id === currentModel;
          const isDownloading = downloading === model.id;

          return (
            <div
              key={model.id}
              onClick={() => model.downloaded && handleSelectModel(model.id)}
              className={`relative p-3 rounded-xl border transition-all duration-150 ${
                isActive
                  ? 'border-iron-accent/30 bg-iron-accent/5 shadow-glow'
                  : model.downloaded
                  ? 'border-iron-border hover:border-iron-border-hover cursor-pointer'
                  : 'border-dashed border-iron-border'
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-iron-text">{model.name}</p>
                    {isActive && <Badge variant="accent">Active</Badge>}
                  </div>
                  <p className="text-xs text-iron-text-muted mt-0.5">{model.description}</p>
                  <div className="flex items-center gap-3 mt-2">
                    <span className="text-[11px] text-iron-text-muted">{formatBytes(model.sizeBytes)}</span>
                    <span className="text-[11px] text-iron-text-muted">Speed: {model.speedLabel}</span>
                    <span className="text-[11px] text-iron-text-muted">Accuracy: {model.accuracyLabel}</span>
                  </div>
                </div>

                <div className="ml-3 flex-shrink-0">
                  {model.downloaded ? (
                    isActive ? (
                      <Check className="w-4 h-4 text-iron-accent-light" />
                    ) : (
                      <span className="text-[11px] text-iron-text-muted">Ready</span>
                    )
                  ) : isDownloading ? (
                    <Loader2 className="w-4 h-4 animate-spin text-iron-accent" />
                  ) : (
                    <Button
                      size="sm"
                      icon={<Download className="w-3 h-3" />}
                      onClick={(e) => { e.stopPropagation(); handleDownload(model); }}
                    >
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
            </div>
          );
        })}
      </div>

      {/* LLM Model */}
      <div className="space-y-2">
        <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">
          Text Cleanup Model
        </p>
        <LlmModelRow />
      </div>

      {/* Chat Models */}
      <ChatModelsSection />
    </div>
  );
}

function ChatModelsSection() {
  const [localModels, setLocalModels] = useState<any[]>([]);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);

  const loadStatus = async () => {
    try {
      const statuses = await window.ironmic.aiGetLocalModelStatus?.();
      if (statuses) setLocalModels(statuses);
    } catch { /* ignore if not available */ }
  };

  useEffect(() => {
    loadStatus();
    const cleanup = window.ironmic.onModelDownloadProgress((prog: DownloadProgress) => {
      if (!prog.model?.startsWith('llm')) return;
      if (prog.model === 'llm' && downloading !== 'llm') return; // Only track if we initiated
      setProgress(prog);
      if (prog.status === 'complete') { setDownloading(null); setProgress(null); setError(null); loadStatus(); }
      if (prog.status === 'error') { setDownloading(null); setError(prog.errorDetail || `Download failed for ${prog.model}`); setShowImport(true); }
    });
    return cleanup;
  }, [downloading]);

  const handleDownload = async (modelId: string) => {
    setDownloading(modelId);
    setError(null);
    try {
      await window.ironmic.downloadModel(modelId);
    } catch (err: any) {
      setError(err.message || `Download failed for ${modelId}`);
      setDownloading(null);
      setShowImport(true);
    }
  };

  if (localModels.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">
        AI Assist Chat Models
      </p>
      <p className="text-xs text-iron-text-muted">
        Local LLMs for the AI Assist chat feature. Download any model to use it as an on-device AI.
      </p>
      {error && (
        <p className="text-[11px] text-iron-danger mt-1 whitespace-pre-wrap break-all">{error}</p>
      )}
      <ModelImportBanner
        visible={showImport}
        onDismiss={() => setShowImport(false)}
        onImported={loadStatus}
        filter="llm"
      />
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
    </div>
  );
}

function LlmModelRow() {
  const [status, setStatus] = useState<any>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);

  const loadStatus = () => window.ironmic.getModelStatus().then(setStatus);
  useEffect(() => {
    loadStatus();
    const cleanup = window.ironmic.onModelDownloadProgress((prog: DownloadProgress) => {
      if (prog.model !== 'llm') return;
      setProgress(prog);
      if (prog.status === 'complete') { setDownloading(false); setProgress(null); loadStatus(); }
      if (prog.status === 'error') { setDownloading(false); setError(prog.errorDetail || 'Download failed'); setShowImport(true); }
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
      setError(err.message || 'Download failed');
      setDownloading(false);
      setShowImport(true);
    }
  };

  return (
    <>
    <Card variant="default" padding="md">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-iron-text">Mistral 7B Instruct Q4</p>
          <p className="text-xs text-iron-text-muted mt-0.5">
            Removes filler words, fixes grammar. Optional (~4.4 GB).
          </p>
          {downloaded && <p className="text-[11px] text-iron-text-muted mt-1">{formatBytes(size)}</p>}
          {error && <p className="text-[11px] text-iron-danger mt-1 whitespace-pre-wrap break-all">{error}</p>}
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
    <ModelImportBanner
      visible={showImport}
      onDismiss={() => setShowImport(false)}
      onImported={loadStatus}
      filter="llm"
    />
    </>
  );
}
