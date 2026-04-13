use std::collections::HashMap;

use chrono::{Datelike, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use tracing::info;

use crate::error::IronMicError;
use crate::storage::db::Database;

/// Pre-computed daily analytics snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailySnapshot {
    pub date: String,
    pub word_count: u64,
    pub sentence_count: u64,
    pub entry_count: u64,
    pub total_duration_seconds: f64,
    pub unique_word_count: u64,
    pub avg_sentence_length: f64,
    pub avg_words_per_minute: f64,
    pub source_app_breakdown: Option<String>,
    pub top_words: Option<String>,
    pub computed_at: String,
}

/// Aggregated overview stats for a time period.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverviewStats {
    pub total_words: u64,
    pub total_sentences: u64,
    pub total_entries: u64,
    pub total_duration_seconds: f64,
    pub avg_words_per_minute: f64,
    pub unique_words: u64,
    pub avg_sentence_length: f64,
    pub period: String,
}

/// Topic breakdown stat.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopicStat {
    pub topic: String,
    pub entry_count: u64,
    pub word_count: u64,
    pub percentage: f64,
}

/// Per-topic-per-date trend data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopicTrend {
    pub date: String,
    pub topic: String,
    pub count: u64,
}

/// Streak information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreakInfo {
    pub current_streak: u32,
    pub longest_streak: u32,
    pub last_active_date: String,
}

/// Week-over-week productivity comparison.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductivityComparison {
    pub this_period_words: u64,
    pub prev_period_words: u64,
    pub change_percent: f64,
    pub period_label: String,
}

/// Vocabulary richness metrics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VocabularyRichness {
    pub ttr: f64,
    pub unique_count: u64,
    pub total_count: u64,
}

/// Common English stop words to exclude from "top words" analysis.
const STOP_WORDS: &[&str] = &[
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by",
    "from", "is", "it", "this", "that", "was", "are", "be", "have", "has", "had", "do", "does",
    "did", "will", "would", "could", "should", "may", "might", "can", "not", "no", "so", "if",
    "then", "than", "too", "very", "just", "about", "up", "out", "all", "been", "when", "who",
    "which", "where", "what", "how", "there", "their", "they", "them", "we", "us", "our", "you",
    "your", "he", "she", "his", "her", "its", "my", "me", "i", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "each", "some", "any", "more", "most", "other",
    "also", "only", "over", "such", "here", "am", "were", "being", "get", "got", "going", "go",
    "like", "well", "really", "know", "think", "thing", "things", "one", "two", "new", "now",
];

/// Count words in text.
fn count_words(text: &str) -> usize {
    text.split_whitespace().count()
}

/// Count sentences in text (split on sentence-ending punctuation).
fn count_sentences(text: &str) -> usize {
    if text.trim().is_empty() {
        return 0;
    }
    let count = text
        .chars()
        .filter(|c| *c == '.' || *c == '?' || *c == '!')
        .count();
    // At minimum 1 sentence if there's any text
    count.max(1)
}

/// Get word frequencies, excluding stop words.
fn word_frequencies(text: &str) -> HashMap<String, u64> {
    let mut freq: HashMap<String, u64> = HashMap::new();
    for word in text.split_whitespace() {
        let cleaned: String = word
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '\'' || *c == '-')
            .collect();
        let lower = cleaned.to_lowercase();
        if lower.len() < 2 || STOP_WORDS.contains(&lower.as_str()) {
            continue;
        }
        *freq.entry(lower).or_insert(0) += 1;
    }
    freq
}

/// Get unique word count from text.
fn unique_words(text: &str) -> usize {
    let mut set = std::collections::HashSet::new();
    for word in text.split_whitespace() {
        let lower: String = word
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '\'' || *c == '-')
            .collect::<String>()
            .to_lowercase();
        if !lower.is_empty() {
            set.insert(lower);
        }
    }
    set.len()
}

/// Analytics CRUD operations.
pub struct AnalyticsStore {
    db: Database,
}

