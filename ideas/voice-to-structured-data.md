# Voice-to-Structured-Data

## Overview

Extend IronMic beyond free-form text transcription to produce structured, machine-readable output from voice input. Instead of just capturing "Log an expense: forty-seven fifty at Home Depot, home improvement category, today's date" as a text note, IronMic extracts the fields, validates them, and outputs a clean JSON object, CSV row, or formatted record that can be appended to a file, pasted into a spreadsheet, or consumed by an external tool.

Users define schemas (templates) for the structured data they want to capture: expenses, contacts, inventory items, CRM entries, meeting action items, time logs, bug reports — anything with a consistent set of fields. IronMic's local LLM (Mistral) extracts the values from the spoken transcript, validates them against the schema's type and constraint rules, and presents a preview form for confirmation before outputting the final record.

Everything runs locally. The LLM does the extraction. The schemas, records, and templates live in SQLite. No data leaves the device.

---

## What This Enables

- **Expense logging by voice:**
  ```
  User speaks: "Log an expense. Forty-seven fifty at Home Depot.
                Category: home improvement. Date: today."
  
  IronMic extracts:
  ┌──────────────────────────────────┐
  │  Expense Record                  │
  │                                  │
  │  Amount:    $47.50               │
  │  Vendor:    Home Depot           │
  │  Category:  Home Improvement     │
  │  Date:      2026-04-15           │
  │                                  │
  │  [Edit] [Copy JSON] [Append CSV] │
  └──────────────────────────────────┘
  ```

- **Contact capture during conversation:**
  ```
  User speaks: "Add a contact. Sarah Chen, VP of Engineering at Acme Corp.
                Email is sarah.chen@acmecorp.com. Met her at the Q1 offsite."
  
  IronMic extracts:
  {
    "name": "Sarah Chen",
    "title": "VP of Engineering",
    "company": "Acme Corp",
    "email": "sarah.chen@acmecorp.com",
    "context": "Met at Q1 offsite"
  }
  ```

- **Batch data entry:** Voice-fill a spreadsheet row by row:
  ```
  User: "New row. Widget A, quantity 500, unit price 2.49, warehouse B."
  User: "New row. Widget B, quantity 120, unit price 7.99, warehouse A."
  User: "New row. Gasket C, quantity 2000, unit price 0.15, warehouse B."
  
  Output (CSV):
  item,quantity,unit_price,warehouse
  Widget A,500,2.49,B
  Widget B,120,7.99,A
  Gasket C,2000,0.15,B
  ```

- **Bug report filing:**
  ```
  User speaks: "File a bug. Title: Login button unresponsive on Safari.
                Priority: high. Steps to reproduce: click login on Safari 17,
                nothing happens. Expected: redirect to dashboard."
  
  IronMic extracts and formats as a structured bug report.
  ```

- **Time tracking:**
  ```
  User: "Log time. Two hours on the API refactor project. Billable. Client: Acme."
  
  → { "hours": 2, "project": "API Refactor", "billable": true, "client": "Acme" }
  ```

---

## Architecture

### New Components

```
Rust Core
├── structured/
│   ├── mod.rs
│   ├── schema.rs             # Schema definition, validation rules, type system
│   ├── extractor.rs          # LLM prompt construction for field extraction
│   ├── validator.rs          # Type checking, constraint enforcement, coercion
│   └── formatter.rs          # Output formatting (JSON, CSV, Markdown table)
│
├── storage/
│   ├── custom_schemas.rs     # Schema CRUD
│   └── structured_records.rs # Extracted record CRUD

Electron App
├── renderer/
│   ├── components/
│   │   ├── StructuredDataPage.tsx        # Top-level view for structured data feature
│   │   ├── SchemaEditor.tsx              # Visual schema builder
│   │   ├── SchemaCard.tsx                # Schema template card in gallery
│   │   ├── SchemaGallery.tsx             # Browse/search available schemas
│   │   ├── FieldEditor.tsx               # Single field configuration
│   │   ├── RecordPreview.tsx             # Post-extraction preview form
│   │   ├── RecordHistory.tsx             # History of extracted records per schema
│   │   ├── BatchEntryMode.tsx            # Row-by-row batch data entry UI
│   │   ├── OutputFormatPicker.tsx        # JSON / CSV / Markdown / Clipboard chooser
│   │   └── StructuredDataSettings.tsx    # Feature settings
│   ├── stores/
│   │   └── useStructuredDataStore.ts     # Schema + record state management
│   └── services/
│       ├── StructuredDataService.ts      # Orchestrates extraction pipeline
│       ├── SchemaValidator.ts            # Client-side validation logic
│       └── OutputFormatter.ts            # Client-side formatting
```

