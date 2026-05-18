# Voice-Driven Workspace Automation

## Overview

Add a plugin/action execution layer to IronMic so voice commands can chain into external tools and workflows. "Take everything from today's standup and create Jira tickets for each action item." IronMic already transcribes meetings, classifies intents, and runs a local LLM. The missing piece is a structured action system that maps voice intent to parameterized operations on external systems.

This is not a general-purpose automation platform. It is a voice-to-action bridge: the user speaks, IronMic understands what they want done, extracts the parameters, and executes a sandboxed action with explicit user approval. Everything from intent detection to parameter extraction runs locally. Network calls only happen when the user explicitly approves an action that targets an external service.

---

## What This Enables

- After a standup meeting:
  ```
  You: "Create tickets for all the action items from this meeting."
  IronMic: Found 3 action items. Proposed actions:
    1. POST to Jira: "Fix staging API test failures" → assigned to Sarah
    2. POST to Jira: "Update database migration docs" → assigned to Alex
    3. Write file: ~/notes/sprint-review-prep.md → meeting summary
  [Approve All] [Review Each] [Cancel]
  ```

- During dictation in VS Code:
  ```
  You: "Save this as a new file called utils/parser.ts"
  IronMic: Write file ~/projects/myapp/utils/parser.ts with dictated content?
  [Approve] [Edit Path] [Cancel]
  ```

- After an AI chat session:
  ```
  You: "Send the summary of this conversation to the team Slack channel."
  IronMic: POST to webhook (self-hosted Slack bridge): #engineering channel
  Preview: "Summary: We decided to move forward with approach B for the caching layer..."
  [Approve] [Edit] [Cancel]
  ```

- Ad hoc automation:
  ```
  You: "Append today's decisions to the project log."
  IronMic: Append to ~/projects/alpha/DECISIONS.md
  Content: "2026-04-15: Decided to use Redis for session caching. Approved budget..."
  [Approve] [Cancel]
  ```

---

## Architecture

### New Components

```
Rust Core
├── actions/
│   ├── mod.rs
│   ├── registry.rs         # Plugin/action registration and discovery
│   ├── executor.rs          # Sandboxed action execution engine
│   ├── filesystem.rs        # Built-in: file read/write/append actions
│   ├── clipboard.rs         # Built-in: clipboard operations (already exists, wrap as action)
│   ├── webhook.rs           # Built-in: HTTP POST to user-configured endpoints
│   ├── shell.rs             # Built-in: run user-approved shell commands
│   └── sandbox.rs           # Process isolation, timeout, resource limits
│
├── actions/plugins/
│   ├── loader.rs            # Load plugin definitions from YAML/JSON files
│   ├── validator.rs         # Validate plugin schemas before registration
│   └── templates.rs         # Built-in plugin templates (Jira, GitHub, Slack webhooks)
│
├── extraction/
│   ├── mod.rs
│   ├── param_extractor.rs   # LLM-powered parameter extraction from transcripts
│   └── schema_matcher.rs    # Match extracted params against action parameter schemas

Electron App
├── renderer/
│   ├── components/
│   │   ├── ActionApprovalModal.tsx    # User approval UI before execution
│   │   ├── ActionResultToast.tsx      # Success/failure feedback
│   │   ├── ActionHistoryPage.tsx      # Log of all executed actions
│   │   ├── PluginManager.tsx          # Browse, install, configure plugins
│   │   ├── PluginCard.tsx             # Individual plugin config card
│   │   ├── ActionBuilder.tsx          # Visual action/workflow builder
│   │   └── WebhookConfigPanel.tsx     # Configure self-hosted webhook targets
│   ├── stores/
│   │   └── useActionStore.ts          # Action queue, history, plugin state
│   └── services/
│       ├── ActionOrchestrator.ts      # Coordinates extraction → approval → execution
│       └── ParameterResolver.ts       # Resolve template variables from context
```

### System Diagram

