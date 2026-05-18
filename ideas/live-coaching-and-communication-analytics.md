# Live Coaching and Communication Analytics

## Overview

Add real-time and post-meeting communication feedback to IronMic. During meetings, surface live metrics like talk-to-listen ratio, speaking pace, and filler word frequency as unobtrusive overlays. After meetings, generate detailed communication profiles with trends over time: "Your discovery calls that convert average 22 minutes; ones that don't average 35 minutes." Over weeks and months, build a personal communication dashboard that tracks improvement across filler words, question density, interruption patterns, and sentiment.

This leverages IronMic's existing infrastructure — VAD for speech detection, turn detection for speaker timing, meeting sessions for segmentation, the local LLM for analysis, and the analytics dashboard for visualization. All analysis runs locally. No communication data ever leaves the device.

---

## What This Enables

- **During a 1-on-1**: A subtle bar at the bottom of the meeting view shows "You: 78% | Them: 22%" — nudging the manager to ask more questions and listen.
- **After a sales call**: The post-meeting summary includes: "You asked 3 open-ended questions (down from your average of 7). You used 12 filler words (up from your average of 5). Your monologue segments averaged 45 seconds (your best calls average 20 seconds)."
- **Weekly review**: The communication dashboard shows: "This week you reduced filler words by 30% compared to last month. Your question density in team meetings improved from 2.1 to 3.4 questions per 10 minutes."
- **Coaching prep**: Before a performance review, a manager pulls up their 1-on-1 communication profile: "In 1-on-1s with Alex, I speak 65% of the time. In 1-on-1s with Pat, it's 45%. I should listen more with Alex."
- **Presentation practice**: User records a practice presentation. IronMic provides: "Speaking pace: 168 wpm (target: 140-160). Filler words: 'um' x8, 'like' x5. Longest pause: 12 seconds. Suggest adding 2 more pauses for audience absorption."

---

## Architecture

### New Components

```
Electron App
├── renderer/
│   ├── components/
│   │   ├── coaching/
│   │   │   ├── LiveCoachingOverlay.tsx     # Real-time metrics during meetings
│   │   │   ├── TalkRatioBar.tsx           # Horizontal bar showing talk/listen split
│   │   │   ├── FillerWordCounter.tsx      # Live filler word tally
│   │   │   ├── PaceIndicator.tsx          # Words-per-minute gauge
│   │   │   ├── QuestionTracker.tsx        # Questions asked count
│   │   │   └── CoachingNudge.tsx          # Contextual suggestion toast
│   │   │
│   │   ├── analytics/
│   │   │   ├── CommunicationDashboard.tsx # Trend charts and profile overview
│   │   │   ├── MeetingScorecard.tsx       # Post-meeting communication breakdown
│   │   │   ├── TrendChart.tsx             # Time-series chart for any metric
│   │   │   ├── PeerComparisonCard.tsx     # Compare your metrics across contacts
│   │   │   ├── CoachingInsightsPanel.tsx  # LLM-generated improvement suggestions
│   │   │   └── GoalTracker.tsx            # User-set communication goals
│   │   │
│   │   └── meeting/
│   │       └── MeetingReview.tsx          # (existing, extended with scorecard)
│   │
│   ├── stores/
│   │   └── useCoachingStore.ts            # Real-time metrics state
│   │
│   └── services/
│       ├── RealTimeMetricsEngine.ts       # Computes live metrics from VAD/audio stream
│       ├── PostMeetingAnalyzer.ts         # Runs after meeting ends, generates scorecard
│       ├── CommunicationProfiler.ts      # Aggregates metrics over time
│       └── CoachingInsightsEngine.ts     # Rule-based + LLM coaching suggestions

Rust Core
├── storage/
│   ├── communication_metrics.rs   # NEW: Metric storage CRUD
│   └── coaching.rs                # NEW: Goals, insights storage
```

### Data Flow: Real-Time Metrics

