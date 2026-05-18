# Multi-Language Dictation and Real-Time Translation

## Overview

Add multilingual speech recognition and on-device translation to IronMic so users can dictate in one language and receive output in another — or simply dictate in any of the 99 languages Whisper supports. A bilingual professional dictates meeting notes in Spanish and gets polished English text. A researcher reads a German paper aloud and pastes the English translation. A multilingual team takes meeting notes that auto-translate for each participant's preferred language.

Whisper already supports 99 languages for speech-to-text. The missing pieces are: language detection and selection UI, a local translation model (or repurposing the existing Mistral LLM for translation), per-entry language metadata, and a multi-output pipeline that produces both the original transcript and the translated version side by side.

All translation happens locally via the existing llama.cpp infrastructure. No cloud translation APIs, no data leaving the device. This makes IronMic viable for translating sensitive content (legal depositions, medical records, confidential business discussions) where cloud-based translation services are prohibited by policy.

---

## What This Enables

- **Bilingual professional workflow:**
  ```
  You dictate in Spanish:
    "Necesitamos revisar el presupuesto del proyecto antes del viernes. 
     Los costos de infraestructura han subido un quince por ciento 
     desde la última estimación."
  
  IronMic produces:
    Original (Spanish): [raw transcript above]
    Translation (English): "We need to review the project budget before Friday. 
     Infrastructure costs have increased by fifteen percent since the last estimate."
  
  Both versions saved. English copied to clipboard (user's preferred output language).
  ```

- **Meeting notes in a foreign language:**
  ```
  User's native language: English
  Meeting language: Japanese
  
  Meeting transcript is captured in Japanese, then auto-translated to English.
  Both versions stored. User reviews the English summary while having the 
  Japanese original available for verification.
  ```

- **Language learning:**
  ```
  You dictate in French (practicing):
    "Je voudrais réserver une table pour deux personnes ce soir."
  
  IronMic shows:
    Your French: "Je voudrais réserver une table pour deux personnes ce soir."
    English: "I would like to reserve a table for two people tonight."
    Corrections: (none — grammar was correct!)
  
  Or if you made a mistake:
    Your French: "Je veux réserver un table pour deux personne ce soir."
    Corrected: "Je voudrais réserver une table pour deux personnes ce soir."
    English: "I would like to reserve a table for two people tonight."
    Notes: "table" is feminine (une table), "personnes" needs plural -s
  ```

- **Document translation by voice:**
  ```
  User reads a paragraph from a German document aloud.
  IronMic transcribes the German, translates to English, 
  copies English to clipboard for pasting into their notes.
  ```

- **Multilingual search:**
  ```
  User searches "budget meeting" across all entries.
  Results include entries originally dictated in English, Spanish, and French
  that discuss budget topics — semantic search works across languages 
  via cross-lingual embeddings.
  ```

---

## Architecture

### New Components

```
Rust Core
├── translation/
│   ├── mod.rs
│   ├── translator.rs          # LLM-based translation pipeline
│   ├── language_detect.rs     # Language identification from text
│   ├── prompts.rs             # Translation prompt templates per language pair
│   └── glossary.rs            # User-defined translation glossary (term pairs)

Electron App
├── renderer/
│   ├── components/
│   │   ├── translation/
│   │   │   ├── LanguageSelector.tsx        # Input/output language picker
│   │   │   ├── TranslationToggle.tsx       # Enable/disable translation per entry
│   │   │   ├── TranslationView.tsx         # Side-by-side original + translation
│   │   │   ├── LanguageBadge.tsx           # Language indicator on entry cards
│   │   │   ├── GlossaryManager.tsx         # Custom term translation pairs
│   │   │   └── LanguageLearningPanel.tsx   # Grammar corrections + notes (optional)
│   │   │
│   │   └── settings/
│   │       └── LanguageSettings.tsx        # Language preferences, default pairs
│   │
│   ├── stores/
│   │   └── useLanguageStore.ts             # Active languages, translation state
│   │
│   └── services/
│       ├── TranslationService.ts           # Orchestrates translation pipeline
│       └── LanguageDetector.ts             # Client-side language detection heuristics
```

### Translation Pipeline