```
[Voice Input]
      │
      ▼
[Whisper STT] ──transcript──> [IntentClassifier]
                                      │
                               intent: "create_tickets"
                               confidence: 0.87
                                      │
                                      ▼
                              [VoiceRouter]
                                      │
                              route: "action"
                                      │
                                      ▼
                          [ActionOrchestrator]
                                      │
                    ┌─────────────────┼──────────────────┐
                    │                 │                   │
                    ▼                 ▼                   ▼
            [PluginRegistry]  [ParamExtractor]   [ContextGatherer]
            "Which action?"   "What params?"     "Meeting data,
                    │                │            active entry,
                    │                │            AI chat history"
                    │                │                   │
                    └────────┬───────┘───────────────────┘
                             │
                             ▼
                    [Action Plan Builder]
                    "3 Jira tickets with
                     these fields..."
                             │
                             ▼
                    [ActionApprovalModal]  ← USER MUST APPROVE
                             │
                      ┌──────┼──────┐
                      │      │      │
                   Approve  Edit  Cancel
                      │      │
                      ▼      ▼
                    [Executor]
                    (sandboxed)
                      │
           ┌──────────┼──────────┐
           │          │          │
           ▼          ▼          ▼
       [Filesystem] [Webhook] [Shell]
           │          │          │
           └──────────┼──────────┘
                      │
                      ▼
              [Action Log (SQLite)]
              [ActionResultToast]
```

### Data Flow: Meeting to Action Items

```
[Meeting Ends]
      │
      ▼
[Meeting Summary + Action Items]    ← Already extracted by MeetingDetector
      │
      ▼
[User: "Create tickets for these"]
      │
      ▼
[IntentClassifier] → intent: "create_external_items"
      │
      ▼
[ParamExtractor (LLM)]
  Input: action items + user intent + plugin schema for "jira-create-ticket"
  Output: [
    { summary: "Fix staging API tests", assignee: "Sarah", priority: "High" },
    { summary: "Update migration docs", assignee: "Alex", priority: "Medium" },
    { summary: "Sprint review prep", assignee: "self", priority: "Low" }
  ]
      │
      ▼
[ActionApprovalModal]
  Shows each proposed action with editable fields
  User can approve all, approve individually, edit params, or cancel
      │
      ▼
[Executor] → POST to configured Jira webhook for each approved action
      │
      ▼
[Action Log] → records what was sent, response status, timestamp
```

---

## Plugin / Action Definition Format

Plugins are defined as YAML files stored in `~/.ironmic/plugins/`. Each file describes one or more actions with their parameter schemas, execution method, and security scope.

### Plugin File Structure

```yaml
# ~/.ironmic/plugins/jira-tickets.yaml
plugin:
  name: "Jira Ticket Creator"
  version: "1.0.0"
  description: "Create Jira tickets from voice commands and meeting action items"
  author: "user"
  
  # What this plugin is allowed to do
  permissions:
    - network:webhook        # Can make HTTP calls to configured webhooks
    # - filesystem:write     # Would allow file writes (not needed here)
    # - shell:execute        # Would allow shell command execution
    # - clipboard:write      # Would allow clipboard access

  # Webhook targets (user configures these once)
  config:
    jira_webhook_url:
      type: string
      description: "URL of your self-hosted Jira bridge / webhook"
      required: true
    jira_project_key:
      type: string
      description: "Default Jira project key (e.g., ENG)"
      default: ""

actions:
  - name: "create_ticket"
    description: "Create a Jira ticket"
    
    # Trigger phrases — used to train the IntentClassifier
    triggers:
      - "create a ticket"
      - "make a Jira issue"
      - "file a ticket for"
      - "create tickets for action items"
    
    # Parameters extracted from voice/context by the LLM
    parameters:
      summary:
        type: string
        required: true
        description: "Ticket title/summary"
        extract_from: "The main task or action item description"
      assignee:
        type: string
        required: false
        description: "Person to assign the ticket to"
        extract_from: "The person responsible for this task"
      priority:
        type: enum
        values: ["Highest", "High", "Medium", "Low", "Lowest"]
        default: "Medium"
        extract_from: "Urgency indicators in the transcript"
      description:
        type: string
        required: false
        description: "Detailed ticket description"
        extract_from: "Additional context about the task"
    
    # How to execute this action
    execution:
      type: webhook
      method: POST
      url: "{{config.jira_webhook_url}}"
      headers:
        Content-Type: "application/json"
      body: |
        {
          "fields": {
            "project": { "key": "{{config.jira_project_key}}" },
            "summary": "{{params.summary}}",
            "assignee": { "name": "{{params.assignee}}" },
            "priority": { "name": "{{params.priority}}" },
            "description": "{{params.description}}\n\nCreated via IronMic voice command.",
            "issuetype": { "name": "Task" }
          }
        }
    
    # What to show the user for approval
    approval:
      title: "Create Jira Ticket"
      preview_template: |
        **{{params.summary}}**
        Assignee: {{params.assignee | default: "Unassigned"}}
        Priority: {{params.priority}}
```

