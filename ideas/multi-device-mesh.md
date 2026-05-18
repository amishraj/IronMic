# Multi-Device Mesh (No Cloud Sync)

## Overview

Enable IronMic instances running on multiple machines (desktop, laptop, work machine) to discover each other on the local network and synchronize data directly — peer-to-peer, encrypted, with no cloud intermediary. Dictionary, settings, transcript history, and meeting records stay in sync across devices without a single byte leaving the local network.

This preserves IronMic's core privacy guarantee: no data ever touches a server. Sync happens exclusively over LAN/WLAN using mDNS for discovery, TLS for encryption, and CRDTs for conflict resolution. The user pairs devices once (QR code or PIN verification) and sync operates transparently from that point forward.

---

## What This Enables

- **Seamless device switching:** User dictates a note on their desktop at work. When they open IronMic on their laptop at home (same network or after reconnecting), the note is already there.

- **Dictionary portability:** Custom dictionary words (technical jargon, names, acronyms) added on one device propagate to all paired devices. No manual re-entry.

- **Settings consistency:** Hotkey configuration, LLM preferences, VAD sensitivity, and display preferences stay consistent across machines.

- **Meeting continuity:** Start a meeting on the desktop, review it later on the laptop. All transcripts, summaries, action items, and speaker labels are available on both.

- **Selective sync:** The user controls exactly what syncs. Options:
  - Settings only (lightest — just preferences)
  - Settings + dictionary
  - Settings + dictionary + entries
  - Everything (settings + dictionary + entries + meetings + analytics)

- **Enterprise deployment:** IT can pre-configure pairing between company machines. No cloud account needed. No firewall exceptions for external services — only local mDNS and a configurable TCP port.

---

## Architecture

### System Diagram

```
┌──────────────────────────┐         LAN / WLAN         ┌──────────────────────────┐
│     Device A (Desktop)   │                             │     Device B (Laptop)    │
│                          │                             │                          │
│  Electron Main Process   │    mDNS Discovery           │  Electron Main Process   │
│  ┌────────────────────┐  │◄──────────────────────────►│  ┌────────────────────┐  │
│  │  SyncCoordinator   │  │                             │  │  SyncCoordinator   │  │
│  │                    │  │    TLS-encrypted TCP         │  │                    │  │
│  │  ┌──────────────┐  │  │◄──────────────────────────►│  │  ┌──────────────┐  │  │
│  │  │ PeerManager  │  │  │    Delta Sync Protocol      │  │  │ PeerManager  │  │  │
│  │  │              │  │  │                             │  │  │              │  │  │
│  │  │ mDNS Advt.   │  │  │                             │  │  │ mDNS Advt.   │  │  │
│  │  │ TLS Server   │  │  │                             │  │  │ TLS Server   │  │  │
│  │  │ TLS Client   │  │  │                             │  │  │ TLS Client   │  │  │
│  │  └──────────────┘  │  │                             │  │  └──────────────┘  │  │
│  │                    │  │                             │  │                    │  │
│  │  ┌──────────────┐  │  │                             │  │  ┌──────────────┐  │  │
│  │  │ CRDTEngine   │  │  │                             │  │  │ CRDTEngine   │  │  │
│  │  │ (settings)   │  │  │                             │  │  │ (settings)   │  │  │
│  │  └──────────────┘  │  │                             │  │  └──────────────┘  │  │
│  │                    │  │                             │  │                    │  │
│  │  ┌──────────────┐  │  │                             │  │  ┌──────────────┐  │  │
│  │  │ DeltaSync    │  │  │                             │  │  │ DeltaSync    │  │  │
│  │  │ (entries)    │  │  │                             │  │  │ (entries)    │  │  │
│  │  └──────────────┘  │  │                             │  │  └──────────────┘  │  │
│  └────────────────────┘  │                             │  └────────────────────┘  │
│           │               │                             │           │               │
│  ┌────────▼────────────┐  │                             │  ┌────────▼────────────┐  │
│  │  Rust Core (SQLite) │  │                             │  │  Rust Core (SQLite) │  │
│  └─────────────────────┘  │                             │  └─────────────────────┘  │
└──────────────────────────┘                             └──────────────────────────┘
```

### New Components

