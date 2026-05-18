# Voice Journal and Mood/Sentiment Tracking

## Overview

Add a dedicated journaling mode to IronMic that combines voice dictation with automatic sentiment analysis and emotional trend tracking. Users dictate daily journal entries, and IronMic classifies the mood and emotional tone of each entry using a lightweight on-device sentiment model and the local LLM. Over time, IronMic visualizes emotional patterns, identifies triggers, and surfaces insights — like a mood tracker powered by voice, entirely private and local.

IronMic already captures and stores voice-to-text entries, runs TF.js models in the renderer, and has analytics infrastructure for tracking patterns over time. The journaling layer adds: a dedicated journal entry type with date-based organization, a TF.js sentiment classifier, LLM-powered emotional theme extraction, mood trend visualizations, and optional journaling prompts to encourage consistent practice.

This extends IronMic from a productivity tool into a personal wellness tool. For users in therapy, managing stress, or simply wanting to reflect, voice journaling removes the friction of typing while providing data-driven self-awareness. All emotional data stays on-device — no mood data ever leaves the machine, a critical requirement for something this personal.

---

## What This Enables

- **Daily voice journaling:**
  ```
  User opens Journal page, presses record.
  
  "Today was tough. The product review didn't go well — the stakeholders 
   pushed back on the timeline and I felt like my team's work wasn't being 
   recognized. But I had a good one-on-one with Sarah afterwards, she had 
   some really helpful perspective. I think I need to reframe how I present 
   our progress next time. Ended the day with a run and feeling a lot better."
  
  IronMic produces:
    Entry date: April 19, 2026
    Sentiment: Mixed → Positive (trending up within entry)
    Moods detected: [frustrated, unappreciated, grateful, determined, relieved]
    Key themes: work stress, stakeholder feedback, team recognition, exercise
    Word count: 82 | Duration: 38s
  ```

- **Mood trend dashboard:**
  ```
  ┌──────────────────────────────────────────────────┐
  │  Mood Trends — Last 30 Days                       │
  │                                                    │
  │  Positivity Score (0-10)                          │
  │  10│                                               │
  │   8│          ●     ●  ●  ●                        │
  │   6│    ●  ●     ●        ●  ●                     │
  │   4│ ●                          ●  ●               │
  │   2│                                    ●          │
  │   0│                                               │
  │    └──────────────────────────────────────          │
  │     Apr 1                            Apr 19        │
  │                                                    │
  │  Top Moods This Week: grateful (4x), stressed (3x)│
  │  Most Common Theme: work deadlines                 │
  │  Journal Streak: 12 days                           │
  │                                                    │
  │  Insight: Your mood tends to be higher on days     │
  │  you mention exercise. You've journaled about      │
  │  running 5 times, and positivity averaged 7.8      │
  │  vs 5.2 on non-exercise days.                      │
  └──────────────────────────────────────────────────┘
  ```

- **Journaling prompts:**
  ```
  IronMic suggests: "What are you grateful for today?"
  
  User dictates: "I'm grateful for the sunny morning — I ate breakfast 
   on the patio. Also grateful that the deployment went smoothly yesterday. 
   And my partner surprised me with dinner."
  
  Sentiment: Positive (0.92)
  Moods: [grateful, content, loved]
  Gratitude items extracted: morning sunshine, smooth deployment, surprise dinner
  ```

- **Weekly reflection summaries:**
  ```
  Sunday evening, IronMic generates:
  
  "This week you journaled 6 out of 7 days. Your average mood was 6.5/10, 
   up from 5.8 last week. The biggest mood boost came on Wednesday when you 
   mentioned closing the Anderson deal. Thursday was your lowest day — you 
   mentioned feeling overwhelmed by the quarterly planning process. You 
   mentioned exercise 3 times this week (running, yoga, walking). Consider: 
   you've mentioned 'not enough sleep' in 4 of the last 7 entries."
  ```

- **Emotion tagging and search:**
  ```
  User searches: "entries where I felt anxious"
  Results: 8 entries from the last month tagged with anxiety-related sentiment.
  
  User searches: "what makes me happy"
  Results: Entries with high positive sentiment, with extracted themes: 
  exercise, family time, creative work, completing projects.
  ```

---

## Architecture

### New Components