### Built-in Action Types

```yaml
# Filesystem action — no network, just local file operations
execution:
  type: filesystem
  operation: append          # write | append | create_directory
  path: "{{params.filepath}}"
  content: "{{params.content}}"

# Shell action — runs a command in a sandboxed subprocess
execution:
  type: shell
  command: "git commit -m '{{params.message}}'"
  working_directory: "{{params.repo_path}}"
  timeout_ms: 10000

# Clipboard action — write to clipboard
execution:
  type: clipboard
  content: "{{params.formatted_text}}"

# Webhook action — HTTP POST to self-hosted service
execution:
  type: webhook
  method: POST
  url: "{{config.webhook_url}}"
  body: "{{params | json}}"
```

---

## LLM Parameter Extraction

The local LLM (Mistral/llama.cpp) extracts structured parameters from unstructured voice input. This is the critical intelligence layer.

### Extraction Prompt Template

```
You are a parameter extraction assistant for a voice automation system.

Given a user's voice command and the available action parameters, extract the values.
If a parameter value is not present in the command, output null.
Output ONLY valid JSON matching the schema. No explanation.

Action: {{action.name}} — {{action.description}}

Parameters:
{{#each action.parameters}}
- {{name}} ({{type}}{{#if required}}, required{{/if}}): {{description}}
  Extraction hint: {{extract_from}}
{{/each}}

Context (if available):
- Current meeting action items: {{context.action_items | json}}
- Active entry text: {{context.active_entry}}
- Current date: {{context.current_date}}

User command: "{{user_transcript}}"

Extract parameters as JSON:
```

### Batch Extraction (Multiple Actions from One Command)

When the user says "Create tickets for all the action items," the LLM needs to produce multiple action invocations:

```
You are a batch parameter extraction assistant.

The user wants to create multiple instances of an action from a list of items.

Action: create_ticket
Items to process:
{{#each context.action_items}}
- {{this}}
{{/each}}

For each item, extract: summary, assignee, priority, description.
Output a JSON array of parameter objects. One object per item.
```

### Confidence and Fallback

- If the LLM extraction confidence is low (missing required params, ambiguous values), the `ActionApprovalModal` highlights uncertain fields in yellow and lets the user fill them in
- The LLM never guesses at values it cannot extract — it returns `null` and the user fills them in manually
- If the IntentClassifier confidence is below 0.6, the system asks "Did you mean to run an action?" before proceeding

---

## Database Schema

### New Tables

