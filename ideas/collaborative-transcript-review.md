# Collaborative Dictation and Shared Transcript Review

## Overview

Enable multiple people to view, annotate, correct, and approve a transcript together in real-time or asynchronously — a shared editing experience for voice-generated content. A legal assistant records a deposition and a paralegal reviews and corrects the transcript on the same machine. A doctor dictates patient notes and a medical scribe verifies medical terminology before the note is finalized. A journalist interviews a source, then a fact-checker reviews the transcript with inline annotations.

IronMic already transcribes, stores, and renders dictation entries and meeting transcripts. The collaborative layer adds: a lightweight local web server that serves a review-only interface to other devices on the same network, real-time cursor presence and inline commenting, a correction workflow with change tracking, and role-based permissions (author, reviewer, viewer) — all without any cloud service, external server, or internet connection.

This is fundamentally different from the multi-device mesh sync idea (which syncs entire IronMic databases between installations). Collaborative review shares a single transcript for review and correction without giving reviewers access to the full IronMic database. The author controls what's shared and can revoke access at any time.

---

## What This Enables

- **Legal transcript review:**
  ```
  Scenario: Deposition recorded by court reporter using IronMic.
  
  1. Reporter finishes recording. Transcript saved in IronMic.
  2. Reporter clicks "Share for Review" on the transcript.
  3. IronMic generates a local URL: http://192.168.1.50:9742/review/abc123
  4. Reporter sends the link to the attorney via Slack/email.
  5. Attorney opens the link on their laptop browser.
  6. Attorney sees the transcript with inline editing tools.
  7. Attorney highlights "Mr. Johnson" and comments: "Should be Mr. Johnston (with a 't')."
  8. Reporter sees the comment in real-time, accepts the correction.
  9. Both see the updated transcript. Correction is tracked in the audit log.
  10. Reporter clicks "Finalize" — transcript is locked, review session ends.
  ```

- **Medical dictation review:**
  ```
  Doctor dictates: "Patient presents with a history of hypertension and 
   type 2 diabetes. Current medications include metformin 500mg BID and 
   lisinopril 10mg daily."
  
  Medical scribe reviews on their tablet via the local web interface:
  - Corrects "met foreman" → "metformin" (Whisper misrecognition)
  - Adds annotation: "Verify dosage — last visit notes show 1000mg"
  - Marks status: "Reviewed, pending physician sign-off"
  
  Doctor sees the corrections, confirms dosage, and finalizes the note.
  ```

- **Interview transcript review:**
  ```
  Journalist records a 45-minute interview using IronMic.
  Shares the transcript with a fact-checker.
  
  Fact-checker highlights specific claims and adds annotations:
  - "Revenue grew 40% year over year" → [Needs verification] [Source?]
  - "We launched in 12 countries" → [Confirmed: press release shows 12]
  
  Journalist reviews annotations, uses verified claims in the article.
  ```

- **Meeting minutes approval:**
  ```
  EA takes meeting notes via IronMic during a board meeting.
  Shares the transcript with 4 board members for review.
  
  Each reviewer can:
  - Suggest corrections to their own quotes
  - Add clarifying comments
  - Approve their section with "Looks good"
  
  EA sees all feedback, makes final edits, marks as "Approved."
  ```

---

## Architecture

### New Components

