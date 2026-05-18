# Voice Fingerprint Security

## Overview

Add biometric voice authentication to IronMic so the application can verify the identity of the person speaking before transcribing, unlocking, or accessing sensitive notes. IronMic learns your voiceprint during a one-time enrollment and continuously verifies that the person dictating is authorized. If an unrecognized voice is detected, transcription is blocked and the session locks.

This builds directly on top of the planned speaker separation work (ECAPA-TDNN / d-vector model, voice enrollment flow, embedding pipeline). The speaker verification model and enrollment infrastructure are the same — this feature adds an authentication gate, anti-spoofing layer, multi-user profile support, and enterprise provisioning.

Everything runs locally. Voice embeddings are mathematical vectors stored in SQLite — no audio recordings, no biometric data leaving the device.

---

## What This Enables

- **Shared workstation security**: In a call center or hospital, multiple people use the same machine. Only authorized users can dictate. IronMic locks itself when an unrecognized voice speaks.
- **Sensitive dictation protection**: A lawyer dictating privileged client notes knows that if a colleague walks up and speaks into the mic, nothing is transcribed or stored.
- **Automatic profile switching**: In a household or shared office, IronMic detects who is speaking and switches to that user's notes, settings, and dictionary. "Good morning" from User A opens their workspace; from User B, theirs.
- **Session lock on voice change**: Mid-dictation, if the voice changes (someone else starts speaking), IronMic pauses and requires re-verification before continuing.
- **Enterprise compliance**: Regulated industries (healthcare, legal, finance) can demonstrate that transcription access is gated by biometric verification, satisfying audit requirements.

---

## Architecture

### Speaker Verification vs Speaker Identification

Two distinct problems:

| | Speaker Verification | Speaker Identification |
|---|---|---|
| Question | "Is this person who they claim to be?" | "Which person is this?" |
| Comparison | 1-to-1 (claimed identity vs stored print) | 1-to-N (unknown voice vs all enrolled prints) |
| Use case | Session unlock, dictation gate | Auto profile switching |
| Speed | O(1) — single comparison | O(N) — compare against all profiles |
| Threshold | Tunable per-user | Global threshold |

IronMic needs both. Verification is the primary security gate. Identification enables convenience features (auto profile switching). Both use the same embedding model.

### New Components

```
Rust Core
├── speaker/
│   ├── mod.rs                  # (existing, extended)
│   ├── embedder.rs             # (existing) ECAPA-TDNN ONNX model
│   ├── verifier.rs             # NEW: 1-to-1 speaker verification
│   ├── identifier.rs           # NEW: 1-to-N speaker identification
│   ├── anti_spoof.rs           # NEW: Replay detection, liveness checks
│   ├── enrollment.rs           # (existing, extended with auth enrollment)
│   └── auth_manager.rs         # NEW: Session auth state machine, lock/unlock
│
├── storage/
│   ├── voice_auth.rs           # NEW: Auth profiles, session logs, provisioning
│   └── speakers.rs             # (existing, extended)

Electron App
├── renderer/
│   ├── components/
│   │   ├── VoiceAuthGate.tsx          # NEW: Lock screen with voice verification
│   │   ├── VoiceAuthSetup.tsx         # NEW: Guided enrollment for auth
│   │   ├── VoiceAuthStatus.tsx        # NEW: Indicator showing auth state
│   │   ├── MultiUserSwitcher.tsx      # NEW: Profile switch UI
│   │   ├── PinFallback.tsx            # NEW: PIN/password fallback dialog
│   │   └── EnterpriseProvision.tsx    # NEW: Bulk user provisioning UI
│   ├── stores/
│   │   └── useAuthStore.ts            # NEW: Auth state management
│   └── services/
│       └── VoiceAuthService.ts        # NEW: Orchestrates verification flow
```

### Data Flow: Dictation with Voice Auth