```
[Microphone Audio Stream]
        │
        ▼
[Existing VAD Service]
        │
        ├── speech_start / speech_end events
        │
        ▼
[RealTimeMetricsEngine]
        │
        ├── Speaking time accumulator (you vs others)
        │       │
        │       ▼
        │   [TalkRatioBar] ──→ "You: 72% | Others: 28%"
        │
        ├── Words-per-minute estimator
        │       │
        │       ▼                    (estimated from segment duration
        │   [PaceIndicator]           + transcript word count, updated
        │                             every 30 seconds with latest
        │                             Whisper partial results)
        │
        ├── Filler word detector
        │       │
        │       ▼
        │   [FillerWordCounter] ──→ "Fillers: um(3) uh(2) like(1)"
        │
        ├── Question detector
        │       │
        │       ▼
        │   [QuestionTracker] ──→ "Questions asked: 4"
        │
        └── Nudge engine (rule-based)
                │
                ▼
            [CoachingNudge] ──→ "You've been speaking for 3 minutes straight.
                                 Consider asking a question."
```

### Data Flow: Post-Meeting Analysis

```
[Meeting Ends]
        │
        ▼
[PostMeetingAnalyzer]
        │
        ├── Aggregate real-time metrics into final scores
        │
        ├── Run transcript through NLP pipeline:
        │       │
        │       ├── Filler word count (regex + pattern matching)
        │       ├── Question detection (interrogative patterns + punctuation)
        │       ├── Sentiment analysis (local model or LLM)
        │       ├── Monologue detection (consecutive segments > 60s)
        │       ├── Interruption detection (overlapping turn boundaries)
        │       └── Topic segmentation (from existing analytics)
        │
        ├── Compute meeting scorecard
        │       │
        │       ▼
        │   [MeetingScorecard]
        │       Talk ratio: 62% you / 38% them
        │       Filler words: 8 (0.4 per minute)
        │       Questions asked: 6 (0.3 per minute)
        │       Avg monologue: 32 seconds
        │       Interruptions: 2 (by you) / 1 (by them)
        │       Pace: 152 wpm average
        │       Sentiment: Mostly positive, dip at 12:05
        │
        ├── Store metrics in communication_metrics table
        │
        └── Generate coaching insights (LLM)
                │
                ▼
            [CoachingInsightsPanel]
                "Good job keeping your monologues under 45 seconds.
                 You asked 40% fewer questions than your average.
                 Consider preparing 2-3 open questions before your
                 next call with this contact."
```

---

## Real-Time Metrics Engine

### Metric: Talk-to-Listen Ratio

Computed from VAD speech/silence events:

```typescript
class TalkRatioTracker {
  private selfSpeakingMs = 0;
  private othersSpeakingMs = 0;
  private totalElapsedMs = 0;

  // Called on each VAD event
  onSpeechSegment(isSelf: boolean, durationMs: number) {
    if (isSelf) {
      this.selfSpeakingMs += durationMs;
    } else {
      this.othersSpeakingMs += durationMs;
    }
  }

  getRatio(): { self: number; others: number } {
    const total = this.selfSpeakingMs + this.othersSpeakingMs;
    if (total === 0) return { self: 0, others: 0 };
    return {
      self: this.selfSpeakingMs / total,
      others: this.othersSpeakingMs / total,
    };
  }
}
```

**Self vs Others**: Without speaker separation, IronMic uses a heuristic: the enrolled user's voice (if voice fingerprinting is enabled) or the dominant speaker near the microphone (louder = closer = you). If speaker separation is not available, the feature degrades to total speaking time vs silence time, which is still useful for presentations.

### Metric: Filler Word Detection

Filler words are detected from the running transcript via pattern matching:

```
Filler patterns (English):
  um, uh, er, ah, like (when not comparative/preposition),
  you know, I mean, basically, actually, honestly,
  sort of, kind of, right?, so (sentence-initial)
```

Implementation: After each Whisper transcription chunk arrives, scan for filler patterns using regex. The tricky case is "like" — it's only a filler when used as a discourse marker, not as a verb or preposition. Heuristic: "like" preceded by a pause or comma, or appearing sentence-initially, is likely a filler.

Accuracy does not need to be perfect. A consistent count (even if off by 10-20%) is useful for tracking trends over time.

### Metric: Speaking Pace (Words Per Minute)

```
WPM = (word_count_in_segment / segment_duration_seconds) * 60
```

Computed per Whisper transcription chunk and smoothed with an exponential moving average (alpha = 0.3) to avoid jumpy readings.

Target ranges:
- Conversational: 120-150 wpm
- Presentation: 140-170 wpm
- Too fast: >180 wpm (prompt to slow down)
- Too slow: <100 wpm (may indicate hesitation)