### Data Flow: Voice to Structured Record

```
[Voice Input]
      │
      ▼
[1. Whisper STT]                   ← Existing transcription pipeline
      │
      ▼
[2. Intent Detection]              ← Existing intent classifier detects "log X" / "add X"
      │                               pattern and identifies target schema
      │
      ├── No schema match → Normal dictation flow (entry/clipboard)
      │
      ├── Schema match detected:
      │
      ▼
[3. Schema Selection]              ← Resolve which schema to use:
      │                               - Explicit: "log an expense" → expense schema
      │                               - Implicit: detected fields match a known schema
      │                               - Ambiguous: prompt user to choose
      │
      ▼
[4. LLM Field Extraction]         ← Send transcript + schema definition to local Mistral
      │                               Structured output prompt → JSON response
      │                               ~500ms-2s depending on transcript length
      │
      ▼
[5. Validation]                    ← Check extracted values against schema rules:
      │                               - Required fields present?
      │                               - Types correct? (number, date, email, enum)
      │                               - Constraints satisfied? (min/max, regex, enum set)
      │
      ├── All valid:
      │   ▼
      │   [6a. Preview Form]       ← Show extracted fields in editable form
      │   │                           User can correct any field before confirming
      │   ▼
      │   [7. Output]             ← User chooses: copy JSON, append CSV, save record
      │
      ├── Validation errors:
      │   ▼
      │   [6b. Error Form]        ← Show form with errors highlighted
      │                              User fills in missing/invalid fields manually
      │                              Re-validate on submit
      │
      ▼
[8. Record Storage]                ← Save to structured_records table
      │                               Link to source entry (transcript)
      │
      ▼
[9. Action Logging]                ← Log to action_log for workflow discovery
```

### Data Flow: Batch Entry Mode

```
[User activates batch mode for schema "Inventory"]
      │
      ▼
[Batch Session Starts]
      │
      ▼
[Row 1: User speaks] ──► [Extract] ──► [Validate] ──► [Add to buffer]
      │
      ▼
[Row 2: User speaks] ──► [Extract] ──► [Validate] ──► [Add to buffer]
      │
      ▼
[Row N: User speaks] ──► [Extract] ──► [Validate] ──► [Add to buffer]
      │
      ▼
[User says "done" or clicks Stop]
      │
      ▼
[Batch Preview Table]              ← Spreadsheet-like view of all rows
      │                               User can edit any cell, delete rows, reorder
      │
      ▼
[Export]                           ← CSV file, JSON array, clipboard
      │                               Or append to existing file
      │
      ▼
[Records saved to structured_records]
```

---

## Schema Definition System

### Field Types

The type system for schema fields:

| Type | Description | Coercion from Voice |
|------|-------------|-------------------|
| `text` | Free-form string | Direct transcription |
| `number` | Integer or decimal | "forty-seven fifty" → 47.50, "two hundred" → 200 |
| `currency` | Number with currency | "$47.50", "forty-seven fifty dollars" → 47.50 |
| `date` | ISO 8601 date | "today" → 2026-04-15, "next Tuesday" → resolved |
| `datetime` | ISO 8601 datetime | "3pm today" → 2026-04-15T15:00:00 |
| `time` | HH:MM format | "two thirty" → 14:30, "quarter past nine" → 09:15 |
| `duration` | Hours/minutes | "two hours" → 2.0, "ninety minutes" → 1.5 |
| `email` | Email address | Validated with regex |
| `phone` | Phone number | Digits extracted, formatted |
| `url` | Web URL | Validated format |
| `enum` | Fixed set of values | "high" matched against ["low","medium","high","critical"] |
| `boolean` | True/false | "yes"/"no", "billable"/"non-billable" |
| `tags` | Array of strings | "tags: api, backend, urgent" → ["api","backend","urgent"] |
| `reference` | Link to another schema | "client: Acme" → resolved from contacts schema |

### Validation Constraints

Each field can have constraints:

```typescript
interface FieldDefinition {
  name: string;              // "amount", "vendor", "category"
  label: string;             // Human-readable: "Amount", "Vendor Name"
  type: FieldType;           // From the type table above
  required: boolean;         // Must be present in voice input
  default_value?: string;    // Used if not spoken: "today" for date fields
  constraints?: {
    min?: number;            // For number/currency: minimum value
    max?: number;            // For number/currency: maximum value
    min_length?: number;     // For text: minimum character length
    max_length?: number;     // For text: maximum character length
    pattern?: string;        // Regex pattern for validation
    enum_values?: string[];  // For enum type: allowed values
    enum_aliases?: Record<string, string[]>;  // "hi" → "high", "med" → "medium"
  };
  extraction_hints?: string; // LLM hint: "usually follows 'at' or 'from'"
  order: number;             // Display order in form
}
```

### Schema Definition

```typescript
interface SchemaDefinition {
  id: string;                     // UUID
  name: string;                   // "Expense", "Contact", "Bug Report"
  description: string;            // "Track business expenses by voice"
  icon: string;                   // Lucide icon name: "receipt", "user", "bug"
  trigger_phrases: string[];      // ["log expense", "add expense", "expense"]
  fields: FieldDefinition[];      // Ordered list of fields
  output_format: OutputFormat;    // Default output: "json" | "csv" | "markdown"
  csv_headers: boolean;           // Include headers in CSV output
  json_pretty: boolean;           // Pretty-print JSON
  created_at: string;
  updated_at: string;
  is_builtin: boolean;            // Shipped with IronMic vs user-created
  record_count: number;           // How many records have been created with this schema
}
```

### Built-in Schema Templates

IronMic ships with starter templates that users can customize:

**Expense**
```
Fields: amount (currency, required), vendor (text, required),
        category (enum: [food, transport, office, entertainment, ...]),
        date (date, default: today), notes (text, optional)
Triggers: "log expense", "add expense", "expense report"
```

**Contact**
```
Fields: name (text, required), title (text), company (text),
        email (email), phone (phone), context (text)
Triggers: "add contact", "new contact", "save contact"
```

**Time Entry**
```
Fields: hours (duration, required), project (text, required),
        billable (boolean, default: true), client (text),
        description (text)
Triggers: "log time", "track time", "time entry"
```

**Action Item**
```
Fields: title (text, required), assignee (text),
        due_date (date), priority (enum: [low, medium, high]),
        project (text)
Triggers: "action item", "todo", "task"
```

**Bug Report**
```
Fields: title (text, required), priority (enum: [low, medium, high, critical]),
        steps (text), expected (text), actual (text),
        component (text)
Triggers: "file bug", "bug report", "report issue"
```

---

## LLM Field Extraction

### Extraction Prompt

The local Mistral model receives a structured extraction prompt:

```
You are a data extraction assistant. Extract structured fields from the spoken transcript.

Schema: {schema_name}
Fields:
{for each field}
- {field.name} ({field.type}{", required" if required}{", one of: " + enum_values if enum})
  {field.extraction_hints if present}
{end for}

Rules:
- Extract ONLY fields defined in the schema above
- Return valid JSON with field names as keys
- For missing optional fields, omit the key entirely
- For dates, resolve relative references ("today" = {current_date}, "next Tuesday" = {resolved_date})
- For numbers spoken as words, convert to digits ("forty-seven fifty" = 47.50)
- For enums, match to the closest allowed value (case-insensitive)
- For currency, extract the numeric value only (no $ sign in the value)
- If a required field cannot be extracted, set its value to null
- Output ONLY the JSON object, nothing else

Transcript:
"{raw_transcript}"
```

### Response Parsing

The LLM response is parsed as JSON. Common failure modes and mitigations:

| Failure | Mitigation |
|---------|------------|
| LLM outputs preamble before JSON | Strip everything before first `{` and after last `}` |
| LLM outputs markdown code block | Strip `` ```json `` and `` ``` `` wrappers |
| Invalid JSON (unclosed quotes, etc.) | Attempt repair with bracket matching; fall back to manual form |
| Field name mismatch (camelCase vs snake_case) | Normalize to schema's field names via fuzzy match |
| Enum value not exact match | Fuzzy match against enum_values + aliases (Levenshtein distance < 3) |
| Number extraction wrong ("forty-seven" as string) | Post-processing: detect number-like strings and convert |

### Performance

- Extraction prompt + response: ~500ms-2s depending on transcript length
- For short inputs ("log expense, $47.50, Home Depot, today"): ~500ms
- For longer inputs (multi-sentence bug report): ~1.5s
- This is acceptable because extraction runs after transcription, not during

---

## Database Schema

### New Tables