```
Electron App (Main Process)
├── src/main/
│   ├── review-server/
│   │   ├── server.ts                 # Express/Fastify HTTP server on local network
│   │   ├── routes.ts                 # REST API for review operations
│   │   ├── websocket.ts              # WebSocket for real-time sync (cursor, edits)
│   │   ├── auth.ts                   # Session token validation, role checking
│   │   ├── static.ts                 # Serve review web client assets
│   │   └── rate-limiter.ts           # Request rate limiting

Electron App (Renderer)
├── src/renderer/
│   ├── components/
│   │   ├── review/
│   │   │   ├── SharePanel.tsx                # Share controls for a transcript
│   │   │   ├── ReviewSessionList.tsx         # Active and past review sessions
│   │   │   ├── ReviewerPresence.tsx          # Show who's currently viewing
│   │   │   ├── InlineAnnotation.tsx          # Comment/correction on text selection
│   │   │   ├── ChangeTracker.tsx             # Shows all corrections with accept/reject
│   │   │   ├── ReviewStatus.tsx              # Status: draft, in review, approved, finalized
│   │   │   ├── AccessControl.tsx             # Manage reviewer permissions
│   │   │   └── AuditLog.tsx                 # Full history of all changes
│   │   │
│   │   └── settings/
│   │       └── ReviewSettings.tsx            # Review server config
│   │
│   ├── stores/
│   │   └── useReviewStore.ts                 # Review sessions, annotations, presence
│   │
│   └── services/
│       └── ReviewService.ts                  # Manages sessions, communicates with server

Review Web Client (standalone, served by review server)
├── review-client/
│   ├── index.html                            # Single-page review app
│   ├── review-app.tsx                        # React app for reviewers
│   ├── components/
│   │   ├── TranscriptViewer.tsx              # Read + annotate transcript
│   │   ├── AnnotationSidebar.tsx             # Comments panel
│   │   ├── CorrectionEditor.tsx              # Suggest text corrections
│   │   ├── PresenceBar.tsx                   # Who else is reviewing
│   │   ├── ApprovalButton.tsx                # Mark section as approved
│   │   └── ReviewerIdentity.tsx              # Reviewer name/role display
│   ├── services/
│   │   ├── WebSocketClient.ts                # Real-time sync
│   │   └── ReviewAPI.ts                      # REST client for review operations
│   └── styles/
│       └── review.css                        # Standalone styling (no Tailwind dependency)

Rust Core
├── storage/
│   └── reviews.rs                            # Review sessions, annotations, corrections CRUD
```

### System Diagram

```
┌────────────────────────────────────────────────────────────────┐
│  IronMic (Author's Machine)                                     │
│                                                                  │
│  ┌──────────────────┐     ┌──────────────────────────────────┐ │
│  │ Electron Renderer │     │ Review Server (Main Process)     │ │
│  │                    │     │                                  │ │
│  │ SharePanel ────────┼────→│ Express/Fastify HTTP             │ │
│  │ ChangeTracker      │     │   Port: 9742 (configurable)     │ │
│  │ ReviewerPresence   │     │   Binds to: LAN IP only         │ │
│  │ AuditLog           │     │                                  │ │
│  │                    │     │ WebSocket (real-time sync)       │ │
│  │                    │     │   Cursor positions               │ │
│  │                    │     │   New annotations                │ │
│  │                    │     │   Corrections                    │ │
│  │                    │     │   Presence updates               │ │
│  │                    │     │                                  │ │
│  └──────────────────┘     │ Static file server                │ │
│                            │   Serves review-client/ assets   │ │
│                            │                                  │ │
│                            │ Auth: session tokens per review  │ │
│                            └────────────┬─────────────────────┘ │
│                                         │                       │
│  ┌──────────────────────────────────────┼──────────────────────┐│
│  │              Rust Core / SQLite       │                      ││
│  │  entries ── review_sessions ── annotations ── corrections   ││
│  └──────────────────────────────────────┴──────────────────────┘│
│                                         │                       │
└─────────────────────────────────────────┼───────────────────────┘
                                          │
                                    LAN (Wi-Fi)
                                    No internet required
                                          │
          ┌───────────────────────────────┼───────────────────┐
          │                               │                   │
  ┌───────▼───────┐             ┌────────▼────────┐   ┌─────▼──────┐
  │  Reviewer A    │             │  Reviewer B      │   │ Viewer C   │
  │  (Laptop)      │             │  (Tablet)        │   │ (Phone)    │
  │                │             │                   │   │            │
  │ Browser opens: │             │ Browser opens:    │   │ Read-only  │
  │ 192.168.1.50   │             │ 192.168.1.50     │   │ access     │
  │ :9742/review/  │             │ :9742/review/    │   │            │
  │ abc123         │             │ abc123           │   │            │
  │                │             │                   │   │            │
  │ Can: annotate  │             │ Can: annotate    │   │ Can: view  │
  │   correct      │             │   correct        │   │   only     │
  │   approve      │             │   approve        │   │            │
  └────────────────┘             └──────────────────┘   └────────────┘
```

### Review Session Flow

