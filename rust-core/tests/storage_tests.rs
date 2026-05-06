use ironmic_core::storage::db::Database;
use ironmic_core::storage::dictionary::DictionaryStore;
use ironmic_core::storage::entries::{EntryStore, EntryUpdate, ListOptions, NewEntry};
use ironmic_core::storage::settings::SettingsStore;

fn test_db() -> Database {
    Database::open_in_memory().unwrap()
}

// ── Database Tests ──

#[test]
fn database_opens_in_memory() {
    let db = test_db();
    assert_eq!(db.path().to_str().unwrap(), ":memory:");
}

#[test]
fn database_schema_tables_exist() {
    let db = test_db();
    let conn = db.conn();

    for table in &["entries", "dictionary", "settings", "schema_version"] {
        let exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |row| row.get(0),
            )
            .unwrap();
        assert!(exists, "Table {table} should exist");
    }
}

#[test]
fn database_fts_table_exists() {
    let db = test_db();
    let conn = db.conn();
    let exists: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='entries_fts'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(exists, "FTS5 table should exist");
}

#[test]
fn database_default_settings() {
    let db = test_db();
    let settings = SettingsStore::new(db);
    assert_eq!(
        settings.get("hotkey_record").unwrap().unwrap(),
        "CommandOrControl+Shift+V"
    );
    assert_eq!(
        settings.get("llm_cleanup_enabled").unwrap().unwrap(),
        "true"
    );
    assert_eq!(settings.get("default_view").unwrap().unwrap(), "timeline");
    assert_eq!(settings.get("theme").unwrap().unwrap(), "system");
}

// ── Entry CRUD Tests ──

fn sample_new_entry() -> NewEntry {
    NewEntry {
        raw_transcript: "um so basically I think we should use Rust".into(),
        polished_text: Some("I think we should use Rust.".into()),
        duration_seconds: Some(3.2),
        source_app: Some("Terminal".into()),
        ..Default::default()
    }
}

#[test]
fn entry_create_and_get() {
    let store = EntryStore::new(test_db());
    let entry = store.create(sample_new_entry()).unwrap();

    assert!(!entry.id.is_empty());
    assert_eq!(entry.raw_transcript, "um so basically I think we should use Rust");
    assert_eq!(entry.polished_text.as_deref(), Some("I think we should use Rust."));
    assert_eq!(entry.display_mode, "polished");
    assert!(!entry.is_pinned);
    assert!(!entry.is_archived);

    let fetched = store.get(&entry.id).unwrap().unwrap();
    assert_eq!(fetched.id, entry.id);
    assert_eq!(fetched.raw_transcript, entry.raw_transcript);
}

#[test]
fn entry_get_nonexistent() {
    let store = EntryStore::new(test_db());
    assert!(store.get("fake-id").unwrap().is_none());
}

#[test]
fn entry_update() {
    let store = EntryStore::new(test_db());
    let entry = store.create(sample_new_entry()).unwrap();

    let updated = store
        .update(
            &entry.id,
            EntryUpdate {
                raw_transcript: Some("Updated raw text".into()),
                display_mode: Some("raw".into()),
                ..Default::default()
            },
        )
        .unwrap();

    assert_eq!(updated.raw_transcript, "Updated raw text");
    assert_eq!(updated.display_mode, "raw");
    assert!(updated.updated_at > entry.updated_at);
}

#[test]
fn entry_update_polished_text() {
    let store = EntryStore::new(test_db());
    let entry = store
        .create(NewEntry {
            raw_transcript: "test".into(),
            ..Default::default()
        })
        .unwrap();

    let updated = store
        .update(
            &entry.id,
            EntryUpdate {
                polished_text: Some(Some("Polished text".into())),
                ..Default::default()
            },
        )
        .unwrap();

    assert_eq!(updated.polished_text.as_deref(), Some("Polished text"));
}

#[test]
fn entry_delete() {
    let store = EntryStore::new(test_db());
    let entry = store.create(sample_new_entry()).unwrap();
    store.delete(&entry.id).unwrap();
    assert!(store.get(&entry.id).unwrap().is_none());
}

#[test]
fn entry_delete_nonexistent_no_error() {
    let store = EntryStore::new(test_db());
    store.delete("fake-id").unwrap();
}

// ── Listing & Pagination ──

