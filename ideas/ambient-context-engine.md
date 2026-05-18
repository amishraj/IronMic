# Ambient Context Engine

## Overview

Passively detect what the user is working on by reading the active window and application, then automatically adapt dictation behavior to match the context. When the user is in VS Code, format dictation as code comments or documentation. In Gmail, use email-appropriate tone and structure. In Slack, keep messages brief and conversational. In a terminal, dictate shell commands.

IronMic already has voice routing, intent classification, LLM text cleanup, and per-entry dictionary boosting. The missing piece is awareness of what the user is doing outside IronMic. The Ambient Context Engine bridges this gap by monitoring the active window title, classifying the application context, selecting an appropriate LLM prompt template, and boosting domain-specific vocabulary — all locally, with no data leaving the device.

This transforms IronMic from "a dictation tool you paste from" into "a dictation tool that understands where you're pasting to."

---

## What This Enables

- In VS Code editing a Python file:
  ```
  You say: "add a docstring that explains this function takes a list of user IDs 
            and returns a dictionary mapping each ID to their account status"
  
  IronMic produces:
  """Retrieve account statuses for a list of users.
  
  Args:
      user_ids: List of user ID strings to look up.
  
  Returns:
      Dict mapping each user_id to its AccountStatus enum value.
  """
  ```

- In Gmail composing a reply:
  ```
  You say: "hey Sarah thanks for sending over the proposal I had a few thoughts 
            the timeline looks good but I think we should add two weeks for QA 
            let me know if you want to discuss further"
  
  IronMic produces:
  Hi Sarah,

  Thanks for sending over the proposal! I had a few thoughts:

  The timeline looks good, but I think we should add two weeks for QA. Let me know 
  if you'd like to discuss further.

  Best,
  ```

- In Slack:
  ```
  You say: "hey team quick update the staging deploy is done and all tests are passing 
            we're good to go for the production push tomorrow morning"
  
  IronMic produces:
  Hey team, quick update: the staging deploy is done and all tests are passing. 
  We're good to go for the production push tomorrow morning.
  ```

- In a terminal:
  ```
  You say: "list all Docker containers that are running and show their ports"
  
  IronMic produces:
  docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
  ```

- In Notion/Obsidian:
  ```
  You say: "create a heading called architecture decisions and then a bullet list 
            first item use Redis for caching second item deploy to AWS ECS 
            third item GraphQL for the API layer"
  
  IronMic produces:
  ## Architecture Decisions

  - Use Redis for caching
  - Deploy to AWS ECS
  - GraphQL for the API layer
  ```

---

## Architecture

### New Components

```
Rust Core
├── context/
│   ├── mod.rs
│   ├── detector.rs          # Active window detection (platform-specific)
│   ├── classifier.rs        # Classify window into context category
│   ├── prompt_selector.rs   # Select LLM prompt template based on context
│   ├── dictionary_boost.rs  # Context-aware dictionary word boosting
│   └── rules.rs             # User-defined per-app rules
│
├── context/platform/
│   ├── mod.rs
│   ├── macos.rs             # NSWorkspace / osascript window detection
│   ├── windows.rs           # Win32 GetForegroundWindow / PowerShell
│   └── linux.rs             # wmctrl / xdotool / D-Bus window detection

Electron App
├── renderer/
│   ├── components/
│   │   ├── ContextIndicator.tsx       # Shows current detected context in status bar
│   │   ├── ContextRulesPage.tsx       # Configure per-app dictation rules
│   │   ├── ContextRuleCard.tsx        # Individual app rule editor
│   │   ├── ContextRuleEditor.tsx      # Detailed rule editing modal
│   │   ├── ContextHistory.tsx         # Recent context switches (for debugging)
│   │   └── PromptTemplateEditor.tsx   # Edit LLM prompt templates per context
│   ├── stores/
│   │   └── useContextStore.ts         # Active context state, rules, history
│   └── services/
│       ├── ContextService.ts          # Polls for context changes, notifies components
│       └── PromptTemplateEngine.ts    # Resolves template variables for LLM prompts
```

### System Diagram

