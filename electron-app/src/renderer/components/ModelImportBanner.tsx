/**
 * ModelImportSection — Always-visible section for manually importing model files.
 * Each model area (Whisper, LLM, Chat, TTS) embeds one of these so the user
 * can import directly into the right place.
 *
 * Flow:
 *  1. User clicks "Choose File" → native file picker opens
 *  2. Selected file shown with name + size for confirmation
 *  3. User clicks "Import" → file is copied to models dir
 *  4. Success/error feedback inline
 */

import { useState, useEffect } from 'react';
import { Upload, CheckCircle, AlertTriangle, FolderOpen, FileBox, ExternalLink, X, Loader2 } from 'lucide-react';

interface ImportableModel {
  modelId: string;
  label: string;
  filename: string;
  downloadUrl: string;
  downloaded: boolean;
}

interface Props {
  /** Section label shown in the header, e.g. "Speech Recognition" */
  sectionLabel: string;
  /** Filter to only show models relevant to this section */
  filter: 'whisper' | 'llm' | 'tts' | 'chat' | 'all';
  /** Callback after successful import — refresh model statuses */
  onImported: () => void;
  /** Optional: highlight/expand when a download error just occurred */
  highlightOnError?: boolean;
}

export function ModelImportSection({ sectionLabel, filter, onImported, highlightOnError }: Props) {
  const [models, setModels] = useState<ImportableModel[]>([]);
  const [expanded, setExpanded] = useState(false);

  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ success: boolean; message: string } | null>(null);

  // Auto-expand when an error triggers highlightOnError
  useEffect(() => {
    if (highlightOnError) {
      setExpanded(true);
    }
  }, [highlightOnError]);

  useEffect(() => {
    loadModels();
  }, []);

  async function loadModels() {
    try {
      const json = await window.ironmic.getImportableModels();
      const all: ImportableModel[] = JSON.parse(json);
      const filtered = filterModels(all, filter);
      setModels(filtered);
    } catch {
      setModels([]);
    }
  }

  async function handleImport() {
    setImporting(true);
    setImportResult(null);
    try {
      const result = await window.ironmic.importModel();
      if (result) {
        setImportResult({ success: true, message: `Imported "${result.label}" successfully. The model is ready to use.` });
        onImported();
        loadModels();
      }
    } catch (err: any) {
      setImportResult({ success: false, message: err.message || 'Import failed' });
    }
    setImporting(false);
  }

  const allReady = models.length > 0 && models.every(m => m.downloaded);

  return (
    <div className={`rounded-xl border transition-colors ${
      highlightOnError
        ? 'border-amber-500/30 bg-amber-500/5'
        : 'border-iron-border bg-iron-surface/50'
    }`}>
      {/* Header — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-iron-surface-hover/50 rounded-xl transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <Upload className={`w-4 h-4 ${highlightOnError ? 'text-amber-400' : 'text-iron-text-muted'}`} />
          <div>
            <p className="text-sm font-medium text-iron-text">
              Import {sectionLabel} Model
            </p>
            <p className="text-[11px] text-iron-text-muted">
              {allReady
                ? 'All models ready — import a different version anytime'
                : 'Have a model file? Import it directly'}
            </p>
          </div>
        </div>
        <span className="text-xs text-iron-text-muted">
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-iron-border/50">
          {/* Recommended models */}
          {models.length > 0 && (
            <div className="pt-3 space-y-1.5">
              <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">
                Recommended Models
              </p>
              <p className="text-[11px] text-iron-text-muted">
                Download any of these from your browser, then import the file below.
              </p>
              {models.map((m) => (
                <div
                  key={m.modelId}
                  className={`flex items-center justify-between text-xs px-3 py-2.5 rounded-lg ${
                    m.downloaded
                      ? 'bg-green-500/5 border border-green-500/10'
                      : 'bg-iron-surface border border-iron-border'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {m.downloaded ? (
                      <CheckCircle className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                    ) : (
                      <FileBox className="w-3.5 h-3.5 text-iron-text-muted flex-shrink-0" />
                    )}
                    <div className="min-w-0">
                      <p className="font-medium text-iron-text">{m.label}</p>
                      <p className="text-[10px] text-iron-text-muted truncate">{m.filename}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                    {m.downloaded ? (
                      <span className="text-[10px] text-green-400 font-medium">Ready</span>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          window.ironmic?.openExternal?.(m.downloadUrl);
                        }}
                        className="flex items-center gap-1 text-[10px] text-iron-accent-light hover:underline"
                      >
                        <ExternalLink className="w-3 h-3" />
                        Download
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Divider */}
          <div className="flex items-center gap-3 pt-1">
            <div className="flex-1 h-px bg-iron-border/50" />
            <span className="text-[10px] text-iron-text-muted font-medium uppercase">Import a file</span>
            <div className="flex-1 h-px bg-iron-border/50" />
          </div>

          {/* Import button — opens native file picker, validates, and copies */}
          <button
            onClick={handleImport}
            disabled={importing}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium bg-iron-accent/10 text-iron-accent-light rounded-lg hover:bg-iron-accent/20 border border-iron-accent/15 transition-all disabled:opacity-50"
          >
            {importing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Importing...
              </>
            ) : (
              <>
                <FolderOpen className="w-4 h-4" />
                Choose File &amp; Import to {sectionLabel}
              </>
            )}
          </button>

          {/* Result feedback */}
          {importResult && (
            <div className={`flex items-start gap-2 text-xs px-3 py-2.5 rounded-lg ${
              importResult.success
                ? 'bg-green-500/10 border border-green-500/15 text-green-400'
                : 'bg-red-500/10 border border-red-500/15 text-red-400'
            }`}>
              {importResult.success ? (
                <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              )}
              <span className="whitespace-pre-wrap">{importResult.message}</span>
            </div>
          )}

          <p className="text-[10px] text-iron-text-muted leading-relaxed">
            Supported formats: <code className="bg-iron-surface-active px-1 py-0.5 rounded">.bin</code>{' '}
            <code className="bg-iron-surface-active px-1 py-0.5 rounded">.gguf</code>{' '}
            <code className="bg-iron-surface-active px-1 py-0.5 rounded">.onnx</code>
            {' '}— IronMic will copy the file to the correct location and validate it.
          </p>
        </div>
      )}
    </div>
  );
}

/** Backward-compatible wrapper — keeps old API working while we transition */
export function ModelImportBanner({ visible, onDismiss, onImported, filter = 'all' }: {
  visible: boolean;
  onDismiss: () => void;
  onImported: () => void;
  filter?: 'whisper' | 'llm' | 'tts' | 'all';
}) {
  if (!visible) return null;
  const label = filter === 'whisper' ? 'Speech Recognition' : filter === 'llm' ? 'Text Cleanup' : filter === 'tts' ? 'TTS' : 'AI';
  return (
    <div className="relative">
      <button onClick={onDismiss} className="absolute top-2 right-2 z-10 p-1 text-iron-text-muted hover:text-iron-text transition-colors">
        <X className="w-3.5 h-3.5" />
      </button>
      <ModelImportSection
        sectionLabel={label}
        filter={filter === 'all' ? 'all' : filter}
        onImported={onImported}
        highlightOnError={true}
      />
    </div>
  );
}

function filterModels(all: ImportableModel[], filter: string): ImportableModel[] {
  if (filter === 'all') return all;
  return all.filter(m => {
    if (filter === 'whisper') return m.modelId.startsWith('whisper');
    if (filter === 'llm') return m.modelId === 'llm' || m.modelId.startsWith('llm-chat');
    if (filter === 'chat') return m.modelId.startsWith('llm-chat');
    if (filter === 'tts') return m.modelId.startsWith('tts');
    return true;
  });
}