```sql
-- Installed plugins
CREATE TABLE plugins (
    id TEXT PRIMARY KEY,                -- UUID
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    description TEXT,
    author TEXT,
    file_path TEXT NOT NULL,            -- Path to YAML definition
    permissions TEXT NOT NULL,           -- JSON array of permission strings
    config TEXT NOT NULL DEFAULT '{}',   -- JSON: user-configured values
    is_enabled INTEGER DEFAULT 1,
    installed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Available actions (from plugins + built-in)
CREATE TABLE actions (
    id TEXT PRIMARY KEY,                -- UUID
    plugin_id TEXT REFERENCES plugins(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    triggers TEXT NOT NULL,             -- JSON array of trigger phrases
    parameters TEXT NOT NULL,           -- JSON schema for parameters
    execution TEXT NOT NULL,            -- JSON execution config
    is_builtin INTEGER DEFAULT 0,      -- Built-in actions (filesystem, clipboard)
    created_at TEXT NOT NULL
);
CREATE INDEX idx_actions_plugin ON actions(plugin_id);

-- Execution history (audit log)
CREATE TABLE action_executions (
    id TEXT PRIMARY KEY,                -- UUID
    action_id TEXT NOT NULL REFERENCES actions(id),
    plugin_id TEXT REFERENCES plugins(id),
    trigger_source TEXT NOT NULL,        -- 'voice' | 'meeting' | 'manual' | 'workflow'
    trigger_transcript TEXT,             -- Original voice input
    parameters TEXT NOT NULL,            -- JSON: resolved parameters
    status TEXT NOT NULL,                -- 'pending' | 'approved' | 'rejected' | 'success' | 'failed'
    result TEXT,                         -- JSON: execution result or error
    execution_time_ms INTEGER,
    source_entry_id TEXT,               -- Entry/meeting that triggered this
    created_at TEXT NOT NULL,
    executed_at TEXT                     -- When actually executed (after approval)
);
CREATE INDEX idx_action_executions_status ON action_executions(status);
CREATE INDEX idx_action_executions_created ON action_executions(created_at);

-- User approval preferences (per-action trust levels)
CREATE TABLE action_trust (
    action_id TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
    trust_level TEXT NOT NULL DEFAULT 'ask', -- 'ask' | 'auto_approve' | 'blocked'
    last_approved_at TEXT,
    approval_count INTEGER DEFAULT 0,
    PRIMARY KEY (action_id)
);
```

### Settings

| Key | Default | Description |
|-----|---------|-------------|
| `actions_enabled` | `false` | Master toggle for the action system |
| `action_approval_mode` | `always_ask` | `always_ask` / `trust_after_3` / `auto_approve_builtin` |
| `action_webhook_timeout_ms` | `10000` | Timeout for webhook calls |
| `action_shell_timeout_ms` | `5000` | Timeout for shell commands |
| `action_max_batch_size` | `10` | Max actions in a single batch execution |
| `action_log_retention_days` | `90` | How long to keep execution history |

---

## Security Model

This is the most critical part. IronMic's core principle is "no network calls." The action system intentionally breaks that principle for webhook actions, so the security model must be airtight.

### Principles

1. **No silent execution.** Every action requires explicit user approval before execution. There is no "auto-approve" mode for network actions — only filesystem and clipboard actions can be auto-approved after repeated use.

2. **No ambient network access.** The webhook executor opens a network connection only for the specific approved request. It does not resolve DNS for arbitrary domains. Allowed endpoints are whitelisted in plugin config.

3. **Sandboxed execution.** Shell actions run in a subprocess with:
   - No access to IronMic's database or config files
   - Timeout enforcement (default 5 seconds, max 30 seconds)
   - No escalation to root/admin
   - Working directory restricted to user-specified paths
   - Environment variables stripped except PATH

4. **Permission scoping.** Each plugin declares its permissions upfront. The user sees these at install time. A plugin cannot request permissions after installation without a version bump and re-approval.

5. **Audit trail.** Every action execution (approved or rejected) is logged in `action_executions` with full parameters and results. The user can review and search this log.

6. **Webhook allowlisting.** Webhook URLs must be explicitly configured by the user in plugin settings. The executor refuses to call any URL not in the plugin's config.

### Threat Model

| Threat | Mitigation |
|--------|------------|
| Malicious plugin YAML | Validator checks all fields, rejects unknown execution types, validates URLs |
| LLM extraction injects unexpected params | Parameters are validated against the action schema; unknown keys are dropped |
| Plugin tries to read IronMic data | Execution sandboxed — no access to app data directory |
| Shell command escape / injection | Parameters are never interpolated into shell commands directly; use argument arrays |
| Webhook to malicious endpoint | URLs must match the user-configured allowlist exactly |
| Overly broad filesystem access | Filesystem actions restricted to user's home directory; `/etc`, `/usr`, system paths blocked |

### Approval UI Flow