```
┌──────────────────────────────────────────────────────────┐
│                    Operating System                        │
│                                                            │
│   [VS Code]  [Gmail/Chrome]  [Slack]  [Terminal]  [Notion] │
│       │            │           │          │          │      │
│       └────────────┼───────────┼──────────┼──────────┘      │
│                    │     Active Window                       │
└────────────────────┼────────────────────────────────────────┘
                     │
                     ▼
          [Window Detector (Rust)]
          Platform-specific:
            macOS: NSWorkspace.activeApplication
            Windows: GetForegroundWindow + GetWindowText
            Linux: xdotool getactivewindow
                     │
                     ▼
          ┌──────────────────────┐
          │ Window Info:          │
          │  app: "Code"          │
          │  title: "parser.py"   │
          │  bundle: "com.microsoft.VSCode" │
          └──────────┬───────────┘
                     │
                     ▼
          [Context Classifier]
          Rule-based + lightweight ML:
            1. Check user-defined rules first
            2. Match app name/bundle against built-in categories
            3. Parse window title for additional signals
                     │
                     ▼
          ┌──────────────────────┐
          │ Context:              │
          │  category: "code"     │
          │  app: "VS Code"       │
          │  language: "python"   │
          │  file: "parser.py"    │
          │  confidence: 0.95     │
          └──────────┬───────────┘
                     │
            ┌────────┼────────┐
            │        │        │
            ▼        ▼        ▼
     [Prompt     [Dictionary  [Formatting
      Selector]   Booster]     Hints]
         │           │            │
         │    "python",      "code_block",
         │    "function",    "docstring",
         │    "class"        "indented"
         │           │            │
         └───────────┼────────────┘
                     │
                     ▼
            [LLM Cleanup Pipeline]
            System prompt tailored to:
              "You are formatting a Python docstring..."
                     │
                     ▼
            [Formatted Output → Clipboard]
```

### Context Detection Data Flow

```
[Polling Loop: every 500ms]
         │
         ▼
[Detect Active Window]
  macOS:   osascript -e 'tell application "System Events" to get
            {name, title} of first application process whose frontmost is true'
  Windows: PowerShell Get-Process | Where MainWindowHandle -ne 0
  Linux:   xdotool getactivewindow getwindowname / getwindowpid
         │
         ▼
[Changed since last poll?]
  ├── No → skip (no work)
  └── Yes ↓
         │
         ▼
[Classify Context]
  1. User rules: "VS Code" → category: code, prompt: code_cleanup
  2. Built-in map:
     "Code" / "code" / "VSCode"      → code
     "Chrome" / "Firefox" / "Safari"  → browser (inspect title for Gmail, Docs, etc.)
     "Slack" / "Discord" / "Teams"    → messaging
     "Terminal" / "iTerm" / "Warp"    → terminal
     "Notion" / "Obsidian"            → notes
     "Mail" / "Outlook"               → email
     "Figma" / "Sketch"               → design
  3. Title parsing:
     "parser.py - Visual Studio Code" → language: python, file: parser.py
     "Inbox - jason@company.com - Gmail" → subcategory: email, provider: gmail
     "#engineering - Slack"            → subcategory: channel, channel: engineering
         │
         ▼
[Update Context State]
  Emit IPC event: context_changed
  Components update: ContextIndicator shows new context
  Next dictation will use this context
         │
         ▼
[When Dictation Starts]
  1. Read current context from state
  2. Select prompt template for this context category
  3. Load context-specific dictionary words
  4. Pass all of this to the LLM cleanup pipeline
```

---

## Window Detection Implementation

### macOS

```rust
// context/platform/macos.rs
// Uses NSWorkspace via objc2 crate or osascript subprocess

pub fn get_active_window() -> Result<WindowInfo> {
    // Primary: Use NSWorkspace API via Objective-C runtime
    // This gives us:
    //   - localizedName: "Visual Studio Code"
    //   - bundleIdentifier: "com.microsoft.VSCode"
    //   - processIdentifier: PID
    
    // For window title, use Accessibility API (AXUIElement):
    //   - AXTitle of the focused window → "parser.py - Visual Studio Code"
    
    // Fallback: osascript subprocess
    //   tell application "System Events"
    //     set frontApp to first application process whose frontmost is true
    //     set appName to name of frontApp
    //     set windowTitle to name of first window of frontApp
    //   end tell
    
    // Accessibility API requires user permission (Privacy > Accessibility)
    // First attempt: check if permission is granted
    // If not: use osascript fallback (less reliable but no permission needed)
    // Prompt user to grant Accessibility permission in Settings panel
}
```

**macOS permissions:**
- `NSWorkspace` info (app name, bundle ID): no permission needed
- Window title via Accessibility API: requires "Accessibility" permission in System Settings > Privacy
- IronMic already needs Accessibility for global hotkey registration, so this is likely already granted
- If not granted, fall back to app name only (no window title)

### Windows

```rust
// context/platform/windows.rs
// Uses Win32 API: GetForegroundWindow, GetWindowText, GetWindowThreadProcessId

pub fn get_active_window() -> Result<WindowInfo> {
    // GetForegroundWindow() → HWND
    // GetWindowTextW(hwnd) → window title string
    // GetWindowThreadProcessId(hwnd) → PID
    // OpenProcess(pid) → QueryFullProcessImageNameW → exe path
    // Extract app name from exe path
    
    // No special permissions needed on Windows
    // Works in all Windows versions (7+)
}
```

### Linux

