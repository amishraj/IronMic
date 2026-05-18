# Offline Meeting Copilot

## Overview

Add a real-time contextual recall system to IronMic meetings. As a meeting progresses and the live transcript grows, IronMic continuously extracts keywords and entities from the conversation, searches the historical corpus of past meetings and notes, and surfaces relevant context in a non-intrusive sidebar. When someone mentions "the migration project," IronMic silently pulls up what was discussed about that project in the last three meetings and shows it alongside the live transcript.

This builds on top of the existing MeetingDetector, semantic search (Universal Sentence Encoder embeddings), and FTS5 full-text index. The new work is a real-time extraction-and-retrieval pipeline that operates within the transcription interval (~5 seconds per chunk) and a sidebar UI that auto-updates without disrupting the meeting flow.

Everything runs locally. No external lookups. No network calls. The copilot is powered entirely by the user's own historical data.

---

## What This Enables

- **Live context surfacing:** During a standup, someone says "the database migration." The sidebar immediately shows:
  ```
  Related context (3 matches):
  
  [Meeting: Sprint Planning - Mar 28]
  "Alex said the Postgres migration is blocked on the schema validation
   tool. Target date pushed to April 10."
  
  [Note: Migration Checklist - Mar 25]
  "Step 3: Run pg_dump with --clean flag. Step 4: Validate foreign
   keys post-migration."
  
  [Meeting: 1:1 with Sarah - Apr 1]
  "Sarah confirmed the staging migration passed all integration tests.
   Production migration scheduled for next sprint."
  ```

- **Pre-meeting briefing:** Before a recurring meeting, IronMic auto-generates a context card summarizing what was discussed in the last 3 instances of that meeting. "Last time: you discussed X, Y, Z. Action items from last meeting: A (assigned to Alex), B (assigned to you)."

- **Entity tracking across meetings:** IronMic builds a lightweight entity index (projects, people, deadlines, tools) that persists across meetings. "The migration project" resolves to the same entity whether it's called "database migration," "the Postgres move," or "the DB project."

- **Action item recall:** When someone says "what did we decide about X," the copilot surfaces the most recent decision or action item related to X.

---

## Architecture

### New Components

```
Electron App
├── renderer/
│   ├── components/
│   │   ├── MeetingCopilot.tsx          # Sidebar panel during active meetings
│   │   ├── ContextCard.tsx             # Single context suggestion card
│   │   ├── PreMeetingBriefing.tsx      # Auto-generated pre-meeting summary
│   │   ├── EntityBadge.tsx             # Inline entity highlight in transcript
│   │   └── CopilotSettings.tsx         # Sensitivity, sources, display prefs
│   ├── stores/
│   │   └── useCopilotStore.ts          # Context suggestions state management
│   └── services/
│       ├── CopilotService.ts           # Orchestrates extraction + retrieval
│       ├── EntityExtractor.ts          # Keyword/entity extraction from text
│       ├── ContextRetriever.ts         # Searches historical corpus
│       ├── RelevanceScorer.ts          # Ranks and deduplicates results
│       └── BriefingGenerator.ts        # Pre-meeting context card builder

Rust Core
├── storage/
│   ├── context_suggestions.rs          # Context suggestion CRUD + logging
│   └── entity_index.rs                 # Entity resolution and tracking
```

### Data Flow: Live Context Pipeline

