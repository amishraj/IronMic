import { useEffect, useRef, useCallback, useState } from 'react';
import { useDictationStore } from '../stores/useDictationStore';
import { useEditor, EditorContent, BubbleMenu } from '@tiptap/react';
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
  AlignLeft, AlignCenter, AlignRight, FileText, Pilcrow,
  ChevronDown, Volume2, Pause,
} from 'lucide-react';
import { useTtsStore } from '../stores/useTtsStore';

export function NoteEditor() {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentEntryId = useRef<string | null>(null);
  const [activeNoteId, setActiveNoteIdState] = useState<string | null>(null);
  // Single setter that keeps the ref (read by async save callbacks) and the
  // state (read by render — the play button needs to know which note is
  // currently loaded so it can compare against the TTS store's activeEntryId).
  const setNoteId = useCallback((id: string | null) => {
    currentEntryId.current = id;
    setActiveNoteIdState(id);
  }, []);
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);
  const [saved, setSaved] = useState(true);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({ placeholder: 'Start dictating or type here...' }),
      Underline,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Highlight.configure({ multicolor: false }),
      Link.configure({ openOnClick: false, HTMLAttributes: { class: '' } }),
      Typography,
    ],
    content: '',
    editorProps: {
      attributes: {
        class: 'focus:outline-none',
      },
    },
    onUpdate: ({ editor }) => {
      setSaved(false);
      const text = editor.getText();
      setCharCount(text.length);
      setWordCount(text.trim() ? text.trim().split(/\s+/).length : 0);

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        saveContent(editor.getHTML());
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
          sourceApp: 'IronMic Editor',
        } as any);
        setNoteId(entry.id);
      }
    } catch (err) { console.error('Failed to save note:', err); }
  }, [setNoteId]);

  useEffect(() => {
    if (!editor) return;

    // If the user clicked the mic shield to start a new note, skip loading the
    // most-recent entry and open a blank canvas instead.
    const { newNoteRequested } = useDictationStore.getState();
    if (newNoteRequested) {
      useDictationStore.setState({ newNoteRequested: false });
      setNoteId(null);
      editor.commands.setContent('');
      setWordCount(0);
      setCharCount(0);
      return;
    }

    async function loadRecent() {
      try {
        const entries = await window.ironmic.listEntries({ limit: 1, offset: 0, archived: false });
        if (entries.length > 0 && editor) {
          setNoteId(entries[0].id);
          editor.commands.setContent(entries[0].rawTranscript || '');
          const t = editor.getText();
          setWordCount(t.trim() ? t.trim().split(/\s+/).length : 0);
          setCharCount(t.length);
        }
      } catch { /* fresh start */ }
    }
    loadRecent();
  }, [editor]);

  // When the user clicks the shield while already on the notes page, open a blank note.
  useEffect(() => {
    if (!editor) return;
    const handler = () => {
      setNoteId(null);
      editor.commands.setContent('');
      editor.commands.focus();
      setWordCount(0);
      setCharCount(0);
      setSaved(true);
    };
    window.addEventListener('ironmic:quick-action-dictate', handler);
    return () => window.removeEventListener('ironmic:quick-action-dictate', handler);
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    const cleanup = window.ironmic.onPipelineStateChanged((state) => {
      if (state === 'idle') {
        setTimeout(async () => {
          try {
            const entries = await window.ironmic.listEntries({ limit: 1, offset: 0, archived: false });
            if (entries.length > 0 && entries[0].id !== currentEntryId.current) {
              const text = entries[0].polishedText || entries[0].rawTranscript;
              editor.commands.insertContent(text + ' ');
            }
          } catch { /* ignore */ }
        }, 100);
      }
    });
    return cleanup;
  }, [editor]);

  const setLink = useCallback(() => {
    if (!editor) return;
    const previousUrl = editor.getAttributes('link').href;
    const url = window.prompt('URL', previousUrl);
    if (url === null) return;
    if (url === '') { editor.chain().focus().extendMarkRange('link').unsetLink().run(); return; }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }, [editor]);

  if (!editor) return null;

  return (
    <div className="h-full flex flex-col bg-iron-bg">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-iron-border bg-iron-surface/40 flex-wrap">
        {/* Undo / Redo */}
        <ToolbarBtn
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!editor.can().undo()}
          icon={<Undo2 className="w-3.5 h-3.5" />}
          title="Undo"
        />
        <ToolbarBtn
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!editor.can().redo()}
          icon={<Redo2 className="w-3.5 h-3.5" />}
          title="Redo"
        />

        <Separator />

        {/* Block type dropdown */}
        <BlockTypeDropdown editor={editor} />

        <Separator />

        {/* Inline formatting */}
        <ToolbarBtn active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} icon={<Bold className="w-3.5 h-3.5" />} title="Bold (⌘B)" />
        <ToolbarBtn active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} icon={<Italic className="w-3.5 h-3.5" />} title="Italic (⌘I)" />
        <ToolbarBtn active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()} icon={<UnderlineIcon className="w-3.5 h-3.5" />} title="Underline (⌘U)" />
        <ToolbarBtn active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} icon={<Strikethrough className="w-3.5 h-3.5" />} title="Strikethrough" />
        <ToolbarBtn active={editor.isActive('highlight')} onClick={() => editor.chain().focus().toggleHighlight().run()} icon={<Highlighter className="w-3.5 h-3.5" />} title="Highlight" />
        <ToolbarBtn active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()} icon={<Code className="w-3.5 h-3.5" />} title="Inline code" />

        <Separator />

        {/* Lists */}
        <ToolbarBtn active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} icon={<List className="w-3.5 h-3.5" />} title="Bullet list" />
        <ToolbarBtn active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} icon={<ListOrdered className="w-3.5 h-3.5" />} title="Numbered list" />

        <Separator />

        {/* Alignment */}
        <ToolbarBtn active={editor.isActive({ textAlign: 'left' })} onClick={() => editor.chain().focus().setTextAlign('left').run()} icon={<AlignLeft className="w-3.5 h-3.5" />} title="Align left" />
        <ToolbarBtn active={editor.isActive({ textAlign: 'center' })} onClick={() => editor.chain().focus().setTextAlign('center').run()} icon={<AlignCenter className="w-3.5 h-3.5" />} title="Align center" />
        <ToolbarBtn active={editor.isActive({ textAlign: 'right' })} onClick={() => editor.chain().focus().setTextAlign('right').run()} icon={<AlignRight className="w-3.5 h-3.5" />} title="Align right" />

        <Separator />

        {/* Insert */}
        <ToolbarBtn active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()} icon={<Quote className="w-3.5 h-3.5" />} title="Blockquote" />
        <ToolbarBtn active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()} icon={<>{`</>`}</>} title="Code block" className="font-mono text-[10px]" />
        <ToolbarBtn onClick={() => editor.chain().focus().setHorizontalRule().run()} icon={<Minus className="w-3.5 h-3.5" />} title="Horizontal rule" />
        <ToolbarBtn active={editor.isActive('link')} onClick={setLink} icon={<LinkIcon className="w-3.5 h-3.5" />} title="Link" />

        <Separator />

        {/* TTS Playback */}
        <EditorPlayButton editor={editor} noteId={activeNoteId} />
      </div>

      {/* Live caption strip — appears while THIS note is being read aloud.
          Implements word-by-word highlighting since TipTap's rich-text doc
          can't be highlighted in-place without invasive Decoration plumbing. */}
      <NoteTtsCaption noteId={activeNoteId} />

      {/* Bubble menu — appears on text selection */}
      {editor && (
        <BubbleMenu editor={editor} tippyOptions={{ duration: 150 }} className="flex items-center gap-0.5 bg-iron-surface border border-iron-border rounded-lg shadow-depth p-1">
          <ToolbarBtn active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} icon={<Bold className="w-3.5 h-3.5" />} title="Bold" />
          <ToolbarBtn active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} icon={<Italic className="w-3.5 h-3.5" />} title="Italic" />
          <ToolbarBtn active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()} icon={<UnderlineIcon className="w-3.5 h-3.5" />} title="Underline" />
          <ToolbarBtn active={editor.isActive('highlight')} onClick={() => editor.chain().focus().toggleHighlight().run()} icon={<Highlighter className="w-3.5 h-3.5" />} title="Highlight" />
          <ToolbarBtn active={editor.isActive('link')} onClick={setLink} icon={<LinkIcon className="w-3.5 h-3.5" />} title="Link" />
        </BubbleMenu>
      )}

      {/* Editor area */}
      <div className="flex-1 overflow-y-auto">
        <EditorContent editor={editor} />
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-1.5 border-t border-iron-border bg-iron-surface/30 text-[11px] text-iron-text-muted">
        <div className="flex items-center gap-3">
          <span>{wordCount} words</span>
          <span>{charCount} characters</span>
        </div>
        <span>{saved ? 'Saved' : 'Saving...'}</span>
      </div>
    </div>
  );
}