```rust
// context/platform/linux.rs
// Uses X11 via xdotool or D-Bus for Wayland

pub fn get_active_window() -> Result<WindowInfo> {
    // X11 (xdotool):
    //   xdotool getactivewindow → window ID
    //   xdotool getactivewindow getwindowname → title
    //   xdotool getactivewindow getwindowpid → PID
    //   /proc/{pid}/comm → process name
    
    // Wayland (D-Bus / wlr-foreign-toplevel):
    //   Wayland compositors don't expose other windows by default
    //   KDE: D-Bus org.kde.KWin
    //   GNOME: GNOME Shell extension (limited)
    //   Sway/wlroots: wlr-foreign-toplevel-management protocol
    
    // Fallback: wmctrl -a (X11 only)
    
    // Linux detection is the most fragile — offer manual "current app" selector
    // as fallback when automated detection isn't available
}
```

### Polling Strategy

- **Poll interval:** 500ms (twice per second)
- **Debounce:** Only emit `context_changed` if the context has been stable for 300ms (avoid rapid switching when alt-tabbing)
- **Resource usage:** One lightweight system call every 500ms; negligible CPU/memory impact
- **When to poll:** Only while IronMic is running. Stop polling if the user disables context detection.
- **Optimization:** Cache the last window info. Only classify if the app name or window title changed.

---

## Context Classification

### Built-in Categories

```
code
├── Matches: VS Code, Vim, Neovim, Emacs, IntelliJ, PyCharm, WebStorm,
│            Sublime Text, Atom, Xcode, Android Studio, CLion, GoLand
├── Title parsing: extract filename → detect language from extension
│   .py → python, .ts/.tsx → typescript, .rs → rust, .go → golang,
│   .java → java, .rb → ruby, .cpp/.c → cpp, .swift → swift
├── Prompt: code-aware formatting (docstrings, comments, inline docs)
└── Dictionary: programming terms, camelCase/snake_case detection

browser
├── Matches: Chrome, Firefox, Safari, Edge, Arc, Brave, Opera
├── Title parsing: detect web app from title
│   "Gmail" → email subcategory
│   "Google Docs" → document subcategory
│   "Jira" / "Linear" / "Asana" → project_management subcategory
│   "GitHub" / "GitLab" → code_review subcategory
│   "Figma" → design subcategory
│   "Slack" (web) → messaging subcategory
├── Prompt: varies by detected web app
└── Dictionary: varies by detected web app

messaging
├── Matches: Slack, Discord, Teams, Telegram, Signal, Messages
├── Prompt: brief, conversational, no formal salutations
└── Dictionary: emoji shortcodes, team/channel names

email
├── Matches: Mail, Outlook, Thunderbird, Spark
│            Also: Gmail detected in browser
├── Prompt: professional email formatting, greeting + body + closing
└── Dictionary: professional vocabulary, formal phrases

terminal
├── Matches: Terminal, iTerm2, Warp, Alacritty, Hyper, Kitty, tmux
├── Title parsing: detect shell type, current directory
├── Prompt: generate shell commands, not prose
└── Dictionary: CLI commands, flags, paths

notes
├── Matches: Notion, Obsidian, Bear, Apple Notes, Evernote, Roam
├── Prompt: structured note formatting (headings, bullets, markdown)
└── Dictionary: note-taking vocabulary

document
├── Matches: Word, Pages, Google Docs (browser), LibreOffice Writer
├── Prompt: standard prose cleanup (closest to default IronMic behavior)
└── Dictionary: writing vocabulary

spreadsheet
├── Matches: Excel, Numbers, Google Sheets (browser), LibreOffice Calc
├── Prompt: terse, data-oriented (column names, formulas, values)
└── Dictionary: spreadsheet terms, formula syntax

design
├── Matches: Figma, Sketch, Adobe XD, Photoshop, Illustrator
├── Prompt: design terminology, annotation-style text
└── Dictionary: design vocabulary (padding, margin, hex colors, typeface names)

general
├── Default fallback for unrecognized apps
├── Prompt: standard IronMic cleanup (existing behavior)
└── Dictionary: no special boosting
```

### Classification Algorithm

```
classify(window_info):
  1. Check user-defined rules (highest priority):
     - Exact app name match → return user's configured category
     - Regex match on window title → return matched rule's category
  
  2. Check built-in app name map:
     - Normalize app name (lowercase, strip version numbers)
     - Look up in KNOWN_APPS map → return category
  
  3. For browsers, parse title for web app detection:
     - Check title against WEB_APP_PATTERNS (Gmail, Docs, Jira, etc.)
     - If match → return specific subcategory
     - If no match → return generic "browser"
  
  4. Parse window title for additional signals:
     - File extensions → detect language for code editors
     - Email addresses → detect email context
     - Channel/DM names → detect messaging context
  
  5. Fallback → "general"
```

### Lightweight On-Device Classifier (Optional Enhancement)

For edge cases where rule-based classification fails (uncommon apps, ambiguous titles), a tiny TF.js classifier can help:

- **Input:** Tokenized window title (32 tokens max)
- **Architecture:** Single dense layer, ~5KB model
- **Output:** Probability distribution over context categories
- **Training data:** User's context switching history (which app → which category the rules assigned)
- **Purpose:** Catch apps like "Warp" (terminal, not a game) or "Bear" (notes, not the animal)