```
[Live Transcript Chunk]            ← Whisper produces text every ~5 seconds
        │
        ▼
[1. Entity Extraction]             ← Extract keywords, proper nouns, project names
        │                             Uses combination of:
        │                             - TF-IDF keyword extraction (stateless)
        │                             - Named entity patterns (regex + heuristics)
        │                             - LLM entity extraction (optional, if loaded)
        │
        ▼
[2. Query Formation]               ← Build search queries from extracted entities
        │                             Combine: exact phrases + semantic embedding
        │
        ├──────────────────────┐
        ▼                      ▼
[3a. FTS5 Search]          [3b. Semantic Search]
(exact keyword match)      (USE embedding similarity)
        │                      │
        └──────────┬───────────┘
                   ▼
[4. Relevance Scoring]             ← Weighted combination of:
        │                             - Text match score (FTS5 rank)
        │                             - Semantic similarity (cosine)
        │                             - Recency (exponential decay)
        │                             - Source type weight (meeting > note > entry)
        │
        ▼
[5. Deduplication]                 ← Remove near-duplicate suggestions
        │                             Cosine similarity between suggestion embeddings
        │                             Merge suggestions from same source document
        │
        ▼
[6. Sidebar Update]                ← Push top-K suggestions to UI
        │                             Animate new cards in, fade stale ones out
        │                             Never interrupt — only update sidebar panel
        │
        ▼
[7. Interaction Logging]           ← Track: shown, clicked, dismissed, helpful
                                      Used to improve relevance scoring over time
```

### Data Flow: Pre-Meeting Briefing

```
[Meeting Start Detected]
        │
        ▼
[1. Identify Recurring Meeting]    ← Match by: day-of-week + time, participants,
        │                             meeting template, or user-tagged series
        │
        ▼
[2. Fetch Past Instances]          ← Last 3-5 meetings in this series
        │                             Pull summaries, action items, key decisions
        │
        ▼
[3. Generate Briefing]             ← Local LLM (if loaded) or template-based:
        │                             - "Last meeting: [date], [duration]"
        │                             - "Key topics: A, B, C"
        │                             - "Open action items: ..."
        │                             - "Decisions made: ..."
        │
        ▼
[4. Display Briefing Card]         ← Show at top of meeting view before transcript starts
                                      Auto-collapse once meeting is 2 minutes in
```

### Performance Pipeline (Must Complete in <5s)

```
Timeline per transcription chunk:
t=0.0s   Whisper finishes chunk transcription
t=0.05s  Entity extraction (regex + TF-IDF: ~50ms)
t=0.10s  USE embedding computation for query (~50ms in Web Worker)
t=0.15s  FTS5 search via IPC to Rust (~20ms)
t=0.20s  Semantic search: compare query embedding to stored embeddings (~100ms)
t=0.35s  Relevance scoring + deduplication (~15ms)
t=0.40s  UI update with new suggestions
─────────────────────────────────────────────
Total: ~400ms  (well within 5s transcription interval)
```

---

## Entity Extraction

### Approach: Hybrid Extraction

The entity extractor uses three layers, each progressively more expensive:

**Layer 1: Pattern-Based (always on, <10ms)**
- Capitalized word sequences (proper nouns): "Project Atlas," "Home Depot"
- Date/time patterns: "next Tuesday," "April 10th," "Q2"
- Technical identifiers: URLs, file paths, version numbers, ticket IDs (JIRA-1234)
- Money amounts: "$47.50," "2 million"

**Layer 2: TF-IDF Keyword Extraction (<50ms)**
- Maintain a running TF-IDF model over the meeting's transcript
- IDF scores pre-computed from the user's historical corpus (updated nightly or on-demand)
- Extract top-5 keywords per chunk that are distinctive relative to the user's baseline vocabulary
- This catches domain-specific terms the user discusses frequently: "the Kubernetes cluster," "the onboarding flow"

**Layer 3: LLM Entity Extraction (optional, ~500ms)**
- If the local LLM (Mistral) is loaded, send the latest chunk with a structured extraction prompt:
  ```
  Extract entities from this meeting transcript segment.
  Return JSON: {"projects": [], "people": [], "decisions": [], "action_items": [], "topics": []}
  Only include clearly stated entities. Do not infer.
  
  Transcript: {chunk}
  ```
- This layer runs asynchronously and may lag one chunk behind — results merged into next update
- Disabled by default to avoid competing with transcription for LLM resources

### Entity Resolution

