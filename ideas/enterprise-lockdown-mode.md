# Enterprise Lockdown Mode

## Overview

Introduce a deployment configuration layer that lets IT/security teams restrict IronMic's feature surface to only personal dictation workflows, disabling anything that could record other people, accumulate organizational intelligence, or create compliance exposure. The result: a tool that enterprise security teams can approve in days instead of months, because the risk profile is equivalent to a local text editor with a microphone.

The core value proposition to enterprises is simple: "Your employees get a 10x productivity tool for personal note-taking and dictation. It never touches the network. And we've already disabled everything your legal team would flag."

---

## The Problem

Enterprise security and legal teams evaluate tools against a checklist of risks. IronMic's fully-local architecture already eliminates the biggest ones (data exfiltration, cloud dependency, third-party data processing). But several features in the v1.1.0 ML layer introduce new categories of risk that have nothing to do with network access:

- **Meeting recording** captures other people's voices without clear consent workflows
- **Speaker separation** creates biometric voiceprints, triggering BIPA/GDPR biometric data rules
- **Organizational voice intelligence** aggregates communication patterns across an org
- **Ambient context engine** implies always-listening behavior
- **Communication analytics** profiles how employees communicate
- **Action logging and workflow mining** tracks user behavior patterns over time

Even though all of this is local, enterprise legal teams don't distinguish between "we sent your data to the cloud" and "we built a local behavioral profile of your employees." Both are liabilities.

---

## What Enterprise Lockdown Mode Does

A single configuration file (`ironmic-policy.json`) deployed alongside the app or pushed via MDM (Jamf, Intune, SCCM) that enforces hard restrictions. The app reads this file at startup and disables features at the code level, not just the UI level. Locked features cannot be re-enabled by the user.

### Tier 1: Personal Dictation Only (Maximum Lockdown)

This is the "approve it tomorrow" configuration. The app is functionally a local speech-to-text tool with an optional LLM polish step.

