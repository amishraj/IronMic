//! Knowledge Q&A (RAG) layer — chunking, retrieval, and prompt assembly.
//!
//! Module map:
//!   - `chunker`   — carves `chunks` rows out of entries, meetings, and notes
//!   - `intent`    — classifies user queries (temporal / topic / cross-doc / single-doc)
//!   - `hybrid_search` — pre-filter → FTS5 + vector → RRF merge
//!   - `vector`    — flat SIMD cosine over the active model's chunk embeddings
//!   - `prompts`   — shared system-prompt templates with the citation contract
//!
//! Embedding *inference* deliberately does not live here. The renderer-side
//! `BgeEmbedder` (ONNX Runtime Web) is the one place a query or chunk is
//! turned into a vector; Rust accepts vectors as bytes from N-API callers
//! and never reaches for a model itself. That keeps the Rust core's
//! dependency tree small and matches the offline-only promise.

pub mod chunker;
pub mod hybrid_search;
pub mod intent;
pub mod prompts;
pub mod vector;