### Metric: Question Detection

Questions are detected from transcript text using multiple signals:

1. **Punctuation**: Sentences ending with "?" (Whisper usually transcribes these correctly).
2. **Interrogative words**: Sentences starting with who, what, where, when, why, how, do, does, did, is, are, was, were, can, could, would, should, will.
3. **Tag questions**: "...right?", "...don't you think?", "...isn't it?"
4. **Rising intonation**: Not available from text alone, but Whisper sometimes adds "?" based on prosody.

Classification:
- **Open-ended**: Starts with what, how, why, tell me, describe, explain.
- **Closed**: Starts with do, does, did, is, are, can, will, should. Answerable with yes/no.
- **Rhetorical**: Detected heuristically (e.g., "Who wouldn't want that?") — excluded from coaching metrics.

### Metric: Interruption Detection

An interruption occurs when:
1. Speaker A is talking.
2. Speaker B begins talking before Speaker A finishes (overlapping speech).
3. Speaker A stops, and Speaker B continues (A was cut off).

Detection requires speaker separation (planned) or at minimum turn detection. Without speaker separation, IronMic can detect "turn violations" — cases where the silence gap between your speech and the other person's is less than 200ms, suggesting overlap.

### Metric: Monologue Detection

A monologue is a continuous speaking segment by one person exceeding a configurable threshold (default: 60 seconds). Tracked per speaker.

Monologue stats:
- Count of monologues per meeting
- Average monologue duration
- Longest monologue
- Monologue-to-dialogue ratio

### Metric: Sentiment Analysis

Two approaches, selectable by user:

1. **Lightweight (default)**: Rule-based sentiment using word lists (positive/negative words, intensifiers, negations). Fast, runs on every transcript chunk. Produces a -1 to +1 score per segment.

2. **LLM-powered (optional)**: Send transcript segments to the local LLM with a prompt asking for sentiment classification. More accurate but slower. Runs post-meeting only.

Sentiment is tracked as a time series across the meeting, enabling visualizations like "The meeting started positive, sentiment dipped during the budget discussion, and recovered during the brainstorming segment."

---

## Coaching Insights Engine

### Rule-Based Insights (Immediate)

These fire during or immediately after a meeting based on metric thresholds:

| Condition | Insight |
|-----------|---------|
| Talk ratio > 70% in a 1-on-1 | "You've been speaking most of the time. Consider asking an open question." |
| Talk ratio < 20% in a group meeting | "You haven't spoken much. Is there something you'd like to add?" |
| Filler words > 1.0 per minute | "Your filler word rate is higher than your average. Take a breath before responding." |
| No questions asked in 10 minutes | "You haven't asked any questions recently. Engagement often improves with questions." |
| Monologue > 90 seconds | "That was a long uninterrupted segment. Consider breaking complex points into smaller pieces." |
| WPM > 180 for 2+ minutes | "You're speaking quickly. Slowing down can improve clarity and give listeners time to process." |
| Interruptions > 3 | "You've interrupted several times. Try waiting 2 seconds after someone finishes before responding." |

### LLM-Powered Insights (Post-Meeting)

After meeting ends, the coaching engine sends a structured prompt to the local LLM:

```
You are a communication coach. Analyze this meeting's communication metrics and provide 2-3 specific, actionable suggestions for improvement.

Meeting type: 1-on-1 recurring check-in
Duration: 28 minutes
Your talk ratio: 68%
Questions asked: 3 (your average: 7)
Filler words: 12 (your average: 5)
Average monologue: 45s (your average: 22s)
Interruptions by you: 2
Sentiment trend: Started neutral, became slightly negative at minute 15

Provide coaching suggestions. Be specific and reference the data. Output ONLY the suggestions, no preamble.
```

The LLM's response is displayed in the coaching panel of the post-meeting review.

### Trend-Based Insights (Weekly)

The CommunicationProfiler runs weekly (or on demand) to generate trend insights:

- "Your filler word rate has decreased 30% over the past month. Keep it up."
- "Your talk ratio in 1-on-1s has been consistently above 65%. In meetings where you spoke less than 50%, your team members contributed 40% more action items."
- "Your question density is highest on Mondays (4.2/10min) and lowest on Fridays (1.8/10min)."
- "Meetings where you ask 5+ questions average 22 minutes. Meetings with fewer than 3 questions average 35 minutes."

