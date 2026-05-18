//! Query intent classification.
//!
//! Routes free-form natural-language queries into one of four intents so the
//! retrieval layer can pick the right strategy:
//!
//! - **Temporal** — "last week's meetings", "yesterday", date ranges.
//!   Pure metadata filter; skip vector search entirely.
//! - **SingleDoc** — "what did Sarah say in Tuesday's standup?".
//!   Filter by speaker / title; return all matching chunks in order.
//! - **CrossDoc** — "prep for sprint planning", multi-clause requests.
//!   Two-stage retrieval: scope first, then topic within scope.
//! - **Topic** — everything else. Hybrid FTS5 + vector with RRF.
//!
//! The classifier is deliberately rule-based — regex + chrono date parsing.
//! That gets us ~80% accuracy with zero training data and no per-call ML
//! cost. A learned classifier can layer on later (intent_training_samples
//! is already in the schema) without changing this surface.

use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum IntentClass {
    Temporal,
    SingleDoc,
    CrossDoc,
    Topic,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct IntentFilters {
    /// ISO-8601 timestamp lower bound (inclusive). When set, retrieval only
    /// considers content whose source's created_at is >= this.
    pub date_from: Option<String>,
    /// ISO-8601 timestamp upper bound (inclusive).
    pub date_to: Option<String>,
    /// When the query names a speaker, the chunker's `speaker_label` filter.
    pub speaker: Option<String>,
    /// When the query references a meeting/note title by quoted name or by
    /// "from the X meeting" pattern. Surfaced as a SQL `LIKE` glob.
    pub title_glob: Option<String>,
    /// When the user constrains the source space ("in my notes only").
    pub source_types: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntentResult {
    pub intent: IntentClass,
    pub filters: IntentFilters,
    /// Human-readable label the UI surfaces above the answer
    /// ("Considering 4 meetings from May 5–9"). Built here because the
    /// classifier is the only thing that knows what scope it picked.
    pub scope_label: String,
}

/// Classify a query against a "now" timestamp (typically `Utc::now()`).
/// Pure function — no state, no side effects, fully testable.
pub fn classify(query: &str, now: DateTime<Utc>) -> IntentResult {
    let q = query.trim();
    let lower = q.to_lowercase();
    let mut filters = IntentFilters::default();
    let mut intent = IntentClass::Topic;
    let mut scope_label = String::from("All time");

    // ── Temporal detection ────────────────────────────────────────────────
    //
    // We accept several common shapes:
    //   "last week", "this week", "past week"
    //   "last N days", "past N days", "in the last N days"
    //   "last month", "this month"
    //   "yesterday", "today"
    //   "since YYYY-MM-DD"
    //
    // The first match wins (specific over general). Each branch sets
    // both the filter range and a human-readable label.

    if let Some((from, to, label)) = parse_temporal_phrase(&lower, now) {
        filters.date_from = Some(from.to_rfc3339());
        filters.date_to = Some(to.to_rfc3339());
        scope_label = label;
        intent = IntentClass::Temporal;
    }

    // ── Single-doc detection ──────────────────────────────────────────────
    //
    // "what did <Name> say" → speaker filter
    // "in <title>" or "from <title>" where title is quoted → title_glob
    //
    // We only flip the intent to SingleDoc if temporal didn't already win —
    // a query like "what did Sarah say last week" is fundamentally temporal
    // with a speaker filter, not a single-doc lookup.
    if let Some(speaker) = parse_speaker(q) {
        filters.speaker = Some(speaker);
        if intent != IntentClass::Temporal {
            intent = IntentClass::SingleDoc;
        }
    }
    if let Some(title) = parse_quoted_title(q) {
        filters.title_glob = Some(format!("%{}%", title));
        if intent != IntentClass::Temporal {
            intent = IntentClass::SingleDoc;
        }
    }

    // ── Cross-doc detection ──────────────────────────────────────────────
    //
    // Heuristic: phrases that suggest synthesis across multiple meetings —
    // "prep for", "summarize my", "what should I do next", "outstanding
    // action items". These need temporal scope + topical filter combined.
    //
    // Only triggers when we haven't already classified as Temporal or
    // SingleDoc — cross-doc is the "needs more than one trick" case.
    if intent == IntentClass::Topic {
        for needle in CROSS_DOC_PHRASES {
            if lower.contains(needle) {
                intent = IntentClass::CrossDoc;
                break;
            }
        }
    }

    IntentResult { intent, filters, scope_label }
}

const CROSS_DOC_PHRASES: &[&str] = &[
    "prep for",
    "prepare for",
    "preparing for",
    "summarize my",
    "summary of my",
    "outstanding action",
    "what's outstanding",
    "what should i",
    "help me get ready",
];

fn parse_temporal_phrase(lower: &str, now: DateTime<Utc>) -> Option<(DateTime<Utc>, DateTime<Utc>, String)> {
    // Simple absolute keywords first.
    if lower.contains("yesterday") {
        let yesterday = now - Duration::days(1);
        let start = day_start(yesterday);
        let end = day_end(yesterday);
        return Some((start, end, "Yesterday".into()));
    }
    if lower.contains("today") {
        return Some((day_start(now), day_end(now), "Today".into()));
    }

    // "last/past/this week"
    if lower.contains("last week") || lower.contains("past week") {
        let end = now;
        let start = now - Duration::days(7);
        return Some((start, end, format!("Last 7 days ({} – {})", short_date(start), short_date(end))));
    }
    if lower.contains("this week") {
        let start = now - Duration::days(now.weekday().num_days_from_monday() as i64);
        let end = now;
        return Some((day_start(start), end, format!("This week (since {})", short_date(start))));
    }
    if lower.contains("last month") || lower.contains("past month") {
        let start = now - Duration::days(30);
        let end = now;
        return Some((start, end, format!("Last 30 days ({} – {})", short_date(start), short_date(end))));
    }
    if lower.contains("this month") {
        // Approximation: 1st of current month → now.
        let start = now.with_day(1).unwrap_or(now);
        return Some((day_start(start), now, format!("This month (since {})", short_date(start))));
    }

    // "last N days" / "past N days" / "N day(s) ago"
    if let Some(n) = parse_n_days(lower) {
        let start = now - Duration::days(n as i64);
        return Some((start, now, format!("Last {} day{} ({} – {})", n, if n == 1 { "" } else { "s" }, short_date(start), short_date(now))));
    }

    // "since YYYY-MM-DD"
    if let Some(d) = parse_since(lower) {
        let start = day_start_from_naive(d);
        return Some((start, now, format!("Since {}", short_date(start))));
    }

    None
}

fn parse_n_days(lower: &str) -> Option<u32> {
    // Matches: "last 7 days", "past 14 days", "in the last 3 days".
    // Word-numbers ("last two days") deliberately not supported in v1 —
    // those add complexity for marginal gain; users typing precise queries
    // almost always type digits.
    let patterns: [&str; 4] = ["last ", "past ", "in the last ", "in the past "];
    for p in patterns {
        if let Some(start) = lower.find(p) {
            let tail = &lower[start + p.len()..];
            let chars = tail.chars();
            let mut num_str = String::new();
            for c in chars {
                if c.is_ascii_digit() {
                    num_str.push(c);
                } else if !num_str.is_empty() {
                    break;
                } else if c == ' ' {
                    continue;
                } else {
                    break;
                }
            }
            if !num_str.is_empty() && (tail.contains("day") || tail.contains("week")) {
                if let Ok(n) = num_str.parse::<u32>() {
                    // Treat "N weeks" as 7N days for the filter.
                    let multiplier = if tail.split_whitespace().any(|w| w.starts_with("week")) {
                        7
                    } else {
                        1
                    };
                    return Some(n.saturating_mul(multiplier));
                }
            }
        }
    }
    None
}

fn parse_since(lower: &str) -> Option<NaiveDate> {
    // Matches "since YYYY-MM-DD". Strict ISO format only; loose date parsing
    // is a known footgun (ambiguity around DD/MM vs MM/DD).
    let needle = "since ";
    let start = lower.find(needle)?;
    let tail = &lower[start + needle.len()..];
    // Take the first 10 chars and try to parse as YYYY-MM-DD.
    let candidate: String = tail.chars().take(10).collect();
    NaiveDate::parse_from_str(&candidate, "%Y-%m-%d").ok()
}

/// Crude name extraction. Matches `what did <Name(s)> say` where Name is
/// any sequence of capitalized words. False-positive risk is real
/// ("what did Project X say") so we keep this opt-in via the explicit
/// "what did … say" trigger phrase rather than a broader heuristic.
fn parse_speaker(query: &str) -> Option<String> {
    let lower = query.to_lowercase();
    let trigger = "what did ";
    let trail = " say";
    let start = lower.find(trigger)?;
    let after = &query[start + trigger.len()..];
    let lower_after = after.to_lowercase();
    let end = lower_after.find(trail)?;
    let name = after[..end].trim();
    if name.is_empty() {
        return None;
    }
    // Reject if the candidate isn't capitalized — "what did the alarm say"
    // shouldn't trigger.
    let first_char = name.chars().next()?;
    if !first_char.is_uppercase() {
        return None;
    }
    Some(name.to_string())
}

fn parse_quoted_title(query: &str) -> Option<String> {
    // Accept ASCII double-quote and curly quotes. First quoted span wins.
    let chars: Vec<char> = query.chars().collect();
    let mut in_quote = false;
    let mut start: usize = 0;
    let mut buf = String::new();
    for (i, c) in chars.iter().enumerate() {
        let is_quote = *c == '"' || *c == '\u{201C}' || *c == '\u{201D}' || *c == '\u{2018}' || *c == '\u{2019}';
        if is_quote {
            if !in_quote {
                in_quote = true;
                start = i;
                buf.clear();
            } else {
                if !buf.is_empty() {
                    return Some(buf);
                }
                in_quote = false;
                start = 0;
            }
        } else if in_quote {
            buf.push(*c);
        }
    }
    let _ = start;
    None
}

// ── Date helpers ──────────────────────────────────────────────────────────

fn day_start(dt: DateTime<Utc>) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(dt.year(), dt.month(), dt.day(), 0, 0, 0).single().unwrap_or(dt)
}

fn day_end(dt: DateTime<Utc>) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(dt.year(), dt.month(), dt.day(), 23, 59, 59).single().unwrap_or(dt)
}

