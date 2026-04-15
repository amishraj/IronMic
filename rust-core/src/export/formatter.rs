use crate::storage::entries::Entry;
use crate::storage::meetings::MeetingSession;

/// Format an entry as Markdown.
pub fn entry_to_markdown(entry: &Entry) -> String {
    let text = entry.polished_text.as_deref().unwrap_or(&entry.raw_transcript);
    let date = &entry.created_at;
    let duration = entry
        .duration_seconds
        .map(|d| format!("{:.0}s", d))
        .unwrap_or_default();

    let tags_line = entry
        .tags
        .as_deref()
        .filter(|t| !t.is_empty() && *t != "[]")
        .map(|t| {
            // Parse JSON array of tags
            let tags: Vec<String> = serde_json::from_str(t).unwrap_or_default();
            if tags.is_empty() {
                String::new()
            } else {
                format!("\n**Tags:** {}\n", tags.join(", "))
            }
        })
        .unwrap_or_default();

    let mut md = format!("# Dictation\n\n**Date:** {date}\n");
    if !duration.is_empty() {
        md.push_str(&format!("**Duration:** {duration}\n"));
    }
    md.push_str(&tags_line);
    md.push_str(&format!("\n---\n\n{text}\n"));
    md
}

/// Format an entry as plain text.
pub fn entry_to_plain_text(entry: &Entry) -> String {
    entry
        .polished_text
        .as_deref()
        .unwrap_or(&entry.raw_transcript)
        .to_string()
}

/// Format an entry as JSON (pretty-printed).
pub fn entry_to_json(entry: &Entry) -> String {
    serde_json::to_string_pretty(entry).unwrap_or_else(|_| "{}".to_string())
}

/// Format a meeting session as Markdown.
pub fn meeting_to_markdown(session: &MeetingSession) -> String {
    let mut md = format!("# Meeting Notes\n\n**Date:** {}\n", session.started_at);

    if let Some(duration) = session.total_duration_seconds {
        let mins = (duration / 60.0).round() as u32;
        md.push_str(&format!("**Duration:** {} min\n", mins));
    }
    if session.speaker_count > 0 {
        md.push_str(&format!("**Speakers:** {}\n", session.speaker_count));
    }
    if let Some(app) = &session.detected_app {
        md.push_str(&format!("**Source:** {}\n", app));
    }

    // If structured output exists (from template), use it directly (it's already markdown-formatted)
    if let Some(structured) = &session.structured_output {
        md.push_str(&format!("\n---\n\n{structured}\n"));
    } else {
        // Fall back to summary + action items
        if let Some(summary) = &session.summary {
            md.push_str(&format!("\n---\n\n## Summary\n\n{summary}\n"));
        }
        if let Some(items) = &session.action_items {
            md.push_str(&format!("\n## Action Items\n\n{items}\n"));
        }
    }

    md
}

/// Format a meeting session as JSON (pretty-printed).
pub fn meeting_to_json(session: &MeetingSession) -> String {
    serde_json::to_string_pretty(session).unwrap_or_else(|_| "{}".to_string())
}

/// Convert plain text to simple HTML for rich clipboard.
pub fn text_to_html(text: &str) -> String {
    let mut html = String::from("<div style=\"font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.6;\">");

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            html.push_str("<br>");
        } else if let Some(h1) = trimmed.strip_prefix("# ") {
            html.push_str(&format!("<h1>{}</h1>", escape_html(h1)));
        } else if let Some(h2) = trimmed.strip_prefix("## ") {
            html.push_str(&format!("<h2>{}</h2>", escape_html(h2)));
        } else if let Some(h3) = trimmed.strip_prefix("### ") {
            html.push_str(&format!("<h3>{}</h3>", escape_html(h3)));
        } else if let Some(li) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")) {
            html.push_str(&format!("<li>{}</li>", escape_html(li)));
        } else if trimmed == "---" {
            html.push_str("<hr>");
        } else if let Some(bold) = trimmed.strip_prefix("**").and_then(|s| s.strip_suffix("**")) {
            html.push_str(&format!("<p><strong>{}</strong></p>", escape_html(bold)));
        } else {
            // Handle inline bold markers
            let processed = process_inline_bold(&escape_html(trimmed));
            html.push_str(&format!("<p>{processed}</p>"));
        }
    }

    html.push_str("</div>");
    html
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn process_inline_bold(s: &str) -> String {
    let mut result = String::new();
    let mut rest = s;
    while let Some(start) = rest.find("**") {
        result.push_str(&rest[..start]);
        rest = &rest[start + 2..];
        if let Some(end) = rest.find("**") {
            result.push_str("<strong>");
            result.push_str(&rest[..end]);
            result.push_str("</strong>");
            rest = &rest[end + 2..];
        } else {
            result.push_str("**");
        }
    }
    result.push_str(rest);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_entry_to_markdown() {
        let entry = Entry {
            id: "test".to_string(),
            created_at: "2026-04-15T10:00:00Z".to_string(),
            updated_at: "2026-04-15T10:00:00Z".to_string(),
            raw_transcript: "hello world".to_string(),
            polished_text: Some("Hello, world.".to_string()),
            display_mode: "polished".to_string(),
            duration_seconds: Some(5.0),
            source_app: None,
            is_pinned: false,
            is_archived: false,
            tags: Some(r#"["work","meeting"]"#.to_string()),
        };
        let md = entry_to_markdown(&entry);
        assert!(md.contains("# Dictation"));
        assert!(md.contains("Hello, world."));
        assert!(md.contains("work, meeting"));
        assert!(md.contains("5s"));
    }

    #[test]
    fn test_entry_to_plain_text() {
        let entry = Entry {
            id: "test".to_string(),
            created_at: "2026-04-15T10:00:00Z".to_string(),
            updated_at: "2026-04-15T10:00:00Z".to_string(),
            raw_transcript: "raw text".to_string(),
            polished_text: None,
            display_mode: "raw".to_string(),
            duration_seconds: None,
            source_app: None,
            is_pinned: false,
            is_archived: false,
            tags: None,
        };
        assert_eq!(entry_to_plain_text(&entry), "raw text");
    }

    #[test]
    fn test_text_to_html() {
        let html = text_to_html("# Title\n\nHello **world**\n\n- item 1\n- item 2");
        assert!(html.contains("<h1>Title</h1>"));
        assert!(html.contains("<strong>world</strong>"));
        assert!(html.contains("<li>item 1</li>"));
    }

    #[test]
    fn test_meeting_to_markdown() {
        let session = MeetingSession {
            id: "test".to_string(),
            started_at: "2026-04-15T10:00:00Z".to_string(),
            ended_at: Some("2026-04-15T10:30:00Z".to_string()),
            speaker_count: 3,
            summary: Some("Discussed roadmap".to_string()),
            action_items: Some("- Ship v2\n- Review PR".to_string()),
            total_duration_seconds: Some(1800.0),
            entry_ids: None,
            template_id: None,
            structured_output: None,
            detected_app: None,
        };
        let md = meeting_to_markdown(&session);
        assert!(md.contains("# Meeting Notes"));
        assert!(md.contains("30 min"));
        assert!(md.contains("Discussed roadmap"));
        assert!(md.contains("Ship v2"));
    }
}
