//! Template prompt constants used by the v10 schema migration.
//!
//! `V4_*` constants are the verbatim strings seeded by migration v4 at
//! [crate::storage::db::seed_builtin_templates] (db.rs:702, 710, 718,
//! 726, 734). They MUST stay byte-identical to those literals — they're
//! the equality guard for the conditional UPDATE in migrate_v10. If a
//! user customized a builtin template's prompt in the UI, their value
//! won't match V4_* and the UPDATE will skip them.
//!
//! `V10_*` constants are the upgraded prompts that replace the v4
//! baselines. They emit richer markdown (bold names/decisions, action
//! item tables, inline code for technical refs) but keep the same
//! `## Section` heading scheme so [parseSections] in the renderer
//! continues to work without changes.
//!
//! `AUTO_*` constants seed the new `builtin-auto` template that becomes
//! the default for fresh installs and for users whose
//! `meeting_default_template` is still the v4 empty-string sentinel.

// ──────────────────────────────────────────────────────────────────────────
// V4 baselines — verbatim copies from seed_builtin_templates.
// Do NOT change a single character; these are equality guards.
// ──────────────────────────────────────────────────────────────────────────

pub const V4_STANDUP_PROMPT: &str = "You are a meeting notes assistant. Given the following meeting transcript, extract a structured standup summary.\n\nRules:\n- Extract what was completed yesterday into the \"Completed\" section\n- Extract what is being worked on today into the \"In Progress\" section\n- Extract any blockers or issues into the \"Blockers\" section\n- Use bullet points for each item\n- Keep items concise (1-2 sentences each)\n- If a section has no items, write \"None mentioned\"\n- Output ONLY the structured sections, no preamble\n\nFormat:\n## Completed\n- ...\n\n## In Progress\n- ...\n\n## Blockers\n- ...\n\nTranscript:\n{transcript}";

pub const V4_1ON1_PROMPT: &str = "You are a meeting notes assistant. Given the following 1-on-1 meeting transcript, extract structured notes.\n\nRules:\n- Extract main discussion topics into \"Discussion Points\"\n- Extract any agreed-upon action items with owners into \"Action Items\"\n- Extract any feedback given or received into \"Feedback\"\n- Use bullet points for each item\n- Keep items concise but include enough context to be actionable\n- If a section has no items, write \"None mentioned\"\n- Output ONLY the structured sections, no preamble\n\nFormat:\n## Discussion Points\n- ...\n\n## Action Items\n- ...\n\n## Feedback\n- ...\n\nTranscript:\n{transcript}";

pub const V4_DISCOVERY_PROMPT: &str = "You are a meeting notes assistant. Given the following discovery call transcript, extract structured notes.\n\nRules:\n- Extract pain points and problems the prospect described into \"Pain Points\"\n- Extract specific requirements, needs, or desired features into \"Requirements\"\n- Extract agreed-upon next steps into \"Next Steps\"\n- Extract any mentions of budget, timeline, or decision process into \"Budget & Timeline\"\n- Use bullet points for each item\n- Include relevant quotes when they capture the prospect's voice\n- If a section has no items, write \"None mentioned\"\n- Output ONLY the structured sections, no preamble\n\nFormat:\n## Pain Points\n- ...\n\n## Requirements\n- ...\n\n## Next Steps\n- ...\n\n## Budget & Timeline\n- ...\n\nTranscript:\n{transcript}";

pub const V4_TEAM_SYNC_PROMPT: &str = "You are a meeting notes assistant. Given the following team sync meeting transcript, extract structured notes.\n\nRules:\n- Extract status updates from team members into \"Updates\"\n- Extract any decisions that were made into \"Decisions\"\n- Extract action items with owners and deadlines into \"Action Items\"\n- Extract unresolved questions or topics needing follow-up into \"Open Questions\"\n- Use bullet points for each item\n- Attribute updates to speakers when possible\n- If a section has no items, write \"None mentioned\"\n- Output ONLY the structured sections, no preamble\n\nFormat:\n## Updates\n- ...\n\n## Decisions\n- ...\n\n## Action Items\n- ...\n\n## Open Questions\n- ...\n\nTranscript:\n{transcript}";

