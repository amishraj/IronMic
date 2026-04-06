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
            polished_text: None,
            duration_seconds: None,
            source_app: None,
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
                polished_text: None,
                duration_seconds: Some(1.0),
                source_app: None,
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
                polished_text: None,
                duration_seconds: None,
                source_app: None,
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
            polished_text: None,
            duration_seconds: None,
            source_app: None,
        })
        .unwrap();
    store
        .create(NewEntry {
            raw_transcript: "React component lifecycle hooks".into(),
            polished_text: None,
            duration_seconds: None,
            source_app: None,
        })
        .unwrap();
    store
        .create(NewEntry {
            raw_transcript: "Database migration patterns".into(),
            polished_text: None,
            duration_seconds: None,
            source_app: None,
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
            polished_text: None,
            duration_seconds: None,
            source_app: None,
        })
        .unwrap();
    let e2 = store
        .create(NewEntry {
            raw_transcript: "Will be pinned".into(),
            polished_text: None,
            duration_seconds: None,
            source_app: None,
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
