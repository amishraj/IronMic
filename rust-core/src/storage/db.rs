use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use tracing::info;

use crate::error::IronMicError;

/// Schema version for migration tracking.
const SCHEMA_VERSION: u32 = 5;

/// Get the platform-appropriate app data directory for IronMic.
pub fn app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("IronMic")
}

/// Get the default database file path.
pub fn default_db_path() -> PathBuf {
    app_data_dir().join("ironmic.db")
}

/// A thread-safe database connection wrapper.
pub struct Database {
    conn: Arc<Mutex<Connection>>,
    path: PathBuf,
}

impl Database {
    /// Open (or create) the database at the given path.
    pub fn open(path: &Path) -> Result<Self, IronMicError> {
        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                IronMicError::Storage(format!("Failed to create data directory: {e}"))
            })?;
        }

        let conn = Connection::open(path)
            .map_err(|e| IronMicError::Storage(format!("Failed to open database: {e}")))?;

        // Enable WAL mode for better concurrent performance
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(|e| IronMicError::Storage(format!("Failed to set pragmas: {e}")))?;

        info!(path = %path.display(), "Database opened");

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
            path: path.to_path_buf(),
        };

        db.run_migrations()?;

        Ok(db)
    }

    /// Open an in-memory database (for testing).
    pub fn open_in_memory() -> Result<Self, IronMicError> {
        let conn = Connection::open_in_memory()
            .map_err(|e| IronMicError::Storage(format!("Failed to open in-memory db: {e}")))?;

        conn.execute_batch("PRAGMA foreign_keys=ON;")
            .map_err(|e| IronMicError::Storage(format!("Failed to set pragmas: {e}")))?;

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
            path: PathBuf::from(":memory:"),
        };

        db.run_migrations()?;

        Ok(db)
    }

    /// Get a locked reference to the connection.
    pub fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap()
    }

    /// Get the database file path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Run all database migrations.
    fn run_migrations(&self) -> Result<(), IronMicError> {
        let conn = self.conn();

        // Create version tracking table
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER NOT NULL
            );",
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to create version table: {e}")))?;

        let current_version: u32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_version",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        if current_version >= SCHEMA_VERSION {
            info!(version = current_version, "Database schema is up to date");
            return Ok(());
        }

        info!(
            current = current_version,
            target = SCHEMA_VERSION,
            "Running database migrations"
        );

        if current_version < 1 {
            self.migrate_v1(&conn)?;
        }

        if current_version < 2 {
            self.migrate_v2(&conn)?;
        }

        if current_version < 3 {
            self.migrate_v3(&conn)?;
        }

        if current_version < 4 {
            self.migrate_v4(&conn)?;
        }

        if current_version < 5 {
            self.migrate_v5(&conn)?;
        }

        // Update version
        conn.execute(
            "INSERT INTO schema_version (version) VALUES (?1)",
            [SCHEMA_VERSION],
        )
        .map_err(|e| IronMicError::Storage(format!("Failed to update schema version: {e}")))?;

        info!(version = SCHEMA_VERSION, "Database migrations complete");
        Ok(())
    }

    /// Migration v1: Create all initial tables.
    fn migrate_v1(&self, conn: &Connection) -> Result<(), IronMicError> {
        conn.execute_batch(
            "
            -- All dictation entries
            CREATE TABLE IF NOT EXISTS entries (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                raw_transcript TEXT NOT NULL,
                polished_text TEXT,
                display_mode TEXT NOT NULL DEFAULT 'polished',
                duration_seconds REAL,
                source_app TEXT,
                is_pinned INTEGER DEFAULT 0,
                is_archived INTEGER DEFAULT 0,
                tags TEXT
            );

            -- Full-text search index
            CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
                raw_transcript,
                polished_text,
                tags,
                content='entries',
                content_rowid='rowid'
            );

            -- Triggers to keep FTS index in sync
            CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
                INSERT INTO entries_fts(rowid, raw_transcript, polished_text, tags)
                VALUES (new.rowid, new.raw_transcript, new.polished_text, new.tags);
            END;

            CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
                INSERT INTO entries_fts(entries_fts, rowid, raw_transcript, polished_text, tags)
                VALUES ('delete', old.rowid, old.raw_transcript, old.polished_text, old.tags);
            END;

            CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
                INSERT INTO entries_fts(entries_fts, rowid, raw_transcript, polished_text, tags)
                VALUES ('delete', old.rowid, old.raw_transcript, old.polished_text, old.tags);
                INSERT INTO entries_fts(rowid, raw_transcript, polished_text, tags)
                VALUES (new.rowid, new.raw_transcript, new.polished_text, new.tags);
            END;

            -- User-defined custom dictionary words
            CREATE TABLE IF NOT EXISTS dictionary (
                id TEXT PRIMARY KEY,
                word TEXT NOT NULL UNIQUE,
                added_at TEXT NOT NULL
            );

            -- Application settings
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            -- Default settings
            INSERT OR IGNORE INTO settings (key, value) VALUES ('hotkey_record', 'CommandOrControl+Shift+V');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('llm_cleanup_enabled', 'true');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('default_view', 'timeline');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('theme', 'system');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('whisper_model', 'large-v3-turbo');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('llm_model', 'mistral-7b-instruct-q4');
            ",
        )
        .map_err(|e| IronMicError::Storage(format!("Migration v1 failed: {e}")))?;

        info!("Migration v1 applied: created entries, dictionary, settings tables");
        Ok(())
    }

    /// Migration v2: Create analytics tables.
    fn migrate_v2(&self, conn: &Connection) -> Result<(), IronMicError> {
        conn.execute_batch(
            "
            -- Pre-computed daily aggregates for fast dashboard loading
            CREATE TABLE IF NOT EXISTS analytics_snapshots (
                date TEXT PRIMARY KEY,
                word_count INTEGER NOT NULL DEFAULT 0,
                sentence_count INTEGER NOT NULL DEFAULT 0,
                entry_count INTEGER NOT NULL DEFAULT 0,
                total_duration_seconds REAL NOT NULL DEFAULT 0.0,
                unique_word_count INTEGER NOT NULL DEFAULT 0,
                avg_sentence_length REAL NOT NULL DEFAULT 0.0,
                avg_words_per_minute REAL NOT NULL DEFAULT 0.0,
                source_app_breakdown TEXT,
                top_words TEXT,
                computed_at TEXT NOT NULL
            );

            -- Per-entry LLM topic classifications
            CREATE TABLE IF NOT EXISTS entry_topics (
                entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                topic TEXT NOT NULL,
                confidence REAL NOT NULL DEFAULT 1.0,
                classified_at TEXT NOT NULL,
                PRIMARY KEY (entry_id, topic)
            );

            CREATE INDEX IF NOT EXISTS idx_entry_topics_topic ON entry_topics(topic);

            -- Daily topic aggregates for trend charts
            CREATE TABLE IF NOT EXISTS analytics_topic_snapshots (
                date TEXT NOT NULL,
                topic TEXT NOT NULL,
                entry_count INTEGER NOT NULL DEFAULT 0,
                word_count INTEGER NOT NULL DEFAULT 0,
                computed_at TEXT NOT NULL,
                PRIMARY KEY (date, topic)
            );
            ",
        )
        .map_err(|e| IronMicError::Storage(format!("Migration v2 failed: {e}")))?;

        info!("Migration v2 applied: created analytics tables");
        Ok(())
    }

    /// Migration v3: Create TF.js ML feature tables (v1.1.0).
    fn migrate_v3(&self, conn: &Connection) -> Result<(), IronMicError> {
        conn.execute_batch(
            "
            -- Feature 1: VAD/turn detection training data
            CREATE TABLE IF NOT EXISTS vad_training_samples (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                audio_features TEXT NOT NULL,
                label TEXT NOT NULL,
                is_user_corrected INTEGER DEFAULT 0,
                session_id TEXT
            );

            -- Feature 2: Intent classification training data
            CREATE TABLE IF NOT EXISTS intent_training_samples (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                transcript TEXT NOT NULL,
                predicted_intent TEXT,
                predicted_entities TEXT,
                corrected_intent TEXT,
                corrected_entities TEXT,
                confidence REAL,
                entry_id TEXT REFERENCES entries(id) ON DELETE SET NULL
            );

            -- Feature 1C: Voice routing log
            CREATE TABLE IF NOT EXISTS voice_routing_log (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                active_screen TEXT NOT NULL,
                detected_intent TEXT NOT NULL,
                routed_to TEXT NOT NULL,
                was_correct INTEGER DEFAULT 1,
                entry_id TEXT REFERENCES entries(id) ON DELETE SET NULL
            );

            -- Feature 1 Bonus: Meeting sessions
            CREATE TABLE IF NOT EXISTS meeting_sessions (
                id TEXT PRIMARY KEY,
                started_at TEXT NOT NULL,
                ended_at TEXT,
                speaker_count INTEGER DEFAULT 0,
                summary TEXT,
                action_items TEXT,
                total_duration_seconds REAL,
                entry_ids TEXT
            );

            -- Feature 3: Notifications
            CREATE TABLE IF NOT EXISTS notifications (
                id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                source_id TEXT,
                notification_type TEXT NOT NULL,
                title TEXT NOT NULL,
                body TEXT,
                priority REAL NOT NULL DEFAULT 0.5,
                created_at TEXT NOT NULL,
                read_at TEXT,
                acted_on_at TEXT,
                dismissed_at TEXT,
                response_latency_ms INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);

            -- Feature 3: Notification interaction log
            CREATE TABLE IF NOT EXISTS notification_interactions (
                id TEXT PRIMARY KEY,
                notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
                action TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                context_hour INTEGER,
                context_day_of_week INTEGER
            );

            -- Feature 4: Action log for workflow discovery
            CREATE TABLE IF NOT EXISTS action_log (
                id TEXT PRIMARY KEY,
                action_type TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                hour_of_day INTEGER NOT NULL,
                day_of_week INTEGER NOT NULL,
                metadata_json TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_action_log_timestamp ON action_log(timestamp);
            CREATE INDEX IF NOT EXISTS idx_action_log_type ON action_log(action_type);

            -- Feature 4: Discovered workflows
            CREATE TABLE IF NOT EXISTS workflows (
                id TEXT PRIMARY KEY,
                name TEXT,
                action_sequence TEXT NOT NULL,
                trigger_pattern TEXT,
                confidence REAL NOT NULL DEFAULT 0.0,
                occurrence_count INTEGER NOT NULL DEFAULT 0,
                first_seen_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                is_saved INTEGER DEFAULT 0,
                is_dismissed INTEGER DEFAULT 0
            );

            -- Feature 5: Semantic embeddings
            CREATE TABLE IF NOT EXISTS embeddings (
                content_id TEXT NOT NULL,
                content_type TEXT NOT NULL,
                embedding BLOB NOT NULL,
                embedded_at TEXT NOT NULL,
                model_version TEXT NOT NULL DEFAULT 'use-v1',
                PRIMARY KEY (content_id, content_type)
            );
            CREATE INDEX IF NOT EXISTS idx_embeddings_type ON embeddings(content_type);

            -- Shared: ML model weights persistence
            CREATE TABLE IF NOT EXISTS ml_model_weights (
                model_name TEXT PRIMARY KEY,
                weights_json TEXT NOT NULL,
                metadata_json TEXT,
                trained_at TEXT NOT NULL,
                training_samples INTEGER NOT NULL DEFAULT 0,
                version INTEGER NOT NULL DEFAULT 1
            );

            -- Shared: TF.js model metadata
            CREATE TABLE IF NOT EXISTS tfjs_model_metadata (
                model_id TEXT PRIMARY KEY,
                version TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                last_loaded_at TEXT,
                personal_fine_tune_version INTEGER DEFAULT 0,
                accuracy_score REAL
            );

            -- Default ML settings
            INSERT OR IGNORE INTO settings (key, value) VALUES ('vad_enabled', 'true');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('vad_sensitivity', '0.5');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('vad_web_audio_enabled', 'true');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('turn_detection_enabled', 'false');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('turn_detection_timeout_ms', '3000');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('turn_detection_mode', 'push-to-talk');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('voice_routing_enabled', 'false');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('meeting_mode_enabled', 'false');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('intent_classification_enabled', 'false');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('intent_llm_fallback', 'true');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('ml_notifications_enabled', 'false');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('ml_notifications_threshold', '0.5');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('ml_notifications_retention_days', '30');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('ml_workflows_enabled', 'false');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('ml_workflows_confidence', '0.7');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('ml_semantic_search_enabled', 'false');
            ",
        )
        .map_err(|e| IronMicError::Storage(format!("Migration v3 failed: {e}")))?;

        info!("Migration v3 applied: created ML feature tables for v1.1.0");
        Ok(())
    }

    /// Migration v4: Meeting templates, meeting session extensions, and new settings.
    fn migrate_v4(&self, conn: &Connection) -> Result<(), IronMicError> {
        conn.execute_batch(
            "
            -- Meeting templates for structured output
            CREATE TABLE IF NOT EXISTS meeting_templates (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                meeting_type TEXT NOT NULL,
                sections TEXT NOT NULL,
                llm_prompt TEXT NOT NULL,
                display_layout TEXT NOT NULL,
                is_builtin INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            -- Extend meeting_sessions with template support
            ALTER TABLE meeting_sessions ADD COLUMN template_id TEXT;
            ALTER TABLE meeting_sessions ADD COLUMN structured_output TEXT;
            ALTER TABLE meeting_sessions ADD COLUMN detected_app TEXT;

            -- New settings
            INSERT OR IGNORE INTO settings (key, value) VALUES ('meeting_auto_detect_enabled', 'false');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('meeting_default_template', '');
            ",
        )
        .map_err(|e| IronMicError::Storage(format!("Migration v4 failed: {e}")))?;

        // Seed builtin meeting templates
        self.seed_builtin_templates(conn)?;

        info!("Migration v4 applied: meeting templates and session extensions");
        Ok(())
    }

    /// Migration v5: Transcript segments table and meeting session extensions for the
    /// Granola-style meeting notetaker feature.
    fn migrate_v5(&self, conn: &Connection) -> Result<(), IronMicError> {
        conn.execute_batch(
            "
            -- Stores every 30-second transcribed chunk for a meeting session
            CREATE TABLE IF NOT EXISTS transcript_segments (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
                speaker_label TEXT,
                start_ms INTEGER NOT NULL,
                end_ms INTEGER NOT NULL,
                text TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'meeting',
                participant_id TEXT,
                confidence REAL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_transcript_segments_session
                ON transcript_segments(session_id, start_ms);

            -- Extend meeting_sessions for room-based multi-user support
            ALTER TABLE meeting_sessions ADD COLUMN room_code TEXT;
            ALTER TABLE meeting_sessions ADD COLUMN audio_device TEXT;
            ALTER TABLE meeting_sessions ADD COLUMN full_transcript TEXT;

            -- New settings for meeting audio device selection
            INSERT OR IGNORE INTO settings (key, value) VALUES ('meeting_audio_device', '');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('meeting_chunk_interval_s', '15');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('meeting_display_name', '');
            ",
        )
        .map_err(|e| IronMicError::Storage(format!("Migration v5 failed: {e}")))?;

        info!("Migration v5 applied: transcript_segments table and meeting session extensions");
        Ok(())
    }

    fn seed_builtin_templates(&self, conn: &Connection) -> Result<(), IronMicError> {
        let now = chrono::Utc::now().to_rfc3339();
        let templates = vec![
            (
                "builtin-standup",
                "Daily Standup",
                "standup",
                r#"["completed","in_progress","blockers"]"#,
                "You are a meeting notes assistant. Given the following meeting transcript, extract a structured standup summary.\n\nRules:\n- Extract what was completed yesterday into the \"Completed\" section\n- Extract what is being worked on today into the \"In Progress\" section\n- Extract any blockers or issues into the \"Blockers\" section\n- Use bullet points for each item\n- Keep items concise (1-2 sentences each)\n- If a section has no items, write \"None mentioned\"\n- Output ONLY the structured sections, no preamble\n\nFormat:\n## Completed\n- ...\n\n## In Progress\n- ...\n\n## Blockers\n- ...\n\nTranscript:\n{transcript}",
                r#"{"order":["completed","in_progress","blockers"]}"#,
            ),
            (
                "builtin-1on1",
                "1-on-1",
                "1on1",
                r#"["discussion_points","action_items","feedback"]"#,
                "You are a meeting notes assistant. Given the following 1-on-1 meeting transcript, extract structured notes.\n\nRules:\n- Extract main discussion topics into \"Discussion Points\"\n- Extract any agreed-upon action items with owners into \"Action Items\"\n- Extract any feedback given or received into \"Feedback\"\n- Use bullet points for each item\n- Keep items concise but include enough context to be actionable\n- If a section has no items, write \"None mentioned\"\n- Output ONLY the structured sections, no preamble\n\nFormat:\n## Discussion Points\n- ...\n\n## Action Items\n- ...\n\n## Feedback\n- ...\n\nTranscript:\n{transcript}",
                r#"{"order":["discussion_points","action_items","feedback"]}"#,
            ),
            (
                "builtin-discovery",
                "Discovery Call",
                "discovery",
                r#"["pain_points","requirements","next_steps","budget_timeline"]"#,
                "You are a meeting notes assistant. Given the following discovery call transcript, extract structured notes.\n\nRules:\n- Extract pain points and problems the prospect described into \"Pain Points\"\n- Extract specific requirements, needs, or desired features into \"Requirements\"\n- Extract agreed-upon next steps into \"Next Steps\"\n- Extract any mentions of budget, timeline, or decision process into \"Budget & Timeline\"\n- Use bullet points for each item\n- Include relevant quotes when they capture the prospect's voice\n- If a section has no items, write \"None mentioned\"\n- Output ONLY the structured sections, no preamble\n\nFormat:\n## Pain Points\n- ...\n\n## Requirements\n- ...\n\n## Next Steps\n- ...\n\n## Budget & Timeline\n- ...\n\nTranscript:\n{transcript}",
                r#"{"order":["pain_points","requirements","next_steps","budget_timeline"]}"#,
            ),
            (
                "builtin-team-sync",
                "Team Sync",
                "team_sync",
                r#"["updates","decisions","action_items","open_questions"]"#,
                "You are a meeting notes assistant. Given the following team sync meeting transcript, extract structured notes.\n\nRules:\n- Extract status updates from team members into \"Updates\"\n- Extract any decisions that were made into \"Decisions\"\n- Extract action items with owners and deadlines into \"Action Items\"\n- Extract unresolved questions or topics needing follow-up into \"Open Questions\"\n- Use bullet points for each item\n- Attribute updates to speakers when possible\n- If a section has no items, write \"None mentioned\"\n- Output ONLY the structured sections, no preamble\n\nFormat:\n## Updates\n- ...\n\n## Decisions\n- ...\n\n## Action Items\n- ...\n\n## Open Questions\n- ...\n\nTranscript:\n{transcript}",
                r#"{"order":["updates","decisions","action_items","open_questions"]}"#,
            ),
            (
                "builtin-retro",
                "Retrospective",
                "retro",
                r#"["went_well","improve","action_items"]"#,
                "You are a meeting notes assistant. Given the following retrospective meeting transcript, extract structured notes.\n\nRules:\n- Extract things that went well into \"Went Well\"\n- Extract things that need improvement into \"Needs Improvement\"\n- Extract concrete action items to improve into \"Action Items\"\n- Use bullet points for each item\n- Group related items together\n- If a section has no items, write \"None mentioned\"\n- Output ONLY the structured sections, no preamble\n\nFormat:\n## Went Well\n- ...\n\n## Needs Improvement\n- ...\n\n## Action Items\n- ...\n\nTranscript:\n{transcript}",
                r#"{"order":["went_well","improve","action_items"]}"#,
            ),
        ];

        for (id, name, meeting_type, sections, llm_prompt, display_layout) in templates {
            conn.execute(
                "INSERT OR IGNORE INTO meeting_templates (id, name, meeting_type, sections, llm_prompt, display_layout, is_builtin, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)",
                rusqlite::params![id, name, meeting_type, sections, llm_prompt, display_layout, now],
            )
            .map_err(|e| IronMicError::Storage(format!("Failed to seed template {id}: {e}")))?;
        }

        Ok(())
    }
}

impl Clone for Database {
    fn clone(&self) -> Self {
        Self {
            conn: Arc::clone(&self.conn),
            path: self.path.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_in_memory() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(db.path(), Path::new(":memory:"));
    }

    #[test]
    fn schema_created() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();

        // Check tables exist
        let count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='entries'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);

        let count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='dictionary'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);

        let count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='settings'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn default_settings_inserted() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();

        let hotkey: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key='hotkey_record'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(hotkey, "CommandOrControl+Shift+V");

        let cleanup: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key='llm_cleanup_enabled'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cleanup, "true");
    }

    #[test]
    fn idempotent_migrations() {
        let db = Database::open_in_memory().unwrap();
        // Running migrations again should be a no-op
        db.run_migrations().unwrap();
    }

    #[test]
    fn clone_shares_connection() {
        let db = Database::open_in_memory().unwrap();
        let cloned = db.clone();

        // Both should see the same data
        let conn1 = db.conn();
        conn1
            .execute(
                "INSERT INTO settings (key, value) VALUES ('test_key', 'test_value')",
                [],
            )
            .unwrap();
        drop(conn1);

        let conn2 = cloned.conn();
        let val: String = conn2
            .query_row(
                "SELECT value FROM settings WHERE key='test_key'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(val, "test_value");
    }
}