```
[User presses hotkey to dictate]
        │
        ▼
[1. Capture first 2 seconds of audio]
        │
        ▼
[2. Extract speaker embedding (ECAPA-TDNN, ~50ms)]
        │
        ▼
[3. Voice Verification]
        │
        ├── Cosine similarity > auth_threshold (0.80) ──→ PASS
        │       │
        │       ▼
        │   [4a. Anti-Spoof Check]
        │       │
        │       ├── Liveness OK ──→ [5. Proceed with transcription]
        │       │                        │
        │       │                   [6. Continuous re-verification every 15s]
        │       │                        │
        │       │                        ├── Still same speaker ──→ Continue
        │       │                        └── Different speaker ──→ Pause + Lock
        │       │
        │       └── Liveness FAIL ──→ [Block: "Replay detected"]
        │
        ├── Similarity 0.60-0.80 ──→ [4b. Low confidence]
        │       │
        │       ├── Prompt for PIN fallback
        │       └── If PIN correct → proceed + update voice print
        │
        └── Similarity < 0.60 ──→ [4c. REJECT]
                │
                ├── Session locks
                ├── Show "Voice not recognized"
                └── Offer PIN/password fallback
```

### Session Auth State Machine

```
                    ┌──────────────────┐
                    │     LOCKED       │ ← App launch / timeout / voice change
                    │  (no access)     │
                    └────────┬─────────┘
                             │
                    Voice verified OR PIN entered
                             │
                    ┌────────▼─────────┐
                    │   AUTHENTICATED  │ ← Normal operation
                    │   (full access)  │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
        Voice change    Timeout (5min)   Manual lock
              │              │              │
              ▼              ▼              ▼
        ┌─────────────────────────────────────┐
        │           CHALLENGED               │ ← Re-verify required
        │  (read-only, no new dictation)     │
        └─────────────┬──────────────────────┘
                      │
             Verify within 30s → AUTHENTICATED
             Fail → LOCKED
```

---

## Anti-Spoofing

### Replay Attack Detection

An attacker could record the authorized user's voice and play it back through speakers to fool the system.

**Countermeasures:**

1. **Spectral analysis**: Replayed audio through speakers has characteristic frequency roll-off above 8kHz and room reverb patterns that differ from direct microphone input. A simple binary classifier on the mel spectrogram can detect this.

2. **Channel consistency checking**: The enrollment microphone's spectral signature is stored. If verification audio comes through a significantly different channel (speaker playback vs direct mic), flag it.

3. **Challenge-response (optional, high-security mode)**: IronMic displays a random short phrase. The user must speak it. The system verifies both the voice identity AND the content matches. A replay attack cannot predict the challenge phrase.

```
Anti-Spoof Pipeline:

[Audio Segment]
      │
      ├──→ [Spectral Flatness Analysis]  ──→ Score (0-1)
      │         Higher flatness = more likely replayed
      │
      ├──→ [High-Frequency Energy Ratio] ──→ Score (0-1)
      │         Low HF energy = likely speaker playback
      │
      ├──→ [Reverb Estimation (RT60)]    ──→ Score (0-1)
      │         Unusual reverb = possible playback
      │
      └──→ [Channel Fingerprint Match]   ──→ Score (0-1)
                Compare to enrollment mic signature

[Weighted Average] ──→ Liveness Score
      │
      ├── > 0.70 ──→ LIVE (proceed)
      ├── 0.40-0.70 ──→ UNCERTAIN (require PIN)
      └── < 0.40 ──→ REPLAY DETECTED (block + alert)
```

**Implementation**: These are signal-processing heuristics, not ML models. They add ~10ms of processing time. The spectral flatness, HF energy ratio, and RT60 estimation are all computed from the same FFT that produces the mel spectrogram — no extra audio analysis pass needed.

### Liveness Detection

Beyond replay detection, ensure the audio is from a live human:

- **Breathing patterns**: Natural speech has micro-pauses and breath sounds. Synthesized or replayed audio may lack these.
- **Micro-variations**: Human voice has natural pitch and amplitude variations frame-to-frame. Perfectly consistent audio is suspicious.
- **Environmental consistency**: The background noise profile should be consistent with the enrolled environment. A sudden shift (anechoic playback in a normally noisy room) is a red flag.

---

## Database Schema

### New Tables

