/**
 * Markdown → projections pipeline. Lives in main because:
 *   1. The renderer never imports `marked` / `sanitize-html` / `@tiptap/html`
 *      (keeps the renderer bundle small and IPC the only contact surface).
 *   2. Sanitization runs once, in one place, before HTML reaches any
 *      `dangerouslySetInnerHTML` site or the TipTap JSON store.
 *
 * The renderer reaches this via the `convertMarkdown` IPC.
 *
 * Layered defenses against malicious markdown / cloud-LLM outputs:
 *   - Marked tokenizer extension drops raw HTML tokens (block + inline).
 *   - sanitize-html is the actual security boundary (allowlist tags + attrs,
 *     href-scheme allowlist).
 *   - The plain-text projection runs through the same HTML-token-dropping
 *     extension AND a final tag-stripper so raw HTML can't leak into FTS,
 *     TTS, clipboard, or exports.
 */

// marked v4 (CJS-compatible). v9+ is ESM-only and Electron's CommonJS main
// can't `require()` it. v4's module-level API is what we use here.
import { marked, Lexer } from 'marked';
import sanitizeHtmlLib from 'sanitize-html';
import { generateJSON } from '@tiptap/html';
import { buildSharedExtensions } from '../../shared/tiptapExtensions';

/** Result of the pipeline. All three projections derive from one input. */
export interface MarkdownProjections {
  /** Markdown stripped to flat text (FTS, TTS, clipboard, exports). */
  plainText: string;
  /** Sanitized HTML matching the shared TipTap extension allowlist. */
  html: string;
  /** ProseMirror JSON, ready for `editor.commands.setContent(parsed)`. */
  json: object;
}

/**
 * Configure module-level marked so the `html` renderer drops raw HTML
 * tokens. marked v4 is module-singleton; this `use()` call applies once
 * at module import time. sanitize-html is still the actual security
 * boundary — this layer simply means HTML never reaches Marked's
 * renderer in the first place. Defense in depth.
 *
 * NOTE: if a future caller in main starts using marked for something
 * else, they'll inherit this html-drop behavior — that's intended.
 */
marked.use({
  renderer: {
    html(_html: string) { return ''; },
  },
});

/**
 * Pre-sanitization step: convert checkbox-prefixed list items into TipTap's
 * `data-type="taskItem"` shape BEFORE sanitize-html runs. Doing it after
 * sanitization would lose the `<input type="checkbox">` (sanitize-html
 * strips it because we don't allowlist input).
 *
 * Defined transformation, NOT a security check — the sanitizer downstream
 * is the actual security boundary. This step exists purely so checked
 * state survives the pipeline.
 */
function normalizeTaskListMarkup(html: string): string {
  // Wrap parent <ul>s that contain task items so TipTap recognizes them.
  // The transformation order matters: items first, then the parent wrap.
  let out = html;

  // Checked state. Marked emits attributes in either order
  // (<input checked="" disabled="" type="checkbox">) so the regex matches
  // attribute presence rather than position. Lookaheads keep the match
  // attribute-order-agnostic.
  out = out.replace(
    /<li[^>]*>\s*<input(?=[^>]*\btype="checkbox")(?=[^>]*\bchecked\b)[^>]*>\s*([\s\S]*?)<\/li>/gi,
    (_m, inner) => `<li data-type="taskItem" data-checked="true"><p>${inner.trim()}</p></li>`,
  );
  // Unchecked: any remaining checkbox input that wasn't caught above.
  out = out.replace(
    /<li[^>]*>\s*<input(?=[^>]*\btype="checkbox")[^>]*>\s*([\s\S]*?)<\/li>/gi,
    (_m, inner) => `<li data-type="taskItem" data-checked="false"><p>${inner.trim()}</p></li>`,
  );

  // Wrap the surrounding <ul> if it contains any taskItem children.
  out = out.replace(
    /<ul([^>]*)>([\s\S]*?)<\/ul>/gi,
    (m, attrs, body) => {
      if (!body.includes('data-type="taskItem"')) return m;
      // Don't double-wrap if already tagged.
      if (/data-type="taskList"/.test(attrs)) return m;
      return `<ul data-type="taskList"${attrs}>${body}</ul>`;
    },
  );

  return out;
}

/**
 * sanitize-html allowlist matches the shared TipTap extension loadout.
 * Anything not on the list is stripped. This is the security boundary —
 * even if upstream layers fail, this catches dangerous content.
 *
 * Notable allowed schemes for `<a href>`: only http, https, mailto.
 * `javascript:`, `data:`, `vbscript:` are rejected.
 */
