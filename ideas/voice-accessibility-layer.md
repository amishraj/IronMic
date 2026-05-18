# Voice-Powered Accessibility Layer

## Overview

Transform IronMic into a system-wide accessibility tool that enables hands-free computer operation beyond dictation. Users navigate their OS, control applications, fill forms, manage windows, and interact with UI elements entirely by voice. This goes far beyond typing replacement — it replaces the mouse and keyboard as primary input devices for users with motor disabilities, repetitive strain injuries (RSI), or anyone who benefits from hands-free workflows.

IronMic already has voice activity detection, intent classification, context-aware routing, and a local LLM for interpreting natural language. The accessibility layer adds a platform-native bridge to the OS accessibility tree (macOS Accessibility API, Windows UI Automation, Linux AT-SPI), enabling IronMic to enumerate visible UI elements, target them by voice, and simulate clicks, keystrokes, scrolling, and drag operations. All processing remains local — no audio or interaction data leaves the device.

This positions IronMic as more than a dictation tool: it becomes an enterprise-grade assistive technology that replaces expensive proprietary solutions (Dragon NaturallySpeaking, Talon Voice) with an open-source, fully-local alternative.

---

## What This Enables

- **UI element targeting by voice:**
  ```
  You say: "click the Save button"
  IronMic: Queries accessibility tree → finds button labeled "Save" → simulates click.
  
  You say: "click the third link"
  IronMic: Enumerates visible links → highlights them with numbered overlays → clicks #3.
  ```

- **Window and workspace management:**
  ```
  You say: "switch to Slack"
  IronMic: Activates the Slack window.
  
  You say: "move this window to the right half"
  IronMic: Resizes and positions the current window to the right 50% of the screen.
  
  You say: "close this tab"
  IronMic: Sends Cmd+W / Ctrl+W to the focused application.
  ```

- **Form filling:**
  ```
  You say: "tab to the email field and type jason at company dot com"
  IronMic: Sends Tab keystrokes to reach the field, then types the email.
  
  You say: "select United States from the country dropdown"
  IronMic: Finds the dropdown via accessibility tree, opens it, selects the matching option.
  ```

- **Cursor and scroll control:**
  ```
  You say: "scroll down"
  IronMic: Scrolls the active window down by one page.
  
  You say: "move cursor to the search box"
  IronMic: Moves the mouse cursor to the search input element.
  ```

- **Text editing by voice (beyond dictation):**
  ```
  You say: "select the last paragraph"
  IronMic: Positions cursor and selects the text.
  
  You say: "bold that"
  IronMic: Sends Cmd+B / Ctrl+B to the focused application.
  
  You say: "undo three times"
  IronMic: Sends Cmd+Z / Ctrl+Z three times.
  ```

- **Keyboard shortcut invocation:**
  ```
  You say: "save this file"
  IronMic: Sends Cmd+S / Ctrl+S.
  
  You say: "open a new terminal"
  IronMic: Sends the platform-appropriate shortcut.
  ```

---

## Architecture

### New Components

```
Rust Core
├── accessibility/
│   ├── mod.rs
│   ├── tree.rs               # Accessibility tree enumeration and caching
│   ├── element.rs             # UI element abstraction (role, label, bounds, actions)
│   ├── actions.rs             # Simulate click, type, scroll, drag, select
│   ├── targeting.rs           # Resolve voice descriptions to UI elements
│   ├── overlay.rs             # Screen overlay coordinates for numbered hints
│   ├── keyboard_sim.rs        # Cross-platform keystroke simulation
│   ├── mouse_sim.rs           # Cross-platform mouse movement and click simulation
│   ├── window_manager.rs      # Window move, resize, focus, minimize, maximize
│   └── platform/
│       ├── mod.rs
│       ├── macos.rs           # AXUIElement API, NSAccessibility
│       ├── windows.rs         # UI Automation (UIA), MSAA fallback
│       └── linux.rs           # AT-SPI2 via D-Bus

Electron App
├── renderer/
│   ├── components/
│   │   ├── accessibility/
│   │   │   ├── AccessibilityPage.tsx        # Main config page
│   │   │   ├── VoiceNavigator.tsx           # Command palette-style element picker
│   │   │   ├── ElementOverlay.tsx           # Numbered overlay on screen elements
│   │   │   ├── CommandFeedback.tsx          # Shows recognized command + result
│   │   │   ├── CursorGrid.tsx              # Grid overlay for precise cursor positioning
│   │   │   ├── AccessibilityHistory.tsx     # Log of voice commands executed
│   │   │   └── CommandCheatSheet.tsx        # Quick reference of available commands
│   │   │
│   │   └── settings/
│   │       └── AccessibilitySettings.tsx    # Toggle features, sensitivity, overlay style
│   │
│   ├── stores/
│   │   └── useAccessibilityStore.ts         # Current state, element cache, overlay mode
│   │
│   └── services/
│       ├── AccessibilityEngine.ts           # Orchestrates command interpretation + execution
│       ├── CommandInterpreter.ts            # NLU for accessibility commands via LLM
│       ├── ElementResolver.ts               # Match spoken description to UI elements
│       └── OverlayRenderer.ts               # Manages numbered hint overlays
```

