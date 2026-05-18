# Organizational Voice Intelligence

## Overview

Build a personal knowledge graph on top of IronMic's local corpus of dictations, meetings, and AI conversations. The goal: turn months of accumulated voice data into a queryable memory layer. "What did I decide about the pricing model last month?" "What commitments did I make in my 1-on-1s this quarter?" "When did we last discuss the API migration?"

IronMic already stores every dictation, meeting transcript, and AI chat locally in SQLite with FTS5 and semantic search (USE embeddings). But keyword search and embedding similarity are not enough for organizational intelligence. The user needs entity-aware, temporally-aware, relationship-aware retrieval. This feature extracts structured entities (people, projects, decisions, commitments, dates, topics) from the unstructured voice corpus, builds a relationship graph, and exposes it through a natural language query interface powered by the local LLM.

Everything runs locally. The knowledge graph lives in SQLite. Entity extraction uses the existing llama.cpp LLM. No new models required.

---

## What This Enables

- Natural language memory queries:
  ```
  You: "What commitments did I make to Sarah this quarter?"
  IronMic: Found 4 commitments involving Sarah Chen (Q1 2026):
    1. Jan 15 standup: "I'll review the auth PR by end of week"
    2. Feb 3 1-on-1: "I'll write the performance review by Friday"
    3. Feb 20 standup: "I'll handle the staging deployment"
    4. Mar 8 meeting: "I'll set up the new CI pipeline this sprint"
    Status: 2 completed (marked in later meetings), 2 unknown
  ```

- Decision tracking:
  ```
  You: "What did we decide about the caching strategy?"
  IronMic: Found 3 discussions about caching:
    1. Feb 10: "Discussed Redis vs Memcached. Leaning toward Redis."
    2. Feb 17: "Decided to go with Redis for session caching. Budget approved."
    3. Mar 5: "Revisited — adding Redis Cluster for high availability."
    Final decision: Redis Cluster for session caching (Mar 5)
  ```

- People context before meetings:
  ```
  You: "Summarize my interactions with Alex this month."
  IronMic: 6 meetings with Alex Chen in March:
    - Sprint planning (Mar 1, 4, 8, 15, 22, 29)
    - Key topics: API migration, database performance, hiring
    - Open commitments: Alex owes load test results; you owe review of migration plan
    - Sentiment: collaborative, no conflicts detected
  ```

- Project timeline:
  ```
  You: "Give me a timeline of the API migration project."
  IronMic:
    Jan 10: First mentioned — Alex proposed migrating to v3
    Jan 24: Decision to proceed, estimated 6 weeks
    Feb 7: Database schema migration completed (Alex)
    Feb 21: Endpoint migration 60% done, staging tests failing
    Mar 7: Staging tests fixed, production deploy scheduled for Mar 14
    Mar 14: Successfully deployed to production
    Mar 21: Post-mortem — 2 minor issues, both resolved
  ```

---

## Architecture

### New Components

```
Rust Core
├── knowledge/
│   ├── mod.rs
│   ├── extractor.rs         # LLM-powered entity/relationship extraction
│   ├── entity_types.rs      # Entity type definitions and serialization
│   ├── graph.rs             # In-memory graph operations (query, traverse)
│   ├── query_engine.rs      # Natural language → structured query → results
│   ├── temporal.rs          # Temporal reasoning (date parsing, range queries)
│   └── indexer.rs           # Background indexing of existing corpus
│
├── storage/
│   ├── entities.rs          # Entity CRUD
│   ├── relationships.rs     # Relationship CRUD
│   └── knowledge_queries.rs # Complex graph queries in SQL

Electron App
├── renderer/
│   ├── components/
│   │   ├── KnowledgePage.tsx          # Main knowledge graph UI
│   │   ├── MemoryQuery.tsx            # Natural language query input + results
│   │   ├── EntityCard.tsx             # Display a person/project/decision entity
│   │   ├── EntityDetail.tsx           # Full entity view with relationships
│   │   ├── RelationshipGraph.tsx      # Visual graph (D3.js or similar)
│   │   ├── TimelineBrowser.tsx        # Temporal view of entities/events
│   │   ├── CommitmentTracker.tsx      # Track open/closed commitments
│   │   ├── DecisionLog.tsx            # Browse decisions with context
│   │   └── KnowledgeSettings.tsx      # Indexing controls, entity types config
│   ├── stores/
│   │   └── useKnowledgeStore.ts       # Entity/relationship/query state
│   └── services/
│       ├── KnowledgeService.ts        # Orchestrates extraction + queries
│       └── GraphLayoutEngine.ts       # Force-directed graph positioning
```