The same concept may be referred to differently across meetings:
- "the migration" / "database migration" / "Postgres move" / "the DB project"

Resolution strategy:
1. When a new entity is extracted, compute its USE embedding
2. Compare against known entities in the `entity_index` table
3. If cosine similarity > 0.80 with an existing entity, link them (same canonical entity)
4. If 0.60-0.80, suggest a merge to the user after the meeting
5. If < 0.60, create a new entity

Over time, the entity index builds a knowledge graph of the user's professional world — projects, people, tools, decisions — all fully local.

---

## Database Schema

### New Tables

```sql
-- Context suggestions surfaced during meetings
CREATE TABLE context_suggestions (
    id TEXT PRIMARY KEY,                    -- UUID
    meeting_id TEXT NOT NULL,               -- Meeting this was surfaced in
    source_type TEXT NOT NULL,              -- 'meeting' | 'entry' | 'note'
    source_id TEXT NOT NULL,                -- ID of the source document
    source_title TEXT,                      -- Display title of the source
    source_date TEXT,                       -- When the source was created
    snippet TEXT NOT NULL,                  -- Excerpt shown to the user (200-500 chars)
    trigger_text TEXT NOT NULL,             -- The transcript text that triggered this
    trigger_entities TEXT,                  -- JSON array of entities that matched
    relevance_score REAL NOT NULL,          -- Combined relevance score (0-1)
    fts_score REAL,                         -- FTS5 component of score
    semantic_score REAL,                    -- Semantic similarity component
    recency_score REAL,                     -- Recency decay component
    shown_at TEXT NOT NULL,                 -- When this was displayed
    interaction TEXT DEFAULT 'shown',       -- 'shown' | 'clicked' | 'dismissed' | 'helpful'
    interaction_at TEXT,                    -- When user interacted
    created_at TEXT NOT NULL
);
CREATE INDEX idx_context_suggestions_meeting ON context_suggestions(meeting_id);
CREATE INDEX idx_context_suggestions_source ON context_suggestions(source_id);

-- Lightweight entity index for cross-meeting entity tracking
CREATE TABLE entity_index (
    id TEXT PRIMARY KEY,                    -- UUID
    canonical_name TEXT NOT NULL,           -- Display name: "Database Migration"
    entity_type TEXT NOT NULL,              -- 'project' | 'person' | 'tool' | 'topic' | 'decision'
    aliases TEXT,                           -- JSON array: ["DB migration", "Postgres move"]
    embedding BLOB,                         -- USE embedding of canonical name (512-dim Float32)
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    mention_count INTEGER DEFAULT 1,
    source_ids TEXT,                        -- JSON array of meeting/entry IDs where mentioned
    metadata TEXT                           -- JSON: arbitrary metadata (deadlines, owners, etc.)
);
CREATE INDEX idx_entity_index_type ON entity_index(entity_type);
CREATE INDEX idx_entity_index_name ON entity_index(canonical_name);

-- Entity mentions: links entities to specific locations in transcripts
CREATE TABLE entity_mentions (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL REFERENCES entity_index(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,              -- 'meeting' | 'entry' | 'note'
    source_id TEXT NOT NULL,
    mention_text TEXT NOT NULL,             -- The exact text that triggered the match
    context_snippet TEXT,                   -- Surrounding sentence for display
    offset_ms INTEGER,                      -- Position in meeting timeline (if meeting)
    created_at TEXT NOT NULL
);
CREATE INDEX idx_entity_mentions_entity ON entity_mentions(entity_id);
CREATE INDEX idx_entity_mentions_source ON entity_mentions(source_id);

-- Pre-meeting briefing cache
CREATE TABLE meeting_briefings (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,               -- The meeting this briefing was generated for
    series_tag TEXT,                        -- Recurring meeting identifier (user-assigned or auto)
    prior_meeting_ids TEXT NOT NULL,        -- JSON array of past meeting IDs used
    summary_text TEXT NOT NULL,             -- Generated briefing content (Markdown)
    action_items TEXT,                      -- JSON array of open action items
    key_topics TEXT,                        -- JSON array of topics from prior meetings
    generated_at TEXT NOT NULL,
    model_used TEXT                         -- 'llm' | 'template' (which generation method)
);
CREATE INDEX idx_meeting_briefings_meeting ON meeting_briefings(meeting_id);
```

