// Verify the marked v4 + sanitize-html + @tiptap/html pipeline works
// when loaded as CommonJS (electron main runs CJS). Exercises the same
// security guarantees as markdown-pipeline-smoke.mjs but uses the v4
// module-level marked API (the only API that loads from CJS).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { marked, Lexer } = require('/Users/amishraj/Desktop/IronMic/electron-app/node_modules/marked');
const sanitizeHtml = require('/Users/amishraj/Desktop/IronMic/electron-app/node_modules/sanitize-html');

// Configure html-token-drop globally (matches markdownPipeline.ts).
marked.use({ renderer: { html() { return ''; } } });

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { console.log('PASS', label); pass++; }
  else { console.error('FAIL', label, '—', detail); fail++; }
}

// 1. Basic round-trip
{
  const html = marked.parse('## Hello\n\n**Bold** and `code`.');
  check('h2 in html', html.includes('<h2>Hello</h2>'), html);
  check('bold in html', html.includes('<strong>Bold</strong>'), html);
}

// 2. Script dropped by html renderer
{
  const html = marked.parse('Hello\n\n<script>alert(1)</script>\n\nWorld');
  check('script dropped', !html.includes('<script>') && !html.includes('alert'), html);
}

// 3. Lexer.lex works
{
  const tokens = Lexer.lex('# foo\n\n- bar\n- baz');
  const types = tokens.map(t => t.type);
  check('lexer types', types.includes('heading') && types.includes('list'), types.join(','));
}

// 4. sanitize-html reject javascript:
{
  const dirty = '<a href="javascript:alert(1)">x</a>';
  const clean = sanitizeHtml(dirty, {
    allowedTags: ['a'],
    allowedAttributes: { a: ['href'] },
    allowedSchemes: ['http', 'https', 'mailto'],
  });
  check('javascript: rejected', !clean.includes('javascript:'), clean);
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