This is strictly optional. The rule-based system handles 95%+ of cases. The classifier is a polish feature for Phase 4+.

---

## LLM Prompt Templates

### Template Format

Each context category has an associated prompt template that replaces the default IronMic cleanup prompt.

```rust
struct PromptTemplate {
    category: String,             // "code", "email", "messaging", etc.
    system_prompt: String,        // Full system prompt for the LLM
    format_hints: Vec<String>,    // Post-processing instructions
    dictionary_words: Vec<String>, // Extra words to boost in Whisper
    example_input: String,        // For testing/preview
    example_output: String,       // Expected result
}
```

### Code Context Prompt

```
You are a code documentation assistant. You receive raw speech-to-text transcriptions 
and produce clean text appropriate for a code editor.

Context: The user is dictating in {{app_name}}, editing a {{language}} file ({{filename}}).

Rules:
- If the user describes a function, class, or variable, format as a docstring/comment 
  in the appropriate style for {{language}}
- Python: Use triple-quote docstrings with Args/Returns sections
- JavaScript/TypeScript: Use JSDoc format (/** ... */)
- Rust: Use /// doc comments with # Examples section
- For inline comments, use the language's comment syntax (// or #)
- Preserve technical terms exactly (function names, variable names, types)
- Convert spoken descriptions to proper technical prose
- If the user is dictating code itself (not comments), output the code directly
- Detect intent: "add a docstring" vs "write a function that" vs "comment explaining"
- Fix grammar and remove filler words
- Output ONLY the formatted text, nothing else

Input transcript:
{raw_transcript}
```

### Email Context Prompt

```
You are an email formatting assistant. You receive raw speech-to-text transcriptions 
and produce clean, well-structured email text.

Rules:
- Add appropriate greeting if the user starts with a name ("hey Sarah" → "Hi Sarah,")
- Structure the body into clear paragraphs
- Add a professional closing if the user seems to be finishing ("thanks" → "Thanks," or "Best,")
- Fix grammar, punctuation, and remove filler words
- Maintain the user's tone — casual if they sound casual, formal if formal
- Do NOT add a signature line (the email client handles that)
- Do NOT add a subject line unless the user explicitly dictates one
- Keep the user's original intent and level of detail
- Output ONLY the formatted email text, nothing else

Input transcript:
{raw_transcript}
```

### Messaging Context Prompt

```
You are a messaging assistant. You receive raw speech-to-text transcriptions and 
produce clean, brief messages suitable for Slack, Discord, or Teams.

Rules:
- Keep it concise — messaging is informal and brief
- No formal greetings or closings
- Fix grammar and remove filler words
- Preserve emoji references ("smiley face" → keep as text, user will add emoji)
- Keep the user's casual tone
- If the user dictates multiple messages, separate them with line breaks
- Do NOT add formatting that messaging platforms can't render
- Output ONLY the cleaned message text, nothing else

Input transcript:
{raw_transcript}
```

### Terminal Context Prompt

```
You are a shell command assistant. You receive raw speech-to-text transcriptions 
describing a terminal operation and produce the correct shell command.

Rules:
- Output ONLY the shell command, nothing else
- Do NOT add explanations, comments, or markdown code blocks
- Use common CLI conventions (long flags for clarity)
- If the user's description is ambiguous, prefer the most common interpretation
- Support bash, zsh, PowerShell — detect from context if possible
- For dangerous commands (rm -rf, drop table), output the command but add a 
  comment: # WARNING: destructive operation
- If the user says "and then" or "pipe that to", chain with | or &&

Examples:
  "list all files including hidden ones" → ls -la
  "find all Python files modified in the last week" → find . -name "*.py" -mtime -7
  "show disk usage sorted by size" → du -sh * | sort -h

Input transcript:
{raw_transcript}
```

### Notes Context Prompt

```
You are a note-taking assistant. You receive raw speech-to-text transcriptions and 
produce clean, structured notes in Markdown format.

Rules:
- Detect structure from speech: "heading" / "title" / "section" → # / ## / ###
- "bullet" / "first" / "next" / "also" → bullet list items
- "number one" / "step one" → numbered list
- Fix grammar, punctuation, remove filler words
- Preserve the user's organizational structure
- If the user dictates a continuous paragraph, keep it as a paragraph
- Bold key terms if the user emphasizes them ("important: ...")
- Output clean Markdown, nothing else

Input transcript:
{raw_transcript}
```

---

## Context-Aware Dictionary Boosting

Different contexts have different vocabularies. When the user is in VS Code editing Python, Whisper should be biased toward recognizing "def," "class," "import," "kwargs" rather than "deaf," "clause," "important," "quarks."

### Implementation