### Relationships

```
meeting_sessions 1 <--> N context_suggestions   (one meeting gets many suggestions)
entity_index 1 <--> N entity_mentions            (one entity, many mentions)
meeting_sessions 1 <--> 1 meeting_briefings      (one briefing per meeting)
entries/meetings  1 <--> N entity_mentions        (sources contain entity mentions)
```

---

## Rust Core Changes

### New N-API Exports

```typescript
// --- Context Suggestions ---
logContextSuggestion(meetingId, sourceType, sourceId, sourceTitle, sourceDate,
    snippet, triggerText, triggerEntities, relevanceScore, ftsScore,
    semanticScore, recencyScore): string  // returns suggestion ID

updateSuggestionInteraction(id, interaction): void
getContextSuggestions(meetingId, limit): string  // JSON array
getInteractionStats(sinceDate): string  // JSON: {shown, clicked, dismissed, helpful}

// --- Entity Index ---
createEntity(canonicalName, entityType, aliases, embeddingBytes): string
updateEntity(id, canonicalName, aliases, embeddingBytes, mentionCount): void
findSimilarEntities(embeddingBytes, threshold, limit): string  // JSON array
getEntity(id): string  // JSON or "null"
listEntities(entityType, limit, offset): string  // JSON array
mergeEntities(sourceId, targetId): void  // Merge source into target
deleteEntity(id): void

// --- Entity Mentions ---
logEntityMention(entityId, sourceType, sourceId, mentionText, contextSnippet, offsetMs): void
getEntityMentions(entityId, limit): string  // JSON array
getMentionsForSource(sourceType, sourceId): string  // JSON array

// --- Briefings ---
saveBriefing(meetingId, seriesTag, priorMeetingIds, summaryText,
    actionItems, keyTopics, modelUsed): string
getBriefing(meetingId): string  // JSON or "null"
```

### Files to Modify

| File | Change |
|------|--------|
| `rust-core/src/storage/db.rs` | Add migration for new tables |
| `rust-core/src/storage/mod.rs` | Export new modules |
| `rust-core/src/lib.rs` | Register new N-API functions |
| `electron-app/src/main/ipc-handlers.ts` | Add IPC channels for copilot operations |
| `electron-app/src/main/native-bridge.ts` | Expose new Rust functions |
| `electron-app/src/preload/index.ts` | Add copilot API to contextBridge |

### New Files

| File | Purpose |
|------|---------|
| `rust-core/src/storage/context_suggestions.rs` | CRUD for context_suggestions table |
| `rust-core/src/storage/entity_index.rs` | Entity resolution + CRUD |
| `electron-app/src/renderer/components/MeetingCopilot.tsx` | Sidebar panel component |
| `electron-app/src/renderer/components/ContextCard.tsx` | Individual suggestion card |
| `electron-app/src/renderer/components/PreMeetingBriefing.tsx` | Briefing display |
| `electron-app/src/renderer/components/EntityBadge.tsx` | Entity highlight chip |
| `electron-app/src/renderer/components/CopilotSettings.tsx` | Settings sub-panel |
| `electron-app/src/renderer/stores/useCopilotStore.ts` | Zustand store for copilot state |
| `electron-app/src/renderer/services/CopilotService.ts` | Orchestration logic |
| `electron-app/src/renderer/services/EntityExtractor.ts` | Keyword/entity extraction |
| `electron-app/src/renderer/services/ContextRetriever.ts` | Historical search logic |
| `electron-app/src/renderer/services/RelevanceScorer.ts` | Scoring + dedup |
| `electron-app/src/renderer/services/BriefingGenerator.ts` | Pre-meeting briefing |