pub const V4_RETRO_PROMPT: &str = "You are a meeting notes assistant. Given the following retrospective meeting transcript, extract structured notes.\n\nRules:\n- Extract things that went well into \"Went Well\"\n- Extract things that need improvement into \"Needs Improvement\"\n- Extract concrete action items to improve into \"Action Items\"\n- Use bullet points for each item\n- Group related items together\n- If a section has no items, write \"None mentioned\"\n- Output ONLY the structured sections, no preamble\n\nFormat:\n## Went Well\n- ...\n\n## Needs Improvement\n- ...\n\n## Action Items\n- ...\n\nTranscript:\n{transcript}";

// ──────────────────────────────────────────────────────────────────────────
// V10 replacements — upgraded prompts with richer formatting.
// Same `## Section` headings as v4 so the renderer's parseSections still
// recognizes the output. Adds bold for names/decisions/deadlines, inline
// code for technical refs, and an action-items table where applicable.
// ──────────────────────────────────────────────────────────────────────────

pub const V10_STANDUP_PROMPT: &str = "You are a meeting notes assistant. Given the following standup meeting transcript, produce a structured summary in markdown.\n\nRules:\n- Extract what was completed since the last standup into \"Completed\"\n- Extract what is being worked on now into \"In Progress\"\n- Extract any blockers or issues into \"Blockers\"\n- **Bold** names of people when attributing updates (e.g. **Alice** finished…)\n- Use `inline code` for file/function/PR/JIRA references\n- Use bullet points; keep each item to 1–2 sentences\n- If a section has no items, write \"None mentioned\"\n- Output ONLY the structured sections — no preamble, no closing notes\n\nFormat:\n## Completed\n- ...\n\n## In Progress\n- ...\n\n## Blockers\n- ...\n\nTranscript:\n{transcript}";

pub const V10_1ON1_PROMPT: &str = "You are a meeting notes assistant. Given the following 1-on-1 meeting transcript, produce structured notes in markdown.\n\nRules:\n- Extract main topics into \"Discussion Points\"\n- Extract agreed action items into \"Action Items\" — render as a markdown table with columns Owner | Item | Due (omit Due if not stated)\n- Extract feedback given or received into \"Feedback\"\n- **Bold** names, decisions, and deadlines in context\n- Use `inline code` for file/function/PR/JIRA references\n- Use bullets where lists are natural; paragraphs where conversational\n- If a section has no items, write \"None mentioned\"\n- Output ONLY the structured sections — no preamble\n\nFormat:\n## Discussion Points\n- ...\n\n## Action Items\n| Owner | Item | Due |\n| --- | --- | --- |\n| ... | ... | ... |\n\n## Feedback\n- ...\n\nTranscript:\n{transcript}";

pub const V10_DISCOVERY_PROMPT: &str = "You are a meeting notes assistant. Given the following discovery call transcript, produce structured notes in markdown.\n\nRules:\n- Extract pain points the prospect described into \"Pain Points\"\n- Extract specific requirements / desired features into \"Requirements\"\n- Extract agreed next steps into \"Next Steps\" — render as a markdown table with Owner | Item | Due (omit Due if not stated)\n- Extract budget, timeline, or decision-process mentions into \"Budget & Timeline\"\n- **Bold** the prospect's company name, key stakeholders, and any commitments\n- Use `> blockquote` for direct quotes that capture the prospect's voice\n- If a section has no items, write \"None mentioned\"\n- Output ONLY the structured sections — no preamble\n\nFormat:\n## Pain Points\n- ...\n\n## Requirements\n- ...\n\n## Next Steps\n| Owner | Item | Due |\n| --- | --- | --- |\n| ... | ... | ... |\n\n## Budget & Timeline\n- ...\n\nTranscript:\n{transcript}";

pub const V10_TEAM_SYNC_PROMPT: &str = "You are a meeting notes assistant. Given the following team sync transcript, produce structured notes in markdown.\n\nRules:\n- Extract status updates per team member into \"Updates\" — attribute with **Bold name** prefix\n- Extract decisions into \"Decisions\" — prefix each with **Decided:**\n- Extract action items into \"Action Items\" — render as a markdown table with Owner | Item | Due (omit Due if not stated)\n- Extract unresolved follow-ups into \"Open Questions\"\n- Use `inline code` for file/function/PR/JIRA references\n- If a section has no items, write \"None mentioned\"\n- Output ONLY the structured sections — no preamble\n\nFormat:\n## Updates\n- **Name** — update text\n\n## Decisions\n- **Decided:** ...\n\n## Action Items\n| Owner | Item | Due |\n| --- | --- | --- |\n| ... | ... | ... |\n\n## Open Questions\n- ...\n\nTranscript:\n{transcript}";

