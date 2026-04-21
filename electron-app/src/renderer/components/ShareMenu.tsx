/**
 * ShareMenu — Dropdown for exporting/sharing entries and meeting notes.
 * Options: Copy as Markdown, Rich Text, Plain Text, Save as File.
 */

import { useState, useRef, useEffect } from 'react';
import { Share2, FileText, FileCode, Type, Save, Check, X, Users } from 'lucide-react';

interface ShareMenuProps {
  /** Entry ID for fetching formatted content from Rust */
  entryId?: string;
  /** Meeting session ID (alternative to entryId) */
  meetingId?: string;
  /** Inline text to use if no ID is available (for quick sharing) */
  text?: string;
  /** Raw transcript (used for plain text fallback) */
  rawText?: string;
  /**
   * Called when user chooses "Collaborate" for a meeting — navigates to the
   * detail page and opens the collaborate panel.
   */
  onCollaborate?: () => void;
}

export function ShareMenu({ entryId, meetingId, text, rawText, onCollaborate }: ShareMenuProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Auto-clear success status
  useEffect(() => {
    if (status === 'success') {
      const timer = setTimeout(() => setStatus('idle'), 2000);
      return () => clearTimeout(timer);
    }
  }, [status]);

  async function handleCopyMarkdown() {
    try {
      let md: string;
      if (entryId) {
        md = await window.ironmic.exportEntryMarkdown(entryId);
      } else if (meetingId) {
        md = await window.ironmic.exportMeetingMarkdown(meetingId);
      } else {
        md = text || rawText || '';
      }
      await window.ironmic.copyToClipboard(md);
      setStatus('success');
    } catch { setStatus('error'); }
    setOpen(false);
  }

  async function handleCopyRichText() {
    try {
      let md: string;
      if (entryId) {
        md = await window.ironmic.exportEntryMarkdown(entryId);
      } else if (meetingId) {
        md = await window.ironmic.exportMeetingMarkdown(meetingId);
      } else {
        md = text || rawText || '';
      }
      const html = await window.ironmic.textToHtml(md);
      const plainText = text || rawText || md;
      await window.ironmic.copyHtmlToClipboard(html, plainText);
      setStatus('success');
    } catch { setStatus('error'); }
    setOpen(false);
  }

  async function handleCopyPlainText() {
    try {
      let plain: string;
      if (entryId) {
        plain = await window.ironmic.exportEntryPlainText(entryId);
      } else {
        plain = text || rawText || '';
      }
      await window.ironmic.copyToClipboard(plain);
      setStatus('success');
    } catch { setStatus('error'); }
    setOpen(false);
  }

  async function handleSaveFile() {
    try {
      let content: string;
      let defaultName: string;
      if (entryId) {
        content = await window.ironmic.exportEntryMarkdown(entryId);
        defaultName = `dictation-${entryId.slice(0, 8)}.md`;
      } else if (meetingId) {
        content = await window.ironmic.exportMeetingMarkdown(meetingId);
        defaultName = `meeting-${meetingId.slice(0, 8)}.md`;
      } else {
        content = text || rawText || '';
        defaultName = 'note.md';
      }
      await window.ironmic.saveFileDialog(content, defaultName, [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'Text', extensions: ['txt'] },
        { name: 'All Files', extensions: ['*'] },
      ]);
      setStatus('success');
    } catch { setStatus('error'); }
    setOpen(false);
  }

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="p-1.5 rounded-lg text-iron-text-muted hover:text-iron-text hover:bg-iron-surface-hover transition-colors"
        title="Share / Export"
      >
        {status === 'success' ? (
          <Check className="w-3.5 h-3.5 text-green-400" />
        ) : status === 'error' ? (
          <X className="w-3.5 h-3.5 text-red-400" />
        ) : (
          <Share2 className="w-3.5 h-3.5" />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-52 py-1 bg-iron-surface border border-iron-border rounded-xl shadow-xl">
          <button
            onClick={handleCopyRichText}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-iron-text-secondary hover:bg-iron-surface-hover hover:text-iron-text transition-colors"
          >
            <FileText className="w-3.5 h-3.5" />
            Copy as Rich Text
          </button>
          <button
            onClick={handleCopyMarkdown}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-iron-text-secondary hover:bg-iron-surface-hover hover:text-iron-text transition-colors"
          >
            <FileCode className="w-3.5 h-3.5" />
            Copy as Markdown
          </button>
          <button
            onClick={handleCopyPlainText}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-iron-text-secondary hover:bg-iron-surface-hover hover:text-iron-text transition-colors"
          >
            <Type className="w-3.5 h-3.5" />
            Copy as Plain Text
          </button>
          {/* Collaborate option — only for meeting sessions */}
          {meetingId && onCollaborate && (
            <>
              <div className="my-1 border-t border-iron-border/50" />
              <button
                onClick={() => { onCollaborate(); setOpen(false); }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-iron-accent-light hover:bg-iron-accent/10 transition-colors"
              >
                <Users className="w-3.5 h-3.5" />
                Share &amp; Collaborate…
              </button>
            </>
          )}
          <div className="my-1 border-t border-iron-border/50" />
          <button
            onClick={handleSaveFile}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-iron-text-secondary hover:bg-iron-surface-hover hover:text-iron-text transition-colors"
          >
            <Save className="w-3.5 h-3.5" />
            Save as File...
          </button>
        </div>
      )}
    </div>
  );
}
