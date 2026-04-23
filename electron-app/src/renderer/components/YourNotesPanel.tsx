/**
 * YourNotesPanel — a scratchpad for the user's own notes during an active
 * meeting. Uses TipTap for the same formatting experience as NoteEditor,
 * but is scoped to a single meeting session and auto-saves to the session's
 * `structured_output` JSON under the `userNotes` key.
 *
 * Activation rules (per product spec):
 *  - Editable ONLY while `isActive` (i.e. a meeting is recording).
 *  - After the meeting ends, the panel shows the saved notes read-only on
 *    the MeetingDetailPage (not here).
 */

import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Typography from '@tiptap/extension-typography';
import { FileText, Check } from 'lucide-react';
import { Card } from './ui';

interface Props {
  sessionId: string | null;
  isActive: boolean;
  /** Optional initial HTML content (e.g. when reopening a session with prior notes). */
  initialHtml?: string;
}

/** Imperative API exposed via ref — lets the parent (MeetingPage) flush the
 *  debounce window and persist the very latest typed notes before the meeting
 *  stops. Without this, if the user clicks End Meeting <800ms after typing,
 *  their last keystrokes never reach the DB and the live summarizer misses
 *  them on its final pass. */
export interface YourNotesPanelHandle {
  /** Persist the current editor content to the session's structured_output
   *  and notify the live summarizer. Awaited — returns when the DB write is
   *  complete so callers can safely run the post-meeting flush right after. */
  flush: () => Promise<void>;
}

/** Read the session's structured_output JSON and return the parsed object (or {}). */
async function readStructured(sessionId: string): Promise<any> {
  try {
    const raw = await window.ironmic.meetingGet(sessionId);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed?.structured_output) return {};
    try { return JSON.parse(parsed.structured_output) || {}; }
    catch { return {}; }
  } catch { return {}; }
}

async function persistUserNotes(sessionId: string, html: string, notifyLiveSummarizer = false): Promise<void> {
  const current = await readStructured(sessionId);
  const merged = { ...current, userNotes: html };
  try {
    await window.ironmic.meetingSetStructuredOutput(sessionId, JSON.stringify(merged));
    // Tell the main-process LiveSummarizer that user notes changed so it
    // re-runs the summary with the new content. Fire-and-forget; safe if
    // the function isn't available on older builds.
    if (notifyLiveSummarizer) {
      try { window.ironmic?.notifyMeetingUserNotesChanged?.(sessionId); }
      catch { /* noop */ }
    }
  } catch (err) {
    console.warn('[YourNotesPanel] Failed to persist notes:', err);
  }
}

export const YourNotesPanel = forwardRef<YourNotesPanelHandle, Props>(function YourNotesPanel(
  { sessionId, isActive, initialHtml },
  ref,
) {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saved, setSaved] = useState(true);
  const [wordCount, setWordCount] = useState(0);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] } }),
      Placeholder.configure({ placeholder: 'Capture your thoughts, questions, and action items here…' }),
      Typography,
    ],
    content: initialHtml || '',
    editable: isActive,
    editorProps: {
      attributes: {
        class: 'focus:outline-none prose prose-invert prose-sm max-w-none min-h-[200px]',
      },
    },
    onUpdate: ({ editor }) => {
      setSaved(false);
      const text = editor.getText();
      setWordCount(text.trim() ? text.trim().split(/\s+/).length : 0);

      if (!sessionId || !isActive) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      // Tight debounce (400ms) so the live AI summary reflects the user's
      // typed notes quickly. The LiveSummarizer has its own ~1s debounce on
      // top of this, so the combined end-to-end latency is ~1.4s — fast
      // enough that pressing a point into your notes shows up in the AI
      // summary on the next update without feeling laggy.
      debounceRef.current = setTimeout(async () => {
        await persistUserNotes(sessionId, editor.getHTML(), /* notifyLiveSummarizer */ true);
        setSaved(true);
      }, 400);
    },
  }, [sessionId, isActive]);

  // When the session becomes active, load any pre-existing user notes (resume case).
  useEffect(() => {
    if (!sessionId || !editor) return;
    void (async () => {
      const structured = await readStructured(sessionId);
      const existing: string | undefined = structured?.userNotes;
      if (typeof existing === 'string' && existing.length > 0) {
        // Only set if editor is empty (don't clobber user's in-flight edits).
        if (!editor.getText().trim()) {
          editor.commands.setContent(existing, false);
        }
      }
    })();
  }, [sessionId, editor]);

  // Toggle editability in sync with isActive.
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(isActive);
  }, [isActive, editor]);

  // Flush any pending save on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (sessionId && editor && isActive) {
        void persistUserNotes(sessionId, editor.getHTML());
      }
    };
  }, [sessionId, editor, isActive]);

  // Imperative flush — the parent awaits this before calling meetingStopRecording
  // so the live summarizer's final pass sees the latest typed content.
  useImperativeHandle(ref, () => ({
    flush: async () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (!sessionId || !editor) return;
      try {
        await persistUserNotes(sessionId, editor.getHTML(), /* notifyLiveSummarizer */ true);
        setSaved(true);
      } catch (err) {
        console.warn('[YourNotesPanel] flush failed:', err);
      }
    },
  }), [sessionId, editor]);

  return (
    <Card variant="default" padding="none" className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-iron-border/50">
        <div className="flex items-center gap-2">
          <FileText className="w-3.5 h-3.5 text-iron-accent-light" />
          <span className="text-xs font-semibold text-iron-text">Your Notes</span>
          {!isActive && (
            <span className="text-[10px] text-iron-text-muted bg-iron-surface-hover px-1.5 py-0.5 rounded">
              Available during meeting
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-iron-text-muted">
          <span>{wordCount} words</span>
          {isActive && saved && (
            <span className="flex items-center gap-1 text-emerald-400">
              <Check className="w-3 h-3" /> Saved
            </span>
          )}
          {isActive && !saved && <span className="text-amber-400">Saving…</span>}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        <EditorContent editor={editor} />
      </div>
    </Card>
  );
});