```
[Author clicks "Share for Review" on a transcript]
        │
        ▼
[Create Review Session]
  ├── Generate session token (cryptographic random)
  ├── Set permissions: who can edit vs view
  ├── Create shareable URL: http://{lan_ip}:{port}/review/{token}
  ├── Optionally set expiration (default: 24 hours)
  ├── Start review server if not already running
        │
        ▼
[Author shares URL via any channel]
  (Slack, email, AirDrop, text message, verbally, QR code)
        │
        ▼
[Reviewer opens URL in browser]
        │
        ├── Reviewer enters their name (stored in browser session only)
        ├── WebSocket connection established
        ├── Transcript content loaded (read from IronMic's SQLite)
        ├── Existing annotations loaded
        ├── Presence broadcast: "Alex joined the review"
        │
        ▼
[Review in progress]
        │
        ├── Reviewer selects text → adds annotation
        │   ├── Comment: "Check this quote with legal"
        │   ├── Correction: "Johnson" → "Johnston"
        │   └── Approval: "This section looks accurate"
        │
        ├── WebSocket broadcasts change to all participants
        │   ├── Author sees new annotation in IronMic
        │   ├── Other reviewers see annotation in their browser
        │
        ├── Author accepts/rejects corrections
        │   ├── Accept: text updated in source entry
        │   └── Reject: correction dismissed with optional reason
        │
        ▼
[Author clicks "Finalize"]
        │
        ├── Transcript locked (no more edits)
        ├── Review session status → "finalized"
        ├── Audit log preserved
        ├── Review server stops serving this session
        └── URL becomes invalid
```

---

## Review Web Client

### UI Design

The review client is a lightweight React app served by IronMic's review server. It has no dependency on Electron, Tailwind, or the main IronMic UI library — it's self-contained and loads fast on any device with a browser.

```
┌──────────────────────────────────────────────────────────────┐
│  IronMic Review — Deposition: Smith v. Anderson              │
│  Shared by: Jason  |  Status: In Review  |  Expires: 23h    │
│                                                               │
│  Reviewers: 🟢 Jason (author)  🟢 Alex  🟢 Maria  🔴 Pat    │
│                                                               │
│  ┌──────────────────────────────────────┬─────────────────┐  │
│  │                                      │  Annotations (5) │  │
│  │  [1] Mr. Johnson testified that the  │                  │  │
│  │  contract was signed on March 15th.  │  Alex, 10:32 AM  │  │
│  │  He stated, "I reviewed the terms    │  "Should be      │  │
│  │  with my attorney before signing."   │  'Johnston' with │  │
│  │                                      │  a 't'. See      │  │
│  │  [2] The plaintiff's counsel then    │  exhibit C."     │  │
│  │  presented Exhibit A, a copy of the  │  [Accept] [Reject│  │
│  │  original agreement dated February   │                  │  │
│  │  2025.                               │  ──────────────  │  │
│  │                                      │                  │  │
│  │  [3] Ms. Davis confirmed that the    │  Maria, 10:45 AM │  │
│  │  amendment was discussed during the  │  "Verified: date │  │
│  │  board meeting on April 3rd. "We     │  matches court   │  │
│  │  voted unanimously," she said.       │  records."       │  │
│  │                                      │  ✓ Informational │  │
│  │                                      │                  │  │
│  │  ┌─ Correction (Alex) ──────────┐   │  ──────────────  │  │
│  │  │ "Johnson" → "Johnston"        │   │                  │  │
│  │  │ [✓ Accept] [✗ Reject]        │   │  Alex, 10:50 AM  │  │
│  │  └──────────────────────────────┘   │  "Paragraph 3:   │  │
│  │                                      │  'unanimously'   │  │
│  │  [4] The meeting adjourned at 3:45  │  should be 'by   │  │
│  │  PM after all parties agreed to the  │  majority vote'  │  │
│  │  revised timeline.                   │  per minutes."   │  │
│  │                                      │  [Accept] [Reject│  │
│  │                                      │                  │  │
│  └──────────────────────────────────────┴─────────────────┘  │
│                                                               │
│  ┌──────────────┐  ┌────────────────┐  ┌──────────────────┐  │
│  │ Add Comment  │  │ Suggest Edit   │  │ Approve Section  │  │
│  └──────────────┘  └────────────────┘  └──────────────────┘  │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

### Key Features

1. **Text selection → annotation:** Select any text span, then choose:
   - **Comment:** Add a note without changing the text.
   - **Correction:** Suggest replacement text. Author must accept or reject.
   - **Approval:** Mark a section as verified/accurate.

2. **Real-time presence:** See who's currently reviewing (green dot = active, grey = offline). Cursor positions shown as colored carets in the transcript.

3. **Threaded annotations:** Each annotation can have replies, creating mini-discussions on specific text spans.

4. **Section approval:** Reviewers can mark individual paragraphs as "Approved." When all paragraphs are approved by all required reviewers, the transcript status changes to "Ready to Finalize."

5. **Offline support:** If the reviewer loses network, the client queues changes locally and syncs when reconnected.

---

## Security Model

### Access Control

```
Roles:
  author     — Full control. Accept/reject corrections, finalize, revoke access.
  reviewer   — Can annotate, suggest corrections, approve sections. Cannot edit directly.
  viewer     — Read-only. Can see transcript and existing annotations.

