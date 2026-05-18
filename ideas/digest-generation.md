# Audio Summarization and Digest Generation

## Overview

Automatically generate daily, weekly, and custom-period digests of all dictation entries, meeting notes, AI conversations, and journal entries — a personal "voice newsletter" that compresses a day's or week's worth of activity into key takeaways, decisions made, action items, and open questions. Users start each morning with a briefing of yesterday's voice activity, end each week with a summary of what happened, and can generate on-demand digests for any time range or topic.

IronMic already stores all dictation entries, meeting transcripts, AI chat conversations, and (with the journal feature) journal entries in SQLite with full-text search. The local LLM can summarize text. The missing piece is a scheduled digest pipeline that automatically queries, aggregates, summarizes, and presents cross-source summaries — plus a UI for browsing, searching, and listening to past digests.

This transforms IronMic from a tool that captures information into one that surfaces information. Instead of scrolling through dozens of timeline entries to recall what happened Tuesday, the user reads a 3-paragraph digest. For busy professionals managing multiple projects, this is the difference between information overload and actionable awareness.

---

## What This Enables

- **Morning briefing:**
  ```
  7:00 AM — IronMic notification: "Your daily briefing is ready."
  
  ┌──────────────────────────────────────────────────┐
  │  Daily Briefing — Friday, April 18               │
  │                                                    │
  │  YESTERDAY AT A GLANCE                            │
  │  You dictated 12 entries (2,340 words) across     │
  │  3 hours of recording time.                        │
  │                                                    │
  │  KEY ACTIVITIES                                    │
  │  • Sprint planning: Committed to 8 stories for    │
  │    the upcoming sprint. Auth migration is the top  │
  │    priority.                                       │
  │  • 1:1 with Sarah: Discussed promotion timeline.  │
  │    She recommended presenting at the next          │
  │    engineering all-hands.                          │
  │  • Client call (Acme Corp): They want the API     │
  │    changes by end of month. Budget approved.       │
  │                                                    │
  │  DECISIONS MADE                                    │
  │  • Use Redis for session caching (not Memcached)  │
  │  • Postpone the mobile redesign to Q3             │
  │                                                    │
  │  ACTION ITEMS                                      │
  │  □ Send API timeline to Acme by Monday            │
  │  □ Prepare all-hands talk proposal                │
  │  □ Review auth migration PR                        │
  │                                                    │
  │  OPEN QUESTIONS                                    │
  │  • Who owns the Redis infrastructure setup?        │
  │  • Is the Q3 mobile budget confirmed?              │
  │                                                    │
  │  [🔊 Listen]  [📋 Copy]  [📝 Edit]               │
  └──────────────────────────────────────────────────┘
  ```

- **Weekly digest:**
  ```
  Sunday evening — IronMic generates:
  
  "Weekly Digest — April 14-18, 2026
  
  This week you recorded 47 entries across 8 meetings and 39 dictations.
  Total words: 12,450. Your most active day was Wednesday (18 entries).
  
  TOP THEMES
  1. Auth migration (mentioned in 12 entries across 4 days)
  2. Acme Corp deliverables (8 entries, 2 meetings)
  3. Team hiring — two candidates interviewed Thursday
  
  WEEK'S DECISIONS: [list]
  WEEK'S ACTION ITEMS: [consolidated list, deduplicated]
  CARRIED FORWARD: [items from previous week still open]
  
  NOTABLE: You spent 40% of meeting time on auth migration this week,
  up from 15% last week. Consider whether this needs more delegation."
  ```