---

## Database Schema

### New Tables

```sql
-- Per-meeting communication metrics
CREATE TABLE communication_metrics (
    id TEXT PRIMARY KEY,                    -- UUID
    meeting_id TEXT NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
    profile_id TEXT,                        -- Voice auth profile (null if single user)
    computed_at TEXT NOT NULL,              -- ISO 8601

    -- Talk ratio
    self_speaking_seconds REAL NOT NULL DEFAULT 0,
    others_speaking_seconds REAL NOT NULL DEFAULT 0,
    silence_seconds REAL NOT NULL DEFAULT 0,
    talk_ratio REAL,                        -- self / (self + others), 0-1

    -- Filler words
    filler_word_count INTEGER NOT NULL DEFAULT 0,
    filler_words_per_minute REAL,
    filler_word_breakdown TEXT,             -- JSON: {"um": 5, "uh": 3, "like": 2}

    -- Questions
    questions_asked INTEGER NOT NULL DEFAULT 0,
    questions_per_10_minutes REAL,
    open_questions INTEGER DEFAULT 0,
    closed_questions INTEGER DEFAULT 0,

    -- Pace
    avg_wpm REAL,
    min_wpm REAL,
    max_wpm REAL,

    -- Monologues
    monologue_count INTEGER DEFAULT 0,
    avg_monologue_seconds REAL,
    max_monologue_seconds REAL,

    -- Interruptions
    interruptions_by_self INTEGER DEFAULT 0,
    interruptions_by_others INTEGER DEFAULT 0,

    -- Sentiment
    avg_sentiment REAL,                    -- -1 to 1
    sentiment_trend TEXT,                  -- JSON array of {timestamp_ms, score}

    -- Meeting context
    meeting_type TEXT,                     -- 'one_on_one' | 'group' | 'presentation' | 'unknown'
    participant_count INTEGER DEFAULT 2,
    meeting_duration_seconds REAL
);
CREATE INDEX idx_comm_metrics_meeting ON communication_metrics(meeting_id);
CREATE INDEX idx_comm_metrics_time ON communication_metrics(computed_at);

-- Coaching insights (generated post-meeting)
CREATE TABLE coaching_insights (
    id TEXT PRIMARY KEY,
    meeting_id TEXT REFERENCES meeting_sessions(id) ON DELETE CASCADE,
    profile_id TEXT,
    generated_at TEXT NOT NULL,
    source TEXT NOT NULL,                   -- 'rule' | 'llm' | 'trend'
    category TEXT NOT NULL,                 -- 'talk_ratio' | 'filler_words' | 'questions' | 'pace' | 'monologue' | 'interruptions' | 'general'
    severity TEXT NOT NULL DEFAULT 'info',  -- 'info' | 'suggestion' | 'warning'
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    metric_value REAL,                     -- The metric that triggered this insight
    metric_target REAL,                    -- The target/average to compare against
    is_dismissed INTEGER DEFAULT 0,
    is_achieved INTEGER DEFAULT 0          -- User marked as "done" / "improved"
);
CREATE INDEX idx_coaching_insights_meeting ON coaching_insights(meeting_id);
CREATE INDEX idx_coaching_insights_category ON coaching_insights(category);

-- Communication goals (user-defined)
CREATE TABLE communication_goals (
    id TEXT PRIMARY KEY,
    profile_id TEXT,
    metric TEXT NOT NULL,                  -- 'filler_words_per_minute' | 'talk_ratio' | 'questions_per_10_min' | etc.
    target_value REAL NOT NULL,            -- Target to achieve
    direction TEXT NOT NULL,               -- 'below' | 'above' | 'between'
    target_upper REAL,                     -- For 'between' direction
    meeting_type_filter TEXT,              -- Optional: only apply to certain meeting types
    created_at TEXT NOT NULL,
    is_active INTEGER DEFAULT 1
);

-- Filler word events (for detailed analysis)
CREATE TABLE filler_word_events (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
    word TEXT NOT NULL,                    -- The filler word detected
    timestamp_ms INTEGER NOT NULL,         -- Offset from meeting start
    context TEXT                           -- 5 words before and after (for accuracy review)
);
CREATE INDEX idx_filler_events_meeting ON filler_word_events(meeting_id);
```

### Relationships

