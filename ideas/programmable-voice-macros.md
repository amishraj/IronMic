# Programmable Voice Macros (Voice Scripting Language)

## Overview

Add a YAML-based macro system that lets power users define custom voice-triggered workflows. A macro is a named pipeline: a voice trigger phrase activates a sequence of steps that query data, transform it with the local LLM, format the output, and deliver it to a destination (clipboard, file, note, or editor). Think of it as voice-activated shell scripting for knowledge work, entirely local.

Example: Say "ship the release notes" and IronMic pulls all meetings tagged "sprint review" from this week, extracts discussed changes, summarizes them via the local LLM into a markdown changelog, and copies the result to the clipboard. No clicking, no manual data gathering.

This builds on IronMic's existing intent classifier (for trigger matching), local LLM (for summarization/transformation), SQLite storage (for data queries), and clipboard manager (for output delivery). The macro engine is a new execution layer that orchestrates these existing capabilities.

---

## What This Enables

- **"Summarize this week"**: Pull all entries from the past 7 days, summarize key themes via LLM, format as bullet points, copy to clipboard. Takes 3 seconds instead of 10 minutes of scrolling.

- **"Prep for my 1-on-1 with Alex"**: Query meetings involving Alex from the past 2 weeks, extract action items and open questions, format as a prep document with sections for "Previous Action Items", "Topics to Discuss", "Questions to Ask". Copy to clipboard or insert into note editor.

- **"Ship the release notes"**: Pull meetings tagged "sprint review" from this sprint, extract feature discussions and bug fixes, format as a markdown changelog with version header and date, copy to clipboard for pasting into GitHub.

- **"Daily standup update"**: Query today's entries and meetings, extract what was done and what's planned, format as a standup update ("Yesterday I..., Today I will..., Blockers:..."), copy to clipboard.

- **"Extract all action items from today"**: Scan all today's meeting transcripts, extract sentences that contain commitments or tasks, deduplicate, format as a checklist. Save as a new note titled "Action Items - Apr 15".

- **"Client report for Acme Corp"**: Query all meetings and entries tagged "Acme" from the past month, summarize progress, extract key decisions, format as a client update email. Copy to clipboard.

- **"Practice pitch feedback"**: Take the most recent entry (presumably a practice recording), analyze it for clarity, structure, and persuasiveness via LLM, format feedback as bullet points with suggestions.

---

## Architecture

### New Components

```
Electron App
├── renderer/
│   ├── components/
│   │   ├── macros/
│   │   │   ├── MacroLibrary.tsx         # List/search/manage all macros
│   │   │   ├── MacroEditor.tsx          # Visual YAML editor with step builder
│   │   │   ├── MacroCard.tsx            # Single macro in library view
│   │   │   ├── MacroExecutionPanel.tsx  # Shows progress while macro runs
│   │   │   ├── MacroResultPreview.tsx   # Preview output before committing
│   │   │   ├── StepBuilder.tsx          # Drag-and-drop step configuration
│   │   │   └── MacroImportExport.tsx    # Share macros as files
│   │   │
│   │   └── settings/
│   │       └── MacroSettings.tsx        # Global macro preferences
│   │
│   ├── stores/
│   │   └── useMacroStore.ts             # Macro state, execution tracking
│   │
│   └── services/
│       ├── MacroEngine.ts               # Core execution engine
│       ├── MacroParser.ts               # YAML parsing and validation
│       ├── MacroTriggerMatcher.ts       # Voice trigger detection
│       ├── MacroStepExecutor.ts         # Runs individual steps
│       └── MacroSandbox.ts             # Execution safety and resource limits

Rust Core
├── storage/
│   └── macros.rs                        # NEW: Macro definition CRUD
```

### Execution Flow

```
[User speaks: "ship the release notes"]
        │
        ▼
[Existing Intent Classifier]
        │
        ├── Detected intent: "voice_macro"
        │   Confidence: 0.92
        │   Extracted trigger: "ship the release notes"
        │
        ▼
[MacroTriggerMatcher]
        │
        ├── Fuzzy match against registered triggers
        │   Best match: "ship release notes" (similarity: 0.95)
        │   Macro: "release-notes-generator"
        │
        ▼
[MacroEngine.execute("release-notes-generator")]
        │
        ├── Step 1: query_meetings
        │   Filter: tag="sprint review", date=this_week
        │   Result → $meetings (3 meetings found)
        │
        ├── Step 2: extract_text
        │   Source: $meetings
        │   Fields: transcript, action_items
        │   Result → $raw_content
        │
        ├── Step 3: llm_transform
        │   Prompt: "Summarize these sprint review discussions
        │            into a changelog. Group by feature area.
        │            Format as markdown with ## headers."
        │   Input: $raw_content
        │   Result → $changelog
        │
        ├── Step 4: format
        │   Template: "# Release Notes - $today\n\n$changelog"
        │   Result → $final
        │
        └── Step 5: copy_to_clipboard
            Input: $final
            ✓ Done — "Release notes copied to clipboard"
```

### Component Interaction