/* ─── Toolbar Button ─── */

function ToolbarBtn({ active, disabled, onClick, icon, title, className = '' }: {
  active?: boolean; disabled?: boolean; onClick: () => void;
  icon: React.ReactNode; title: string; className?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`p-1.5 rounded-md transition-all text-xs ${className} ${
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

/* ─── Separator ─── */

function Separator() {
  return <div className="w-px h-5 bg-iron-border mx-1" />;
}

/* ─── Block Type Dropdown ─── */

function BlockTypeDropdown({ editor }: { editor: any }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const currentType = editor.isActive('heading', { level: 1 }) ? 'Heading 1'
    : editor.isActive('heading', { level: 2 }) ? 'Heading 2'
    : editor.isActive('heading', { level: 3 }) ? 'Heading 3'
    : editor.isActive('codeBlock') ? 'Code Block'
    : editor.isActive('blockquote') ? 'Quote'
    : 'Paragraph';

  const options = [
    { label: 'Paragraph', icon: <Pilcrow className="w-3.5 h-3.5" />, action: () => editor.chain().focus().setParagraph().run() },
    { label: 'Heading 1', icon: <Heading1 className="w-3.5 h-3.5" />, action: () => editor.chain().focus().toggleHeading({ level: 1 }).run() },
    { label: 'Heading 2', icon: <Heading2 className="w-3.5 h-3.5" />, action: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: 'Heading 3', icon: <Heading3 className="w-3.5 h-3.5" />, action: () => editor.chain().focus().toggleHeading({ level: 3 }).run() },
    { label: 'Quote', icon: <Quote className="w-3.5 h-3.5" />, action: () => editor.chain().focus().toggleBlockquote().run() },
    { label: 'Code Block', icon: <Code className="w-3.5 h-3.5" />, action: () => editor.chain().focus().toggleCodeBlock().run() },
  ];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs text-iron-text-secondary hover:bg-iron-surface-hover transition-colors min-w-[100px]"
      >
        <FileText className="w-3.5 h-3.5 text-iron-text-muted" />
        <span>{currentType}</span>
        <ChevronDown className="w-3 h-3 text-iron-text-muted ml-auto" />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 bg-iron-surface border border-iron-border rounded-lg shadow-depth-lg py-1 z-50 min-w-[160px] animate-fade-in">
          {options.map((opt) => (
            <button
              key={opt.label}
              onClick={() => { opt.action(); setOpen(false); }}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs transition-colors ${
                currentType === opt.label
                  ? 'text-iron-accent-light bg-iron-accent/10'
                  : 'text-iron-text-secondary hover:bg-iron-surface-hover hover:text-iron-text'
              }`}
            >
              {opt.icon}
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Editor Play Button ─── */

/**
 * Read-aloud button for the currently-loaded note.
 *
 * State machine:
 *  - `THIS` note is the active TTS target AND playing → button shows Pause.
 *  - `THIS` note is the active TTS target AND paused  → button shows Play (resumes).
 *  - `THIS` note is the active TTS target AND synthesizing → spinner.
 *  - Some OTHER note is currently playing, OR nothing is → button shows
 *    "Read aloud". Clicking it tears down the previous synth (the store's
 *    synthesizeAndPlay always calls ttsStop first) and starts fresh on this
 *    note's text. This matches the requested UX: switching notes mid-playback
 *    does NOT show pause/stop on the new note; clicking play replaces the
 *    active stream.
 */
function EditorPlayButton({ editor, noteId }: { editor: any; noteId: string | null }) {
  const { state, synthesizeAndPlay, pause, play, activeEntryId } = useTtsStore();
  const isThisNote = !!noteId && activeEntryId === noteId;
  const isPlayingThis = isThisNote && state === 'playing';
  const isPausedThis = isThisNote && state === 'paused';
  const isSynthThis = isThisNote && state === 'synthesizing';

  const handleClick = async () => {
    if (isPlayingThis) {
      await pause();
      return;
    }
    if (isPausedThis) {
      await play();
      return;
    }
    // Either nothing is playing, or a DIFFERENT note is playing. Either way:
    // start fresh synthesis for this note. The store's synthesizeAndPlay
    // calls ttsStop() internally before kicking off, so any previous stream
    // is replaced cleanly.
    const text = editor?.getText() || '';
    if (text.trim()) {
      await synthesizeAndPlay(text, noteId || undefined);
    }
  };

  const Icon = isPlayingThis ? Pause : Volume2;
  const title = isPlayingThis
    ? 'Pause'
    : isPausedThis
    ? 'Resume'
    : isThisNote
    ? 'Read aloud'
    : activeEntryId
    ? 'Read aloud (replaces current playback)'
    : 'Read aloud';

  return (
    <button
      onClick={handleClick}
      disabled={isSynthThis}
      title={title}
      className={`p-1.5 rounded-md transition-all ${
        isPlayingThis || isPausedThis
          ? 'bg-emerald-500/15 text-emerald-400'
          : 'text-iron-text-muted hover:text-iron-text-secondary hover:bg-iron-surface-hover'
      } disabled:opacity-40`}
    >
      {isSynthThis ? (
        <div className="w-3.5 h-3.5 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
      ) : (
        <Icon className="w-3.5 h-3.5" />
      )}
    </button>
  );
}

/* ─── Live TTS Caption Strip ─── */

/**
 * Word-by-word caption for an active read-back of THIS note. TipTap's
 * rich-text editor can't be highlighted in place without invasive ProseMirror
 * Decoration plumbing, so we surface the playback context as a sticky strip
 * just below the toolbar instead — same UX intent, much smaller blast radius.
 *
 * Renders nothing when no read-back is in progress for this note.
 */
function NoteTtsCaption({ noteId }: { noteId: string | null }) {
  const { state, timestamps, currentTimeMs, activeEntryId, durationMs } = useTtsStore();
  const isThisNote = !!noteId && activeEntryId === noteId;
  if (!isThisNote || (state !== 'playing' && state !== 'paused')) return null;

  // Find the active word index by binary-search style scan. Mirrors
  // HighlightedText.tsx — kept local to avoid coupling to that component
  // which is built around plain-text rendering.
  let activeIdx = -1;
  for (let i = 0; i < timestamps.length; i += 1) {
    const t = timestamps[i];
    if (currentTimeMs >= t.start_ms && currentTimeMs < t.end_ms) {
      activeIdx = i;
      break;
    }
    if (currentTimeMs < t.start_ms) {
      activeIdx = i - 1;
      break;
    }
  }
  if (activeIdx === -1 && timestamps.length > 0 && currentTimeMs >= timestamps[timestamps.length - 1].end_ms) {
    activeIdx = timestamps.length - 1;
  }

  // Show 4 words before and 8 after the active word for context.
  const start = Math.max(0, activeIdx - 4);
  const end = Math.min(timestamps.length, Math.max(activeIdx + 9, start + 12));
  const window = timestamps.slice(start, end);

  const progress = durationMs > 0 ? Math.min(100, (currentTimeMs / durationMs) * 100) : 0;
  const stateLabel = state === 'paused' ? 'Paused' : 'Reading aloud';

  return (
    <div className="border-b border-iron-border bg-emerald-500/5">
      <div className="flex items-center gap-3 px-4 py-2">
        <div className="flex items-center gap-1.5 text-[10px] font-medium text-emerald-400 flex-shrink-0">
          <Volume2 className="w-3 h-3" />
          {stateLabel}
        </div>
        <div className="flex-1 min-w-0 text-sm leading-relaxed truncate">
          {window.length === 0 ? (
            <span className="text-iron-text-muted italic">Synthesizing…</span>
          ) : (
            window.map((t, i) => {
              const idx = start + i;
              const isActive = idx === activeIdx;
              const isPast = idx < activeIdx;
              return (
                <span
                  key={`${idx}-${t.word}`}
                  className={
                    isActive
                      ? 'bg-emerald-500/25 text-emerald-200 px-1 rounded'
                      : isPast
                      ? 'text-iron-text-muted'
                      : 'text-iron-text'
                  }
                >
                  {i > 0 ? ' ' : ''}{t.word}
                </span>
              );
            })
          )}
        </div>
      </div>
      <div className="h-0.5 bg-iron-surface-active">
        <div className="h-full bg-emerald-500 transition-all duration-100" style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}