```
Rust Core
├── sync/
│   ├── mod.rs
│   ├── discovery.rs          # mDNS service advertisement and browsing
│   ├── tls.rs                # Self-signed cert generation, TLS server/client
│   ├── protocol.rs           # Sync message framing and serialization
│   ├── delta.rs              # Delta computation: what changed since last sync
│   ├── crdt.rs               # CRDT merge logic for settings
│   ├── pairing.rs            # QR code / PIN verification handshake
│   └── bandwidth.rs          # Rate limiting and compression
│
├── storage/
│   ├── sync_peers.rs         # Peer device CRUD
│   ├── sync_log.rs           # Sync event logging
│   └── sync_state.rs         # Per-peer sync cursors (vector clocks)

Electron App
├── renderer/
│   ├── components/
│   │   ├── SyncSettings.tsx          # Sync configuration panel
│   │   ├── PeerManager.tsx           # List of paired devices + status
│   │   ├── PairingFlow.tsx           # QR code / PIN pairing wizard
│   │   ├── SyncStatusIndicator.tsx   # Tray/toolbar sync status icon
│   │   └── ConflictResolver.tsx      # Manual conflict resolution (rare)
│   ├── stores/
│   │   └── useSyncStore.ts           # Sync state management
│   └── services/
│       └── SyncService.ts            # Renderer-side sync orchestration
│
├── main/
│   ├── sync-coordinator.ts           # Main process sync lifecycle manager
│   └── sync-ipc.ts                   # IPC handlers for sync operations
```

### Data Flow: Device Discovery and Pairing

```
Device A                                              Device B
   │                                                      │
   │  1. User clicks "Add Device" on A                    │
   │  ──────────────────────────────────                  │
   │  A generates ephemeral pairing code (6-digit PIN)    │
   │  A displays QR code encoding: {pin, fingerprint, ip} │
   │                                                      │
   │  2. User scans QR / enters PIN on B                  │
   │  ────────────────────────────────────────────────    │
   │                                                      │
   │  3. B connects to A via TCP                          │
   │  ◄───────────── TLS ClientHello ────────────────────│
   │                                                      │
   │  4. TLS handshake with cert fingerprint verification │
   │  ──────────── TLS ServerHello + Cert ───────────────►│
   │  B verifies A's cert fingerprint matches QR/PIN      │
   │  ◄───────── TLS Finished ───────────────────────────│
   │                                                      │
   │  5. Mutual authentication                            │
   │  ──────── PairingRequest{deviceId, name, pin} ─────►│
   │  ◄─────── PairingAccept{deviceId, name, cert} ──────│
   │                                                      │
   │  6. Both devices store each other's info             │
   │  A stores B in sync_peers table                      │
   │  B stores A in sync_peers table                      │
   │                                                      │
   │  7. Initial sync begins                              │
   │  ◄═══════════ Full delta exchange ══════════════════►│
```

### Data Flow: Ongoing Sync

```
[Change detected on Device A]        (entry created, setting changed, word added)
        │
        ▼
[1. Write to local SQLite]           ← Normal operation, change is persisted locally first
        │
        ▼
[2. Update sync_state]               ← Increment local vector clock component
        │                               Record the change in sync_log
        │
        ▼
[3. Notify SyncCoordinator]          ← "I have a new change"
        │
        ▼
[4. Check peer availability]         ← Is Device B online? (mDNS presence check)
        │
        ├── Peer offline → Queue change. Sync when peer comes online.
        │
        ├── Peer online:
        │
        ▼
[5. Compute delta]                   ← Compare local vector clock with peer's last known clock
        │                               Only send changes since last successful sync
        │
        ▼
[6. Send delta over TLS]             ← Compressed, encrypted, authenticated
        │
        ▼
[7. Peer receives + merges]          ← CRDT merge for settings
        │                               Last-write-wins for entries (with tombstone support)
        │                               Set-union for dictionary
        │
        ▼
[8. Peer sends its delta back]       ← Bidirectional: both sides exchange what the other is missing
        │
        ▼
[9. Both update vector clocks]       ← Record successful sync point
```

---

## Sync Protocol

### Wire Format

All messages are framed as length-prefixed MessagePack payloads over TLS:

```
┌──────────────┬──────────────┬────────────────────────────┐
│ Length (4B)   │ Type (1B)    │ Payload (MessagePack)      │
│ big-endian    │              │ optionally zstd-compressed │
└──────────────┴──────────────┴────────────────────────────┘
```

### Message Types

```
0x01  PairingRequest     { device_id, device_name, pin_hash }
0x02  PairingAccept      { device_id, device_name, cert_der }
0x03  PairingReject      { reason }
0x10  SyncRequest        { vector_clock, sync_scope }
0x11  SyncDelta          { changes: [Change], clock: VectorClock }
0x12  SyncAck            { clock: VectorClock }
0x13  SyncError          { code, message }
0x20  Ping               { timestamp }
0x21  Pong               { timestamp }
0xFF  Disconnect         { reason }
```

### Change Record

Each change in a SyncDelta message:

```rust
struct Change {
    table: String,          // "entries", "settings", "dictionary", "meeting_sessions"
    operation: Op,          // Insert, Update, Delete
    row_id: String,         // Primary key of affected row
    timestamp: u64,         // Lamport timestamp (for ordering)
    device_id: String,      // Which device made this change
    data: Option<Value>,    // Full row data for Insert/Update (MessagePack Value)
    tombstone: bool,        // True for deletes (row stays in sync_log for propagation)
}
```

### Vector Clocks

Each device maintains a vector clock tracking the latest known timestamp from every peer:

```
Device A's clock: { A: 47, B: 32 }
Device B's clock: { A: 45, B: 35 }

When A syncs with B:
  A sends changes with A-timestamps 46, 47 (B hasn't seen these)
  B sends changes with B-timestamps 33, 34, 35 (A hasn't seen these)
  After sync: both clocks are { A: 47, B: 35 }
```

This ensures exactly-once delivery without duplicate processing.

---

## Conflict Resolution

### Settings: CRDT (Last-Writer-Wins Register)

Settings are key-value pairs. Conflicts are resolved by timestamp — the most recent write wins:

```rust
struct SettingsCRDT {
    key: String,
    value: String,
    timestamp: u64,     // Lamport timestamp
    device_id: String,  // Tie-breaker: if timestamps equal, highest device_id wins
}
```

Example:
- Device A sets `theme = "dark"` at t=10
- Device B sets `theme = "light"` at t=12
- After sync: both devices have `theme = "light"` (t=12 wins)

If timestamps are identical (extremely rare), the device with the lexicographically higher device_id wins. This is deterministic — both devices arrive at the same result independently.

### Entries: Last-Write-Wins with Tombstones

Entries (dictation transcripts) use last-write-wins based on `updated_at`:

- If the same entry is edited on two devices, the later edit wins
- Deleted entries create a tombstone record in `sync_log` that propagates to peers
- Tombstones are retained for 30 days, then pruned

**Why not CRDT for entries?** Entry edits are rare (usually one device creates, occasionally one device edits). Full CRDT for rich text would require a complex data structure (e.g., Yjs/Automerge) that adds significant overhead for a rarely-exercised path. LWW is simpler and sufficient.

### Dictionary: Set-Union (Add-Wins)

The dictionary is an add-wins set:
- Adding a word on any device propagates to all devices
- Removing a word creates a tombstone
- If Device A adds "Kubernetes" and Device B removes "Kubernetes" concurrently, the add wins (the word stays)
- This prevents accidental data loss — it's easier to re-remove than to re-add

### Meetings: Last-Write-Wins with Merge Heuristics

Meeting sessions have multiple fields that may be updated independently (summary, action items, speaker labels). For meetings:
- Whole-record LWW based on `updated_at`
- If a meeting is actively being edited on one device and synced from another, the local edit takes priority (local-first principle)

---

## Pairing Flow

### Option A: QR Code (Preferred)

1. On Device A: **Settings > Sync > Add Device**
2. A generates:
   - 6-digit PIN (cryptographically random)
   - Self-signed TLS certificate (Ed25519, 1 year validity)
   - QR code encoding: `ironmic-pair://pin={PIN}&fp={CERT_FINGERPRINT}&ip={LOCAL_IP}&port={PORT}`
3. A displays QR code on screen
4. On Device B: **Settings > Sync > Scan Code**
   - B uses the Electron window to display a camera viewfinder (or user manually enters the PIN)
   - B decodes the QR code