```sql
-- Voice authentication profiles
CREATE TABLE voice_auth_profiles (
    id TEXT PRIMARY KEY,                    -- UUID
    speaker_id TEXT NOT NULL REFERENCES speakers(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,             -- Profile display name
    pin_hash TEXT,                          -- bcrypt hash of fallback PIN (null if not set)
    auth_threshold REAL DEFAULT 0.80,       -- Per-user verification threshold
    anti_spoof_enabled INTEGER DEFAULT 1,   -- Enable replay detection
    challenge_response_enabled INTEGER DEFAULT 0, -- Require phrase challenge
    enrollment_quality TEXT,                -- 'good' | 'fair' | 'needs_improvement'
    enrollment_mic_fingerprint BLOB,        -- Spectral signature of enrollment mic
    max_session_duration_minutes INTEGER DEFAULT 480,  -- Auto-lock after N minutes
    idle_lock_minutes INTEGER DEFAULT 5,    -- Lock after N minutes of no speech
    is_active INTEGER DEFAULT 1,            -- Admin can deactivate
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_verified_at TEXT,                  -- Most recent successful verification
    failed_attempts INTEGER DEFAULT 0,      -- Consecutive failed attempts
    locked_until TEXT                       -- Temporary lockout after too many failures
);
CREATE INDEX idx_voice_auth_speaker ON voice_auth_profiles(speaker_id);

-- Authentication session log (audit trail)
CREATE TABLE voice_auth_sessions (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES voice_auth_profiles(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    end_reason TEXT,                        -- 'manual_lock' | 'timeout' | 'voice_change' | 'app_close'
    verification_method TEXT NOT NULL,      -- 'voice' | 'pin' | 'voice+challenge'
    verification_confidence REAL,           -- Cosine similarity score
    anti_spoof_score REAL,                 -- Liveness score
    continuous_checks INTEGER DEFAULT 0,    -- Number of re-verifications during session
    continuous_failures INTEGER DEFAULT 0   -- Re-verification failures (voice changed)
);
CREATE INDEX idx_auth_sessions_profile ON voice_auth_sessions(profile_id);
CREATE INDEX idx_auth_sessions_time ON voice_auth_sessions(started_at);

-- Failed authentication attempts (security monitoring)
CREATE TABLE voice_auth_failures (
    id TEXT PRIMARY KEY,
    profile_id TEXT,                        -- null if unknown voice (no profile match)
    attempted_at TEXT NOT NULL,
    failure_reason TEXT NOT NULL,           -- 'voice_mismatch' | 'replay_detected' | 'pin_wrong' | 'lockout'
    similarity_score REAL,                 -- What the cosine similarity was
    liveness_score REAL                    -- Anti-spoof score
);
CREATE INDEX idx_auth_failures_time ON voice_auth_failures(attempted_at);

-- Enterprise provisioning (optional)
CREATE TABLE voice_auth_provisioning (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES voice_auth_profiles(id) ON DELETE CASCADE,
    provisioned_by TEXT,                   -- Admin name/ID who set this up
    provisioned_at TEXT NOT NULL,
    policy_json TEXT,                       -- Enterprise policy overrides (JSON)
    -- e.g., {"min_threshold": 0.85, "require_pin": true, "max_idle_minutes": 3}
    revoked_at TEXT                         -- null if still active
);
```

### Relationships

```
speakers 1 ←→ 1 voice_auth_profiles     (one speaker = one auth profile)
voice_auth_profiles 1 ←→ N voice_auth_sessions   (auth history)
voice_auth_profiles 1 ←→ N voice_auth_failures    (failed attempts)
voice_auth_profiles 1 ←→ 1 voice_auth_provisioning (enterprise policy)
```

---

## Enrollment Flow for Authentication

### Differences from Speaker Separation Enrollment

The speaker separation enrollment captures enough voice to identify you in a group. Authentication enrollment requires a higher bar:

| Aspect | Speaker Separation | Voice Auth |
|--------|-------------------|------------|
| Samples | 3-5 sentences (~30s) | 5-8 sentences (~60s) |
| Quality threshold | SNR > 10dB | SNR > 15dB |
| Microphone | Any | Records mic fingerprint |
| Re-enrollment | Optional | Required if mic changes |
| Phoneme coverage | Basic | Comprehensive (all vowels, common consonants) |
| Anti-spoof baseline | Not needed | Records room noise profile |

### Guided Enrollment UI