```rust
// Dictionary boost words per context category
struct ContextDictionary {
    category: String,
    words: Vec<String>,
    // Sub-dictionaries by language/tool
    sub_dictionaries: HashMap<String, Vec<String>>,
}

// Built-in dictionaries
const CODE_PYTHON: &[&str] = &[
    "def", "class", "import", "return", "yield", "async", "await",
    "kwargs", "args", "self", "None", "True", "False", "lambda",
    "pytest", "numpy", "pandas", "django", "flask", "fastapi",
    "docstring", "decorator", "generator", "comprehension",
];

const CODE_TYPESCRIPT: &[&str] = &[
    "const", "let", "interface", "type", "enum", "async", "await",
    "Promise", "useState", "useEffect", "useCallback", "useMemo",
    "React", "NextJS", "Express", "TypeScript", "JSDoc",
    "nullable", "readonly", "generic", "extends", "implements",
];

const CODE_RUST: &[&str] = &[
    "fn", "struct", "enum", "impl", "trait", "mod", "pub", "crate",
    "mut", "ref", "dyn", "Box", "Vec", "Option", "Result",
    "unwrap", "clone", "derive", "macro", "lifetime", "borrow",
    "tokio", "serde", "anyhow", "thiserror",
];

const TERMINAL: &[&str] = &[
    "sudo", "chmod", "chown", "grep", "awk", "sed", "pipe",
    "stdout", "stderr", "redirect", "docker", "kubectl",
    "git", "npm", "cargo", "pip", "brew", "apt",
];

const EMAIL_PROFESSIONAL: &[&str] = &[
    "regarding", "attached", "forwarded", "sincerely",
    "availability", "schedule", "deadline", "deliverable",
    "stakeholder", "alignment", "bandwidth", "synergy",
];
```

### How Boosting Works

Whisper's vocabulary boosting uses the `initial_prompt` parameter:
1. Before transcription, the context engine provides a list of domain-specific words
2. These words are formatted as a "vocabulary hint" prompt prefix for Whisper
3. Whisper's language model is biased toward these words during beam search
4. The existing custom dictionary system (user-defined words) is combined with context dictionary

```
Whisper initial_prompt composition:
  [User custom dictionary words]
  + [Context-specific dictionary words]
  + [Recently used words from this context]
  = Combined vocabulary hint
```

---

## Database Schema

### New Tables

```sql
-- Context detection rules (user-defined)
CREATE TABLE context_rules (
    id TEXT PRIMARY KEY,                -- UUID
    name TEXT NOT NULL,                 -- User-facing rule name
    priority INTEGER DEFAULT 0,        -- Higher priority = checked first
    
    -- Match conditions (at least one required)
    match_app_name TEXT,               -- Exact or glob match on app name
    match_app_bundle TEXT,             -- Bundle identifier (macOS) or exe path
    match_title_regex TEXT,            -- Regex on window title
    
    -- Output configuration
    category TEXT NOT NULL,            -- Context category to assign
    subcategory TEXT,                  -- Optional subcategory
    prompt_template_id TEXT,           -- Custom prompt template (null = use category default)
    dictionary_words TEXT DEFAULT '[]', -- JSON array of extra dictionary words
    
    is_enabled INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_context_rules_priority ON context_rules(priority DESC);

-- Custom prompt templates (user-editable)
CREATE TABLE prompt_templates (
    id TEXT PRIMARY KEY,               -- UUID
    name TEXT NOT NULL,                -- Template name
    category TEXT NOT NULL,            -- Associated context category
    system_prompt TEXT NOT NULL,       -- Full LLM system prompt
    format_hints TEXT DEFAULT '[]',    -- JSON array of post-processing hints
    is_builtin INTEGER DEFAULT 0,     -- Built-in vs user-created
    is_default INTEGER DEFAULT 0,     -- Default template for this category
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_prompt_templates_category ON prompt_templates(category);

-- Context history (for debugging and analytics)
CREATE TABLE context_history (
    id TEXT PRIMARY KEY,
    app_name TEXT NOT NULL,
    window_title TEXT,                 -- May be null if title detection failed
    app_bundle TEXT,
    detected_category TEXT NOT NULL,
    detected_subcategory TEXT,
    rule_id TEXT,                      -- Which rule matched (null = built-in)
    confidence REAL DEFAULT 1.0,
    started_at TEXT NOT NULL,          -- When this context became active
    ended_at TEXT,                     -- When context switched away
    duration_seconds REAL              -- How long this context was active
);
CREATE INDEX idx_context_history_started ON context_history(started_at);
CREATE INDEX idx_context_history_category ON context_history(detected_category);

-- Per-entry context metadata
-- (added as a column to the existing entries table, not a new table)
-- ALTER TABLE entries ADD COLUMN context_category TEXT;
-- ALTER TABLE entries ADD COLUMN context_app TEXT;
-- ALTER TABLE entries ADD COLUMN context_detail TEXT;  -- JSON: language, filename, etc.
```

### Settings

