/**
 * RichTextEditorShell — the shared TipTap surface used by both the Notes
 * editor (NoteEditor.tsx) and the Meetings detail editor
 * (MeetingDetailPage.tsx).
 *
 * Owns:
 *   - TipTap editor instance + extension config (StarterKit, Underline,
 *     TextAlign, Highlight, Link, Typography, Placeholder)
 *   - The toolbar (block-type dropdown, inline marks, lists, alignment,
 *     insertions, undo/redo) and the bubble menu
 *
 * Does NOT own:
 *   - Persistence — the parent gets the HTML via `onChangeHtml` and
 *     decides what to do with it (debounced save to SQLite for Notes,
 *     buffered draft for Meetings)
 *   - Per-surface controls (TTS, Collaborate, Raw/Polished, Dictate) —
 *     those go in the parent-supplied `rightToolbarSlot`
 *
 * Lifecycle contract for `onReady`:
 *   - Called with the live `Editor` once after the editor mounts.
 *   - Called with `null` when the shell unmounts so the parent never
 *     holds a stale Editor reference across remounts.
 *
 * Controlled-content sync:
 *   - The editor's content updates from typing fire `onChangeHtml`.
 *   - When the parent passes a NEW `valueHtml` that differs from the
 *     editor's current HTML AND from the last value we emitted, we call
 *     `setContent(valueHtml, false)` (no emit, so we don't loop).
 *   - The "last emitted" guard is the important one — without it, every
 *     keystroke would round-trip through React state and trigger a
 *     setContent that resets the cursor.
 */

import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { useEditor, EditorContent, BubbleMenu, type Editor } from '@tiptap/react';
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
  ChevronDown,
} from 'lucide-react';

interface Props {
  valueHtml: string;
  onChangeHtml: (html: string) => void;
  placeholder?: string;
  /** Optional slot rendered at the right edge of the toolbar. Used by
   *  parents to inject surface-specific controls (TTS, Collaborate,
   *  Raw/Polished toggle, Dictate) without forking the toolbar code. */
  rightToolbarSlot?: ReactNode;
  readOnly?: boolean;
  /** Lifecycle callback. Receives the live `Editor` once it's ready and
   *  `null` on unmount so the parent can clean up imperative refs. */
  onReady?: (editor: Editor | null) => void;
  /** Optional className applied to the outer wrapper. Defaults match the
   *  Notes editor look (full height, iron-bg). */
  className?: string;
}

