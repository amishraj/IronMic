/**
 * ModelImportSection — Always-visible section for manually importing model files.
 * Each model area (Whisper, LLM, Chat, TTS) embeds one of these so the user
 * can import directly into the right place.
 *
 * Two import modes:
 *  - Single file: for complete model files (.bin, .gguf, .onnx)
 *  - Multi-part: select all .partN files, app assembles them automatically
 */

import { useState, useEffect } from 'react';
import { Upload, CheckCircle, AlertTriangle, FolderOpen, FileBox, ExternalLink, X, Loader2, Layers } from 'lucide-react';

interface ImportableModel {
  modelId: string;
  label: string;
  filename: string;
  downloadUrl: string;
  downloaded: boolean;
  parts?: { filename: string; url: string }[];
  /** Moonshine engines route to a dedicated 3-file import handler. */
  isMoonshine?: boolean;
}

interface Props {
  sectionLabel: string;
  filter: 'whisper' | 'llm' | 'tts' | 'chat' | 'all';
  onImported: () => void;
  highlightOnError?: boolean;
}

export function ModelImportSection({ sectionLabel, filter, onImported, highlightOnError }: Props) {
  const [models, setModels] = useState<ImportableModel[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    if (highlightOnError) setExpanded(true);
  }, [highlightOnError]);

  useEffect(() => { loadModels(); }, []);

  async function loadModels() {
    try {
      const json = await window.ironmic.getImportableModels();
      const all: ImportableModel[] = JSON.parse(json);
      setModels(filterModels(all, filter));
    } catch { setModels([]); }
  }

  async function handleSingleImport() {
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

  async function handleMultiPartImport() {
    setImporting(true);
    setImportResult(null);
    try {
      const result = await window.ironmic.importMultiPartModel();
      if (result) {
        setImportResult({
          success: true,
          message: `Assembled ${result.partCount} parts and imported "${result.label}" successfully. The model is ready to use.`,
        });
        onImported();
        loadModels();
      }
    } catch (err: any) {
      setImportResult({ success: false, message: err.message || 'Multi-part import failed' });
    }
    setImporting(false);
  }

  async function handleMoonshineImport(engineId: string, label: string) {
    setImporting(true);
    setImportResult(null);
    try {
      const result = await window.ironmic.importMoonshineEngine(engineId);
      if (result) {
        setImportResult({
          success: true,
          message: `Imported "${result.label}" (${result.fileCount} files). Click Switch on the row above to activate it.`,
        });
        onImported();
        loadModels();
      }
    } catch (err: any) {
      setImportResult({ success: false, message: err.message || `Import of ${label} failed` });
    }
    setImporting(false);
  }

  const hasMultiPartModels = models.some(m => m.parts && m.parts.length > 0);
  const allReady = models.length > 0 && models.every(m => m.downloaded);

  return (
    <div className={`rounded-xl border transition-colors ${
      highlightOnError ? 'border-amber-500/30 bg-amber-500/5' : 'border-iron-border bg-iron-surface/50'
    }`}>
      {/* Header — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-iron-surface-hover/50 rounded-xl transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <Upload className={`w-4 h-4 ${highlightOnError ? 'text-amber-400' : 'text-iron-text-muted'}`} />
          <div>
            <p className="text-sm font-medium text-iron-text">Import {sectionLabel} Model</p>
            <p className="text-[11px] text-iron-text-muted">
              {allReady ? 'All models ready — import a different version anytime' : 'Have a model file? Import it directly'}
            </p>
          </div>
        </div>
        <span className="text-xs text-iron-text-muted">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-iron-border/50">
          {/* Recommended models with download links */}
          {models.length > 0 && (
            <div className="pt-3 space-y-2">
              <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">
                Recommended Models
              </p>
              <p className="text-[11px] text-iron-text-muted">
                Download in your browser, then import below. Links open in your default browser.
              </p>
              {models.map((m) => (
                <div key={m.modelId} className={`text-xs rounded-lg ${
                  m.downloaded ? 'bg-green-500/5 border border-green-500/10' : 'bg-iron-surface border border-iron-border'
                }`}>
                  {/* Model header */}
                  <div className="flex items-center justify-between px-3 py-2.5">
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
                    {m.downloaded && (
                      <span className="text-[10px] text-green-400 font-medium flex-shrink-0 ml-2">Ready</span>
                    )}
                  </div>

                  {/* Download links — shown for models that aren't downloaded */}
                  {!m.downloaded && (
                    <div className="px-3 pb-2.5 space-y-1.5">
                      {m.isMoonshine && m.parts && m.parts.length > 0 ? (
                        <>
                          <p className="text-[10px] text-iron-text-muted font-medium">
                            HuggingFace ({m.parts.length} files — download all, then click Import below):
                          </p>
                          <div className="space-y-0.5 ml-1">
                            {m.parts.map((part) => (
                              <button
                                key={part.filename}
                                onClick={() => window.ironmic?.openExternal?.(part.url)}
                                className="flex items-center gap-1.5 text-[10px] text-iron-accent-light hover:underline"
                              >
                                <ExternalLink className="w-2.5 h-2.5" />
                                {part.filename.split('/').pop()}
                              </button>
                            ))}
                          </div>
                          <button
                            onClick={() => handleMoonshineImport(m.modelId, m.label)}
                            disabled={importing}
                            className="mt-2 w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium bg-iron-accent/10 text-iron-accent-light rounded-lg hover:bg-iron-accent/20 border border-iron-accent/15 transition-all disabled:opacity-50"
                          >
                            {importing ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <FolderOpen className="w-3.5 h-3.5" />
                            )}
                            <span>{importing ? 'Importing...' : `Import ${m.label} (3 files)`}</span>
                          </button>
                        </>
                      ) : m.parts && m.parts.length > 0 ? (
                        <>
                          {/* Multi-part model: show each part + single-file alternative */}
                          <p className="text-[10px] text-iron-text-muted font-medium">
                            GitHub Releases ({m.parts.length} parts — download all, then use "Import Multi-Part"):
                          </p>
                          <div className="space-y-0.5 ml-1">
                            {m.parts.map((part, i) => (
                              <button
                                key={part.filename}
                                onClick={() => window.ironmic?.openExternal?.(part.url)}
                                className="flex items-center gap-1.5 text-[10px] text-iron-accent-light hover:underline"
                              >
                                <ExternalLink className="w-2.5 h-2.5" />
                                Part {i + 1}: {part.filename}
                              </button>
                            ))}
                          </div>
                          <div className="flex items-center gap-2 pt-1">
                            <div className="flex-1 h-px bg-iron-border/30" />
                            <span className="text-[9px] text-iron-text-muted">or</span>
                            <div className="flex-1 h-px bg-iron-border/30" />
                          </div>
                          <button
                            onClick={() => window.ironmic?.openExternal?.(m.downloadUrl)}
                            className="flex items-center gap-1.5 text-[10px] text-iron-accent-light hover:underline"
                          >
                            <ExternalLink className="w-2.5 h-2.5" />
                            Single file from HuggingFace (no parts needed)
                          </button>
                        </>
                      ) : (
                        /* Single-file model: one download link */
                        <button
                          onClick={() => window.ironmic?.openExternal?.(m.downloadUrl)}
                          className="flex items-center gap-1.5 text-[10px] text-iron-accent-light hover:underline"
                        >
                          <ExternalLink className="w-2.5 h-2.5" />
                          Download from {m.downloadUrl.includes('github.com') ? 'GitHub Releases' : 'HuggingFace'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Divider */}
          <div className="flex items-center gap-3 pt-1">
            <div className="flex-1 h-px bg-iron-border/50" />
            <span className="text-[10px] text-iron-text-muted font-medium uppercase">Import</span>
            <div className="flex-1 h-px bg-iron-border/50" />
          </div>

          {/* Import buttons */}
          <div className={`${hasMultiPartModels ? 'grid grid-cols-2 gap-2' : ''}`}>
            {/* Single file import */}
            <button
              onClick={handleSingleImport}
              disabled={importing}
              className="w-full flex items-center justify-center gap-2 px-3 py-3 text-xs font-medium bg-iron-accent/10 text-iron-accent-light rounded-lg hover:bg-iron-accent/20 border border-iron-accent/15 transition-all disabled:opacity-50"
            >
              {importing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <FolderOpen className="w-3.5 h-3.5" />
              )}
              <span>{importing ? 'Importing...' : 'Import Single File'}</span>
            </button>

            {/* Multi-part import — only shown when relevant */}
            {hasMultiPartModels && (
              <button
                onClick={handleMultiPartImport}
                disabled={importing}
                className="w-full flex items-center justify-center gap-2 px-3 py-3 text-xs font-medium bg-iron-surface text-iron-text-secondary rounded-lg hover:bg-iron-surface-hover border border-iron-border transition-all disabled:opacity-50"
              >
                {importing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Layers className="w-3.5 h-3.5" />
                )}
                <span>{importing ? 'Assembling...' : 'Import Multi-Part'}</span>
              </button>
            )}
          </div>

          {hasMultiPartModels && (
            <p className="text-[10px] text-iron-text-muted leading-relaxed">
              <strong>Single File</strong> — for complete .bin, .gguf, or .onnx files.{' '}
              <strong>Multi-Part</strong> — select all .part0, .part1, .part2 files at once and IronMic will assemble them automatically.
            </p>
          )}

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
            Supported: <code className="bg-iron-surface-active px-1 py-0.5 rounded">.bin</code>{' '}
            <code className="bg-iron-surface-active px-1 py-0.5 rounded">.gguf</code>{' '}
            <code className="bg-iron-surface-active px-1 py-0.5 rounded">.onnx</code>{' '}
            <code className="bg-iron-surface-active px-1 py-0.5 rounded">.part*</code>
            {' '}— files are copied to the app's model directory and validated.
          </p>
        </div>
      )}
    </div>
  );
}

/** Backward-compatible wrapper */
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
      <ModelImportSection sectionLabel={label} filter={filter} onImported={onImported} highlightOnError={true} />
    </div>
  );
}

function filterModels(all: ImportableModel[], filter: string): ImportableModel[] {
  if (filter === 'all') return all;
  return all.filter(m => {
    // Speech-recognition section covers both Whisper *and* Moonshine engines.
    if (filter === 'whisper') return m.modelId.startsWith('whisper') || m.modelId.startsWith('moonshine-');
    if (filter === 'llm') return m.modelId === 'llm' || m.modelId.startsWith('llm-chat');
    if (filter === 'chat') return m.modelId.startsWith('llm-chat');
    if (filter === 'tts') return m.modelId.startsWith('tts');
    return true;
  });
}