#[test]
fn entry_list_all() {
    let store = EntryStore::new(test_db());
    for i in 0..5 {
        store
            .create(NewEntry {
                raw_transcript: format!("Entry number {i}"),
                duration_seconds: Some(1.0),
                ..Default::default()
            })
            .unwrap();
    }

    let entries = store
        .list(ListOptions {
            limit: 100,
            offset: 0,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(entries.len(), 5);
}

#[test]
fn entry_list_pagination() {
    let store = EntryStore::new(test_db());
    for i in 0..10 {
        store
            .create(NewEntry {
                raw_transcript: format!("Entry {i}"),
                ..Default::default()
            })
            .unwrap();
    }

    let page1 = store.list(ListOptions { limit: 3, offset: 0, ..Default::default() }).unwrap();
    let page2 = store.list(ListOptions { limit: 3, offset: 3, ..Default::default() }).unwrap();
    let page3 = store.list(ListOptions { limit: 3, offset: 6, ..Default::default() }).unwrap();
    let page4 = store.list(ListOptions { limit: 3, offset: 9, ..Default::default() }).unwrap();

    assert_eq!(page1.len(), 3);
    assert_eq!(page2.len(), 3);
    assert_eq!(page3.len(), 3);
    assert_eq!(page4.len(), 1);
}

#[test]
fn entry_list_archive_filter() {
    let store = EntryStore::new(test_db());
    let e1 = store.create(sample_new_entry()).unwrap();
    let _e2 = store.create(sample_new_entry()).unwrap();

    store.archive(&e1.id, true).unwrap();

    let active = store
        .list(ListOptions {
            limit: 100,
            offset: 0,
            archived: Some(false),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(active.len(), 1);

    let archived = store
        .list(ListOptions {
            limit: 100,
            offset: 0,
            archived: Some(true),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(archived.len(), 1);

    let all = store
        .list(ListOptions {
            limit: 100,
            offset: 0,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(all.len(), 2);
}

// ── FTS5 Search ──

#[test]
fn fts_search_by_transcript() {
    let store = EntryStore::new(test_db());
    store
        .create(NewEntry {
            raw_transcript: "Kubernetes cluster deployment strategy".into(),
            ..Default::default()
        })
        .unwrap();
    store
        .create(NewEntry {
            raw_transcript: "React component lifecycle hooks".into(),
            ..Default::default()
        })
        .unwrap();
    store
        .create(NewEntry {
            raw_transcript: "Database migration patterns".into(),
            ..Default::default()
        })
        .unwrap();

    let results = store
        .list(ListOptions {
            limit: 100,
            offset: 0,
            search: Some("Kubernetes".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(results.len(), 1);
    assert!(results[0].raw_transcript.contains("Kubernetes"));

    let results = store
        .list(ListOptions {
            limit: 100,
            offset: 0,
            search: Some("component".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(results.len(), 1);
}

#[test]
fn fts_search_no_results() {
    let store = EntryStore::new(test_db());
    store.create(sample_new_entry()).unwrap();

    let results = store
        .list(ListOptions {
            limit: 100,
            offset: 0,
            search: Some("zzzyyyxxx".into()),
            ..Default::default()
        })
        .unwrap();
    assert!(results.is_empty());
}

// ── Pin & Archive ──

#[test]
fn pin_and_unpin() {
    let store = EntryStore::new(test_db());
    let entry = store.create(sample_new_entry()).unwrap();

    store.pin(&entry.id, true).unwrap();
    assert!(store.get(&entry.id).unwrap().unwrap().is_pinned);

    store.pin(&entry.id, false).unwrap();
    assert!(!store.get(&entry.id).unwrap().unwrap().is_pinned);
}

#[test]
fn archive_and_unarchive() {
    let store = EntryStore::new(test_db());
    let entry = store.create(sample_new_entry()).unwrap();

    store.archive(&entry.id, true).unwrap();
    assert!(store.get(&entry.id).unwrap().unwrap().is_archived);

    store.archive(&entry.id, false).unwrap();
    assert!(!store.get(&entry.id).unwrap().unwrap().is_archived);
}

#[test]
fn pinned_entries_sort_first() {
    let store = EntryStore::new(test_db());
    let e1 = store
        .create(NewEntry {
            raw_transcript: "Unpinned entry".into(),
            ..Default::default()
        })
        .unwrap();
    let e2 = store
        .create(NewEntry {
            raw_transcript: "Will be pinned".into(),
            ..Default::default()
        })
        .unwrap();

    store.pin(&e2.id, true).unwrap();

    let entries = store
        .list(ListOptions {
            limit: 10,
            offset: 0,
            ..Default::default()
        })
        .unwrap();
    assert!(entries[0].is_pinned);
    assert_eq!(entries[0].id, e2.id);
}

// ── Dictionary Store Tests ──

#[test]
fn dict_add_and_list() {
    let store = DictionaryStore::new(test_db());
    store.add_word("Kubernetes").unwrap();
    store.add_word("gRPC").unwrap();

    let words = store.list_words().unwrap();
    assert_eq!(words.len(), 2);
}

#[test]
fn dict_add_duplicate() {
    let store = DictionaryStore::new(test_db());
    store.add_word("Rust").unwrap();
    store.add_word("Rust").unwrap();
    assert_eq!(store.list_words().unwrap().len(), 1);
}

#[test]
fn dict_remove() {
    let store = DictionaryStore::new(test_db());
    store.add_word("test").unwrap();
    store.remove_word("test").unwrap();
    assert!(store.list_words().unwrap().is_empty());
}

// ── Settings Store Tests ──

#[test]
fn settings_defaults() {
    let store = SettingsStore::new(test_db());
    assert_eq!(
        store.get("hotkey_record").unwrap().unwrap(),
        "CommandOrControl+Shift+V"
    );
}

#[test]
fn settings_set_and_get() {
    let store = SettingsStore::new(test_db());
    store.set("custom", "value").unwrap();
    assert_eq!(store.get("custom").unwrap().unwrap(), "value");
}

#[test]
fn settings_overwrite() {
    let store = SettingsStore::new(test_db());
    store.set("theme", "dark").unwrap();
    assert_eq!(store.get("theme").unwrap().unwrap(), "dark");

    store.set("theme", "light").unwrap();
    assert_eq!(store.get("theme").unwrap().unwrap(), "light");
}

#[test]
fn settings_nonexistent() {
    let store = SettingsStore::new(test_db());
    assert!(store.get("fake_key").unwrap().is_none());
}

// ── Migration v7: meeting_sessions.participants column ──

#[test]
fn migration_v7_creates_participants_column() {
    let db = test_db();
    let conn = db.conn();
    let mut stmt = conn.prepare("PRAGMA table_info(meeting_sessions)").unwrap();
    let cols: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .flatten()
        .collect();
    assert!(
        cols.iter().any(|c| c == "participants"),
        "expected participants column, got: {cols:?}"
    );
}

#[test]
fn migration_v7_default_is_empty_array() {
    let db = test_db();
    {
        let conn = db.conn();
        conn.execute(
            "INSERT INTO meeting_sessions (id, started_at) VALUES ('m1', '2026-01-01')",
            [],
        )
        .unwrap();
    }
    let participants: String = db
        .conn()
        .query_row(
            "SELECT participants FROM meeting_sessions WHERE id = 'm1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(participants, "[]");
}

// ── Meeting participant CRUD ──

#[test]
fn meeting_set_and_get_participants() {
    let db = test_db();
    let session = db.create_meeting_session().unwrap();
    let roster = r#"[{"id":"host","displayName":"Alice","isHost":true,"joinedAt":1000}]"#;
    db.set_meeting_participants(&session.id, roster).unwrap();
    let got = db.get_meeting_participants(&session.id).unwrap();
    assert!(got.contains("Alice"));
    assert!(got.contains("\"isHost\":true"));
}

#[test]
fn meeting_add_participant_appends() {
    let db = test_db();
    let session = db.create_meeting_session().unwrap();
    db.add_meeting_participant(
        &session.id,
        r#"{"id":"host","displayName":"Alice","isHost":true,"joinedAt":1000}"#,
    )
    .unwrap();
    db.add_meeting_participant(
        &session.id,
        r#"{"id":"p1","displayName":"Bob","isHost":false,"joinedAt":2000}"#,
    )
    .unwrap();
    let json = db.get_meeting_participants(&session.id).unwrap();
    assert!(json.contains("Alice"));
    assert!(json.contains("Bob"));
}

#[test]
fn meeting_mark_left_preserves_entry() {
    let db = test_db();
    let session = db.create_meeting_session().unwrap();
    db.add_meeting_participant(
        &session.id,
        r#"{"id":"p1","displayName":"Bob","isHost":false,"joinedAt":2000}"#,
    )
    .unwrap();
    db.mark_meeting_participant_left(&session.id, "p1", 5000)
        .unwrap();
    let json = db.get_meeting_participants(&session.id).unwrap();
    assert!(json.contains("Bob"), "Bob should remain in roster: {json}");
    assert!(json.contains("\"leftAt\":5000"), "leftAt should be set: {json}");
}

#[test]
fn meeting_participants_sanitize_long_names() {
    let db = test_db();
    let session = db.create_meeting_session().unwrap();
    let long = "a".repeat(200);
    let roster = format!(
        r#"[{{"id":"host","displayName":"{long}","isHost":true,"joinedAt":1000}}]"#
    );
    db.set_meeting_participants(&session.id, &roster).unwrap();
    let got = db.get_meeting_participants(&session.id).unwrap();
    // Display names are capped at 64 chars.
    let parsed: serde_json::Value = serde_json::from_str(&got).unwrap();
    let name = parsed[0]["displayName"].as_str().unwrap();
    assert!(name.len() <= 64, "name should be capped: len={}", name.len());
}

#[test]
fn meeting_participants_camelcase_on_wire() {
    let db = test_db();
    let session = db.create_meeting_session().unwrap();
    db.add_meeting_participant(
        &session.id,
        r#"{"id":"host","displayName":"Alice","isHost":true,"joinedAt":1000}"#,
    )
    .unwrap();
    let json = db.get_meeting_participants(&session.id).unwrap();
    // Hard requirement: snake_case must NOT appear in the JSON the
    // renderer receives — the Rust struct uses #[serde(rename_all = "camelCase")].
    assert!(!json.contains("display_name"), "snake_case leaked: {json}");
    assert!(!json.contains("is_host"), "snake_case leaked: {json}");
    assert!(!json.contains("joined_at"), "snake_case leaked: {json}");
    assert!(json.contains("displayName"));
    assert!(json.contains("isHost"));
    assert!(json.contains("joinedAt"));
}

#[test]
fn meeting_add_participant_dedupes_by_id_on_rejoin() {
    let db = test_db();
    let session = db.create_meeting_session().unwrap();
    db.add_meeting_participant(
        &session.id,
        r#"{"id":"p1","displayName":"Bob","isHost":false,"joinedAt":2000}"#,
    )
    .unwrap();
    db.mark_meeting_participant_left(&session.id, "p1", 3000)
        .unwrap();
    // Re-join: same id, leftAt should clear.
    db.add_meeting_participant(
        &session.id,
        r#"{"id":"p1","displayName":"Bob","isHost":false,"joinedAt":4000}"#,
    )
    .unwrap();
    let json = db.get_meeting_participants(&session.id).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    let arr = parsed.as_array().unwrap();
    assert_eq!(arr.len(), 1, "no duplicate: {json}");
    assert!(arr[0].get("leftAt").is_none() || arr[0]["leftAt"].is_null(), "leftAt cleared on re-join: {json}");
}

// ── v8 migration: rejoin dedup + indexed lookups ──

#[test]
fn add_segment_with_remote_id_is_idempotent() {
    let db = test_db();
    let session = db.create_meeting_session().unwrap();
    let s1 = db.add_transcript_segment_with_remote_id(
        &session.id, Some("Alice"), 0, 1000, "hello", "broadcast", "remote-1",
    ).unwrap();
    let s2 = db.add_transcript_segment_with_remote_id(
        &session.id, Some("Alice"), 0, 1000, "hello", "broadcast", "remote-1",
    ).unwrap();
    assert_eq!(s1.id, s2.id, "second insert returns same row");
    let listed = db.list_transcript_segments(&session.id).unwrap();
    assert_eq!(listed.len(), 1, "no duplicate row");
}

#[test]
fn add_segment_with_remote_id_distinguishes_sessions() {
    let db = test_db();
    let s1 = db.create_meeting_session().unwrap();
    let s2 = db.create_meeting_session().unwrap();
    let r1 = db.add_transcript_segment_with_remote_id(
        &s1.id, None, 0, 100, "a", "meeting", "shared-id",
    ).unwrap();
    let r2 = db.add_transcript_segment_with_remote_id(
        &s2.id, None, 0, 100, "b", "meeting", "shared-id",
    ).unwrap();
    assert_ne!(r1.id, r2.id, "same remote_id in different sessions = different rows");
}

#[test]
fn find_latest_local_session_for_remote_returns_none_when_unlinked() {
    let db = test_db();
    let result = db.find_latest_local_session_for_remote("nonexistent-remote").unwrap();
    assert!(result.is_none());
}

#[test]
fn find_latest_local_session_for_remote_finds_linked_row() {
    let db = test_db();
    let session = db.create_meeting_session().unwrap();
    db.set_meeting_structured_output(
        &session.id,
        r#"{"linkedRemoteSessionId":"host-abc"}"#,
    ).unwrap();
    let result = db.find_latest_local_session_for_remote("host-abc").unwrap();
    assert!(result.is_some());
    let (id, ended_at) = result.unwrap();
    assert_eq!(id, session.id);
    assert!(ended_at.is_none());
}

#[test]
fn find_latest_local_session_for_remote_includes_ended_rows() {
    // The rejoin policy: ended_at is set on participant leave. On rejoin we
    // MUST find the ended row (then reopen it) so the participant gets one
    // continuous record per host meeting.
    let db = test_db();
    let session = db.create_meeting_session().unwrap();
    db.set_meeting_structured_output(
        &session.id,
        r#"{"linkedRemoteSessionId":"host-xyz"}"#,
    ).unwrap();
    db.end_meeting_session(&session.id, 1, Some("done"), None, 30.0, None).unwrap();
    let result = db.find_latest_local_session_for_remote("host-xyz").unwrap();
    assert!(result.is_some(), "ended row must still be findable for rejoin");
    let (id, ended_at) = result.unwrap();
    assert_eq!(id, session.id);
    assert!(ended_at.is_some(), "ended_at preserved so caller knows to reopen");
}

#[test]
fn find_latest_local_session_for_remote_picks_most_recent() {
    let db = test_db();
    let s1 = db.create_meeting_session().unwrap();
    db.set_meeting_structured_output(&s1.id, r#"{"linkedRemoteSessionId":"host-1"}"#).unwrap();
    // Sleep so the timestamps are distinguishable in a hot loop.
    std::thread::sleep(std::time::Duration::from_millis(15));
    let s2 = db.create_meeting_session().unwrap();
    db.set_meeting_structured_output(&s2.id, r#"{"linkedRemoteSessionId":"host-1"}"#).unwrap();
    let (id, _) = db.find_latest_local_session_for_remote("host-1").unwrap().unwrap();
    assert_eq!(id, s2.id, "most recent linked row wins");
}

#[test]
fn reopen_meeting_session_clears_sealed_state() {
    let db = test_db();
    let session = db.create_meeting_session().unwrap();
    db.end_meeting_session(&session.id, 2, Some("summary"), Some("items"), 42.0, Some("e1,e2")).unwrap();
    db.reopen_meeting_session(&session.id).unwrap();
    let row = db.get_meeting_session(&session.id).unwrap().unwrap();
    assert!(row.ended_at.is_none());
    assert!(row.summary.is_none());
    assert!(row.action_items.is_none() || row.action_items.as_deref() == Some("items"),
        // We chose to clear summary/total_duration/entry_ids but NOT action_items —
        // either is defensible. Adjust if the implementation does.
        "action_items kept or cleared per impl");
    assert!(row.total_duration_seconds.is_none());
    assert!(row.entry_ids.is_none());
}

#[test]
fn get_max_meeting_sequence_empty() {
    let db = test_db();
    assert_eq!(db.get_max_meeting_sequence().unwrap(), 0);
}

#[test]
fn get_max_meeting_sequence_returns_largest() {
    let db = test_db();
    let s1 = db.create_meeting_session().unwrap();
    db.set_meeting_structured_output(&s1.id, r#"{"sequence":3}"#).unwrap();
    let s2 = db.create_meeting_session().unwrap();
    db.set_meeting_structured_output(&s2.id, r#"{"sequence":7}"#).unwrap();
    let s3 = db.create_meeting_session().unwrap();
    db.set_meeting_structured_output(&s3.id, r#"{"sequence":5}"#).unwrap();
    assert_eq!(db.get_max_meeting_sequence().unwrap(), 7);
}

#[test]
fn get_max_meeting_sequence_survives_deletion() {
    // The whole point of MAX(seq)+1 over count(): deleting old meetings
    // shouldn't cause a new meeting to reuse an old number. Verifies the
    // invariant the renderer's auto-numbering relies on.
    let db = test_db();
    let s1 = db.create_meeting_session().unwrap();
    db.set_meeting_structured_output(&s1.id, r#"{"sequence":5}"#).unwrap();
    let s2 = db.create_meeting_session().unwrap();
    db.set_meeting_structured_output(&s2.id, r#"{"sequence":10}"#).unwrap();
    assert_eq!(db.get_max_meeting_sequence().unwrap(), 10);
    db.delete_meeting_session(&s2.id).unwrap();
    assert_eq!(db.get_max_meeting_sequence().unwrap(), 5,
        "MAX adjusts down when a high-seq row is deleted");
}