---

## Sidebar UI Design

### Layout Integration

```
┌─────────────────────────────────────────────────────────────┐
│  IronMic - Meeting Mode                            [|||] [x]│
├──────────────────────────────────┬──────────────────────────┤
│                                  │  MEETING COPILOT         │
│  Live Transcript                 │                          │
│                                  │  ┌────────────────────┐  │
│  [10:02] You: Let's talk about   │  │ Related: DB        │  │
│  the database migration status.  │  │ Migration           │  │
│                                  │  │                     │  │
│  [10:02] Alex: The staging       │  │ Sprint Planning     │  │
│  migration passed. We're ready   │  │ Mar 28:             │  │
│  for production.                 │  │ "Migration blocked  │  │
│                                  │  │  on schema tool.    │  │
│  [10:03] You: What about the     │  │  Target: Apr 10."   │  │
│  rollback plan?                  │  │                     │  │
│                                  │  │ [Click for full]    │  │
│                                  │  └────────────────────┘  │
│                                  │                          │
│                                  │  ┌────────────────────┐  │
│                                  │  │ 1:1 with Sarah     │  │
│                                  │  │ Apr 1:             │  │
│                                  │  │ "Staging passed.   │  │
│                                  │  │  Production next   │  │
│                                  │  │  sprint."          │  │
│                                  │  │ [Click for full]   │  │
│                                  │  └────────────────────┘  │
│                                  │                          │
│                                  │  ┌────────────────────┐  │
│                                  │  │ [Helpful] [Dismiss]│  │
│                                  │  └────────────────────┘  │
├──────────────────────────────────┴──────────────────────────┤
│  [Mic Active] Recording... 00:03:42          [Stop] [Pause] │
└─────────────────────────────────────────────────────────────┘
```

### Interaction Patterns

- **Auto-populate:** Suggestions appear automatically as the conversation progresses. No user action required.
- **Non-intrusive:** The sidebar is a fixed-width panel (300px) on the right. It does not overlay the transcript. Users can collapse it.
- **Card lifecycle:** New cards slide in from the top. Cards that are no longer relevant (topic changed >2 minutes ago) fade to lower opacity. Maximum 5 visible cards at once.
- **Click to expand:** Clicking a card opens the full source document (meeting transcript or note) in a modal, scrolled to the relevant section.
- **Feedback buttons:** Each card has subtle "Helpful" (thumbs up) and "Dismiss" (x) buttons. This feedback trains the relevance scorer over time.
- **Keyboard shortcut:** `Cmd+K` / `Ctrl+K` toggles the copilot sidebar.

---

## Relevance Scoring Algorithm

The final relevance score is a weighted combination:

```
relevance = (w1 * fts_score) + (w2 * semantic_score) + (w3 * recency_score) + (w4 * source_weight)

Default weights:
  w1 = 0.30  (FTS5 text match)
  w2 = 0.35  (Semantic similarity via USE)
  w3 = 0.20  (Recency: exponential decay, half-life = 14 days)
  w4 = 0.15  (Source type: meeting=1.0, note=0.8, entry=0.6)
```

### Recency Decay

```
recency_score = exp(-lambda * days_since_source)
lambda = ln(2) / 14  (half-life of 14 days)

Examples:
  Today:      1.00
  1 week ago: 0.71
  2 weeks:    0.50
  1 month:    0.25
  3 months:   0.02
```

### Deduplication

Before displaying, remove near-duplicates:
1. Compute pairwise cosine similarity between all candidate suggestion embeddings
2. If two suggestions have similarity > 0.85, keep the one with higher relevance score
3. If two suggestions are from the same source document, merge into one card showing the best snippet

### Adaptive Weights (ML-enhanced, optional)