5. B connects to A's IP:port over TLS
6. B verifies A's TLS certificate fingerprint matches the QR code
7. Both exchange device IDs and names
8. Both store each other as trusted peers
9. Initial sync begins automatically

### Option B: Manual PIN

For devices without cameras or when on different subnets:
1. Device A shows a 6-digit PIN and its mDNS hostname
2. User enters the PIN on Device B
3. Device B discovers Device A via mDNS (or user enters IP manually)
4. Same TLS handshake with PIN verification
5. PIN is single-use and expires after 5 minutes

### Security Properties

- **No trust-on-first-use (TOFU) weakness:** The QR code / PIN includes the certificate fingerprint, so the user verifies the identity of the peer out-of-band before any data is exchanged.
- **No plaintext exchange:** All data travels over TLS 1.3. The PIN is never sent in plaintext — it's used as a pre-shared key to authenticate the pairing handshake.
- **Revocation:** Either device can unpair at any time. Unpairing deletes the peer's certificate from the trust store and stops all sync.

---

## Database Schema

### New Tables

```sql
-- Known peer devices
CREATE TABLE sync_peers (
    id TEXT PRIMARY KEY,                    -- UUID (stable device identifier)
    device_name TEXT NOT NULL,              -- Human-readable name ("Jason's MacBook Pro")
    cert_fingerprint TEXT NOT NULL,         -- SHA-256 of peer's TLS certificate (hex)
    cert_der BLOB,                         -- Full DER-encoded certificate for TLS verification
    last_ip TEXT,                           -- Last known IP address
    last_port INTEGER,                      -- Last known TCP port
    paired_at TEXT NOT NULL,                -- When pairing was established
    last_sync_at TEXT,                      -- Most recent successful sync
    last_seen_at TEXT,                      -- Most recent mDNS presence
    sync_scope TEXT NOT NULL DEFAULT '["settings","dictionary"]',
                                           -- JSON array of enabled sync categories
    is_active INTEGER DEFAULT 1,           -- 0 = paused, 1 = active
    vector_clock TEXT NOT NULL DEFAULT '{}', -- JSON: {device_id: timestamp} per peer
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Sync event log (for delta computation and audit trail)
CREATE TABLE sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,                -- Which device originated this change
    table_name TEXT NOT NULL,               -- "entries", "settings", "dictionary", etc.
    row_id TEXT NOT NULL,                   -- Primary key of changed row
    operation TEXT NOT NULL,                -- "insert" | "update" | "delete"
    lamport_ts INTEGER NOT NULL,            -- Lamport timestamp for ordering
    data_hash TEXT,                         -- SHA-256 of row data (for integrity check)
    data BLOB,                             -- MessagePack-encoded row data (null for deletes)
    tombstone INTEGER DEFAULT 0,           -- 1 for delete records
    synced_to TEXT DEFAULT '{}',            -- JSON: {peer_id: true} tracking delivery
    created_at TEXT NOT NULL
);
CREATE INDEX idx_sync_log_table ON sync_log(table_name, lamport_ts);
CREATE INDEX idx_sync_log_device ON sync_log(device_id, lamport_ts);
CREATE INDEX idx_sync_log_row ON sync_log(table_name, row_id);

-- Sync conflict history (for diagnostics, not displayed to user normally)
CREATE TABLE sync_conflicts (
    id TEXT PRIMARY KEY,
    table_name TEXT NOT NULL,
    row_id TEXT NOT NULL,
    local_value BLOB,                       -- MessagePack of local version
    remote_value BLOB,                      -- MessagePack of remote version
    local_timestamp INTEGER,
    remote_timestamp INTEGER,
    resolution TEXT NOT NULL,               -- "local_wins" | "remote_wins" | "merged" | "manual"
    resolved_at TEXT NOT NULL,
    peer_id TEXT NOT NULL REFERENCES sync_peers(id)
);
CREATE INDEX idx_sync_conflicts_table ON sync_conflicts(table_name, resolved_at);
```

### Schema Modifications to Existing Tables

Add sync metadata columns to existing tables:

```sql
-- entries: add sync tracking
ALTER TABLE entries ADD COLUMN sync_device_id TEXT;     -- Device that created this entry
ALTER TABLE entries ADD COLUMN sync_lamport_ts INTEGER DEFAULT 0;

-- settings: add sync tracking
ALTER TABLE settings ADD COLUMN sync_device_id TEXT;
ALTER TABLE settings ADD COLUMN sync_lamport_ts INTEGER DEFAULT 0;

-- dictionary: add sync tracking
ALTER TABLE dictionary ADD COLUMN sync_device_id TEXT;
ALTER TABLE dictionary ADD COLUMN sync_lamport_ts INTEGER DEFAULT 0;

-- meeting_sessions: add sync tracking
ALTER TABLE meeting_sessions ADD COLUMN sync_device_id TEXT;
ALTER TABLE meeting_sessions ADD COLUMN sync_lamport_ts INTEGER DEFAULT 0;
```

---

## Rust Core Changes

### New Crates

| Crate | Version | Purpose | Size |
|-------|---------|---------|------|
| `mdns-sd` | ^0.11 | mDNS/DNS-SD service discovery (cross-platform) | ~200KB |
| `rustls` | ^0.23 | TLS 1.3 implementation (no OpenSSL dependency) | ~500KB |
| `rcgen` | ^0.13 | Self-signed certificate generation | ~100KB |
| `rmp-serde` | ^1.3 | MessagePack serialization | ~50KB |
| `zstd` | ^0.13 | Zstandard compression for sync payloads | ~300KB |
| `qrcode` | ^0.14 | QR code generation for pairing | ~50KB |

Total new dependency footprint: ~1.2MB compiled.

### New N-API Exports

```typescript
// --- Discovery ---
startDiscovery(): void                           // Begin mDNS browsing for peers
stopDiscovery(): void                            // Stop browsing
getDiscoveredPeers(): string                     // JSON: [{ip, port, deviceName, fingerprint}]
advertiseSelf(deviceName: string, port: number): void  // Advertise this device via mDNS
stopAdvertising(): void

// --- Pairing ---
generatePairingCode(): string                    // JSON: {pin, qrData, fingerprint}
acceptPairing(peerIp: string, peerPort: number, pin: string): string  // JSON: PeerInfo
revokePairing(peerId: string): void

// --- Sync ---
startSync(): void                                // Begin background sync loop
stopSync(): void
syncNow(peerId: string): Promise<string>         // Force immediate sync, returns JSON status
getSyncStatus(): string                          // JSON: {peers: [{id, status, lastSync}]}

// --- Peer Management ---
listPeers(): string                              // JSON array of sync_peers
updatePeerScope(peerId: string, scope: string): void  // Update sync scope JSON
removePeer(peerId: string): void
getPeerSyncHistory(peerId: string, limit: number): string  // JSON: sync_log entries

// --- Sync Log ---
getSyncLog(limit: number, offset: number): string  // JSON array
getSyncConflicts(limit: number): string            // JSON array
clearSyncLog(olderThanDays: number): number        // Returns deleted count

// --- Device Identity ---
getDeviceId(): string                            // This device's stable UUID
getDeviceName(): string
setDeviceName(name: string): void
```

### Files to Modify

| File | Change |
|------|--------|
| `rust-core/Cargo.toml` | Add mdns-sd, rustls, rcgen, rmp-serde, zstd, qrcode |
| `rust-core/src/storage/db.rs` | Migration for new tables + ALTER columns |
| `rust-core/src/storage/mod.rs` | Export sync modules |
| `rust-core/src/lib.rs` | Register sync N-API functions |
| `electron-app/src/main/ipc-handlers.ts` | Add sync IPC channels |
| `electron-app/src/main/native-bridge.ts` | Expose sync Rust functions |
| `electron-app/src/main/index.ts` | Start/stop sync coordinator on app lifecycle |
| `electron-app/src/preload/index.ts` | Add sync API to contextBridge |

### New Files