export function RichTextEditorShell({
  valueHtml,
  onChangeHtml,
  placeholder = 'Start typing…',
  rightToolbarSlot,
  readOnly = false,
  onReady,
  className = 'h-full flex flex-col bg-iron-bg',
}: Props) {
  // Holds the most recent HTML we emitted via onChangeHtml. The
  // controlled-sync effect below skips setContent when the incoming
  // valueHtml equals what we just emitted — that's the loop-breaker.
  const lastEmittedRef = useRef<string>(valueHtml);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Placeholder.configure({ placeholder }),
      Underline,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Highlight.configure({ multicolor: false }),
      Link.configure({ openOnClick: false, HTMLAttributes: { class: '' } }),
      Typography,
    ],
    content: valueHtml,
    editable: !readOnly,
    editorProps: { attributes: { class: 'focus:outline-none' } },
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      lastEmittedRef.current = html;
      onChangeHtml(html);
    },
  });

  // Notify parent on mount + cleanup on unmount.
  useEffect(() => {
    if (!editor) return;
    onReady?.(editor);
    return () => { onReady?.(null); };
    // We deliberately don't depend on `onReady` — a parent that passes a
    // fresh closure each render would otherwise tear down + remount on
    // every keystroke. The editor instance is stable for the shell's
    // lifetime, so notifying once is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Keep `editable` in sync if the parent toggles readOnly mid-session.
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  // Controlled-content sync. Runs whenever the parent supplies a new
  // valueHtml; skips when the incoming value matches what we last
  // emitted (to avoid a typing-induced loop) or what's already in the
  // editor (no-op write — also resets cursor without `false` flag).
  useEffect(() => {
    if (!editor) return;
    if (valueHtml === lastEmittedRef.current) return;
    if (valueHtml === editor.getHTML()) return;
    editor.commands.setContent(valueHtml || '', false);
    lastEmittedRef.current = valueHtml;
  }, [editor, valueHtml]);

  const setLink = useCallback(() => {
    if (!editor) return;
    const previousUrl = editor.getAttributes('link').href;
    const url = window.prompt('URL', previousUrl);
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }, [editor]);

  if (!editor) return null;

  return (
    <div className={className}>
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-iron-border bg-iron-surface/40 flex-wrap">
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
        <BlockTypeDropdown editor={editor} />
        <Separator />

        <ToolbarBtn active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} icon={<Bold className="w-3.5 h-3.5" />} title="Bold (⌘B)" />
        <ToolbarBtn active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} icon={<Italic className="w-3.5 h-3.5" />} title="Italic (⌘I)" />
        <ToolbarBtn active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()} icon={<UnderlineIcon className="w-3.5 h-3.5" />} title="Underline (⌘U)" />
        <ToolbarBtn active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} icon={<Strikethrough className="w-3.5 h-3.5" />} title="Strikethrough" />
        <ToolbarBtn active={editor.isActive('highlight')} onClick={() => editor.chain().focus().toggleHighlight().run()} icon={<Highlighter className="w-3.5 h-3.5" />} title="Highlight" />
        <ToolbarBtn active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()} icon={<Code className="w-3.5 h-3.5" />} title="Inline code" />

        <Separator />

        <ToolbarBtn active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} icon={<List className="w-3.5 h-3.5" />} title="Bullet list" />
        <ToolbarBtn active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} icon={<ListOrdered className="w-3.5 h-3.5" />} title="Numbered list" />

        <Separator />

        <ToolbarBtn active={editor.isActive({ textAlign: 'left' })} onClick={() => editor.chain().focus().setTextAlign('left').run()} icon={<AlignLeft className="w-3.5 h-3.5" />} title="Align left" />
        <ToolbarBtn active={editor.isActive({ textAlign: 'center' })} onClick={() => editor.chain().focus().setTextAlign('center').run()} icon={<AlignCenter className="w-3.5 h-3.5" />} title="Align center" />
        <ToolbarBtn active={editor.isActive({ textAlign: 'right' })} onClick={() => editor.chain().focus().setTextAlign('right').run()} icon={<AlignRight className="w-3.5 h-3.5" />} title="Align right" />

        <Separator />

        <ToolbarBtn active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()} icon={<Quote className="w-3.5 h-3.5" />} title="Blockquote" />
        <ToolbarBtn active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()} icon={<>{`</>`}</>} title="Code block" className="font-mono text-[10px]" />
        <ToolbarBtn onClick={() => editor.chain().focus().setHorizontalRule().run()} icon={<Minus className="w-3.5 h-3.5" />} title="Horizontal rule" />
        <ToolbarBtn active={editor.isActive('link')} onClick={setLink} icon={<LinkIcon className="w-3.5 h-3.5" />} title="Link" />

        {rightToolbarSlot && (
          <>
            <Separator />
            <div className="flex items-center gap-1 ml-auto">{rightToolbarSlot}</div>
          </>
        )}
      </div>

      {/* Bubble menu — appears on text selection */}
      <BubbleMenu editor={editor} tippyOptions={{ duration: 150 }} className="flex items-center gap-0.5 bg-iron-surface border border-iron-border rounded-lg shadow-depth p-1">
        <ToolbarBtn active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} icon={<Bold className="w-3.5 h-3.5" />} title="Bold" />
        <ToolbarBtn active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} icon={<Italic className="w-3.5 h-3.5" />} title="Italic" />
        <ToolbarBtn active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()} icon={<UnderlineIcon className="w-3.5 h-3.5" />} title="Underline" />
        <ToolbarBtn active={editor.isActive('highlight')} onClick={() => editor.chain().focus().toggleHighlight().run()} icon={<Highlighter className="w-3.5 h-3.5" />} title="Highlight" />
        <ToolbarBtn active={editor.isActive('link')} onClick={setLink} icon={<LinkIcon className="w-3.5 h-3.5" />} title="Link" />
      </BubbleMenu>

      {/* Editor area */}
      <div className="flex-1 overflow-y-auto">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

/* ─── Toolbar primitives (kept module-private; identical look to NoteEditor) ─── */

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

function Separator() {
  return <div className="w-px h-5 bg-iron-border mx-1" />;
}

function BlockTypeDropdown({ editor }: { editor: Editor }) {
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
