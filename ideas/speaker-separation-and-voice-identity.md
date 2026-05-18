# Speaker Separation & Voice Identity System

## Overview

Add real speaker diarization, voice enrollment, and persistent contact tracking to IronMic meetings. The goal: after any meeting, IronMic can tell you exactly who said what, label your voice automatically, and let you name and track other participants across all future meetings.

This is a full-stack feature spanning ML models, Rust audio processing, SQLite storage, and React UI. Everything runs locally — no audio or voice fingerprints ever leave the device.

---

## What This Enables

- During a meeting with 4 people, the transcript reads:
  ```
  You: Let's review the sprint goals for this week.
  Alex Chen: I finished the auth migration yesterday.
  Unknown Speaker 1: The API tests are still failing on staging.
  You: Can you file a ticket for that?
  ```
- After the meeting, you can click "Unknown Speaker 1" and name them → "Sarah Kim"
- Next meeting with Sarah, IronMic recognizes her voice automatically
- Contact profiles accumulate: Sarah has been in 12 meetings, spoke for 45 minutes total, most discussed topics: API, testing, deployments

---

## Architecture

### New Components

```
Rust Core
├── speaker/
│   ├── mod.rs
│   ├── embedder.rs        # ONNX voice embedding model (d-vector / ECAPA-TDNN)
│   ├── diarizer.rs        # Segment audio into speaker turns
│   ├── enrollment.rs      # Voice enrollment (capture + store reference embedding)
│   └── matcher.rs         # Compare embeddings to known speakers
│
├── storage/
│   ├── speakers.rs        # Speaker/contact CRUD
│   └── voice_prints.rs    # Voice embedding storage

Electron App
├── renderer/
│   ├── components/
│   │   ├── PeoplePage.tsx           # Contact directory with voice profiles
│   │   ├── SpeakerCard.tsx          # Individual contact: name, meetings, voice status
│   │   ├── VoiceEnrollment.tsx      # Record your voice sample UI
│   │   ├── SpeakerLabelEditor.tsx   # Post-meeting: name unknown speakers
│   │   └── SpeakerTimeline.tsx      # Meeting view with per-speaker segments
│   ├── stores/
│   │   └── useSpeakerStore.ts       # Speaker/contact state management
│   └── services/
│       └── SpeakerService.ts        # Orchestrates diarization + matching
```

### Data Flow

```
[Meeting Audio Buffer]
        │
        ▼
[1. VAD Segmentation]          ← Existing VADService splits audio into speech segments
        │
        ▼
[2. Speaker Embedding]         ← NEW: Extract 192-dim d-vector per segment (ONNX model)
        │
        ▼
[3. Clustering]                ← NEW: Group segments by speaker similarity (agglomerative clustering)
        │
        ▼
[4. Speaker Matching]          ← NEW: Compare cluster centroids to enrolled voice prints
        │
        ├── Match found → Label as known contact (e.g., "Alex Chen")
        └── No match → Label as "Unknown Speaker 1"
                │
                ▼
[5. Per-Speaker Transcription] ← Feed each speaker's segments to Whisper separately
        │
        ▼
[6. Assembled Transcript]      ← Interleave transcriptions by timestamp with speaker labels
        │
        ▼
[7. Post-Meeting Review]       ← UI to name unknowns, correct misidentifications
```

---

## ML Model Selection

### Speaker Embedding Model

**Recommended: ECAPA-TDNN (SpeechBrain)**
- Architecture: ECAPA-TDNN (Emphasized Channel Attention, Propagation and Aggregation in TDNN)
- Output: 192-dimensional speaker embedding vector
- Size: ~25MB (ONNX exported)
- Input: Variable-length audio segments (minimum ~1 second)
- Performance: State-of-the-art on VoxCeleb, works well with short utterances
- License: Apache 2.0
- ONNX export: Available via SpeechBrain's HuggingFace integration

**Alternative: Resemblyzer (GE2E)**
- Architecture: 3-layer LSTM with generalized end-to-end loss
- Output: 256-dimensional embedding
- Size: ~17MB
- Simpler but slightly less accurate than ECAPA-TDNN
- Good fallback if ONNX export issues arise