```
meeting_sessions 1 ←→ 1 communication_metrics   (one scorecard per meeting)
meeting_sessions 1 ←→ N coaching_insights         (multiple insights per meeting)
meeting_sessions 1 ←→ N filler_word_events        (filler word timeline)
communication_goals     standalone                 (user's improvement targets)
```

---

## UI Design

### Live Coaching Overlay

A minimal, non-distracting overlay anchored to the bottom of the meeting view:

```
┌──────────────────────────────────────────────────────────────┐
│  Meeting: Sprint Review          ● Recording  23:45          │
│                                                              │
│  [Meeting transcript content...]                             │
│                                                              │
│                                                              │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  You 68% ████████████████░░░░░░░░ 32% Others          │  │
│  │  Pace: 148 wpm    Fillers: 4    Questions: 3           │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

Design principles:
- **Unobtrusive**: Thin bar, muted colors, does not overlay transcript text.
- **Glanceable**: Key metrics are single numbers, scannable in <1 second.
- **Color-coded**: Green = within target range, yellow = approaching threshold, red = outside target.
- **Collapsible**: Click to minimize to just the talk ratio bar. Click again to expand.
- **Dismissable**: "Hide coaching for this meeting" option.

### Coaching Nudge Toast

When a rule triggers, a toast slides in from the bottom-right:

```
┌────────────────────────────────────┐
│  💡 Communication Tip              │
│                                    │
│  You've been speaking for 3        │
│  minutes straight. Try asking      │
│  an open question to engage        │
│  the other person.                 │
│                                    │
│  [Dismiss]  [Don't show again]     │
└────────────────────────────────────┘
```

Nudges are rate-limited: maximum 1 nudge per 5 minutes to avoid distraction.

### Post-Meeting Scorecard

Integrated into the existing meeting review page as a new tab:

```
┌──────────────────────────────────────────────────────────────┐
│  Sprint Review - Apr 15, 2026                                │
│  [Transcript]  [Summary]  [Actions]  [Communication ●]      │
│                                                              │
│  Communication Scorecard                                     │
│  ─────────────────────────────────────────────────           │
│                                                              │
│  Talk Ratio          Questions           Filler Words        │
│  ┌──────────┐       ┌──────────┐       ┌──────────┐         │
│  │          │       │          │       │          │         │
│  │   68%    │       │    6     │       │    8     │         │
│  │   You    │       │  asked   │       │  total   │         │
│  │          │       │          │       │          │         │
│  │ avg: 55% │       │ avg: 7.2 │       │ avg: 4.1 │         │
│  └──────────┘       └──────────┘       └──────────┘         │
│                                                              │
│  Pace: 152 wpm (target: 140-160) ✓                           │
│  Longest monologue: 48s (avg: 22s) ▲                         │
│  Interruptions: 2 by you, 1 by them                          │
│                                                              │
│  Sentiment Timeline                                          │
│  +1 ┤                     ╭──╮        ╭────                  │
│   0 ┤──────╮    ╭────────╯  ╰──╮    │                       │
│  -1 ┤      ╰────╯              ╰────╯                       │
│      0    5    10   15   20   25   28 min                    │
│                                                              │
│  Coaching Insights                                           │
│  ─────────────────                                           │
│  ● Your talk ratio was higher than your average. In past     │
│    meetings where you spoke less, team members contributed   │
│    more action items.                                        │
│  ● You asked 6 questions — close to your average. Good job   │
│    maintaining engagement.                                   │
│  ● Filler word rate (0.3/min) is within your target range.   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Communication Dashboard

A new section in the existing analytics page (or standalone page):

```
┌──────────────────────────────────────────────────────────────┐
│  Communication Analytics                                     │
│  ─────────────────────                                       │
│                                                              │
│  Time Range: [Last 30 days ▼]   Meeting Type: [All ▼]       │
│                                                              │
│  Filler Words per Minute                                     │
│  1.2 ┤                                                       │
│  0.8 ┤   ╭╮     ╭╮                                          │
│  0.4 ┤╮╭╯╰╮╭──╯╰╮╭──╮                                     │
│  0.0 ┤╰╯   ╰╯     ╰╯  ╰────── target: 0.5                  │
│       Mar 15        Mar 29        Apr 12                     │
│                                                              │
│  Talk Ratio in 1-on-1s                                       │
│  80% ┤                                                       │
│  60% ┤╮  ╭──╮  ╭╮  ╭╮  ╭─╮                                 │
│  40% ┤╰──╯  ╰──╯╰──╯╰──╯ ╰──── target: 40-50%             │
│  20% ┤                                                       │
│       Mar 15        Mar 29        Apr 12                     │
│                                                              │
│  Per-Contact Comparison                                      │
│  ┌─────────────────────────────────────┐                     │
│  │ Alex Chen    ████████████░░ 62%     │  7 meetings         │
│  │ Pat Kim      ██████░░░░░░░░ 45%     │  4 meetings         │
│  │ Team Standup ████░░░░░░░░░░ 28%     │  12 meetings        │
│  └─────────────────────────────────────┘                     │
│                                                              │
│  Goals                                                       │
│  ● Filler words < 0.5/min: ████████░░ 80% of meetings ✓     │
│  ● Talk ratio < 50% in 1-on-1s: ██████░░░░ 60% ▲            │
│  ● 5+ questions per meeting: ████████████ 95% ✓              │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Integration with Existing Systems

### VAD Service (existing)

The VAD already produces speech/silence events with timestamps. The RealTimeMetricsEngine subscribes to these events to compute talk ratio, monologue detection, and turn timing. No modifications to VADService needed — just a new consumer.

### Turn Detection (existing)

The TurnDetector identifies speaker turns (when one person stops and another starts). This feeds directly into interruption detection and talk ratio per speaker. The existing `turn_detection_timeout_ms` setting controls sensitivity.

### Meeting Sessions (existing)

Communication metrics attach to existing `meeting_sessions` records via `meeting_id` foreign key. No changes to meeting lifecycle — the coaching layer is purely additive.

### Analytics Dashboard (existing)

The existing analytics page already has chart infrastructure (topic trends, usage patterns). Communication trends use the same charting components. The CommunicationDashboard can be a new tab alongside existing analytics.

### Local LLM (existing)

Post-meeting coaching insights use the already-loaded local LLM (Mistral). The coaching prompt is lightweight (~200 tokens input, ~100 tokens output) — adds <2 seconds to post-meeting processing.

### Speaker Separation (planned)

Without speaker separation, talk ratio is estimated (self = near-mic speaker, others = everyone else). With speaker separation enabled, metrics become per-speaker: "You spoke 62%, Alex spoke 25%, Pat spoke 13%." All metrics improve in accuracy when speaker identity is known.

---

## NLP Pipeline for Transcript Analysis

### Filler Word Detection

```typescript
const FILLER_PATTERNS = [
  // Direct fillers
  /\b(um|uh|er|ah|hmm)\b/gi,
  // Discourse markers (context-dependent)
  /\b(you know|I mean|basically|actually|honestly|literally)\b/gi,
  // Hedge words
  /\b(sort of|kind of|I guess|I think|maybe)\b/gi,
  // Initial "so" and "like" (when sentence-initial or after comma)
  /(?:^|[,.])\s*(so|like)\b/gi,
];

// Post-processing: exclude false positives
// "I like pizza" → not a filler
// "It was, like, really good" → filler
// "So the next step is..." (after transition) → filler
// "Do so immediately" → not a filler
```

### Question Detection

```typescript
function detectQuestions(transcript: string): Question[] {
  const sentences = splitSentences(transcript);
  const questions: Question[] = [];

  for (const sentence of sentences) {
    const isQuestion =
      sentence.trim().endsWith('?') ||
      /^(who|what|where|when|why|how|do|does|did|is|are|was|were|can|could|would|should|will|have|has)\b/i.test(sentence.trim());

    if (isQuestion) {
      const type = /^(what|how|why|tell|describe|explain|walk me through)\b/i.test(sentence.trim())
        ? 'open'
        : 'closed';

      questions.push({ text: sentence, type, timestamp_ms: /* from segment */ });
    }
  }

  return questions;
}
```

### Sentiment Analysis (Lightweight)

For real-time use, a lexicon-based approach using AFINN-165 word list (2,477 words with sentiment scores from -5 to +5):

```
Score per segment = sum(word_scores) / word_count
Normalized to -1 to +1 range
Smoothed with EMA (alpha = 0.3) for time-series display
```

For post-meeting analysis, the local LLM can provide more nuanced sentiment per segment when the user opts in.

---

## Privacy Considerations

- **All metrics computed locally**: No communication data, scores, or coaching insights ever leave the device.
- **Opt-in per meeting**: Users can enable/disable coaching for specific meetings. A meeting tagged "personal" might have coaching disabled.
- **No recording of others' consent**: IronMic does not inform meeting participants about coaching analysis. This is purely self-improvement tooling on the user's own device. However, a disclaimer in settings should note that communication metrics involve analysis of all participants' speech patterns.
- **Metric data is aggregate**: Filler word events store the word and timestamp but not surrounding transcript context (by default). The `context` field in `filler_word_events` is optional and can be disabled.
- **Coaching insights reference metrics, not transcript content**: The LLM receives statistical summaries, not raw transcript text. (Exception: if the user explicitly enables "detailed coaching" mode, transcript excerpts may be sent to the local LLM for more specific feedback.)
- **Data retention**: Communication metrics follow the same retention policy as meeting sessions. Users can delete metrics for any meeting, or bulk-delete all coaching data.
- **No comparison with others**: IronMic never compares your metrics against other users' data. "Per-contact comparison" shows YOUR talk ratio when speaking with different people — not their metrics.

---

## Settings

New settings under **Settings > Coaching**:

| Setting | Default | Description |
|---------|---------|-------------|
| `coaching_enabled` | `false` | Master toggle for all coaching features |
| `coaching_live_overlay` | `true` | Show real-time metrics during meetings |
| `coaching_nudges_enabled` | `true` | Show contextual suggestion toasts |
| `coaching_nudge_interval_min_s` | `300` | Minimum seconds between nudges |
| `coaching_post_meeting` | `true` | Generate scorecard after meetings |
| `coaching_llm_insights` | `true` | Use LLM for post-meeting coaching |
| `coaching_sentiment_enabled` | `true` | Track sentiment over time |
| `coaching_sentiment_mode` | `lexicon` | 'lexicon' (fast) or 'llm' (accurate, post-meeting only) |
| `coaching_filler_sensitivity` | `medium` | 'low' / 'medium' / 'high' — how aggressively to count fillers |
| `coaching_monologue_threshold_s` | `60` | Seconds before a segment is flagged as a monologue |
| `coaching_talk_ratio_target` | `0.50` | Target talk ratio for 1-on-1 meetings |
| `coaching_pace_target_min` | `130` | Target WPM lower bound |
| `coaching_pace_target_max` | `170` | Target WPM upper bound |

---

## Implementation Phases

### Phase 1: Real-Time Talk Ratio
- Implement `RealTimeMetricsEngine.ts` with talk ratio tracking from VAD events
- Build `LiveCoachingOverlay.tsx` with `TalkRatioBar.tsx`
- Add `communication_metrics` table (schema migration)
- Store talk ratio at meeting end
- Settings toggle for coaching features
- **Deliverable:** During meetings, see a live talk-to-listen ratio bar

### Phase 2: Filler Words and Pace
- Add filler word detection to RealTimeMetricsEngine (processes each Whisper chunk)
- Add WPM calculation with EMA smoothing
- Build `FillerWordCounter.tsx` and `PaceIndicator.tsx`
- Add `filler_word_events` table
- Store filler and pace metrics at meeting end
- **Deliverable:** Live filler word count and speaking pace during meetings

### Phase 3: Post-Meeting Scorecard
- Implement `PostMeetingAnalyzer.ts` — aggregates all metrics after meeting ends
- Build `MeetingScorecard.tsx` — visual summary integrated into meeting review
- Question detection from transcript
- Monologue and interruption detection
- Store all metrics in `communication_metrics`
- **Deliverable:** After each meeting, see a comprehensive communication scorecard

### Phase 4: Coaching Insights
- Implement `CoachingInsightsEngine.ts` — rule-based insights
- Add LLM-powered post-meeting coaching prompt
- Build `CoachingInsightsPanel.tsx` and `CoachingNudge.tsx`
- Add `coaching_insights` table
- Nudge rate-limiting and dismissal
- **Deliverable:** Actionable coaching suggestions during and after meetings

### Phase 5: Trends and Dashboard
- Implement `CommunicationProfiler.ts` — aggregate metrics over time
- Build `CommunicationDashboard.tsx` with trend charts
- Per-contact comparison view
- Goal tracking (`communication_goals` table)
- Weekly trend insights (scheduled or on-demand)
- Sentiment time-series visualization
- **Deliverable:** Long-term communication improvement tracking with goal setting

### Phase 6: Advanced Analytics
- Meeting type auto-detection (1-on-1 vs group vs presentation based on participant count and talk ratio)
- Correlation analysis: "Meetings where you ask 5+ questions are 30% shorter"
- Export communication report as PDF/markdown
- Integration with speaker separation for per-speaker metrics
- Custom filler word lists (domain-specific terms that are fillers in your context)
- **Deliverable:** Deep analytical capabilities for power users

---

## Performance Considerations

| Operation | Time | Notes |
|-----------|------|-------|
| Talk ratio update (per VAD event) | <1ms | Simple accumulator |
| Filler word scan (per transcript chunk) | <5ms | Regex on ~50-200 words |
| WPM calculation | <1ms | Division + EMA |
| Question detection (per chunk) | <5ms | Pattern matching |
| Post-meeting analysis (full pipeline) | ~500ms | Aggregation + NLP |
| LLM coaching insights | ~2-3s | Local LLM inference |
| Sentiment (lexicon, per chunk) | <2ms | Word lookup |
| Sentiment (LLM, post-meeting) | ~5s | Full meeting analysis |
| Dashboard rendering (30 days) | <200ms | SQLite queries + chart render |
| Memory overhead (real-time engine) | ~2MB | Metric accumulators + buffers |

All real-time operations complete within a single animation frame. Post-meeting processing adds 3-8 seconds to the existing meeting end pipeline, which already includes transcription and summary generation.

---

## N-API Surface Additions

```typescript
// --- Communication Metrics ---
saveCommunicationMetrics(metricsJson: string): Promise<string>  // returns metric_id
getCommunicationMetrics(meetingId: string): string  // JSON or "null"
listCommunicationMetrics(limit: number, offset: number, meetingType?: string): string  // JSON
getCommunicationTrends(fromDate: string, toDate: string, metric: string): string  // JSON time series
getPerContactMetrics(speakerId: string): string  // JSON

// --- Coaching ---
saveCoachingInsight(meetingId: string, insightJson: string): Promise<string>
listCoachingInsights(limit: number, category?: string): string  // JSON
dismissCoachingInsight(id: string): void
markInsightAchieved(id: string): void

// --- Goals ---
createCommunicationGoal(goalJson: string): Promise<string>
listCommunicationGoals(activeOnly: boolean): string  // JSON
updateCommunicationGoal(id: string, updatesJson: string): void
deleteCommunicationGoal(id: string): void

// --- Filler Words ---
saveFillerWordEvents(meetingId: string, eventsJson: string): void
getFillerWordBreakdown(fromDate: string, toDate: string): string  // JSON
```

---

## Open Questions

1. **Speaker attribution without speaker separation**: How accurately can we attribute talk ratio without knowing which speech is "you" vs "them"? The near-mic heuristic works for headsets but fails for laptop speakers in conference rooms. Should coaching features require speaker separation, or degrade gracefully?

2. **Cultural sensitivity**: Communication norms vary significantly across cultures. High talk ratio may be expected in some cultures, low in others. Filler words differ by language. Should coaching targets be user-configurable from the start, or start with English-centric defaults and expand?

3. **Coaching fatigue**: Too many nudges during a meeting will annoy users and be dismissed. What's the right balance? Should nudges become less frequent as the user improves on a metric?

4. **Meeting type detection**: Automatically classifying a meeting as "1-on-1", "group", or "presentation" affects which metrics and targets apply. How reliable can auto-detection be based only on talk patterns and participant count?

5. **Historical backfill**: When a user enables coaching, should we retroactively analyze past meetings to build an initial communication profile? This would provide immediate value but could be computationally expensive for users with hundreds of meetings.

6. **Sentiment accuracy**: Lexicon-based sentiment is fast but crude. The local LLM is more accurate but slower. Is there a middle ground — perhaps a small TF.js sentiment model (~5MB) running in the ML worker?

7. **Competitive framing vs self-improvement**: Should the UI ever frame metrics as "better/worse than average"? Or strictly frame everything as personal improvement over time? The latter feels more aligned with IronMic's ethos.