```
┌─────────────────────────────────────────────────────────┐
│  Renderer Process                                        │
│                                                          │
│  ┌─────────────────┐    ┌──────────────────────┐        │
│  │ Intent Classifier│───→│ MacroTriggerMatcher  │        │
│  │ (existing TF.js) │    │                      │        │
│  └─────────────────┘    └──────────┬───────────┘        │
│                                    │                     │
│                          ┌─────────▼──────────┐         │
│                          │   MacroEngine       │         │
│                          │                     │         │
│                          │  ┌───────────────┐  │         │
│                          │  │ MacroParser   │  │         │
│                          │  │ (YAML → AST)  │  │         │
│                          │  └───────────────┘  │         │
│                          │                     │         │
│                          │  ┌───────────────┐  │         │
│                          │  │ StepExecutor  │  │         │
│                          │  │               │  │         │
│                          │  │ query_entries──┼──┼──→ IPC → Rust (SQLite)
│                          │  │ query_meetings─┼──┼──→ IPC → Rust (SQLite)
│                          │  │ llm_transform──┼──┼──→ IPC → Rust (llama.cpp)
│                          │  │ copy_clipboard─┼──┼──→ IPC → Rust (arboard)
│                          │  │ save_note─────┼──┼──→ IPC → Rust (SQLite)
│                          │  │ format────────┼──┤  (local, no IPC)
│                          │  │ filter────────┼──┤  (local, no IPC)
│                          │  └───────────────┘  │         │
│                          │                     │         │
│                          │  ┌───────────────┐  │         │
│                          │  │ MacroSandbox  │  │         │
│                          │  │ (limits)      │  │         │
│                          │  └───────────────┘  │         │
│                          └─────────────────────┘         │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

---

## Macro Definition Format

### YAML Structure

```yaml
# ~/.ironmic/macros/release-notes.yaml
name: "Release Notes Generator"
description: "Generates changelog from this week's sprint review meetings"
version: 1
author: "Jason Humphrey"
tags: ["work", "release", "changelog"]

trigger:
  phrases:
    - "ship the release notes"
    - "generate release notes"
    - "build the changelog"
  # Optional: require exact match instead of fuzzy
  exact_match: false
  # Optional: minimum confidence from intent classifier
  min_confidence: 0.85

# Variables available to all steps
variables:
  sprint_tag: "sprint review"
  date_range: "this_week"      # Built-in: today, this_week, this_month, last_7_days, last_30_days
  version: "1.2.0"             # Static value, user can edit

steps:
  - id: fetch_meetings
    action: query_meetings
    params:
      tags: ["$sprint_tag"]
      date_range: "$date_range"
      limit: 20
    output: $meetings

  - id: check_results
    action: assert
    params:
      condition: "$meetings.length > 0"
      error_message: "No sprint review meetings found this week."

  - id: extract_content
    action: extract_text
    params:
      source: "$meetings"
      fields: ["transcript", "summary", "action_items"]
      separator: "\n---\n"
    output: $raw_content

  - id: generate_changelog
    action: llm_transform
    params:
      prompt: |
        You are a technical writer. Given these sprint review meeting transcripts,
        generate a clean changelog. Group changes by category (Features, Bug Fixes,
        Improvements, Breaking Changes). Use bullet points. Include only concrete
        changes, not discussion or process items.
        
        Meeting content:
        $raw_content
      max_tokens: 2000
      temperature: 0.3
    output: $changelog

  - id: format_output
    action: format
    params:
      template: |
        # Release Notes v$version - $today
        
        $changelog
        
        ---
        _Generated by IronMic from $meetings.length sprint review meetings._
    output: $final

  - id: deliver
    action: copy_to_clipboard
    params:
      content: "$final"
      notification: "Release notes for v$version copied to clipboard"
```

### Variable System

Variables are the data-passing mechanism between steps:

| Variable | Type | Description |
|----------|------|-------------|
| `$result` | any | Output of the previous step (implicit) |
| `$today` | string | Today's date in ISO format |
| `$now` | string | Current datetime in ISO format |
| `$day_of_week` | string | "Monday", "Tuesday", etc. |
| `$selection` | string | Currently selected text in the note editor |
| `$current_entry` | object | The currently open entry/note |
| `$current_meeting` | object | The currently open meeting session |
| `$meetings` | array | Result of a query_meetings step |
| `$entries` | array | Result of a query_entries step |
| `${step_id}` | any | Output of a named step by its `id` |
| User-defined | any | Set in `variables:` block or `set_variable` action |

Variable interpolation uses `$name` for simple values and `$name.field` for object properties. Array access: `$meetings[0].summary`, `$meetings.length`.

### Built-In Actions

#### Data Query Actions

```yaml
# Query dictation entries
- action: query_entries
  params:
    search: "optional FTS search query"
    tags: ["tag1", "tag2"]          # Filter by tags (AND)
    date_range: "this_week"          # Or explicit: { from: "2026-04-08", to: "2026-04-15" }
    limit: 50
    include_archived: false
    sort: "newest"                   # newest | oldest | relevance
  output: $entries

