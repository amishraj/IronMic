/**
 * AddToNotebookMenu — a small dropdown that lets the user copy the AI
 * meeting summary into one of their notebooks as a new note. Used on the
 * MeetingSessionCard.
 *
 * Behavior:
 *  - Opens a menu listing all notebooks (including the default "My Notes")
 *    plus an inline "+ New notebook" action.
 *  - Clicking a notebook creates a fresh entry containing the summary,
 *    titled with the meeting title, tagged with the notebook id.
 *  - Does NOT modify the meeting itself — pure copy-out.
 */

import { useState, useRef, useEffect } from 'react';
import { FolderPlus, Folder, Plus, Check } from 'lucide-react';
import {
  listNotebooks,
  createNotebook,
  addTextAsEntryToNotebook,
  type Notebook,
} from '../services/notebooks';
import { useToastStore } from '../stores/useToastStore';

interface Props {
  /** The plaintext content to save as a new entry in the chosen notebook. */
  plainText: string;
  /** Title to assign the new note (e.g. "Meeting #7"). */
  title: string;
  /** Source app tag (e.g. 'meeting-export'). */
  sourceApp?: string;
  /** Optional onSaved callback fired with the created entry id. */
  onSaved?: (entryId: string, notebook: Notebook) => void;
}

export function AddToNotebookMenu({ plainText, title, sourceApp, onSaved }: Props) {
  const [open, setOpen] = useState(false);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [savingTo, setSavingTo] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { show: showToast } = useToastStore();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await listNotebooks();
        if (!cancelled) setNotebooks(list);
      } catch (err) {
        console.warn('[AddToNotebookMenu] Failed to load notebooks:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  const handleSaveTo = async (nb: Notebook) => {
    setSavingTo(nb.id);
    try {
      const entryId = await addTextAsEntryToNotebook({
        notebookId: nb.id,
        title,
        plainText,
        sourceApp,
      });
      showToast({
        message: `Added to "${nb.name}"`,
        type: 'success',
        durationMs: 3000,
      });
      onSaved?.(entryId, nb);
      setOpen(false);
    } catch (err: any) {
      showToast({
        message: `Failed to add note: ${err?.message || err}`,
        type: 'error',
        durationMs: 5000,
      });
    } finally {
      setSavingTo(null);
    }
  };

  const handleCreateAndSave = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const nb = await createNotebook(name);
      setNotebooks(prev => [...prev, nb]);
      setNewName('');
      setCreating(false);
      await handleSaveTo(nb);
    } catch (err: any) {
      showToast({
        message: `Failed to create notebook: ${err?.message || err}`,
        type: 'error',
        durationMs: 5000,
      });
    }
  };

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(v => !v);
        }}
        className="p-1.5 rounded-lg text-iron-text-muted hover:text-iron-accent-light hover:bg-iron-accent/10 transition-colors"
        title="Add AI notes to a notebook"
      >
        <FolderPlus className="w-3.5 h-3.5" />
      </button>

      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute right-0 top-full mt-1 z-20 w-64 bg-iron-surface border border-iron-border rounded-lg shadow-depth overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-iron-border text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">
            Add to notebook
          </div>
          <div className="max-h-64 overflow-y-auto">
            {notebooks.length === 0 && (
              <div className="px-3 py-3 text-xs text-iron-text-muted">Loading…</div>
            )}
            {notebooks.map(nb => (
              <button
                key={nb.id}
                onClick={() => void handleSaveTo(nb)}
                disabled={savingTo !== null}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-iron-text hover:bg-iron-surface-hover disabled:opacity-50 transition-colors text-left"
              >
                {savingTo === nb.id ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <Folder className="w-3.5 h-3.5 text-iron-text-muted flex-shrink-0" />
                )}
                <span className="truncate">{nb.name}</span>
              </button>
            ))}
          </div>
          <div className="border-t border-iron-border p-2">
            {creating ? (
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleCreateAndSave();
                    if (e.key === 'Escape') { setCreating(false); setNewName(''); }
                  }}
                  placeholder="Notebook name"
                  className="flex-1 bg-iron-bg border border-iron-border rounded px-2 py-1 text-xs text-iron-text focus:outline-none focus:border-iron-accent/40"
                />
                <button
                  onClick={() => void handleCreateAndSave()}
                  className="px-2 py-1 text-xs bg-iron-accent/15 text-iron-accent-light rounded hover:bg-iron-accent/25"
                >
                  Add
                </button>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-iron-accent-light hover:bg-iron-accent/10 rounded transition-colors"
              >
                <Plus className="w-3 h-3" />
                New notebook
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