| File | Purpose |
|------|---------|
| `rust-core/src/sync/mod.rs` | Module root |
| `rust-core/src/sync/discovery.rs` | mDNS advertisement + browsing |
| `rust-core/src/sync/tls.rs` | TLS server/client, cert generation |
| `rust-core/src/sync/protocol.rs` | Message framing, serialization |
| `rust-core/src/sync/delta.rs` | Delta computation from sync_log |
| `rust-core/src/sync/crdt.rs` | CRDT merge for settings |
| `rust-core/src/sync/pairing.rs` | Pairing handshake logic |
| `rust-core/src/sync/bandwidth.rs` | Compression + rate limiting |
| `rust-core/src/storage/sync_peers.rs` | Peer CRUD |
| `rust-core/src/storage/sync_log.rs` | Sync log CRUD |
| `rust-core/src/storage/sync_state.rs` | Vector clock management |
| `electron-app/src/main/sync-coordinator.ts` | Main process sync lifecycle |
| `electron-app/src/main/sync-ipc.ts` | IPC handler registration |
| `electron-app/src/renderer/components/SyncSettings.tsx` | Settings panel |
| `electron-app/src/renderer/components/PeerManager.tsx` | Peer list UI |
| `electron-app/src/renderer/components/PairingFlow.tsx` | Pairing wizard |
| `electron-app/src/renderer/components/SyncStatusIndicator.tsx` | Status icon |
| `electron-app/src/renderer/components/ConflictResolver.tsx` | Conflict UI |
| `electron-app/src/renderer/stores/useSyncStore.ts` | Sync state store |
| `electron-app/src/renderer/services/SyncService.ts` | Renderer orchestration |

---

## Bandwidth Management

### Delta Sync (Not Full Dump)

The sync protocol never transfers the full database. Instead:

1. Each change to a synced table is recorded in `sync_log` with a Lamport timestamp
2. When syncing with a peer, compute the delta: all sync_log entries with timestamps newer than the peer's last known clock value
3. Send only the delta, compressed with zstd

### Compression

All sync payloads over 1KB are zstd-compressed before transmission:
- Typical compression ratio for text data: 3-5x
- A sync delta of 100 entries (~50KB text) compresses to ~12KB
- Compression/decompression: <5ms for typical payloads

### Rate Limiting

To avoid saturating the network (especially on slow WiFi):
- Maximum sync throughput: 1MB/s (configurable)
- Large initial syncs are chunked: 100 changes per message, with flow control
- Sync operations yield to active recording/transcription (lower priority)

### Bandwidth Estimates

| Scenario | Data Size | Compressed | Time (1MB/s) |
|----------|----------|------------|--------------|
| Daily settings sync | ~500B | ~200B | instant |
| Dictionary sync (500 words) | ~15KB | ~4KB | instant |
| 10 new entries | ~50KB | ~12KB | <1s |
| Full initial sync (1000 entries) | ~500KB | ~120KB | <1s |
| Full sync with meetings (100 meetings) | ~5MB | ~1.2MB | ~1.5s |

---

## Security Model

### Threat Model

The sync system assumes:
- The local network may have eavesdroppers (shared WiFi, compromised router)
- Devices on the network may attempt to impersonate a peer
- Physical access to a device is a separate concern (handled by OS-level encryption)

### Defenses

| Threat | Defense |
|--------|---------|
| Eavesdropping | TLS 1.3 encryption on all sync traffic |
| Man-in-the-middle | Certificate fingerprint verified out-of-band during pairing |
| Impersonation | Each peer's certificate is pinned after pairing; connections rejected if cert doesn't match |
| Replay attacks | Lamport timestamps + vector clocks ensure each change is processed exactly once |
| Data tampering | MessagePack payloads include SHA-256 hash of row data; verified on receipt |
| Unauthorized pairing | PIN is 6 digits (1M possibilities), single-use, expires in 5 minutes |
| Post-compromise | Unpair immediately revokes trust; no shared secrets persist after unpairing |

### Certificate Lifecycle

- Certificates are Ed25519 (fast, small, no RSA overhead)
- Generated at first launch or when user clicks "Reset Device Identity"
- 1-year validity, auto-renewed
- Stored in the OS keychain (macOS Keychain, Windows DPAPI, Linux secret-tool) when available, otherwise in an encrypted file in the app data directory
- Certificate fingerprint is the device's identity — stable across reboots

---

## Enterprise Considerations

### IT Deployment