```
Electron App
├── renderer/
│   ├── components/
│   │   ├── journal/
│   │   │   ├── JournalPage.tsx              # Main journal view (date-based)
│   │   │   ├── JournalEntry.tsx             # Single journal entry display
│   │   │   ├── JournalEditor.tsx            # Dictation + text editing for journal
│   │   │   ├── JournalCalendar.tsx          # Calendar view with mood dots
│   │   │   ├── JournalPrompt.tsx            # Suggested journaling prompt
│   │   │   ├── MoodSelector.tsx             # Manual mood override (emoji picker)
│   │   │   ├── MoodTrendChart.tsx           # Line chart of sentiment over time
│   │   │   ├── MoodDistribution.tsx         # Pie/bar chart of mood categories
│   │   │   ├── EmotionTimeline.tsx          # Emotion tags across entries
│   │   │   ├── ThemeCloud.tsx               # Word cloud of emotional themes
│   │   │   ├── WeeklyReflection.tsx         # LLM-generated weekly summary
│   │   │   ├── InsightCard.tsx              # Individual insight (correlation, pattern)
│   │   │   ├── JournalStreak.tsx            # Streak counter and motivation
│   │   │   └── JournalExport.tsx            # Export journal as markdown/PDF
│   │   │
│   │   └── settings/
│   │       └── JournalSettings.tsx          # Journal preferences
│   │
│   ├── stores/
│   │   └── useJournalStore.ts               # Journal entries, mood data, insights
│   │
│   └── services/
│       ├── tfjs/
│       │   └── SentimentClassifier.ts       # TF.js sentiment analysis model
│       ├── JournalService.ts                # Journal entry management
│       ├── MoodAnalyzer.ts                  # Orchestrates sentiment + LLM analysis
│       ├── InsightEngine.ts                 # Pattern detection across entries
│       └── PromptGenerator.ts               # Selects journaling prompts

Rust Core
├── storage/
│   └── journal.rs                           # Journal entry CRUD, mood queries
```

### Sentiment Analysis Pipeline

```
[User dictates journal entry]
        │
        ▼
[Whisper STT → Raw Transcript]
        │
        ▼
[LLM Cleanup → Polished Text]
        │
        ├──────────────────────────────────────┐
        │                                      │
        ▼                                      ▼
[TF.js Sentiment Classifier]          [LLM Emotional Analysis]
  (runs in ML Web Worker)               (runs in Rust via llama.cpp)
        │                                      │
        │                                      │
  ┌─────▼──────────┐                  ┌───────▼───────────┐
  │ Valence: 0.72   │                  │ Moods: [grateful, │
  │ Arousal: 0.45   │                  │   stressed,       │
  │ Sentiment:       │                  │   determined]     │
  │   positive (0.72)│                  │ Themes: [work,    │
  │                  │                  │   relationships,  │
  │                  │                  │   exercise]       │
  │                  │                  │ Summary: "Mixed   │
  │                  │                  │   day with stress  │
  │                  │                  │   offset by       │
  │                  │                  │   exercise."      │
  └────────┬─────────┘                  └───────┬───────────┘
           │                                    │
           └────────────────┬───────────────────┘
                            │
                            ▼
                   [Merge Results]
                     Sentiment score + mood tags + themes + summary
                            │
                            ▼
                   [Store in SQLite]
                     journal_entries table + journal_moods table
                            │
                            ▼
                   [Update Visualizations]
                     Mood chart, calendar, insights
```

### Component Interaction

```
┌──────────────────────────────────────────────────────────────┐
│  Renderer Process                                             │
│                                                               │
│  ┌─────────────────┐         ┌────────────────────┐          │
│  │  JournalEditor  │────────→│  JournalService    │          │
│  │  (dictate/type) │         │                    │          │
│  └─────────────────┘         │  ┌──────────────┐  │          │
│                              │  │ MoodAnalyzer │  │          │
│  ┌─────────────────┐         │  │              │  │          │
│  │  JournalPage    │◄────────│  │ ┌──────────┐ │  │          │
│  │  (view entries) │         │  │ │ TF.js    │ │  │          │
│  └─────────────────┘         │  │ │Sentiment │ │  │          │
│                              │  │ └──────────┘ │  │          │
│  ┌─────────────────┐         │  │              │  │          │
│  │ MoodTrendChart  │◄────────│  │ ┌──────────┐ │  │          │
│  │ JournalCalendar │         │  │ │ LLM mood │──┼──→ IPC → Rust
│  │ InsightCard     │         │  │ │ analysis │ │  │    (llama.cpp)
│  └─────────────────┘         │  │ └──────────┘ │  │
│                              │  └──────────────┘  │          │
│  ┌─────────────────┐         │                    │          │
│  │ InsightEngine   │◄────────│  ┌──────────────┐  │          │
│  │ (correlations)  │         │  │ PromptGen    │  │          │
│  └─────────────────┘         │  └──────────────┘  │          │
│                              └────────────────────┘          │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

---

## Sentiment Analysis Models

### TF.js Sentiment Classifier (Real-Time)

A lightweight model that runs in the ML Web Worker for instant feedback:

- **Architecture:** Bidirectional LSTM with attention, ~2MB
- **Input:** Tokenized text (first 256 tokens)
- **Output:**
  - Valence: -1.0 (very negative) to +1.0 (very positive)
  - Arousal: 0.0 (calm) to 1.0 (intense)
  - Sentiment class: negative / neutral / positive
  - Confidence: 0.0 to 1.0
- **Training:** Pre-trained on conversational English text (reviews, diaries, social media)
- **Ships with app:** Yes (~2MB)
- **Inference time:** ~20ms per entry

This model provides instant numeric sentiment scores for visualizations and trend tracking.

### LLM Emotional Analysis (Deep)

The local Mistral LLM provides richer emotional analysis:

```
Emotional Analysis Prompt:

You are a thoughtful journal analyst. Read the following journal entry and provide:

1. MOODS: List 2-5 specific emotions present (e.g., grateful, anxious, frustrated, 
   hopeful, overwhelmed, content, lonely, excited, determined, sad, relieved, proud).
   Order from strongest to weakest.

2. THEMES: List 2-4 life themes this entry touches on (e.g., work, relationships, 
   health, creativity, finances, personal growth, family, social life, self-care).

3. MOOD_ARC: In one word, describe how the emotional tone changes through the entry: 
   stable / improving / declining / mixed / neutral.

4. SUMMARY: One sentence capturing the emotional essence of this entry.

5. GRATITUDE: List any things the person expressed gratitude for (empty if none).

Respond in JSON only:
{
  "moods": ["mood1", "mood2"],
  "themes": ["theme1", "theme2"],
  "mood_arc": "improving",
  "summary": "A challenging work day redeemed by supportive relationships and exercise.",
  "gratitude": ["supportive colleague", "evening run"]
}

Journal entry:
{text}
```

This runs after the TF.js classifier, adding qualitative analysis on top of the quantitative score. It takes 2-4 seconds but only runs once per entry (not in real-time).

---

## Mood Visualization

### Calendar Heat Map

```
┌──────────────────────────────────────────────────┐
│  April 2026                                       │
│                                                    │
│  Mon   Tue   Wed   Thu   Fri   Sat   Sun          │
│              ●(4)  ●(6)  ●(7)  ●(8)  ●(5)        │
│  ●(3)  ●(5)  ●(8)  ●(4)  ●(6)  ○     ●(7)        │
│  ●(6)  ●(7)  ●(9)  ●(5)  ●(6)  ●(8)  ●(7)        │
│  ●(5)  ●(4)  ●(7)  ○     ○     ○     ○            │
│                                                    │
│  Legend: ●(1-3) Low  ●(4-6) Medium  ●(7-10) High  │
│          ○ No entry                                │
└──────────────────────────────────────────────────┘
```

Dots are color-coded by sentiment score (red → yellow → green). Clicking a day opens that day's journal entry.

### Trend Line Chart

Sentiment score (0-10) plotted daily over 7/30/90 days with:
- Moving average trendline (7-day smoothing)
- Highlighted peaks and valleys with the entry's mood summary
- Annotation markers for life events the user tags

### Mood Distribution

Pie or horizontal bar chart showing frequency of detected moods:
- grateful: 12 entries (28%)
- stressed: 8 entries (19%)
- content: 7 entries (16%)
- determined: 6 entries (14%)
- anxious: 5 entries (12%)
- other: 5 entries (12%)

### Theme Correlation Matrix

```
              Exercise  Sleep  Work   Social
Positive        0.72    0.58   0.31   0.65
Negative        -0.15   -0.42  0.48   -0.08

Reading: Exercise and social activities correlate with positive moods.
         Poor sleep and work stress correlate with negative moods.
```

---

## Insight Engine

The insight engine analyzes journal entries over time to surface patterns the user might not notice:

### Pattern Types

```
1. CORRELATION
   "Your mood is 2.3 points higher on days you mention exercise."
   Detection: Compare average sentiment of entries containing keyword vs without.

2. TEMPORAL
   "You tend to feel most stressed on Mondays and Tuesdays."
   Detection: Average sentiment by day of week.

