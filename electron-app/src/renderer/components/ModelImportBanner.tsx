/**
 * ModelImportBanner — Shown when model downloads fail.
 * Offers manual file import as a fallback for corporate/proxy environments.
 */

import { useState, useEffect } from 'react';
import { Upload, ExternalLink, CheckCircle, AlertTriangle, X, FolderOpen } from 'lucide-react';

interface ImportableModel {
  modelId: string;
  label: string;
  filename: string;
  downloadUrl: string;
  downloaded: boolean;
}

interface Props {
  /** Whether to show the banner (typically set when a download error occurs) */
  visible: boolean;
  /** Callback when user dismisses the banner */
  onDismiss: () => void;
  /** Callback after successful import — refresh model statuses */
  onImported: () => void;
  /** Optional: filter to only show certain model types */
  filter?: 'whisper' | 'llm' | 'tts' | 'all';
}

export function ModelImportBanner({ visible, onDismiss, onImported, filter = 'all' }: Props) {
  const [models, setModels] = useState<ImportableModel[]>([]);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ success: boolean; message: string } | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (visible) {
      loadModels();
    }
  }, [visible]);

  async function loadModels() {
    try {
      const json = await (window as any).ironmic.getImportableModels();
      const all: ImportableModel[] = JSON.parse(json);
      // Apply filter
      const filtered = filter === 'all' ? all : all.filter(m => {
        if (filter === 'whisper') return m.modelId.startsWith('whisper');
        if (filter === 'llm') return m.modelId.startsWith('llm');
        if (filter === 'tts') return m.modelId.startsWith('tts');
        return true;
      });
      setModels(filtered);
    } catch {
      setModels([]);
    }
  }

  async function handleImport() {
    setImporting(true);
    setImportResult(null);
    try {
      const result = await (window as any).ironmic.importModel();
      if (result) {
        setImportResult({ success: true, message: `Successfully imported ${result.label}` });
        onImported();
        loadModels();
      } else {
        // User cancelled the file picker
        setImporting(false);
        return;
      }
    } catch (err: any) {
      setImportResult({ success: false, message: err.message || 'Import failed' });
    }
    setImporting(false);
  }

  if (!visible) return null;

  return (
    <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Upload className="w-4 h-4 text-amber-400" />
          <div>
            <p className="text-sm font-medium text-iron-text">Download blocked?</p>
            <p className="text-xs text-iron-text-muted">
              Import model files manually from your browser.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-amber-400 hover:text-amber-300 font-medium transition-colors"
          >
            {expanded ? 'Hide details' : 'Show me how'}
          </button>
          <button onClick={onDismiss} className="p-1 text-iron-text-muted hover:text-iron-text transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-amber-500/10 pt-3">
          <div className="text-xs text-iron-text-muted space-y-1">
            <p className="font-medium text-iron-text">How to import:</p>
            <ol className="list-decimal list-inside space-y-1 text-[11px]">
              <li>Click a download link below to open it in your browser</li>
              <li>Save the file anywhere on your computer</li>
              <li>Click <strong>"Import File"</strong> below and select the downloaded file</li>
              <li>IronMic will copy it to the right location automatically</li>
            </ol>
          </div>

          {/* Model list with download URLs */}
          <div className="space-y-1.5">
            {models.map((m) => (
              <div
                key={m.modelId}
                className={`flex items-center justify-between text-xs px-3 py-2 rounded-lg ${
                  m.downloaded
                    ? 'bg-green-500/5 border border-green-500/10'
                    : 'bg-iron-surface border border-iron-border'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {m.downloaded ? (
                    <CheckCircle className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                  ) : (
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="font-medium text-iron-text truncate">{m.label}</p>
                    <p className="text-[10px] text-iron-text-muted truncate">{m.filename}</p>
                  </div>
                </div>
                {!m.downloaded && (
                  <a
                    href={m.downloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-[10px] text-iron-accent-light hover:underline flex-shrink-0 ml-2"
                    onClick={(e) => {
                      e.preventDefault();
                      // Open in default browser (not blocked by our network filter)
                      const { shell } = require('electron');
                      if (shell?.openExternal) {
                        shell.openExternal(m.downloadUrl);
                      } else {
                        // Fallback: copy to clipboard
                        navigator.clipboard.writeText(m.downloadUrl);
                      }
                    }}
                  >
                    <ExternalLink className="w-3 h-3" />
                    Download
                  </a>
                )}
              </div>
            ))}
          </div>

          {/* Import button */}
          <button
            onClick={handleImport}
            disabled={importing}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium bg-iron-accent/15 text-iron-accent-light rounded-lg hover:bg-iron-accent/25 transition-colors disabled:opacity-50"
          >
            <FolderOpen className="w-4 h-4" />
            {importing ? 'Importing...' : 'Import File'}
          </button>

          {/* Import result */}
          {importResult && (
            <p className={`text-xs ${importResult.success ? 'text-green-400' : 'text-red-400'} whitespace-pre-wrap`}>
              {importResult.message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
