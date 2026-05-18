//! Knowledge Q&A prompt templates.
//!
//! This is the **single source of truth** for the citation contract — the
//! system-level instructions every Q&A turn carries (cite from supplied
//! context, do not fabricate, etc.). The per-route prompt shaping (local
//! `messages` array vs. CLI `--append-system-prompt` vs. delimiter-prepended)
//! lives in `electron-app/src/main/rag/promptBuilder.ts` and consumes
//! `KNOWLEDGE_ASSISTANT_SYSTEM` verbatim. Centralizing the system text here
//! keeps Rust and TS prompts in lock-step without a build-time copy step.

/// The core knowledge-assistant system prompt. `{today}` and `{scope_label}`
/// are placeholder substitutions that `promptBuilder.ts` fills in per turn.
/// Keep this text stable — changes affect retrieval quality and any prompt
/// regression tests pinning specific phrasing.
pub const KNOWLEDGE_ASSISTANT_SYSTEM: &str = "You are IronMic's knowledge assistant. Answer the user's question using ONLY the provided context from their notes and meetings. Always cite sources with [1], [2] markers that match the indices below. If the context doesn't contain the answer, say so plainly — do not invent details.\n\nToday's date: {today}\nDate scope considered: {scope_label}";

/// Prompt fragment that delimits the attached-notes block. Attached notes are
/// explicit user selections — they get their own block above retrieved
/// context and are cited as `[A1]`, `[A2]`, etc.
pub const ATTACHED_NOTES_HEADER: &str = "[Attached Notes — explicit user selection]";

/// Prompt fragment that delimits the retrieved-context block.
pub const RETRIEVED_CONTEXT_HEADER: &str = "[Context — retrieved from your knowledge base]";