### System Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     Existing Data Sources                     │
│                                                               │
│  [Entries Table]   [Meeting Sessions]   [AI Chat History]     │
│   ~raw_transcript   ~summary             ~messages            │
│   ~polished_text    ~action_items        ~context             │
│   ~tags             ~speaker_segments                         │
│   ~created_at       ~duration                                 │
└──────────┬──────────────────┬────────────────────┬───────────┘
           │                  │                    │
           └──────────────────┼────────────────────┘
                              │
                              ▼
                   [Entity Extractor (LLM)]
                   "Extract people, projects,
                    decisions, commitments,
                    dates, topics from this text"
                              │
                    ┌─────────┼─────────┐
                    │         │         │
                    ▼         ▼         ▼
              [Entities] [Relations] [Events]
                    │         │         │
                    └─────────┼─────────┘
                              │
                              ▼
                    [Knowledge Graph (SQLite)]
                    entities + relationships +
                    temporal_events tables
                              │
                    ┌─────────┼─────────┐
                    │         │         │
                    ▼         ▼         ▼
             [Query Engine]  [Graph   [Timeline
              NL → SQL       Viz]     Browser]
                    │
                    ▼
            [LLM Query Interpreter]
            "What did I decide about X?"
                    │
                    ▼
            [Structured SQL Query]
            SELECT ... FROM entities
            JOIN relationships ...
            WHERE type='decision'
            AND mentions LIKE '%X%'
                    │
                    ▼
            [LLM Result Summarizer]
            "You made 3 decisions about X..."
```

### Data Flow: Entry to Knowledge Graph

```
[New Entry Created / Meeting Ends]
           │
           ▼
[Background Indexer Queue]
           │
           ▼
[Entity Extractor]
  Input:  "In the standup, Alex said the auth migration is done.
           Sarah mentioned the API tests are failing on staging.
           I committed to filing a ticket for that by EOD."
  
  LLM extracts:
  ┌────────────────────────────────────────────────┐
  │ Entities:                                       │
  │   - Person: "Alex" (existing: Alex Chen)        │
  │   - Person: "Sarah" (existing: Sarah Kim)       │
  │   - Project: "auth migration"                   │
  │   - Project: "API tests"                        │
  │   - System: "staging"                           │
  │                                                 │
  │ Events:                                         │
  │   - Completion: "auth migration is done"        │
  │     who: Alex, when: today, status: completed   │
  │   - Issue: "API tests failing on staging"       │
  │     who: Sarah (reporter), status: open         │
  │   - Commitment: "filing a ticket by EOD"        │
  │     who: self, deadline: today EOD              │
  │                                                 │
  │ Relationships:                                  │
  │   - Alex → works_on → auth migration            │
  │   - Sarah → reported → API test failure         │
  │   - self → committed_to → file ticket           │
  │   - API tests → blocked_by → staging issue      │
  └────────────────────────────────────────────────┘
           │
           ▼
[Entity Resolution]
  "Alex" → match to existing entity "Alex Chen" (fuzzy match + context)
  "auth migration" → match to existing project entity (embedding similarity)
  "API tests" → create new entity or match existing
           │
           ▼
[Store in SQLite]
  INSERT INTO entities ...
  INSERT INTO relationships ...
  INSERT INTO temporal_events ...
```

---

## Entity Types

### Core Entity Types

```
Person
├── name: string (display name)
├── aliases: string[] ("Alex", "Alex Chen", "AC")
├── role: string? ("engineer", "manager", "designer")
├── organization: string?
├── is_self: boolean
└── Relationships: works_on, manages, reports_to, collaborates_with