pub const V10_RETRO_PROMPT: &str = "You are a meeting notes assistant. Given the following retrospective transcript, produce structured notes in markdown.\n\nRules:\n- Extract things that went well into \"Went Well\"\n- Extract things needing improvement into \"Needs Improvement\"\n- Extract concrete improvements into \"Action Items\" — render as a markdown table with Owner | Item | Due (omit Due if not stated)\n- **Bold** names when attributing observations\n- Group related items under sub-points\n- If a section has no items, write \"None mentioned\"\n- Output ONLY the structured sections — no preamble\n\nFormat:\n## Went Well\n- ...\n\n## Needs Improvement\n- ...\n\n## Action Items\n| Owner | Item | Due |\n| --- | --- | --- |\n| ... | ... | ... |\n\nTranscript:\n{transcript}";

// ──────────────────────────────────────────────────────────────────────────
// New "Auto" template — the default for users without a preference.
// Detects meeting type from transcript signals and tailors the layout per
// type. Action items always render as a markdown table.
// ──────────────────────────────────────────────────────────────────────────

/// User-facing name. The internal id stays `builtin-auto` for back-compat
/// with the v10 migration that already seeded it; we just rename the label.
pub const AUTO_TEMPLATE_NAME: &str = "Default";
pub const AUTO_TEMPLATE_TYPE: &str = "auto";

/// Sections list for the default template. The renderer's parseSections
/// only cares about ## headings present in the LLM output — the section
/// keys here are the canonical superset for the simplified layout.
pub const AUTO_TEMPLATE_SECTIONS: &str = r#"["tldr","decisions","discussion","action_items","open_questions"]"#;

pub const AUTO_TEMPLATE_LAYOUT: &str = r#"{"order":["tldr","decisions","discussion","action_items","open_questions"]}"#;

/// The v10 baseline prompt for `builtin-auto`. Kept verbatim so the v11
/// migration's equality-guarded UPDATE can recognize and overwrite v10-
/// installed prompts without touching user customizations. Once v11 has
/// run, this constant is dead — leave it as a historical reference.
pub const V10_AUTO_TEMPLATE_PROMPT: &str = "You are a professional meeting notes assistant. Given the following meeting transcript, produce well-formatted structured notes in markdown.\n\nSTEP 1 — Detect the meeting type from the transcript:\n- STANDUP: short per-person updates, yesterday/today/blockers pattern\n- CODE_REVIEW: PR refs, file/function names, technical decisions, debate\n- PLANNING: scope, timelines, owners, milestones\n- ONE_ON_ONE: two speakers, feedback, career, longer reflections\n- RETRO: \"went well / needs improvement / improvements\" framing\n- DISCOVERY: prospect pain points, requirements, budget, timeline\n- TEAM_SYNC: status updates, decisions, action items, open questions\n- GENERIC: doesn't match any of the above\n\nSTEP 2 — Produce sections per the detected type. Always lead with `## TL;DR` (one or two sentences). Action items, when present, render as a markdown table:\n| Owner | Item | Due |\n| --- | --- | --- |\nOmit the Due column entry when not stated.\n\nLayouts (only emit the sections that have content):\n\n- STANDUP → `## TL;DR` + `### {Name}` per speaker with **Done**/**Doing**/**Blocked** bolded inline\n- CODE_REVIEW → `## TL;DR` + `## Decisions` (each prefixed `**Decided:**`) + `## Open Questions` + `## Action Items` table\n- PLANNING → `## TL;DR` + `## Scope` + `## Milestones` (dates **bolded**) + `## Owners` + `## Risks` + `## Action Items` table\n- ONE_ON_ONE → `## TL;DR` + `## Discussion` + `## Feedback` + `## Action Items` table + `## Follow-ups`\n- RETRO → `## TL;DR` + `## Went Well` + `## Needs Improvement` + `## Action Items` table\n- DISCOVERY → `## TL;DR` + `## Pain Points` + `## Requirements` + `## Budget & Timeline` + `## Next Steps` table\n- TEAM_SYNC → `## TL;DR` + `## Updates` (per-person, **Name** prefix) + `## Decisions` (`**Decided:**` prefix) + `## Action Items` table + `## Open Questions`\n- GENERIC → `## TL;DR` + `## Discussion` + `## Decisions` + `## Action Items` table + `## Open Questions`\n\nFORMATTING RULES:\n- **Bold** names, decisions, deadlines, owners\n- Use `inline code` for file/function/PR/JIRA/command references\n- Use `> blockquote` for direct quotes\n- Use professional vocabulary: \"blockers\", \"action items\", \"deliverables\", \"stakeholders\", \"scope\", \"timeline\"\n\nHARD RULES (priority order):\n1. Stay grounded in the transcript — every claim must be traceable to what was said\n2. Never invent participants, dates, numbers, or facts\n3. If the transcript is too thin to summarize meaningfully, output exactly: [INSUFFICIENT_CONTENT]\n4. Output ONLY markdown — no preamble (\"Here are the notes:\"), no closing remarks\n\nTranscript:\n{transcript}";

