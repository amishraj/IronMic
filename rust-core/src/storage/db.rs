use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use tracing::info;

use crate::error::IronMicError;

/// Schema version for migration tracking.
const SCHEMA_VERSION: u32 = 15;

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

        if current_version < 6 {
            self.migrate_v6(&conn)?;
        }

        if current_version < 7 {
            self.migrate_v7(&conn)?;
        }

        if current_version < 8 {
            self.migrate_v8(&conn)?;
        }

        if current_version < 9 {
            self.migrate_v9(&conn)?;
        }

        if current_version < 10 {
            self.migrate_v10(&conn)?;
        }

        if current_version < 11 {
            self.migrate_v11(&conn)?;
        }

        if current_version < 12 {
            self.migrate_v12(&conn)?;
        }

        if current_version < 13 {
            self.migrate_v13(&conn)?;
        }

        if current_version < 14 {
            self.migrate_v14(&conn)?;
        }

        if current_version < 15 {
            self.migrate_v15(&conn)?;
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
            INSERT OR IGNORE INTO settings (key, value) VALUES ('llm_model', 'Phi-3-mini-4k-instruct-Q2_K');
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

    /// Migration v6: Add nullable rich-text JSON columns to entries so the editor
    /// can round-trip TipTap formatting (paragraphs, headings, bold, lists, etc.)
    /// instead of having every save flatten back to plaintext. The existing
    /// raw_transcript / polished_text columns continue to hold plaintext (FTS
    /// source, timeline previews, Whisper output, polish input/output).
    fn migrate_v6(&self, conn: &Connection) -> Result<(), IronMicError> {
        conn.execute_batch(
            "
            ALTER TABLE entries ADD COLUMN raw_transcript_json TEXT;
            ALTER TABLE entries ADD COLUMN polished_text_json TEXT;
            ",
        )
        .map_err(|e| IronMicError::Storage(format!("Migration v6 failed: {e}")))?;

        info!("Migration v6 applied: rich-text JSON columns on entries");
        Ok(())
    }

    /// Migration v7: Add a `participants` JSON column to `meeting_sessions`
    /// so the historical roster (host + joiners + leftAt timestamps) is
    /// persisted alongside the meeting. Idempotent — checks PRAGMA
    /// table_info first so a partially-applied state (column exists but
    /// schema_version still below 7) does not error.
    fn migrate_v7(&self, conn: &Connection) -> Result<(), IronMicError> {
        let mut stmt = conn
            .prepare("PRAGMA table_info(meeting_sessions)")
            .map_err(|e| IronMicError::Storage(format!("Migration v7 prepare failed: {e}")))?;

        let mut already_exists = false;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| IronMicError::Storage(format!("Migration v7 query failed: {e}")))?;
        for col in rows.flatten() {
            if col == "participants" {
                already_exists = true;
                break;
            }
        }
        drop(stmt);

        if !already_exists {
            conn.execute_batch(
                "ALTER TABLE meeting_sessions ADD COLUMN participants TEXT NOT NULL DEFAULT '[]';",
            )
            .map_err(|e| IronMicError::Storage(format!("Migration v7 failed: {e}")))?;
            info!("Migration v7 applied: meeting_sessions.participants column added");
        } else {
            info!("Migration v7 skipped: meeting_sessions.participants already exists");
        }

        Ok(())
    }

    /// Migration v8: Cross-machine segment identity for rejoin dedup, plus
    /// expression indexes that turn the renderer's full-table sequence/linkage
    /// scans into indexed lookups.
    ///
    /// Adds `transcript_segments.remote_segment_id` (defensive — checks
    /// PRAGMA table_info first), a partial unique index on
    /// `(session_id, remote_segment_id)` so re-ingesting a welcome snapshot
    /// after a participant rejoin is a no-op, and two expression indexes on
    /// `meeting_sessions.structured_output` JSON paths used by rejoin lookup
    /// and `Meeting #N` numbering.
    fn migrate_v8(&self, conn: &Connection) -> Result<(), IronMicError> {
        let mut stmt = conn
            .prepare("PRAGMA table_info(transcript_segments)")
            .map_err(|e| IronMicError::Storage(format!("Migration v8 prepare failed: {e}")))?;

        let mut already_exists = false;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| IronMicError::Storage(format!("Migration v8 query failed: {e}")))?;
        for col in rows.flatten() {
            if col == "remote_segment_id" {
                already_exists = true;
                break;
            }
        }
        drop(stmt);

        if !already_exists {
            conn.execute_batch(
                "ALTER TABLE transcript_segments ADD COLUMN remote_segment_id TEXT;",
            )
            .map_err(|e| IronMicError::Storage(format!("Migration v8 ALTER failed: {e}")))?;
        }

        conn.execute_batch(
            "
            CREATE UNIQUE INDEX IF NOT EXISTS idx_segments_remote
                ON transcript_segments(session_id, remote_segment_id)
                WHERE remote_segment_id IS NOT NULL;

            CREATE INDEX IF NOT EXISTS idx_meetings_linked_remote
                ON meeting_sessions(json_extract(structured_output, '$.linkedRemoteSessionId'))
                WHERE structured_output IS NOT NULL;

            CREATE INDEX IF NOT EXISTS idx_meetings_sequence
                ON meeting_sessions(CAST(json_extract(structured_output, '$.sequence') AS INTEGER))
                WHERE structured_output IS NOT NULL;
            ",
        )
        .map_err(|e| IronMicError::Storage(format!("Migration v8 indexes failed: {e}")))?;

        info!("Migration v8 applied: remote_segment_id + expression indexes");
        Ok(())
    }

    /// Migration v9: Persistent AI chat sessions and messages, with FTS5 search
    /// across message content. Mirrors the entries/entries_fts pattern. New
    /// `voice_chat_allow_cloud` setting added (default off) so cloud Voice Chat
    /// requires explicit user opt-in.
    fn migrate_v9(&self, conn: &Connection) -> Result<(), IronMicError> {
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS ai_chat_sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                provider TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_accessed_at TEXT NOT NULL,
                last_message_preview TEXT,
                is_pinned INTEGER NOT NULL DEFAULT 0,
                is_archived INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_updated
                ON ai_chat_sessions(updated_at);
            CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_pinned
                ON ai_chat_sessions(is_pinned, updated_at);

            CREATE TABLE IF NOT EXISTS ai_chat_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
                role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
                content TEXT NOT NULL,
                provider TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_session
                ON ai_chat_messages(session_id, created_at);

            CREATE VIRTUAL TABLE IF NOT EXISTS ai_chat_messages_fts USING fts5(
                content,
                session_id UNINDEXED,
                content='ai_chat_messages',
                content_rowid='rowid'
            );

            CREATE TRIGGER IF NOT EXISTS ai_chat_messages_ai AFTER INSERT ON ai_chat_messages BEGIN
                INSERT INTO ai_chat_messages_fts(rowid, content, session_id)
                VALUES (new.rowid, new.content, new.session_id);
            END;

            CREATE TRIGGER IF NOT EXISTS ai_chat_messages_ad AFTER DELETE ON ai_chat_messages BEGIN
                INSERT INTO ai_chat_messages_fts(ai_chat_messages_fts, rowid, content, session_id)
                VALUES ('delete', old.rowid, old.content, old.session_id);
            END;

            CREATE TRIGGER IF NOT EXISTS ai_chat_messages_au AFTER UPDATE ON ai_chat_messages BEGIN
                INSERT INTO ai_chat_messages_fts(ai_chat_messages_fts, rowid, content, session_id)
                VALUES ('delete', old.rowid, old.content, old.session_id);
                INSERT INTO ai_chat_messages_fts(rowid, content, session_id)
                VALUES (new.rowid, new.content, new.session_id);
            END;

            INSERT OR IGNORE INTO settings (key, value) VALUES ('voice_chat_allow_cloud', 'false');
            ",
        )
        .map_err(|e| IronMicError::Storage(format!("Migration v9 failed: {e}")))?;

        info!("Migration v9 applied: ai_chat_sessions + ai_chat_messages + FTS5");
        Ok(())
    }

    /// Migration v10: Intelligent polish + meeting summary formatting.
    ///
    /// Schema-content only — no column changes. Three things happen:
    ///   1. Seed the new "Auto" builtin template (`builtin-auto`).
    ///   2. Equality-guarded UPDATE on each of the 5 v4 builtin templates'
    ///      `llm_prompt` content. The guard preserves user customizations
    ///      (if/when the UI permits editing builtin prompts) by only
    ///      writing when the current value matches the v4 baseline byte-
    ///      for-byte.
    ///   3. Default-flip: set `meeting_default_template = 'builtin-auto'`
    ///      for users where it's still the v4 default empty string.
    ///   4. Seed `polish_format_mode = 'rich'` for users where the setting
    ///      isn't yet present.
    ///
    /// Existing installs migrate to the upgraded prompts atomically here.
    /// Fresh installs get the same prompts via `seed_builtin_templates`,
    /// which is updated to seed v10 prompts directly (the new Auto plus
    /// the upgraded 5 — see below).
    fn migrate_v10(&self, conn: &Connection) -> Result<(), IronMicError> {
        use crate::llm::v4_template_prompts as t;
        let now = chrono::Utc::now().to_rfc3339();

        // 1. Seed the new "Auto" template. Idempotent on builtin-auto id.
        conn.execute(
            "INSERT OR IGNORE INTO meeting_templates
                (id, name, meeting_type, sections, llm_prompt, display_layout, is_builtin, created_at, updated_at)
             VALUES ('builtin-auto', ?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)",
            rusqlite::params![
                t::AUTO_TEMPLATE_NAME,
                t::AUTO_TEMPLATE_TYPE,
                t::AUTO_TEMPLATE_SECTIONS,
                t::AUTO_TEMPLATE_PROMPT,
                t::AUTO_TEMPLATE_LAYOUT,
                now,
            ],
        )
        .map_err(|e| IronMicError::Storage(format!("Migration v10 seed Auto failed: {e}")))?;

        // 2. Upgrade the 5 existing builtin templates' prompts.
        // Conditional UPDATE — fires only when current llm_prompt matches
        // the v4 baseline (byte-equal). Preserves user customizations.
        let upgrades: [(&str, &str, &str); 5] = [
            ("builtin-standup",  t::V4_STANDUP_PROMPT,   t::V10_STANDUP_PROMPT),
            ("builtin-1on1",     t::V4_1ON1_PROMPT,      t::V10_1ON1_PROMPT),
            ("builtin-discovery", t::V4_DISCOVERY_PROMPT, t::V10_DISCOVERY_PROMPT),
            ("builtin-team-sync", t::V4_TEAM_SYNC_PROMPT, t::V10_TEAM_SYNC_PROMPT),
            ("builtin-retro",    t::V4_RETRO_PROMPT,     t::V10_RETRO_PROMPT),
        ];
        for (id, expected, replacement) in upgrades.iter() {
            conn.execute(
                "UPDATE meeting_templates
                 SET llm_prompt = ?2, updated_at = ?3
                 WHERE id = ?1 AND llm_prompt = ?4",
                rusqlite::params![id, replacement, now, expected],
            )
            .map_err(|e| IronMicError::Storage(format!("Migration v10 upgrade {id} failed: {e}")))?;
        }

        // 3. Default-flip meeting_default_template only when still empty.
        // Preserves any user-set choice (including legacy template IDs).
        conn.execute(
            "UPDATE settings SET value = 'builtin-auto'
             WHERE key = 'meeting_default_template' AND value = ''",
            [],
        )
        .map_err(|e| IronMicError::Storage(format!("Migration v10 default flip failed: {e}")))?;

        // 4. Seed polish_format_mode = 'rich' (idempotent).
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value)
             VALUES ('polish_format_mode', 'rich')",
            [],
        )
        .map_err(|e| IronMicError::Storage(format!("Migration v10 settings seed failed: {e}")))?;

        info!("Migration v10 applied: Auto template seeded, 5 builtin prompts upgraded, polish_format_mode default seeded");
        Ok(())
    }

    /// Migration v11: simplify the Default (formerly "Auto") template.
    ///
    /// The v10 prompt asked the local Phi-3-mini-Q2_K to (a) classify the
    /// meeting type into one of 8 categories and (b) emit a layout from a
    /// per-category spec. Too much instruction-following for the small
    /// model — it routinely returned the `[INSUFFICIENT_CONTENT]` escape
    /// hatch on perfectly good transcripts. v11 replaces that with a
    /// single fixed structured layout (TL;DR / Decisions / Discussion /
    /// Action Items / Open Questions) that both local and cloud models
    /// follow reliably, and renames the user-facing label from
    /// "Auto (smart format)" → "Default".
    ///
    /// Equality guards on the v10 baseline preserve any user-customized
    /// builtin-auto rows (if/when the UI ever permits editing builtin
    /// templates).
    fn migrate_v11(&self, conn: &Connection) -> Result<(), IronMicError> {
        use crate::llm::v4_template_prompts as t;
        let now = chrono::Utc::now().to_rfc3339();

        // Update name + prompt + sections + layout in a single statement
        // so a partial v10 row (e.g. user customized only the prompt)
        // doesn't get split between v10/v11 shapes.
        conn.execute(
            "UPDATE meeting_templates
             SET name = ?1,
                 llm_prompt = ?2,
                 sections = ?3,
                 display_layout = ?4,
                 updated_at = ?5
             WHERE id = 'builtin-auto'
               AND name = ?6
               AND llm_prompt = ?7",
            rusqlite::params![
                t::AUTO_TEMPLATE_NAME,           // ?1 — new name "Default"
                t::AUTO_TEMPLATE_PROMPT,         // ?2 — new simplified prompt
                t::AUTO_TEMPLATE_SECTIONS,       // ?3 — new sections list
                t::AUTO_TEMPLATE_LAYOUT,         // ?4 — new layout
                now,                             // ?5 — updated_at
                t::V10_AUTO_TEMPLATE_NAME,       // ?6 — equality guard (name)
                t::V10_AUTO_TEMPLATE_PROMPT,     // ?7 — equality guard (prompt)
            ],
        )
        .map_err(|e| IronMicError::Storage(format!("Migration v11 update Default template failed: {e}")))?;

        info!("Migration v11 applied: Default template prompt simplified, name updated");
        Ok(())
    }

    /// Migration v12: add Date / Attendees / Overview to the Default
    /// template, and emphasize Action Items in the prompt body.
    ///
    /// The v11 prompt produced TL;DR / Decisions / Discussion / Action
    /// Items / Open Questions. Per user feedback we now want every
    /// generated meeting note to start with date + attendees clearly,
    /// rename TL;DR → Overview, and try harder to surface action items.
    /// Caller (SummaryGenerator) prepends a `[MEETING METADATA]` block
    /// to the transcript so the LLM has accurate values for Date and
    /// Attendees instead of guessing from filler.
    ///
    /// Equality-guarded on the v11 baseline name + prompt so user
    /// customizations are preserved.
    fn migrate_v12(&self, conn: &Connection) -> Result<(), IronMicError> {
        use crate::llm::v4_template_prompts as t;
        let now = chrono::Utc::now().to_rfc3339();

        conn.execute(
            "UPDATE meeting_templates
             SET llm_prompt = ?1,
                 sections = ?2,
                 display_layout = ?3,
                 updated_at = ?4
             WHERE id = 'builtin-auto'
               AND llm_prompt = ?5
               AND sections = ?6
               AND display_layout = ?7",
            rusqlite::params![
                t::AUTO_TEMPLATE_PROMPT,         // ?1 — new v12 prompt
                t::AUTO_TEMPLATE_SECTIONS,       // ?2 — new sections list
                t::AUTO_TEMPLATE_LAYOUT,         // ?3 — new layout
                now,                             // ?4 — updated_at
                t::V11_AUTO_TEMPLATE_PROMPT,     // ?5 — v11 prompt guard
                t::V11_AUTO_TEMPLATE_SECTIONS,   // ?6 — v11 sections guard
                t::V11_AUTO_TEMPLATE_LAYOUT,     // ?7 — v11 layout guard
            ],
        )
        .map_err(|e| IronMicError::Storage(format!("Migration v12 update Default template failed: {e}")))?;

        info!("Migration v12 applied: Default template now includes Date + Attendees + Overview, emphasizes Action Items");
        Ok(())
    }

    /// Migration v13: Knowledge Q&A (RAG) layer.
    ///
    /// (Originally drafted as v10 in `feature/knowledge-qa-foundation`; main
    /// landed three meeting-template migrations (v10/v11/v12) before this
    /// merge, so the RAG migration is renumbered v13. The migration body is
    /// unchanged.)
    ///
    /// Adds three things in one block so the new feature has everything it needs:
    ///
    /// 1. **user_notes / user_notebooks (+ FTS5)** — promotes user-authored notes
    ///    from renderer localStorage to first-class SQLite citizens so RAG, full-text
    ///    search, citations, and deeplinks can reference them. The renderer performs
    ///    a one-shot localStorage→SQLite import guarded by the
    ///    `notes_migrated_to_sqlite` setting flag.
    /// 2. **chunks / chunks_fts** — retrievable units carved from entries, meetings,
    ///    meeting transcript segments, and user notes. Chunk text is stored
    ///    alongside its metadata so provenance display is instant and we never
    ///    re-chunk on retrieval.
    /// 3. **chunk_embeddings** — keyed by (chunk_id, model_version) so multiple
    ///    embedding models can coexist during lazy migration. The legacy
    ///    `embeddings` table (PK content_id+content_type) is left untouched; new
    ///    chunk-level vectors live here. ON DELETE CASCADE keeps things tidy when
    ///    a chunk is removed.
    /// 4. **ai_chat_sessions.kind** — distinguishes regular chat from knowledge Q&A
    ///    sessions without overloading `provider` (renderer types coerce unknown
    ///    provider strings to null and would lose history rows). Defaults to
    ///    `'chat'`; new Q&A turns persist as `'knowledge'`.
    ///
    /// Plus seeds the new RAG-related settings with privacy-safe defaults.
    fn migrate_v13(&self, conn: &Connection) -> Result<(), IronMicError> {
        // ── ai_chat_sessions.kind (defensive — check first so partial application
        //    or future rebases over a hand-applied column don't error) ──
        let mut stmt = conn
            .prepare("PRAGMA table_info(ai_chat_sessions)")
            .map_err(|e| IronMicError::Storage(format!("Migration v13 prepare failed: {e}")))?;
        let mut kind_exists = false;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| IronMicError::Storage(format!("Migration v13 query failed: {e}")))?;
        for col in rows.flatten() {
            if col == "kind" {
                kind_exists = true;
                break;
            }
        }
        drop(stmt);

        if !kind_exists {
            conn.execute_batch(
                "ALTER TABLE ai_chat_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';",
            )
            .map_err(|e| IronMicError::Storage(format!("Migration v13 kind ALTER failed: {e}")))?;
        }

        conn.execute_batch(
            "
            -- ── user_notes (replaces localStorage-backed useNotesStore) ──
            CREATE TABLE IF NOT EXISTS user_notes (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL DEFAULT '',
                polished_content TEXT,
                display_mode TEXT NOT NULL DEFAULT 'raw',
                notebook_id TEXT,
                tags TEXT NOT NULL DEFAULT '[]',
                is_pinned INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_user_notes_notebook ON user_notes(notebook_id);
            CREATE INDEX IF NOT EXISTS idx_user_notes_updated ON user_notes(updated_at);

            CREATE TABLE IF NOT EXISTS user_notebooks (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                color TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            -- FTS5 over notes (mirrors entries_fts pattern)
            CREATE VIRTUAL TABLE IF NOT EXISTS user_notes_fts USING fts5(
                title,
                content,
                polished_content,
                tags,
                content='user_notes',
                content_rowid='rowid'
            );

            CREATE TRIGGER IF NOT EXISTS user_notes_ai AFTER INSERT ON user_notes BEGIN
                INSERT INTO user_notes_fts(rowid, title, content, polished_content, tags)
                VALUES (new.rowid, new.title, new.content, new.polished_content, new.tags);
            END;

            CREATE TRIGGER IF NOT EXISTS user_notes_ad AFTER DELETE ON user_notes BEGIN
                INSERT INTO user_notes_fts(user_notes_fts, rowid, title, content, polished_content, tags)
                VALUES ('delete', old.rowid, old.title, old.content, old.polished_content, old.tags);
            END;

            CREATE TRIGGER IF NOT EXISTS user_notes_au AFTER UPDATE ON user_notes BEGIN
                INSERT INTO user_notes_fts(user_notes_fts, rowid, title, content, polished_content, tags)
                VALUES ('delete', old.rowid, old.title, old.content, old.polished_content, old.tags);
                INSERT INTO user_notes_fts(rowid, title, content, polished_content, tags)
                VALUES (new.rowid, new.title, new.content, new.polished_content, new.tags);
            END;

            -- ── chunks (RAG retrievable units) ──
            CREATE TABLE IF NOT EXISTS chunks (
                id TEXT PRIMARY KEY,
                source_type TEXT NOT NULL,
                source_id TEXT NOT NULL,
                parent_id TEXT,
                chunk_index INTEGER NOT NULL,
                text TEXT NOT NULL,
                context_prefix TEXT,
                char_start INTEGER,
                char_end INTEGER,
                start_ms INTEGER,
                end_ms INTEGER,
                speaker_label TEXT,
                heading_path TEXT,
                token_count INTEGER,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_type, source_id);
            CREATE INDEX IF NOT EXISTS idx_chunks_parent ON chunks(parent_id);

            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                text,
                context_prefix,
                content='chunks',
                content_rowid='rowid'
            );

            CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
                INSERT INTO chunks_fts(rowid, text, context_prefix)
                VALUES (new.rowid, new.text, new.context_prefix);
            END;

            CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
                INSERT INTO chunks_fts(chunks_fts, rowid, text, context_prefix)
                VALUES ('delete', old.rowid, old.text, old.context_prefix);
            END;

            CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
                INSERT INTO chunks_fts(chunks_fts, rowid, text, context_prefix)
                VALUES ('delete', old.rowid, old.text, old.context_prefix);
                INSERT INTO chunks_fts(rowid, text, context_prefix)
                VALUES (new.rowid, new.text, new.context_prefix);
            END;

            -- ── chunk_embeddings (per-(chunk, model) Float32 BLOBs) ──
            -- Distinct table from legacy `embeddings` so multiple model_versions can
            -- coexist during lazy re-embedding migrations (legacy PK is
            -- content_id+content_type, which clobbers older vectors on REPLACE).
            CREATE TABLE IF NOT EXISTS chunk_embeddings (
                chunk_id TEXT NOT NULL,
                model_version TEXT NOT NULL,
                dim INTEGER NOT NULL,
                embedding BLOB NOT NULL,
                embedded_at TEXT NOT NULL,
                PRIMARY KEY (chunk_id, model_version),
                FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_model ON chunk_embeddings(model_version);

            -- ── Knowledge Q&A settings (all opt-in / privacy-safe defaults) ──
            INSERT OR IGNORE INTO settings (key, value) VALUES ('knowledge_qa_enabled', 'true');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('knowledge_qa_allow_cloud', 'false');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('knowledge_qa_default_provider', 'auto');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('embedding_active_model', 'bge-small-en-v1.5');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('rag_chunk_size_tokens', '400');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('rag_chunk_overlap_tokens', '50');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('rag_contextual_prefix_enabled', 'true');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('rag_topic_k_local', '8');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('rag_topic_k_cloud', '30');
            -- Renderer flips this to 'true' after the one-shot localStorage import.
            INSERT OR IGNORE INTO settings (key, value) VALUES ('notes_migrated_to_sqlite', 'false');
            ",
        )
        .map_err(|e| IronMicError::Storage(format!("Migration v13 failed: {e}")))?;

        info!("Migration v13 applied: user_notes + chunks + chunk_embeddings + ai_chat_sessions.kind + RAG settings");
        Ok(())
    }

    /// Migration v14: Seed `meeting_transcription_engine` default.
    ///
    /// Meetings benefit from Whisper Large's accuracy (they process audio in
    /// 30 s+ chunks, so first-chunk latency doesn't matter). MeetingPage reads
    /// this on meeting start and writes the existing `transcription_engine`
    /// key to trigger the native engine swap; on meeting end it restores the
    /// prior dictation engine.
    ///
    /// Uses INSERT OR IGNORE so existing installs that have already been
    /// fiddling with this key (e.g. via manual SQL) keep their value. The new
    /// migration step (rather than editing v1's seed) is what makes this safe
    /// to ship — v1 already ran on every existing install.
    fn migrate_v14(&self, conn: &Connection) -> Result<(), IronMicError> {
        conn.execute_batch(
            "
            INSERT OR IGNORE INTO settings (key, value)
                VALUES ('meeting_transcription_engine', 'whisper-large-v3-turbo');
            ",
        )
        .map_err(|e| IronMicError::Storage(format!("Migration v14 failed: {e}")))?;

        info!("Migration v14 applied: meeting_transcription_engine default");
        Ok(())
    }

    /// Migration v15: speaker diarization plumbing. Adds per-segment speaker
    /// embedding columns to `transcript_segments` and seeds the new
    /// `meeting_diarization_*` settings. M1 ships with mode = 'off' so live
    /// behavior is unchanged; the M2 runtime readiness check flips it once
    /// the WeSpeaker model is bundled. Allowed mode values: 'off' /
    /// 'embedding' / 'llm-text'.
    ///
    /// Idempotent: ALTER TABLE ADD COLUMN is wrapped in best-effort error
    /// handling so re-running on a partially-migrated DB is safe.
    fn migrate_v15(&self, conn: &Connection) -> Result<(), IronMicError> {
        // `ALTER TABLE ADD COLUMN` errors if the column already exists. Run
        // each statement individually and swallow "duplicate column" errors
        // so the migration is idempotent on partial state.
        let alters = [
            "ALTER TABLE transcript_segments ADD COLUMN speaker_embedding BLOB",
            "ALTER TABLE transcript_segments ADD COLUMN speaker_embedding_model TEXT",
            "ALTER TABLE transcript_segments ADD COLUMN diarization_confidence REAL",
        ];
        for stmt in alters {
            if let Err(e) = conn.execute(stmt, []) {
                let msg = e.to_string();
                if !msg.contains("duplicate column name") {
                    return Err(IronMicError::Storage(format!(
                        "Migration v15 failed on `{stmt}`: {e}"
                    )));
                }
            }
        }

        conn.execute_batch(
            "
            CREATE INDEX IF NOT EXISTS idx_transcript_segments_session_source
                ON transcript_segments(session_id, source);

            INSERT OR IGNORE INTO settings (key, value) VALUES
                ('meeting_diarization_mode', 'off'),
                ('meeting_diarization_threshold', '0.55'),
                ('meeting_diarization_max_speakers', '20'),
                ('meeting_diarization_min_slice_ms', '800'),
                ('meeting_diarization_max_slice_ms', '6000'),
                ('meeting_diarization_user_overridden', 'false'),
                ('meeting_llm_name_pass_enabled', 'false');
            ",
        )
        .map_err(|e| IronMicError::Storage(format!("Migration v15 failed: {e}")))?;

        info!("Migration v15 applied: diarization columns + settings");
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
    fn schema_version_is_15() {
        // Pin SCHEMA_VERSION so accidentally regressing it (e.g. during a
        // rebase) fails loud. Diarization plumbing depends on v15.
        assert_eq!(SCHEMA_VERSION, 15);
    }

    #[test]
    fn migration_v15_adds_diarization_columns() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();

        // Confirm the three new columns exist on transcript_segments.
        let mut stmt = conn
            .prepare("PRAGMA table_info(transcript_segments)")
            .unwrap();
        let cols: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        for required in [
            "speaker_embedding",
            "speaker_embedding_model",
            "diarization_confidence",
        ] {
            assert!(
                cols.iter().any(|c| c == required),
                "transcript_segments missing column `{}`; columns = {:?}",
                required,
                cols
            );
        }

        // Confirm the seven new settings landed with the documented defaults.
        for (key, expected) in [
            ("meeting_diarization_mode", "off"),
            ("meeting_diarization_threshold", "0.55"),
            ("meeting_diarization_max_speakers", "20"),
            ("meeting_diarization_min_slice_ms", "800"),
            ("meeting_diarization_max_slice_ms", "6000"),
            ("meeting_diarization_user_overridden", "false"),
            ("meeting_llm_name_pass_enabled", "false"),
        ] {
            let value: String = conn
                .query_row(
                    "SELECT value FROM settings WHERE key = ?1",
                    [key],
                    |row| row.get(0),
                )
                .unwrap_or_else(|_| panic!("missing setting `{}`", key));
            assert_eq!(value, expected, "setting `{}` has wrong default", key);
        }
    }

    #[test]
    fn migration_v10_seeds_auto_template_and_upgrades_builtins() {
        use crate::llm::v4_template_prompts as t;
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();

        // builtin-auto exists with the new prompt + sections.
        let auto_prompt: String = conn
            .query_row(
                "SELECT llm_prompt FROM meeting_templates WHERE id='builtin-auto'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(auto_prompt, t::AUTO_TEMPLATE_PROMPT);

        let auto_sections: String = conn
            .query_row(
                "SELECT sections FROM meeting_templates WHERE id='builtin-auto'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(auto_sections, t::AUTO_TEMPLATE_SECTIONS);

        // Each existing builtin was upgraded from V4 baseline to V10.
        // (Fresh-install path: v4 seeds V4, then v10 UPDATEs to V10.)
        for (id, expected) in [
            ("builtin-standup", t::V10_STANDUP_PROMPT),
            ("builtin-1on1", t::V10_1ON1_PROMPT),
            ("builtin-discovery", t::V10_DISCOVERY_PROMPT),
            ("builtin-team-sync", t::V10_TEAM_SYNC_PROMPT),
            ("builtin-retro", t::V10_RETRO_PROMPT),
        ] {
            let prompt: String = conn
                .query_row(
                    "SELECT llm_prompt FROM meeting_templates WHERE id=?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap_or_else(|e| panic!("failed to read {id}: {e}"));
            assert_eq!(prompt, expected, "template {id} not upgraded to V10");
        }

        // meeting_default_template flipped from '' to 'builtin-auto' on
        // the fresh install.
        let default_template: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key='meeting_default_template'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(default_template, "builtin-auto");

        // polish_format_mode seeded.
        let mode: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key='polish_format_mode'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(mode, "rich");
    }

    #[test]
    fn migration_v10_preserves_user_customized_templates() {
        // Simulate an existing install where the user customized a builtin
        // template's prompt before v10 ran. The equality guard should NOT
        // overwrite their customization.
        use crate::llm::v4_template_prompts as t;
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();

        // Replace standup prompt with a user-edited version (matches neither V4 nor V10).
        const USER_PROMPT: &str = "USER CUSTOM standup prompt — do not overwrite";
        conn.execute(
            "UPDATE meeting_templates SET llm_prompt = ?1 WHERE id = 'builtin-standup'",
            [USER_PROMPT],
        )
        .unwrap();

        // Re-run the v10 migration. (open_in_memory already ran it once;
        // call directly to simulate re-application as if a cold-resume hit
        // the migration again — defensive idempotency check.)
        db.migrate_v10(&conn).unwrap();

        // User customization preserved — equality guard prevents overwrite.
        let prompt: String = conn
            .query_row(
                "SELECT llm_prompt FROM meeting_templates WHERE id='builtin-standup'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(prompt, USER_PROMPT);

        // Other builtins still got the V10 upgrade — only the modified one was protected.
        let one_on_one: String = conn
            .query_row(
                "SELECT llm_prompt FROM meeting_templates WHERE id='builtin-1on1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(one_on_one, t::V10_1ON1_PROMPT);
    }

    #[test]
    fn migration_v11_renames_auto_to_default_and_simplifies_prompt() {
        use crate::llm::v4_template_prompts as t;
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();

        // After fresh install (which runs through v11), the Default template
        // exists with the simplified prompt + the new label.
        let (name, prompt, sections, layout): (String, String, String, String) = conn
            .query_row(
                "SELECT name, llm_prompt, sections, display_layout FROM meeting_templates WHERE id='builtin-auto'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(name, t::AUTO_TEMPLATE_NAME);
        assert_eq!(name, "Default");
        assert_eq!(prompt, t::AUTO_TEMPLATE_PROMPT);
        assert_eq!(sections, t::AUTO_TEMPLATE_SECTIONS);
        assert_eq!(layout, t::AUTO_TEMPLATE_LAYOUT);
        // The new prompt removes the [INSUFFICIENT_CONTENT] escape hatch.
        assert!(!prompt.contains("INSUFFICIENT_CONTENT"));
    }

    #[test]
    fn migration_v11_preserves_user_customized_auto_template() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();

        // Simulate a user who customized the auto template post-v10.
        const USER_PROMPT: &str = "USER CUSTOMIZED auto prompt — do not overwrite";
        const USER_NAME: &str = "My Custom Auto";
        conn.execute(
            "UPDATE meeting_templates
             SET name = ?1, llm_prompt = ?2
             WHERE id = 'builtin-auto'",
            [USER_NAME, USER_PROMPT],
        )
        .unwrap();

        // Re-run v11 — it should be a no-op for this row because the
        // equality guard requires the v10 baseline name AND prompt.
        db.migrate_v11(&conn).unwrap();

        let (name, prompt): (String, String) = conn
            .query_row(
                "SELECT name, llm_prompt FROM meeting_templates WHERE id='builtin-auto'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(name, USER_NAME);
        assert_eq!(prompt, USER_PROMPT);
    }

    #[test]
    fn migration_v12_adds_attendees_overview_to_default() {
        use crate::llm::v4_template_prompts as t;
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();

        let (prompt, sections, layout): (String, String, String) = conn
            .query_row(
                "SELECT llm_prompt, sections, display_layout FROM meeting_templates WHERE id='builtin-auto'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(prompt, t::AUTO_TEMPLATE_PROMPT);
        assert_eq!(sections, t::AUTO_TEMPLATE_SECTIONS);
        assert_eq!(layout, t::AUTO_TEMPLATE_LAYOUT);
        // Spot-check the new section keys are in the sections JSON.
        assert!(sections.contains("attendees"));
        assert!(sections.contains("overview"));
        // Date intentionally NOT in the layout — meeting header shows it.
        assert!(!sections.contains("\"date\""));
        // Spot-check the new prompt content references the new sections.
        assert!(prompt.contains("## Attendees"));
        assert!(prompt.contains("## Overview"));
        assert!(!prompt.contains("## TL;DR"));
        assert!(!prompt.contains("## Date"));
        // Action items emphasis verbiage is present.
        assert!(prompt.to_lowercase().contains("action items are usually the most valuable"));
    }

    #[test]
    fn migration_v12_preserves_user_customized_default() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();

        // Simulate a user who customized the Default template after v11.
        const USER_PROMPT: &str = "USER CUSTOMIZED default — do not overwrite";
        conn.execute(
            "UPDATE meeting_templates
             SET llm_prompt = ?1
             WHERE id = 'builtin-auto'",
            [USER_PROMPT],
        )
        .unwrap();

        // Re-run v12; equality guard requires v11 baseline prompt match.
        db.migrate_v12(&conn).unwrap();

        let prompt: String = conn
            .query_row(
                "SELECT llm_prompt FROM meeting_templates WHERE id='builtin-auto'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(prompt, USER_PROMPT);
    }

    #[test]
    fn migration_v10_preserves_user_default_template_choice() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();

        // Simulate user picking a non-empty default before v10.
        conn.execute(
            "UPDATE settings SET value = 'builtin-retro' WHERE key = 'meeting_default_template'",
            [],
        )
        .unwrap();

        // Re-run v10.
        db.migrate_v10(&conn).unwrap();

        // User's choice preserved — only empty values get flipped to builtin-auto.
        let chosen: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key='meeting_default_template'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(chosen, "builtin-retro");
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
    fn migration_v13_creates_rag_tables_and_settings() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();

        // user_notes + user_notebooks + user_notes_fts exist
        for table in &["user_notes", "user_notebooks", "user_notes_fts", "chunks", "chunks_fts", "chunk_embeddings"] {
            let count: i32 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name=?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(count >= 1, "expected table or fts vtable {} to exist", table);
        }

        // ai_chat_sessions has the new `kind` column with default 'chat'
        let mut stmt = conn.prepare("PRAGMA table_info(ai_chat_sessions)").unwrap();
        let cols: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .flatten()
            .collect();
        assert!(cols.contains(&"kind".to_string()), "ai_chat_sessions.kind missing");

        // RAG settings seeded with privacy-safe defaults
        let cloud_default: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key='knowledge_qa_allow_cloud'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cloud_default, "false", "cloud Q&A must default to off");

        let model_default: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key='embedding_active_model'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(model_default, "bge-small-en-v1.5");

        let migrated: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key='notes_migrated_to_sqlite'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(migrated, "false", "renderer flips this after the one-shot import");
    }

    #[test]
    fn user_notes_fts_roundtrip() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();

        // Insert a note via the trigger-fed path so FTS gets populated.
        conn.execute(
            "INSERT INTO user_notes (id, title, content, polished_content, display_mode, notebook_id, tags, is_pinned, created_at, updated_at)
             VALUES ('n1', 'Auth migration', 'We will need to migrate auth before Q3', NULL, 'raw', NULL, '[]', 0, '2026-05-09T10:00:00Z', '2026-05-09T10:00:00Z')",
            [],
        ).unwrap();

        let hits: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM user_notes_fts WHERE user_notes_fts MATCH 'auth migration'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1, "user_notes_fts should find the inserted note");
    }

    #[test]
    fn chunk_embeddings_cascade_on_chunk_delete() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();

        conn.execute(
            "INSERT INTO chunks (id, source_type, source_id, chunk_index, text, token_count, created_at)
             VALUES ('c1', 'user_note', 'n1', 0, 'hello world', 2, '2026-05-09T10:00:00Z')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO chunk_embeddings (chunk_id, model_version, dim, embedding, embedded_at)
             VALUES ('c1', 'bge-small-en-v1.5', 384, x'00', '2026-05-09T10:00:00Z')",
            [],
        ).unwrap();

        // Deleting the chunk should cascade-delete its embedding via the FK.
        conn.execute("DELETE FROM chunks WHERE id='c1'", []).unwrap();
        let remaining: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM chunk_embeddings WHERE chunk_id='c1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 0, "ON DELETE CASCADE should remove the embedding");
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