### System Diagram

```
┌───────────────────────────────────────────────────────────────┐
│                     Operating System                           │
│                                                                │
│   ┌──────────────────────────────────────────────────┐        │
│   │          Accessibility Tree (Live)                │        │
│   │                                                   │        │
│   │   Window: "VS Code"                              │        │
│   │   ├── MenuBar                                     │        │
│   │   ├── ToolBar                                     │        │
│   │   │   ├── Button "Run" [bounds: 120,40,60,30]    │        │
│   │   │   ├── Button "Debug" [bounds: 180,40,60,30]  │        │
│   │   │   └── Button "Save" [bounds: 240,40,60,30]   │        │
│   │   ├── Editor                                      │        │
│   │   │   ├── TextArea [editable, focused]            │        │
│   │   │   └── ScrollBar                               │        │
│   │   └── StatusBar                                   │        │
│   │       ├── Label "Ln 42, Col 8"                    │        │
│   │       └── Button "UTF-8"                          │        │
│   └──────────────────────────────────────────────────┘        │
│                          │                                     │
└──────────────────────────┼─────────────────────────────────────┘
                           │ Platform API
                           │ macOS: AXUIElement
                           │ Windows: IUIAutomation
                           │ Linux: AT-SPI2 / D-Bus
                           │
          ┌────────────────▼────────────────┐
          │     Rust Core: Accessibility     │
          │                                  │
          │  ┌────────────────────────────┐  │
          │  │  Tree Enumerator           │  │
          │  │  - Walk accessibility tree  │  │
          │  │  - Cache visible elements   │  │
          │  │  - Filter by role/label     │  │
          │  └──────────┬─────────────────┘  │
          │             │                    │
          │  ┌──────────▼─────────────────┐  │
          │  │  Element Targeting         │  │
          │  │  - Match voice description  │  │
          │  │  - Fuzzy label matching     │  │
          │  │  - Numbered hint assignment │  │
          │  └──────────┬─────────────────┘  │
          │             │                    │
          │  ┌──────────▼─────────────────┐  │
          │  │  Action Executor           │  │
          │  │  - Click (AXPress / UIA)    │  │
          │  │  - Type (CGEvent / SendInput)│  │
          │  │  - Scroll (wheel events)    │  │
          │  │  - Move/resize windows      │  │
          │  └────────────────────────────┘  │
          │                                  │
          └──────────────────────────────────┘
                           │
                    IPC (napi-rs)
                           │
          ┌────────────────▼────────────────┐
          │     Electron: Renderer           │
          │                                  │
          │  [Voice Input] ──→ [CommandInterpreter]
          │                          │
          │              ┌───────────┼───────────┐
          │          dictation    a11y command   macro
          │              │           │            │
          │         (existing)  [AccessibilityEngine]
          │                          │
          │              ┌───────────┼───────────┐
          │          element     window        keyboard
          │          action      mgmt         shortcut
          │              │           │            │
          │         IPC: click   IPC: move    IPC: keystroke
          │                                      │
          └──────────────────────────────────────┘
```

### Command Interpretation Flow

```
[User speaks: "click the Save button"]
        │
        ▼
[VAD + Whisper STT]
        │ transcript: "click the Save button"
        ▼
[Intent Classifier]
        │ intent: accessibility_command (0.94)
        ▼
[CommandInterpreter (LLM-assisted)]
        │
        ├── Parse command structure:
        │     verb: "click"
        │     target: "the Save button"
        │     modifiers: []
        │
        ├── Classify command type:
        │     element_action (vs window_mgmt, keyboard, cursor, scroll)
        │
        ▼
[ElementResolver]
        │
        ├── Query accessibility tree for buttons
        │   containing "Save" in label
        │
        ├── Results:
        │   ┌──────────────────────────────────────┐
        │   │ 1. Button "Save" (toolbar, visible)  │ ← best match
        │   │ 2. MenuItem "Save As..." (menu, hidden)│
        │   └──────────────────────────────────────┘
        │
        ├── Single confident match → execute directly
        │   Multiple matches → show numbered overlay for disambiguation
        │
        ▼
[Action Executor]
        │
        ├── Simulate click at button center coordinates
        │   macOS: AXPerformAction(kAXPressAction)
        │   Windows: InvokePattern.Invoke()
        │   Linux: AT-SPI Action.doAction("click")
        │
        ▼
[CommandFeedback]
        │ "Clicked Save" (brief confirmation toast)
```