**How it works:**
1. Take a 1-10 second audio clip of someone speaking
2. Convert to mel spectrogram (80 mel banks, 25ms window, 10ms hop)
3. Feed through the model → get a fixed-size vector (the "voice print")
4. Two clips from the same person produce similar vectors (high cosine similarity)
5. Two clips from different people produce dissimilar vectors (low cosine similarity)

**Threshold tuning:**
- Cosine similarity > 0.75 → same speaker (high confidence)
- Cosine similarity 0.55-0.75 → possibly same speaker (ask user to confirm)
- Cosine similarity < 0.55 → different speaker

These thresholds need tuning per environment (quiet office vs noisy meeting room). IronMic should let the user adjust sensitivity in settings.

### Integration with Existing Stack

The model runs via the `ort` crate (ONNX Runtime) which is already a dependency in Cargo.toml for TTS. No new native dependencies needed. The embedding computation takes ~50ms per segment on CPU, so a 30-minute meeting with 200 speaker turns would take ~10 seconds to process — acceptable as a post-recording step.

---

## Database Schema

### New Tables

```sql
-- Known speakers / contacts
CREATE TABLE speakers (
    id TEXT PRIMARY KEY,                -- UUID
    name TEXT,                          -- Display name (null for unnamed)
    email TEXT,                         -- Optional contact email
    organization TEXT,                  -- Optional company/team
    notes TEXT,                         -- Free-form notes about this person
    is_self INTEGER DEFAULT 0,          -- 1 for the user's own voice profile
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- Aggregated stats (updated after each meeting)
    total_meetings INTEGER DEFAULT 0,
    total_speaking_seconds REAL DEFAULT 0,
    last_seen_at TEXT                   -- Most recent meeting date
);

-- Voice print embeddings (one per enrollment sample or meeting detection)
CREATE TABLE voice_prints (
    id TEXT PRIMARY KEY,                -- UUID
    speaker_id TEXT NOT NULL REFERENCES speakers(id) ON DELETE CASCADE,
    embedding BLOB NOT NULL,            -- Float32 array as binary (192 or 256 dims)
    embedding_dim INTEGER NOT NULL,     -- Dimension count (for validation)
    source TEXT NOT NULL,               -- 'enrollment' | 'meeting' | 'auto-detected'
    source_meeting_id TEXT,             -- Meeting this was detected in (null for enrollment)
    audio_duration_seconds REAL,        -- Duration of audio used to create this print
    quality_score REAL,                 -- SNR-based quality estimate (0-1)
    created_at TEXT NOT NULL
);
CREATE INDEX idx_voice_prints_speaker ON voice_prints(speaker_id);

-- Per-segment speaker labels within a meeting
CREATE TABLE meeting_speaker_segments (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
    speaker_id TEXT REFERENCES speakers(id) ON DELETE SET NULL,  -- null = unknown
    speaker_label TEXT NOT NULL,        -- Display label: name or "Unknown Speaker 1"
    start_ms INTEGER NOT NULL,          -- Offset from meeting start
    end_ms INTEGER NOT NULL,
    transcript TEXT,                    -- Whisper output for this segment
    embedding BLOB,                     -- Speaker embedding for this segment
    confidence REAL DEFAULT 0,          -- Match confidence (0-1)
    created_at TEXT NOT NULL
);
CREATE INDEX idx_meeting_segments_meeting ON meeting_speaker_segments(meeting_id);
CREATE INDEX idx_meeting_segments_speaker ON meeting_speaker_segments(speaker_id);
```

### Relationships

```
speakers 1 ←→ N voice_prints           (one person can have multiple voice samples)
speakers 1 ←→ N meeting_speaker_segments (one person appears in many meetings)
meeting_sessions 1 ←→ N meeting_speaker_segments (one meeting has many speaker turns)
```

---

## Voice Enrollment Flow

### Initial Setup ("This is my voice")

