/**
 * MeetingVersionsDrawer — slide-in panel listing prior versions of the
 * meeting notes, with one-click restore.
 *
 * Versions are stored inline on the meeting's `structured_output` JSON under
 * `versions[]` (see SummaryGenerator.ts), so no new SQLite schema is needed.
 */

import { History, RotateCcw, X } from 'lucide-react';
import type { VersionEntry } from '../services/meeting/SummaryGenerator';

interface Props {
  versions: VersionEntry[];
  onClose: () => void;
  onRestore: (versionId: string) => Promise<void>;
}

const REASON_LABEL: Record<VersionEntry['reason'], string> = {
  'user-edit-before-regenerate': 'Saved before regenerate',
  'template-switch': 'Saved before template switch',
  'manual': 'Saved manually',
};

export function MeetingVersionsDrawer({ versions, onClose, onRestore }: Props) {
  return (
    <div className="fixed inset-0 z-40 flex" onClick={onClose}>
      {/* Backdrop */}
      <div className="flex-1 bg-black/40" />
      {/* Panel */}
      <aside
        className="w-[380px] bg-iron-surface border-l border-iron-border shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-iron-border">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-iron-text-muted" />
            <h2 className="text-sm font-medium text-iron-text">Notes history</h2>
            <span className="text-[11px] text-iron-text-muted">
              {versions.length} {versions.length === 1 ? 'version' : 'versions'}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-iron-text-muted hover:bg-iron-surface-hover"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {versions.length === 0 ? (
            <div className="p-6 text-center text-[12px] text-iron-text-muted">
              No prior versions. Your saved edits will appear here.
            </div>
          ) : (
            <ul className="divide-y divide-iron-border/60">
              {versions.map((v) => {
                const preview =
                  v.snapshot.plainSummary?.trim()
                    ? v.snapshot.plainSummary
                    : v.snapshot.sections
                        .filter(s => s.content && s.content.trim() !== 'None mentioned')
                        .map(s => `## ${s.title}\n${s.content}`)
                        .join('\n\n');
                const date = new Date(v.savedAt).toLocaleString(undefined, {
                  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                });
                return (
                  <li key={v.id} className="p-3 hover:bg-iron-surface-hover">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-medium text-iron-text">{date}</span>
                        {v.templateName && (
                          <span className="text-[10px] text-iron-text-muted bg-iron-surface-hover px-1.5 py-0.5 rounded">
                            {v.templateName}
                          </span>
                        )}
                      </div>
                      <button
                        onClick={() => onRestore(v.id)}
                        className="flex items-center gap-1 px-2 py-1 text-[11px] text-iron-accent-light hover:bg-iron-accent/10 rounded"
                        title="Restore this version"
                      >
                        <RotateCcw className="w-3 h-3" />
                        Restore
                      </button>
                    </div>
                    <p className="text-[10px] text-iron-text-muted mb-1.5">
                      {REASON_LABEL[v.reason]}
                    </p>
                    <p className="text-[12px] text-iron-text/80 line-clamp-4 whitespace-pre-wrap font-mono">
                      {preview || '(empty)'}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