---

## Command Grammar

### Built-In Command Categories

```
click / press / tap
├── "click [the] <element description>"
│   "click Save"
│   "click the blue Submit button"
│   "click link number three"
│   "press Enter"
│   "double-click the file icon"
│   "right-click the image"
│
├── Modifiers:
│   "shift-click ..."  → hold Shift while clicking
│   "command-click ..." → hold Cmd/Ctrl while clicking

type / enter
├── "type hello world"
│   "enter my email address"  → uses stored profile data
│   "type capital H hello"
│   "press Tab then type jason"

select
├── "select all"
│   "select the last word"
│   "select from here to the end of the line"
│   "select the email field"

scroll
├── "scroll down"
│   "scroll up three times"
│   "scroll to the bottom"
│   "scroll left"

move / resize (windows)
├── "move this window to the left half"
│   "maximize this window"
│   "minimize Slack"
│   "close this window"
│   "switch to Chrome"
│   "next window"
│   "full screen"

navigate
├── "go back"       → browser back
│   "go forward"
│   "open new tab"
│   "close this tab"
│   "next tab"
│   "previous tab"
│   "go to address bar"

edit
├── "undo"
│   "redo"
│   "cut"  "copy"  "paste"
│   "bold"  "italic"  "underline"
│   "find and replace"
│   "save"  "save as"

system
├── "show desktop"
│   "open Spotlight" / "open Start menu"
│   "lock screen"
│   "take a screenshot"
│   "increase volume"
│   "mute"
```

### LLM-Assisted Command Parsing

For commands that don't match the built-in grammar, the local LLM interprets intent:

```
Prompt:
  You are an accessibility command parser. Given a voice command, extract:
  - action: click | type | select | scroll | move | resize | keyboard | navigate
  - target: UI element description or null
  - value: text to type, direction to scroll, window position, or key combination
  - repeat: number of times to repeat (default 1)
  
  Respond in JSON only.
  
  Command: "go to the search box and type machine learning papers from 2025"
  
  Response:
  [
    {"action": "click", "target": "search box", "value": null, "repeat": 1},
    {"action": "type", "target": null, "value": "machine learning papers from 2025", "repeat": 1}
  ]
```

This handles compound commands ("click X and then type Y"), ambiguous phrasing, and natural language variations that the rule-based parser misses.

---

## Element Targeting

### Numbered Hint Overlay

When the target is ambiguous or the user says "show links" / "show buttons," IronMic displays numbered overlays on matching elements:

```
┌──────────────────────────────────────────────────────────┐
│  Browser: Search Results                                  │
│                                                           │
│  [1] Getting Started with Rust Programming                │
│      https://doc.rust-lang.org ─── [2]                   │
│                                                           │
│  [3] The Rust Programming Language Book                   │
│      https://doc.rust-lang.org/book ─── [4]              │
│                                                           │
│  [5] Rust by Example                                      │
│      https://doc.rust-lang.org/rust-by-example ─── [6]   │
│                                                           │
│  [7] Next Page ►                                          │
│                                                           │
└──────────────────────────────────────────────────────────┘

User says: "three"
IronMic: Clicks link #3 ("The Rust Programming Language Book")
```

Implementation:
- Transparent always-on-top overlay window (Electron BrowserWindow with `transparent: true, alwaysOnTop: true, focusable: false`)
- Overlay receives element coordinates from Rust via IPC
- Each hint is a small badge positioned at the element's top-left corner
- Hints dismiss after action or after 10-second timeout
- User can say "cancel" or "dismiss" to close overlay

### Targeting Resolution Algorithm

```
resolve_target(description, element_cache):
  1. Exact label match:
     - Case-insensitive comparison against element labels
     - If single match → return it

  2. Fuzzy label match:
     - Levenshtein distance + token overlap against labels
     - If single match above 0.85 → return it
     - If multiple matches above 0.70 → show numbered overlay

  3. Role + label match:
     - "the Save button" → role: button, label contains "Save"
     - "the email field" → role: textField, label contains "email"
     - "the first link" → role: link, ordinal: 1

  4. Contextual match:
     - "the dropdown" → nearest comboBox/popUpButton to the focused element
     - "the next field" → next focusable element in tab order
     - "the checkbox" → nearest checkbox (by proximity to focus)

  5. LLM fallback:
     - Send element list + user description to LLM
     - LLM returns the most likely match
     - Show confirmation: "Did you mean [element label]?"

  6. No match:
     - "I couldn't find that element. Try 'show all buttons' to see what's available."
```

---

## Platform-Specific Accessibility APIs

### macOS (AXUIElement)