- **On-demand project digest:**
  ```
  User: "Give me a digest of everything about the Acme project this month."
  
  IronMic queries all entries and meetings mentioning "Acme" from April 1-19,
  then generates:
  
  "Acme Corp Project Digest — April 2026
  
  14 entries and 3 meetings reference Acme this month.
  
  TIMELINE:
  Apr 3: Initial scope discussion. Client wants API + dashboard.
  Apr 8: Technical review — chose GraphQL over REST.
  Apr 12: Budget approved ($45K for Phase 1).
  Apr 15: Client call — timeline agreed: API by Apr 30, dashboard by May 15.
  Apr 18: Sprint planning — 3 stories allocated to Acme this sprint.
  
  KEY DECISIONS: [list]
  COMMITMENTS TO CLIENT: [list]
  RISKS: API timeline is tight given auth migration competing for bandwidth."
  ```

- **Digest as TTS read-back:**
  ```
  User commuting to work, says: "Read me my briefing."
  IronMic reads the daily digest aloud via Kokoro TTS.
  Word-level highlighting follows along if the app is visible.
  ```

---

## Architecture

### New Components

```
Electron App
├── renderer/
│   ├── components/
│   │   ├── digest/
│   │   │   ├── DigestPage.tsx               # Main digest browsing view
│   │   │   ├── DigestCard.tsx               # Single digest display card
│   │   │   ├── DigestViewer.tsx             # Full digest with sections
│   │   │   ├── DigestTimeline.tsx           # Browse digests by date
│   │   │   ├── DailyBriefing.tsx            # Today's briefing widget
│   │   │   ├── WeeklyDigest.tsx             # Week view with expandable sections
│   │   │   ├── CustomDigestBuilder.tsx      # On-demand digest with date/topic filters
│   │   │   ├── DigestCompare.tsx            # Compare two periods side by side
│   │   │   ├── ActionItemTracker.tsx        # Consolidated action items across digests
│   │   │   └── DigestScheduleConfig.tsx     # When to generate digests
│   │   │
│   │   └── settings/
│   │       └── DigestSettings.tsx           # Digest preferences
│   │
│   ├── stores/
│   │   └── useDigestStore.ts                # Digest data, generation status
│   │
│   └── services/
│       ├── DigestEngine.ts                  # Orchestrates digest generation
│       ├── DigestAggregator.ts              # Queries and merges data from all sources
│       ├── DigestSummarizer.ts              # LLM summarization pipeline
│       ├── ActionItemExtractor.ts           # Extracts and tracks action items
│       └── DigestScheduler.ts              # Schedules automatic digest generation

Rust Core
├── storage/
│   └── digests.rs                           # Digest CRUD, action item tracking
```

### Digest Generation Pipeline

```
[Trigger: Schedule (daily/weekly) OR User Request]
        │
        ▼
[DigestAggregator]
        │
        ├── Query entries: date range, optional topic filter
        │   Source: entries table (FTS5)
        │   → 47 entries, 12,450 words
        │
        ├── Query meetings: date range, optional topic filter
        │   Source: meeting_sessions table
        │   → 8 meetings with transcripts, summaries, action items
        │
        ├── Query AI chats: date range (if applicable)
        │   Source: AI chat history
        │   → 5 conversations
        │
        ├── Query journal entries: date range (if journal enabled)
        │   Source: journal_entries table
        │   → 3 journal entries
        │
        └── Merge into unified timeline
            Sort by timestamp, tag by source type
                │
                ▼
[Content Preparation]
        │
        ├── Estimate total tokens
        │   If > LLM context window:
        │     1. Pre-summarize each source independently
        │     2. Feed summaries (not full content) to digest LLM
        │   If within context:
        │     Feed full content directly
        │
        ▼
[DigestSummarizer (LLM)]
        │
        ├── Step 1: Extract key activities (who, what, when)
        ├── Step 2: Extract decisions made
        ├── Step 3: Extract action items (with owners if mentioned)
        ├── Step 4: Extract open questions
        ├── Step 5: Identify themes and trends
        ├── Step 6: Generate narrative summary
        ├── Step 7: Compare to previous period (if weekly)
        │
        ▼
[ActionItemExtractor]
        │
        ├── Parse action items from digest
        ├── Deduplicate against existing tracked items
        ├── Identify carried-forward items from previous digests
        │
        ▼
[Store Digest]
        │
        ├── Save to digests table
        ├── Save action items to action_items table
        ├── Update digest index
        │
        ▼
[Notification]
        │
        └── "Your daily briefing is ready" (if scheduled)
```