Access grant:
  1. Author creates review session → gets URL with embedded token.
  2. Author can specify max reviewers (default: 10).
  3. Each person who opens the URL gets a session cookie (browser-side only).
  4. Author can revoke individual access or end the entire session.
  5. No account creation, no login, no passwords — access is token-based.

Token security:
  - Token is a 32-byte cryptographic random value, base64url-encoded.
  - Tokens are single-use per session (one transcript per token).
  - Tokens expire after configurable duration (default: 24 hours).
  - Author can regenerate the token (invalidates old URL).
```

### Network Security

```
Binding:
  - Review server binds to the machine's LAN IP only (e.g., 192.168.1.50).
  - NOT bound to 0.0.0.0 (would expose to all interfaces).
  - NOT bound to localhost (would prevent LAN access).
  - Firewall rule advisory: only the configured port needs to be open.

Transport:
  - HTTP (not HTTPS) by default for LAN simplicity.
  - Optional: Self-signed TLS certificate for encrypted transport.
  - If TLS enabled, browser will show a certificate warning — user must accept once.
  - For enterprise environments: support importing a corporate CA certificate.

Content exposure:
  - Only the specific transcript in the review session is accessible.
  - The reviewer cannot access other entries, settings, models, or any other IronMic data.
  - The server serves static review client assets and the transcript content — nothing else.
  - No directory listing, no file traversal, no API access beyond the review endpoints.

Rate limiting:
  - Max 100 requests per minute per IP.
  - Max 10 concurrent WebSocket connections per session.
  - Request size limit: 10KB per annotation/correction.
```

### Data in Transit

```
What the review server exposes:
  - Transcript text (raw and/or polished, as selected by author)
  - Annotations and corrections (text + reviewer name + timestamp)
  - Reviewer presence (name only, no device info)