1. User goes to **Settings > Voice** or **People > My Profile**
2. Sees a "Set Up Your Voice" card with instructions:
   - "Read the following sentences aloud in your normal speaking voice"
   - 3-5 prompted sentences covering different phonemes
   - Each sentence is ~5 seconds, total enrollment takes ~30 seconds
3. For each sentence:
   - User clicks "Record" → records 5 seconds
   - AudioBridge captures frames → sent to Rust
   - Rust extracts embedding via ONNX model
   - Visual feedback: waveform + "Voice captured" checkmark
4. Multiple embeddings are averaged to create a robust reference embedding
5. Stored in `voice_prints` with `source = 'enrollment'` and `is_self = 1` on the speaker
6. Quality check: if SNR is too low (noisy room), warn and suggest re-recording

### Passive Enrollment (from meetings)

After any meeting where a speaker is identified and named:
- Their best-quality segment embedding is saved as a voice print
- Marked as `source = 'meeting'`
- Over multiple meetings, their voice print improves (more samples → more robust matching)

### Re-enrollment

User can re-record their voice anytime (voice changes, new microphone). Old prints are kept for a grace period, then pruned.

---

## Diarization Pipeline (During/After Meeting)

### Step 1: Audio Segmentation

Use the existing VAD to split the meeting audio into speech segments. Each segment is a contiguous block of speech from (presumably) one person. The VAD already tracks segment boundaries (`speechSegments` array in `VADService`).

**Enhancement needed:** Currently VAD only tracks speech/silence. Need to also detect **speaker changes within continuous speech** (e.g., two people talking back-to-back without a pause). This uses energy discontinuities or spectral change detection.