**Enabled:**
- Push-to-talk dictation (user explicitly presses hotkey to start/stop)
- Whisper transcription of user's own speech
- LLM text cleanup (optional, configurable)
- Clipboard copy
- Personal note editor
- Timeline of user's own dictations
- Full-text search across own entries
- Custom dictionary
- SQLite storage (user's own app data directory)

**Disabled and locked:**
- Meeting mode / ambient recording
- Speaker separation / voice identity
- Always-listening / auto-detect turn mode (only push-to-talk allowed)
- VAD training sample collection
- Action logging / workflow mining
- Notification intelligence
- Semantic search embeddings
- Voice routing
- Intent classification
- Any feature that records, profiles, or analyzes beyond the single active dictation

**Why this works for enterprises:**
- No biometric data collection (no voiceprints, no speaker ID)
- No behavioral profiling (no action logs, no workflow patterns)
- No ambient capture (push-to-talk only, user has full control)
- No multi-person recording (designed for single-user dictation)
- Data footprint is just text entries the user explicitly created
- User can delete all their data at any time

### Tier 2: Enhanced Personal (Moderate Lockdown)

For organizations comfortable with on-device ML but not with recording other people.

**Additionally enabled (on top of Tier 1):**
- VAD for smarter push-to-talk (detect speech end, auto-stop)
- Semantic search across own entries
- Basic intent classification for voice commands ("save this", "copy that")
- Turn detection in auto-detect mode (but single-user only)

**Still disabled:**
- Meeting mode
- Speaker separation
- Action logging / workflow mining
- Communication analytics
- Ambient listening

### Tier 3: Full Features (No Lockdown)

Everything enabled. For organizations that have done their own risk assessment or for individual users.

---

## Policy File Format

```json
{
  "ironmic_policy": {
    "version": 1,
    "tier": "personal-dictation-only",
    "enforced_by": "IT Security Team",
    "contact": "security@company.com",
    "applied_at": "2026-04-15T00:00:00Z",

    "overrides": {
      "vad_enabled": true,
      "vad_sensitivity": 0.5,
      "turn_detection_mode": "push-to-talk",
      "meeting_mode_enabled": false,
      "voice_routing_enabled": false,
      "intent_classification_enabled": false,
      "ml_notifications_enabled": false,
      "ml_workflows_enabled": false,
      "ml_semantic_search_enabled": false
    },

    "locked_settings": [
      "turn_detection_mode",
      "meeting_mode_enabled",
      "voice_routing_enabled",
      "intent_classification_enabled",
      "ml_notifications_enabled",
      "ml_workflows_enabled",
      "ml_semantic_search_enabled"
    ],

    "data_retention": {
      "max_entry_age_days": 90,
      "auto_purge": true
    },

    "audit": {
      "log_policy_load": true,
      "log_feature_access_denied": true
    }
  }
}
```

---

## Policy Enforcement Architecture

```
App Startup
    │
    ├── Check well-known paths for ironmic-policy.json
    │   ├── /etc/ironmic/policy.json (Linux)
    │   ├── /Library/Application Support/IronMic/policy.json (macOS)
    │   └── C:\ProgramData\IronMic\policy.json (Windows)
    │
    ├── If found: parse, validate, apply overrides to settings
    │   ├── Override values written to settings table
    │   ├── Locked settings flagged in-memory (cannot be changed via UI or API)
    │   └── Policy hash stored to detect tampering
    │
    ├── If NOT found: check user-level policy path
    │   └── ~/.config/ironmic/policy.json (for self-managed users)
    │
    └── If no policy: all features available (Tier 3)

Settings Panel (Renderer)
    │
    ├── On render: check locked_settings list
    │   ├── Locked settings shown as disabled with lock icon
    │   └── Tooltip: "Managed by your organization (contact: security@company.com)"
    │
    └── On change attempt for locked setting: blocked, toast notification shown
```

The enforcement happens at three levels:
1. **Settings layer:** Locked values cannot be overwritten via `setSetting()`
2. **API layer:** N-API functions for disabled features return early with a policy error
3. **UI layer:** Controls are visually disabled with explanation

This defense-in-depth means a user can't bypass restrictions by calling the Rust API directly through dev tools.

---

## MDM / Mass Deployment

### macOS (Jamf / Mosyle)
- Policy file deployed to `/Library/Application Support/IronMic/policy.json` via configuration profile
- File owned by root, read-only for user
- Jamf script validates policy hash on check-in

### Windows (Intune / SCCM)
- Policy file deployed to `C:\ProgramData\IronMic\policy.json` via Win32 app or PowerShell script
- ACL set to read-only for standard users
- Intune compliance policy checks for file existence

### Linux (Ansible / Chef)
- Policy file deployed to `/etc/ironmic/policy.json`
- Standard file permissions (root:root, 644)

---

## Data Retention Controls

Enterprise lockdown adds automatic data lifecycle management:

- **Max entry age:** Entries older than N days are auto-purged (default 90 days in Tier 1)
- **Max storage size:** SQLite DB capped at N MB, oldest entries pruned first
- **Export restrictions:** Bulk export can be disabled (prevents data hoarding)
- **Delete all:** One-click "Delete all my IronMic data" always available, never locked

This addresses the "what if an employee leaves?" question. With 90-day retention, there's no years-old data accumulation to worry about.

---

## Compliance Mapping

| Regulation | Risk | How Lockdown Addresses It |
|---|---|---|
| GDPR Art. 9 (Biometric data) | Voiceprints are biometric | Speaker separation disabled, no voice identity |
| BIPA (Illinois) | Biometric identifiers | No voiceprint creation or storage |
| CCPA/CPRA | Personal information collection | Only user-created text, auto-purged, deletable |
| HIPAA | PHI in transcriptions | Local-only storage, no network, auto-retention |
| SOC 2 | Data access controls | Policy-enforced feature restrictions, audit log |
| FERPA | Student records | No ambient recording, push-to-talk only |
| GDPR Art. 22 (Automated decisions) | Behavioral profiling | Action logging and workflow mining disabled |

---

## What the Enterprise Sales Pitch Looks Like

> "IronMic is a local-only voice-to-text tool. Nothing leaves the device. No cloud, no telemetry, no network calls.
>
> For enterprise deployments, we offer a lockdown mode that restricts the app to personal dictation only. No meeting recording, no voice biometrics, no behavioral tracking. Your employees get a fast, accurate dictation tool. Your security team gets a risk profile equivalent to Notepad with a microphone.
>
> Deploy the policy file via Jamf/Intune/Ansible. Done.
>
> If your security team wants to review the code, it's open source. If they want to build it themselves, the build is reproducible."

---

## Implementation Scope

### Rust Core Changes
- `PolicyEngine` module: load, validate, and enforce policy files
- Settings store: add `is_locked(key)` check, reject writes to locked keys
- Each N-API function for lockable features: early-return with policy error if disabled
- Data retention: background task that prunes entries on schedule

### Electron Changes
- Main process: load policy on startup, pass locked-settings list to renderer
- Settings panel: visually lock managed settings
- New "Managed by your organization" banner when policy is active
- Audit log viewer (optional, for IT admins reviewing local logs)

### New Files
- Policy JSON schema definition
- MDM deployment templates (Jamf plist, Intune PowerShell, Ansible playbook)
- Compliance documentation for each supported regulation

### Estimated Model Size Impact
None. This is configuration, not new models. In Tier 1 lockdown, bundled ML models (VAD, intent, USE) are never loaded, reducing memory footprint to just Whisper + optional LLM.

---

## Open Questions

1. **Should policy files be signed?** A cryptographic signature would prevent users from editing the policy file to unlock features. Adds complexity but stronger enforcement for high-security environments.

2. **Should there be a "policy active" indicator in the UI?** Transparency is good, but some orgs prefer invisible enforcement. Make it configurable in the policy itself.

3. **Per-user policy overrides?** Some orgs might want most users on Tier 1 but allow specific teams (e.g., legal, executive assistants) on Tier 2. This requires a policy-of-policies or integration with directory services.

4. **Audit log format?** Should lockdown produce audit logs in a standard format (CEF, JSON lines) that enterprise SIEM tools can ingest?

5. **Can Tier 1 lockdown strip the ML models from the installer entirely?** A "lite" build without the 41MB ML bundle would be a smaller install and eliminate any question about what the models could theoretically do.
