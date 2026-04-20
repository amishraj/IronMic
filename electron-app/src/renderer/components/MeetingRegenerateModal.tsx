/**
 * MeetingRegenerateModal — confirmation UI for regenerating meeting notes.
 *
 * Responsibilities:
 *  - Let the user pick a (possibly different) template for the regeneration.
 *  - When the current notes have unsaved user edits, surface a clear choice
 *    between "Save to history" and "Discard edits" before firing the LLM.
 *  - Kick off the regenerate and close itself when done.
 *
 * The modal is presentational — it does not talk to the LLM or the DB itself;
 * the parent (MeetingDetailPage) owns the regenerate effect and only calls
 * us to collect the user's decisions.
 */

import { useState } from 'react';
import { X, RefreshCw, History, AlertTriangle, Loader2 } from 'lucide-react';
import type { MeetingTemplate } from '../services/tfjs/MeetingTemplateEngine';

export type EditsDisposition = 'save-to-history' | 'discard';

interface Props {
  /** Templates available for selection. Empty array → "No template" only. */
  templates: MeetingTemplate[];
  /** Template currently applied to this meeting (so we can pre-select it). */
  currentTemplate: MeetingTemplate | null;
  /** True when the current notes differ from the last generated output. */
  hasUnsavedEdits: boolean;
  onClose: () => void;
  /**
   * Called when the user commits. If `hasUnsavedEdits` is true, `disposition`
   * is always set; otherwise it's undefined.
   */
  onConfirm: (args: {
    template: MeetingTemplate | null;
    disposition?: EditsDisposition;
  }) => Promise<void>;
}

export function MeetingRegenerateModal({
  templates,
  currentTemplate,
  hasUnsavedEdits,
  onClose,
  onConfirm,
}: Props) {
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(currentTemplate?.id ?? '');
  const [disposition, setDisposition] = useState<EditsDisposition>(
    hasUnsavedEdits ? 'save-to-history' : 'discard',
  );
  const [submitting, setSubmitting] = useState(false);

  const selectedTemplate =
    selectedTemplateId === '' ? null : templates.find(t => t.id === selectedTemplateId) ?? null;
  const isTemplateChange = (currentTemplate?.id ?? '') !== selectedTemplateId;

  const handleConfirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onConfirm({
        template: selectedTemplate,
        disposition: hasUnsavedEdits ? disposition : undefined,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-iron-surface border border-iron-border rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-iron-border">
          <div className="flex items-center gap-2">
            <RefreshCw className="w-4 h-4 text-iron-accent-light" />
            <h2 className="text-sm font-medium text-iron-text">Regenerate meeting notes</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-iron-text-muted hover:bg-iron-surface-hover"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          {/* Template picker */}
          <div>
            <label className="block text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider mb-1.5">
              Template
            </label>
            <select
              value={selectedTemplateId}
              onChange={(e) => setSelectedTemplateId(e.target.value)}
              className="w-full bg-iron-surface-hover border border-iron-border rounded-lg px-3 py-2 text-sm text-iron-text focus:outline-none focus:border-iron-accent/40"
            >
              <option value="">No template (plain summary)</option>
              {templates.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name}{t.is_builtin ? '' : ' (custom)'}
                </option>
              ))}
            </select>
            {isTemplateChange && (
              <p className="text-[11px] text-iron-text-muted mt-1.5">
                Switching template will reformat the notes using the new structure.
              </p>
            )}
          </div>

          {/* Unsaved-edits disposition */}
          {hasUnsavedEdits && (
            <div className="border border-amber-500/30 bg-amber-500/5 rounded-lg p-3">
              <div className="flex items-start gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                <p className="text-[12px] text-iron-text">
                  You have edits that haven't been regenerated. Choose what to do with them:
                </p>
              </div>
              <div className="space-y-1.5 pl-6">
                <label className="flex items-start gap-2 text-[12px] text-iron-text cursor-pointer">
                  <input
                    type="radio"
                    name="disposition"
                    value="save-to-history"
                    checked={disposition === 'save-to-history'}
                    onChange={() => setDisposition('save-to-history')}
                    className="mt-0.5"
                  />
                  <span className="flex items-center gap-1.5">
                    <History className="w-3.5 h-3.5 text-iron-text-muted" />
                    Save current edits to history, then regenerate
                  </span>
                </label>
                <label className="flex items-start gap-2 text-[12px] text-iron-text cursor-pointer">
                  <input
                    type="radio"
                    name="disposition"
                    value="discard"
                    checked={disposition === 'discard'}
                    onChange={() => setDisposition('discard')}
                    className="mt-0.5"
                  />
                  <span>Discard edits and regenerate</span>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-iron-border">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-xs text-iron-text-muted rounded-lg border border-iron-border hover:bg-iron-surface-hover disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={submitting}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-iron-accent/15 text-iron-accent-light rounded-lg border border-iron-accent/20 hover:bg-iron-accent/25 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {submitting ? 'Regenerating…' : 'Regenerate'}
          </button>
        </div>
      </div>
    </div>
  );
}
