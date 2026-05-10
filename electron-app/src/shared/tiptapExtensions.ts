/**
 * Shared TipTap extension list — single source of truth used by both:
 *   - main process (`@tiptap/html` `generateJSON` in markdownPipeline)
 *   - renderer (RichTextEditorShell `useEditor` config)
 *
 * Drift between the two would corrupt the JSON round-trip: main produces
 * ProseMirror nodes the renderer doesn't recognize (and vice versa). Keeping
 * one list here forces them to agree.
 *
 * Lives in src/shared because tsconfig.main.json already includes that path
 * and the renderer alias resolves it cleanly. Renderer never imports from
 * src/main; that boundary is preserved.
 *
 * Note on configuration: this list does NOT carry editor-only config like
 * Placeholder text or BubbleMenu — those live with the renderer's editor
 * because they're presentation concerns. The shared list covers ONLY the
 * structural extensions whose ProseMirror schema must be identical on both
 * sides.
 */

import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import Highlight from '@tiptap/extension-highlight';
import Link from '@tiptap/extension-link';
import Typography from '@tiptap/extension-typography';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';

/**
 * Extensions used for schema-significant operations on both main and
 * renderer. Returns a fresh array each call because TipTap mutates extension
 * objects when registering them (caching the same instance breaks the
 * second editor that tries to use it).
 */
export function buildSharedExtensions() {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
    }),
    Underline,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Highlight.configure({ multicolor: false }),
    Link.configure({ openOnClick: false, HTMLAttributes: { class: '' } }),
    Typography,
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
  ];
}