```rust
// accessibility/platform/macos.rs

use core_foundation::*;
use accessibility::*;  // objc2 bindings

pub fn get_focused_application() -> Result<AXUIElement> {
    // AXUIElementCreateSystemWide()
    // Get kAXFocusedApplicationAttribute → AXUIElement for the focused app
}

pub fn enumerate_elements(app: &AXUIElement) -> Result<Vec<UIElement>> {
    // Walk the accessibility tree recursively:
    // kAXChildrenAttribute → children
    // kAXRoleAttribute → "AXButton", "AXTextField", "AXLink", etc.
    // kAXTitleAttribute / kAXDescriptionAttribute → label
    // kAXPositionAttribute + kAXSizeAttribute → bounds
    // kAXEnabledAttribute → interactable
    // kAXFocusedAttribute → currently focused
    // Filter to visible elements only (bounds within screen)
}

pub fn perform_action(element: &AXUIElement, action: &str) -> Result<()> {
    // AXUIElementPerformAction(element, kAXPressAction)  → click
    // AXUIElementPerformAction(element, kAXShowMenuAction) → right-click
    // AXUIElementSetAttributeValue(element, kAXValueAttribute, text) → type
    // AXUIElementSetAttributeValue(element, kAXFocusedAttribute, true) → focus
}

pub fn simulate_keystroke(key: u16, modifiers: CGEventFlags) -> Result<()> {
    // CGEventCreateKeyboardEvent for key down/up
    // CGEventPost to kCGHIDEventTap
}

pub fn move_mouse(x: f64, y: f64) -> Result<()> {
    // CGEventCreateMouseEvent for mouse move
    // CGEventPost
}
```

**macOS permissions:** Requires Accessibility permission in System Settings > Privacy & Security > Accessibility. IronMic already needs this for global hotkey — same permission.

### Windows (UI Automation)

```rust
// accessibility/platform/windows.rs

use windows::Win32::UI::Accessibility::*;

pub fn get_focused_element() -> Result<IUIAutomationElement> {
    // CoCreateInstance(CUIAutomation)
    // automation.GetFocusedElement()
}

pub fn enumerate_elements(root: &IUIAutomationElement) -> Result<Vec<UIElement>> {
    // CreateTreeWalker with condition: IsEnabled + IsOffscreen=false
    // Walk tree: GetFirstChildElement, GetNextSiblingElement
    // CurrentName → label
    // CurrentControlType → role
    // CurrentBoundingRectangle → bounds
}

pub fn perform_action(element: &IUIAutomationElement, action: &str) -> Result<()> {
    // InvokePattern → click buttons
    // ValuePattern → set text field values
    // SelectionItemPattern → select dropdown items
    // ExpandCollapsePattern → open/close menus
    // ScrollPattern → scroll
}

pub fn simulate_keystroke(vk: u16, modifiers: u32) -> Result<()> {
    // SendInput with KEYBDINPUT
}
```

**Windows permissions:** UI Automation is available to all applications without special permissions. Keystroke simulation may be blocked by UAC for elevated windows.

### Linux (AT-SPI2)

```rust
// accessibility/platform/linux.rs

// AT-SPI2 via D-Bus (atspi crate or raw D-Bus calls)

pub fn enumerate_elements(app_name: &str) -> Result<Vec<UIElement>> {
    // Connect to org.a11y.Bus
    // Get accessible tree for target application
    // Walk children recursively
    // GetRole → role
    // GetName → label
    // GetExtents → bounds
}

pub fn perform_action(element_path: &str, action: &str) -> Result<()> {
    // org.a11y.atspi.Action.DoAction(index)
    // org.a11y.atspi.EditableText.InsertText for typing
}

pub fn simulate_keystroke(keycode: u32, modifiers: u32) -> Result<()> {
    // xdotool key / xdotool type (X11)
    // wtype (Wayland, if available)
    // Or: libxdo bindings
}
```

**Linux limitations:** AT-SPI2 support varies across desktop environments and toolkits. GTK apps have excellent support, Qt apps require `QT_ACCESSIBILITY=1`, and Electron apps expose a11y by default. Wayland compositors may restrict simulated input.

---

## Continuous Listening Mode

### Always-Listening with Wake Word

For hands-free operation, the accessibility layer supports a continuous listening mode where IronMic listens for a wake word before processing commands:

```
Modes:
  hotkey_mode (default):
    - User presses hotkey → speaks command → IronMic executes
    - Same as existing dictation flow
    - Lowest resource usage

  wake_word_mode:
    - IronMic listens for "Hey Iron" (configurable)
    - Wake word detected → listen for command (5s window)
    - Execute command → return to wake word listening
    - Uses VAD + lightweight keyword spotting (not full Whisper)
    - Resource usage: ~2% CPU for keyword spotting

  always_listening_mode:
    - Every speech segment is classified: dictation vs accessibility command
    - Commands execute immediately, dictation routes to editor/clipboard
    - Highest resource usage but most seamless experience
    - Requires high-accuracy intent classifier to avoid misfires
```