```
┌─────────────────────────────────────────┐
│  Action Approval                    [X] │
│                                         │
│  Plugin: Jira Ticket Creator            │
│  Action: Create 3 tickets               │
│  Triggered by: Voice command            │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │ 1. Fix staging API tests        │    │
│  │    Assignee: Sarah              │    │
│  │    Priority: High               │    │
│  │    [Edit] [Skip]                │    │
│  ├─────────────────────────────────┤    │
│  │ 2. Update migration docs        │    │
│  │    Assignee: Alex               │    │
│  │    Priority: Medium [?]         │    │ ← yellow = low confidence
│  │    [Edit] [Skip]                │    │
│  ├─────────────────────────────────┤    │
│  │ 3. Sprint review prep           │    │
│  │    Assignee: (you)              │    │
│  │    Priority: Low                │    │
│  │    [Edit] [Skip]                │    │
│  └─────────────────────────────────┘    │
│                                         │
│  Network: POST to jira.internal:8080    │
│  [Approve All]  [Review Each]  [Cancel] │
└─────────────────────────────────────────┘
```

---

## Integration with Existing Systems

### IntentClassifier Integration

The existing `IntentClassifier` (TF.js LSTM, ~5MB) handles voice command detection. Action triggers from plugins are added to its training data:

1. When a plugin is installed, its trigger phrases are extracted
2. A new intent label is created: `action:<plugin_name>:<action_name>`
3. The classifier is fine-tuned with these new examples (on-device, ~2 seconds)
4. When the classifier detects an action intent, it routes to the `ActionOrchestrator`

### MeetingDetector Integration

After a meeting ends, the `MeetingDetector` already extracts action items and summaries. The action system adds a hook:

1. Meeting ends → action items extracted
2. System checks if any installed plugins have meeting-related triggers
3. If yes, shows a subtle prompt: "3 action items detected. Create tickets?" 
4. User clicks → ActionOrchestrator takes over with pre-filled parameters

### VoiceRouter Integration

The existing `VoiceRouter` decides where voice input goes (dictation, command, chat). A new route is added:

```
VoiceRouter routes:
  - dictation → clipboard/editor (existing)
  - command → IntentClassifier → action system (enhanced)
  - conversation → AI chat (existing)
  - action → ActionOrchestrator (new direct route for high-confidence action intents)
```

### Workflow Discovery Integration

The existing `WorkflowMiner` (TF.js GRU) detects repeated patterns. It can now discover action patterns:

- "After every standup meeting, you create Jira tickets"
- Suggest: "Automatically propose ticket creation after standup meetings?"
- If approved, becomes a triggered workflow (still requires per-execution approval)

---

## Rust Core N-API Surface (New Exports)

```typescript
// --- Plugin Management ---
installPlugin(yamlContent: string): Promise<Plugin>
uninstallPlugin(pluginId: string): Promise<void>
listPlugins(includeDisabled: boolean): Promise<Plugin[]>
enablePlugin(pluginId: string, enabled: boolean): Promise<void>
updatePluginConfig(pluginId: string, config: Record<string, string>): Promise<void>

// --- Action Execution ---
executeAction(actionId: string, parameters: Record<string, any>): Promise<ActionResult>
executeWebhook(url: string, method: string, headers: Record<string, string>, body: string): Promise<WebhookResult>
executeFilesystemAction(operation: string, path: string, content?: string): Promise<void>
executeShellCommand(command: string[], workingDir: string, timeoutMs: number): Promise<ShellResult>

// --- Parameter Extraction ---
extractActionParams(transcript: string, actionSchema: string, context: string): Promise<string>

// --- Execution History ---
logActionExecution(execution: ActionExecution): Promise<void>
listActionExecutions(limit: number, offset: number, status?: string): Promise<ActionExecution[]>
getActionExecutionStats(): Promise<ActionStats>
deleteOldActionExecutions(retentionDays: number): Promise<number>

// --- Trust Management ---
setActionTrust(actionId: string, trustLevel: string): Promise<void>
getActionTrust(actionId: string): Promise<string>
```

---

## New Files

### Rust Core

