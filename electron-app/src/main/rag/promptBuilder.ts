/**
 * promptBuilder — single source of truth for the Knowledge Q&A prompt shape.
 *
 * The grounding rules ("cite from supplied context only, do not fabricate")
 * are security-critical. Cloud CLIs differ in what they accept (Claude CLI
 * has `--append-system-prompt`; `gh models run` / Copilot CLI typically
 * don't), so instead of pretending there's a unified "system" channel we
 * commit to a hardened, tested **per-route** prompt shape:
 *
 *   - **local** — pass `systemPrompt` as a leading `system` role in the
 *     messages array consumed by the ironmic-llm subprocess.
 *   - **claude** — use `--append-system-prompt "<systemPrompt>"` when the
 *     installed CLI supports it; fall back to the prepended shape below.
 *   - **copilot / gh-models / anything-else** — prepend the system block
 *     to the user prompt with a fixed delimiter the model is instructed
 *     to treat as system-level.
 *
 * Centralizing this in one builder + one Rust constants module keeps the
 * citation contract identical across routes and gives prompt-injection
 * tests a single seam to assert against.
 */

/** Two-block context input from the retrieval layer. Attached notes appear
 *  in their own section above retrieved chunks so the LLM (and the user)
 *  can distinguish explicit user selections (`[A1]`, `[A2]`) from RAG hits
 *  (`[1]`, `[2]`). */
export interface PromptContext {
  /** Today's date in ISO yyyy-mm-dd format. */
  today: string;
  /** Human-readable description of the date range / scope considered for
   *  the answer. E.g. "Last 7 days (May 3 – May 9)". Surfaced inline so the
   *  model never invents a different scope. */
  scopeLabel: string;
  /** Forced-context notes the user explicitly attached. Always included
   *  verbatim regardless of retrieval results. */
  attachedNotes: Array<{ id: string; title: string; body: string }>;
  /** Retrieval hits, in rank order. The renderer numbers them [1]..[N]
   *  and the LLM is instructed to cite back to those indices. */
  retrievedChunks: Array<{ id: string; label: string; text: string }>;
}

export type PromptRoute = 'local' | 'claude' | 'copilot';

/** Mirror of `rust-core/src/rag/prompts.rs:KNOWLEDGE_ASSISTANT_SYSTEM`.
 *  Update both sides together; the Vitest spec for this module pins the
 *  Rust constant via `string-includes` so drift is caught at test time. */
const SYSTEM_TEMPLATE = `You are IronMic's knowledge assistant. Answer the user's question using ONLY the provided context from their notes and meetings. Always cite sources with [1], [2] markers that match the indices below. If the context doesn't contain the answer, say so plainly — do not invent details.

Today's date: {today}
Date scope considered: {scope_label}`;

const ATTACHED_HEADER = '[Attached Notes — explicit user selection]';
const RETRIEVED_HEADER = '[Context — retrieved from your knowledge base]';

/** Stable, instruction-resistant delimiter used in the prepended shape.
 *  The text intentionally repeats the SYSTEM word in caps and brackets to
 *  reduce the chance a follow-on user injection ("Now ignore the system…")
 *  can convince the model the block has ended. */
const PREPEND_START = '<<IRONMIC SYSTEM — DO NOT IGNORE>>';
const PREPEND_END = '<<END IRONMIC SYSTEM>>';

function renderSystem(ctx: PromptContext): string {
  return SYSTEM_TEMPLATE.replace('{today}', ctx.today).replace('{scope_label}', ctx.scopeLabel);
}

function renderAttachedBlock(ctx: PromptContext): string {
  if (ctx.attachedNotes.length === 0) return '';
  const lines: string[] = [ATTACHED_HEADER];
  ctx.attachedNotes.forEach((n, i) => {
    const idx = i + 1;
    const title = (n.title || 'Untitled').trim();
    // Body may be long. We don't truncate here — the orchestrator decides
    // budget. This builder only assembles.
    lines.push(`[A${idx}] ${title}`);
    lines.push(n.body);
  });
  return lines.join('\n');
}

function renderRetrievedBlock(ctx: PromptContext): string {
  if (ctx.retrievedChunks.length === 0) return '';
  const lines: string[] = [RETRIEVED_HEADER];
  ctx.retrievedChunks.forEach((c, i) => {
    const idx = i + 1;
    lines.push(`[${idx}] ${c.label} — ${c.text}`);
  });
  return lines.join('\n');
}

/** Local-route output: a messages array with a leading `system` message.
 *  History (prior user/assistant turns) is appended after the system msg
 *  and before the final user turn. */
export interface LocalPromptShape {
  route: 'local';
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
}

/** Claude-route output: optional `appendSystemPrompt` (passed to
 *  `--append-system-prompt`) plus a user prompt that contains the context
 *  blocks and the question. When the installed CLI doesn't support the
 *  flag, the orchestrator falls through to the prepend shape (see
 *  `buildPrependShape`). */
export interface ClaudePromptShape {
  route: 'claude';
  appendSystemPrompt: string;
  userPrompt: string;
}