Over time, use interaction data (clicked vs. dismissed) to adjust weights:
- Train a tiny logistic regression model on `(fts_score, semantic_score, recency_score, source_weight) -> clicked_or_not`
- Retrain weekly using all interaction data
- Store weights in `ml_model_weights` table (existing infrastructure)
- This lets the system learn the user's preferences: some users care about recency, others about semantic match

---

## Settings

New settings in **Settings > Meeting Copilot**:

| Setting | Default | Description |
|---------|---------|-------------|
| `copilot_enabled` | `false` | Enable the meeting copilot feature |
| `copilot_auto_show` | `true` | Auto-show sidebar when meeting starts |
| `copilot_max_suggestions` | `5` | Maximum visible suggestions at once |
| `copilot_sources` | `["meetings","entries","notes"]` | Which sources to search |
| `copilot_recency_halflife_days` | `14` | Recency decay half-life |
| `copilot_entity_extraction_llm` | `false` | Use LLM for entity extraction (expensive) |
| `copilot_briefing_enabled` | `true` | Generate pre-meeting briefing cards |
| `copilot_min_relevance` | `0.3` | Minimum relevance score to display |
| `copilot_keyboard_shortcut` | `CommandOrControl+K` | Toggle sidebar shortcut |

---

## Privacy Considerations

- **All searches are local.** The copilot queries the user's own SQLite database. No network requests. No external APIs.
- **Entity index stays on device.** The knowledge graph of projects, people, and topics is never transmitted. It lives in the same SQLite file as all other IronMic data.
- **Interaction logging is minimal.** Only tracks: suggestion was shown, clicked, dismissed, or marked helpful. No content is logged in the interaction — just the suggestion ID and action.
- **No cross-user data.** Even in a multi-device mesh scenario (see separate idea), entity indices are per-device and not synchronized by default.
- **Full deletion.** User can clear all entity data, suggestion history, and briefing cache from Settings. "Delete all copilot data" removes tables cleanly.
- **Audio is never stored.** The copilot works entirely on text transcripts. No audio is retained for entity extraction or context retrieval.

---

## Implementation Phases

### Phase 1: Entity Extraction Pipeline
- Implement `EntityExtractor.ts` with pattern-based and TF-IDF layers
- Add `entity_index` and `entity_mentions` tables (schema migration)
- Rust CRUD for entity storage
- Extract entities from live transcript chunks
- Unit tests for extraction accuracy on sample transcripts
- **Deliverable:** Entities are extracted from live meetings and stored in the index

### Phase 2: Context Retrieval Engine
- Implement `ContextRetriever.ts` using existing FTS5 and semantic search
- Implement `RelevanceScorer.ts` with weighted scoring
- Add `context_suggestions` table
- Rust CRUD for suggestion logging
- Performance testing: retrieval must complete in <500ms
- **Deliverable:** Given a transcript chunk, system returns ranked relevant historical context

### Phase 3: Sidebar UI
- Build `MeetingCopilot.tsx` sidebar panel
- Build `ContextCard.tsx` with expand, helpful, dismiss interactions
- Integrate with `useCopilotStore.ts` for state management
- Wire up to live transcript stream — auto-update as new chunks arrive
- Keyboard shortcut for toggle
- **Deliverable:** Working sidebar that shows relevant context during meetings

### Phase 4: Pre-Meeting Briefing
- Implement `BriefingGenerator.ts` with template-based and LLM-based modes
- Build `PreMeetingBriefing.tsx` component
- Add `meeting_briefings` table
- Detect recurring meetings by schedule pattern or user tag
- Auto-generate and display briefing card at meeting start
- **Deliverable:** Users see a summary of past discussions when a recurring meeting begins

### Phase 5: Adaptive Scoring and Entity Resolution
- Implement adaptive weight training using interaction data
- Implement entity resolution (merge similar entities across meetings)
- Add entity merge UI in a dedicated "Knowledge Base" view
- LLM-based entity extraction layer (optional, for users with LLM loaded)
- **Deliverable:** Relevance improves over time; entity index becomes a browsable knowledge graph