| Key | Default | Description |
|-----|---------|-------------|
| `context_detection_enabled` | `false` | Master toggle for ambient context detection |
| `context_poll_interval_ms` | `500` | How often to check active window |
| `context_debounce_ms` | `300` | Stability requirement before context change emits |
| `context_auto_prompt` | `true` | Automatically switch LLM prompt based on context |
| `context_auto_dictionary` | `true` | Automatically boost dictionary based on context |
| `context_show_indicator` | `true` | Show context in status bar |
| `context_history_enabled` | `true` | Log context switches (for analytics) |
| `context_history_retention_days` | `30` | How long to keep context history |
| `context_title_privacy` | `redact_sensitive` | `full` / `redact_sensitive` / `app_only` |

---

## Privacy Considerations

This feature reads window titles, which can contain sensitive information (email subjects, document titles, URLs, chat messages). Privacy must be handled carefully.

### Privacy Levels

```
app_only:
  - Only detect the application name (VS Code, Chrome, Slack)
  - Never read the window title
  - Classification works but cannot detect language, filename, or web app
  - Most private; suitable for users with strict privacy requirements

redact_sensitive (default):
  - Read the window title but apply redaction rules before classification:
    - Email addresses: replaced with "[email]"
    - URLs: only domain kept, path stripped
    - File paths: only filename and extension kept, full path stripped
    - Chat messages in title: stripped entirely
  - Redacted title is used for classification, then discarded
  - Context history stores only: app name, category, subcategory
  - Window title is NEVER stored in context_history

full:
  - Full window title is available for classification
  - Title is still NOT stored in context_history (only category/subcategory stored)
  - Title exists only in memory during the classification step
  - Useful for power users who want maximum context accuracy
```

### Data Guarantees

1. **Window titles are ephemeral.** The detected window title is used for classification in memory, then discarded. It is never written to SQLite, never logged, never sent anywhere.