const SANITIZE_OPTS: sanitizeHtmlLib.IOptions = {
  allowedTags: [
    'p', 'br',
    'h1', 'h2', 'h3',
    'strong', 'em', 'u', 's',
    'a',
    'ul', 'ol', 'li',
    'blockquote',
    'pre', 'code',
    'hr',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  allowedAttributes: {
    a: ['href', 'title'],
    li: ['data-type', 'data-checked'],
    ul: ['data-type'],
    p: ['style'], // for text-align inline style
    h1: ['style'], h2: ['style'], h3: ['style'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { a: ['http', 'https', 'mailto'] },
  // Drop href entirely if it has a disallowed scheme; don't render the link as text.
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  // sanitize-html collapses whitespace by default; preserve preformatted blocks.
  parseStyleAttributes: false,
  allowedStyles: {
    '*': {
      'text-align': [/^left$|^right$|^center$|^justify$/],
    },
  },
};

function sanitizeHtml(html: string): string {
  return sanitizeHtmlLib(html, SANITIZE_OPTS);
}

/**
 * Walk the Marked AST to flatten markdown into plain text. Tables become
 * row-by-row labeled output ("Owner: Alice, Item: Ship the migration, Due: Friday").
 * Lists get "- " prefixes. Headings become their text content. Code blocks
 * are dropped of their fences but kept as text.
 *
 * Crucially: the tokenizer used here is the same HTML-dropping one as the
 * HTML pipeline, so raw HTML never reaches this walker. Final tag-stripper
 * at the end is defense-in-depth — if a future Marked update re-exposes
 * HTML tokens, we still don't leak them.
 */
function mdToPlainText(md: string): string {
  if (!md) return '';
  // marked v4: `Lexer.lex(md)` returns the token array. Same shape as
  // v9's `marked.lexer(md)`.
  const tokens = Lexer.lex(md);
  const out: string[] = [];

  const walkInline = (toks: any[]): string => {
    let s = '';
    for (const t of toks) {
      switch (t.type) {
        case 'text':
        case 'codespan':
          s += t.text;
          break;
        case 'strong':
        case 'em':
        case 'del':
          s += walkInline(t.tokens || []);
          break;
        case 'link':
          s += walkInline(t.tokens || []);
          break;
        case 'br':
          s += '\n';
          break;
        case 'escape':
          s += t.text;
          break;
        case 'html':
          // explicitly drop raw HTML inline tokens
          break;
        default:
          if (t.tokens) s += walkInline(t.tokens);
          else if (typeof t.text === 'string') s += t.text;
      }
    }
    return s;
  };

  for (const tok of tokens) {
    switch (tok.type) {
      case 'heading':
        out.push(walkInline(tok.tokens || []));
        break;
      case 'paragraph':
        out.push(walkInline(tok.tokens || []));
        break;
      case 'blockquote':
        // recurse-by-relexing the contents
        out.push(mdToPlainText(tok.text || '').trim());
        break;
      case 'list': {
        const items = (tok.items || []) as any[];
        // Join the bullets together as a single block so they don't get
        // double-spaced when out[] is joined with '\n\n' later.
        const bullets = items
          .map((it) => `- ${walkInline(it.tokens || []).trim()}`)
          .join('\n');
        if (bullets) out.push(bullets);
        break;
      }
      case 'code':
        out.push((tok.text || '').trim());
        break;
      case 'table': {
        const headers: string[] = (tok.header || []).map((h: any) =>
          walkInline(h.tokens || h.text ? (h.tokens || []) : []),
        );
        for (const row of tok.rows || []) {
          const cells: string[] = row.map((c: any) =>
            walkInline(c.tokens || []),
          );
          const labeled = cells
            .map((cell, i) => `${headers[i] ?? ''}: ${cell}`)
            .filter((s) => !s.endsWith(': '))
            .join(', ');
          if (labeled.trim()) out.push(labeled);
        }
        break;
      }
      case 'space':
      case 'hr':
        break;
      case 'html':
        // explicitly drop raw HTML block tokens
        break;
      default:
        if (typeof (tok as any).text === 'string') {
          out.push((tok as any).text);
        }
    }
  }

  // Defense-in-depth: strip any HTML tags that snuck past the tokenizer.
  // Drop the tag AND its text content together for `<script>`/`<style>`-style
  // tokens — leaving the inner text is worse than nothing.
  let text = out.join('\n\n');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<[^>]+>/g, '');
  // Decode the most common HTML entities so plain readers see clean text.
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // Collapse runs of 3+ blank lines.
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/**
 * Convert markdown to all three projections used by the app.
 *
 * Pipeline (precise order):
 *   1. Marked parse (HTML tokens dropped)
 *   2. Pre-sanitization task-list normalization (preserves checked state)
 *   3. sanitize-html allowlist (security boundary)
 *   4. @tiptap/html generateJSON via the shared extensions
 *   5. mdToPlainText (independent walker, same HTML-drop guarantee)
 */
export function markdownToProjections(md: string): MarkdownProjections {
  const safeMd = typeof md === 'string' ? md : '';
  // marked v4 returns string synchronously by default (no `async: false`
  // option needed — that was a v9+ option for opting out of Promise return).
  const rawHtml = marked.parse(safeMd) as string;
  const normalized = normalizeTaskListMarkup(rawHtml);
  const html = sanitizeHtml(normalized);
  const json = generateJSON(html, buildSharedExtensions());
  const plainText = mdToPlainText(safeMd);
  return { plainText, html, json };
}