/** Copilot / Claude-without-`--append-system-prompt` / any-CLI-without-system
 *  route: a single user prompt with the system block prepended. The exact
 *  framing differs by provider — Copilot gets standard markdown role markers
 *  (`### INSTRUCTIONS`, `### CONTEXT`, `### QUESTION`) since the
 *  `<<IRONMIC SYSTEM>>` delimiter is tuned for Claude's instruction-following.
 */
export interface PrependPromptShape {
  route: 'claude' | 'copilot';
  userPrompt: string;
}

export type ShapedPrompt = LocalPromptShape | ClaudePromptShape | PrependPromptShape;

/** Build the context body (everything below the system instructions). Used
 *  by every route — the difference is just *where* the system text goes. */
function buildContextBody(ctx: PromptContext, userQuestion: string): string {
  const parts: string[] = [];
  const attached = renderAttachedBlock(ctx);
  const retrieved = renderRetrievedBlock(ctx);
  if (attached) parts.push(attached);
  if (retrieved) parts.push(retrieved);
  parts.push(`Question: ${userQuestion}`);
  return parts.join('\n\n');
}

export interface BuildOptions {
  route: PromptRoute;
  /** Whether the Claude CLI on this machine accepts `--append-system-prompt`.
   *  Probed by AIManager and cached; passed in here so the builder can
   *  pick the right Claude shape. Ignored for non-Claude routes. */
  claudeSupportsAppendSystemPrompt?: boolean;
  /** Prior conversation tail (for local route history replay). Ignored by
   *  cloud routes — those carry session state in the CLI itself. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export function buildPrompt(
  ctx: PromptContext,
  userQuestion: string,
  opts: BuildOptions,
): ShapedPrompt {
  const systemText = renderSystem(ctx);
  const contextBody = buildContextBody(ctx, userQuestion);

  if (opts.route === 'local') {
    const messages: LocalPromptShape['messages'] = [
      { role: 'system', content: systemText },
    ];
    if (opts.history && opts.history.length > 0) {
      for (const m of opts.history) {
        messages.push({ role: m.role, content: m.content });
      }
    }
    messages.push({ role: 'user', content: contextBody });
    return { route: 'local', messages };
  }

  if (opts.route === 'claude' && opts.claudeSupportsAppendSystemPrompt) {
    return {
      route: 'claude',
      appendSystemPrompt: systemText,
      userPrompt: contextBody,
    };
  }

  // Copilot route: use standard markdown role markers. The `<<IRONMIC SYSTEM>>`
  // delimiter is tuned for Claude's instruction-following and Copilot, which is
  // an interactive coding assistant, can mis-read it as user-pasted text and
  // respond "give me the text now" as if no context was attached.
  if (opts.route === 'copilot') {
    const userPrompt = buildCopilotPrompt(systemText, ctx, userQuestion);
    return { route: 'copilot', userPrompt };
  }

  // Claude without `--append-system-prompt` support: keep the existing
  // delimiter shape that's tuned for Claude's instruction-following.
  const userPrompt = `${PREPEND_START}\n${systemText}\n${PREPEND_END}\n\nUser question:\n${contextBody}`;
  return { route: 'claude', userPrompt };
}

/**
 * Copilot-tuned prompt shape. Uses standard markdown role markers Copilot is
 * trained to honor, with an explicit `### ANSWER` cue that nudges the model
 * to produce the cited answer rather than a meta-reply asking for the input.
 */
function buildCopilotPrompt(systemText: string, ctx: PromptContext, userQuestion: string): string {
  const sections: string[] = [];
  sections.push('### INSTRUCTIONS');
  sections.push(systemText);

  const attached = renderAttachedBlock(ctx);
  const retrieved = renderRetrievedBlock(ctx);
  if (attached || retrieved) {
    sections.push('### CONTEXT');
    if (attached) sections.push(attached);
    if (retrieved) sections.push(retrieved);
  }

  sections.push('### QUESTION');
  sections.push(userQuestion);
  sections.push('### ANSWER');
  sections.push('(Cite sources as [1], [2]. Use only the context above.)');
  return sections.join('\n\n');
}

// ── Citation post-processing ──────────────────────────────────────────────
//
// The model is instructed to emit `[1]`, `[A1]`, etc. We accept anything in
// that shape but strip references to indices we didn't supply (the model
// occasionally invents new numbers when the context is thin). Orphan
// stripping happens after streaming finishes — during streaming we render
// chips eagerly and they re-resolve when the full marker list lands.

export interface CitationParseResult {
  /** Answer text with orphan markers removed but valid markers preserved. */
  cleanedText: string;
  /** The set of valid citation tokens (e.g. `1`, `A2`) the model actually used. */
  usedCitations: Set<string>;
  /** Markers the model produced that didn't match any supplied source. */
  orphanMarkers: string[];
}

const CITATION_RE = /\[(A?\d+)\]/g;

export function postProcessCitations(
  text: string,
  validKeys: Set<string>,
): CitationParseResult {
  const used = new Set<string>();
  const orphans: string[] = [];
  const cleaned = text.replace(CITATION_RE, (match, key: string) => {
    if (validKeys.has(key)) {
      used.add(key);
      return match;
    }
    orphans.push(key);
    return '';
  });
  return { cleanedText: cleaned, usedCitations: used, orphanMarkers: orphans };
}