3. TREND
   "Your overall mood has been improving over the last 3 weeks."
   Detection: Linear regression on sentiment scores.

4. TRIGGER
   "Entries mentioning 'deadline' have an average mood of 3.2/10."
   Detection: Keywords associated with low/high sentiment.

5. RECURRENCE
   "You've mentioned feeling overwhelmed about quarterly planning 
    3 times in the last month."
   Detection: Repeated theme + negative mood combination.

6. ABSENCE
   "You haven't journaled about social activities in 2 weeks. 
    Your last social entry had a mood of 8.1."
   Detection: Theme that used to appear frequently but has dropped off.

7. STREAK
   "Your longest positive streak was 8 days (April 5-12). 
    Common themes: exercise, creative projects."
   Detection: Consecutive days above a sentiment threshold.
```

### Insight Generation

```typescript
interface Insight {
  type: 'correlation' | 'temporal' | 'trend' | 'trigger' | 'recurrence' | 'absence' | 'streak';
  title: string;            // "Exercise boosts your mood"
  body: string;             // "Your mood is 2.3 points higher on days you mention exercise."
  confidence: number;       // Statistical significance
  dataPoints: number;       // How many entries support this insight
  timeRange: string;        // "Last 30 days"
  actionable: boolean;      // Does this suggest a behavior change?
  suggestion?: string;      // "Consider scheduling exercise on your most stressful days."
}
```

Insights are generated:
- Daily: Quick scan of recent entries after each new journal entry.
- Weekly: Comprehensive analysis of the past 7 days (generates the weekly reflection).
- On-demand: User clicks "Generate Insights" for a full analysis.

### Weekly Reflection

Every Sunday (or user-configured day), IronMic generates a weekly reflection using the LLM:

```
Weekly Reflection Prompt:

You are a supportive journal analyst. Given this week's journal entries with their 
mood data, write a brief (3-5 sentence) reflection that:

1. Acknowledges the overall emotional tone of the week
2. Highlights one positive pattern or moment
3. Gently notes one area of recurring stress (if any)
4. Suggests one small, actionable thing the user could try next week
5. Ends on an encouraging note

Be warm but not saccharine. Be specific (reference actual themes from the entries), 
not generic. Never be judgmental or prescriptive about emotions — all emotions are valid.

This week's entries:
{entries_with_mood_data}
```

---

## Journaling Prompts

### Prompt Categories

```yaml
gratitude:
  - "What are three things you're grateful for today?"
  - "Who made a positive difference in your day?"
  - "What's something small that brought you joy recently?"

reflection:
  - "What was the most challenging part of your day, and how did you handle it?"
  - "What did you learn today that you didn't know yesterday?"
  - "If you could change one thing about today, what would it be?"

mindfulness:
  - "How does your body feel right now? Any tension, energy, or relaxation?"
  - "What sounds can you hear in this moment?"
  - "Describe your current emotional state in three words."

growth:
  - "What's one thing you did today that your past self would be proud of?"
  - "What's a fear you faced this week, even in a small way?"
  - "What skill or habit are you actively working on?"

relationships:
  - "Who did you connect with today, and how did it make you feel?"
  - "Is there a conversation you've been putting off? What's holding you back?"
  - "Who do you want to reach out to this week?"

free_form:
  - "How are you feeling right now? Just speak freely."
  - "What's on your mind today?"
  - "Tell me about your day."