| File | Purpose |
|------|---------|
| `rust-core/src/actions/mod.rs` | Module exports |
| `rust-core/src/actions/registry.rs` | Plugin/action registration, discovery |
| `rust-core/src/actions/executor.rs` | Sandboxed execution engine, dispatch |
| `rust-core/src/actions/filesystem.rs` | File write/append/create actions |
| `rust-core/src/actions/webhook.rs` | HTTP POST with allowlist enforcement |
| `rust-core/src/actions/shell.rs` | Subprocess execution with sandbox |
| `rust-core/src/actions/sandbox.rs` | Process isolation, timeouts, resource limits |
| `rust-core/src/actions/plugins/loader.rs` | YAML plugin file parser |
| `rust-core/src/actions/plugins/validator.rs` | Schema validation for plugin definitions |
| `rust-core/src/actions/plugins/templates.rs` | Built-in plugin templates |
| `rust-core/src/extraction/mod.rs` | Module exports |
| `rust-core/src/extraction/param_extractor.rs` | LLM-powered parameter extraction |
| `rust-core/src/extraction/schema_matcher.rs` | Parameter schema validation |
| `rust-core/src/storage/actions.rs` | Action/plugin/execution CRUD |

### Electron App

| File | Purpose |
|------|---------|
| `electron-app/src/renderer/components/ActionApprovalModal.tsx` | Approval UI |
| `electron-app/src/renderer/components/ActionResultToast.tsx` | Execution feedback |
| `electron-app/src/renderer/components/ActionHistoryPage.tsx` | Execution log viewer |
| `electron-app/src/renderer/components/PluginManager.tsx` | Plugin browse/install/config |
| `electron-app/src/renderer/components/PluginCard.tsx` | Individual plugin card |
| `electron-app/src/renderer/components/ActionBuilder.tsx` | Visual action builder |
| `electron-app/src/renderer/components/WebhookConfigPanel.tsx` | Webhook endpoint config |
| `electron-app/src/renderer/stores/useActionStore.ts` | Action/plugin state |
| `electron-app/src/renderer/services/ActionOrchestrator.ts` | Extraction + approval + execution flow |
| `electron-app/src/renderer/services/ParameterResolver.ts` | Template variable resolution |

### Files to Modify

| File | Change |
|------|--------|
| `rust-core/src/lib.rs` | Add N-API exports for action functions |
| `rust-core/src/storage/db.rs` | Add migration for new tables |
| `rust-core/Cargo.toml` | Add `reqwest` (blocking, minimal features) for webhook support |
| `electron-app/src/main/ipc-handlers.ts` | Wire action IPC channels |
| `electron-app/src/preload/index.ts` | Expose action API to renderer |
| `electron-app/src/renderer/services/VoiceRouter.ts` | Add action route |
| `electron-app/src/renderer/services/IntentClassifier.ts` | Support dynamic action intents |
| `electron-app/src/renderer/components/Layout.tsx` | Add Actions/Plugins nav items |
| `electron-app/src/renderer/components/MeetingDetail.tsx` | Add "Create actions" button post-meeting |

---

## Privacy Considerations

- **Network access is opt-in, scoped, and auditable.** The action system is the first IronMic feature that can make network calls. This is acceptable because: (a) the user explicitly installs a plugin that declares network permissions, (b) the user explicitly configures the target URL, (c) the user explicitly approves each execution, (d) every call is logged.
- **No phone-home.** Plugin installation is from local YAML files, not a marketplace. No plugin registry server.
- **Transcript data in webhooks.** When a webhook sends meeting data to Jira, that transcript leaves the device. The approval UI makes this very clear: "This action will send the following text to jira.internal:8080."
- **Filesystem actions** are restricted to the user's home directory and cannot access system paths, IronMic's own data directory, or hidden config files (`.ssh`, `.gnupg`, etc.).
- **Shell commands** never run with elevated privileges and cannot access IronMic internals.

---

## Phased Rollout

### Phase 1: Core Action Framework
- Plugin YAML parser and validator
- Action registry with built-in filesystem and clipboard actions
- `ActionApprovalModal` with parameter editing
- Execution engine for filesystem/clipboard only (no network yet)
- Action execution log and history page
- **Deliverable:** "Save this as a file" and "Copy formatted text" work via voice