# Query meeting sessions
- action: query_meetings
  params:
    tags: ["sprint review"]
    date_range: "last_7_days"
    has_summary: true                # Only meetings with summaries
    has_action_items: true           # Only meetings with action items
    min_duration_minutes: 5
    limit: 20
  output: $meetings

# Semantic search (requires embeddings enabled)
- action: semantic_search
  params:
    query: "database migration progress"
    content_type: "entry"            # entry | meeting
    limit: 10
    min_similarity: 0.5
  output: $results
```

#### Text Extraction Actions

```yaml
# Extract specific fields from query results
- action: extract_text
  params:
    source: "$meetings"
    fields: ["transcript", "summary", "action_items"]
    separator: "\n---\n"
    include_metadata: true           # Prepend date/title to each item
  output: $text

# Extract from a single entry
- action: get_field
  params:
    source: "$current_entry"
    field: "polished_text"           # Or: raw_transcript, tags, created_at, etc.
  output: $text
```

#### LLM Actions

```yaml
# Transform text with the local LLM
- action: llm_transform
  params:
    prompt: "Summarize the following text as bullet points:\n\n$input"
    input: "$raw_content"            # Optional: appended to prompt if not interpolated
    max_tokens: 1000
    temperature: 0.3                 # 0-1, lower = more deterministic
    system_prompt: "You are a concise summarizer."  # Optional override
  output: $summary

# Ask the LLM a question about the data
- action: llm_ask
  params:
    question: "What were the main decisions made in these meetings?"
    context: "$raw_content"
    max_tokens: 500
  output: $answer

# Classify text
- action: llm_classify
  params:
    text: "$entry.transcript"
    categories: ["bug report", "feature request", "question", "update", "other"]
  output: $category
```

#### Formatting Actions

```yaml
# Template-based formatting
- action: format
  params:
    template: |
      # Weekly Summary - $today
      
      ## Key Themes
      $themes
      
      ## Action Items
      $action_items
  output: $formatted

# Convert between formats
- action: convert
  params:
    input: "$markdown_text"
    from: "markdown"
    to: "plain_text"                 # plain_text | markdown | html
  output: $converted
```

#### Filter and Transform Actions

```yaml
# Filter array items
- action: filter
  params:
    source: "$entries"
    condition: "item.tags.includes('important')"
    # Or simple field match:
    where:
      is_pinned: true
  output: $filtered

# Sort array
- action: sort
  params:
    source: "$entries"
    by: "created_at"
    direction: "desc"
  output: $sorted

# Map/transform each item
- action: map
  params:
    source: "$entries"
    template: "- [$item.created_at] $item.polished_text"
    separator: "\n"
  output: $list

# Concatenate multiple variables
- action: concat
  params:
    parts: ["$header", "\n\n", "$body", "\n\n", "$footer"]
  output: $combined

# Count items
- action: count
  params:
    source: "$entries"
  output: $total

# Set a variable
- action: set_variable
  params:
    name: "greeting"
    value: "Hello, here is your report for $today"
```

#### Output Actions

```yaml
# Copy to clipboard
- action: copy_to_clipboard
  params:
    content: "$final"
    notification: "Copied to clipboard!"  # Optional toast message

# Save as a new entry/note
- action: save_entry
  params:
    text: "$final"
    tags: ["generated", "release-notes"]
    source: "macro:release-notes"

# Insert into the active note editor
- action: insert_in_editor
  params:
    content: "$final"
    position: "cursor"               # cursor | start | end | replace_selection

# Save to file (within IronMic's data directory only)
- action: save_file
  params:
    content: "$final"
    filename: "release-notes-$today.md"
    # Files saved to: ~/.ironmic/exports/
    # Cannot write outside this directory (sandboxed)

# Show in a preview panel (user can then copy/save)
- action: preview
  params:
    content: "$final"
    title: "Release Notes Preview"
    format: "markdown"               # Rendered as markdown in preview
```

#### Control Flow Actions

```yaml
# Conditional execution
- action: if
  params:
    condition: "$meetings.length > 0"
    then:
      - action: extract_text
        params: { source: "$meetings", fields: ["summary"] }
        output: $summaries
    else:
      - action: set_variable
        params: { name: "summaries", value: "No meetings found." }

# Assert (stop execution with error if condition fails)
- action: assert
  params:
    condition: "$entries.length > 0"
    error_message: "No entries found matching your criteria."

# User prompt (ask for input before continuing)
- action: prompt_user
  params:
    message: "Which version number for the release notes?"
    default: "1.0.0"
    variable: "version"
```

---

## Trigger Matching

### How Triggers Are Detected

The existing intent classifier is extended with a "macro" intent category. When the classifier detects a voice command (vs dictation), the transcript is passed to the MacroTriggerMatcher.

```
[Voice Input: "Hey, can you ship the release notes for this week?"]
        │
        ▼
[Intent Classifier]
        │
        ├── Intent: "voice_macro" (confidence: 0.88)
        │   (as opposed to "dictation", "command", "question")
        │
        ▼