### Wake Word Detection

```
[Mic Audio Stream]
        │
        ▼
[VAD: Speech detected?]
        │
        ├── No → continue listening (no CPU cost)
        │
        ├── Yes ↓
        │
        ▼
[Keyword Spotter (tiny model, ~200KB)]
        │
        ├── "Hey Iron" detected (confidence > 0.90) ──→ [Activate: listen for command]
        │                                                        │
        │                                                   [5s command window]
        │                                                        │
        │                                                   [Whisper STT → CommandInterpreter]
        │                                                        │
        │                                                   [Execute → return to listening]
        │
        └── Not a wake word → discard, continue listening
```

The keyword spotter is a tiny CNN (~200KB) trained on the wake phrase. It runs on every VAD-detected speech segment but is orders of magnitude cheaper than full Whisper inference. Only when the wake word is detected does the system engage Whisper for the actual command.

---

## Database Schema

### New Tables

```sql
-- Accessibility command history (for analytics and learning)
CREATE TABLE a11y_commands (
    id TEXT PRIMARY KEY,                    -- UUID
    spoken_text TEXT NOT NULL,              -- What the user said
    parsed_action TEXT NOT NULL,            -- click | type | scroll | etc.
    parsed_target TEXT,                     -- Element description
    parsed_value TEXT,                      -- Typed text, scroll direction, etc.
    resolution_method TEXT,                 -- exact | fuzzy | numbered | llm
    element_role TEXT,                      -- button | textField | link | etc.
    element_label TEXT,                     -- Resolved element's label
    app_name TEXT,                          -- Which app was focused
    success INTEGER DEFAULT 1,             -- Did the command execute successfully?
    correction TEXT,                        -- User correction if command was wrong
    execution_time_ms REAL,                -- Total time from speech to action
    created_at TEXT NOT NULL
);
CREATE INDEX idx_a11y_commands_time ON a11y_commands(created_at);
CREATE INDEX idx_a11y_commands_action ON a11y_commands(parsed_action);

-- Custom voice shortcuts (user-defined command aliases)
CREATE TABLE a11y_shortcuts (
    id TEXT PRIMARY KEY,
    phrase TEXT NOT NULL UNIQUE,            -- "save it" / "nuke this" / "big text"
    action_json TEXT NOT NULL,             -- JSON: [{action, target, value, repeat}]
    app_filter TEXT,                       -- Optional: only active in specific apps
    is_enabled INTEGER DEFAULT 1,
    usage_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_a11y_shortcuts_phrase ON a11y_shortcuts(phrase);

-- Element targeting corrections (for learning better targeting)
CREATE TABLE a11y_corrections (
    id TEXT PRIMARY KEY,
    original_description TEXT NOT NULL,     -- What the user said
    original_match TEXT,                    -- What IronMic selected
    corrected_match TEXT NOT NULL,         -- What the user actually wanted
    app_name TEXT,
    element_role TEXT,
    created_at TEXT NOT NULL
);
```

### Settings

| Key | Default | Description |
|-----|---------|-------------|
| `a11y_enabled` | `false` | Master toggle for accessibility layer |
| `a11y_mode` | `hotkey` | `hotkey` / `wake_word` / `always_listening` |
| `a11y_wake_phrase` | `hey iron` | Wake word for wake_word_mode |
| `a11y_overlay_style` | `badge` | `badge` (numbered) / `border` (highlight) / `both` |
| `a11y_overlay_timeout_s` | `10` | Dismiss overlay after N seconds |
| `a11y_confirm_destructive` | `true` | Confirm before close/delete/shutdown commands |
| `a11y_feedback_voice` | `false` | Speak confirmation ("Clicked Save") via TTS |
| `a11y_feedback_toast` | `true` | Show toast notification on command execution |
| `a11y_tree_cache_ms` | `2000` | Refresh accessibility tree cache interval |
| `a11y_llm_fallback` | `true` | Use LLM for ambiguous command parsing |
| `a11y_command_history_days` | `30` | Retention for command history |
| `a11y_keyboard_echo` | `true` | Speak typed characters aloud (screen reader mode) |

---

## Integration with Existing Systems

### Intent Classifier (existing)

The intent classifier gains a new category: `accessibility_command`. Training data includes:
- Positive: "click Save", "scroll down", "switch to Chrome", "select all", "type hello"
- Negative: dictation that mentions UI elements ("I clicked the button yesterday" is dictation, not a command)

The classifier must distinguish between:
- Dictation: "and then I clicked the Save button" → transcribe as text
- Command: "click the Save button" → execute the action

Context signals that help: recording mode (dictation page vs command mode), sentence structure (imperative vs narrative), and the `a11y_mode` setting.