```
[User speaks in Spanish]
        │
        ▼
[VAD → Audio Buffer]
        │
        ▼
[Whisper STT]
  language parameter:
    ├── Explicit: user selected "Spanish" → Whisper decodes as Spanish
    └── Auto-detect: Whisper detects language from first 30s of audio
        │
        ▼
[Raw Transcript (Spanish)]
  "Necesitamos revisar el presupuesto del proyecto antes del viernes."
        │
        ├──────────────────────────────────────┐
        │                                      │
        ▼                                      ▼
[LLM Cleanup (Spanish)]                [LLM Translation (Spanish → English)]
  Same cleanup prompt                    Translation prompt with glossary
  but in Spanish                         and domain context
        │                                      │
        ▼                                      ▼
[Polished Spanish Text]               [English Translation]
        │                                      │
        └──────────────┬───────────────────────┘
                       │
                       ▼
              [Store Entry]
                id: uuid
                raw_transcript: "Necesitamos..."
                polished_text: "Necesitamos..." (cleaned Spanish)
                translated_text: "We need to review..."
                source_language: "es"
                target_language: "en"
                translation_confidence: 0.92
                       │
                       ▼
              [Copy to Clipboard]
                Based on output_language preference:
                  "original" → Spanish text
                  "translated" → English text
                  "both" → "Spanish: ... | English: ..."
```

### System Diagram

```
┌─────────────────────────────────────────────────────────┐
│  User Settings                                           │
│                                                          │
│  Input Language:  [Auto-Detect ▼]  (or specific lang)   │
│  Output Language: [English ▼]                            │
│  Translation:     [◉ On]                                 │
│  Output Mode:     [Translated ▼]  (original/both)       │
│                                                          │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────┐
│  Transcription Pipeline                                 │
│                                                         │
│  [Audio] ──→ [Whisper STT] ──→ [Raw Transcript]       │
│                   │                    │                 │
│                   │              ┌─────┴─────┐          │
│            language detected     │           │          │
│                   │              ▼           ▼          │
│                   │         [Cleanup]   [Translate]     │
│                   │           (LLM)       (LLM)        │
│                   │              │           │          │
│                   │              ▼           ▼          │
│                   │         [Polished]  [Translated]    │
│                   │              │           │          │
│                   │              └─────┬─────┘          │
│                   │                    │                 │
│                   └────────────────────┤                 │
│                                        ▼                │
│                               [Save Entry]              │
│                          (all versions + language tags)  │
│                                        │                │
│                                        ▼                │
│                             [Clipboard / Editor]        │
│                          (user's preferred output)      │
│                                                         │
└────────────────────────────────────────────────────────┘
```

---

## Language Support

### Tier 1: Full Support (Whisper + Translation + Cleanup)

Languages with strong Whisper accuracy and good LLM translation quality:

| Language | Code | Whisper WER | Translation Quality |
|----------|------|-------------|-------------------|
| English | en | <5% | N/A (native) |
| Spanish | es | <8% | Excellent |
| French | fr | <8% | Excellent |
| German | de | <8% | Excellent |
| Portuguese | pt | <10% | Excellent |
| Italian | it | <10% | Excellent |
| Dutch | nl | <10% | Very Good |
| Russian | ru | <10% | Very Good |
| Japanese | ja | <12% | Good |
| Chinese (Mandarin) | zh | <12% | Good |
| Korean | ko | <12% | Good |

### Tier 2: Good Support (Whisper + Translation)

Languages with acceptable Whisper accuracy. Cleanup may be lower quality:

| Language | Code | Whisper WER | Notes |
|----------|------|-------------|-------|
| Arabic | ar | <15% | RTL text handling needed |
| Hindi | hi | <15% | Devanagari script |
| Turkish | tr | <12% | Agglutinative structure |
| Polish | pl | <12% | |
| Swedish | sv | <12% | |
| Czech | cs | <15% | |
| Greek | el | <15% | |
| Hebrew | he | <15% | RTL text handling needed |
| Thai | th | <18% | No word boundaries |
| Vietnamese | vi | <15% | Tonal language |

### Tier 3: Basic Support (Whisper only, translation may be rough)

Whisper can transcribe these languages, but LLM translation quality may be inconsistent. Users are warned about translation quality.

### Language Detection

Whisper has built-in language detection from the first 30 seconds of audio. IronMic also provides:

1. **User-set language:** Explicit selection overrides auto-detection (most reliable).
2. **Whisper auto-detect:** Used when language is set to "Auto-Detect."
3. **Text-based confirmation:** After transcription, a lightweight text language detector (n-gram based, runs in <1ms) confirms the language. If Whisper and text detection disagree, flag it.
4. **Per-entry override:** User can correct the detected language on any entry.