[MacroTriggerMatcher]
        │
        ├── Normalize input: strip filler, lowercase
        │   "ship the release notes for this week"
        │
        ├── Compare against all registered trigger phrases:
        │   ┌─────────────────────────────────┬────────────┐
        │   │ Trigger Phrase                   │ Similarity │
        │   ├─────────────────────────────────┼────────────┤
        │   │ "ship the release notes"         │ 0.92       │
        │   │ "generate release notes"         │ 0.78       │
        │   │ "summarize this week"            │ 0.45       │
        │   │ "daily standup update"           │ 0.22       │
        │   └─────────────────────────────────┴────────────┘
        │
        ├── Best match: "ship the release notes" (0.92 > 0.85 threshold)
        │
        ▼
[Execute macro: "release-notes-generator"]
```

### Matching Algorithm

1. **Exact match**: If the normalized transcript exactly matches a trigger phrase, execute immediately.
2. **Fuzzy match**: Compute similarity using a combination of:
   - **Token overlap**: Jaccard similarity of word sets (handles word order variation).
   - **Edit distance**: Normalized Levenshtein distance (handles minor transcription errors).
   - **Semantic similarity**: If semantic search is enabled, compute USE embedding similarity between the transcript and each trigger phrase.
3. **Weighted score**: `0.3 * token_overlap + 0.3 * (1 - edit_distance) + 0.4 * semantic_similarity`
4. **Threshold**: Score must exceed `min_confidence` (default 0.85) to trigger. If between 0.70 and 0.85, show a confirmation: "Did you mean to run 'Release Notes Generator'?"

### Conflict Resolution

If multiple macros match above threshold:
- Show a disambiguation menu: "Which macro did you mean?"
- List top 3 matches with their trigger phrases.
- User selects one or says "cancel."

---

## Macro Engine: Execution Details

### Execution Model

Steps execute sequentially. Each step receives the current variable context, performs its action, and optionally stores output in a named variable. The engine tracks execution state for progress reporting and error recovery.

```typescript
interface MacroExecutionContext {
  variables: Map<string, any>;        // Current variable state
  steps: MacroStep[];                 // All steps in the macro
  currentStepIndex: number;           // Progress tracking
  startedAt: number;                  // Execution start time
  status: 'running' | 'paused' | 'completed' | 'failed';
  errors: MacroError[];               // Accumulated errors
  executionLog: StepResult[];         // Result of each completed step
}

interface StepResult {
  stepId: string;
  action: string;
  startedAt: number;
  completedAt: number;
  output: any;
  error?: string;
}
```

### Step Execution

```typescript
async function executeStep(step: MacroStep, ctx: MacroExecutionContext): Promise<any> {
  // 1. Interpolate variables in params
  const resolvedParams = interpolateVariables(step.params, ctx.variables);

  // 2. Validate params against action schema
  validateParams(step.action, resolvedParams);

  // 3. Check sandbox limits
  checkResourceLimits(step.action, ctx);

  // 4. Execute action
  const result = await actionExecutors[step.action](resolvedParams, ctx);

  // 5. Store output
  if (step.output) {
    ctx.variables.set(step.output.replace('$', ''), result);
  }
  ctx.variables.set('result', result);  // Always update $result

  return result;
}
```

### Error Handling

```yaml
# Per-step error handling
steps:
  - action: query_meetings
    params:
      tags: ["sprint review"]
      date_range: "this_week"
    output: $meetings
    on_error: skip          # skip | abort (default) | retry

  - action: assert
    params:
      condition: "$meetings.length > 0"
      error_message: "No sprint review meetings found."
    # If assert fails → macro aborts with error message shown to user
```

Error modes:
- **abort** (default): Stop execution, show error to user, clean up.
- **skip**: Log the error, set output to null, continue to next step.
- **retry**: Retry the step once after 1 second (useful for LLM timeouts).

---

## Sandboxed Execution

### Why Sandboxing Matters

Macros execute user-defined logic that queries data and invokes the LLM. Without limits, a badly-written macro could:
- Query the entire database repeatedly (performance).
- Send enormous prompts to the LLM (memory/time).
- Write unlimited files to disk.
- Run indefinitely.

### Resource Limits

| Resource | Limit | Configurable |
|----------|-------|-------------|
| Max steps per macro | 50 | Yes |
| Max execution time | 60 seconds | Yes |
| Max LLM calls per macro | 5 | Yes |
| Max LLM tokens per call | 4000 | Yes |
| Max total LLM tokens per macro | 10000 | Yes |
| Max query results per step | 100 | Yes |
| Max file write size | 1 MB | Yes |
| File write directory | `~/.ironmic/exports/` only | No |
| Max variables in context | 100 | No |
| Max string variable size | 500 KB | No |

### Execution Isolation

- Macros cannot access the filesystem outside `~/.ironmic/exports/`.
- Macros cannot make network requests (consistent with IronMic's zero-network principle).
- Macros cannot modify other macros or settings.
- Macros cannot access raw audio or voice prints.
- Macros operate on a read-only view of entries and meetings (except for `save_entry` which creates new entries, and `insert_in_editor` which appends to the current note).

---

## Database Schema

### New Tables

```sql
-- Macro definitions
CREATE TABLE macros (
    id TEXT PRIMARY KEY,                    -- UUID
    name TEXT NOT NULL,
    description TEXT,
    version INTEGER DEFAULT 1,
    author TEXT,
    tags TEXT,                              -- JSON array
    trigger_phrases TEXT NOT NULL,           -- JSON array of trigger strings
    trigger_exact_match INTEGER DEFAULT 0,
    trigger_min_confidence REAL DEFAULT 0.85,
    variables_json TEXT,                    -- JSON object of default variables
    steps_json TEXT NOT NULL,               -- JSON array of step definitions
    is_enabled INTEGER DEFAULT 1,
    is_builtin INTEGER DEFAULT 0,           -- Shipped with IronMic
    source TEXT,                            -- 'user' | 'builtin' | 'imported'
    imported_from TEXT,                     -- File path or URL if imported
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_executed_at TEXT,
    execution_count INTEGER DEFAULT 0,
    avg_execution_time_ms REAL
);
CREATE INDEX idx_macros_enabled ON macros(is_enabled);