Project
├── name: string
├── aliases: string[] ("auth migration", "the auth thing", "migration project")
├── status: active | completed | paused | cancelled
├── started_at: date?
├── completed_at: date?
└── Relationships: has_member, depends_on, part_of

Decision
├── summary: string ("Use Redis for session caching")
├── context: string (why this was decided)
├── decided_by: Person[]
├── decided_at: date
├── status: active | superseded | reversed
├── superseded_by: Decision? (links to newer decision on same topic)
└── Relationships: about_project, made_by, affects

Commitment
├── description: string ("Review the auth PR by end of week")
├── committed_by: Person (who made the promise)
├── committed_to: Person? (who was it promised to)
├── deadline: date?
├── status: open | completed | missed | cancelled
├── completed_at: date?
├── evidence_entry_id: string? (entry where completion was mentioned)
└── Relationships: related_to_project, assigned_to

Topic
├── name: string ("caching", "hiring", "performance")
├── aliases: string[]
├── category: technical | business | organizational | personal
└── Relationships: discussed_in, related_to

Meeting
├── session_id: string (FK to meeting_sessions)
├── title: string
├── date: date
├── participants: Person[]
├── topics_discussed: Topic[]
└── Relationships: produced_decisions, produced_commitments, involved
```

### Relationship Types

```
works_on:         Person → Project (role: lead | member | reviewer)
manages:          Person → Person
collaborates_with: Person ↔ Person (bidirectional)
decided:          Person → Decision
committed_to:     Person → Commitment
discussed:        Meeting → Topic
produced:         Meeting → Decision | Commitment
related_to:       any → any (generic association)
supersedes:       Decision → Decision
depends_on:       Project → Project
mentioned_in:     Entity → Entry (source reference back to transcript)
```

---

## Database Schema

### New Tables

```sql
-- Extracted entities
CREATE TABLE entities (
    id TEXT PRIMARY KEY,                -- UUID
    type TEXT NOT NULL,                 -- 'person' | 'project' | 'decision' | 'commitment' | 'topic'
    name TEXT NOT NULL,                 -- Primary display name
    aliases TEXT DEFAULT '[]',          -- JSON array of alternative names
    properties TEXT DEFAULT '{}',       -- JSON: type-specific properties (status, deadline, etc.)
    first_seen_at TEXT NOT NULL,        -- First entry where this entity appeared
    last_seen_at TEXT NOT NULL,         -- Most recent entry
    mention_count INTEGER DEFAULT 1,   -- How many entries mention this entity
    confidence REAL DEFAULT 1.0,       -- Extraction confidence (0-1)
    is_verified INTEGER DEFAULT 0,     -- User has confirmed this entity
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_entities_type ON entities(type);
CREATE INDEX idx_entities_name ON entities(name);
CREATE INDEX idx_entities_last_seen ON entities(last_seen_at);

-- Full-text search on entity names and aliases
CREATE VIRTUAL TABLE entities_fts USING fts5(
    name,
    aliases,
    content='entities',
    content_rowid='rowid'
);

-- Relationships between entities
CREATE TABLE relationships (
    id TEXT PRIMARY KEY,                -- UUID
    source_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    type TEXT NOT NULL,                 -- 'works_on' | 'decided' | 'committed_to' | etc.
    properties TEXT DEFAULT '{}',       -- JSON: role, strength, notes
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    mention_count INTEGER DEFAULT 1,
    confidence REAL DEFAULT 1.0,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_rel_source ON relationships(source_entity_id);
CREATE INDEX idx_rel_target ON relationships(target_entity_id);
CREATE INDEX idx_rel_type ON relationships(type);
CREATE UNIQUE INDEX idx_rel_unique ON relationships(source_entity_id, target_entity_id, type);

-- Temporal events (things that happened at a specific time)
CREATE TABLE temporal_events (
    id TEXT PRIMARY KEY,                -- UUID
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    entry_id TEXT,                      -- FK to entries.id (source transcript)
    meeting_id TEXT,                    -- FK to meeting_sessions.id (source meeting)
    event_type TEXT NOT NULL,           -- 'created' | 'completed' | 'decided' | 'mentioned' |
                                       -- 'committed' | 'status_changed' | 'discussed'
    description TEXT,                   -- Human-readable event description
    occurred_at TEXT NOT NULL,          -- When the event happened (ISO 8601)
    properties TEXT DEFAULT '{}',       -- JSON: additional metadata
    created_at TEXT NOT NULL
);
CREATE INDEX idx_events_entity ON temporal_events(entity_id);
CREATE INDEX idx_events_occurred ON temporal_events(occurred_at);
CREATE INDEX idx_events_entry ON temporal_events(entry_id);
CREATE INDEX idx_events_type ON temporal_events(event_type);

-- Entity mentions — links entities back to source entries
CREATE TABLE entity_mentions (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    entry_id TEXT,                      -- FK to entries.id
    meeting_id TEXT,                    -- FK to meeting_sessions.id
    excerpt TEXT,                       -- The relevant text snippet
    position_start INTEGER,            -- Character offset in source text
    position_end INTEGER,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_mentions_entity ON entity_mentions(entity_id);
CREATE INDEX idx_mentions_entry ON entity_mentions(entry_id);

-- Query history (for improving query interpretation over time)
CREATE TABLE knowledge_queries (
    id TEXT PRIMARY KEY,
    query_text TEXT NOT NULL,           -- User's natural language query
    interpreted_as TEXT,                -- JSON: structured query representation
    result_count INTEGER,
    response_text TEXT,                 -- LLM-generated response
    user_rating INTEGER,               -- -1 (bad), 0 (neutral), 1 (good)
    created_at TEXT NOT NULL
);
```

### Relationships

```
entities 1 ←→ N relationships (as source or target)
entities 1 ←→ N temporal_events
entities 1 ←→ N entity_mentions
entries 1 ←→ N entity_mentions
entries 1 ←→ N temporal_events
meeting_sessions 1 ←→ N entity_mentions
meeting_sessions 1 ←→ N temporal_events
```

---

## Entity Extraction Pipeline

### LLM Extraction Prompt

```
You are an entity extraction system for a personal knowledge base.
Given a transcript (from a dictation, meeting, or conversation), extract:

1. PEOPLE: Names of people mentioned (not "someone" or "they" — only named individuals)
2. PROJECTS: Named projects, features, initiatives, codebases, products
3. DECISIONS: Explicit decisions made ("we decided to...", "let's go with...", "the plan is...")
4. COMMITMENTS: Promises, action items, things someone agreed to do ("I'll...", "can you...", "by Friday")
5. TOPICS: Key subjects discussed (technical concepts, business areas)

For each entity, provide:
- name: the most specific name used
- type: person | project | decision | commitment | topic
- context: a one-sentence description from the transcript
- temporal: any date/time/deadline mentioned (relative dates resolved to absolute using today's date)
- relationships: connections to other extracted entities

For COMMITMENTS, also provide:
- who: the person who committed (use "self" if it's the speaker/user)
- to_whom: who received the commitment (if clear)
- deadline: when it's due (if mentioned)
- status: open (default)

Output valid JSON only. No explanation.

Today's date: {{today}}
Source type: {{source_type}}  (dictation | meeting | ai_chat)
{{#if meeting_participants}}Known participants: {{meeting_participants}}{{/if}}

Transcript:
"""
{{transcript}}
"""
```

### Entity Resolution

When the LLM extracts "Alex," we need to determine if this is the same "Alex Chen" from previous meetings. Resolution strategy:

1. **Exact match:** Entity name or alias matches exactly (case-insensitive)
2. **Fuzzy match:** Levenshtein distance < 2 for short names, or Jaccard similarity > 0.8 for multi-word names
3. **Context match:** If the same entry mentions a known project that "Alex Chen" works on, boost match confidence
4. **Embedding similarity:** Compare the sentence context around the mention against stored entity descriptions using existing USE embeddings
5. **User confirmation:** If confidence < 0.7, flag for review in the entity card UI

### Incremental Indexing

- New entries trigger extraction immediately (background, non-blocking)
- A single entry typically produces 2-8 entities and 3-10 relationships
- Extraction takes ~3-5 seconds per entry (one LLM inference pass)
- The indexer maintains a queue; if the user creates entries faster than extraction, they queue up
- Existing corpus (backfill) runs as a low-priority background job

### Deduplication and Merging

Over time, the same entity may be extracted multiple times with slightly different names:
- "auth migration," "the authentication migration," "auth project"
- These should all resolve to one entity

Merge strategy:
1. After extraction, run a lightweight similarity check against existing entities of the same type
2. If a match is found, increment `mention_count` and update `last_seen_at`
3. Add new aliases if the name variant is novel
4. If no match, create a new entity
5. Users can manually merge entities in the UI ("These are the same project")

---

## Query Engine

### Natural Language Query Flow

```
[User types: "What commitments did I make to Sarah this quarter?"]
           │
           ▼
[Query Interpreter (LLM)]
  Prompt: "Convert this question into a structured query.
           Available entity types: person, project, decision, commitment, topic
           Available relationship types: works_on, decided, committed_to, ...
           Available time ranges: today, this_week, this_month, this_quarter, this_year
           Output JSON query structure."
           │
           ▼
[Structured Query]
  {
    "type": "commitment",
    "filters": {
      "committed_by": "self",
      "related_person": "Sarah",
      "time_range": {
        "from": "2026-01-01",
        "to": "2026-03-31"
      },
      "status": ["open", "completed"]
    },
    "include": ["source_excerpt", "deadline", "status"],
    "order_by": "occurred_at ASC"
  }
           │
           ▼
[SQL Query Builder]
  SELECT e.*, te.occurred_at, te.description, em.excerpt
  FROM entities e
  JOIN temporal_events te ON te.entity_id = e.id
  JOIN entity_mentions em ON em.entity_id = e.id
  JOIN relationships r ON r.source_entity_id = e.id
  JOIN entities target ON r.target_entity_id = target.id
  WHERE e.type = 'commitment'
    AND e.properties->>'committed_by' = 'self'
    AND target.name LIKE '%Sarah%'
    AND te.occurred_at BETWEEN '2026-01-01' AND '2026-03-31'
  ORDER BY te.occurred_at ASC
           │
           ▼
[Results: 4 commitments]
           │
           ▼
[Result Summarizer (LLM)]
  Prompt: "Summarize these query results in a helpful response.
           Include dates, specific commitments, and current status.
           Be concise but complete."
           │
           ▼
[Display in MemoryQuery component]
```

### Query Types Supported

| Query Pattern | Example | SQL Strategy |
|---|---|---|
| Entity lookup | "What projects is Alex working on?" | JOIN entities + relationships WHERE type='works_on' |
| Temporal query | "What happened last week?" | temporal_events WHERE occurred_at BETWEEN ... |
| Decision search | "What did we decide about caching?" | entities WHERE type='decision' + FTS on name/context |
| Commitment tracking | "My open commitments" | entities WHERE type='commitment' AND status='open' |
| Person summary | "Summarize interactions with Sarah" | Aggregate across meetings, topics, commitments for person |
| Topic timeline | "Timeline of the API migration" | temporal_events for project entity, ordered by date |
| Relationship query | "Who works on the payments team?" | Graph traversal: Person → works_on → Project(payments) |
| Comparison | "How much time did we spend on hiring vs engineering?" | Topic mention counts across time ranges |

### Fallback to Semantic Search

If the structured query returns zero results, fall back to the existing semantic search (USE embeddings) over the raw entry corpus. This catches cases where the entity extractor missed something but the information exists in the transcripts.

---

## Integration with Existing Systems

### FTS5 Integration

The knowledge graph complements, not replaces, existing FTS5 search:
- FTS5 handles keyword matching on raw text ("find entries containing 'Redis'")
- The knowledge graph handles semantic/structural queries ("what decisions about caching")
- The query engine tries the knowledge graph first, falls back to FTS5, then to semantic search

### Semantic Search (USE) Integration

Entity descriptions and relationship contexts can be embedded using the existing Universal Sentence Encoder:
- Each entity gets a USE embedding of its name + context
- Entity resolution uses these embeddings for fuzzy matching
- Query interpretation uses embeddings when the LLM query structure is ambiguous

### Meeting Integration

Meetings are the richest source of entities:
- After meeting end, the knowledge extractor runs on the full transcript
- If speaker separation is enabled, commitments are attributed to specific speakers
- Action items from MeetingDetector are cross-referenced with extracted commitments
- Meeting participants are automatically linked to Person entities

### AI Chat Integration

AI chat conversations often produce decisions and action items:
- The extractor runs on AI chat history (user messages + assistant responses)
- Decisions reached through AI discussion are captured
- "The AI suggested X and I agreed" → Decision entity

### Analytics Integration

The existing analytics dashboard can be extended:
- "Topics over time" chart using entity mention_count by week
- "Commitment completion rate" from commitment status tracking
- "Most discussed people/projects" from entity frequency
- "Decision velocity" — how many decisions per week

---

## Rust Core N-API Surface (New Exports)

```typescript
// --- Entity CRUD ---
createEntity(type: string, name: string, properties: string): Promise<string>  // returns entity JSON
getEntity(id: string): Promise<string | null>
updateEntity(id: string, updates: string): Promise<void>
deleteEntity(id: string): Promise<void>
listEntities(type?: string, limit?: number, offset?: number): Promise<string>  // JSON array
searchEntities(query: string, type?: string): Promise<string>  // FTS search
mergeEntities(sourceId: string, targetId: string): Promise<void>

// --- Relationship CRUD ---
createRelationship(sourceId: string, targetId: string, type: string, properties: string): Promise<string>
getRelationships(entityId: string, direction?: string, type?: string): Promise<string>
deleteRelationship(id: string): Promise<void>

// --- Temporal Events ---
createTemporalEvent(entityId: string, entryId: string, eventType: string, description: string, occurredAt: string): Promise<string>
getEntityTimeline(entityId: string, from?: string, to?: string): Promise<string>
getTimelineRange(from: string, to: string, entityTypes?: string): Promise<string>

// --- Entity Extraction ---
extractEntities(transcript: string, sourceType: string, sourceId: string, context?: string): Promise<string>
getExtractionQueue(): Promise<number>  // pending items
reindexEntry(entryId: string): Promise<void>
reindexAll(): Promise<void>  // background job

// --- Knowledge Queries ---
queryKnowledge(naturalLanguageQuery: string): Promise<string>  // JSON with results + summary
getCommitments(status?: string, personId?: string, from?: string, to?: string): Promise<string>
getDecisions(topicId?: string, from?: string, to?: string): Promise<string>
getPersonSummary(personId: string, from?: string, to?: string): Promise<string>

// --- Entity Mentions ---
getEntityMentions(entityId: string, limit?: number): Promise<string>
linkEntityToEntry(entityId: string, entryId: string, excerpt: string): Promise<void>

// --- Stats ---
getKnowledgeStats(): Promise<string>  // entity counts, relationship counts, index status
```

---

## New Files

### Rust Core

| File | Purpose |
|------|---------|
| `rust-core/src/knowledge/mod.rs` | Module exports |
| `rust-core/src/knowledge/extractor.rs` | LLM entity/relationship extraction |
| `rust-core/src/knowledge/entity_types.rs` | Entity type definitions, serialization |
| `rust-core/src/knowledge/graph.rs` | In-memory graph traversal, shortest path |
| `rust-core/src/knowledge/query_engine.rs` | NL query → SQL → results → summary |
| `rust-core/src/knowledge/temporal.rs` | Date parsing, relative→absolute, range queries |
| `rust-core/src/knowledge/indexer.rs` | Background extraction queue, backfill |
| `rust-core/src/storage/entities.rs` | Entity CRUD operations |
| `rust-core/src/storage/relationships.rs` | Relationship CRUD operations |
| `rust-core/src/storage/knowledge_queries.rs` | Complex graph SQL queries |

### Electron App

| File | Purpose |
|------|---------|
| `electron-app/src/renderer/components/KnowledgePage.tsx` | Main knowledge graph view |
| `electron-app/src/renderer/components/MemoryQuery.tsx` | Natural language query interface |
| `electron-app/src/renderer/components/EntityCard.tsx` | Entity display card |
| `electron-app/src/renderer/components/EntityDetail.tsx` | Full entity view |
| `electron-app/src/renderer/components/RelationshipGraph.tsx` | Visual graph (Canvas/SVG) |
| `electron-app/src/renderer/components/TimelineBrowser.tsx` | Temporal entity view |
| `electron-app/src/renderer/components/CommitmentTracker.tsx` | Open/closed commitments |
| `electron-app/src/renderer/components/DecisionLog.tsx` | Decision browser |
| `electron-app/src/renderer/components/KnowledgeSettings.tsx` | Indexing config |
| `electron-app/src/renderer/stores/useKnowledgeStore.ts` | Entity/query state |
| `electron-app/src/renderer/services/KnowledgeService.ts` | Extraction + query orchestration |
| `electron-app/src/renderer/services/GraphLayoutEngine.ts` | Force-directed layout |

### Files to Modify

| File | Change |
|------|--------|
| `rust-core/src/lib.rs` | Add N-API exports for knowledge functions |
| `rust-core/src/storage/db.rs` | Add migration for entity/relationship/event tables |
| `electron-app/src/main/ipc-handlers.ts` | Wire knowledge IPC channels |
| `electron-app/src/preload/index.ts` | Expose knowledge API to renderer |
| `electron-app/src/renderer/components/Layout.tsx` | Add Knowledge nav item |
| `electron-app/src/renderer/components/SearchBar.tsx` | Add "Ask" mode alongside keyword search |
| `electron-app/src/renderer/components/MeetingDetail.tsx` | Show extracted entities post-meeting |
| `electron-app/src/renderer/components/EntryCard.tsx` | Show entity tags on entries |
| `electron-app/src/renderer/components/AnalyticsDashboard.tsx` | Add entity-based analytics |

---

## Privacy Considerations

- **All extraction is local.** The LLM (llama.cpp) runs on-device. No transcript text leaves the machine.
- **Entity data is derived, not new.** Every entity traces back to an existing entry. Deleting the source entry can cascade-delete its entities.
- **People entities store names only.** No biometric data, no contact info beyond what the user explicitly adds. Voice print data (if speaker separation is enabled) is separate.
- **User controls indexing scope.** Settings allow excluding specific entries, date ranges, or source types (e.g., "don't index AI chat conversations").
- **Full deletion.** "Delete all knowledge data" wipes entities, relationships, events, and mentions without affecting the source transcripts.
- **No inference beyond the corpus.** The system never speculates about information not in the transcripts. If the user asks something not in their data, the system says "No information found" rather than hallucinating.

---

## Phased Rollout

### Phase 1: Entity Extraction Foundation
- Implement entity type definitions and storage schema (migration)
- Build `extractor.rs` with LLM extraction prompt
- Entity resolution (exact + fuzzy matching)
- Extract entities from new entries as they're created (background)
- Basic `KnowledgePage.tsx` showing entity list by type
- **Deliverable:** Entities automatically extracted from dictations and meetings; browsable list

### Phase 2: Relationships and Temporal Events
- Implement relationship extraction and storage
- Temporal event tracking (decisions, commitments with dates)
- Entity deduplication and merge UI
- `EntityDetail.tsx` showing relationships and timeline per entity
- `CommitmentTracker.tsx` for open/closed commitment tracking
- **Deliverable:** Click on a person → see their projects, decisions, commitments over time

### Phase 3: Natural Language Query Engine
- Implement query interpreter (LLM-powered NL → structured query)
- SQL query builder for graph traversal
- Result summarizer (LLM-powered)
- `MemoryQuery.tsx` chat-like query interface
- Query history with user ratings for improvement
- **Deliverable:** "What commitments did I make this week?" returns structured, sourced results

### Phase 4: Corpus Backfill and Graph Visualization
- Background indexer for existing entry corpus
- Progress tracking for backfill ("Indexed 450/1200 entries")
- `RelationshipGraph.tsx` visual graph with force-directed layout
- `TimelineBrowser.tsx` temporal view across all entity types
- **Deliverable:** Full knowledge graph over the user's entire history, visually browsable

### Phase 5: Advanced Intelligence
- Commitment status auto-detection (scan new entries for completion signals)
- Decision supersession tracking (detect when an old decision is overridden)
- Proactive insights: "You have 3 overdue commitments" notification
- Cross-reference with meeting templates (standup action items → commitments)
- Export knowledge graph (JSON-LD, Markdown timeline)
- `DecisionLog.tsx` — searchable decision archive with full context

---

## Performance Considerations

| Operation | Time | Notes |
|-----------|------|-------|
| Entity extraction per entry | ~3-5s | Single LLM inference; runs in background |
| Entity resolution (match against 500 entities) | ~50ms | FTS + fuzzy match in SQLite |
| Knowledge query (NL → SQL → results) | ~4-6s | LLM interpretation + SQL + LLM summary |
| Graph visualization (200 nodes) | ~100ms | Force-directed layout in JS |
| Backfill 1000 entries | ~60-80 min | Background job, ~4s per entry |
| Entity table with 5000 entities | <10ms queries | SQLite with indexes |

The main concern is backfill time for users with large existing corpora. This runs as a low-priority background job and doesn't block normal usage. Incremental extraction for new entries (3-5s) runs after each entry is saved, concurrent with other processing.

### Memory

- In-memory graph cache for the 200 most-referenced entities: ~5MB
- LLM context for extraction: same as existing (Mistral loaded once, shared)
- No new ML models — reuses existing llama.cpp and USE embeddings

---

## Open Questions

1. **Extraction accuracy.** LLM entity extraction from noisy speech-to-text transcripts will have errors. How aggressively should we surface uncertain entities? Should there be a "review extracted entities" queue, or should we only show high-confidence ones?

2. **Commitment completion detection.** Automatically detecting when a commitment is fulfilled is hard. "I'll review the PR by Friday" → later "I reviewed Alex's PR yesterday" — the LLM needs to connect these. Should we attempt this automatically or rely on manual status updates?

3. **Scale.** A power user doing 10+ meetings/week for a year produces ~500 meetings and ~5000 entries. That is ~25,000 entities and ~50,000 relationships. SQLite handles this fine, but the graph visualization needs level-of-detail rendering. What is the practical display limit?

4. **Entity type extensibility.** Should users be able to define custom entity types beyond the built-in ones? E.g., "customer," "feature request," "bug." This adds complexity but increases utility for domain-specific use cases.

5. **Cross-entity queries.** "Which of Sarah's commitments relate to projects that Alex also works on?" requires multi-hop graph traversal. How many hops should the query engine support before falling back to the LLM for interpretation?

6. **Conflicting information.** If the user said "We're using Redis" in January and "We decided to switch to Memcached" in March, the system should surface the latest decision. How to handle contradictions gracefully without losing historical context?

7. **Shared contexts.** If two users both run IronMic and attend the same meeting, they'll build separate knowledge graphs. Is there ever a scenario for merging/importing entities (with user consent)?

---

## Dependencies

| Dependency | Already in project? | Purpose |
|-----------|---------------------|---------|
| `llama-cpp-rs` | Yes | Entity extraction + query interpretation |
| `rusqlite` | Yes | Entity/relationship storage |
| `serde_json` | Yes | Entity serialization |
| `chrono` | Yes (via other features) | Date parsing and temporal queries |
| `strsim` | **No — needs adding** | Fuzzy string matching for entity resolution |

One new Rust dependency (`strsim` for Levenshtein/Jaro-Winkler distance), plus a JS graphing library for the visualization component (e.g., `d3-force` or `@antv/g6`).

---

## Success Metrics

- Entity extraction precision: >80% of extracted entities are meaningful and correctly typed
- Entity resolution accuracy: >90% of duplicate mentions resolve to the correct existing entity
- Query response relevance: >75% of natural language queries return useful results (user-rated)
- Query latency: <6 seconds from question to displayed answer
- Commitment tracking: >70% of commitments have accurate status (open/completed)
- Backfill throughput: 1000 entries indexed within 90 minutes on a modern laptop
- User engagement: Users who enable the knowledge graph query it >5 times per week