---

## Translation Engine

### LLM-Based Translation

Translation uses the existing Mistral 7B model via llama.cpp. The quality of 7B model translation is sufficient for conversational and business text. For specialized domains, the user-defined glossary improves accuracy on technical terms.

```
Translation Prompt:

You are a professional translator. Translate the following {source_language} 
text into {target_language}. 

Rules:
- Translate accurately and naturally — do not transliterate or leave words untranslated
  unless they are proper nouns, brand names, or technical terms that are used in the 
  target language as-is
- Preserve the speaker's tone (formal, casual, technical, emotional)
- Preserve formatting: paragraphs, lists, line breaks
- If a sentence is ambiguous, choose the most likely interpretation based on context
- Apply any glossary overrides provided below
- Output ONLY the translated text, nothing else

{glossary_section}

{source_language} text:
{text}
```

### Glossary System

Users can define custom term pairs that override the LLM's default translations:

```yaml
# User glossary entries
glossary:
  - source: "presupuesto"
    target: "budget"
    context: "financial"
    note: "Not 'estimate' — we use 'budget' in our org"
    
  - source: "Sprint Review"
    target: "Sprint Review"
    context: "agile"
    note: "Keep English term as-is, even in Spanish context"
    
  - source: "Datenschutz"
    target: "data privacy"
    context: "legal"
    note: "Specifically 'data privacy', not 'data protection'"
```

Glossary terms are injected into the translation prompt:

```
Glossary (use these translations when these terms appear):
- "presupuesto" → "budget" (financial context)
- "Sprint Review" → "Sprint Review" (keep as-is)
```

---

## Database Schema

### Modified Tables

```sql
-- Extend entries table with language fields
ALTER TABLE entries ADD COLUMN source_language TEXT;          -- ISO 639-1: "es", "en", "ja"
ALTER TABLE entries ADD COLUMN target_language TEXT;          -- Language translated to (null if no translation)
ALTER TABLE entries ADD COLUMN translated_text TEXT;          -- Translated version (null if no translation)
ALTER TABLE entries ADD COLUMN translation_confidence REAL;   -- 0-1 model confidence
ALTER TABLE entries ADD COLUMN language_detected_by TEXT;     -- 'user' | 'whisper' | 'auto'
```

### New Tables

```sql
-- Translation glossary (custom term pairs)
CREATE TABLE translation_glossary (
    id TEXT PRIMARY KEY,                    -- UUID
    source_term TEXT NOT NULL,             -- Term in source language
    source_language TEXT NOT NULL,          -- ISO 639-1
    target_term TEXT NOT NULL,             -- Translated term
    target_language TEXT NOT NULL,          -- ISO 639-1
    context TEXT,                           -- Domain hint: "financial", "legal", "medical"
    note TEXT,                             -- Why this translation was chosen
    usage_count INTEGER DEFAULT 0,         -- How often this term has been applied
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_glossary_source ON translation_glossary(source_term, source_language);
CREATE INDEX idx_glossary_pair ON translation_glossary(source_language, target_language);
CREATE UNIQUE INDEX idx_glossary_unique ON translation_glossary(
    source_term, source_language, target_language
);

-- Language usage statistics (for smart defaults)
CREATE TABLE language_stats (
    id TEXT PRIMARY KEY,
    language_code TEXT NOT NULL,            -- ISO 639-1
    usage_type TEXT NOT NULL,              -- 'dictation' | 'translation_source' | 'translation_target'
    usage_count INTEGER DEFAULT 0,
    last_used_at TEXT NOT NULL
);
CREATE INDEX idx_lang_stats_code ON language_stats(language_code);

-- Translation corrections (user edits to translations for learning)
CREATE TABLE translation_corrections (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    source_text TEXT NOT NULL,             -- Original segment
    original_translation TEXT NOT NULL,    -- What the LLM produced
    corrected_translation TEXT NOT NULL,   -- What the user changed it to
    source_language TEXT NOT NULL,
    target_language TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_trans_corrections_pair ON translation_corrections(source_language, target_language);
```

### Settings