-- Macro execution history
CREATE TABLE macro_executions (
    id TEXT PRIMARY KEY,                    -- UUID
    macro_id TEXT NOT NULL REFERENCES macros(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL,                   -- 'running' | 'completed' | 'failed' | 'cancelled'
    steps_completed INTEGER DEFAULT 0,
    steps_total INTEGER NOT NULL,
    error_message TEXT,                     -- Null on success
    execution_time_ms REAL,
    output_preview TEXT,                    -- First 500 chars of final output
    variables_snapshot TEXT                 -- JSON snapshot of final variable state
);
CREATE INDEX idx_macro_exec_macro ON macro_executions(macro_id);
CREATE INDEX idx_macro_exec_time ON macro_executions(started_at);

-- Shared macro packages (for import/export)
CREATE TABLE macro_packages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    macros_json TEXT NOT NULL,              -- JSON array of full macro definitions
    author TEXT,
    version TEXT,
    created_at TEXT NOT NULL,
    checksum TEXT                           -- SHA-256 of macros_json for integrity
);
```

### Relationships

```
macros 1 ←→ N macro_executions    (execution history per macro)
macro_packages 1 ←→ N macros      (logical grouping, not FK — macros are copied on import)
```

---

## Macro Library

### Built-In Macros

IronMic ships with a set of useful macros that demonstrate the system's capabilities:

```yaml
# 1. Weekly Summary
name: "Weekly Summary"
trigger: ["summarize this week", "weekly summary", "what happened this week"]
steps:
  - query_entries: { date_range: this_week }
  - query_meetings: { date_range: this_week }
  - llm_transform: "Summarize the key themes, decisions, and action items from this week"
  - copy_to_clipboard

# 2. Daily Standup
name: "Daily Standup Update"
trigger: ["standup update", "daily standup", "what did I do yesterday"]
steps:
  - query_entries: { date_range: { from: yesterday, to: today } }
  - query_meetings: { date_range: { from: yesterday, to: today } }
  - llm_transform: "Format as: Yesterday I..., Today I will..., Blockers:"
  - copy_to_clipboard

# 3. Meeting Prep
name: "Meeting Prep"
trigger: ["prep for my meeting with $person", "prepare for $person"]
steps:
  - query_meetings: { involving: "$person", date_range: last_30_days, limit: 5 }
  - extract_text: { fields: [summary, action_items] }
  - llm_transform: "Generate a meeting prep doc with Previous Topics, Open Items, Suggested Agenda"
  - preview

# 4. Action Item Roundup
name: "Action Items Today"
trigger: ["action items from today", "what needs doing", "today's tasks"]
steps:
  - query_meetings: { date_range: today, has_action_items: true }
  - extract_text: { fields: [action_items] }
  - llm_transform: "Deduplicate and format as a checklist"
  - save_entry: { tags: [action-items, generated] }

# 5. Quick Email Draft
name: "Email Draft"
trigger: ["draft an email about $topic", "write an email about $topic"]
steps:
  - query_entries: { search: "$topic", limit: 10 }
  - llm_transform: "Draft a professional email about $topic using the context provided"
  - copy_to_clipboard