What the review server does NOT expose:
  - Audio recordings (IronMic doesn't store them anyway)
  - Other entries or meetings
  - User settings or preferences
  - Model files or weights
  - Database files
  - Any file system content
```

---

## Database Schema

### New Tables

```sql
-- Review sessions
CREATE TABLE review_sessions (
    id TEXT PRIMARY KEY,                    -- UUID
    entry_id TEXT NOT NULL,                 -- REFERENCES entries(id) or meeting_sessions(id)
    entry_type TEXT NOT NULL,               -- 'entry' | 'meeting'
    
    -- Session config
    session_token TEXT NOT NULL UNIQUE,     -- Cryptographic token for URL
    title TEXT,                             -- Display title for the review
    status TEXT DEFAULT 'active',           -- 'active' | 'paused' | 'finalized' | 'expired'
    max_reviewers INTEGER DEFAULT 10,
    
    -- Content snapshot
    content_snapshot TEXT NOT NULL,         -- Text as it was when sharing started
    content_current TEXT NOT NULL,          -- Current text (updated as corrections are accepted)
    show_raw INTEGER DEFAULT 0,            -- Share raw transcript (vs polished)
    
    -- Access
    author_name TEXT NOT NULL,
    
    -- Lifecycle
    expires_at TEXT,                        -- Auto-expire after this time
    created_at TEXT NOT NULL,
    finalized_at TEXT,
    
    -- Stats
    total_annotations INTEGER DEFAULT 0,
    total_corrections INTEGER DEFAULT 0,
    corrections_accepted INTEGER DEFAULT 0,
    corrections_rejected INTEGER DEFAULT 0
);
CREATE INDEX idx_review_sessions_token ON review_sessions(session_token);
CREATE INDEX idx_review_sessions_entry ON review_sessions(entry_id);
CREATE INDEX idx_review_sessions_status ON review_sessions(status);

-- Reviewers in a session
CREATE TABLE review_participants (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'reviewer',  -- 'reviewer' | 'viewer'
    session_cookie TEXT NOT NULL UNIQUE,    -- Browser session identifier
    joined_at TEXT NOT NULL,
    last_active_at TEXT,
    is_online INTEGER DEFAULT 0
);
CREATE INDEX idx_review_participants_session ON review_participants(session_id);

-- Annotations (comments, corrections, approvals)
CREATE TABLE review_annotations (
    id TEXT PRIMARY KEY,                    -- UUID
    session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
    participant_id TEXT NOT NULL REFERENCES review_participants(id),
    
    -- Position in text
    start_offset INTEGER NOT NULL,         -- Character offset start
    end_offset INTEGER NOT NULL,           -- Character offset end
    selected_text TEXT,                     -- The text that was selected
    
    -- Content
    annotation_type TEXT NOT NULL,          -- 'comment' | 'correction' | 'approval'
    body TEXT,                             -- Comment text or null for approval
    suggested_text TEXT,                   -- Replacement text for corrections
    
    -- Resolution
    status TEXT DEFAULT 'open',            -- 'open' | 'accepted' | 'rejected' | 'resolved'
    resolved_by TEXT,                      -- Author name who resolved
    resolution_note TEXT,                  -- Optional reason for rejection
    resolved_at TEXT,
    
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_annotations_session ON review_annotations(session_id);
CREATE INDEX idx_annotations_status ON review_annotations(status);
CREATE INDEX idx_annotations_type ON review_annotations(annotation_type);

-- Annotation replies (threaded comments)
CREATE TABLE review_annotation_replies (
    id TEXT PRIMARY KEY,
    annotation_id TEXT NOT NULL REFERENCES review_annotations(id) ON DELETE CASCADE,
    participant_id TEXT NOT NULL REFERENCES review_participants(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_annotation_replies ON review_annotation_replies(annotation_id);

-- Audit log (all actions in a review session)
CREATE TABLE review_audit_log (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
    participant_name TEXT NOT NULL,
    action TEXT NOT NULL,                   -- 'joined' | 'annotated' | 'corrected' | 'approved' |
                                           -- 'accepted' | 'rejected' | 'finalized' | 'revoked'
    detail TEXT,                            -- JSON: action-specific details
    created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_session ON review_audit_log(session_id);
CREATE INDEX idx_audit_time ON review_audit_log(created_at);
```

### Settings

| Key | Default | Description |
|-----|---------|-------------|
| `review_enabled` | `false` | Master toggle for review sharing |
| `review_server_port` | `9742` | Port for the review HTTP server |
| `review_server_auto_start` | `false` | Start server when IronMic launches |
| `review_default_expiry_hours` | `24` | Default session expiration |
| `review_max_concurrent_sessions` | `5` | Maximum active review sessions |
| `review_max_reviewers_per_session` | `10` | Maximum reviewers per session |
| `review_tls_enabled` | `false` | Enable self-signed TLS |
| `review_require_name` | `true` | Require reviewers to enter their name |
| `review_allow_corrections` | `true` | Allow text correction suggestions |
| `review_show_raw_transcript` | `false` | Share raw (vs polished) transcript |
| `review_audit_log_retention_days` | `90` | How long to keep audit logs |

---

## Real-Time Sync Protocol

### WebSocket Messages

```typescript
// Client → Server
interface WSClientMessage {
  type: 'join' | 'cursor_move' | 'annotate' | 'correct' | 'approve' | 
        'reply' | 'typing' | 'leave';
  sessionId: string;
  participantId: string;
  payload: any;
}

// Server → Client (broadcast)
interface WSServerMessage {
  type: 'participant_joined' | 'participant_left' | 'cursor_update' |
        'annotation_added' | 'annotation_resolved' | 'correction_accepted' |
        'correction_rejected' | 'content_updated' | 'session_finalized' |
        'presence_update' | 'reply_added';
  payload: any;
  timestamp: string;
}
```

### Sync Flow

```
[Reviewer selects text and adds a comment]
        │
        ▼
[Review Client (Browser)]
  ├── Optimistic UI update (show comment immediately)
  ├── Send WSClientMessage: { type: 'annotate', payload: { ... } }
        │
        ▼
[Review Server (IronMic Main Process)]
  ├── Validate: session active? participant authorized? offset valid?
  ├── Store annotation in SQLite
  ├── Broadcast WSServerMessage to all connected clients:
  │   { type: 'annotation_added', payload: { annotation, participantName } }
        │
        ├──→ [Author's Electron UI] — shows new annotation in ChangeTracker
        ├──→ [Reviewer B's Browser] — shows new annotation inline
        └──→ [Viewer C's Browser] — shows new annotation (read-only)
```

### Cursor Presence

```
[Reviewer A's cursor at offset 245]
  → WSClientMessage: { type: 'cursor_move', payload: { offset: 245 } }
  → Server broadcasts to all others
  → Other clients render a colored caret at offset 245 with "Alex" label

Throttled: cursor updates sent at most every 200ms to avoid flooding.
Offline detection: if no message received in 30s, mark participant as offline.
```

---

## Integration with Existing Systems

### Entries and Meetings (existing)

Review sessions reference existing `entries` or `meeting_sessions` records. When a correction is accepted, the source record's `polished_text` (or `raw_transcript`) is updated. The original text is preserved in `review_sessions.content_snapshot` for audit purposes.

### LLM Cleanup (existing)

The author can trigger "Re-polish with corrections" which sends the corrected transcript through the LLM cleanup pipeline again, incorporating all accepted corrections. This produces a final polished version that reflects both the original dictation and reviewer corrections.

### Speaker Separation (planned)

For meeting transcripts with speaker labels, the review client shows speaker attribution alongside the transcript. Reviewers can correct speaker labels (e.g., "This was said by Alex, not Pat") as a special annotation type.

### Multi-Device Mesh (planned)

If the multi-device mesh is available, review sessions could be synced to other IronMic installations (not just browser clients). This would allow a reviewer with IronMic installed to review within the full IronMic UI instead of the lightweight web client. However, the browser-based approach is the primary workflow and doesn't require IronMic installation.

### Export (existing)

Review-annotated transcripts can be exported with annotations included:
- Markdown: annotations as footnotes or inline `[comment: ...]` markers
- PDF: annotations in margins (similar to Word track changes)
- JSON: full structured export with text + annotations + audit log

---

## Privacy Considerations

- **Content exposure is explicit and scoped.** The author chooses which transcript to share. Only that specific text is accessible to reviewers. No browsing of other content is possible.
- **LAN-only by default.** The review server binds to the machine's LAN IP, not the public internet. Access requires being on the same network.
- **Token-based access, no accounts.** Reviewers don't create accounts. The URL token grants access. Tokens expire automatically.
- **Author controls lifecycle.** The author can revoke access, pause a session, or finalize (permanently lock) at any time.
- **No reviewer data collection.** The review server stores only the display name the reviewer enters. No device fingerprinting, no cookies beyond the session identifier, no analytics.
- **Audit trail is local.** The audit log of all review actions is stored in IronMic's local SQLite. It's not shared with reviewers unless the author explicitly exports it.
- **Content in transit.** Over plain HTTP on a LAN, transcript content is unencrypted. For sensitive content (legal, medical), the author should enable TLS or ensure the network is trusted. IronMic warns the author if TLS is disabled when sharing.
- **Session cleanup.** When a session expires or is finalized, the review server stops serving that content. Reviewers' browsers may have cached content — IronMic sets `Cache-Control: no-store` headers to minimize this.

---

## Implementation Phases

### Phase 1: Review Server and Basic Sharing
- Implement lightweight HTTP server in Electron main process (Express or Fastify)
- Serve a static single-page review client
- Create review session with token-based URL
- Display transcript content (read-only initially)
- `SharePanel.tsx` — create and manage share links
- `ReviewSessionList.tsx` — view active sessions
- **Deliverable:** Share a transcript URL, reviewer reads it in their browser

### Phase 2: Annotations and Corrections
- WebSocket server for real-time communication
- Inline commenting: select text, add comment
- Text correction suggestions: select text, propose replacement
- Author accept/reject workflow in IronMic
- Apply accepted corrections to source entry
- `ChangeTracker.tsx` — review and resolve corrections
- `InlineAnnotation.tsx` — annotation display in review client
- **Deliverable:** Reviewers can suggest corrections, author accepts/rejects

### Phase 3: Real-Time Presence and Collaboration
- Cursor presence (colored carets with names)
- Participant list with online/offline status
- Threaded replies on annotations
- Section approval workflow
- Real-time annotation visibility across all clients
- `ReviewerPresence.tsx` — presence indicators
- **Deliverable:** Multiple reviewers collaborate in real-time

### Phase 4: Security and Access Control
- Role-based permissions (reviewer vs viewer)
- Session expiration and auto-cleanup
- Rate limiting and request validation
- Optional self-signed TLS
- `AccessControl.tsx` — manage reviewer permissions
- `AuditLog.tsx` — full change history
- **Deliverable:** Secure, auditable review sessions

### Phase 5: Polish and Enterprise Features
- Meeting transcript review with speaker labels
- Export reviewed transcript with annotations (markdown, JSON)
- QR code generation for sharing URLs (easy for tablets)
- Review analytics: time to review, correction rate, reviewer participation
- Session templates (pre-configured for legal, medical, general)
- Mobile-responsive review client
- **Deliverable:** Production-ready review workflow for professional use cases

---

## Performance Considerations

| Operation | Time | Notes |
|-----------|------|-------|
| Review server startup | ~200ms | Express/Fastify initialization |
| Serve review client page | <50ms | Static files, <500KB total |
| Load transcript (10,000 words) | <100ms | SQLite read + JSON serialize |
| WebSocket message (annotation) | <10ms | Broadcast to all clients |
| Accept correction (update entry) | <20ms | SQLite update + broadcast |
| Concurrent reviewers (10) | Negligible | WebSocket is lightweight |
| Review client bundle size | <500KB | Minimal React app, no heavy deps |

### Memory

- Review server: ~20MB (Express + WebSocket + review client assets)
- Per session: ~50KB (transcript + annotations in memory cache)
- Per WebSocket connection: ~5KB
- Maximum with 5 sessions, 10 reviewers each: ~25MB total

### Network

- Transcript download: ~50KB for 10,000 words
- WebSocket messages: ~500 bytes per annotation
- Cursor updates: ~100 bytes per update, throttled to 5/second
- Total bandwidth per review session: <1MB/hour

---

## N-API Surface Additions

```typescript
// --- Review Sessions ---
createReviewSession(entryId: string, entryType: string, title: string,
                    options?: string): Promise<string>              // JSON: { sessionId, token, url }
getReviewSession(id: string): Promise<string>                       // JSON or "null"
listReviewSessions(status?: string): Promise<string>                // JSON array
pauseReviewSession(id: string): Promise<void>
resumeReviewSession(id: string): Promise<void>
finalizeReviewSession(id: string): Promise<void>
deleteReviewSession(id: string): Promise<void>
regenerateSessionToken(id: string): Promise<string>                 // New token

// --- Annotations ---
createAnnotation(annotationJson: string): Promise<string>
resolveAnnotation(id: string, resolution: string, note?: string): Promise<void>
listAnnotations(sessionId: string, status?: string): Promise<string>
addAnnotationReply(annotationId: string, participantId: string, 
                   body: string): Promise<string>

// --- Participants ---
addParticipant(sessionId: string, name: string, role: string): Promise<string>
removeParticipant(id: string): Promise<void>
listParticipants(sessionId: string): Promise<string>

// --- Corrections ---
acceptCorrection(annotationId: string): Promise<void>              // Updates source entry
rejectCorrection(annotationId: string, reason?: string): Promise<void>
getSessionCorrections(sessionId: string): Promise<string>          // JSON summary

// --- Audit ---
logReviewAction(sessionId: string, participant: string, 
                action: string, detail?: string): Promise<void>
getAuditLog(sessionId: string, limit: number): Promise<string>

// --- Server ---
startReviewServer(): Promise<string>                                // Returns URL base
stopReviewServer(): Promise<void>
isReviewServerRunning(): boolean
getReviewServerUrl(): string
```

---

## New Files

### Electron Main Process

| File | Purpose |
|------|---------|
| `electron-app/src/main/review-server/server.ts` | HTTP + WebSocket server |
| `electron-app/src/main/review-server/routes.ts` | REST API endpoints |
| `electron-app/src/main/review-server/websocket.ts` | WebSocket handling |
| `electron-app/src/main/review-server/auth.ts` | Token validation |
| `electron-app/src/main/review-server/static.ts` | Static file serving |
| `electron-app/src/main/review-server/rate-limiter.ts` | Rate limiting |

### Review Web Client

| File | Purpose |
|------|---------|
| `electron-app/src/review-client/index.html` | Entry point |
| `electron-app/src/review-client/review-app.tsx` | Main review app |
| `electron-app/src/review-client/components/TranscriptViewer.tsx` | Transcript display |
| `electron-app/src/review-client/components/AnnotationSidebar.tsx` | Comments panel |
| `electron-app/src/review-client/components/CorrectionEditor.tsx` | Correction UI |
| `electron-app/src/review-client/components/PresenceBar.tsx` | Reviewer presence |
| `electron-app/src/review-client/components/ApprovalButton.tsx` | Section approval |
| `electron-app/src/review-client/components/ReviewerIdentity.tsx` | Name display |
| `electron-app/src/review-client/services/WebSocketClient.ts` | Real-time sync |
| `electron-app/src/review-client/services/ReviewAPI.ts` | REST client |
| `electron-app/src/review-client/styles/review.css` | Standalone styles |

### Electron Renderer

| File | Purpose |
|------|---------|
| `electron-app/src/renderer/components/review/SharePanel.tsx` | Share controls |
| `electron-app/src/renderer/components/review/ReviewSessionList.tsx` | Session management |
| `electron-app/src/renderer/components/review/ReviewerPresence.tsx` | Presence display |
| `electron-app/src/renderer/components/review/InlineAnnotation.tsx` | Annotation display |
| `electron-app/src/renderer/components/review/ChangeTracker.tsx` | Correction workflow |
| `electron-app/src/renderer/components/review/ReviewStatus.tsx` | Status badge |
| `electron-app/src/renderer/components/review/AccessControl.tsx` | Permission management |
| `electron-app/src/renderer/components/review/AuditLog.tsx` | Action history |
| `electron-app/src/renderer/components/settings/ReviewSettings.tsx` | Settings |
| `electron-app/src/renderer/stores/useReviewStore.ts` | Review state |
| `electron-app/src/renderer/services/ReviewService.ts` | Session management |

### Rust Core

| File | Purpose |
|------|---------|
| `rust-core/src/storage/reviews.rs` | Sessions, annotations, participants, audit CRUD |

### Files to Modify

| File | Change |
|------|--------|
| `rust-core/src/lib.rs` | Add N-API exports for review functions |
| `rust-core/src/storage/db.rs` | Add migration for review tables |
| `electron-app/src/main/index.ts` | Start/stop review server lifecycle |
| `electron-app/src/main/ipc-handlers.ts` | Wire review IPC channels |
| `electron-app/src/preload/index.ts` | Expose review API to renderer |
| `electron-app/src/renderer/components/EntryCard.tsx` | Add "Share for Review" button |
| `electron-app/src/renderer/components/SettingsPanel.tsx` | Add review settings section |
| `electron-app/package.json` | Add express/fastify + ws dependencies |

---

## Open Questions

1. **HTTP vs HTTPS on LAN.** Self-signed TLS adds security but causes browser warnings that confuse non-technical users. Should the default be HTTP with a prominent warning about LAN security, or HTTPS with guidance on accepting the certificate? Alternatively, could mDNS + a local CA certificate remove the warning?

2. **Offline reviewer sync.** If a reviewer annotates while temporarily disconnected (laptop sleep, Wi-Fi dropout), the client queues changes. When reconnected, how should conflicts be handled if another reviewer annotated the same text span?

3. **Large transcript performance.** A 2-hour meeting transcript could be 20,000+ words. Rendering this in a browser with real-time annotation is feasible but needs careful DOM management (virtualized rendering). At what transcript size should IronMic warn the author about performance?

4. **Reviewer identity verification.** Since reviewers only enter a display name (no authentication), a malicious person with the URL could impersonate someone. Is this acceptable for the LAN trust model, or should there be an optional PIN per reviewer?

5. **Multi-transcript review sessions.** Should a review session support sharing multiple related transcripts (e.g., a 3-part meeting series), or should each transcript be a separate session?

6. **Integration with compliance workflows.** Legal and medical transcripts often need formal sign-off chains (transcriber → reviewer → attorney/physician). Should IronMic support a configurable approval chain, or is the simple approve/finalize model sufficient?

7. **Review server resource usage.** Running an HTTP server in Electron's main process adds memory and CPU overhead even when no reviews are active. Should the server start only when a session is created and stop when all sessions expire?

---

## Dependencies

| Dependency | Already in project? | Purpose |
|-----------|---------------------|---------|
| `express` or `fastify` | **No — needs adding** | HTTP server in main process |
| `ws` | **No — needs adding** | WebSocket server for real-time sync |
| `crypto` (Node.js built-in) | Yes | Generate session tokens |
| `react` + `react-dom` | Yes (renderer) | Review client UI (bundled separately) |
| `vite` | Yes | Bundle review client as separate build target |
| `qrcode` | **No — optional** | Generate QR codes for sharing URLs |

Two required npm dependencies (HTTP server + WebSocket), one optional (QR code). No new Rust dependencies.

---

## Success Metrics

- Review session creation: >90% of shared sessions are accessed by at least one reviewer
- Reviewer engagement: Average of 3+ annotations per review session
- Correction acceptance rate: >60% of suggested corrections are accepted by the author
- Time to review: Average review completed within 2 hours of sharing
- Concurrent reviewer support: System handles 5+ simultaneous reviewers without degradation
- Session completion: >70% of review sessions are finalized (not abandoned/expired)
- Network reliability: <1% of WebSocket messages lost or out-of-order on LAN
- Security: Zero incidents of unintended data exposure beyond the shared transcript