| Key | Default | Description |
|-----|---------|-------------|
| `translation_enabled` | `false` | Master toggle for translation |
| `input_language` | `auto` | Dictation language (`auto` for auto-detect, or ISO 639-1 code) |
| `output_language` | `en` | Preferred output/translation language |
| `translation_auto` | `false` | Automatically translate when input != output language |
| `translation_output_mode` | `translated` | `original` / `translated` / `both` for clipboard |
| `translation_cleanup_source` | `true` | Also run LLM cleanup on the source language text |
| `translation_glossary_enabled` | `true` | Apply user glossary during translation |
| `language_learning_mode` | `false` | Show grammar corrections and learning notes |
| `translation_side_by_side` | `true` | Show original and translation side by side in timeline |

---

## Integration with Existing Systems

### Whisper STT (existing)

Whisper's `language` parameter controls which language to decode. Changes:

```rust
// Current:
fn transcribe(audio: &[f32]) -> Result<String> {
    let params = WhisperParams::default();
    // Always decodes as English
    whisper.transcribe(audio, params)
}

// New:
fn transcribe(audio: &[f32], language: Option<&str>) -> Result<TranscriptionResult> {
    let params = WhisperParams::default();
    match language {
        Some(lang) => params.set_language(lang),
        None => params.set_language("auto"),  // Auto-detect
    };
    let result = whisper.transcribe(audio, params);
    TranscriptionResult {
        text: result.text,
        detected_language: result.language,     // Whisper's detected language
        language_probability: result.language_probability,
    }
}
```

### LLM Cleanup (existing)

The cleanup pipeline is extended to handle non-English text. When the source language is not English, the cleanup prompt is adjusted:

```
// Cleanup prompt for non-English:
You are a text cleanup assistant for {language_name} text. You receive raw 
speech-to-text transcriptions in {language_name} and produce clean, polished 
{language_name} text.

[Same rules as English cleanup, but applied to the source language]
```

The translation step runs after cleanup, receiving the polished source text as input.

### Semantic Search (existing)

The Universal Sentence Encoder (USE) supports multilingual embeddings, but the version currently used (English-only) would need to be swapped for the multilingual USE variant (~100MB vs ~30MB). Cross-lingual semantic search then works naturally: searching "budget meeting" in English returns Spanish entries about "reunión de presupuesto."

### Entry Cards (existing)

Entry cards in the timeline gain:
- A language badge (flag icon or "ES", "EN", "FR")
- A toggle between original and translated text (similar to raw/polished toggle)
- Side-by-side view option

### Analytics (existing)

New analytics dimensions:
- Entries per language over time
- Translation volume (how many entries were translated)
- Most common language pairs
- Translation correction rate (how often users edit translations)

---

## Privacy Considerations

- **All translation is local.** The existing Mistral 7B LLM handles translation via llama.cpp. No Google Translate, no DeepL, no cloud API. Text never leaves the device.
- **Language metadata is minimal.** Entries store only the ISO 639-1 code ("es", "en"), not voice characteristics or accent data.
- **Glossary is user-controlled.** Custom term pairs are stored in local SQLite. No sharing unless the user explicitly exports.
- **Translation corrections are local training data.** Corrections improve translation quality for the user's specific domain but never leave the device.
- **No accent profiling.** IronMic detects what language is being spoken, not what accent the speaker has. No demographic inference is made from voice or language data.

---

## Implementation Phases

### Phase 1: Multi-Language Whisper Support
- Extend Whisper integration to accept a `language` parameter
- Language auto-detection using Whisper's built-in detector
- `LanguageSelector.tsx` UI in Settings and recording indicator
- Store `source_language` on entries
- Language badge on entry cards
- **Deliverable:** Dictate in any Whisper-supported language, transcription in that language

### Phase 2: LLM Translation Pipeline
- Implement `translator.rs` — translation via Mistral LLM with prompt engineering
- Translation prompt templates for top 10 language pairs
- Auto-translate when source != output language
- Store `translated_text` on entries
- Toggle between original and translated text on entry cards
- **Deliverable:** Dictate in Spanish, get English translation in clipboard

### Phase 3: Glossary and Translation Quality
- Implement `glossary.rs` — user-defined term pairs
- `GlossaryManager.tsx` — add/edit/import/export glossary entries
- Translation corrections: user edits to translations are tracked
- Glossary injection into translation prompts
- Language-specific LLM cleanup prompts for top 10 languages
- **Deliverable:** Domain-accurate translations with custom terminology

### Phase 4: Side-by-Side View and Search
- `TranslationView.tsx` — side-by-side original + translation display
- Translation on-demand for existing entries ("Translate now" button)
- Extend FTS5 search to include `translated_text` column
- Swap USE model for multilingual variant for cross-lingual semantic search
- Language-filtered timeline views
- **Deliverable:** Full multilingual experience with cross-language search