```

### Macro Library UI

```
┌──────────────────────────────────────────────────────────────┐
│  Voice Macros                              [+ New Macro]     │
│  ─────────────                                               │
│                                                              │
│  Search macros...                    Filter: [All ▼]         │
│                                                              │
│  Built-In                                                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ ◉ Weekly Summary                    Runs: 12          │  │
│  │   "summarize this week"             Last: 2h ago      │  │
│  │   Pulls entries + meetings, summarizes via LLM        │  │
│  │   [Edit]  [Duplicate]  [Disable]  [Run Now]           │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ ◉ Daily Standup Update              Runs: 45          │  │
│  │   "standup update"                  Last: 18h ago     │  │
│  │   Generates Yesterday/Today/Blockers format           │  │
│  │   [Edit]  [Duplicate]  [Disable]  [Run Now]           │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  My Macros                                                   │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ ◉ Release Notes Generator           Runs: 3           │  │
│  │   "ship the release notes"          Last: 3d ago      │  │
│  │   Sprint review → changelog → clipboard               │  │
│  │   [Edit]  [Duplicate]  [Delete]  [Run Now]  [Export]  │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ ○ Client Report (Acme)              Runs: 0           │  │
│  │   "client report for acme"          Never run         │  │
│  │   Monthly progress summary for Acme Corp              │  │
│  │   [Edit]  [Duplicate]  [Delete]  [Run Now]  [Export]  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  [Import Macro...]                                           │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Visual Macro Editor

For users who prefer not to write YAML directly, a visual step builder:

```
┌──────────────────────────────────────────────────────────────┐
│  Edit Macro: Release Notes Generator                         │
│  ─────────────────────────────                               │
│                                                              │
│  Name: [Release Notes Generator          ]                   │
│  Trigger phrases:                                            │
│    [ship the release notes    ] [x]                          │
│    [generate release notes    ] [x]                          │
│    [+ Add trigger]                                           │
│                                                              │
│  Variables:                                                  │
│    version = [1.2.0]    sprint_tag = [sprint review]         │
│    [+ Add variable]                                          │
│                                                              │
│  Steps:                                                      │
│  ┌─ 1 ─────────────────────────────────────────────────┐    │
│  │ [Query Meetings ▼]                                   │    │
│  │ Tags: [$sprint_tag]   Date: [This Week ▼]           │    │
│  │ Output: $meetings                                    │    │
│  │                                         [x] [↕]     │    │
│  └──────────────────────────────────────────────────────┘    │
│                        │                                     │
│  ┌─ 2 ─────────────────▼───────────────────────────────┐    │
│  │ [Assert ▼]                                           │    │
│  │ Condition: $meetings.length > 0                      │    │
│  │ Error: "No sprint review meetings found."            │    │
│  │                                         [x] [↕]     │    │
│  └──────────────────────────────────────────────────────┘    │
│                        │                                     │
│  ┌─ 3 ─────────────────▼───────────────────────────────┐    │
│  │ [LLM Transform ▼]                                   │    │
│  │ Prompt: [Generate a changelog from...]               │    │
│  │ Input: $raw_content  Temp: 0.3  Tokens: 2000        │    │
│  │ Output: $changelog                                   │    │
│  │                                         [x] [↕]     │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  [+ Add Step]                                                │
│                                                              │
│  ┌────────┐  ┌────────────┐  ┌──────────┐                   │
│  │  Save  │  │ Test Run   │  │ View YAML│                   │
│  └────────┘  └────────────┘  └──────────┘                   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Import / Export and Sharing

### Export Format

Macros export as `.ironmic-macro` files (YAML with a metadata header):

```yaml
# IronMic Macro Package v1
# Exported: 2026-04-15T10:30:00Z
# Checksum: sha256:a1b2c3d4...

package:
  name: "Sprint Workflow Pack"
  version: "1.0.0"
  author: "Jason Humphrey"
  description: "Macros for sprint ceremony workflows"

macros:
  - name: "Release Notes Generator"
    # ... full macro definition ...
  - name: "Sprint Retro Summary"
    # ... full macro definition ...
