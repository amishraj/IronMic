/**
 * tiptapText — plain-text ↔ TipTap-compatible-HTML helpers shared by the
 * Notes editor (DictatePage / NoteEditor) and the Meetings detail editor.
 *
 * Why these live here, not inline in components:
 *  - Multiple surfaces need to seed a TipTap editor from a stored plain
 *    string (`rawTranscript`, `plainSummary`, etc.) without collapsing
 *    paragraph breaks, which TipTap's own `setContent(string)` does.
 *  - We also need to derive a clean plain string from editor HTML for
 *    DB columns that downstream search / export reads (FTS, markdown
 *    export, notebook-entry `rawTranscript`).
 *  - Keeping a single implementation prevents the helpers in DictatePage
 *    and Meetings drifting (e.g. one starts decoding `&nbsp;` and the
 *    other doesn't) and makes the meeting↔notes sync round-trip stable.
 */

/** Minimal HTML escaper. TipTap further sanitizes on parse, but we don't
 *  want raw `<script>` or stray `<` from a transcript to slip through as
 *  real HTML. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Plain text → TipTap-compatible HTML. Splits on `\n\n+` for paragraph
 *  breaks and `\n` for `<br>` so `setContent` doesn't collapse formatting
 *  the user typed in a textarea or that arrived from an LLM. */
export function textToHtml(text: string): string {
  if (!text) return '';
  return text
    .split(/\n\n+/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** TipTap (or any) HTML → plain text. Block-level tags become `\n\n`,
 *  `<br>` becomes `\n`, list items get a leading `- `, and the result is
 *  stripped of any remaining tags + decoded for the common entities.
 *
 *  Used when writing back to columns the rest of the app reads as plain
 *  (FTS, sidebar previews, meeting `plainSummary`, notebook
 *  `rawTranscript`). It is intentionally lossy — formatting lives in the
 *  parallel `htmlContent` field. */
export function htmlToText(html: string): string {
  if (!html) return '';
  let s = html;
  // Block boundaries → paragraph breaks. Doing this BEFORE tag stripping
  // is what preserves the visual structure as plain text.
  s = s
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/(ul|ol)>/gi, '\n');
  // Strip remaining tags.
  s = s.replace(/<[^>]+>/g, '');
  // Decode the entities our escapeHtml could have produced, plus &nbsp;.
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // Collapse 3+ blank lines but PRESERVE single blank lines — paragraph
  // breaks are meaningful for the AI title generator and exports.
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** True when an HTML string contains no visible characters (only tags,
 *  whitespace, or empty paragraphs). Cheaper than rendering. */
export function isHtmlEmpty(html: string): boolean {
  if (!html) return true;
  return htmlToText(html).length === 0;
}