### Hierarchical Summarization

For large volumes of content that exceed the LLM's context window:

```
[47 entries, ~12,000 words total]
        │
        ├── Exceeds context window (~4,000 token limit for Mistral 7B)
        │
        ▼
[Chunk into source groups]
        │
        ├── Meetings (8 entries, ~4,000 words)
        │   └── LLM summarize → 300 words
        │
        ├── Dictations (36 entries, ~7,000 words)
        │   └── Split into time-based chunks:
        │       ├── Morning (12 entries) → LLM summarize → 200 words
        │       ├── Afternoon (15 entries) → LLM summarize → 200 words
        │       └── Evening (9 entries) → LLM summarize → 150 words
        │
        ├── AI Chats (5 entries, ~1,500 words)
        │   └── LLM summarize → 200 words
        │
        └── Journal (3 entries, ~500 words)
            └── LLM summarize → 100 words
                │
                ▼
[Combined summaries: ~1,150 words — fits in context]
                │
                ▼
[Final Digest LLM call]
  "Given these summaries of today's activities, generate a 
   daily briefing with: overview, key activities, decisions, 
   action items, open questions."
                │
                ▼
[Structured Digest Output]
```

---

## Digest Formats

### Daily Briefing

```
Daily Briefing Prompt:

You are a personal executive assistant. Given all of yesterday's dictation 
entries, meeting notes, and conversations, create a concise daily briefing.

Structure:
1. AT A GLANCE: One sentence overview (entries count, word count, time span)
2. KEY ACTIVITIES: 3-5 bullet points of the most important things that happened
3. DECISIONS MADE: List any decisions that were explicitly stated or clearly implied
4. ACTION ITEMS: Checklist of tasks mentioned or committed to, with owners if mentioned
5. OPEN QUESTIONS: Unresolved questions or items that need follow-up
6. NOTABLE: One observation about patterns, time allocation, or things that stand out

Rules:
- Be concise — each section should be 2-5 bullet points max
- Use the speaker's own terminology and project names
- Action items should be actionable (start with a verb)
- If content is sparse, keep the briefing short rather than padding
- Never fabricate information not present in the source material
- Output clean markdown

Source content:
{content}
```

### Weekly Digest

```
Weekly Digest Prompt:

You are a personal executive assistant. Given this week's daily briefings 
and any additional entries, create a comprehensive weekly digest.

Structure:
1. WEEK AT A GLANCE: Total entries, meetings, word count, most active day
2. TOP THEMES: 3-5 recurring topics that dominated the week, with brief context
3. KEY ACCOMPLISHMENTS: What was completed or moved forward significantly
4. DECISIONS MADE: Consolidated list across the entire week
5. ACTION ITEMS: 
   - NEW: Items generated this week
   - CARRIED FORWARD: Items from previous weeks still open
   - COMPLETED: Items from previous weeks resolved this week
6. WEEK-OVER-WEEK: How this week compared to last (volume, themes, mood if available)
7. LOOKING AHEAD: Based on open items and momentum, what's likely on the horizon

Rules:
- Deduplicate across daily briefings — don't repeat the same decision 5 times
- Highlight escalations: items that appeared small earlier in the week but grew
- If journal mood data is available, note the emotional arc of the week
- Be specific with project names, people, and dates

This week's content:
{content}

Previous week's digest (for comparison):
{previous_digest}
```

### Custom/Topic Digest

```
Custom Digest Prompt:

You are a research assistant. Given all content matching the query 
"{topic}" from {date_range}, create a focused digest.

Structure:
1. OVERVIEW: What this topic is about and its significance based on frequency
2. TIMELINE: Chronological progression of this topic across entries/meetings
3. KEY POINTS: The most important facts, decisions, and developments
4. STAKEHOLDERS: People mentioned in relation to this topic
5. STATUS: Current state based on the most recent entries
6. RISKS/CONCERNS: Any worries, blockers, or risks mentioned

Source content:
{content}
```