fn day_start_from_naive(d: NaiveDate) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(d.year(), d.month(), d.day(), 0, 0, 0).single().unwrap_or_else(Utc::now)
}

fn short_date(dt: DateTime<Utc>) -> String {
    dt.format("%b %-d").to_string()
}

use chrono::Datelike;

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        // Fixed reference: Friday, May 9, 2026 13:00 UTC. Tests use this so
        // "last week" / "yesterday" math is deterministic.
        Utc.with_ymd_and_hms(2026, 5, 9, 13, 0, 0).unwrap()
    }

    #[test]
    fn topic_default_for_open_question() {
        let r = classify("What did we decide about the auth flow?", now());
        assert_eq!(r.intent, IntentClass::Topic);
        assert!(r.filters.date_from.is_none());
    }

    #[test]
    fn temporal_last_week() {
        let r = classify("Summarize my meetings from the past week", now());
        assert_eq!(r.intent, IntentClass::Temporal);
        assert!(r.filters.date_from.is_some());
        assert!(r.scope_label.contains("Last 7 days"));
    }

    #[test]
    fn temporal_yesterday() {
        let r = classify("What did I dictate yesterday?", now());
        assert_eq!(r.intent, IntentClass::Temporal);
        assert!(r.scope_label.contains("Yesterday"));
    }

    #[test]
    fn temporal_last_n_days() {
        let r = classify("Show me notes from the last 14 days", now());
        assert_eq!(r.intent, IntentClass::Temporal);
        assert!(r.scope_label.contains("Last 14 days"));
    }

    #[test]
    fn single_doc_what_did_x_say() {
        let r = classify("What did Sarah say in Tuesday's standup?", now());
        assert_eq!(r.intent, IntentClass::SingleDoc);
        assert_eq!(r.filters.speaker.as_deref(), Some("Sarah"));
    }

    #[test]
    fn temporal_wins_over_speaker_when_both_present() {
        // "Yesterday what did Bob say" → Temporal with a speaker filter.
        let r = classify("Yesterday what did Bob say about timing?", now());
        assert_eq!(r.intent, IntentClass::Temporal);
        assert_eq!(r.filters.speaker.as_deref(), Some("Bob"));
    }

    #[test]
    fn quoted_title_filter() {
        let r = classify("In \"Project X\" what did we decide?", now());
        assert_eq!(r.intent, IntentClass::SingleDoc);
        assert_eq!(r.filters.title_glob.as_deref(), Some("%Project X%"));
    }

    #[test]
    fn cross_doc_prep_for_sprint_planning() {
        let r = classify("Help me prep for the next sprint planning", now());
        assert_eq!(r.intent, IntentClass::CrossDoc);
    }

    #[test]
    fn speaker_lowercase_rejected() {
        // "what did the alarm say" should NOT trigger speaker filter.
        let r = classify("What did the alarm say?", now());
        assert!(r.filters.speaker.is_none());
        assert_eq!(r.intent, IntentClass::Topic);
    }

    #[test]
    fn since_iso_date() {
        let r = classify("Notes since 2026-04-01", now());
        assert_eq!(r.intent, IntentClass::Temporal);
        assert!(r.filters.date_from.is_some());
        assert!(r.scope_label.starts_with("Since"));
    }
}
