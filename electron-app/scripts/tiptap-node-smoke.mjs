// Phase 2 acceptance gate (per the approved plan): verify @tiptap/html
// generateJSON works from plain Node (electron main runs Node) using the
// FULL shared extension list including Table + TaskList. If this throws,
// the fallback is to add jsdom and shim DOM globals at startup.
import { generateJSON } from '@tiptap/html';
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

const html = `
<h2>Heading test</h2>
<p>A paragraph with <strong>bold</strong> and <em>italic</em> and <code>inline</code>.</p>
<ul>
  <li>First bullet</li>
  <li>Second bullet</li>
</ul>
<ol><li>Ordered one</li><li>Ordered two</li></ol>
<blockquote>quoted text</blockquote>
<pre><code>code block contents</code></pre>
<table>
  <thead><tr><th>Owner</th><th>Item</th><th>Due</th></tr></thead>
  <tbody>
    <tr><td>Alice</td><td>Ship the migration</td><td>Friday</td></tr>
    <tr><td>Bob</td><td>Review tests</td><td></td></tr>
  </tbody>
</table>
<ul data-type="taskList">
  <li data-type="taskItem" data-checked="true"><p>done thing</p></li>
  <li data-type="taskItem" data-checked="false"><p>todo thing</p></li>
</ul>
`;

const extensions = [
  StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
  Underline,
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  Highlight.configure({ multicolor: false }),
  Link.configure({ openOnClick: false }),
  Typography,
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  TaskList,
  TaskItem.configure({ nested: true }),
];

try {
  const json = generateJSON(html, extensions);
  console.log('OK: @tiptap/html generateJSON works in plain Node with the full shared extension list.');
  console.log('Top-level node type:', json.type);
  console.log('Child count:', json.content?.length);
  console.log('Child kinds:', json.content?.map((n) => n.type).join(', '));
  // Spot-check that table and taskList survived round-trip
  const kinds = json.content?.map((n) => n.type) ?? [];
  if (!kinds.includes('table')) {
    console.error('FAIL: expected table node missing');
    process.exit(1);
  }
  if (!kinds.includes('taskList')) {
    console.error('FAIL: expected taskList node missing');
    process.exit(1);
  }
  console.log('Phase 2 acceptance gate: PASSED. No DOM shim required.');
  process.exit(0);
} catch (err) {
  console.error('FAIL:', err.message);
  console.error(err.stack);
  process.exit(1);
}