### Phase 2: LLM Parameter Extraction
- Implement `param_extractor.rs` with prompt templates
- Batch extraction for multi-item commands
- Confidence scoring and uncertain-field highlighting
- Integration with existing IntentClassifier for action routing
- **Deliverable:** "Create a summary file from today's meeting" extracts filename, content, path

### Phase 3: Webhook Actions
- Add `reqwest` dependency (blocking client, no async runtime needed)
- Webhook executor with URL allowlisting
- `WebhookConfigPanel` for endpoint setup
- Built-in plugin templates for Jira, GitHub Issues, Slack webhooks
- **Deliverable:** "Create a Jira ticket for this" sends a POST to configured endpoint

### Phase 4: Meeting Integration
- Post-meeting action item detection triggers plugin suggestions
- Batch action creation from meeting action items
- MeetingDetail page gets "Create actions" button
- WorkflowMiner learns meeting-to-action patterns
- **Deliverable:** Meeting ends, IronMic proposes creating tickets for each action item

### Phase 5: Shell Actions & Advanced Features
- Sandboxed shell command execution
- Visual ActionBuilder for creating custom plugins without YAML
- Plugin import/export (share plugin files)
- Trust levels for frequently-used actions
- Action chains (output of one action feeds into the next)
- Scheduled actions ("Every Friday, export this week's decisions to a file")

---

## Performance Considerations

| Operation | Time | Notes |
|-----------|------|-------|
| Plugin YAML parsing | ~5ms | Small files, simple schema |
| LLM parameter extraction | ~2-4s | Single llama.cpp inference pass |
| Batch extraction (10 items) | ~5-8s | One inference for the batch, not per-item |
| Filesystem action execution | ~10ms | Direct file I/O |
| Webhook execution | ~100ms-5s | Depends on target server; timeout enforced |
| Shell command execution | ~50ms-5s | Timeout enforced |
| Action log query (1000 entries) | ~20ms | SQLite indexed query |

The LLM extraction is the bottleneck. Since the user is reviewing and approving anyway, 2-4 seconds is acceptable — the approval modal renders while extraction completes.

---

## Dependencies

| Dependency | Already in project? | Purpose |
|-----------|---------------------|---------|
| `serde_yaml` | **No** | Parse plugin YAML definitions |
| `reqwest` (blocking) | **No** | HTTP client for webhook actions |
| `handlebars` or `tera` | **No** | Template rendering for action bodies |
| `llama-cpp-rs` | Yes | LLM parameter extraction |
| `arboard` | Yes | Clipboard actions |
| `rusqlite` | Yes | Action/plugin storage |

Three new Rust dependencies, all well-maintained and auditable.

---

## Open Questions

1. **Plugin distribution.** For now, plugins are local YAML files. Should we eventually support a curated plugin directory (still just a git repo of YAML files, no marketplace server)?

2. **Action chaining.** Should one action's output be pipeable into another? E.g., "Transcribe this meeting, then create tickets, then email the summary." This adds significant complexity to the execution model.

3. **Undo/rollback.** If a webhook call succeeds but the user regrets it, can we undo? Filesystem actions are reversible (keep a backup before overwrite). Webhook actions are generally not reversible.

4. **Rate limiting.** If a user says "Create tickets for all 50 action items from this month's meetings," should we batch or throttle? 50 sequential webhook calls could overwhelm a self-hosted service.

5. **Authentication.** Webhooks to services like Jira need API tokens. Where should these be stored? The SQLite database is local but not encrypted. Should we use the OS keychain (macOS Keychain, Windows Credential Manager)?

6. **Error recovery.** If 3 of 10 webhook calls fail, how should we report this? Retry? Show partial success with option to retry failed ones?

---

## Success Metrics

- Plugin installation: <30 seconds from YAML file to working action
- Parameter extraction accuracy: >85% for well-defined schemas with clear voice input
- Approval-to-execution latency: <500ms for filesystem, <5s for webhooks
- User trust: >90% of approved actions execute successfully (good parameter extraction)
- Adoption: Users who enable actions use them >3 times per week