- **No cloud dependency:** IT does not need to provision cloud accounts or manage a sync server
- **Network requirements:** mDNS on UDP port 5353 (standard, usually allowed on corporate LANs). Sync on a configurable TCP port (default: 51337)
- **Firewall:** Only local network traffic. No external connections. Firewall rules can restrict sync to specific subnets
- **Pre-pairing:** IT can distribute a configuration file with pre-authorized device fingerprints, skipping the QR/PIN flow
- **Audit trail:** The `sync_log` table provides a complete audit trail of what was synced, when, and between which devices

### MDM Integration

For managed devices:
- Sync scope can be locked (e.g., IT requires settings sync but disables entry sync)
- Pairing can be restricted to devices with specific certificate fingerprints
- Sync port can be set via MDM configuration profile

### Network Policy

- mDNS discovery respects network boundaries — devices on different VLANs won't discover each other (unless mDNS bridging is configured)
- For cross-subnet sync (e.g., VPN), user can manually enter peer IP instead of relying on mDNS
- All sync traffic is indistinguishable from generic TLS traffic on the wire (no plaintext protocol identifiers)

---

## Settings

New settings in **Settings > Sync**:

| Setting | Default | Description |
|---------|---------|-------------|
| `sync_enabled` | `false` | Enable multi-device sync |
| `sync_port` | `51337` | TCP port for sync connections |
| `sync_auto` | `true` | Sync automatically when peers are available |
| `sync_interval_seconds` | `30` | How often to check for changes to sync |
| `sync_on_change` | `true` | Sync immediately when a local change is made |
| `sync_max_bandwidth_kbps` | `1024` | Maximum sync throughput (KB/s) |
| `sync_scope_default` | `["settings","dictionary"]` | Default sync scope for new peers |
| `sync_compress` | `true` | Enable zstd compression |
| `sync_conflict_resolution` | `automatic` | "automatic" or "manual" (ask user) |
| `sync_log_retention_days` | `30` | How long to keep sync log entries |
| `sync_device_name` | `(hostname)` | Display name for this device |

---

## Privacy Considerations

- **No cloud.** Sync is direct device-to-device over the local network. No relay servers. No NAT traversal services. No STUN/TURN.
- **No internet required.** Sync works on an air-gapped network with no internet access.
- **Encrypted in transit.** All sync data is TLS 1.3 encrypted. Even on a compromised local network, data cannot be read.
- **User-controlled scope.** The user explicitly chooses what to sync. By default, only settings and dictionary are synced — transcript content requires explicit opt-in.
- **No metadata leakage.** mDNS advertisements reveal only: service type ("_ironmic._tcp"), device name, and port. No content metadata is broadcast.
- **Full deletion.** Unpairing a device removes all sync state. "Delete all sync data" clears sync_log, sync_peers, and sync_conflicts. Tombstones ensure deletions propagate before the peer is removed.
- **Audio never synced.** Consistent with IronMic's core principle — audio buffers are never persisted, so they cannot be synced. Only text data moves between devices.

---

## Implementation Phases

### Phase 1: Device Identity and Discovery
- Generate stable device UUID on first launch
- Self-signed Ed25519 certificate generation via `rcgen`
- mDNS service advertisement and browsing via `mdns-sd`
- `SyncStatusIndicator.tsx` showing "Sync available" when peers detected
- **Deliverable:** Devices can discover each other on the local network

### Phase 2: Pairing Flow
- Implement QR code generation (encoding PIN + fingerprint + IP)
- TLS handshake with certificate fingerprint verification
- PIN verification protocol
- `PairingFlow.tsx` wizard UI
- `sync_peers` table and CRUD
- **Deliverable:** Two devices can securely pair and store each other's identity

### Phase 3: Settings and Dictionary Sync
- Implement sync_log tracking for settings and dictionary changes
- CRDT merge for settings (LWW register)
- Set-union merge for dictionary (add-wins)
- Vector clock management
- Delta computation and transmission
- `SyncSettings.tsx` and `PeerManager.tsx` UI
- **Deliverable:** Settings and dictionary stay in sync across paired devices

### Phase 4: Entry Sync
- Extend sync_log tracking to entries table
- LWW merge for entries with tombstone support
- Large payload chunking and flow control
- Bandwidth management (rate limiting, compression)
- Selective sync UI (per-peer scope configuration)
- **Deliverable:** Dictation entries sync across devices