---

## Action Item Tracking

### Extraction

Action items are extracted from both individual entries and digests:

```
Action Item Extraction Prompt (runs on each meeting/entry with commitments):

Extract all action items from the following text. An action item is a task 
that someone committed to doing or that was assigned.

For each action item, provide:
- task: What needs to be done (start with a verb)
- owner: Who is responsible (name or "me" if the speaker, "unassigned" if unclear)
- deadline: When it's due (date if mentioned, "unspecified" if not)
- source: Brief context (which meeting or conversation)

Respond in JSON array format.

Text:
{text}
```

### Lifecycle

```
[Action Item Extracted]
        │
        ├── status: "open"
        ├── source_type: "meeting" | "entry" | "digest"
        ├── source_id: reference to origin
        │
        ▼
[Appears in daily/weekly digests as "NEW"]
        │
        ├── User marks as complete → status: "completed"
        │   Appears in next digest as "COMPLETED"
        │
        ├── Appears in next digest without progress → status: "carried_forward"
        │   Counter increments: carried_count: 2, 3, 4...
        │
        ├── Carried 3+ times → flagged as "stale"
        │   Digest notes: "This item has been open for 3 weeks."
        │
        └── User dismisses → status: "dismissed"
```

### Action Item UI

```
┌──────────────────────────────────────────────────────────────┐
│  Action Items                                    [Filters ▼] │
│                                                               │
│  Open (7)                                                     │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ □ Send API timeline to Acme by Monday                  │  │
│  │   From: Client call (Apr 18) · Owner: Me · Due: Apr 21│  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ □ Review auth migration PR                             │  │
│  │   From: Sprint planning (Apr 18) · Owner: Me           │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ □ Prepare all-hands talk proposal                      │  │
│  │   From: 1:1 with Sarah (Apr 18) · Owner: Me            │  │
│  │   ⚠ Carried forward 2 weeks                            │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  Completed This Week (3)                                      │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ ✓ Submit Q2 budget proposal                            │  │
│  │ ✓ Merge Redis caching PR                               │  │
│  │ ✓ Schedule candidate interview for Thursday            │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

---

## Database Schema

### New Tables

```sql
-- Generated digests
CREATE TABLE digests (
    id TEXT PRIMARY KEY,                    -- UUID
    digest_type TEXT NOT NULL,             -- 'daily' | 'weekly' | 'custom'
    title TEXT NOT NULL,                    -- "Daily Briefing — April 18, 2026"
    period_start TEXT NOT NULL,             -- Start of digest period (ISO date)
    period_end TEXT NOT NULL,               -- End of digest period (ISO date)
    topic_filter TEXT,                      -- Topic filter for custom digests (null for daily/weekly)
    
    -- Content
    content_markdown TEXT NOT NULL,         -- Full digest in markdown
    content_sections_json TEXT,             -- JSON: parsed sections for structured display
    
    -- Metadata
    source_entry_count INTEGER,            -- Number of entries included
    source_meeting_count INTEGER,          -- Number of meetings included
    source_chat_count INTEGER,             -- Number of AI chats included
    source_journal_count INTEGER,          -- Number of journal entries included
    total_source_words INTEGER,            -- Total words in source material
    digest_word_count INTEGER,             -- Words in the digest itself
    compression_ratio REAL,                -- total_source / digest_words
    
    -- Generation info
    generation_time_ms REAL,               -- How long generation took
    llm_calls INTEGER,                     -- Number of LLM calls used
    hierarchical INTEGER DEFAULT 0,        -- Was hierarchical summarization used?
    
    -- State
    is_read INTEGER DEFAULT 0,
    is_pinned INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_digests_type ON digests(digest_type);
CREATE INDEX idx_digests_period ON digests(period_start, period_end);
CREATE INDEX idx_digests_created ON digests(created_at);

-- Full-text search for digests
CREATE VIRTUAL TABLE digests_fts USING fts5(
    title,
    content_markdown,
    content='digests',
    content_rowid='rowid'
);

-- Tracked action items
CREATE TABLE digest_action_items (
    id TEXT PRIMARY KEY,                    -- UUID
    task TEXT NOT NULL,                     -- Action item description
    owner TEXT,                            -- Who's responsible
    deadline TEXT,                          -- Due date (ISO) or null
    status TEXT DEFAULT 'open',            -- 'open' | 'completed' | 'dismissed' | 'stale'
    
    -- Source tracking
    source_type TEXT NOT NULL,             -- 'entry' | 'meeting' | 'digest'
    source_id TEXT NOT NULL,               -- Reference to source record
    source_context TEXT,                   -- Brief context (meeting name, etc.)
    
    -- Lifecycle
    first_seen_date TEXT NOT NULL,         -- When this item was first extracted
    completed_date TEXT,                   -- When marked complete
    carried_count INTEGER DEFAULT 0,       -- How many digests this appeared in as "carried"
    last_digest_id TEXT,                   -- Most recent digest that included this item
    
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_action_items_status ON digest_action_items(status);
CREATE INDEX idx_action_items_owner ON digest_action_items(owner);
CREATE INDEX idx_action_items_deadline ON digest_action_items(deadline);

-- Digest-to-source mapping (which entries/meetings contributed to each digest)
CREATE TABLE digest_sources (
    digest_id TEXT NOT NULL REFERENCES digests(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,             -- 'entry' | 'meeting' | 'chat' | 'journal'
    source_id TEXT NOT NULL,               -- ID of the source record
    PRIMARY KEY (digest_id, source_type, source_id)
);
CREATE INDEX idx_digest_sources_digest ON digest_sources(digest_id);
```

### Settings

| Key | Default | Description |
|-----|---------|-------------|
| `digest_enabled` | `false` | Master toggle for digest generation |
| `digest_daily_enabled` | `true` | Generate daily briefings |
| `digest_daily_time` | `07:00` | When to generate daily briefing |
| `digest_daily_lookback_hours` | `24` | How far back the daily briefing covers |
| `digest_weekly_enabled` | `true` | Generate weekly digests |
| `digest_weekly_day` | `sunday` | Day to generate weekly digest |
| `digest_weekly_time` | `18:00` | Time to generate weekly digest |
| `digest_include_entries` | `true` | Include dictation entries in digests |
| `digest_include_meetings` | `true` | Include meeting notes in digests |
| `digest_include_chats` | `true` | Include AI chat conversations |
| `digest_include_journal` | `false` | Include journal entries (sensitive, off by default) |
| `digest_max_sections` | `6` | Maximum sections in a digest |
| `digest_auto_read` | `false` | Automatically read digest via TTS when ready |
| `digest_notification` | `true` | Notify when a new digest is available |
| `digest_action_item_tracking` | `true` | Track and deduplicate action items across digests |
| `digest_retention_days` | `90` | How long to keep generated digests |

---

## Integration with Existing Systems

### Timeline (existing)

The daily briefing appears as a special card at the top of the timeline on each day. Users see their digest first, then individual entries below it. The digest card is collapsible and pinned by default.

### Notifications (existing)

Digest notifications use the existing notification system:
- "Your daily briefing is ready" (morning notification)
- "Weekly digest available" (weekly notification)
- "3 action items are overdue" (action item reminders)

### TTS Read-Back (existing)

Digests can be read aloud via the existing Kokoro TTS engine. The "Listen" button on each digest sends the markdown content to TTS. Word-level highlighting works the same as entry read-back.

### Semantic Search (existing)

Digests are embedded in the semantic search index, making them searchable by meaning:
- "What decisions did we make about caching?" matches the digest that mentions Redis.
- "Acme project status" matches the weekly digest's Acme section.

### Macros (planned)

Digest generation is accessible as a macro action:
```yaml
- action: generate_digest
  params:
    type: custom
    topic: "auth migration"
    date_range: last_30_days
  output: $digest
```

### Analytics (existing)

Digest metadata feeds analytics:
- Entries per day/week → activity volume trend
- Compression ratio → how information-dense each period was
- Action item completion rate → productivity metric
- Theme frequency → what topics dominate over time

### Ambient Context Engine (planned)

If the context engine is active, digest sections can be organized by application context:
- "While coding: 15 entries about auth migration, 8 about API endpoints"
- "While in meetings: 3 sprint ceremonies, 2 client calls"
- "While in email: 4 client follow-ups drafted"

---

## Privacy Considerations

- **Digests are derivatives, not new data.** Digests summarize information already stored locally. They add no new data collection.
- **Journal inclusion is opt-in.** Since journal entries are the most sensitive data type, they are excluded from digests by default. Users must explicitly enable `digest_include_journal`.
- **Digest content stays local.** Generated digests are stored in the same SQLite database. No network access.
- **Digest export is explicit.** Digests can only be copied or exported through user-initiated actions.
- **Action items reference sources, not content.** Action item records store the task text and a source reference, not the full meeting transcript or entry text.
- **Retention controls.** `digest_retention_days` allows automatic cleanup of old digests. Action items marked as completed are retained for analytics but can be purged.

---

## Implementation Phases

### Phase 1: Daily Briefing
- Implement `DigestAggregator.ts` — query entries and meetings for a date range
- Implement `DigestSummarizer.ts` — LLM summarization with daily briefing prompt
- Add `digests` table and FTS index (schema migration)
- Implement `digests.rs` — CRUD operations
- Build `DailyBriefing.tsx` — display today's briefing
- Manual trigger: "Generate Briefing" button
- **Deliverable:** Click a button, get yesterday's briefing

### Phase 2: Scheduled Generation
- Implement `DigestScheduler.ts` — cron-like scheduling within Electron
- Daily briefing auto-generates at configured time
- Notification when briefing is ready
- Build `DigestTimeline.tsx` — browse past digests by date
- Build `DigestCard.tsx` — compact digest display for timeline
- **Deliverable:** Automatic daily briefings appear each morning

### Phase 3: Weekly Digest and Hierarchical Summarization
- Weekly digest prompt and generation
- Hierarchical summarization for large content volumes
- Week-over-week comparison in weekly digests
- Build `WeeklyDigest.tsx` — expanded weekly view
- Build `DigestCompare.tsx` — side-by-side period comparison
- **Deliverable:** Automatic weekly digests with trend analysis

### Phase 4: Action Item Tracking
- Implement `ActionItemExtractor.ts` — LLM-based action item extraction
- Add `digest_action_items` table
- Deduplication of action items across digests
- Carried-forward detection and stale item flagging
- Build `ActionItemTracker.tsx` — action item management UI
- Integration with digest sections (new/completed/carried)
- **Deliverable:** Action items tracked across digests with completion status

### Phase 5: Custom Digests and Polish
- Build `CustomDigestBuilder.tsx` — on-demand digest with filters
- Topic-based digests (filter by keyword, tag, or semantic query)
- TTS read-back integration for digests
- Digest export (markdown, PDF)
- Include AI chats and journal entries as optional sources
- Build `DigestPage.tsx` — full digest management page
- **Deliverable:** On-demand project and topic digests with full customization

---

## Performance Considerations

| Operation | Time | Notes |
|-----------|------|-------|
| Aggregate entries (50 entries) | <100ms | SQLite queries |
| Aggregate meetings (10 meetings) | <50ms | SQLite queries |
| LLM summarize chunk (~1000 words) | 2-4s | Mistral 7B via llama.cpp |
| Hierarchical summarize (3 chunks) | 8-15s | 3 chunk summaries + 1 final pass |
| Direct summarize (fits in context) | 3-5s | Single LLM call |
| Action item extraction (per entry) | 1-2s | Focused LLM call |
| Full daily briefing generation | 5-20s | Depends on volume and hierarchy |
| Full weekly digest generation | 15-45s | Larger volume, more LLM calls |
| Digest FTS search | <50ms | SQLite FTS5 |
| Digest read-back (TTS) | ~2s startup | Then streams in real-time |

### Optimization: Background Generation

Scheduled digests generate in the background while the user isn't actively using IronMic:
- Daily briefings generate at the configured time (default 7 AM) in a background process
- Weekly digests generate Sunday evening
- LLM calls are queued behind any active user requests (dictation cleanup takes priority)
- If the user opens IronMic before the digest is ready, it generates on-demand

### Memory

- Digest content in SQLite: ~10KB per daily digest, ~30KB per weekly digest
- 1 year of daily + weekly digests: ~5MB
- Action items table: <1MB for 1 year
- Aggregation buffers (during generation): up to 50MB temporarily (large content sets)

---

## N-API Surface Additions

```typescript
// --- Digests ---
createDigest(digestJson: string): Promise<string>              // returns digest_id
getDigest(id: string): Promise<string>                         // JSON or "null"
getLatestDigest(type: string): Promise<string>                 // JSON: latest daily/weekly
listDigests(type?: string, limit?: number, offset?: number): Promise<string>
searchDigests(query: string, limit: number): Promise<string>
deleteDigest(id: string): Promise<void>
deleteOldDigests(retentionDays: number): Promise<number>
pinDigest(id: string, pinned: boolean): Promise<void>
markDigestRead(id: string): Promise<void>

// --- Digest Sources ---
addDigestSource(digestId: string, sourceType: string, sourceId: string): Promise<void>
getDigestSources(digestId: string): Promise<string>            // JSON: source references

// --- Action Items ---
createActionItem(itemJson: string): Promise<string>
updateActionItem(id: string, updates: string): Promise<void>
completeActionItem(id: string): Promise<void>
dismissActionItem(id: string): Promise<void>
listActionItems(status?: string, owner?: string, limit?: number): Promise<string>
getOverdueActionItems(): Promise<string>
getCarriedForwardItems(minCarriedCount: number): Promise<string>
deleteOldActionItems(completedOlderThanDays: number): Promise<number>

// --- Aggregation (for digest generation) ---
aggregateEntries(fromDate: string, toDate: string, 
                 topicFilter?: string): Promise<string>
aggregateMeetings(fromDate: string, toDate: string,
                  topicFilter?: string): Promise<string>
```

---

## New Files

### Rust Core

| File | Purpose |
|------|---------|
| `rust-core/src/storage/digests.rs` | Digest CRUD, action items, source mapping |

### Electron App

| File | Purpose |
|------|---------|
| `electron-app/src/renderer/components/digest/DigestPage.tsx` | Main digest browsing view |
| `electron-app/src/renderer/components/digest/DigestCard.tsx` | Compact digest card |
| `electron-app/src/renderer/components/digest/DigestViewer.tsx` | Full digest display |
| `electron-app/src/renderer/components/digest/DigestTimeline.tsx` | Date-based digest browser |
| `electron-app/src/renderer/components/digest/DailyBriefing.tsx` | Today's briefing widget |
| `electron-app/src/renderer/components/digest/WeeklyDigest.tsx` | Weekly view |
| `electron-app/src/renderer/components/digest/CustomDigestBuilder.tsx` | On-demand builder |
| `electron-app/src/renderer/components/digest/DigestCompare.tsx` | Period comparison |
| `electron-app/src/renderer/components/digest/ActionItemTracker.tsx` | Action item management |
| `electron-app/src/renderer/components/digest/DigestScheduleConfig.tsx` | Schedule settings |
| `electron-app/src/renderer/components/settings/DigestSettings.tsx` | Preferences |
| `electron-app/src/renderer/stores/useDigestStore.ts` | Digest state |
| `electron-app/src/renderer/services/DigestEngine.ts` | Generation orchestration |
| `electron-app/src/renderer/services/DigestAggregator.ts` | Data collection |
| `electron-app/src/renderer/services/DigestSummarizer.ts` | LLM summarization |
| `electron-app/src/renderer/services/ActionItemExtractor.ts` | Action item parsing |
| `electron-app/src/renderer/services/DigestScheduler.ts` | Scheduling |

### Files to Modify

| File | Change |
|------|--------|
| `rust-core/src/lib.rs` | Add N-API exports for digest and action item functions |
| `rust-core/src/storage/db.rs` | Add migration for digest tables |
| `electron-app/src/main/ipc-handlers.ts` | Wire digest IPC channels |
| `electron-app/src/preload/index.ts` | Expose digest API to renderer |
| `electron-app/src/renderer/App.tsx` | Add Digest page route |
| `electron-app/src/renderer/components/Layout.tsx` | Add Digest nav item |
| `electron-app/src/renderer/components/Timeline.tsx` | Show daily briefing card at top |
| `electron-app/src/renderer/components/SettingsPanel.tsx` | Add digest settings section |

---

## Open Questions

1. **Context window management.** Mistral 7B has a ~4K token context window. A productive day might generate 10,000+ words of source material. Hierarchical summarization handles this, but each level of hierarchy loses detail. Should IronMic support larger-context models (like Mistral with sliding window attention, or a different model entirely) for digest generation?

2. **Action item deduplication.** The same action item may be mentioned in multiple meetings across the week ("remember to send the API timeline"). The deduplication logic needs to identify when two differently-worded items refer to the same task. Should this use semantic similarity (USE embeddings) or simple keyword matching?

3. **Digest editing.** After a digest is generated, should the user be able to edit it (correct errors, add notes)? If so, should edits be tracked to distinguish LLM-generated content from user additions?

4. **Stale action item escalation.** When an action item has been carried forward for 3+ weeks, should IronMic just note it, or take stronger action (move it to a "needs attention" section, change its visual priority)?

5. **Multi-project separation.** Power users working on multiple projects may want separate digests per project rather than one combined daily briefing. Should digests support project tags or categories for filtering?

6. **Digest quality evaluation.** How do we measure whether digests are actually useful? Options: user feedback (thumbs up/down per digest), engagement tracking (do users read/listen to digests?), or comparison of digest content to user's manual notes.

7. **Privacy of cross-source aggregation.** Combining meeting notes with journal entries in a single digest could surface sensitive patterns (e.g., journal mentions frustration with a colleague, meeting notes mention that colleague by name). Should cross-source aggregation have extra guardrails?

---

## Dependencies

| Dependency | Already in project? | Purpose |
|-----------|---------------------|---------|
| LLM (llama.cpp) | Yes | Summarization, extraction, formatting |
| SQLite (rusqlite) | Yes | Digest storage, source aggregation |
| TTS (Kokoro) | Yes | Digest read-back |
| Notification system | Yes | Digest ready alerts |
| Semantic search (USE) | Yes | Digest search and action item deduplication |
| `node-cron` or similar | **No — needs adding** | Schedule daily/weekly generation |

One new npm dependency for scheduling. All heavy lifting uses existing infrastructure.

---

## Success Metrics

- Daily briefing generation: >95% of scheduled briefings generated successfully
- Generation speed: <20 seconds for daily briefing, <45 seconds for weekly digest
- User engagement: >60% of generated digests are opened/read within 24 hours
- Action item tracking: >50% of extracted action items are eventually marked complete or dismissed (not ignored)
- Carried-forward reduction: Average carried-forward count decreases over time (items get resolved faster)
- Compression ratio: Daily briefings compress source material by >10x (e.g., 5,000 words → 400 words)
- Accuracy: <10% of digest bullet points contain factual errors when compared to source material
- User retention: Users with digest enabled open IronMic 30% more frequently than those without