Minimum segment length: 1 second (shorter segments don't produce reliable embeddings).

### Step 2: Per-Segment Embedding

For each speech segment:
1. Extract the audio (Float32 PCM, 16kHz mono)
2. Compute mel spectrogram (80 banks, matching model's training config)
3. Run through ECAPA-TDNN ONNX model → 192-dim embedding
4. Normalize the embedding (L2 norm = 1)

This can run on the AudioBridge's accumulated buffer. The buffer is already in memory at meeting end.

### Step 3: Clustering

Group segments by speaker using **agglomerative hierarchical clustering**:

1. Compute pairwise cosine similarity between all segment embeddings
2. Start with each segment as its own cluster
3. Iteratively merge the two most similar clusters
4. Stop when the maximum inter-cluster similarity drops below threshold (0.55)
5. Each remaining cluster = one speaker

This is a pure algorithm (no ML model needed). Implementation in Rust is straightforward — it's matrix operations on the embedding vectors.

**Output:** Each segment gets a cluster ID (Speaker 0, Speaker 1, Speaker 2, ...)

### Step 4: Speaker Identification

Compare each cluster's centroid embedding against enrolled voice prints:

1. Compute centroid for each cluster (average of member embeddings)
2. For each centroid, compute cosine similarity against all entries in `voice_prints`
3. If best match > 0.75 → assign that speaker's name
4. If best match 0.55-0.75 → mark as "Possibly [Name]" (confirm later)
5. If no match > 0.55 → mark as "Unknown Speaker N"

The user's own voice (enrolled with `is_self = 1`) is always checked first.

### Step 5: Per-Speaker Transcription

Instead of transcribing the entire meeting as one block:
1. Group audio segments by speaker cluster
2. Concatenate each speaker's segments
3. Transcribe each speaker's audio separately via Whisper
4. Interleave the results by timestamp

**Why per-speaker?** Whisper performs better on single-speaker audio. Mixed-speaker audio confuses the language model, especially for short utterances.

### Step 6: Assembled Output

The final transcript looks like:
```
[00:00] You: Good morning everyone. Let's get started with the standup.
[00:05] Alex Chen: Sure. Yesterday I finished the database migration.
[00:12] Unknown Speaker 1: I'm still working on the API refactor. Should be done by EOD.
[00:20] You: Great. Any blockers?
```

Stored in `meeting_speaker_segments` table with timestamps, speaker references, and transcripts.

---

## People / Contacts System

### People Page

A new top-level navigation item: **People**

Shows all known speakers as a card grid or list:
- **Your profile** at the top (with voice enrollment status)
- **Named contacts** sorted by most recent meeting
- **Unnamed voices** — detected but not yet identified (with audio sample preview)

Each contact card shows:
- Name (editable)
- Number of meetings
- Total speaking time
- Most discussed topics (if topic classification is enabled)
- Voice print status: enrolled / auto-detected / needs improvement
- Last seen date

### Contact Detail Page

Click a contact to see:
- Full meeting history with this person
- Speaking time breakdown by meeting
- Ability to play back audio samples of their voice
- Edit name, email, organization, notes
- Merge contacts (if the same person was detected as different speakers in different meetings)
- Delete contact (removes voice prints too)

### Privacy Considerations

- Voice prints are stored as mathematical vectors, not audio recordings
- The original audio is NOT stored (consistent with IronMic's "audio never hits disk" principle)
- The embeddings cannot be reversed into audio — they're a one-way transformation
- All data stays in the local SQLite database
- User can delete any speaker's data at any time
- "Forget this person" removes all voice prints and unlinks meeting segments

---

## Post-Meeting Review UI

After a meeting ends, the meeting detail view shows:

### Speaker Timeline
A visual timeline showing who spoke when:
```
You:        ████████░░░░████░░████████████
Alex:       ░░░░░░░░████░░░░██░░░░░░░░░░░░
Unknown 1:  ░░░░░░░░░░░░░░██░░░░░░████░░░░
```

### Transcript with Speaker Labels
Each segment has:
- Speaker name/label (color-coded)
- Timestamp
- Transcript text
- Click speaker label → dropdown to reassign to a different person or create new contact

### "Name This Speaker" Flow
When the transcript has "Unknown Speaker 1":
1. Click the label → modal appears
2. Shows a 5-second audio clip of that speaker's voice (played back from the embedding's source segment — need to temporarily hold audio for this)
3. Options:
   - "This is [existing contact]" → dropdown of known speakers
   - "This is a new person" → enter name → creates speaker + saves voice print
   - "This is me" → assigns to self (useful if enrollment was imperfect)
4. All instances of "Unknown Speaker 1" in this meeting update immediately
5. Voice print is saved for future meetings

**Audio retention for review:**
- IronMic's principle is "audio never hits disk"
- Exception: during post-meeting review (before the user closes the review), keep audio segments in memory
- Once the user finishes reviewing (or closes the meeting detail), audio is zeroed and dropped
- Only the embedding vectors persist — not the audio

---

## Settings

New settings in **Settings > Voice AI**:

| Setting | Default | Description |
|---------|---------|-------------|
| `speaker_diarization_enabled` | `false` | Enable speaker separation in meetings |
| `speaker_match_threshold` | `0.75` | Cosine similarity threshold for positive speaker match |
| `speaker_uncertain_threshold` | `0.55` | Below this = definitely different speaker |
| `speaker_max_speakers` | `10` | Maximum speakers to detect per meeting |
| `speaker_auto_enroll` | `true` | Automatically save voice prints from meetings for named speakers |
| `speaker_model` | `ecapa-tdnn` | Which embedding model to use |

---

## Model Download & Management

The speaker embedding model needs to be downloaded like other models:

- **Model**: ECAPA-TDNN (~25MB ONNX)
- **Location**: `models/speaker-ecapa-tdnn.onnx`
- **Download**: Added to `MODEL_URLS` / `IMPORTABLE_FILES` with GitHub Releases + HuggingFace fallback
- **Settings > Models**: New "Speaker Recognition" section with download/import

The model is loaded once when speaker diarization is first used and kept in memory for subsequent meetings.

---

## Implementation Phases

### Phase 1: Core Embedding Pipeline
- Add ECAPA-TDNN ONNX model to model registry
- Implement `speaker/embedder.rs` — mel spectrogram + ONNX inference
- Implement `speaker/matcher.rs` — cosine similarity
- Add `speakers` and `voice_prints` tables (schema migration)
- Rust tests for embedding extraction and similarity
- **Deliverable:** Given two audio clips, can determine if same or different speaker

### Phase 2: Diarization
- Implement `speaker/diarizer.rs` — agglomerative clustering
- Modify `MeetingDetector` to save per-segment audio in buffer
- Run diarization at meeting end → cluster segments by speaker
- Store results in `meeting_speaker_segments`
- **Deliverable:** Meeting transcript with "Speaker 1 said X, Speaker 2 said Y"

### Phase 3: Voice Enrollment
- Implement `speaker/enrollment.rs`
- Build `VoiceEnrollment.tsx` — guided recording UI
- Store enrolled embeddings in `voice_prints`
- After enrollment, meetings auto-label "You" segments
- **Deliverable:** User enrolls their voice, meetings show "You: ..." for their segments

### Phase 4: Speaker Identification & Contacts
- Implement speaker matching against enrolled prints at meeting end
- Build `PeoplePage.tsx` and `SpeakerCard.tsx`
- Build post-meeting `SpeakerLabelEditor.tsx`
- Name unknown speakers → create contacts → save voice prints
- Auto-recognition in future meetings
- **Deliverable:** Full contact system with cross-meeting speaker tracking

### Phase 5: Polish & Advanced Features
- Speaker timeline visualization
- Contact merge (same person detected as different speakers)
- Speaking time analytics per person
- Topic analysis per speaker
- Improve clustering with online learning (refine voice prints over time)
- Handle edge cases: speaker talking over each other, phone/speaker audio quality

---

## Performance Considerations

| Operation | Time (CPU) | Notes |
|-----------|-----------|-------|
| Embedding extraction per segment | ~50ms | 1-5 second audio clips |
| Full meeting diarization (200 segments) | ~10s | Clustering + matching |
| Voice enrollment (5 samples) | ~250ms | 5 × 50ms |
| Speaker matching against 20 contacts | ~5ms | Just cosine similarity |
| Model load (first time) | ~500ms | ONNX model into memory |
| Memory usage | ~50MB | Model + embeddings in memory |

These are all acceptable for a post-meeting processing step. The user sees "Processing meeting..." for ~15-20 seconds (transcription + diarization combined) which is reasonable for a 30-minute meeting.

---

## Open Questions

1. **How to handle overlapping speech?** When two people talk at the same time, the embedding is unreliable. Options: skip the segment, or use a source separation model (adds significant complexity).

2. **Phone/speaker audio quality**: Voices through speakerphone or phone lines sound different than in-person. The embedding model may not match. Might need per-medium voice prints.

3. **Voice changes over time**: People's voices change with illness, aging, microphone changes. How aggressively should we update stored voice prints?

4. **Cross-device enrollment**: If the user enrolls on their laptop mic but attends meetings with a headset, the voice prints may not transfer well. May need per-device enrollment or device-agnostic preprocessing.

5. **Legal/compliance**: In some jurisdictions, voice biometric data has special legal status (similar to fingerprints). IronMic should clearly inform users what's stored and provide complete deletion capability. Since everything is local, this is simpler than cloud services but should still be documented.

---

## Dependencies

| Dependency | Already in project? | Purpose |
|-----------|---------------------|---------|
| `ort` (ONNX Runtime) | Yes (used for TTS) | Run ECAPA-TDNN model |
| `ndarray` | Yes (used for TTS) | Mel spectrogram computation |
| `rustfft` | **No — needs adding** | FFT for mel spectrogram |
| ECAPA-TDNN ONNX model | **No — ~25MB download** | Speaker embedding extraction |

Only one new Rust dependency (`rustfft`) and one new model file.

---

## Success Metrics

- Speaker separation accuracy: >85% on 2-4 speaker meetings
- Voice enrollment: 30 seconds of recording produces a usable voice print
- Cross-meeting recognition: >90% accuracy for enrolled speakers after 3+ meetings
- Processing time: <20 seconds for a 30-minute meeting (transcription + diarization)
- User satisfaction: Correctly identifies "You" in >95% of segments after enrollment