### Phase 5: Meeting Sync and Polish
- Extend sync to meeting_sessions table
- Handle meeting-specific data (summaries, action items, speaker segments)
- Conflict resolution UI for rare manual conflicts
- Sync audit log viewer
- Performance optimization for large corpora
- Cross-subnet manual peering (enter IP directly)
- **Deliverable:** Full-featured multi-device sync with meeting support

### Phase 6: Enterprise Features
- Pre-pairing via configuration file
- MDM-compatible sync scope locking
- Sync policy enforcement (admin can restrict what syncs)
- Diagnostic tools for IT (sync health check, bandwidth usage report)
- **Deliverable:** Enterprise-ready deployment with IT management hooks

---

## Performance Considerations

| Operation | Time | Notes |
|-----------|------|-------|
| mDNS discovery | 1-3s | Standard mDNS response time |
| TLS handshake | ~50ms | Ed25519 is very fast |
| Pairing flow | ~2s | Handshake + verification + initial metadata exchange |
| Settings delta sync | <100ms | Tiny payload |
| 10-entry delta sync | <500ms | Including compression + TLS |
| Full initial sync (1000 entries) | 2-5s | Chunked, compressed, background |
| Memory overhead | ~10MB | TLS context + sync state + mDNS stack |
| CPU overhead (idle) | <1% | mDNS listener + periodic sync check |
| CPU overhead (syncing) | ~5% | Serialization + compression + TLS |

---

## Open Questions

1. **Cross-network sync (VPN, different offices):** mDNS doesn't cross subnet boundaries. Should we support manual peer configuration (enter IP:port)? This is straightforward but means the user needs to know the peer's IP.

2. **More than 2 devices:** The protocol supports N-way sync, but conflict probability increases. Should we limit to 5 paired devices? Do we need to test specific N-way scenarios (A syncs with B, B syncs with C, then A syncs with C)?

3. **Sync during active recording:** If a sync delta arrives while the user is recording, should we defer applying it until recording stops? Applying changes to SQLite during recording could cause micro-stutters.

4. **Model sync:** Should we sync ML model weights (VAD fine-tuning, notification ranker) between devices? The models are small (<1MB) but trained on device-specific data. Merging model weights is a non-trivial ML problem.

5. **Selective entry sync:** Users may want to sync only certain entries (e.g., work entries but not personal). Should we support tag-based sync filters? This adds complexity to the delta computation.

6. **NAT traversal for remote sync:** Some users may want to sync between home and office networks. This requires either a relay server (violates "no cloud") or NAT hole-punching (unreliable). Is this out of scope?

7. **Sync permissions per peer:** Should different peers have different sync scopes? E.g., sync everything with personal laptop but only settings with work desktop. Current design supports this (per-peer scope), but the UI complexity increases.

8. **Database format compatibility:** If two devices run different versions of IronMic with different schema versions, sync could fail. Need a schema version negotiation step in the handshake — only sync tables that both devices understand.

---

## Dependencies

| Dependency | Already in project? | Purpose |
|-----------|---------------------|---------|
| `mdns-sd` | **No** | mDNS service discovery |
| `rustls` | **No** | TLS 1.3 (pure Rust, no OpenSSL) |
| `rcgen` | **No** | Ed25519 certificate generation |
| `rmp-serde` | **No** | MessagePack serialization |
| `zstd` | **No** | Compression for sync payloads |
| `qrcode` | **No** | QR code generation for pairing |
| `rusqlite` | Yes | Sync tables live in the same DB |
| `serde` + `serde_json` | Yes | Serialization infrastructure |
| `tokio` or `async-std` | **Evaluate** | Async networking for sync (may already be present via ort/napi) |

Six new Rust crates. All are well-maintained, pure-Rust (except zstd which wraps a C library), and add no network-dependent behavior themselves.

---

## Success Metrics

- **Sync latency:** Changes appear on the other device within 5 seconds when both are online
- **Reliability:** Zero data loss across 1000 sync cycles in testing
- **Conflict rate:** <1% of syncs produce a conflict requiring resolution
- **Pairing success:** >95% of pairing attempts succeed on first try
- **Bandwidth:** Typical daily sync uses <1MB of network traffic
- **Setup time:** Pairing two devices takes <30 seconds from start to first successful sync
- **Zero cloud dependency:** Verified by network audit — no DNS lookups, no external connections during sync