```
┌──────────────────────────────────────────────────┐
│  Voice Authentication Setup         Step 2 of 4  │
│                                                  │
│  Read the following sentence aloud:              │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  "The quick brown fox jumps over the lazy  │  │
│  │   dog while the five boxing wizards jump   │  │
│  │   quickly at dawn."                        │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌─ Audio Level ──────────────────────────────┐  │
│  │  ▁▂▃▅▇▅▃▂▁▂▃▅▇█▇▅▃▂▁▂▃▅▇▅▃▁▁▂▃▅▇▅▃▂▁   │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  Quality: ████████████░░  Good (SNR: 18dB)       │
│                                                  │
│  [◉ Recording...  8s / 10s]                      │
│                                                  │
│  ┌──────────┐  ┌──────────┐                      │
│  │ Re-record│  │   Next   │                      │
│  └──────────┘  └──────────┘                      │
└──────────────────────────────────────────────────┘
```

Steps:
1. **Environment check**: Record 3 seconds of silence to measure ambient noise. Warn if too loud.
2. **Voice samples**: Read 5-8 prompted sentences (covering diverse phonemes).
3. **PIN setup**: Set a 4-8 digit fallback PIN (bcrypt hashed, stored locally).
4. **Verification test**: System immediately verifies the user against their new enrollment. If verification fails, re-enroll.

### Enrollment Prompt Sentences

Designed to cover English phoneme space comprehensively:

1. "The quick brown fox jumps over the lazy dog while the five boxing wizards jump quickly at dawn."
2. "She sells sea shells by the seashore and watches the waves crash against the rocky shore."
3. "Peter Piper picked a peck of pickled peppers near the pleasant purple garden path."
4. "The weather this Thursday is thirty-three degrees with thick thunder clouds throughout."
5. "My voice is my passport, verify me for secure access to this application."
6. "Organizations recognize the authorization of vocalized identification systems."
7. "How much wood would a woodchuck chuck if a woodchuck could chuck wood?"
8. "Bright blue butterflies briefly buzzed between blooming begonias in the botanical breeze."

---

## Multi-User Profiles

### How It Works

Multiple people can enroll on the same IronMic installation:

1. **Primary user** enrolls first (becomes admin by default).
2. **Additional users** are added via Settings > Voice Auth > Add User.
3. Each user gets their own:
   - Notes and entries (filtered by `created_by_profile_id`)
   - Dictionary
   - Settings preferences
   - Meeting history (which meetings they were the host of)

### Automatic Profile Switching

When voice auth is enabled and IronMic detects speech:

1. Extract embedding from first 2 seconds.
2. Run speaker identification against all enrolled profiles (1-to-N).
3. If a match is found with confidence > threshold:
   - Switch to that user's profile automatically.
   - Load their notes, settings, dictionary.
   - Status bar shows: "Authenticated as [Name]".
4. If no match found:
   - Session remains locked.
   - "Voice not recognized. Please enter PIN or ask an enrolled user to add you."

### Data Isolation

```
┌──────────────────────────────────────────────┐
│  SQLite Database (single file)               │
│                                              │
│  ┌──────────────┐  ┌──────────────┐          │
│  │  Profile: You │  │  Profile: Pat│          │
│  │              │  │              │          │
│  │  entries     │  │  entries     │          │
│  │  dictionary  │  │  dictionary  │          │
│  │  settings    │  │  settings    │          │
│  │  meetings    │  │  meetings    │          │
│  └──────────────┘  └──────────────┘          │
│                                              │
│  ┌──────────────────────────────────┐        │
│  │  Shared (profile-independent)    │        │
│  │  - voice_auth_profiles           │        │
│  │  - voice_prints                  │        │
│  │  - voice_auth_sessions           │        │
│  │  - model metadata                │        │
│  └──────────────────────────────────┘        │
└──────────────────────────────────────────────┘
```

Implementation: Add a `profile_id` column to `entries`, `dictionary`, `settings` tables. Existing single-user data gets assigned to the primary profile on migration.

---

## Enterprise Provisioning

### Use Case

IT admin deploys IronMic to 50 workstations in a call center. Each workstation is shared by 3 agents across shifts.

### Provisioning Flow