impl AnalyticsStore {
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    /// Compute and upsert the daily snapshot for a given date (YYYY-MM-DD).
    pub fn compute_daily_snapshot(&self, date: &str) -> Result<DailySnapshot, IronMicError> {
        let conn = self.db.conn();

        // Fetch all entries for this date
        let mut stmt = conn
            .prepare(
                "SELECT raw_transcript, polished_text, duration_seconds, source_app
                 FROM entries
                 WHERE date(created_at) = ?1 AND is_archived = 0",
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare analytics query: {e}")))?;

        type EntryRow = (String, Option<String>, Option<f64>, Option<String>);
        let rows: Vec<EntryRow> = stmt
            .query_map([date], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<f64>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|e| IronMicError::Storage(format!("Failed to query entries: {e}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| IronMicError::Storage(format!("Failed to collect entries: {e}")))?;

        let entry_count = rows.len() as u64;
        let mut total_words: u64 = 0;
        let mut total_sentences: u64 = 0;
        let mut total_duration: f64 = 0.0;
        let mut all_text = String::new();
        let mut source_counts: HashMap<String, u64> = HashMap::new();
        let mut wpm_sum: f64 = 0.0;
        let mut wpm_count: u64 = 0;

        for (raw, polished, duration, source_app) in &rows {
            let text = polished.as_deref().unwrap_or(raw.as_str());
            let words = count_words(text) as u64;
            let sentences = count_sentences(text) as u64;

            total_words += words;
            total_sentences += sentences;
            all_text.push(' ');
            all_text.push_str(text);

            if let Some(d) = duration {
                total_duration += d;
                if *d > 0.0 {
                    wpm_sum += (words as f64) / (d / 60.0);
                    wpm_count += 1;
                }
            }

            if let Some(app) = source_app {
                if !app.is_empty() {
                    *source_counts.entry(app.clone()).or_insert(0) += 1;
                }
            }
        }

        let unique = unique_words(&all_text) as u64;
        let avg_sentence_length = if total_sentences > 0 {
            total_words as f64 / total_sentences as f64
        } else {
            0.0
        };
        let avg_wpm = if wpm_count > 0 {
            wpm_sum / wpm_count as f64
        } else {
            0.0
        };

        // Top words (top 50)
        let freq = word_frequencies(&all_text);
        let mut sorted_words: Vec<_> = freq.into_iter().collect();
        sorted_words.sort_by(|a, b| b.1.cmp(&a.1));
        sorted_words.truncate(50);
        let top_words_json =
            serde_json::to_string(&sorted_words).unwrap_or_else(|_| "[]".into());

        let source_json = if source_counts.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&source_counts).unwrap_or_else(|_| "{}".into()))
        };

        let now = Utc::now().to_rfc3339();

        // Upsert
        conn.execute(
            "INSERT INTO analytics_snapshots
                (date, word_count, sentence_count, entry_count, total_duration_seconds,
                 unique_word_count, avg_sentence_length, avg_words_per_minute,
                 source_app_breakdown, top_words, computed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(date) DO UPDATE SET
                word_count = excluded.word_count,
                sentence_count = excluded.sentence_count,
                entry_count = excluded.entry_count,
                total_duration_seconds = excluded.total_duration_seconds,
                unique_word_count = excluded.unique_word_count,
                avg_sentence_length = excluded.avg_sentence_length,
                avg_words_per_minute = excluded.avg_words_per_minute,
                source_app_breakdown = excluded.source_app_breakdown,
                top_words = excluded.top_words,
                computed_at = excluded.computed_at",
            rusqlite::params![
                date,
                total_words,
                total_sentences,
                entry_count,
                total_duration,
                unique,
                avg_sentence_length,
                avg_wpm,
                source_json,
                top_words_json,
                now,
            ],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to upsert snapshot: {e}")))?;

        Ok(DailySnapshot {
            date: date.to_string(),
            word_count: total_words,
            sentence_count: total_sentences,
            entry_count,
            total_duration_seconds: total_duration,
            unique_word_count: unique,
            avg_sentence_length,
            avg_words_per_minute: avg_wpm,
            source_app_breakdown: source_json,
            top_words: Some(top_words_json),
            computed_at: now,
        })
    }

    /// Backfill snapshots for all historical dates that have entries.
    pub fn backfill_all(&self) -> Result<u32, IronMicError> {
        let conn = self.db.conn();
        let mut stmt = conn
            .prepare("SELECT DISTINCT date(created_at) FROM entries WHERE is_archived = 0")
            .map_err(|e| IronMicError::Storage(format!("Failed to query dates: {e}")))?;

        let dates: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| IronMicError::Storage(format!("Failed to list dates: {e}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| IronMicError::Storage(format!("Failed to collect dates: {e}")))?;

        drop(stmt);
        drop(conn);

        let count = dates.len() as u32;
        for date in &dates {
            self.compute_daily_snapshot(date)?;
        }

        info!("Backfilled analytics for {} days", count);
        Ok(count)
    }

    /// Get overview stats for a period.
    pub fn get_overview(&self, period: &str) -> Result<OverviewStats, IronMicError> {
        let (from, to) = period_to_range(period);
        let conn = self.db.conn();

        let mut stmt = conn
            .prepare(
                "SELECT
                    COALESCE(SUM(word_count), 0),
                    COALESCE(SUM(sentence_count), 0),
                    COALESCE(SUM(entry_count), 0),
                    COALESCE(SUM(total_duration_seconds), 0.0),
                    COALESCE(AVG(CASE WHEN avg_words_per_minute > 0 THEN avg_words_per_minute END), 0.0),
                    COALESCE(SUM(unique_word_count), 0),
                    COALESCE(AVG(CASE WHEN avg_sentence_length > 0 THEN avg_sentence_length END), 0.0)
                 FROM analytics_snapshots
                 WHERE date >= ?1 AND date <= ?2",
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare overview query: {e}")))?;

        let stats = stmt
            .query_row(rusqlite::params![from, to], |row| {
                Ok(OverviewStats {
                    total_words: row.get::<_, i64>(0)? as u64,
                    total_sentences: row.get::<_, i64>(1)? as u64,
                    total_entries: row.get::<_, i64>(2)? as u64,
                    total_duration_seconds: row.get(3)?,
                    avg_words_per_minute: row.get(4)?,
                    unique_words: row.get::<_, i64>(5)? as u64,
                    avg_sentence_length: row.get(6)?,
                    period: period.to_string(),
                })
            })
            .map_err(|e| IronMicError::Storage(format!("Failed to get overview: {e}")))?;

        Ok(stats)
    }

    /// Get daily trend data for charting.
    pub fn get_daily_trend(
        &self,
        from: &str,
        to: &str,
    ) -> Result<Vec<DailySnapshot>, IronMicError> {
        let conn = self.db.conn();
        let mut stmt = conn
            .prepare(
                "SELECT date, word_count, sentence_count, entry_count, total_duration_seconds,
                        unique_word_count, avg_sentence_length, avg_words_per_minute,
                        source_app_breakdown, top_words, computed_at
                 FROM analytics_snapshots
                 WHERE date >= ?1 AND date <= ?2
                 ORDER BY date ASC",
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare trend query: {e}")))?;

        let snapshots = stmt
            .query_map(rusqlite::params![from, to], |row| {
                Ok(DailySnapshot {
                    date: row.get(0)?,
                    word_count: row.get::<_, i64>(1)? as u64,
                    sentence_count: row.get::<_, i64>(2)? as u64,
                    entry_count: row.get::<_, i64>(3)? as u64,
                    total_duration_seconds: row.get(4)?,
                    unique_word_count: row.get::<_, i64>(5)? as u64,
                    avg_sentence_length: row.get(6)?,
                    avg_words_per_minute: row.get(7)?,
                    source_app_breakdown: row.get(8)?,
                    top_words: row.get(9)?,
                    computed_at: row.get(10)?,
                })
            })
            .map_err(|e| IronMicError::Storage(format!("Failed to query trend: {e}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| IronMicError::Storage(format!("Failed to collect trend: {e}")))?;

        Ok(snapshots)
    }

    /// Get merged top words across a date range.
    pub fn get_top_words(
        &self,
        from: &str,
        to: &str,
        limit: u32,
    ) -> Result<Vec<(String, u64)>, IronMicError> {
        let conn = self.db.conn();
        let mut stmt = conn
            .prepare(
                "SELECT top_words FROM analytics_snapshots WHERE date >= ?1 AND date <= ?2",
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare top words query: {e}")))?;

        let rows: Vec<Option<String>> = stmt
            .query_map(rusqlite::params![from, to], |row| row.get(0))
            .map_err(|e| IronMicError::Storage(format!("Failed to query top words: {e}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| IronMicError::Storage(format!("Failed to collect top words: {e}")))?;

        let mut merged: HashMap<String, u64> = HashMap::new();
        for json in rows.into_iter().flatten() {
            if let Ok(words) = serde_json::from_str::<Vec<(String, u64)>>(&json) {
                for (word, count) in words {
                    *merged.entry(word).or_insert(0) += count;
                }
            }
        }

        let mut sorted: Vec<_> = merged.into_iter().collect();
        sorted.sort_by(|a, b| b.1.cmp(&a.1));
        sorted.truncate(limit as usize);
        Ok(sorted)
    }

    /// Get source app breakdown across a date range.
    pub fn get_source_breakdown(
        &self,
        from: &str,
        to: &str,
    ) -> Result<HashMap<String, u64>, IronMicError> {
        let conn = self.db.conn();
        let mut stmt = conn
            .prepare(
                "SELECT source_app_breakdown FROM analytics_snapshots WHERE date >= ?1 AND date <= ?2",
            )
            .map_err(|e| {
                IronMicError::Storage(format!("Failed to prepare source breakdown query: {e}"))
            })?;

        let rows: Vec<Option<String>> = stmt
            .query_map(rusqlite::params![from, to], |row| row.get(0))
            .map_err(|e| IronMicError::Storage(format!("Failed to query source breakdown: {e}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| {
                IronMicError::Storage(format!("Failed to collect source breakdown: {e}"))
            })?;

        let mut merged: HashMap<String, u64> = HashMap::new();
        for json in rows.into_iter().flatten() {
            if let Ok(map) = serde_json::from_str::<HashMap<String, u64>>(&json) {
                for (app, count) in map {
                    *merged.entry(app).or_insert(0) += count;
                }
            }
        }

        Ok(merged)
    }

    /// Compute vocabulary richness (type-token ratio) across a date range.
    pub fn get_vocabulary_richness(
        &self,
        from: &str,
        to: &str,
    ) -> Result<VocabularyRichness, IronMicError> {
        let conn = self.db.conn();
        let mut stmt = conn
            .prepare(
                "SELECT COALESCE(SUM(unique_word_count), 0), COALESCE(SUM(word_count), 0)
                 FROM analytics_snapshots
                 WHERE date >= ?1 AND date <= ?2",
            )
            .map_err(|e| {
                IronMicError::Storage(format!("Failed to prepare vocabulary query: {e}"))
            })?;

        let (unique, total) = stmt
            .query_row(rusqlite::params![from, to], |row| {
                Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)? as u64))
            })
            .map_err(|e| IronMicError::Storage(format!("Failed to get vocabulary richness: {e}")))?;

        let ttr = if total > 0 {
            unique as f64 / total as f64
        } else {
            0.0
        };

        Ok(VocabularyRichness {
            ttr,
            unique_count: unique,
            total_count: total,
        })
    }

    /// Get streak data (current and longest daily streak).
    pub fn get_streaks(&self) -> Result<StreakInfo, IronMicError> {
        let conn = self.db.conn();
        let mut stmt = conn
            .prepare(
                "SELECT date FROM analytics_snapshots WHERE entry_count > 0 ORDER BY date DESC",
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to prepare streaks query: {e}")))?;

        let dates: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| IronMicError::Storage(format!("Failed to query streaks: {e}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| IronMicError::Storage(format!("Failed to collect streaks: {e}")))?;

        if dates.is_empty() {
            return Ok(StreakInfo {
                current_streak: 0,
                longest_streak: 0,
                last_active_date: String::new(),
            });
        }

        let last_active = dates[0].clone();
        let today = Utc::now().format("%Y-%m-%d").to_string();

        // Parse all dates
        let parsed: Vec<NaiveDate> = dates
            .iter()
            .filter_map(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
            .collect();

        // Calculate current streak
        let mut current_streak: u32 = 0;
        let today_date = NaiveDate::parse_from_str(&today, "%Y-%m-%d")
            .unwrap_or_else(|_| Utc::now().date_naive());

        if !parsed.is_empty() {
            let first = parsed[0];
            let diff = (today_date - first).num_days();
            if diff <= 1 {
                current_streak = 1;
                for i in 1..parsed.len() {
                    if (parsed[i - 1] - parsed[i]).num_days() == 1 {
                        current_streak += 1;
                    } else {
                        break;
                    }
                }
            }
        }

        // Calculate longest streak
        let mut longest_streak: u32 = 0;
        let mut streak: u32 = 1;
        for i in 1..parsed.len() {
            if (parsed[i - 1] - parsed[i]).num_days() == 1 {
                streak += 1;
            } else {
                longest_streak = longest_streak.max(streak);
                streak = 1;
            }
        }
        longest_streak = longest_streak.max(streak);
        if parsed.is_empty() {
            longest_streak = 0;
        }

        Ok(StreakInfo {
            current_streak,
            longest_streak,
            last_active_date: last_active,
        })
    }

    /// Compare this week's word count to last week's.
    pub fn get_productivity_comparison(&self) -> Result<ProductivityComparison, IronMicError> {
        let today = Utc::now().date_naive();
        let weekday = today.weekday().num_days_from_monday();
        let this_monday = today - chrono::Duration::days(weekday as i64);
        let last_monday = this_monday - chrono::Duration::days(7);
        let last_sunday = this_monday - chrono::Duration::days(1);

        let this_week_from = this_monday.format("%Y-%m-%d").to_string();
        let this_week_to = today.format("%Y-%m-%d").to_string();
        let last_week_from = last_monday.format("%Y-%m-%d").to_string();
        let last_week_to = last_sunday.format("%Y-%m-%d").to_string();

        let conn = self.db.conn();

        let this_words: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(word_count), 0) FROM analytics_snapshots WHERE date >= ?1 AND date <= ?2",
                rusqlite::params![this_week_from, this_week_to],
                |row| row.get(0),
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to get this week words: {e}")))?;

        let last_words: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(word_count), 0) FROM analytics_snapshots WHERE date >= ?1 AND date <= ?2",
                rusqlite::params![last_week_from, last_week_to],
                |row| row.get(0),
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to get last week words: {e}")))?;

        let change_percent = if last_words > 0 {
            ((this_words as f64 - last_words as f64) / last_words as f64) * 100.0
        } else if this_words > 0 {
            100.0
        } else {
            0.0
        };

        Ok(ProductivityComparison {
            this_period_words: this_words as u64,
            prev_period_words: last_words as u64,
            change_percent,
            period_label: "week".into(),
        })
    }

    /// Get entry IDs that haven't been classified yet.
    pub fn get_unclassified_entry_ids(
        &self,
        limit: u32,
    ) -> Result<Vec<(String, String)>, IronMicError> {
        let conn = self.db.conn();
        let mut stmt = conn
            .prepare(
                "SELECT e.id, COALESCE(e.polished_text, e.raw_transcript)
                 FROM entries e
                 LEFT JOIN entry_topics t ON e.id = t.entry_id
                 WHERE t.entry_id IS NULL AND e.is_archived = 0
                 LIMIT ?1",
            )
            .map_err(|e| {
                IronMicError::Storage(format!("Failed to prepare unclassified query: {e}"))
            })?;

        let rows = stmt
            .query_map([limit], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| IronMicError::Storage(format!("Failed to query unclassified: {e}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| IronMicError::Storage(format!("Failed to collect unclassified: {e}")))?;

        Ok(rows)
    }

    /// Get count of unclassified entries.
    pub fn get_unclassified_count(&self) -> Result<u32, IronMicError> {
        let conn = self.db.conn();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM entries e
                 LEFT JOIN entry_topics t ON e.id = t.entry_id
                 WHERE t.entry_id IS NULL AND e.is_archived = 0",
                [],
                |row| row.get(0),
            )
            .map_err(|e| {
                IronMicError::Storage(format!("Failed to count unclassified entries: {e}"))
            })?;

        Ok(count as u32)
    }

    /// Save topic classifications for an entry.
    pub fn save_entry_topics(
        &self,
        entry_id: &str,
        topics: &[(String, f64)],
    ) -> Result<(), IronMicError> {
        let conn = self.db.conn();
        let now = Utc::now().to_rfc3339();

        for (topic, confidence) in topics {
            conn.execute(
                "INSERT OR REPLACE INTO entry_topics (entry_id, topic, confidence, classified_at)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![entry_id, topic, confidence, now],
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to save entry topic: {e}")))?;
        }

        Ok(())
    }

    /// Get topic breakdown across a date range.
    pub fn get_topic_breakdown(
        &self,
        from: &str,
        to: &str,
    ) -> Result<Vec<TopicStat>, IronMicError> {
        let conn = self.db.conn();
        let mut stmt = conn
            .prepare(
                "SELECT t.topic, COUNT(DISTINCT t.entry_id) as entry_count
                 FROM entry_topics t
                 JOIN entries e ON e.id = t.entry_id
                 WHERE date(e.created_at) >= ?1 AND date(e.created_at) <= ?2
                 GROUP BY t.topic
                 ORDER BY entry_count DESC",
            )
            .map_err(|e| {
                IronMicError::Storage(format!("Failed to prepare topic breakdown query: {e}"))
            })?;

        let rows: Vec<(String, u64)> = stmt
            .query_map(rusqlite::params![from, to], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64))
            })
            .map_err(|e| IronMicError::Storage(format!("Failed to query topic breakdown: {e}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| {
                IronMicError::Storage(format!("Failed to collect topic breakdown: {e}"))
            })?;

        let total: u64 = rows.iter().map(|(_, c)| c).sum();
        let topics = rows
            .into_iter()
            .map(|(topic, entry_count)| TopicStat {
                percentage: if total > 0 {
                    (entry_count as f64 / total as f64) * 100.0
                } else {
                    0.0
                },
                topic,
                entry_count,
                word_count: 0, // Simplified; could join with entries for word count
            })
            .collect();

        Ok(topics)
    }

    /// Get topic trends over time.
    pub fn get_topic_trends(
        &self,
        from: &str,
        to: &str,
    ) -> Result<Vec<TopicTrend>, IronMicError> {
        let conn = self.db.conn();
        let mut stmt = conn
            .prepare(
                "SELECT date(e.created_at) as d, t.topic, COUNT(*) as cnt
                 FROM entry_topics t
                 JOIN entries e ON e.id = t.entry_id
                 WHERE date(e.created_at) >= ?1 AND date(e.created_at) <= ?2
                 GROUP BY d, t.topic
                 ORDER BY d ASC, cnt DESC",
            )
            .map_err(|e| {
                IronMicError::Storage(format!("Failed to prepare topic trends query: {e}"))
            })?;

        let trends = stmt
            .query_map(rusqlite::params![from, to], |row| {
                Ok(TopicTrend {
                    date: row.get(0)?,
                    topic: row.get(1)?,
                    count: row.get::<_, i64>(2)? as u64,
                })
            })
            .map_err(|e| IronMicError::Storage(format!("Failed to query topic trends: {e}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| IronMicError::Storage(format!("Failed to collect topic trends: {e}")))?;

        Ok(trends)
    }
}

/// Convert a period string to a (from, to) date range.
fn period_to_range(period: &str) -> (String, String) {
    let today = Utc::now().date_naive();
    let to = today.format("%Y-%m-%d").to_string();

    let from = match period {
        "today" => to.clone(),
        "week" => {
            let weekday = today.weekday().num_days_from_monday();
            let monday = today - chrono::Duration::days(weekday as i64);
            monday.format("%Y-%m-%d").to_string()
        }
        "month" => {
            let first = NaiveDate::from_ymd_opt(today.year(), today.month(), 1)
                .unwrap_or(today);
            first.format("%Y-%m-%d").to_string()
        }
        _ => "2020-01-01".to_string(), // all_time
    };

    (from, to)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::db::Database;
    use crate::storage::entries::{EntryStore, NewEntry};

    fn setup() -> (Database, AnalyticsStore, EntryStore) {
        let db = Database::open_in_memory().unwrap();
        let analytics = AnalyticsStore::new(db.clone());
        let entries = EntryStore::new(db.clone());
        (db, analytics, entries)
    }

    #[test]
    fn count_words_basic() {
        assert_eq!(count_words("hello world foo bar"), 4);
        assert_eq!(count_words(""), 0);
        assert_eq!(count_words("  "), 0);
        assert_eq!(count_words("single"), 1);
    }

    #[test]
    fn count_sentences_basic() {
        assert_eq!(count_sentences("Hello world. How are you? I'm fine!"), 3);
        assert_eq!(count_sentences("No punctuation here"), 1);
        assert_eq!(count_sentences(""), 0);
    }

    #[test]
    fn word_frequencies_excludes_stop_words() {
        let freq = word_frequencies("the code is very good and the deployment is fast");
        assert!(freq.contains_key("code"));
        assert!(freq.contains_key("deployment"));
        assert!(freq.contains_key("fast"));
        assert!(freq.contains_key("good"));
        assert!(!freq.contains_key("the"));
        assert!(!freq.contains_key("is"));
        assert!(!freq.contains_key("and"));
        assert!(!freq.contains_key("very"));
    }

    #[test]
    fn unique_words_count() {
        assert_eq!(unique_words("hello hello world world world"), 2);
        assert_eq!(unique_words("one two three"), 3);
        assert_eq!(unique_words(""), 0);
    }

    #[test]
    fn compute_snapshot_empty_day() {
        let (_db, analytics, _entries) = setup();
        let snapshot = analytics.compute_daily_snapshot("2025-01-01").unwrap();
        assert_eq!(snapshot.entry_count, 0);
        assert_eq!(snapshot.word_count, 0);
    }

    #[test]
    fn compute_snapshot_with_entries() {
        let (db, analytics, entries) = setup();
        // Insert an entry with a known timestamp
        let conn = db.conn();
        conn.execute(
            "INSERT INTO entries (id, created_at, updated_at, raw_transcript, polished_text, duration_seconds, source_app)
             VALUES ('test1', '2025-06-15T10:00:00Z', '2025-06-15T10:00:00Z', 'hello world this is a test', 'Hello world, this is a test.', 5.0, 'VSCode')",
            [],
        ).unwrap();
        drop(conn);

        let snapshot = analytics.compute_daily_snapshot("2025-06-15").unwrap();
        assert_eq!(snapshot.entry_count, 1);
        assert!(snapshot.word_count > 0);
        assert!(snapshot.total_duration_seconds > 0.0);
    }

    #[test]
    fn backfill_works() {
        let (db, analytics, _entries) = setup();
        let conn = db.conn();
        conn.execute(
            "INSERT INTO entries (id, created_at, updated_at, raw_transcript, duration_seconds)
             VALUES ('a', '2025-06-15T10:00:00Z', '2025-06-15T10:00:00Z', 'hello world', 2.0)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO entries (id, created_at, updated_at, raw_transcript, duration_seconds)
             VALUES ('b', '2025-06-16T10:00:00Z', '2025-06-16T10:00:00Z', 'foo bar baz', 3.0)",
            [],
        ).unwrap();
        drop(conn);

        let count = analytics.backfill_all().unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn get_overview_empty() {
        let (_db, analytics, _entries) = setup();
        let stats = analytics.get_overview("all_time").unwrap();
        assert_eq!(stats.total_words, 0);
        assert_eq!(stats.total_entries, 0);
    }

    #[test]
    fn streaks_empty() {
        let (_db, analytics, _entries) = setup();
        let streaks = analytics.get_streaks().unwrap();
        assert_eq!(streaks.current_streak, 0);
        assert_eq!(streaks.longest_streak, 0);
    }

    #[test]
    fn productivity_comparison_empty() {
        let (_db, analytics, _entries) = setup();
        let comparison = analytics.get_productivity_comparison().unwrap();
        assert_eq!(comparison.this_period_words, 0);
        assert_eq!(comparison.prev_period_words, 0);
    }

    #[test]
    fn topic_operations() {
        let (db, analytics, _entries) = setup();
        let conn = db.conn();
        conn.execute(
            "INSERT INTO entries (id, created_at, updated_at, raw_transcript)
             VALUES ('t1', '2025-06-15T10:00:00Z', '2025-06-15T10:00:00Z', 'talking about code')",
            [],
        ).unwrap();
        drop(conn);

        // Save topics
        analytics
            .save_entry_topics(
                "t1",
                &[
                    ("Software Development".into(), 1.0),
                    ("Code Review".into(), 0.8),
                ],
            )
            .unwrap();

        // Get topic breakdown
        let breakdown = analytics
            .get_topic_breakdown("2025-06-01", "2025-06-30")
            .unwrap();
        assert_eq!(breakdown.len(), 2);

        // Get unclassified count should be 0 for this entry
        let unclassified = analytics.get_unclassified_count().unwrap();
        assert_eq!(unclassified, 0);
    }

    #[test]
    fn vocabulary_richness_empty() {
        let (_db, analytics, _entries) = setup();
        let richness = analytics
            .get_vocabulary_richness("2020-01-01", "2030-01-01")
            .unwrap();
        assert_eq!(richness.ttr, 0.0);
        assert_eq!(richness.unique_count, 0);
        assert_eq!(richness.total_count, 0);
    }
}