### Voice Router (existing)

The voice router adds a new route: `accessibility`. When the router detects an accessibility command, it bypasses the dictation pipeline and routes directly to the `CommandInterpreter`.

```
[VoiceRouter]
  ├── dictation       → clipboard / editor (existing)
  ├── command         → intent classifier (existing)
  ├── conversation    → AI chat (existing)
  └── accessibility   → CommandInterpreter → AccessibilityEngine (NEW)
```

### Ambient Context Engine (planned)

The context engine's window detection feeds directly into the accessibility layer. When the user says "click Save," the accessibility layer already knows which application is focused and only searches that application's accessibility tree. No redundant window detection.

### TTS Read-Back (existing)

When `a11y_feedback_voice` is enabled, command confirmations are spoken aloud via the existing Kokoro TTS engine. This creates a screen-reader-like experience for visually impaired users: "Clicked Save button. File saved."

### Custom Dictionary (existing)

UI element labels from frequently-used applications are added to the Whisper vocabulary boost. If the user's app has buttons like "Deploy," "Terraform," or "Kubernetes," those labels are boosted to improve transcription accuracy for accessibility commands.

---

## Privacy Considerations

- **Accessibility tree data is ephemeral.** The tree is queried, used for element targeting, then discarded from memory. Element labels and roles are never persisted to disk (except for the optional command history, which stores only the matched element label, not the full tree).
- **No screen capture.** The accessibility layer reads the accessibility tree (text metadata), never pixels. No screenshots, no screen recording, no OCR.
- **Command history is optional.** Users can disable `a11y_command_history_days` (set to 0) to prevent any command logging.
- **Wake word processing is local.** The keyword spotter runs entirely in the renderer process. Audio segments that don't match the wake word are discarded without Whisper processing.
- **No new network access.** All accessibility APIs are local OS APIs. The LLM fallback for command parsing uses the same local llama.cpp instance. No data leaves the device.
- **Keystroke simulation security.** Simulated keystrokes and clicks are subject to OS security policies (macOS Accessibility permission, Windows UAC). IronMic cannot interact with elevated/admin processes unless explicitly permitted by the OS.

---

## Implementation Phases

### Phase 1: Platform Accessibility Bridge
- Implement macOS AXUIElement tree enumeration (focused app only)
- Abstract UI element type: role, label, bounds, enabled, focused
- N-API exports: `getAccessibilityTree()`, `getfocusedElement()`
- Basic element targeting: exact label match for buttons
- Simulate click via AXPerformAction
- **Deliverable:** Say "click Save" and IronMic clicks the Save button in the focused app (macOS only)

### Phase 2: Keyboard and Window Management
- Implement keystroke simulation (CGEvent on macOS)
- Built-in command grammar: type, undo, redo, copy, paste, select all, save
- Window management: switch app, minimize, maximize, move to half-screen
- Keyboard shortcut invocation by voice
- **Deliverable:** Full keyboard and window control by voice (macOS)

### Phase 3: Smart Element Targeting
- Fuzzy label matching with Levenshtein distance
- Role-aware targeting: "the button" vs "the link" vs "the field"
- Ordinal targeting: "the third link," "the second button"
- Numbered hint overlay for disambiguation
- LLM fallback for ambiguous descriptions
- **Deliverable:** Natural language element targeting with visual feedback

### Phase 4: Windows and Linux Support
- Implement Windows UI Automation backend
- Implement Linux AT-SPI2 backend
- Keystroke simulation on each platform (SendInput, xdotool)
- Platform-specific testing and edge case handling
- **Deliverable:** Cross-platform accessibility layer

### Phase 5: Continuous Listening and Wake Word
- Wake word detection with lightweight keyword spotter CNN
- Always-listening mode with intent classification
- Custom voice shortcuts (user-defined command aliases)
- Command history analytics
- Audible feedback via TTS
- **Deliverable:** Hands-free computer operation without pressing any hotkey

### Phase 6: Form Filling and Advanced Interaction
- Tab order navigation: "next field," "previous field"
- Dropdown/combobox interaction: "select X from the dropdown"
- Checkbox/radio: "check the Remember Me box," "select Option B"
- Scroll control: directional, per-page, to-top, to-bottom
- Text selection: "select the last paragraph," "select word"
- Grid-based cursor positioning for pixel-precise targeting
- **Deliverable:** Complete form filling and complex UI interaction by voice

---

## Performance Considerations