1. **Admin creates a provisioning policy** (JSON file):
   ```json
   {
     "policy_version": 1,
     "organization": "Acme Corp",
     "require_voice_auth": true,
     "require_pin_fallback": true,
     "min_auth_threshold": 0.85,
     "max_idle_lock_minutes": 3,
     "max_session_duration_minutes": 480,
     "anti_spoof_required": true,
     "challenge_response_required": false,
     "allow_self_enrollment": false,
     "max_failed_attempts": 5,
     "lockout_duration_minutes": 15,
     "audit_log_retention_days": 90
   }
   ```

2. **Admin enrolls each user** on their primary workstation (or via a dedicated enrollment station).

3. **Enrollment export**: Voice auth profile (embedding vectors + encrypted PIN hash + policy) can be exported as an encrypted `.ironmic-profile` file and imported on other workstations. The export file contains:
   - Speaker embedding vectors (not audio)
   - bcrypt PIN hash
   - Policy overrides
   - Profile metadata (name, org)
   - Signed with a provisioning key to prevent tampering

4. **Import on target machine**: Drop `.ironmic-profile` files into IronMic's config directory or use Settings > Voice Auth > Import Profile.

### Security of Exported Profiles

- Embeddings are encrypted at rest using AES-256-GCM with a key derived from the provisioning password.
- The file is signed with HMAC-SHA256 to detect tampering.
- No audio is included — only mathematical vectors.
- Profiles can be revoked by the admin (sets `revoked_at` on provisioning record).

---

## Continuous Verification

### Why

A single check at session start is insufficient for high-security environments. Someone could start a session and then hand the microphone to an unauthorized person.

### How

During an active authenticated session:

1. Every 15 seconds of active speech, extract a new embedding from the most recent 2-second window.
2. Compare against the authenticated profile's enrollment embeddings.
3. If similarity drops below `auth_threshold - 0.10` (hysteresis to avoid flapping):
   - Pause transcription immediately.
   - Buffer untranscribed audio in memory (do not transcribe it yet).
   - Show "Voice change detected. Verifying..." for 5 seconds.
   - If the next check passes → resume, transcribe buffered audio.
   - If it fails → lock session, discard buffered audio.

### Performance Impact

Continuous verification adds ~50ms every 15 seconds — negligible. The embedding model is already loaded in memory for the initial check.

---

## Fallback Authentication

### PIN / Password

When voice verification fails or is unavailable (user has a cold, noisy environment, microphone issues):

1. **PIN entry**: 4-8 digit numeric PIN, entered via on-screen keypad or keyboard.
2. **PIN is stored as bcrypt hash** in `voice_auth_profiles.pin_hash`. Never stored in plaintext.
3. **Rate limiting**: After 5 failed PIN attempts, lock the profile for 15 minutes.
4. **PIN + voice (low confidence)**: If voice similarity is between 0.60-0.80, accept a correct PIN as confirmation. Update the voice print with this session's embedding (the user's voice may have changed).

### Recovery

If a user cannot authenticate by voice or PIN:

- **Primary user / admin**: Can reset via a recovery key generated at first enrollment (stored offline by the user, never in the app).
- **Enterprise**: Admin can remotely revoke and re-provision profiles.
- **Single user**: Factory reset of voice auth (deletes all auth profiles, requires re-enrollment). Protected by a confirmation dialog and optional recovery key.

---

## Privacy Considerations

- **Voice embeddings are not reversible**: The ECAPA-TDNN embedding is a lossy compression from ~960,000 audio samples (60s at 16kHz) to 192 floating-point numbers. The original voice cannot be reconstructed from the embedding.
- **No audio stored**: Consistent with IronMic's core principle. Enrollment audio is processed in memory and discarded. Only the mathematical embedding persists.
- **All local**: No biometric data leaves the device. Enterprise profile export is an explicit user/admin action with encryption.
- **User control**: Any user can delete their voice auth profile at any time. "Forget my voice" removes all embeddings, session logs, and auth history.
- **Audit trail**: Auth sessions and failures are logged locally for security review but contain no audio or transcript content.
- **Legal compliance**: Voice biometric data has special legal status in Illinois (BIPA), Texas, Washington, and EU (GDPR Article 9). IronMic should display a clear consent dialog at enrollment explaining what biometric data is collected, how it's stored, and how to delete it. Since all data is local and user-controlled, compliance is simpler than cloud-based systems.