---

## Performance Considerations

| Operation | Time (Target) | Notes |
|-----------|--------------|-------|
| Entity extraction (pattern + TF-IDF) | <50ms | Per transcript chunk |
| USE embedding for query | ~50ms | Existing Web Worker infrastructure |
| FTS5 search | <20ms | SQLite is fast for this |
| Semantic search (compare against corpus) | <200ms | Depends on corpus size; index top 10K entries |
| Relevance scoring + dedup | <15ms | Pure computation, no I/O |
| Full pipeline per chunk | <400ms | Well within 5s transcription interval |
| Entity index memory | ~5MB | For 1000 tracked entities with embeddings |
| Pre-meeting briefing (template) | <100ms | Just database queries + string formatting |
| Pre-meeting briefing (LLM) | ~3s | Acceptable as a one-time operation at meeting start |

### Scaling Concerns

For users with large historical corpora (10,000+ entries):
- Semantic search becomes expensive (comparing query embedding against all stored embeddings)
- Mitigation: maintain an in-memory HNSW index (approximate nearest neighbors) built on startup
- Alternative: pre-filter by FTS5 results, then semantic-rank the top 50 candidates only
- The hybrid approach (FTS5 pre-filter + semantic re-rank) keeps latency under 200ms for any corpus size

---

## Open Questions

1. **How aggressively should suggestions update?** Every transcript chunk (~5s) may be too frequent. Should suggestions only update when a new entity is detected, or on a fixed cadence (every 15s)?

2. **Handling tangents:** If the meeting briefly mentions "the migration" but then moves to a completely different topic, how long should migration-related suggestions stay visible? Current design: fade after 2 minutes of no related mentions.

3. **LLM resource contention:** If the user has LLM cleanup enabled AND LLM entity extraction enabled, they compete for the same Mistral model. Options: queue requests, disable entity extraction during active cleanup, or use a smaller dedicated model for extraction.

4. **Briefing accuracy:** Template-based briefings may miss nuance. LLM-based briefings are better but slow (~3s) and require the model to be loaded. Should the system pre-generate briefings in the background (e.g., every evening for tomorrow's recurring meetings)?

5. **Entity disambiguation:** "Alex" in one meeting might be "Alex Chen" and in another "Alex Kim." How should the entity index handle ambiguous first-name-only references? Possible approach: link to speaker identity if speaker diarization is enabled.

6. **Information overload:** Users in back-to-back meetings may find the copilot distracting. Should there be a "focus mode" that suppresses suggestions unless explicitly requested via keyboard shortcut?

7. **Cold start:** New users have no historical data. The copilot is useless until there are at least a few meetings in the corpus. Should the UI explain this and show a progress indicator ("Copilot will activate after 3 meetings")?

---

## Dependencies

| Dependency | Already in project? | Purpose |
|-----------|---------------------|---------|
| USE embeddings (TF.js) | Yes | Semantic search queries |
| FTS5 (SQLite) | Yes | Full-text keyword search |
| Zustand | Yes | Copilot state management |
| Local LLM (Mistral) | Yes (optional) | Entity extraction + briefing generation |
| MeetingDetector | Yes | Triggers copilot activation |
| SemanticSearch service | Yes | Embedding storage + retrieval |

No new Rust crates or ML models required. This feature is built entirely on existing infrastructure.

---

## Success Metrics

- **Relevance:** >60% of displayed suggestions are clicked or marked helpful (not dismissed)
- **Latency:** Full pipeline completes in <500ms per transcript chunk
- **Coverage:** After 10+ meetings, >80% of entity references trigger at least one relevant suggestion
- **User engagement:** Users who enable the copilot keep it enabled (churn rate <20% after 2 weeks)
- **Briefing utility:** Pre-meeting briefings are rated "helpful" >70% of the time
- **Zero distraction:** The sidebar never causes the user to miss something in the live meeting (measured by post-meeting survey or implicit signals)