```

### Prompt Selection Logic

```
1. Default: Random prompt from a weighted pool.
2. Streak-aware: If user hasn't journaled in 2+ days, use a gentle re-entry prompt.
3. Mood-aware: If recent entries are consistently low-mood, offer gratitude prompts.
4. Theme-aware: If a theme hasn't appeared recently, prompt about it.
5. User preference: User can pin favorite prompt categories.
6. Skip: User can always skip the prompt and free-form journal.
```

---

## Database Schema

### New Tables

```sql
-- Journal entries (separate from dictation entries)
CREATE TABLE journal_entries (
    id TEXT PRIMARY KEY,                    -- UUID
    date TEXT NOT NULL,                     -- Date (YYYY-MM-DD), one primary entry per day
    raw_transcript TEXT NOT NULL,
    polished_text TEXT,
    
    -- Sentiment scores (from TF.js classifier)
    sentiment_valence REAL,                -- -1.0 to 1.0
    sentiment_arousal REAL,                -- 0.0 to 1.0
    sentiment_class TEXT,                  -- 'negative' | 'neutral' | 'positive'
    sentiment_confidence REAL,             -- 0.0 to 1.0
    
    -- LLM emotional analysis
    moods_json TEXT,                        -- JSON: ["grateful", "stressed", "determined"]
    themes_json TEXT,                       -- JSON: ["work", "exercise", "relationships"]
    mood_arc TEXT,                          -- 'stable' | 'improving' | 'declining' | 'mixed'
    emotional_summary TEXT,                -- One-sentence summary
    gratitude_items_json TEXT,             -- JSON: ["morning sunshine", "smooth deployment"]
    
    -- User overrides
    user_mood_override TEXT,               -- Emoji or mood name if user manually sets mood
    user_mood_score_override REAL,         -- 0-10 if user manually rates their day
    
    -- Metadata
    prompt_used TEXT,                       -- The journaling prompt shown (null if free-form)
    word_count INTEGER,
    duration_seconds REAL,
    
    is_favorite INTEGER DEFAULT 0,         -- Star/favorite entries
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_journal_date ON journal_entries(date);
CREATE INDEX idx_journal_sentiment ON journal_entries(sentiment_valence);

-- Full-text search for journal entries
CREATE VIRTUAL TABLE journal_entries_fts USING fts5(
    raw_transcript,
    polished_text,
    emotional_summary,
    content='journal_entries',
    content_rowid='rowid'
);

-- Mood snapshots for quick chart rendering (one per day)
CREATE TABLE journal_mood_daily (
    date TEXT PRIMARY KEY,                  -- YYYY-MM-DD
    avg_valence REAL,                      -- Average of all entries that day
    primary_mood TEXT,                     -- Most prominent mood
    themes_json TEXT,                       -- Combined themes for the day
    entry_count INTEGER DEFAULT 1
);
CREATE INDEX idx_mood_daily_date ON journal_mood_daily(date);

-- Generated insights
CREATE TABLE journal_insights (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,                     -- correlation | temporal | trend | trigger | etc.
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    confidence REAL,
    data_points INTEGER,
    time_range TEXT,
    suggestion TEXT,
    is_read INTEGER DEFAULT 0,
    is_dismissed INTEGER DEFAULT 0,
    generated_at TEXT NOT NULL,
    expires_at TEXT                         -- Insights become stale
);
CREATE INDEX idx_insights_type ON journal_insights(type);
CREATE INDEX idx_insights_generated ON journal_insights(generated_at);

-- Weekly reflections
CREATE TABLE journal_reflections (
    id TEXT PRIMARY KEY,
    week_start TEXT NOT NULL,              -- YYYY-MM-DD (Monday of the week)
    week_end TEXT NOT NULL,
    reflection_text TEXT NOT NULL,
    avg_sentiment REAL,
    entry_count INTEGER,
    top_moods_json TEXT,
    top_themes_json TEXT,
    generated_at TEXT NOT NULL
);
CREATE INDEX idx_reflections_week ON journal_reflections(week_start);

-- Journaling streaks
CREATE TABLE journal_streaks (
    id TEXT PRIMARY KEY,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    length_days INTEGER NOT NULL,
    avg_sentiment REAL,
    is_current INTEGER DEFAULT 0           -- Is this the active streak?
);
```

### Settings

| Key | Default | Description |
|-----|---------|-------------|
| `journal_enabled` | `false` | Master toggle for journal feature |
| `journal_prompt_enabled` | `true` | Show journaling prompts |
| `journal_prompt_categories` | `["gratitude","reflection","free_form"]` | Active prompt categories |
| `journal_auto_analyze` | `true` | Run sentiment + LLM analysis on save |
| `journal_weekly_reflection` | `true` | Generate weekly reflections |
| `journal_weekly_reflection_day` | `sunday` | Day to generate weekly reflection |
| `journal_streak_notifications` | `true` | Remind user to journal if streak at risk |
| `journal_reminder_time` | `21:00` | Daily reminder time (if enabled) |
| `journal_reminder_enabled` | `false` | Push daily journaling reminder |
| `journal_insight_frequency` | `weekly` | `daily` / `weekly` / `manual` |
| `journal_export_format` | `markdown` | `markdown` / `json` / `csv` |
| `journal_mood_scale` | `emoji` | `emoji` / `numeric` / `both` for manual mood input |
| `journal_retention_days` | `0` | 0 = keep forever, N = auto-delete after N days |

---

## Integration with Existing Systems

### Dictation Pipeline (existing)

Journal entries use the same Whisper STT and LLM cleanup pipeline as regular dictation. The difference is routing: when the user is on the Journal page, dictation creates a `journal_entries` record instead of an `entries` record. The recording indicator, VAD, and turn detection all work identically.

### Analytics (existing)

Journal mood data integrates with the existing analytics dashboard:
- New section: "Mood & Journaling" alongside existing "Productivity" analytics
- Shared date range controls and chart styling
- Journal word counts contribute to overall dictation volume metrics

### Semantic Search (existing)

Journal entries are embedded using the same USE model for semantic search. Searching "when did I feel overwhelmed" returns both regular entries and journal entries, with mood context.

### Notifications (existing)

The notification system delivers journal-related alerts:
- Streak risk: "You've journaled 6 days in a row! Keep it going?"
- Weekly reflection ready: "Your weekly reflection is ready to read."
- New insights: "New insight: Exercise correlates with higher mood."
- Reminder: "Time for your evening journal."

### TTS Read-Back (existing)

Users can listen to past journal entries via the existing Kokoro TTS. The weekly reflection can also be read aloud — a "podcast-style" summary of your emotional week.

### Macros (planned)

Journal data becomes queryable in the macro system:
- `query_journal_entries: { date_range: this_week, min_sentiment: 0.7 }`
- `llm_transform: "What were my happiest moments this month?"`
- Macro: "Therapy prep" — query journal entries from last 2 weeks, extract recurring themes and stressors, format as a discussion guide.

---

## Privacy Considerations

- **Journal entries are the most sensitive data in IronMic.** The journal stores unfiltered emotional expression. All journal data is stored in the same local SQLite database as other entries, benefiting from the same zero-network, zero-telemetry guarantees.
- **Sentiment analysis is local.** Both the TF.js classifier and LLM emotional analysis run entirely on-device. No mood data, emotional tags, or journal content is transmitted anywhere.
- **Insights are derived locally.** Pattern detection and correlation analysis run as local computations on SQLite data. No external analytics service.
- **Export is user-initiated.** Journal export (markdown/JSON) only happens when the user explicitly requests it. No automatic syncing, no cloud backup.
- **Deletion is thorough.** "Delete journal entry" removes the entry, its mood data, its FTS index entry, and any insights derived from it. "Delete all journal data" purges all journal tables.
- **No diagnostic inference.** IronMic detects mood and sentiment, not clinical conditions. It never suggests diagnoses, never claims to detect depression or anxiety disorders, and includes a disclaimer that it is not a substitute for professional mental health support.

---

## Implementation Phases

### Phase 1: Journal Entry Type and Page
- Add `journal_entries` table and FTS index (schema migration)
- Implement `journal.rs` in Rust core — CRUD operations
- Build `JournalPage.tsx` — date-based entry list with current-day editor
- Build `JournalEditor.tsx` — dictation integration for journal entries
- Build `JournalCalendar.tsx` — calendar view with entry dots
- Journaling prompts (random from pool, no intelligence yet)
- **Deliverable:** Users can dictate and browse journal entries by date

### Phase 2: Sentiment Analysis
- Implement `SentimentClassifier.ts` — TF.js LSTM model for valence/arousal
- Train or fine-tune on conversational/diary text (ship pre-trained weights, ~2MB)
- Run sentiment classifier on every journal entry save
- Store scores in `journal_entries` table
- Color-code calendar dots by sentiment
- Build `MoodTrendChart.tsx` — basic sentiment line chart over time
- **Deliverable:** Automatic mood scoring with visual trend

### Phase 3: LLM Emotional Analysis
- Implement emotional analysis prompt for Mistral LLM
- Extract moods, themes, mood arc, summary, gratitude items
- `MoodSelector.tsx` — manual mood override (emoji picker)
- `MoodDistribution.tsx` — mood frequency chart
- `ThemeCloud.tsx` — theme word cloud
- Journal entry search by mood/theme
- **Deliverable:** Rich emotional tagging and filtering

### Phase 4: Insights and Weekly Reflections
- Implement `InsightEngine.ts` — correlation, temporal, trend, trigger patterns
- Build `InsightCard.tsx` — individual insight display
- Build `WeeklyReflection.tsx` — LLM-generated weekly summary
- `JournalStreak.tsx` — streak tracking and motivation
- Smart prompt selection based on mood history
- **Deliverable:** Data-driven emotional insights and reflections

### Phase 5: Export and Polish
- Build `JournalExport.tsx` — export as markdown, JSON, or CSV
- Journal entry favorites and filtering
- Mood comparison across time periods (this month vs last month)
- Theme correlation matrix visualization
- Integration with macros and notification system
- Optional daily reminder notification
- **Deliverable:** Complete journaling experience with data portability

---

## Performance Considerations

| Operation | Time | Notes |
|-----------|------|-------|
| TF.js sentiment classification | ~20ms | LSTM model, ~2MB, Web Worker |
| LLM emotional analysis | 2-4s | Mistral 7B via llama.cpp |
| Journal entry save (SQLite) | <5ms | Insert + FTS update |
| Mood daily aggregation | <10ms | SQLite aggregate query |
| Insight generation (30 days) | ~500ms | Statistical analysis on cached data |
| Weekly reflection (LLM) | 3-5s | Mistral 7B summarization |
| Calendar render (30 days) | <20ms | Read + color computation |
| Trend chart render (90 days) | <30ms | Data query + chart library |
| Journal search (FTS5) | <50ms | Full-text search |

### Memory

- TF.js sentiment model: ~2MB (ships with app)
- Journal data (1 year daily): ~5MB in SQLite
- Insight cache: <500KB
- Chart data in memory: <1MB

---

## N-API Surface Additions

```typescript
// --- Journal Entries ---
createJournalEntry(entry: string): Promise<string>              // JSON → returns id
updateJournalEntry(id: string, updates: string): Promise<void>
deleteJournalEntry(id: string): Promise<void>
getJournalEntry(id: string): Promise<string>                    // JSON or "null"
getJournalEntryByDate(date: string): Promise<string>            // JSON or "null"
listJournalEntries(limit: number, offset: number, 
                   fromDate?: string, toDate?: string): Promise<string>
searchJournalEntries(query: string, limit: number): Promise<string>
favoriteJournalEntry(id: string, favorite: boolean): Promise<void>

// --- Mood Data ---
updateJournalMood(id: string, moodJson: string): Promise<void>  // LLM analysis results
updateJournalSentiment(id: string, valence: number, arousal: number,
                       sentimentClass: string, confidence: number): Promise<void>
getMoodDaily(fromDate: string, toDate: string): Promise<string>  // JSON: daily aggregates
getMoodDistribution(fromDate: string, toDate: string): Promise<string>
getThemeDistribution(fromDate: string, toDate: string): Promise<string>

// --- Insights ---
saveInsight(insightJson: string): Promise<string>
listInsights(unreadOnly: boolean, limit: number): Promise<string>
markInsightRead(id: string): Promise<void>
dismissInsight(id: string): Promise<void>
deleteOldInsights(olderThanDays: number): Promise<number>

// --- Reflections ---
saveReflection(reflectionJson: string): Promise<string>
getReflection(weekStart: string): Promise<string>               // JSON or "null"
listReflections(limit: number): Promise<string>

// --- Streaks ---
getCurrentStreak(): Promise<string>                              // JSON: { length, start, avg_sentiment }
getLongestStreak(): Promise<string>
updateStreaks(journalDate: string): Promise<void>

// --- Export ---
exportJournal(fromDate: string, toDate: string, 
              format: string): Promise<string>                   // markdown | json | csv
```

---

## New Files

### Rust Core

| File | Purpose |
|------|---------|
| `rust-core/src/storage/journal.rs` | Journal entries, moods, insights, reflections, streaks CRUD |

### Electron App

| File | Purpose |
|------|---------|
| `electron-app/src/renderer/components/journal/JournalPage.tsx` | Main journal view |
| `electron-app/src/renderer/components/journal/JournalEntry.tsx` | Single entry display |
| `electron-app/src/renderer/components/journal/JournalEditor.tsx` | Dictation + editing |
| `electron-app/src/renderer/components/journal/JournalCalendar.tsx` | Calendar with mood dots |
| `electron-app/src/renderer/components/journal/JournalPrompt.tsx` | Prompt display |
| `electron-app/src/renderer/components/journal/MoodSelector.tsx` | Manual mood picker |
| `electron-app/src/renderer/components/journal/MoodTrendChart.tsx` | Sentiment line chart |
| `electron-app/src/renderer/components/journal/MoodDistribution.tsx` | Mood frequency chart |
| `electron-app/src/renderer/components/journal/EmotionTimeline.tsx` | Emotion tags timeline |
| `electron-app/src/renderer/components/journal/ThemeCloud.tsx` | Theme word cloud |
| `electron-app/src/renderer/components/journal/WeeklyReflection.tsx` | Weekly summary |
| `electron-app/src/renderer/components/journal/InsightCard.tsx` | Individual insight |
| `electron-app/src/renderer/components/journal/JournalStreak.tsx` | Streak counter |
| `electron-app/src/renderer/components/journal/JournalExport.tsx` | Export functionality |
| `electron-app/src/renderer/components/settings/JournalSettings.tsx` | Settings |
| `electron-app/src/renderer/stores/useJournalStore.ts` | Journal state |
| `electron-app/src/renderer/services/tfjs/SentimentClassifier.ts` | TF.js sentiment model |
| `electron-app/src/renderer/services/JournalService.ts` | Entry management |
| `electron-app/src/renderer/services/MoodAnalyzer.ts` | Sentiment + LLM orchestration |
| `electron-app/src/renderer/services/InsightEngine.ts` | Pattern detection |
| `electron-app/src/renderer/services/PromptGenerator.ts` | Prompt selection |

### Files to Modify

| File | Change |
|------|--------|
| `rust-core/src/lib.rs` | Add N-API exports for journal functions |
| `rust-core/src/storage/db.rs` | Add migration for journal tables |
| `electron-app/src/main/ipc-handlers.ts` | Wire journal IPC channels |
| `electron-app/src/preload/index.ts` | Expose journal API to renderer |
| `electron-app/src/renderer/App.tsx` | Add Journal page route |
| `electron-app/src/renderer/components/Layout.tsx` | Add Journal nav item |
| `electron-app/src/renderer/components/SettingsPanel.tsx` | Add journal settings section |
| `electron-app/src/renderer/components/SearchBar.tsx` | Include journal entries in search |
| `electron-app/src/renderer/workers/ml-worker.ts` | Load sentiment classifier model |

---

## Open Questions

1. **Journal vs entry overlap.** Should journal entries be a completely separate data type, or a tagged subset of regular entries? Separate tables keep the data model clean, but the user might want to search across both dictation entries and journal entries simultaneously. A shared base table with a `type` column is an alternative.

2. **Sentiment model accuracy.** The TF.js sentiment model will be trained on general text, but voice-transcribed journal entries have a different distribution (more conversational, more emotional, more first-person). Fine-tuning on diary-style text would improve accuracy but requires training data. Should IronMic ship a diary-tuned model, or fine-tune on the user's own entries over time?

3. **Mood manual override priority.** If the user manually sets their mood to "happy" but the sentiment classifier reads the entry as negative, which takes precedence for trend charts? The user's subjective assessment should probably win, but then the classifier's output becomes invisible.

4. **Therapeutic disclaimers.** Mood tracking apps have a responsibility to not overclaim. IronMic should clearly state it is not a diagnostic tool and not a substitute for therapy. Where should this disclaimer appear — in settings, in the journal page header, or as a one-time acknowledgment during setup?

5. **Data sensitivity for export.** Journal exports contain the most intimate data in IronMic. Should exports be encrypted by default, or is plaintext markdown sufficient since the user is explicitly requesting it?

6. **Multiple entries per day.** The schema allows one "primary" entry per date, but users might want to journal multiple times a day (morning, afternoon, evening). Should the calendar show a single merged mood, or allow multiple entries per day?

7. **Negative mood spiraling.** If a user journals consistently negative entries, should IronMic proactively suggest resources (crisis hotlines, therapy directories), or would that be overstepping? This is a sensitive design decision with safety implications.

---

## Dependencies

| Dependency | Already in project? | Purpose |
|-----------|---------------------|---------|
| TF.js | Yes | Sentiment classifier runtime |
| LLM (llama.cpp) | Yes | Emotional analysis and reflections |
| `recharts` or `d3` | **Check if analytics uses one** | Mood trend charts |
| Sentiment LSTM model | **New model asset (~2MB)** | Pre-trained sentiment classifier |
| TTS (Kokoro) | Yes | Read-back of journal entries and reflections |

One new TF.js model asset (~2MB). Chart library may already be present from existing analytics; if not, one new npm dependency.

---

## Success Metrics

- Journal adoption: >20% of users enable and use the journal feature at least once
- Journaling consistency: Active journal users average 4+ entries per week after first month
- Sentiment accuracy: >80% agreement between TF.js classifier and user manual mood override
- LLM mood extraction: >85% of mood tags are relevant to the entry (user-evaluated)
- Insight engagement: >50% of generated insights are read (not immediately dismissed)
- Weekly reflection satisfaction: >70% of users rate weekly reflections as "helpful" or "very helpful"
- Streak retention: >60% of users who start a 7-day streak continue to 14 days
- Data safety: Zero incidents of journal data leaving the device