```

### Import Flow

1. User clicks "Import Macro" or drags `.ironmic-macro` file into the app.
2. IronMic parses and validates the file (schema validation, step action whitelist).
3. Shows a preview: macro name, description, steps, trigger phrases.
4. User confirms import.
5. Macro is copied into the local database (not linked to the file).
6. If trigger phrases conflict with existing macros, user is warned and can rename.

### Enterprise Team Sharing

For teams that want shared macro libraries without a server:

1. Macros are exported as `.ironmic-macro` files.
2. Files are placed in a shared directory (Dropbox, OneDrive, network share, Git repo).
3. IronMic can watch a configured "shared macros" directory for new/updated files.
4. Setting: `macro_shared_directory` — path to watch.
5. New macros from the shared directory appear in a "Team Macros" section of the library.
6. Team macros are read-only by default (user can duplicate to customize).

This approach requires no server, no network, and no sync protocol — just a shared filesystem, which many enterprises already have.

---

## Integration with Existing Systems

### Intent Classifier (existing)

The intent classifier already categorizes voice input as dictation vs command. A new "macro" intent category is added to the training data. When the classifier detects a macro intent, the transcript is routed to MacroTriggerMatcher instead of the standard command handler.

Training data additions:
- Positive: trigger phrases from all registered macros.
- Negative: similar-sounding dictation that should NOT trigger macros.
- The classifier is retrained (on-device) whenever macros are added or trigger phrases change.

### Local LLM (existing)

The `llm_transform` and `llm_ask` actions use the same llama.cpp instance as the text polishing feature. Macros share the LLM queue — if a polish operation is in progress, macro LLM calls wait. The LLM is the bottleneck: each call takes 2-5 seconds, so macros with multiple LLM steps take proportionally longer.

### Clipboard (existing)

The `copy_to_clipboard` action calls the existing `copyToClipboard()` N-API function. No changes needed.

### Note Editor (existing)

The `insert_in_editor` action sends text to the TipTap editor via the existing IPC bridge. The editor receives a `insertContent` event and inserts at the cursor position (or appends, or replaces selection, depending on the `position` parameter).

### Workflow Discovery (existing)

The existing workflow mining feature detects repeated action sequences. When a user repeatedly performs the same manual steps (query → copy → paste), the workflow miner can suggest: "You do this sequence often. Want to create a macro for it?" This bridges the gap between automatic workflow detection and explicit macro creation.

---

## Settings

New settings under **Settings > Macros**:

| Setting | Default | Description |
|---------|---------|-------------|
| `macros_enabled` | `false` | Master toggle for macro system |
| `macro_trigger_threshold` | `0.85` | Minimum similarity for voice trigger match |
| `macro_confirm_before_run` | `false` | Ask "Run [macro name]?" before executing |
| `macro_max_execution_time_s` | `60` | Maximum seconds per macro execution |
| `macro_max_llm_calls` | `5` | Maximum LLM invocations per macro |
| `macro_max_llm_tokens` | `10000` | Maximum total LLM tokens per macro |
| `macro_shared_directory` | `""` | Path to shared macro directory (empty = disabled) |
| `macro_show_preview` | `true` | Show output preview before delivering to clipboard |
| `macro_execution_history_days` | `30` | Retention for execution history |

---

## Privacy Considerations

- **Macros run locally**: All data queries, LLM calls, and output actions happen on-device. No macro execution ever triggers network access.
- **Macros cannot exfiltrate data**: The sandbox prevents file writes outside `~/.ironmic/exports/` and blocks all network access. The only outputs are clipboard, note editor, and local files.
- **Imported macros are inspectable**: Users can view the full YAML of any imported macro before enabling it. No obfuscated or compiled macros.
- **LLM prompts are user-visible**: The prompt sent to the local LLM for each `llm_transform` step is stored in the execution log and can be reviewed.
- **Shared macros contain no data**: Exported `.ironmic-macro` files contain only the macro definition (triggers, steps, prompts). They never contain user data, entries, or meeting content.
- **Execution history is local**: Macro execution logs (including output previews) are stored in SQLite and follow the same retention/deletion policies as other IronMic data.

---

## Implementation Phases

### Phase 1: Core Engine and YAML Parser
- Implement `MacroParser.ts` — YAML schema validation, step parsing
- Implement `MacroEngine.ts` — sequential step executor with variable interpolation
- Implement `MacroStepExecutor.ts` — action handlers for: query_entries, query_meetings, extract_text, format, copy_to_clipboard
- Add `macros` and `macro_executions` tables (schema migration)
- Add `macros.rs` to Rust core for CRUD operations
- Manual trigger only (no voice trigger yet) — "Run Now" button
- **Deliverable:** User can write a YAML macro and execute it via the UI

### Phase 2: LLM Actions and Sandbox
- Add `llm_transform`, `llm_ask`, `llm_classify` action handlers
- Implement `MacroSandbox.ts` — resource limits, execution timeout, action whitelist
- Add `save_entry`, `insert_in_editor`, `save_file` action handlers
- Add `filter`, `sort`, `map`, `count`, `concat` action handlers
- Error handling: abort / skip / retry per step
- **Deliverable:** Full action library with LLM integration and safety limits

### Phase 3: Voice Triggers
- Implement `MacroTriggerMatcher.ts` — fuzzy matching with token overlap + edit distance
- Extend intent classifier with "macro" intent category
- Add trigger phrase management (add/remove/edit per macro)
- Conflict detection for overlapping triggers
- Confirmation flow for low-confidence matches
- **Deliverable:** Say a trigger phrase and the macro runs

### Phase 4: UI — Library and Editor
- Build `MacroLibrary.tsx` — list, search, filter, enable/disable
- Build `MacroEditor.tsx` — visual step builder
- Build `MacroExecutionPanel.tsx` — live progress during execution
- Build `MacroResultPreview.tsx` — preview output before committing
- YAML view/edit toggle in editor
- **Deliverable:** Full macro management UI

### Phase 5: Built-In Macros and Import/Export
- Ship 5-8 built-in macros covering common workflows
- Build `MacroImportExport.tsx` — export as `.ironmic-macro`, import with validation
- Shared directory watching for team macros
- Execution history view with output previews
- **Deliverable:** Ready-to-use macros and team sharing

### Phase 6: Advanced Features
- Semantic search action (requires embeddings enabled)
- Conditional execution (`if`/`assert` steps)
- User prompt action (interactive macros that ask for input)
- Macro chaining (one macro can invoke another)
- Macro scheduling ("run Weekly Summary every Friday at 5pm")
- Integration with workflow discovery ("Create macro from this pattern?")
- **Deliverable:** Power-user workflow automation

---

## Performance Considerations

| Operation | Time | Notes |
|-----------|------|-------|
| YAML parsing + validation | <10ms | Schema check on macro definition |
| Trigger matching (20 macros) | <5ms | String similarity computation |
| query_entries (100 results) | <50ms | SQLite with FTS5 |
| query_meetings (20 results) | <30ms | SQLite query |
| extract_text (20 items) | <5ms | String concatenation |
| format (template render) | <1ms | String interpolation |
| llm_transform | 2-5s | Local LLM inference (bottleneck) |
| copy_to_clipboard | <5ms | Via arboard |
| save_file (1MB) | <50ms | Disk write |
| Full macro (3 query + 1 LLM + format) | ~3-6s | Dominated by LLM call |
| Full macro (3 query + 3 LLM + format) | ~8-16s | Multiple LLM calls |

The LLM is always the bottleneck. Macros with zero LLM calls complete in <100ms. Each LLM call adds 2-5 seconds. The execution panel shows progress per step so the user knows what's happening during longer macros.

---

## N-API Surface Additions

```typescript
// --- Macros ---
createMacro(yamlContent: string): Promise<string>           // returns macro_id
updateMacro(id: string, yamlContent: string): Promise<void>
deleteMacro(id: string): Promise<void>
getMacro(id: string): string                                // JSON or "null"
listMacros(includeDisabled: boolean): string                // JSON array
enableMacro(id: string, enabled: boolean): void
updateMacroStats(id: string, executionTimeMs: number): void

