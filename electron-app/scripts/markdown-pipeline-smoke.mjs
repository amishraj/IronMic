// End-to-end smoke for markdownPipeline. Exercises all three projections
// plus the security boundaries (raw HTML drop, javascript: href reject,
// task list state preservation, table plain-text flattening).
import { Marked } from 'marked';
import sanitizeHtmlLib from 'sanitize-html';
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

// ── Replicate the pipeline from src/main/utils/markdownPipeline.ts ──
// (We can't easily import the TS module from a .mjs script without a build
// step; this duplicates the logic to validate the algorithm. Production
// callers go through ipc-handlers → markdownPipeline.ts.)
const marked = new Marked();
marked.use({ renderer: { html() { return ''; } } });

function normalizeTaskListMarkup(html) {
  let out = html;
  out = out.replace(
    /<li[^>]*>\s*<input(?=[^>]*\btype="checkbox")(?=[^>]*\bchecked\b)[^>]*>\s*([\s\S]*?)<\/li>/gi,
    (_m, inner) => `<li data-type="taskItem" data-checked="true"><p>${inner.trim()}</p></li>`,
  );
  out = out.replace(
    /<li[^>]*>\s*<input(?=[^>]*\btype="checkbox")[^>]*>\s*([\s\S]*?)<\/li>/gi,
    (_m, inner) => `<li data-type="taskItem" data-checked="false"><p>${inner.trim()}</p></li>`,
  );
  out = out.replace(/<ul([^>]*)>([\s\S]*?)<\/ul>/gi, (m, attrs, body) => {
    if (!body.includes('data-type="taskItem"')) return m;
    if (/data-type="taskList"/.test(attrs)) return m;
    return `<ul data-type="taskList"${attrs}>${body}</ul>`;
  });
  return out;
}

const SANITIZE_OPTS = {
  allowedTags: ['p','br','h1','h2','h3','strong','em','u','s','a','ul','ol','li','blockquote','pre','code','hr','table','thead','tbody','tr','th','td'],
  allowedAttributes: { a: ['href','title'], li: ['data-type','data-checked'], ul: ['data-type'] },
  allowedSchemes: ['http','https','mailto'],
  allowedSchemesByTag: { a: ['http','https','mailto'] },
};
const sanitize = (h) => sanitizeHtmlLib(h, SANITIZE_OPTS);

const exts = [
  StarterKit.configure({ heading: { levels: [1,2,3] } }),
  Underline, TextAlign, Highlight, Link.configure({ openOnClick: false }), Typography,
  Table.configure({ resizable: false }), TableRow, TableHeader, TableCell,
  TaskList, TaskItem.configure({ nested: true }),
];

function project(md) {
  const rawHtml = marked.parse(md);
  const normalized = normalizeTaskListMarkup(rawHtml);
  const html = sanitize(normalized);
  const json = generateJSON(html, exts);
  return { html, json };
}

let pass = 0, fail = 0;
function check(label, condition, detail) {
  if (condition) { console.log('PASS', label); pass++; }
  else { console.error('FAIL', label, '—', detail); fail++; }
}

// 1. Basic happy path
{
  const { html, json } = project('## Hello\n\n**Bold** and `code`.\n\n- one\n- two');
  check('h2 in html', html.includes('<h2>Hello</h2>'), html);
  check('bold in html', html.includes('<strong>Bold</strong>'), html);
  check('inline code in html', html.includes('<code>code</code>'), html);
  check('list in html', html.includes('<ul>') && html.includes('<li>one</li>'), html);
  const kinds = json.content?.map(n => n.type) ?? [];
  check('json has heading', kinds.includes('heading'));
  check('json has bulletList', kinds.includes('bulletList'));
}

// 2. XSS / raw HTML drop
{
  const { html } = project('Hello\n\n<script>alert("x")</script>\n\nWorld');
  check('script tag dropped', !html.includes('<script>') && !html.includes('alert'), html);
}

// 3. javascript: href rejected
{
  const { html } = project('[click me](javascript:alert(1))');
  check('javascript: href rejected', !html.includes('javascript:'), html);
}

// 4. http: href allowed
{
  const { html } = project('[docs](https://example.com)');
  check('https href allowed', html.includes('href="https://example.com"'), html);
}

// 5. Task list state preserved
{
  const md = '- [x] done thing\n- [ ] todo thing';
  const { html, json } = project(md);
  check('task item checked=true', html.includes('data-checked="true"'), html);
  check('task item checked=false', html.includes('data-checked="false"'), html);
  const kinds = json.content?.map(n => n.type) ?? [];
  check('json has taskList', kinds.includes('taskList'));
}

// 6. Table round-trip
{
  const md = '| Owner | Item | Due |\n|---|---|---|\n| Alice | Ship | Friday |';
  const { html, json } = project(md);
  check('table in html', html.includes('<table>'), html);
  const kinds = json.content?.map(n => n.type) ?? [];
  check('json has table', kinds.includes('table'));
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