---

## Integration with Existing Systems

### Session Lock (existing)

IronMic already has an idle timeout that requires interaction to resume. Voice auth replaces the "click to unlock" with "speak to unlock" — or supplements it (voice + click).

### VAD Pipeline (existing)

The Silero VAD already runs on every audio frame. Voice auth piggybacks on this:
- VAD detects speech onset → trigger embedding extraction on next 2 seconds of audio.
- No additional audio capture pipeline needed.

### Speaker Separation (planned)

Voice auth enrollment creates the same speaker embeddings used for meeting diarization. A user who enrolls for auth automatically gets speaker separation labeling ("You") in meetings — no separate enrollment needed.

### Settings Integration

New settings under **Settings > Security > Voice Authentication**:

| Setting | Default | Description |
|---------|---------|-------------|
| `voice_auth_enabled` | `false` | Master toggle |
| `voice_auth_threshold` | `0.80` | Verification similarity threshold |
| `voice_auth_continuous` | `false` | Re-verify during session |
| `voice_auth_continuous_interval_s` | `15` | Seconds between re-checks |
| `voice_auth_anti_spoof` | `true` | Enable replay detection |
| `voice_auth_challenge_response` | `false` | Require spoken challenge phrase |
| `voice_auth_idle_lock_minutes` | `5` | Lock after N minutes idle |
| `voice_auth_max_session_minutes` | `480` | Maximum session duration |
| `voice_auth_pin_required` | `true` | Require PIN as fallback |
| `voice_auth_max_failed_attempts` | `5` | Lockout after N failures |
| `voice_auth_lockout_minutes` | `15` | Lockout duration |

---

## Implementation Phases

### Phase 1: Core Verification Pipeline
- Implement `speaker/verifier.rs` — 1-to-1 cosine similarity verification
- Implement `speaker/auth_manager.rs` — session state machine (locked/authenticated/challenged)
- Add `voice_auth_profiles` and `voice_auth_sessions` tables (schema migration)
- Build `VoiceAuthSetup.tsx` — enrollment flow with quality checks
- Build `VoiceAuthGate.tsx` — lock screen with "Speak to unlock"
- PIN fallback with bcrypt hashing
- Rust tests for verification accuracy at various thresholds
- **Deliverable:** Single-user voice auth that locks/unlocks IronMic

### Phase 2: Anti-Spoofing
- Implement `speaker/anti_spoof.rs` — spectral flatness, HF energy, reverb estimation
- Store enrollment microphone fingerprint
- Channel consistency checking
- Log anti-spoof scores in session records
- **Deliverable:** Replay attacks are detected and blocked

### Phase 3: Continuous Verification
- Background re-verification every N seconds during active speech
- Voice change detection with hysteresis
- Auto-pause and re-lock on speaker change
- Buffer management for untranscribed audio during verification
- **Deliverable:** Sessions stay secure even if the speaker changes mid-dictation

### Phase 4: Multi-User Profiles
- Implement `speaker/identifier.rs` — 1-to-N identification for auto profile switching
- Add `profile_id` column to entries, dictionary, settings
- Build `MultiUserSwitcher.tsx` — profile management UI
- Data isolation between profiles
- **Deliverable:** Multiple people can use the same IronMic installation securely

### Phase 5: Enterprise Provisioning
- Implement encrypted profile export/import (`.ironmic-profile` format)
- Build `EnterpriseProvision.tsx` — bulk profile management
- Policy file support (JSON provisioning config)
- Admin revocation capability
- Audit log retention and export
- **Deliverable:** IT admins can deploy voice auth across an organization

---

## Performance Considerations

| Operation | Time (CPU) | Notes |
|-----------|-----------|-------|
| Initial verification (2s audio) | ~80ms | Embedding extraction + comparison |
| Continuous re-verification | ~50ms | Embedding only (comparison is trivial) |
| Anti-spoof analysis | ~10ms | Computed from existing FFT data |
| PIN verification (bcrypt) | ~100ms | Intentionally slow (security) |
| 1-to-N identification (20 profiles) | ~55ms | 50ms embedding + 5ms comparisons |
| Enrollment (8 samples) | ~400ms | 8 x 50ms embedding extraction |
| Memory overhead | ~5MB | Auth state + cached embeddings |