// --- Macro Execution History ---
logMacroExecution(executionJson: string): Promise<string>    // returns execution_id
getMacroExecutions(macroId: string, limit: number): string   // JSON array
deleteOldMacroExecutions(retentionDays: number): number

// --- Macro Packages (Import/Export) ---
exportMacroPackage(macroIds: string[], packageName: string): string  // YAML string
importMacroPackage(yamlContent: string): Promise<string[]>           // returns macro_ids
validateMacroYaml(yamlContent: string): string                       // JSON: { valid, errors }
```

---

## Open Questions

1. **YAML vs JSON vs GUI-only**: YAML is human-readable and familiar to developers, but non-technical users may never touch it. Should the visual editor be the primary interface, with YAML as an "advanced" export format? Or should both be first-class?

2. **Macro parameter extraction from speech**: When a user says "prep for my meeting with Alex," how do we extract "Alex" as a parameter? The intent classifier can detect entities, but mapping them to macro variables requires a binding mechanism. Should triggers support `$person` placeholders that are filled from entity extraction?

3. **LLM prompt quality**: Macros live or die by their LLM prompts. Bad prompts produce useless output. Should IronMic offer prompt templates for common macro types (summarize, extract, format, classify)? Should there be a "test step" feature that runs a single LLM step with sample data?

4. **Macro versioning**: When a built-in macro is updated in a new IronMic release, but the user has customized it, how do we handle the conflict? Options: always keep user's version, offer merge, keep both as separate macros.

5. **Recursive macros**: Should a macro be able to call another macro as a step? This enables powerful composition but also introduces loop risk. If allowed, we need a max recursion depth (e.g., 3 levels).

6. **Rate limiting LLM calls**: A macro with 5 LLM calls takes 10-25 seconds. Should there be a way to batch or parallelize LLM calls? The local LLM is single-threaded, so true parallelism isn't possible, but we could optimize by pre-computing all prompts and feeding them sequentially without waiting for user interaction between steps.

7. **Macro marketplace**: Should there be a way to discover and share macros beyond file exchange? A simple GitHub-hosted JSON index of community macros (fetched on demand, not automatically) could work without violating the zero-telemetry principle — the user explicitly requests the catalog.

---

## Dependencies

| Dependency | Already in project? | Purpose |
|-----------|---------------------|---------|
| `js-yaml` | **No — needs adding** | YAML parsing in renderer process |
| `ajv` | **No — needs adding** | JSON Schema validation for macro definitions |
| `string-similarity` | **No — needs adding** | Fuzzy trigger matching (Dice coefficient) |
| Local LLM (llama.cpp) | Yes | LLM transform/ask/classify actions |
| SQLite (rusqlite) | Yes | Macro storage, query actions |
| Clipboard (arboard) | Yes | copy_to_clipboard action |
| Intent Classifier (TF.js) | Yes | Macro intent detection |

Three new npm dependencies, all lightweight. No new Rust dependencies.

---

## Success Metrics

- Macro creation: 80% of users can create a working macro within 5 minutes using the visual editor
- Trigger accuracy: >90% of voice triggers correctly match the intended macro
- Execution reliability: >99% of macro executions complete without errors (for well-formed macros)
- Execution speed: Average macro completes in <5 seconds (1 LLM call) or <15 seconds (3 LLM calls)
- Adoption: Users who enable macros execute an average of 3+ macros per week after the first month
- Built-in macro usage: >50% of users with macros enabled use at least one built-in macro