/// V10's auto-template name, kept for the equality guard.
pub const V10_AUTO_TEMPLATE_NAME: &str = "Auto (smart format)";

/// V10 sections list — kept for the equality guard so v11 only overwrites
/// when the row matches the v10 baseline byte-for-byte.
pub const V10_AUTO_TEMPLATE_SECTIONS: &str = r#"["tldr","decisions","action_items","open_questions","discussion","feedback","follow_ups","went_well","improve","scope","milestones","owners","risks","pain_points","requirements","next_steps","budget_timeline","updates"]"#;

/// V10 layout — kept for the equality guard.
pub const V10_AUTO_TEMPLATE_LAYOUT: &str = r#"{"order":["tldr","decisions","discussion","action_items","open_questions","feedback","follow_ups","went_well","improve","scope","milestones","owners","risks","pain_points","requirements","next_steps","budget_timeline","updates"]}"#;

/// Default template prompt — simplified from the prior multi-layout
/// auto-detect version. The earlier prompt asked the local Phi-3-mini-Q2_K
/// to (a) classify the meeting type into one of 8 buckets, then (b)
/// produce a layout from a per-bucket spec — too much instruction-
/// following for the small model, which often bailed out with the
/// `[INSUFFICIENT_CONTENT]` escape hatch on perfectly good transcripts.
///
/// Now: one fixed layout. Sections are emitted only when they have
/// content. Cloud models do well with this; local models do too because
/// the instructions fit in a few hundred tokens. No `[INSUFFICIENT_CONTENT]`
/// escape hatch — if the transcript is genuinely empty, the upstream
/// `wordCount(trimmed) < MIN_WORDS_FOR_SUMMARY` guard already short-
/// circuits to `processingState: 'empty'` before this prompt runs.
pub const AUTO_TEMPLATE_PROMPT: &str = "You are a professional meeting notes assistant. Given the meeting transcript below, produce well-structured markdown notes.\n\nLAYOUT — emit only the sections that have content:\n\n## TL;DR\nOne or two sentences capturing the meeting in plain language.\n\n## Decisions\n- **Decided:** what was agreed (one bullet per decision)\n\n## Discussion\nBrief paragraph(s) or bullets covering main topics. Use ### sub-headings if there are multiple distinct topics.\n\n## Action Items\nMarkdown table with columns Owner | Item | Due (omit Due cell if not stated):\n| Owner | Item | Due |\n| --- | --- | --- |\n\n## Open Questions\n- Bullets for unresolved follow-ups\n\nFORMATTING:\n- **Bold** names, decisions, deadlines, owners, totals\n- Use `inline code` for file/function/PR/JIRA refs\n- Use professional vocabulary: \"blockers\", \"action items\", \"deliverables\", \"stakeholders\"\n\nHARD RULES:\n- Stay grounded in the transcript — every claim must trace to what was said\n- Never invent participants, dates, numbers, or facts\n- Skip sections with no content (don't write \"None mentioned\" or empty headings)\n- Output ONLY the markdown sections — no preamble (\"Here are the notes:\"), no closing remarks\n\nTranscript:\n{transcript}";