```sql
-- User-defined schemas (and built-in templates)
CREATE TABLE custom_schemas (
    id TEXT PRIMARY KEY,                    -- UUID
    name TEXT NOT NULL,                     -- "Expense", "Contact", etc.
    description TEXT,                       -- Human-readable description
    icon TEXT DEFAULT 'file-text',          -- Lucide icon name
    trigger_phrases TEXT NOT NULL,          -- JSON array: ["log expense", "expense"]
    fields TEXT NOT NULL,                   -- JSON array of FieldDefinition objects
    output_format TEXT DEFAULT 'json',      -- "json" | "csv" | "markdown"
    csv_headers INTEGER DEFAULT 1,
    json_pretty INTEGER DEFAULT 1,
    is_builtin INTEGER DEFAULT 0,          -- 1 for shipped templates
    is_active INTEGER DEFAULT 1,           -- 0 = disabled (won't trigger)
    record_count INTEGER DEFAULT 0,        -- Counter updated on each extraction
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_custom_schemas_active ON custom_schemas(is_active);

-- Extracted structured records
CREATE TABLE structured_records (
    id TEXT PRIMARY KEY,                    -- UUID
    schema_id TEXT NOT NULL REFERENCES custom_schemas(id) ON DELETE CASCADE,
    entry_id TEXT REFERENCES entries(id) ON DELETE SET NULL,
                                           -- Link to source transcript entry
    data TEXT NOT NULL,                     -- JSON object with extracted field values
    raw_transcript TEXT NOT NULL,           -- Original voice input that produced this
    validation_status TEXT DEFAULT 'valid', -- "valid" | "corrected" | "partial"
    corrections TEXT,                       -- JSON: {field: {original, corrected}} tracking user edits
    output_format TEXT,                     -- Format used when outputting this record
    batch_id TEXT,                          -- Groups records from the same batch session
    batch_sequence INTEGER,                 -- Order within batch (row number)
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_structured_records_schema ON structured_records(schema_id);
CREATE INDEX idx_structured_records_batch ON structured_records(batch_id);
CREATE INDEX idx_structured_records_entry ON structured_records(entry_id);

-- Batch sessions for row-by-row data entry
CREATE TABLE batch_sessions (
    id TEXT PRIMARY KEY,                    -- UUID
    schema_id TEXT NOT NULL REFERENCES custom_schemas(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'active',           -- "active" | "completed" | "cancelled"
    record_count INTEGER DEFAULT 0,
    output_file TEXT,                       -- Path if exported to file
    started_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE INDEX idx_batch_sessions_schema ON batch_sessions(schema_id);

-- FTS index for searching records by field values
CREATE VIRTUAL TABLE structured_records_fts USING fts5(
    data,
    raw_transcript,
    content='structured_records',
    content_rowid='rowid'
);
```

### Relationships

```
custom_schemas 1 <--> N structured_records    (one schema produces many records)
entries 1 <--> 0..1 structured_records         (one entry may produce one record)
custom_schemas 1 <--> N batch_sessions         (one schema used in many batches)
batch_sessions 1 <--> N structured_records     (one batch produces many records)
```

---

## Rust Core Changes

### New N-API Exports

```typescript
// --- Schema CRUD ---
createSchema(name, description, icon, triggerPhrases, fields,
    outputFormat, csvHeaders, jsonPretty, isBuiltin): string  // returns schema ID
getSchema(id): string                              // JSON or "null"
updateSchema(id, name, description, icon, triggerPhrases, fields,
    outputFormat, csvHeaders, jsonPretty): void
deleteSchema(id): void
listSchemas(includeInactive): string               // JSON array
setSchemaActive(id, active): void
matchSchemaTrigger(transcript): string             // JSON: {schemaId, confidence} or "null"

// --- Record CRUD ---
createRecord(schemaId, entryId, data, rawTranscript, validationStatus,
    corrections, outputFormat, batchId, batchSequence): string
getRecord(id): string                              // JSON or "null"
updateRecord(id, data, validationStatus, corrections): void
deleteRecord(id): void
listRecords(schemaId, limit, offset): string       // JSON array
searchRecords(query, schemaId): string             // JSON array (FTS5)

// --- Batch Sessions ---
createBatchSession(schemaId): string               // returns batch ID
completeBatchSession(id, outputFile): void
cancelBatchSession(id): void
getBatchSession(id): string                        // JSON or "null"
listBatchSessions(schemaId, limit): string         // JSON array

// --- Extraction ---
extractFields(transcript, schemaJson): Promise<string>  // JSON: extracted fields
                                                        // Uses local LLM
validateFields(data, schemaJson): string           // JSON: {valid, errors: [{field, message}]}

// --- Output Formatting ---
formatAsJson(data, pretty): string
formatAsCsv(records, headers): string              // records is JSON array
formatAsMarkdown(data, schemaJson): string
```