All operations complete well within the 2-second audio capture window, so verification is transparent to the user — they speak naturally and auth happens before transcription begins.

---

## N-API Surface Additions

```typescript
// --- Voice Authentication ---
voiceAuthEnroll(audioSamples: Buffer[], pin: string): Promise<string>  // returns profile_id
voiceAuthVerify(audioSample: Buffer, profileId?: string): Promise<VoiceAuthResult>
// VoiceAuthResult = { verified: boolean, profileId: string | null, confidence: number, antiSpoofScore: number }

voiceAuthSetPin(profileId: string, pin: string): Promise<void>
voiceAuthVerifyPin(profileId: string, pin: string): Promise<boolean>

voiceAuthLockSession(): void
voiceAuthGetSessionState(): string  // 'locked' | 'authenticated' | 'challenged'
voiceAuthGetActiveProfile(): string | null  // profile_id

voiceAuthListProfiles(): string  // JSON array
voiceAuthDeleteProfile(profileId: string): Promise<void>
voiceAuthExportProfile(profileId: string, password: string): Promise<Buffer>
voiceAuthImportProfile(data: Buffer, password: string): Promise<string>

voiceAuthGetSessionLog(profileId: string, limit: number): string  // JSON
voiceAuthGetFailureLog(limit: number): string  // JSON
```

---

## Open Questions

1. **Threshold tuning across microphones**: A user enrolls with their laptop mic but later uses a USB headset. The spectral characteristics differ enough to lower similarity scores. Should we require per-microphone enrollment, or can we normalize embeddings to be mic-agnostic?

2. **Voice changes from illness**: A user with a cold may fail verification for days. How aggressive should the system be about falling back to PIN? Should there be a "temporarily lower threshold" option?

3. **Environmental noise impact**: In a noisy open office, verification accuracy drops. Should the system automatically adjust thresholds based on ambient noise level, or is that a security risk?

4. **Biometric consent UX**: How prominent should the consent dialog be? A simple checkbox feels insufficient for biometric data. A full-screen disclosure with explicit "I understand" feels enterprise-appropriate but may annoy personal users.

5. **Profile portability security**: Encrypted profile export enables convenience but also creates an attack vector. If the provisioning password is weak, embeddings could be extracted. Should we enforce minimum password complexity for exports?

6. **Overlapping speech during verification**: If background conversation is picked up during the 2-second verification window, the embedding will be noisy. Should we gate verification on VAD confidence (only verify when single-speaker speech is detected)?

7. **Latency perception**: The 2-second audio capture before transcription begins may feel slow. Can we reduce to 1 second with acceptable accuracy, or should we start transcribing optimistically and retroactively lock if verification fails?

---

## Dependencies

| Dependency | Already in project? | Purpose |
|-----------|---------------------|---------|
| `ort` (ONNX Runtime) | Yes | Run ECAPA-TDNN model |
| `ndarray` | Yes | Embedding manipulation |
| `bcrypt` / `argon2` | **No — needs adding** | PIN hash generation and verification |
| `aes-gcm` | **No — needs adding** | Profile export encryption |
| `hmac` + `sha2` | **No — needs adding** | Profile export signing |
| ECAPA-TDNN ONNX model | Planned (speaker separation) | Speaker embedding extraction |

Three new Rust crates for cryptographic operations. The ONNX model is shared with the speaker separation feature.

---

## Success Metrics

- Voice verification accuracy: >98% true positive rate at 0.80 threshold (authorized user recognized)
- False acceptance rate: <1% (unauthorized user incorrectly accepted)
- Anti-spoof detection: >95% of replay attacks detected
- Verification latency: <200ms from speech onset to auth decision
- Enrollment completion rate: >90% of users complete enrollment on first attempt
- Fallback usage: <5% of sessions require PIN (voice auth should work most of the time)
- Continuous verification: <0.1% false positives (legitimate user incorrectly locked out mid-session)