| Operation | Time | Notes |
|-----------|------|-------|
| Accessibility tree enumeration (50 elements) | ~15ms macOS, ~20ms Windows, ~30ms Linux | Platform API call + tree walk |
| Accessibility tree enumeration (500 elements) | ~80ms macOS, ~120ms Windows, ~200ms Linux | Larger apps (browsers, IDEs) |
| Element targeting (exact label match) | <1ms | String comparison |
| Element targeting (fuzzy match, 200 elements) | ~5ms | Levenshtein + scoring |
| Element targeting (LLM fallback) | 1-3s | Local LLM inference |
| Simulate click (platform action) | <5ms | OS API call |
| Simulate keystroke | <2ms | OS API call |
| Numbered overlay render | ~10ms | Electron overlay window update |
| Wake word detection (per speech segment) | ~5ms | Tiny CNN inference |
| Command parse (rule-based) | <2ms | Grammar matching |
| Command parse (LLM) | 1-3s | Local LLM inference |
| Full command pipeline (speech → action) | ~2.5s | Dominated by Whisper STT |

### Memory

- Accessibility tree cache: ~1-5MB (depending on app complexity)
- Wake word model: ~200KB
- Command grammar tables: ~50KB
- Overlay window: ~5MB (Electron renderer)

---

## N-API Surface Additions

```typescript
// --- Accessibility Tree ---
getAccessibilityTree(appName?: string): Promise<string>     // JSON: UIElement[]
getFocusedElement(): Promise<string>                         // JSON: UIElement | null
findElements(role?: string, labelContains?: string): Promise<string>  // JSON: UIElement[]

// --- Actions ---
clickElement(elementId: string): Promise<void>
doubleClickElement(elementId: string): Promise<void>
rightClickElement(elementId: string): Promise<void>
typeText(text: string): Promise<void>
typeKeystroke(key: string, modifiers: string[]): Promise<void>   // key: "a", modifiers: ["cmd"]
setElementValue(elementId: string, value: string): Promise<void>
focusElement(elementId: string): Promise<void>

// --- Mouse ---
moveMouse(x: number, y: number): Promise<void>
clickAt(x: number, y: number, button: string): Promise<void>  // button: "left" | "right"
scrollDirection(direction: string, amount: number): Promise<void>

// --- Window Management ---
focusApplication(appName: string): Promise<void>
moveWindow(position: string): Promise<void>           // "left_half" | "right_half" | "maximize" | etc.
minimizeWindow(): Promise<void>
closeWindow(): Promise<void>

// --- Shortcuts ---
createShortcut(phrase: string, actionJson: string, appFilter?: string): Promise<string>
deleteShortcut(id: string): Promise<void>
listShortcuts(): Promise<string>                        // JSON

// --- Command History ---
logCommand(commandJson: string): Promise<void>
getCommandHistory(limit: number, offset: number): Promise<string>
getCommandStats(): Promise<string>                      // JSON: most used commands, success rate
```

---

## New Files

### Rust Core

| File | Purpose |
|------|---------|
| `rust-core/src/accessibility/mod.rs` | Module exports |
| `rust-core/src/accessibility/tree.rs` | Accessibility tree enumeration and caching |
| `rust-core/src/accessibility/element.rs` | UIElement abstraction type |
| `rust-core/src/accessibility/actions.rs` | Click, type, scroll, drag simulation |
| `rust-core/src/accessibility/targeting.rs` | Voice description → element resolution |
| `rust-core/src/accessibility/overlay.rs` | Compute overlay positions for hint badges |
| `rust-core/src/accessibility/keyboard_sim.rs` | Cross-platform keystroke simulation |
| `rust-core/src/accessibility/mouse_sim.rs` | Cross-platform mouse simulation |
| `rust-core/src/accessibility/window_manager.rs` | Window move/resize/focus |
| `rust-core/src/accessibility/platform/mod.rs` | Platform module exports |
| `rust-core/src/accessibility/platform/macos.rs` | macOS AXUIElement API |
| `rust-core/src/accessibility/platform/windows.rs` | Windows UI Automation |
| `rust-core/src/accessibility/platform/linux.rs` | Linux AT-SPI2 |
| `rust-core/src/storage/accessibility.rs` | Command history, shortcuts CRUD |

### Electron App

| File | Purpose |
|------|---------|
| `electron-app/src/renderer/components/accessibility/AccessibilityPage.tsx` | Main config page |
| `electron-app/src/renderer/components/accessibility/VoiceNavigator.tsx` | Command palette element picker |
| `electron-app/src/renderer/components/accessibility/ElementOverlay.tsx` | Numbered hint overlay |
| `electron-app/src/renderer/components/accessibility/CommandFeedback.tsx` | Command result toast |
| `electron-app/src/renderer/components/accessibility/CursorGrid.tsx` | Grid overlay for cursor control |
| `electron-app/src/renderer/components/accessibility/AccessibilityHistory.tsx` | Command log view |
| `electron-app/src/renderer/components/accessibility/CommandCheatSheet.tsx` | Quick reference |
| `electron-app/src/renderer/components/settings/AccessibilitySettings.tsx` | Feature toggles |
| `electron-app/src/renderer/stores/useAccessibilityStore.ts` | Accessibility state |
| `electron-app/src/renderer/services/AccessibilityEngine.ts` | Command orchestration |
| `electron-app/src/renderer/services/CommandInterpreter.ts` | NLU for commands |
| `electron-app/src/renderer/services/ElementResolver.ts` | Element matching |
| `electron-app/src/renderer/services/OverlayRenderer.ts` | Overlay management |