2. **Context history stores categories, not content.** The `context_history` table records "code/python" not "parser.py - Visual Studio Code." The app name is stored (it's not sensitive), but the window title is not.

3. **No screenshots, no screen content.** The engine reads only the window title string — it never captures screen content, pixels, or accessibility tree content beyond the title.

4. **User controls scope.** The user can disable context detection entirely, switch to `app_only` mode, or create rules that exclude specific apps from detection.

5. **Per-entry context metadata is minimal.** Entries store only the category ("code"), app name ("VS Code"), and a small detail JSON ({"language": "python"}). No window title, no file path, no sensitive content.

---

## Integration with Existing Systems

### Voice Router Integration

The existing `VoiceRouter` decides between dictation, command, and conversation modes. The context engine adds a layer:

```
[Voice Input]
      │
      ▼
[VoiceRouter]
  ├── route: dictation
  │     └── [Context Engine] → which prompt template to use?
  │                              code → code_cleanup prompt
  │                              email → email_format prompt
  │                              terminal → command_generation prompt
  ├── route: command
  │     └── [IntentClassifier] → existing flow (unaffected)
  └── route: conversation
        └── [AI Chat] → existing flow (unaffected)
```

The context engine only affects dictation mode. Commands and AI chat use their existing processing.

### LLM Cleanup Pipeline Integration

The existing cleanup pipeline in `rust-core/src/llm/cleanup.rs` uses a single system prompt. The context engine modifies this:

```rust
// Current flow:
fn cleanup_text(raw_transcript: &str) -> String {
    let prompt = DEFAULT_CLEANUP_PROMPT;
    llm_inference(prompt, raw_transcript)
}

// New flow:
fn cleanup_text(raw_transcript: &str, context: Option<&Context>) -> String {
    let prompt = match context {
        Some(ctx) => get_prompt_template(ctx.category, ctx.subcategory),
        None => DEFAULT_CLEANUP_PROMPT,
    };
    // Inject context variables into prompt template
    let prompt = resolve_template(prompt, context);
    llm_inference(&prompt, raw_transcript)
}
```

### Whisper Dictionary Integration

The existing dictionary system (`rust-core/src/transcription/dictionary.rs`) manages user-defined words. Context-aware boosting adds to this:

```rust
// Current: user dictionary only
fn get_initial_prompt() -> String {
    let words = load_user_dictionary();
    format_vocabulary_hint(&words)
}

// New: user dictionary + context dictionary
fn get_initial_prompt(context: Option<&Context>) -> String {
    let mut words = load_user_dictionary();
    if let Some(ctx) = context {
        words.extend(get_context_dictionary(ctx.category, ctx.subcategory));
    }
    format_vocabulary_hint(&words)
}
```

### Analytics Integration

Context history enables new analytics:

- "Time spent per app category" pie chart
- "Dictation volume by context" (how many entries in code vs email vs messaging)
- "Most productive hours by context" (when do you dictate code vs emails?)
- "Context switching frequency" (how often do you alt-tab between categories)

---

## Rust Core N-API Surface (New Exports)

```typescript
// --- Context Detection ---
startContextDetection(pollIntervalMs: number): void
stopContextDetection(): void
getCurrentContext(): Promise<string>     // JSON: { category, app, title_hash, detail }
onContextChanged(callback: (context: string) => void): void

// --- Context Rules ---
createContextRule(rule: string): Promise<string>   // JSON rule definition
updateContextRule(id: string, updates: string): Promise<void>
deleteContextRule(id: string): Promise<void>
listContextRules(): Promise<string>                // JSON array
testContextRule(appName: string, title: string): Promise<string>  // Which rule matches

// --- Prompt Templates ---
getPromptTemplate(category: string, subcategory?: string): Promise<string>
createPromptTemplate(template: string): Promise<string>
updatePromptTemplate(id: string, updates: string): Promise<void>
deletePromptTemplate(id: string): Promise<void>
listPromptTemplates(): Promise<string>
resetPromptTemplate(category: string): Promise<void>  // Reset to built-in default

// --- Context Dictionary ---
getContextDictionary(category: string, subcategory?: string): Promise<string[]>
addContextDictionaryWord(category: string, word: string): Promise<void>
removeContextDictionaryWord(category: string, word: string): Promise<void>

// --- Context History ---
getContextHistory(from: string, to: string, limit?: number): Promise<string>
getContextStats(from: string, to: string): Promise<string>  // Time per category
deleteContextHistory(olderThan: string): Promise<number>
```

---

## New Files

### Rust Core

| File | Purpose |
|------|---------|
| `rust-core/src/context/mod.rs` | Module exports |
| `rust-core/src/context/detector.rs` | Active window detection orchestrator |
| `rust-core/src/context/classifier.rs` | Window info → context category |
| `rust-core/src/context/prompt_selector.rs` | Context → prompt template resolution |
| `rust-core/src/context/dictionary_boost.rs` | Context-specific dictionary word lists |
| `rust-core/src/context/rules.rs` | User-defined rule matching engine |
| `rust-core/src/context/platform/mod.rs` | Platform module exports |
| `rust-core/src/context/platform/macos.rs` | macOS window detection |
| `rust-core/src/context/platform/windows.rs` | Windows window detection |
| `rust-core/src/context/platform/linux.rs` | Linux window detection |
| `rust-core/src/storage/context.rs` | Context rules, templates, history CRUD |

### Electron App

| File | Purpose |
|------|---------|
| `electron-app/src/renderer/components/ContextIndicator.tsx` | Status bar context display |
| `electron-app/src/renderer/components/ContextRulesPage.tsx` | Rule configuration page |
| `electron-app/src/renderer/components/ContextRuleCard.tsx` | Individual rule card |
| `electron-app/src/renderer/components/ContextRuleEditor.tsx` | Rule editing modal |
| `electron-app/src/renderer/components/ContextHistory.tsx` | Context switch log |
| `electron-app/src/renderer/components/PromptTemplateEditor.tsx` | Template editing |
| `electron-app/src/renderer/stores/useContextStore.ts` | Context state management |
| `electron-app/src/renderer/services/ContextService.ts` | Polling, classification, events |
| `electron-app/src/renderer/services/PromptTemplateEngine.ts` | Template variable resolution |

### Files to Modify

| File | Change |
|------|--------|
| `rust-core/src/lib.rs` | Add N-API exports for context functions |
| `rust-core/src/storage/db.rs` | Add migration for context tables + entries columns |
| `rust-core/src/llm/cleanup.rs` | Accept optional context parameter for prompt selection |
| `rust-core/src/llm/prompts.rs` | Add context-specific prompt templates |
| `rust-core/src/transcription/whisper.rs` | Accept context dictionary words for initial_prompt |
| `rust-core/src/transcription/dictionary.rs` | Merge user + context dictionaries |
| `rust-core/Cargo.toml` | Add `regex` (if not present), platform-specific deps |
| `electron-app/src/main/ipc-handlers.ts` | Wire context IPC channels |
| `electron-app/src/preload/index.ts` | Expose context API to renderer |
| `electron-app/src/renderer/components/Layout.tsx` | Add ContextIndicator to status bar |
| `electron-app/src/renderer/components/SettingsPanel.tsx` | Add context detection settings section |
| `electron-app/src/renderer/components/RecordingIndicator.tsx` | Show active context during recording |
| `electron-app/src/renderer/services/VoiceRouter.ts` | Pass context to dictation pipeline |
| `electron-app/src/renderer/components/EntryCard.tsx` | Show context badge on entries |
| `electron-app/src/renderer/components/AnalyticsDashboard.tsx` | Add context-based analytics |

---

## Phased Rollout

### Phase 1: Window Detection Foundation
- Implement platform-specific window detection (macOS first, then Windows, Linux)
- Basic polling loop with debounce
- `ContextIndicator.tsx` showing current app name in the status bar
- Settings toggle for enabling/disabling
- **Deliverable:** IronMic shows which app is currently focused

### Phase 2: Context Classification and Prompt Switching
- Built-in app-to-category mapping (15+ apps)
- Window title parsing for language/file detection
- Context-specific LLM prompt templates (code, email, messaging, terminal, notes)
- Automatic prompt switching during dictation
- `context_category` stored on entries
- **Deliverable:** Dictate in VS Code → get code-formatted output; dictate in Gmail → get email-formatted output

### Phase 3: Dictionary Boosting
- Built-in context dictionaries (Python, TypeScript, Rust, terminal, email)
- Merge context dictionary with user custom dictionary for Whisper
- Sub-dictionary selection based on detected language/tool
- **Deliverable:** Whisper accurately transcribes "kwargs" when in Python, "kubectl" when in terminal

### Phase 4: User-Defined Rules and Custom Templates
- `ContextRulesPage.tsx` for creating custom app → category rules
- Regex matching on window titles
- `PromptTemplateEditor.tsx` for editing/creating prompt templates
- Import/export rules and templates
- **Deliverable:** User can configure "When in Figma, use design-oriented formatting"

### Phase 5: Analytics, History, and Polish
- Context history logging and analytics charts
- Browser web app detection (Gmail, Docs, Jira in Chrome)
- Lightweight TF.js classifier for edge-case apps
- Linux Wayland support improvements
- Context-aware entry filtering ("Show me all dictations I made while coding")
- Smart context learning: if user always edits the LLM output in a specific context, suggest prompt improvements

---

## Performance Considerations

| Operation | Time | Notes |
|-----------|------|-------|
| Window detection (single poll) | ~2ms macOS, ~1ms Windows, ~5ms Linux | System call + string extraction |
| Context classification | ~0.5ms | HashMap lookup + regex (if title parsing) |
| Dictionary merge (user + context) | ~1ms | Vec concatenation |
| Prompt template resolution | ~0.5ms | String interpolation |
| Context history insert | ~2ms | SQLite insert |
| Polling overhead (500ms interval) | <0.1% CPU | Negligible |

The context engine adds virtually zero latency to the dictation pipeline. Window detection and classification complete in <10ms total. The LLM inference time is unchanged — only the prompt content changes.

### Memory

- Context dictionaries: ~50KB total (all categories combined)
- Prompt templates: ~20KB total
- Context history (30 days): ~500KB in SQLite
- No new ML models in Phase 1-4 (the optional Phase 5 classifier is ~5KB)

---

## Open Questions

1. **Multi-monitor context.** If the user has two monitors — one with VS Code and one with a browser — which context wins? Should IronMic track the window that was most recently focused, or the one the user was looking at when they pressed the hotkey?

2. **Context for IronMic itself.** When IronMic is the focused window (e.g., using the note editor or AI chat), what context should apply? Probably "notes" for the editor and "general" for AI chat. The note editor already has its own flow, so context detection should be a no-op when IronMic is focused.

3. **Rapid context switching.** If the user alt-tabs between VS Code and Chrome 5 times in 3 seconds, the debounce (300ms) should prevent thrashing. But what if they start dictating mid-switch? Use the context that was stable before the switching began.

4. **Terminal command accuracy.** Generating shell commands from voice is powerful but risky. Should there be extra confirmation for commands that modify files or system state? Or is the existing "approve clipboard content" flow sufficient?

5. **Custom app training.** For niche apps that the built-in classifier doesn't recognize (e.g., a custom internal tool), should the user be able to "teach" IronMic? "This app is for code review, treat it like VS Code." This is essentially what user-defined rules provide, but could be more streamlined.

6. **Language detection accuracy.** Detecting the programming language from the filename extension is reliable. But some editors don't put the filename in the title, or the user could be editing a file with an ambiguous extension (.h could be C or C++). How important is sub-language accuracy vs just "code" category?

7. **Wayland support on Linux.** Wayland's security model intentionally prevents apps from reading other windows' titles. This is a fundamental limitation, not a bug. For Wayland users, the best option may be a compositor-specific extension or manual context selection. How much effort should we invest in Wayland workarounds vs accepting the limitation?

---

## Dependencies

| Dependency | Already in project? | Purpose |
|-----------|---------------------|---------|
| `regex` | Likely (check) | Title parsing and rule matching |
| `objc2` or `cocoa` | **Check macOS deps** | NSWorkspace API on macOS |
| `windows` crate | **Check Windows deps** | Win32 API on Windows |
| Platform CLI tools | System-provided | osascript (macOS), xdotool (Linux) |

Minimal new dependencies. macOS and Windows detection may use existing platform crates or shell out to system tools. Linux detection uses xdotool (user must install) with wmctrl as fallback.

---

## Success Metrics

- Context detection accuracy: >95% for the top 15 apps (VS Code, Chrome, Slack, Terminal, etc.)
- Prompt switching perceived benefit: >70% of users report "better formatted output" with context detection on
- Latency impact: <5ms added to the dictation pipeline
- Dictionary boosting impact: >10% improvement in technical term recognition in code contexts
- User adoption: >60% of users enable context detection after trying it once
- False positive rate: <2% of dictations get the wrong context category