### Files to Modify

| File | Change |
|------|--------|
| `rust-core/Cargo.toml` | No new crates needed (uses existing serde, llama-cpp-rs) |
| `rust-core/src/storage/db.rs` | Migration for new tables |
| `rust-core/src/storage/mod.rs` | Export new modules |
| `rust-core/src/lib.rs` | Register new N-API functions |
| `rust-core/src/llm/prompts.rs` | Add extraction prompt templates |
| `rust-core/src/llm/cleanup.rs` | Add extraction mode alongside cleanup mode |
| `electron-app/src/main/ipc-handlers.ts` | Add structured data IPC channels |
| `electron-app/src/main/native-bridge.ts` | Expose new Rust functions |
| `electron-app/src/preload/index.ts` | Add structured data API to contextBridge |

### New Files

| File | Purpose |
|------|---------|
| `rust-core/src/structured/mod.rs` | Module root |
| `rust-core/src/structured/schema.rs` | Schema definition types + validation rules |
| `rust-core/src/structured/extractor.rs` | LLM prompt construction + response parsing |
| `rust-core/src/structured/validator.rs` | Field type checking + constraint enforcement |
| `rust-core/src/structured/formatter.rs` | JSON/CSV/Markdown output formatting |
| `rust-core/src/storage/custom_schemas.rs` | Schema CRUD operations |
| `rust-core/src/storage/structured_records.rs` | Record CRUD + FTS5 |
| `electron-app/src/renderer/components/StructuredDataPage.tsx` | Top-level view |
| `electron-app/src/renderer/components/SchemaEditor.tsx` | Visual schema builder |
| `electron-app/src/renderer/components/SchemaCard.tsx` | Schema card |
| `electron-app/src/renderer/components/SchemaGallery.tsx` | Template gallery |
| `electron-app/src/renderer/components/FieldEditor.tsx` | Field configuration |
| `electron-app/src/renderer/components/RecordPreview.tsx` | Extraction preview |
| `electron-app/src/renderer/components/RecordHistory.tsx` | Record list per schema |
| `electron-app/src/renderer/components/BatchEntryMode.tsx` | Batch data entry |
| `electron-app/src/renderer/components/OutputFormatPicker.tsx` | Export format chooser |
| `electron-app/src/renderer/components/StructuredDataSettings.tsx` | Settings |
| `electron-app/src/renderer/stores/useStructuredDataStore.ts` | State management |
| `electron-app/src/renderer/services/StructuredDataService.ts` | Orchestration |
| `electron-app/src/renderer/services/SchemaValidator.ts` | Client-side validation |
| `electron-app/src/renderer/services/OutputFormatter.ts` | Client-side formatting |

---

## Integration with Existing Intent Classifier

The existing intent classifier detects voice commands. Structured data extraction hooks into this system:

### Detection Flow

```
[Transcript from Whisper]
        │
        ▼
[Intent Classifier]                ← Existing LSTM model
        │
        ├── Intent: "dictation"    → Normal flow
        ├── Intent: "command"      → Existing command routing
        ├── Intent: "structured"   → NEW: Route to structured data pipeline
        │
        ▼
[Schema Matching]                  ← Match trigger phrases against active schemas
        │                             "log expense" → Expense schema (confidence 0.95)
        │                             "add a contact" → Contact schema (confidence 0.90)
        │
        ├── High confidence (>0.8) → Auto-select schema, proceed to extraction
        ├── Medium (0.5-0.8)       → Show schema suggestions, user confirms
        └── Low (<0.5)             → Fall back to normal dictation
```

### Training Data for Intent Classifier

Add a "structured" intent category to the existing training data:

```
"log an expense forty-seven fifty at home depot"    → structured
"add contact sarah chen VP engineering acme corp"    → structured
"new time entry two hours on the api project"        → structured
"file a bug login button not working on safari"      → structured
"let's discuss the migration timeline"               → dictation
"open the settings"                                  → command
```

The classifier needs retraining with ~200 synthetic structured-intent examples. The existing on-device training infrastructure (TF.js LSTM) handles this.

---

## Schema Editor UI

### Visual Schema Builder

