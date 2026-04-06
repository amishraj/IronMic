import { useEffect, useRef, useCallback, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import Highlight from '@tiptap/extension-highlight';
import Link from '@tiptap/extension-link';
import Typography from '@tiptap/extension-typography';
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  Heading1, Heading2, Heading3, List, ListOrdered,
  Quote, Code, Minus, Link as LinkIcon, Highlighter, Undo2, Redo2,
  AlignLeft, AlignCenter, AlignRight, Mic, Info, FileText,
  Volume2, Square, Pause, Play,
} from 'lucide-react';
import { useRecordingStore } from '../stores/useRecordingStore';
import { useTtsStore } from '../stores/useTtsStore';
import { Card } from './ui';

const STORAGE_KEY = 'ironmic-dictate-draft';

function loadDraft(): { html: string; entryId: string | null } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function saveDraft(html: string, entryId: string | null) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ html, entryId }));
  } catch { /* quota exceeded — ignore */ }
}

export function DictatePage() {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentEntryId = useRef<string | null>(null);
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);
  const [saved, setSaved] = useState(true);
  const { handleHotkeyPress, state: recordingState } = useRecordingStore();
  const { state: ttsState, synthesizeAndPlay, stop: ttsStop, toggle: ttsToggle } = useTtsStore();

  const handleReadBack = useCallback(() => {
    if (!editor) return;
    if (ttsState === 'playing' || ttsState === 'paused') {
      ttsStop();
      return;
    }
    const text = editor.getText().trim();
    if (text) synthesizeAndPlay(text, currentEntryId.current ?? undefined);
  }, [editor, ttsState, synthesizeAndPlay, ttsStop]);

  // Restore draft on mount
  const draft = useRef(loadDraft());

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Placeholder.configure({ placeholder: 'Press the mic button and start speaking, or type here...' }),
      Underline,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Highlight.configure({ multicolor: false }),
      Link.configure({ openOnClick: false, HTMLAttributes: { class: '' } }),
      Typography,
    ],
    content: draft.current?.html || '',
    editorProps: {
      attributes: { class: 'focus:outline-none' },
    },
    onCreate: ({ editor }) => {
      if (draft.current?.entryId) currentEntryId.current = draft.current.entryId;
      const text = editor.getText();
      setCharCount(text.length);
      setWordCount(text.trim() ? text.trim().split(/\s+/).length : 0);
    },
    onUpdate: ({ editor }) => {
      setSaved(false);
      const text = editor.getText();
      setCharCount(text.length);
      setWordCount(text.trim() ? text.trim().split(/\s+/).length : 0);

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const html = editor.getHTML();
        saveContent(html);
        saveDraft(html, currentEntryId.current);
        setSaved(true);
      }, 1000);
    },
  });

  const saveContent = useCallback(async (html: string) => {
    const api = window.ironmic;
    const plainText = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!plainText) return;
    try {
      if (currentEntryId.current) {
        await api.updateEntry(currentEntryId.current, { rawTranscript: plainText });
      } else {
        const entry = await api.createEntry({
          rawTranscript: plainText,
          polishedText: undefined,
          durationSeconds: undefined,
          sourceApp: 'dictate',
        } as any);
        currentEntryId.current = entry.id;
      }
    } catch (err) { console.error('Failed to save:', err); }
  }, []);

  // Insert dictation result into editor when recording completes
  useEffect(() => {
    if (!editor) return;
    const handler = (e: Event) => {
      const { text, entryId } = (e as CustomEvent).detail;
      if (text && !text.startsWith('[stub')) {
        if (entryId) currentEntryId.current = entryId;
        editor.commands.insertContent(text + ' ');
        // Persist immediately so navigating away doesn't lose it
        saveDraft(editor.getHTML(), currentEntryId.current);
      }
    };
    window.addEventListener('ironmic:dictation-complete', handler);
    return () => window.removeEventListener('ironmic:dictation-complete', handler);
  }, [editor]);

  const setLink = useCallback(() => {
    if (!editor) return;
    const previousUrl = editor.getAttributes('link').href;
    const url = window.prompt('URL', previousUrl);
    if (url === null) return;
    if (url === '') { editor.chain().focus().extendMarkRange('link').unsetLink().run(); return; }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }, [editor]);

  const handleNewDocument = () => {
    if (!editor) return;
    editor.commands.clearContent();
    currentEntryId.current = null;
    localStorage.removeItem(STORAGE_KEY);
    setWordCount(0);
    setCharCount(0);
    setSaved(true);
  };

  if (!editor) return null;

  return (
    <div className="h-full flex flex-col bg-iron-bg">
      {/* Header */}
      <div className="px-5 pt-4 pb-3 border-b border-iron-border">
        <div className="flex items-center justify-between max-w-4xl mx-auto">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-iron-accent/10 flex items-center justify-center">
              <Mic className="w-4.5 h-4.5 text-iron-accent-light" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-iron-text">Dictate</h2>
              <p className="text-[10px] text-iron-text-muted">Voice-to-text rich editor</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Record button */}
            <button
              onClick={() => handleHotkeyPress('dictate')}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium transition-all ${
                recordingState === 'recording'
                  ? 'bg-iron-danger text-white shadow-glow-danger animate-pulse-recording'
                  : recordingState === 'processing'
                  ? 'bg-iron-warning text-white shadow-glow'
                  : 'bg-gradient-accent text-white hover:shadow-glow'
              }`}
            >
              <Mic className="w-3.5 h-3.5" />
              {recordingState === 'recording' ? 'Stop' : recordingState === 'processing' ? 'Processing...' : 'Dictate'}
            </button>

            {/* Read back button */}
            <button
              onClick={ttsState === 'playing' || ttsState === 'paused' ? () => ttsToggle() : handleReadBack}
              disabled={ttsState === 'synthesizing' || (!editor?.getText().trim() && ttsState === 'idle')}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium transition-all ${
                ttsState === 'playing'
                  ? 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25'
                  : ttsState === 'paused'
                  ? 'bg-yellow-500/15 text-yellow-400 hover:bg-yellow-500/25'
                  : ttsState === 'synthesizing'
                  ? 'text-iron-text-muted opacity-50 cursor-wait'
                  : 'text-iron-text-muted hover:text-iron-text-secondary hover:bg-iron-surface-hover'
              } disabled:opacity-30 disabled:cursor-not-allowed`}
              title={ttsState === 'playing' ? 'Pause read-back' : ttsState === 'paused' ? 'Resume read-back' : 'Read back aloud'}
            >
              {ttsState === 'playing' ? <Pause className="w-3.5 h-3.5" /> :
               ttsState === 'paused' ? <Play className="w-3.5 h-3.5" /> :
               <Volume2 className="w-3.5 h-3.5" />}
              {ttsState === 'playing' ? 'Pause' : ttsState === 'paused' ? 'Resume' : ttsState === 'synthesizing' ? 'Loading...' : 'Read Back'}
            </button>

            {/* Stop button (only when playing/paused) */}
            {(ttsState === 'playing' || ttsState === 'paused') && (
              <button
                onClick={handleReadBack}
                className="flex items-center gap-1.5 px-2 py-2 rounded-xl text-xs font-medium text-iron-text-muted hover:text-red-400 hover:bg-red-500/10 transition-all"
                title="Stop read-back"
              >
                <Square className="w-3 h-3" />
              </button>
            )}

            <button
              onClick={handleNewDocument}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium text-iron-text-muted hover:text-iron-text-secondary hover:bg-iron-surface-hover transition-all"
            >
              <FileText className="w-3.5 h-3.5" />
              New
            </button>
          </div>
        </div>
      </div>

      {/* Info tip */}
      <div className="px-5 py-2 border-b border-iron-border bg-iron-surface/30">
        <div className="max-w-4xl mx-auto flex items-center gap-2 text-[11px] text-iron-text-muted">
          <Info className="w-3 h-3 flex-shrink-0" />
          Press <strong className="text-iron-text">Dictate</strong> to record, then press again to stop. Your speech appears in the editor as formatted text. You can also type and edit directly.
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-iron-border bg-iron-surface/40 flex-wrap">
        <ToolbarBtn onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} icon={<Undo2 className="w-3.5 h-3.5" />} title="Undo" />
        <ToolbarBtn onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} icon={<Redo2 className="w-3.5 h-3.5" />} title="Redo" />
        <ToolbarDivider />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={editor.isActive('heading', { level: 1 })} icon={<Heading1 className="w-3.5 h-3.5" />} title="Heading 1" />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive('heading', { level: 2 })} icon={<Heading2 className="w-3.5 h-3.5" />} title="Heading 2" />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive('heading', { level: 3 })} icon={<Heading3 className="w-3.5 h-3.5" />} title="Heading 3" />
        <ToolbarDivider />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive('bold')} icon={<Bold className="w-3.5 h-3.5" />} title="Bold" />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive('italic')} icon={<Italic className="w-3.5 h-3.5" />} title="Italic" />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive('underline')} icon={<UnderlineIcon className="w-3.5 h-3.5" />} title="Underline" />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive('strike')} icon={<Strikethrough className="w-3.5 h-3.5" />} title="Strikethrough" />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleHighlight().run()} active={editor.isActive('highlight')} icon={<Highlighter className="w-3.5 h-3.5" />} title="Highlight" />
        <ToolbarDivider />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive('bulletList')} icon={<List className="w-3.5 h-3.5" />} title="Bullet list" />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive('orderedList')} icon={<ListOrdered className="w-3.5 h-3.5" />} title="Ordered list" />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive('blockquote')} icon={<Quote className="w-3.5 h-3.5" />} title="Quote" />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleCodeBlock().run()} active={editor.isActive('codeBlock')} icon={<Code className="w-3.5 h-3.5" />} title="Code" />
        <ToolbarBtn onClick={() => editor.chain().focus().setHorizontalRule().run()} icon={<Minus className="w-3.5 h-3.5" />} title="Divider" />
        <ToolbarDivider />
        <ToolbarBtn onClick={() => editor.chain().focus().setTextAlign('left').run()} active={editor.isActive({ textAlign: 'left' })} icon={<AlignLeft className="w-3.5 h-3.5" />} title="Align left" />
        <ToolbarBtn onClick={() => editor.chain().focus().setTextAlign('center').run()} active={editor.isActive({ textAlign: 'center' })} icon={<AlignCenter className="w-3.5 h-3.5" />} title="Align center" />
        <ToolbarBtn onClick={() => editor.chain().focus().setTextAlign('right').run()} active={editor.isActive({ textAlign: 'right' })} icon={<AlignRight className="w-3.5 h-3.5" />} title="Align right" />
        <ToolbarDivider />
        <ToolbarBtn onClick={setLink} active={editor.isActive('link')} icon={<LinkIcon className="w-3.5 h-3.5" />} title="Link" />
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-y-auto">
        <EditorContent editor={editor} />
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between px-5 py-1.5 border-t border-iron-border bg-iron-surface/30 text-[10px] text-iron-text-muted">
        <div className="flex items-center gap-3">
          <span>{wordCount} words</span>
          <span>{charCount} characters</span>
        </div>
        <span>{saved ? 'Saved' : 'Saving...'}</span>
      </div>
    </div>
  );
}

function ToolbarBtn({ onClick, active, disabled, icon, title }: {
  onClick: () => void; icon: React.ReactNode; title: string; active?: boolean; disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`p-1.5 rounded-md transition-colors ${
        active
          ? 'bg-iron-accent/15 text-iron-accent-light'
          : disabled
          ? 'text-iron-text-muted/30 cursor-not-allowed'
          : 'text-iron-text-muted hover:text-iron-text-secondary hover:bg-iron-surface-hover'
      }`}
    >
      {icon}
    </button>
  );
}

function ToolbarDivider() {
  return <div className="w-px h-5 bg-iron-border mx-1" />;
}