### Files to Modify

| File | Change |
|------|--------|
| `rust-core/src/lib.rs` | Add N-API exports for accessibility functions |
| `rust-core/src/storage/db.rs` | Add migration for a11y tables |
| `rust-core/Cargo.toml` | Add platform-specific accessibility crate deps |
| `electron-app/src/main/ipc-handlers.ts` | Wire accessibility IPC channels |
| `electron-app/src/preload/index.ts` | Expose accessibility API to renderer |
| `electron-app/src/renderer/components/Layout.tsx` | Add overlay container |
| `electron-app/src/renderer/components/SettingsPanel.tsx` | Add accessibility settings section |
| `electron-app/src/renderer/services/tfjs/VoiceRouter.ts` | Add accessibility route |
| `electron-app/src/renderer/services/tfjs/IntentClassifier.ts` | Add accessibility_command intent |

---

## Open Questions

1. **Accessibility permission UX.** On macOS, IronMic needs Accessibility permission (System Settings > Privacy > Accessibility). This is the same permission needed for global hotkeys, but some users may not have granted it yet. Should IronMic detect the missing permission and show an in-app guide with a deep link to the System Settings pane?

2. **Command confirmation for destructive actions.** "Close this window" and "delete this file" are destructive. The `a11y_confirm_destructive` setting adds a confirmation step, but this breaks the hands-free flow. Should destructive commands require a different confirmation mechanism (e.g., "close window — say 'confirm' to proceed")?

3. **Interaction with screen readers.** If the user is already running VoiceOver (macOS), NVDA (Windows), or Orca (Linux), IronMic's accessibility layer may conflict. Should IronMic detect active screen readers and adjust behavior, or should users choose one or the other?

4. **Complex web applications.** Modern web apps (React, Angular) often have poor accessibility tree coverage. Shadow DOM, custom components, and canvas-based UIs may not expose elements to AT APIs. Should IronMic fall back to OCR/vision for elements not in the accessibility tree, or accept the limitation?

5. **Typing mode latency.** When the user says "type hello world," there's a 2-second Whisper processing delay before the text appears. For rapid typing, this feels sluggish. Should there be a dedicated "typing mode" that uses a faster, smaller Whisper model (tiny/base) for lower latency at the cost of accuracy?

6. **Multi-monitor element targeting.** With multiple monitors, the accessibility tree spans all screens. When the user says "click Submit," should IronMic only search elements on the monitor where the focused window is, or all monitors? What about elements in background windows?

7. **Gaming and creative apps.** Applications like Photoshop, Blender, and games use custom rendering that bypasses the OS accessibility tree. These apps are effectively invisible to AT APIs. Should IronMic offer a "screen grid" mode for these apps (divide the screen into numbered zones for cursor positioning), or is this out of scope?

---

## Dependencies

| Dependency | Already in project? | Purpose |
|-----------|---------------------|---------|
| `accessibility` / `objc2` | **Check macOS deps** | macOS AXUIElement API bindings |
| `windows` crate | **Check Windows deps** | Windows UI Automation bindings |
| `atspi` or `zbus` | **No — needs adding** | Linux AT-SPI2 via D-Bus |
| `core-graphics` | **Check macOS deps** | macOS CGEvent for keystroke/mouse simulation |
| `strsim` | **No — needs adding** | String similarity for fuzzy element matching |
| `ort` (ONNX Runtime) | Yes | Wake word keyword spotter model |
| LLM (llama.cpp) | Yes | Command parsing fallback |
| TTS (Kokoro) | Yes | Audible feedback |

Two to three new Rust crates depending on platform. The keyword spotter model (~200KB ONNX) is a new model asset but runs on the existing ONNX Runtime.

---

## Success Metrics

- Element targeting accuracy: >90% of "click X" commands resolve to the correct element on first try
- Command recognition: >95% of built-in commands (scroll, save, undo, switch app) execute correctly
- End-to-end latency: <3 seconds from speech onset to action execution (hotkey mode)
- Wake word accuracy: >98% true positive, <1% false positive for "Hey Iron"
- Cross-platform coverage: >80% of common desktop apps have usable accessibility trees on each platform
- User adoption: >40% of users with motor accessibility needs report IronMic as their primary voice control tool
- Command success rate: >85% of all accessibility commands execute without user correction
- Form filling: >80% of standard web forms can be completed entirely by voice