```
┌─────────────────────────────────────────────────────────────┐
│  Schema Editor: Expense Tracker                    [Save]    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Name: [Expense Tracker                    ]                │
│  Icon: [receipt ▼]  Description: [Track business expenses]  │
│                                                             │
│  Trigger Phrases:                                           │
│  [log expense] [add expense] [expense report] [+]           │
│                                                             │
│  Fields:                                                    │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ ≡  amount    Currency  ★ Required  [Edit] [Delete]  │    │
│  ├─────────────────────────────────────────────────────┤    │
│  │ ≡  vendor    Text      ★ Required  [Edit] [Delete]  │    │
│  ├─────────────────────────────────────────────────────┤    │
│  │ ≡  category  Enum      Optional    [Edit] [Delete]  │    │
│  │    Values: food, transport, office, entertainment    │    │
│  ├─────────────────────────────────────────────────────┤    │
│  │ ≡  date      Date      Default: today  [Edit] [Del] │    │
│  ├─────────────────────────────────────────────────────┤    │
│  │ ≡  notes     Text      Optional    [Edit] [Delete]  │    │
│  └─────────────────────────────────────────────────────┘    │
│  [+ Add Field]                                              │
│                                                             │
│  Output: [JSON ▼]  ☑ Pretty print  ☐ Include headers       │
│                                                             │
│  ── Test ──────────────────────────────────────────────     │
│  Try it: [Type or speak a sample input...              ]    │
│  [Extract]                                                  │
│  Result: { "amount": 47.50, "vendor": "Home Depot", ... }  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Field Editor Modal

```
┌────────────────────────────────────────┐
│  Edit Field: category                  │
├────────────────────────────────────────┤
│                                        │
│  Name:  [category              ]       │
│  Label: [Category              ]       │
│  Type:  [Enum ▼]                       │
│                                        │
│  ☐ Required                            │
│  Default: [                    ]       │
│                                        │
│  Enum Values:                          │
│  [food] [transport] [office]           │
│  [entertainment] [travel] [other] [+]  │
│                                        │
│  Aliases:                              │
│  "food" also matches: [eating, lunch,  │
│   dinner, groceries]                   │
│  "transport" also matches: [uber,      │
│   taxi, gas, parking]                  │
│                                        │
│  Extraction Hint:                      │
│  [Usually follows "category" or        │
│   "filed under"                  ]     │
│                                        │
│  [Cancel]                    [Save]    │
└────────────────────────────────────────┘
```

---

## Record Preview and Confirmation

After extraction, the user sees an editable preview:

```
┌─────────────────────────────────────────────────────────────┐
│  Extracted: Expense                              [✓] [✗]    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Original: "Log an expense. Forty-seven fifty at Home       │
│  Depot. Category home improvement. Today."                  │
│                                                             │
│  ┌─────────────────────────────────────────────────┐        │
│  │  Amount:    [$47.50            ]  ✓              │        │
│  │  Vendor:    [Home Depot        ]  ✓              │        │
│  │  Category:  [Home Improvement ▼]  ✓              │        │
│  │  Date:      [2026-04-15       ]  ✓              │        │
│  │  Notes:     [                  ]  (optional)     │        │
│  └─────────────────────────────────────────────────┘        │
│                                                             │
│  Output format: ● JSON  ○ CSV  ○ Markdown                   │
│                                                             │
│  Preview:                                                   │
│  {                                                          │
│    "amount": 47.50,                                         │
│    "vendor": "Home Depot",                                  │
│    "category": "Home Improvement",                          │
│    "date": "2026-04-15"                                     │
│  }                                                          │
│                                                             │
│  [Copy to Clipboard]  [Append to File...]  [Save Record]   │
└─────────────────────────────────────────────────────────────┘
```

### User Corrections

When the user edits a field in the preview form:
- The correction is tracked in the `corrections` column: `{"category": {"original": "Home", "corrected": "Home Improvement"}}`
- Over time, corrections improve extraction: the system learns that "home improvement" is a valid category value and adds it as an alias
- Correction data can be used to fine-tune the extraction prompt (add examples of past corrections)

---

## Output Formats

### JSON

```json
{
  "amount": 47.50,
  "vendor": "Home Depot",
  "category": "Home Improvement",
  "date": "2026-04-15"
}
```

### CSV

```csv
amount,vendor,category,date
47.50,Home Depot,Home Improvement,2026-04-15
```

For batch mode, all rows share the same header:
```csv
amount,vendor,category,date
47.50,Home Depot,Home Improvement,2026-04-15
23.99,Staples,Office,2026-04-14
156.00,Delta Airlines,Travel,2026-04-13
```

### Markdown Table

```markdown
| Field | Value |
|-------|-------|
| Amount | $47.50 |
| Vendor | Home Depot |
| Category | Home Improvement |
| Date | 2026-04-15 |
```

### Clipboard Behavior

- **JSON:** Copy the JSON string to clipboard. User pastes into any text field, API tool, or IDE.
- **CSV:** Copy the CSV row (with or without header). User pastes into Excel, Google Sheets, or any spreadsheet app.
- **Markdown:** Copy the Markdown table. User pastes into Notion, GitHub, Slack, or any Markdown-aware app.
- **Tab-separated:** For direct paste into spreadsheet cells. Values separated by tabs, which spreadsheets interpret as column separators.

### File Append

Users can configure a schema to auto-append records to a local file:
- CSV: append a new row to `~/Documents/expenses.csv`
- JSON Lines: append a JSON object per line to `~/Documents/contacts.jsonl`
- The file path is configured per schema in settings
- File is created on first record if it doesn't exist (with headers for CSV)

---

## Settings

New settings in **Settings > Structured Data**:

| Setting | Default | Description |
|---------|---------|-------------|
| `structured_data_enabled` | `false` | Enable voice-to-structured-data feature |
| `structured_auto_detect` | `true` | Auto-detect structured intent from voice |
| `structured_confirm_before_output` | `true` | Show preview form before outputting |
| `structured_default_format` | `json` | Default output format |
| `structured_auto_save` | `true` | Auto-save records to database |
| `structured_learn_from_corrections` | `true` | Improve extraction from user corrections |
| `structured_batch_delimiter` | `new row` | Phrase that separates batch entries |
| `structured_csv_separator` | `,` | CSV field separator |

---

## Privacy Considerations

- **All extraction is local.** The LLM (Mistral) runs entirely on-device. Transcripts and extracted data never leave the machine.
- **Schemas are user-owned.** Schema definitions live in the local SQLite database. They are not uploaded to any template marketplace or shared service.
- **Records are local.** All structured records are stored in the same SQLite file as other IronMic data. The user has full control.
- **File exports are local.** When appending to files, the files are on the user's local filesystem. No cloud storage integration.
- **Corrections are private.** The correction tracking data is used only to improve the local extraction. It is not sent anywhere.
- **No training data exfiltration.** Even if future versions support "share schema," only the schema definition (field names + types) would be shared, never the user's actual records.

---

## Implementation Phases

### Phase 1: Schema System and Storage
- Implement `custom_schemas` and `structured_records` tables (schema migration)
- Implement `structured/schema.rs` — type system and validation rules
- Rust CRUD for schemas and records
- Seed 5 built-in schema templates
- `SchemaGallery.tsx` — browse and preview templates
- **Deliverable:** Users can browse, create, edit, and delete schemas

### Phase 2: LLM Field Extraction
- Implement `structured/extractor.rs` — prompt construction and response parsing
- Implement `structured/validator.rs` — type checking and constraint enforcement
- Wire extraction through existing LLM pipeline (add extraction mode to `cleanup.rs`)
- Handle common LLM output failures (preamble stripping, JSON repair)
- Unit tests with sample transcripts and schemas
- **Deliverable:** Given a transcript and schema, the LLM returns validated structured data

### Phase 3: Preview UI and Output
- Build `RecordPreview.tsx` — editable form showing extracted fields
- Build `OutputFormatPicker.tsx` — JSON/CSV/Markdown/clipboard chooser
- Implement `structured/formatter.rs` — output formatting
- Clipboard integration (uses existing arboard infrastructure)
- Correction tracking in `structured_records`
- **Deliverable:** Full voice-to-structured-output flow for single records

### Phase 4: Intent Integration and Auto-Detection
- Add "structured" intent category to intent classifier
- Train with ~200 synthetic examples
- Implement `matchSchemaTrigger` — schema resolution from trigger phrases
- Wire auto-detection into the existing voice routing pipeline
- **Deliverable:** User says "log an expense" and IronMic automatically routes to the expense schema

### Phase 5: Batch Mode
- Build `BatchEntryMode.tsx` — row-by-row entry with running table view
- Implement `batch_sessions` table and CRUD
- Batch delimiter detection ("new row", "next", configurable phrase)
- Batch export (CSV file, JSON array, clipboard)
- **Deliverable:** Users can voice-fill a spreadsheet row by row

### Phase 6: Schema Editor and Advanced Features
- Build `SchemaEditor.tsx` — visual drag-and-drop field builder
- Build `FieldEditor.tsx` — field configuration modal with constraints
- Test mode in editor (try extraction with sample input)
- File append mode (auto-export to local file)
- Correction-driven prompt improvement (add examples to extraction prompt)
- `RecordHistory.tsx` — browse and search past records per schema
- **Deliverable:** Full-featured schema editor with test mode and record history

---

## Performance Considerations

| Operation | Time | Notes |
|-----------|------|-------|
| Intent detection (structured vs dictation) | ~20ms | Existing LSTM classifier |
| Schema trigger matching | <5ms | String matching against trigger phrases |
| LLM field extraction (short input) | ~500ms | "log expense $47.50 Home Depot today" |
| LLM field extraction (long input) | ~2s | Multi-sentence bug report |
| Validation | <5ms | Type checking + constraint evaluation |
| JSON/CSV formatting | <1ms | String operations |
| Record save to SQLite | <5ms | Single INSERT |
| Schema CRUD | <5ms | Simple SQL operations |
| Batch export (100 rows) | <50ms | Formatting + clipboard/file write |

### LLM Contention

The extraction uses the same Mistral model as text cleanup. If both are enabled:
- Extraction and cleanup are never needed simultaneously (cleanup runs on the raw transcript, extraction runs on the same or cleaned text)
- If the user has cleanup ON: run cleanup first, then extract from the polished text (more accurate)
- If cleanup is OFF: extract directly from the raw transcript
- The LLM is single-threaded; requests are queued. No parallel execution needed.

---

## Open Questions

1. **Schema sharing between users:** Should IronMic support importing/exporting schema definitions (as JSON files)? This enables teams to standardize on schemas without a cloud service. But it adds complexity: schema versioning, field compatibility, import conflicts.

2. **Nested schemas:** Should a field reference another schema? E.g., an "Invoice" schema with a "line_items" field that is an array of "Line Item" sub-schemas. This is powerful but significantly increases LLM prompt complexity and extraction difficulty.

3. **Multi-language number parsing:** "Forty-seven fifty" works in English. What about "quarante-sept cinquante" (French) or "siebenundvierzig funfzig" (German)? The LLM handles this implicitly, but validation and coercion logic may need localization.

4. **Schema versioning:** If a user modifies a schema (adds a field, changes a type), what happens to existing records? Options: records retain the schema version they were created with, or migrate records to the new schema.

5. **Confidence scoring:** Should each extracted field have a confidence score? The LLM doesn't natively output confidence, but heuristics could estimate it (exact phrase match = high, inferred value = low). This would let the preview form highlight uncertain fields.

6. **Integration with external tools:** Users may want to push structured records to external apps (Notion, Airtable, Sheets). This violates "no network" unless it's opt-in and user-initiated. Could support a "copy as API payload" feature that formats the data but doesn't send it.

7. **Voice correction of fields:** In the preview form, should users be able to correct fields by voice? "Change vendor to Lowes" would update the vendor field without touching the keyboard. This requires a secondary extraction pass on the correction utterance.

8. **Large enum sets:** Some enums may have 50+ values (e.g., countries, US states, product categories). The LLM can handle these in the prompt, but it uses significant context window. May need to use embedding similarity instead of listing all values in the prompt.

---

## Dependencies

| Dependency | Already in project? | Purpose |
|-----------|---------------------|---------|
| `llama-cpp-rs` | Yes | Local LLM for field extraction |
| `serde` + `serde_json` | Yes | Schema and record serialization |
| `rusqlite` | Yes | Schema and record storage |
| `arboard` | Yes | Clipboard output |
| Intent classifier (TF.js) | Yes | Detect structured intent |
| `chrono` | Likely yes | Date/time parsing and resolution |

No new Rust crates required. This feature builds entirely on existing infrastructure — the LLM, the intent classifier, the clipboard manager, and SQLite.

---

## Success Metrics

- **Extraction accuracy:** >90% of fields correctly extracted on first attempt (before user correction)
- **Correction rate:** <15% of records require user correction of any field
- **End-to-end time:** <3 seconds from voice input to structured output in clipboard
- **Schema creation:** Users create their first custom schema within 5 minutes of discovering the feature
- **Adoption:** >30% of users who enable the feature use it at least weekly
- **Batch efficiency:** Voice data entry is within 2x the speed of keyboard entry for 10+ row batches
- **Format utility:** Clipboard output pastes correctly into target apps (Excel, Notion, JSON tools) >95% of the time