### Phase 5: Language Learning Mode
- Grammar correction feedback for non-native speakers
- Vocabulary suggestions and alternative phrasings
- `LanguageLearningPanel.tsx` — per-entry feedback display
- Pronunciation tips (based on common transcription errors for the user's native language)
- Progress tracking: vocabulary growth, error rate trends
- **Deliverable:** IronMic as a language practice tool

---

## Performance Considerations

| Operation | Time | Notes |
|-----------|------|-------|
| Whisper STT (English) | ~2s for 30s audio | Baseline, no change |
| Whisper STT (non-English) | ~2-3s for 30s audio | Slightly slower for some languages |
| Whisper language detection | ~200ms | First 30s of audio analyzed |
| Text language detection (n-gram) | <1ms | Confirmation check on transcript |
| LLM translation (200 words) | 3-5s | Mistral 7B via llama.cpp |
| LLM cleanup (source language) | 2-4s | Same as English cleanup |
| Glossary lookup + injection | <2ms | HashMap lookup |
| Full pipeline (dictate + cleanup + translate) | ~7-12s | Cleanup and translation sequential |

### Optimization: Parallel Cleanup and Translation

Cleanup (source language) and translation can run in parallel if the LLM supports concurrent requests, or sequentially if single-threaded:

```
Sequential (current LLM is single-threaded):
  Whisper (2s) → Cleanup (3s) → Translation (4s) = ~9s total

Parallel (if LLM supports batching):
  Whisper (2s) → [Cleanup (3s) | Translation (4s)] = ~6s total
```

For the first release, sequential execution is simpler and sufficient. The total latency (7-12s) is acceptable for a dictation workflow where the user is switching apps or composing thoughts between dictations.

### Memory

- No new models required (uses existing Whisper + Mistral)
- Multilingual USE model: ~100MB (replaces ~30MB English-only model, net +70MB)
- Glossary data: <1MB in SQLite
- Translation prompt templates: ~30KB

---

## N-API Surface Additions

```typescript
// --- Translation ---
translateText(text: string, sourceLang: string, targetLang: string): Promise<string>
detectLanguage(text: string): Promise<{ language: string, confidence: number }>

// --- Glossary ---
addGlossaryEntry(entry: string): Promise<string>      // JSON entry → returns id
updateGlossaryEntry(id: string, updates: string): Promise<void>
deleteGlossaryEntry(id: string): Promise<void>
listGlossaryEntries(sourceLang?: string, targetLang?: string): Promise<string>
importGlossary(csvContent: string): Promise<number>     // returns count imported
exportGlossary(sourceLang: string, targetLang: string): Promise<string>  // CSV

// --- Translation Corrections ---
logTranslationCorrection(entryId: string, original: string, corrected: string,
                         sourceLang: string, targetLang: string): Promise<void>
getTranslationCorrections(sourceLang: string, targetLang: string, 
                          limit: number): Promise<string>

// --- Language Stats ---
getLanguageStats(): Promise<string>                    // JSON: usage counts per language
getSupportedLanguages(): Promise<string>                // JSON: language list with tier info
```

---

## New Files

### Rust Core

| File | Purpose |
|------|---------|
| `rust-core/src/translation/mod.rs` | Module exports |
| `rust-core/src/translation/translator.rs` | LLM-based translation pipeline |
| `rust-core/src/translation/language_detect.rs` | Text-based language identification |
| `rust-core/src/translation/prompts.rs` | Translation prompt templates per language pair |
| `rust-core/src/translation/glossary.rs` | Glossary lookup and prompt injection |
| `rust-core/src/storage/translation.rs` | Glossary CRUD, corrections, language stats |

### Electron App

| File | Purpose |
|------|---------|
| `electron-app/src/renderer/components/translation/LanguageSelector.tsx` | Input/output language picker |
| `electron-app/src/renderer/components/translation/TranslationToggle.tsx` | Per-entry translation toggle |
| `electron-app/src/renderer/components/translation/TranslationView.tsx` | Side-by-side display |
| `electron-app/src/renderer/components/translation/LanguageBadge.tsx` | Language indicator badge |
| `electron-app/src/renderer/components/translation/GlossaryManager.tsx` | Glossary management UI |
| `electron-app/src/renderer/components/translation/LanguageLearningPanel.tsx` | Grammar feedback |
| `electron-app/src/renderer/components/settings/LanguageSettings.tsx` | Language preferences |
| `electron-app/src/renderer/stores/useLanguageStore.ts` | Language state management |
| `electron-app/src/renderer/services/TranslationService.ts` | Translation orchestration |
| `electron-app/src/renderer/services/LanguageDetector.ts` | Client-side language detection |

### Files to Modify

| File | Change |
|------|--------|
| `rust-core/src/lib.rs` | Add N-API exports for translation and glossary functions |
| `rust-core/src/storage/db.rs` | Add migration for language columns on entries + new tables |
| `rust-core/src/transcription/whisper.rs` | Accept `language` parameter, return detected language |
| `rust-core/src/llm/cleanup.rs` | Support non-English cleanup prompts |
| `rust-core/src/llm/prompts.rs` | Add language-specific cleanup prompt templates |
| `electron-app/src/main/ipc-handlers.ts` | Wire translation IPC channels |
| `electron-app/src/preload/index.ts` | Expose translation API to renderer |
| `electron-app/src/renderer/components/EntryCard.tsx` | Add language badge, translation toggle |
| `electron-app/src/renderer/components/RecordingIndicator.tsx` | Show active input language |
| `electron-app/src/renderer/components/SettingsPanel.tsx` | Add language settings section |
| `electron-app/src/renderer/components/SearchBar.tsx` | Search across translated_text |
| `electron-app/src/renderer/stores/useEntryStore.ts` | Add translation fields to entry type |
| `electron-app/src/renderer/stores/useRecordingStore.ts` | Add language selection state |
| `electron-app/src/renderer/components/AnalyticsDashboard.tsx` | Add language analytics |

---

## Open Questions

1. **Translation model quality.** Mistral 7B is a general-purpose model, not a translation specialist. For common language pairs (Spanish-English, French-English), quality is good. For less common pairs (Thai-Portuguese), quality may be poor. Should IronMic support downloading a dedicated translation model (like NLLB-200) as an alternative to Mistral, or is Mistral sufficient?

2. **Right-to-left language support.** Arabic and Hebrew are RTL languages. The TipTap editor and timeline cards need CSS `direction: rtl` for these languages. How deep should RTL support go — just text display, or full UI mirroring?

3. **CJK text segmentation.** Chinese, Japanese, and Korean don't use spaces between words. When displaying raw transcripts, should IronMic add spaces for readability, or preserve the natural unsegmented format? The cleanup LLM can handle this, but the raw transcript view may look dense.

4. **Translation latency.** Adding a translation step increases the dictation pipeline from ~4-5s to ~7-12s. Is this acceptable, or should translation run asynchronously (show original text immediately, fill in translation when ready)?

5. **Multilingual meetings.** If a meeting has speakers in multiple languages, the current architecture handles one language per entry. Should there be a per-segment language detection for meetings, where different segments can have different source languages and independent translations?

6. **Glossary sharing.** Teams working on the same project want shared terminology. Should glossaries support export/import in standard formats (TBX, CSV) for sharing via file exchange, similar to the macro sharing model?

7. **Translation memory.** Professional translators use translation memory (TM) — caching translated segments for reuse. Should IronMic build up a TM from past translations to improve consistency and reduce LLM calls for repeated content?

---

## Dependencies

| Dependency | Already in project? | Purpose |
|-----------|---------------------|---------|
| Whisper multilingual | Yes (built-in) | Speech-to-text in 99 languages |
| Mistral 7B (llama.cpp) | Yes | Translation via prompting |
| `whatlang` | **No — needs adding** | Lightweight text-based language detection |
| Multilingual USE | **Replaces existing USE** | Cross-lingual semantic search (+70MB) |

One new Rust crate (`whatlang`, ~500KB). The multilingual USE model replaces the English-only variant — not an additional model, a swap.

---

## Success Metrics

- Translation accuracy: >85% BLEU score for Tier 1 language pairs (human-evaluated sample)
- Language detection accuracy: >98% for Tier 1 languages, >90% for Tier 2
- End-to-end latency: <12 seconds for dictate + cleanup + translate (30s audio)
- Glossary impact: >15% improvement in domain-specific term accuracy when glossary is populated
- User adoption: >30% of multilingual users enable translation after discovering the feature
- Translation edit rate: <20% of translated entries require manual correction for Tier 1 pairs
- Cross-lingual search recall: >70% of relevant results found when searching across languages
