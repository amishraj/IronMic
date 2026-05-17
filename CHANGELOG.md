# Changelog

All notable changes to IronMic will be documented in this file.

## [1.9.1] - 2026-05-17

Remote-meeting capture latency fix. v1.9.0 made embedding-based
diarization the default on every remote-capture meeting, which doubled
the loopback chunk's processing cost (multi-segment Whisper + N×
WeSpeaker inferences + per-segment DB writes) and left transcripts
showing a lingering "Remote (pending diarization…)" hint that confused
users. v1.9.1 returns the default to a single fast "Remote" label
identical in latency to the local mic stream and moves the speaker
labeling into an opt-in Advanced toggle.

### Changed

- **Default remote-capture mode is now Simple.** `meeting_diarization_mode`
  defaults to `'off'` on fresh installs and on v1.9.0 upgraders whose
  Settings UI never explicitly enabled the feature
  (`meeting_diarization_user_overridden !== 'true'`). The old M2.5b
  runtime readiness flip that auto-promoted users to embedding mode
  is removed.
- **Simple-mode loopback path reuses the mic path verbatim**
  ([`meeting-recorder.ts`](electron-app/src/main/meeting-recorder.ts)):
  one row per 30 s chunk via `transcribeWithContext`, `speaker_label =
  null`, rendered as a plain "Remote" badge. No segment slicing, no
  WeSpeaker inference, no AHC at stop, no LLM fallback. Loopback now
  finalises in the same time window as the mic side.
- **Advanced mode is unchanged** — the full v1.9.0 pipeline (per-Whisper-
  segment rows + inline embedding + AHC refinement at stop) still
  runs end-to-end when the user explicitly enables it.
- **"pending diarization…" sub-line is now mode-aware.**
  [`MeetingTranscriptPanel`](electron-app/src/renderer/components/MeetingTranscriptPanel.tsx)
  only renders the hint when `diarizationMode === 'embedding'`; Simple-
  mode null-labeled loopback rows just show the plain "Remote" badge.

### Added

- **Settings → Voice AI → "Identify Individual Remote Speakers (Advanced)"**
  toggle, gated on the existing remote-capture toggle. Description
  spells out the tradeoff: Simple = same latency as mic, Advanced =
  per-speaker labels at ~2× chunk cost.

### Notes

- The WeSpeaker ONNX (26 MB) is still bundled in the installer. It
  sits idle until the user enables Advanced mode — the bundling cost
  is paid up front so opting in doesn't trigger a download. Same
  rationale as the bundled Whisper / Phi-3 models that are always
  shipped even though most users only use one engine.

## [1.9.0] - 2026-05-17

Acoustic speaker diarization for remote-meeting capture. Replaces the
v1.8 LLM-text heuristic with WeSpeaker ResNet34 voice embeddings and
agglomerative clustering, so 12–20 distinct speakers on a Zoom / Teams /
Meet call get labeled `[Speaker 1..N]` live during the meeting instead
of all collapsing into a single "Remote" bucket. Windows-only this
release (matches the v1.8 loopback-capture scope); macOS / Linux
inherit automatically once their loopback paths land.

### Added

- **WeSpeaker ResNet34 ONNX speaker-embedding model** (~26 MB, Apache-2.0,
  pinned to commit `0ae88dca…` from
  `hbredin/wespeaker-voxceleb-resnet34-LM`). Bundled into the installer
  alongside Moonshine and Phi-3 — works fully offline on first launch.
  Inference runs in Rust via the existing `ort` dependency through the
  new `speaker-diarization` Cargo feature.
- **Live `[Speaker N]` labels during remote-meeting capture.** Each
  Whisper-detected segment on the loopback stream gets sliced (800 ms
  min, middle 3 s of segments > 6 s, RMS gate to skip silence), embedded
  to a 256-d L2-normalized vector, and assigned a cluster label via
  online clustering — all before the segment renders. Embed-before-push
  discipline means the renderer never sees a row twice.
- **End-of-meeting AHC refinement** consolidates online drift via
  agglomerative hierarchical clustering (average linkage, 0.48 cutoff)
  over every persisted embedding pulled from SQLite (DB-canonical, not
  live state — survives crashes / mid-session restarts). Cluster labels
  reassigned in first-occurrence order so `[Speaker 1]` is always the
  earliest-detected remote speaker.
- **Optional LLM roster-rename pass** (`meeting_llm_name_pass_enabled`,
  default off) maps `[Speaker N]` → roster display names when a meeting
  has a participant roster, applied uniformly per cluster.
- **`MEETING_SEGMENTS_RELABELED` IPC event** patches the renderer's
  segment list in place after refinement — no full reload, no flicker
  for users viewing the detail view at meeting-stop time.
- **`SpeakerClusterer`** TypeScript module
  ([`electron-app/src/main/SpeakerClusterer.ts`](electron-app/src/main/SpeakerClusterer.ts))
  with online `assign()` + offline `refine()`. Empty-state branch seeds
  `[Speaker 1]` correctly, floor at cosine 0.40 routes weak embeddings
  to `[Speaker ?]` without polluting centroids, overflow at the
  20-speaker cap also returns `[Speaker ?]`. Synthetic 10-cluster ×
  50-sample Gaussian-blob vitest reaches V-measure ≥ 0.9.
- **`transcribe_with_segments` API** on the `TranscriptionEngine` trait
  exposes Whisper's per-segment timestamps (centiseconds → ms) so the
  meeting recorder can slice loopback PCM at utterance boundaries
  rather than the legacy 30 s chunk boundary. Moonshine falls back to a
  single segment via the default trait impl (POC accepts the coarser
  granularity until Moonshine segment timestamps land).
- **Models manifest pipeline.**
  [`electron-app/resources/models/models-manifest.json`](electron-app/resources/models/models-manifest.json)
  records every bundled model's path, sha256, license, source URL, and
  pinned commit revision.
  [`electron-app/scripts/verify-models-manifest.mjs`](electron-app/scripts/verify-models-manifest.mjs)
  runs at packaging time to re-hash each entry and require an
  attribution block in `THIRD_PARTY_NOTICES.md` for every license that
  carries an attribution clause.
- **`THIRD_PARTY_NOTICES.md`** at repo root with Apache-2.0 attribution
  for WeSpeaker plus carry-over entries for Moonshine, Whisper, Kokoro,
  and the TF.js model bundles.
- **Runtime readiness flip on app start** — the new
  `meeting_diarization_mode` setting flips from `'off'` to
  `'embedding'` only when (a) the WeSpeaker model file is on disk, AND
  (b) the user hasn't explicitly opted out via
  `meeting_diarization_user_overridden`. The flip never sets the
  user-override flag, so it can retry on a later boot if the model
  arrives via download-models.sh in the interim.
- **`speakerDiarizationAvailable` N-API export** lets the main process
  check WeSpeaker presence without loading the ONNX.
- **Schema migration v15** — `speaker_embedding BLOB`,
  `speaker_embedding_model`, `diarization_confidence` columns on
  `transcript_segments`; new `idx_transcript_segments_session_source`
  index; seven new `meeting_diarization_*` settings keys with
  conservative defaults (`mode = 'off'` until M2.5b flips it).
- **`scripts/download-models.sh --include-wespeaker`** convenience flag
  pulls the pinned WeSpeaker ONNX + Apache-2.0 LICENCE.md for local
  installer builds. `scripts/package.sh` invokes it automatically.

### Changed

- **Loopback transcript rows are now one-per-Whisper-segment** rather
  than one-per-30 s chunk. Mic side unchanged (still one row per chunk,
  pre-labeled `'You'`). This is what enables per-utterance embedding;
  it also gives users finer-grained transcripts on long monologues.
- **`processChunkDual` zeroes drained PCM16 buffers on every exit path**
  (mute gate, silent buffer, Whisper error, empty text, success) via a
  `try { } finally { zeroDrainedBuffersFinally(drained) }` wrapper. The
  helper is exported for direct unit testing. Closes a latent gap where
  the JS Buffer returned by `drainMeetingBuffers` survived past every
  early return until GC.
- **Stop-of-meeting diarization pipeline** is now strictly:
  final chunk → AHC refinement (DB-canonical) → optional LLM
  roster-rename → single `MEETING_SEGMENTS_RELABELED` emission. The
  legacy text-LLM diarization stays in place but only fires when the
  embedding pipeline never ran (Moonshine engine, multi-user room mode,
  or any segment whose embedding step failed). Per-segment word-overlap
  matching is removed — cluster labels are uniform per cluster.
- **Speaker embeddings persisted as raw little-endian f32 bytes** in a
  new BLOB column kept out of the default `SELECT_COLS` — loads only
  through the dedicated `listSegmentEmbeddings` path at refinement
  time, so list-transcript-segments stays lean.
- **CI clippy step is green again.** Resolved 16 pre-existing
  `-D warnings` violations on `main` (redundant closures, type
  complexity, manual `repeat_n`, dead-code in feature-gated paths) so
  the v1.9.0 PR can land on green.

### Privacy

- **Speaker embeddings are biometric-adjacent identifiers** even though
  no raw audio is retained. The new BLOB column is local-only,
  cascade-deleted with its `meeting_sessions` row, excluded from every
  export path, and covered by retention sweeps. Documented in
  `THIRD_PARTY_NOTICES.md` and surfaced in Settings → Security &
  Privacy.
- **Per-segment PCM slices are zeroed immediately after embedding**
  (Buffer.subarray shares memory with the parent, so the zero also
  wipes that range of the chunk Buffer). The outer chunk try/finally
  remains the backstop.

## [1.7.5] - 2026-05-10

Major upgrade to the polish + meeting-summary experience: every dictation
and every meeting now produces a structured, well-formatted document
instead of flat text. Hits Granola-style adaptive formatting (bold for
key terms even on short notes, headings hierarchy that scales with
length), and meeting summaries include attendees, an Overview, and a
dedicated Action Items table extracted from the transcript.

### Added

#### Polished output is now structured markdown (not flat text)

- **Adaptive heading hierarchy** in polished notes — short notes (<30 words) stay a single paragraph with **bold** for key subjects (names, decisions, deadlines, owners); 30–80 words get bullets when content is enumerated; 80–200 words get `### H3` sub-sections; >200 words get `## H2` sections with optional `### H3` inside. Both local and cloud paths produce markdown that the editor renders with full TipTap formatting (headings, bold, italic, lists, blockquotes, inline code, code blocks, action-item tables).
- **Cloud polish gets richer prompts than local.** `LOCAL_POLISH_PROMPT` (~350 tokens, one example) is tuned for Phi-3-mini-Q2_K's instruction-following limits. `CLOUD_POLISH_PROMPT` (~900 tokens, four worked examples covering paragraph / multi-topic / list / technical shapes) takes advantage of Claude / Copilot's larger context. Both share the same markdown grammar — only the teaching style differs.
- **Inline code for technical refs** — file names, function names, commands, package names, PR/JIRA refs all get `` `inline code` `` styling automatically.
- **Tables for genuinely tabular dictated content** (cloud only — local model handles tables less reliably).
- **Smart Formatting setting** — Settings → General → "Smart formatting" toggle (`polish_format_mode`) lets users opt out of the new rich rendering and fall back to the legacy flat-paragraph behavior. Default-on; persisted in SQLite. The toggle gates both prompt selection AND the markdown pipeline so plain mode is byte-for-byte identical to the prior behavior.

#### Meeting summaries — structured, attended, action-item-focused

- **New "Default" meeting template** (replaces the previous "Auto") with a simplified single-layout prompt that local Phi-3 follows reliably. Layout: `## Attendees` → `## Overview` → `## Discussion` (with optional `### H3` per topic) → `## Decisions` (each prefixed `**Decided:**`) → `## Action Items` (markdown table with Owner / Item / Due) → `## Open Questions`. Sections are emitted only when they have content — no "None mentioned" placeholders.
- **Attendees auto-populated from session participants.** Host + every joiner from the v7 `participants` roster gets surfaced as a bullet under the Attendees heading. The summarizer prepends a `[MEETING METADATA]` block to the transcript so the LLM sources accurate names instead of inferring from filler.
- **Action Items extraction emphasized in the prompt.** New language: *"Action items are usually the most valuable thing that comes out of a meeting — try hard to identify them."* Plus concrete pattern hints (explicit assignments, commitments, agreed next steps, follow-ups requested) to help the model surface them reliably.
- **Auto-detect meeting templates upgraded.** All five existing templates (Standup / 1-on-1 / Discovery / Team Sync / Retrospective) now produce richer markdown — bold for names/decisions/deadlines, inline code for technical refs, action items rendered as proper markdown tables.
- **Default template auto-selected on launch.** `meeting_default_template` is now read on `MeetingPage` mount and applied as the initial selection. Without this fix, every new meeting started without an explicit template click went through the flat-bullets path even after the v10 migration set the setting.
- **Meeting list grouped by date bucket** — Today / Yesterday / This week / Last week / This month / Earlier. Empty buckets are hidden; sessions inside each bucket sort newest-first.
- **Hide empty meetings toggle** in the meeting list header (default on) filters out sessions with `processingState === 'empty'` so noise from accidental short captures stays out of the way. Persisted to localStorage. Hidden count chip surfaces on the toggle so users know what they're not seeing.
- **Multi-select bulk delete** — click any meeting card's mic icon to enter selection mode (icon swaps to a checkbox, all other cards' mics become empty checkboxes). Click cards to add/remove. A floating action bar at the bottom shows "N selected / Cancel / Delete N" with a confirm dialog. Per-card actions hide in selection mode for visual focus.
- **Scroll position preserved across meeting open + back navigation** — clicking into a meeting and pressing back returns you to the same card you opened, not the top of the list. Implementation via a `useLayoutEffect`-anchored scroll restore on `detailSessionId` transition.

#### Notes editor — Raw vs Polished split for meeting-auto entries

- **Auto-filed meeting notes now have a meaningful Raw/Polished toggle.** Previously the markdown summary was written into `rawTranscript` with `polishedText: undefined`, so DictatePage showed the raw markdown source on the raw side and had nothing on the polished side. Now: polished side gets the rich AI summary (with formatted headings, bold, action-items table); raw side gets the verbatim meeting transcript. Polished view is the default per the existing schema default `display_mode = 'polished'`.

#### AI Assistant — voice chat redesign

- **Live AI panel** during voice chat now shows the assistant's words *as they're produced* (thinking phase) and *as they're spoken* (speaking phase), in a prominent card with `text-base` size and full-opacity color. Replaces the previous tiny grey 3-line `line-clamp-3` caption that read like an afterthought.
- **Streaming caret** appears after the live tokens during the thinking phase so the panel feels alive while the model is still emitting output.
- **Phase-aware labeling** — header reads "AI is thinking…" with a pulsing dot during streaming, then "AI is speaking…" while TTS plays the completed reply.
- **Wider overlay** (`max-w-2xl` from `max-w-md`) gives the live panel room to breathe.

#### New IPC channels

- **`generateText(systemPrompt, userPrompt, opts?)`** — generic LLM transport for non-polish completions (meeting summarization, template generation, intent classification fallback, meeting detection). Caller owns the system prompt; no cleanup-prompt layering. Handler clamps `maxTokens` to `[1, 4096]`, `temperature` to `[0, 1]`, validates prompt lengths against `MAX_PROMPT_LENGTH`, and reads `polish_allow_cloud` from main-process settings only — renderer can pass `forceLocal: true` to narrow but never widen permissions.
- **`generateTextLocal(systemPrompt, userPrompt, opts?)`** — same but with `forceLocal` pinned on. For callers (e.g. AI title generation) that must never touch cloud regardless of the user's setting.
- **`convertMarkdown(md)`** — markdown → `{ plainText, html, jsonString }` projections from the main-side sanitization pipeline. Renderer never imports the pipeline directly. `html` is sanitize-html-approved (safe for `dangerouslySetInnerHTML`), `jsonString` is JSON.stringify of ProseMirror JSON ready for `editor.commands.setContent(JSON.parse(...))`.

### Changed

- **`polishTextDetailed` response shape** — was `{ text, providerUsed }`, now `{ markdown, plainText, html, jsonString, providerUsed, text }`. New callers consume the projections directly; legacy callers reading `.text` still work (kept as alias of `plainText`).
- **`polishText` returns the `plainText` projection** — was the verbatim LLM output. Prevents markdown syntax bleed (`**bold**`, `## Heading`) into clipboards / Forge pastes / plain-text fields after the prompt change.
- **`MeetingDetailPage` regenerate path no longer nulls `htmlContent`.** Previously the spread set `htmlContent: null` on the assumption that AI output is always plain. Now preserves `fresh.htmlContent` from the markdown pipeline so the rich summary survives a regenerate.
- **`MAX_OUTPUT_TO_INPUT_RATIO`** bumped 0.8 → 1.6 in `runTemplateWithGuardrails`. Genuine transcript echoes still fail the long-verbatim-span check; legitimate structured summaries that happen to exceed 80% of input length are no longer rejected as "echo". Plus a new pass #3 fallback (`hasStructureWithoutPromptLeak`) accepts output the strict guard rejected as long as it has at least one heading or bullet and no prompt leakage.
- **Meeting title generator** prompt tightened with worked examples ("Sprint planning", "Q4 budget review"), hard 5-word and 45-char clamps in `sanitizeTitle` so titles stay glanceable. Truncation is on a word boundary; trailing punctuation is stripped after the cut.
- **`polish_allow_cloud` Settings copy** rewritten to reflect its broader scope — it now also gates meeting summaries, template generation, intent classification, and meeting detection. New copy: "Use cloud AI when authenticated (Claude / Copilot) … routes polish, meeting summarization, and other AI tasks through the authenticated CLI". Live meeting summaries always stay local regardless of this setting.
- **Notebook auto-file (`addTextAsEntryToNotebook`)** now runs the markdown through `convertMarkdown` and writes both `polishedText` (plain) and `polishedTextJson` (rich ProseMirror) — same shape as the dictation polish flow. The resulting entry opens in DictatePage with full headings/bold/lists rendering.
- **`MeetingSessionCard` restructured from `<button>` to `<div role="button">`.** Nested `<button>` elements (the AddToNotebook menu inside the outer card button) caused click events to be swallowed. Now nested interactive children get their own clicks, and the keyboard semantics are preserved via `role` + `tabIndex` + Enter/Space handlers.
- **ShareMenu removed from meeting cards.** AddToNotebook now actually works.
- **MeetingRegenerateModal** — removed the "Free-form bullets (no template)" option; pre-selects the Default template (`builtin-auto`) when the meeting has no current template. Generic / no-template button removed from the meeting start screen too. Every meeting now goes through a template so output is always structured.
- **Marked pinned to v4** (CJS-compatible). v18+ is ESM-only and Electron's CommonJS main process can't `require()` it.

### Fixed

- **Meeting summary section keys produced lowercase headings** in the auto-filed Notes entry (`## tldr`, `## discussion`) because `SECTION_TITLES` was missing those keys. Now covers every key any seeded template emits — fresh meetings produce proper-cased `## TL;DR` / `## Overview` / `## Discussion` / etc.
- **Meeting `plainSummary` reconstruction was lossy** — the template path returned a `StructuredOutput` without `plainSummary`, so `MeetingPage`'s `summaryForColumn` always fell through to the section-by-section markdown rebuild. Now populated from the LLM's raw output so the notebook auto-file uses the actual produced markdown.
- **Auto template prompt always returned `[INSUFFICIENT_CONTENT]`** on perfectly good transcripts. The v10 prompt asked Phi-3-mini to classify the meeting type into one of 8 buckets and emit a per-bucket layout — too much instruction-following for the small model. v11 simplified to a single fixed structured layout and removed the escape hatch entirely.
- **First message to Claude / Copilot in a new chat failed with `claude exited with code null: (no stderr)`.** Root cause was two defensive `aiResetSession(id)` calls — one enqueued in `useAiChatStore.createSession`, one direct in `AIChat.handleNewChat` — that fired `aiManager.cancel()` on whatever CLI process was active. The user's just-spawned first-message process got SIGTERM'd before any output arrived. Both defensive calls removed; a brand-new session id has no context to clear by definition.
- **Claude Haiku model id was malformed** — `claude-haiku-3-5-20241022` instead of `claude-3-5-haiku-20241022`. The Claude CLI rejected it with "model may not exist or you may not have access to it." Corrected the dated id, added Haiku 4.5 (`claude-haiku-4-5`) alongside, and added a `normalizeKnownBadModelId` helper in `AIManager.resolveModel` so users with the bogus id already saved in their `ai_model` setting get transparently rewritten on read — no need to manually re-pick.
- **Polish overlay only covered the top portion of long notes.** The "Generating polished version…" overlay was an `absolute inset-0` child of the scrolling editor container. Restructured DictatePage's editor wrapper so the overlay covers the viewport, not the scroll content area.
- **Tailwind Typography `prose` classes had no effect** on `dangerouslySetInnerHTML` containers (MeetingNotesPanel, MeetingDetailPage user-notes pane) because the `@tailwindcss/typography` plugin was never installed. Added explicit `.prose` CSS rules in `globals.css` mirroring the existing `.ProseMirror` styles so headings, bold, lists, blockquotes, and tables render correctly outside the editor.
- **Live summary path bypassed user-selected templates.** When a non-empty live summary existed at meeting end, `MeetingPage` routed straight to `finalizeWithLiveSummary` (flat bullets) regardless of the selected template. Now: when a template is selected (always, post-Default-auto-selection), the structured pass always runs.
- **NoteEditor inserted plain text instead of the rich JSON fragment** when polish completed after dictation. Now reads `entry.polishedTextJson`, parses it, and `insertContent`s the block-node array (preserves any user content the new dictation is appended into).
- **`useEntryStore.polishEntry` was deliberately dropping `polishedTextJson`** from the update with a stale comment ("Polish output is plaintext"). Now writes both `polishedText` and `polishedTextJson` atomically. DictatePage's reactive sync at line 1366 already preferred the JSON projection, so the editor renders rich content as soon as polish completes.
- **DictatePage's editor was missing Table + TaskList extensions.** Even when `polishedTextJson` arrived correctly, action-item tables and checkboxes from cloud polish would be silently dropped by the editor schema. Now spreads `buildSharedExtensions()` — the same set the markdown pipeline's `@tiptap/html generateJSON` uses in main.
- **`polished_text_json` write contract was contradictory.** `polishTextDetailed.json` was an object internally, but the IPC + DB layer expects strings. Pinned the public IPC shape to strings (`jsonString: string`); the object form stays private to `markdownPipeline.ts` in main and never crosses IPC.
- **NPM `@tailwindcss/typography` not installed** — added explicit `.prose` CSS rules instead, mirroring the existing `.ProseMirror` ones.
- **Meeting card share/export removed; AddToNotebook now functional** (was broken by the nested `<button>` HTML — see Changed above).

### Migration notes

- **Schema bumped from v9 → v12.** Three new migrations in series:
  - **v10**: seeds the new "Auto" meeting template; equality-guarded UPDATE on the 5 existing builtin templates' `llm_prompt` to richer-formatting versions; flips `meeting_default_template = 'builtin-auto'` for users where the setting is still empty; seeds `polish_format_mode = 'rich'`.
  - **v11**: simplifies the Auto template prompt (single fixed layout instead of 8-way meeting-type classification, removes the `[INSUFFICIENT_CONTENT]` escape hatch); renames "Auto (smart format)" → "Default" in the user-facing label.
  - **v12**: adds `## Attendees` + `## Overview` to the Default template; emphasizes Action Items in the prompt body. (Date intentionally NOT in the layout — the meeting detail header already shows it.)
  - All three use equality-guarded UPDATEs against their respective baseline constants. **User customizations to builtin templates are preserved** — the UPDATE only fires when the row matches the prior version's exact bytes.
- **No new schema columns for `entries` or `meeting_sessions`.** Reuses the existing `polished_text_json` (added in v6) for rich entry content and `structured_output.htmlContent` (already in use) for meeting rich content.
- **For meetings created before v12:** hit Regenerate to pick up the new layout (Attendees + Overview + Action Items emphasis). Old meetings keep working as-is.
- **For polish-completed entries created before v1.7.5:** the legacy `polished_text` column stays as the rendering source; the `polishedTextJson` rich projection only populates for fresh polishes.

### Verification

- `cargo test --lib` passes 166/166 (5 new migration tests across v10/v11/v12, 161 prior tests unchanged).
- TypeScript main typecheck clean; renderer typecheck unchanged from baseline (30 pre-existing errors, 0 new).
- Markdown pipeline security smoke: 14/14 passing — `<script>` tag drop, `javascript:` href reject, task-list checked-state preservation, table round-trip.
- `@tiptap/html` Node-compat smoke passes without DOM shim — no `jsdom` required.

## [1.7.4] - 2026-05-08

### Fixed

- **Copilot model dropdown showed "Model..." after Refresh** — The orphan-selection row rendered the raw saved id verbatim, which after CSS truncation read as "Model...". The orphan label now goes through `prettifyModelId` so saved selections always render cleanly (e.g. `gpt-4o-mini (openai)` instead of the raw string). The post-restart synthesis path in `AIManager.synthesizeModel` does the same.
- **Polish "model isn't available on your plan or policy" error** — When `copilot help` parsing returned nothing (current `@github/copilot` builds don't expose models in `--help`), the catalog fell through to a two-entry hardcoded list whose lead model can be refused on free-tier accounts. The catalog now uses a 5-entry curated baseline (`openai/gpt-4.1`, `openai/gpt-4o`, `openai/gpt-5-mini`, `anthropic/claude-sonnet-4.5`, `anthropic/claude-haiku-4.5`) with both `runIds.copilotCli` and `runIds.ghModels` populated, giving users free-tier-friendly options out of the box.

### Added

- **`copilot --list-models` probe** — Tried first as a structured probe before the heuristic `copilot help` text-scrape, in case future CLI builds expose a non-interactive enumeration flag.
- **Source-aware merge of probed vs. curated catalog** — High-confidence probes (`gh models list`, `--list-models`) replace the curated list; low-confidence probes (help-text scrape) supplement it. Bare-id-vs-slash-id matching (e.g. probe `gpt-5-mini` matches curated `openai/gpt-5-mini`) prevents duplicate rows, and `runIds` are deep-merged so a copilot-cli probe never drops a curated `ghModels` mapping.
- **Probe log file** — Raw stdout/stderr/exit-code for every Copilot CLI probe is appended as one JSON line per probe to `<userData>/logs/copilot-probe.log` (Windows: `%APPDATA%\IronMic\logs\copilot-probe.log`). The absolute path is printed once on first probe to the dev console. Used for diagnosing parser regressions without needing a Settings UI surface. 1 MB rotation; silent no-op outside Electron so unit tests don't break.
- **`'curated'` source on `AIModel`** — New union member alongside `'cli' | 'fallback' | 'static' | 'local'`. The Settings caption now classifies the visible list as all-cli ("From your GitHub Copilot subscription"), all-curated ("Built-in catalog"), or mixed ("Live probe plus built-in fallback entries").

### Changed

- **TTL fast path on `refreshModels()` excludes both `'fallback'` and `'curated'`** — Previously only `'fallback'` was skipped, so once a curated cache was warm the Refresh button could short-circuit on subsequent clicks. Refresh now always re-probes when no real probe data is cached.
- **Tightened `looksLikeCopilotModelId` heuristic** — Candidate must contain `/` or start with a known vendor prefix (`gpt-`, `claude-`, `o3-`, `o4-`, `gemini-`, `mistral-`, `llama-`, `phi-`). Rejects prose tokens (`available`, `default`, `none`) that the previous loose char regex would admit.
- **Pure-helper extraction** — `getCuratedCopilotModels()` and `mergeProbedIntoCurated()` now live in `electron-app/src/main/ai/copilot-catalog.ts` so they're easy to unit-test without instantiating the adapter. Returned objects are deep-cloned each call.
- **`aiRefreshModels` properly typed on the renderer Window** — Drops the `(window.ironmic as any).aiRefreshModels?.(...)` cast in SettingsPanel.

### Tests

- **First Copilot adapter unit tests** (`src/main/ai/CopilotAdapter.test.ts`, 15 cases) — parser false-positive rejection, JSON/table parsing, curated catalog shape immutability, and merge semantics for high/low/empty probe confidence.

## [1.7.3] - 2026-05-08

### Added

- **Dynamic GitHub Copilot model catalog** — Settings → AI Assist now reflects the models your actual Copilot subscription supports instead of two hardcoded options. A "Refresh models" button queries the active backend (`copilot help` for the `@github/copilot` CLI, `gh models list` for the `gh-models` extension) and populates the dropdown from the response. Free, Pro, Pro+, Business, and Enterprise users now see the full set their plan exposes.
- **`ai:refresh-models` IPC** — Renderer-triggered catalog probe. The existing `ai:get-models` is now strictly cache-only and never spawns child processes, so opening Settings does not produce a network call. Catalog probes only run on explicit user action.
- **Orphan-selection UI** — When a previously-saved Copilot model isn't in the visible catalog (e.g. immediately after app restart, before a refresh), the dropdown now shows it as a "Saved" entry with a Refresh CTA so the UI never silently drifts from what the backend will actually call.
- **Cross-platform spawn helper** — New `utils/spawn-portable.ts` extracts the Windows `.cmd`/extensionless-shim wrapping previously private to `AIManager`, so adapter probes (`copilot help`, `gh models list`, `gh auth status`) work correctly on Windows where shim binaries can't be invoked via `execFile` directly.

### Fixed

- **Polish ignored selected model** — `AIManager.polish()` was silently dropping the user's selected model and always running CLI defaults. The cleanup pass now reads `ai_model` from settings and forwards it via `--model`, so a user who picked Claude Sonnet 4 or `claude-haiku-4.5` in Copilot actually gets that model for transcript polish.
- **Friendly entitlement-error messages** — When the CLI rejects a model the user's plan doesn't grant (overlisting from `copilot help` is possible), the chat surfaces a clear "model isn't available on your plan" message instead of raw stderr.
- **Async, non-blocking model probes** — Catalog probes use promisified `execFile` with hard timeouts (≤5 s) so the Electron main process never freezes while waiting on `gh` or `copilot`.

### Changed

- **`AIModel.free: boolean` → `billing: 'free' | 'paid' | 'unknown'`** — Dynamically discovered models from `gh models list` / `copilot help` don't expose plan tier, so they're tagged `unknown` instead of guessing. The "Free" badge is preserved for known-free entries; "Saved" badge tags orphaned post-restart selections.
- **`AIModel.runIds`** — New optional field carrying backend-specific run identifiers (`copilotCli`, `ghModels`) so saved selections always invoke the correct argument form regardless of which backend is active. Legacy pre-1.7.3 string IDs continue to work via the existing alias normalizer.

## [1.7.2] - 2026-05-08

### Fixed

- **GitHub Copilot auth on Windows** — Settings always showed "not logged in" for Copilot on current `@github/copilot` CLI builds because the adapter read `logged_in_users` (snake_case) while modern builds write `loggedInUsers` (camelCase). Both keys are now accepted.
- **Copilot auth env precedence** — `COPILOT_GITHUB_TOKEN` is now checked before `GH_TOKEN` / `GITHUB_TOKEN`, matching GitHub's documented precedence. `COPILOT_HOME` is honoured so non-default config directories are found correctly.
- **Copilot subprocess env** — The spawned `copilot` process now receives `COPILOT_GITHUB_TOKEN`, `COPILOT_HOME`, and `COPILOT_GH_HOST` in its environment so env-based auth reaches the CLI.
- **Copilot chat stateless** — Every turn was starting a fresh session. `--continue` is now passed after the first successful turn so multi-turn conversations have memory. `-s` (silent mode) added for clean programmatic output.
- **Per-provider turn counts** — A shared turn counter across Claude, Copilot, and local meant switching provider tabs could incorrectly send `--continue` on a brand-new Copilot session. Counts are now tracked per-provider and only incremented on a clean exit code 0 response.

## [1.6.0] - 2026-05-04

### Changed

- **Simplified meeting model** — The Meetings page now defaults to two modes: **Host Room** and **Join Room**. Solo mode is no longer the default; it remains accessible by enabling **Developer features** in Settings → Security & Privacy.
- **Repurposed Collaborate button** — During a live host meeting, the toolbar now has a **Collaborate** toggle that shows or hides the invite details (IP, port, code). Useful for hiding the invite during screen-share. Participants list stays visible regardless.
- **Removed "Join Shared Meetings" card** — The finished-meeting notes-share entry point on the Meetings page has been removed. Note collaboration in the dictation flow is unchanged.

### Added

- **Mid-meeting mic on/off** — A new mic toggle in the live meeting toolbar lets users mute their microphone without stopping the meeting. Mute is a hard privacy boundary: no local STT, no segment broadcast to peers, no final-drain commit on stop, and any in-flight streaming draft is dropped on mute.
- **`dev_features_enabled` setting** — New toggle in **Settings → Security & Privacy → Developer** that exposes legacy/experimental controls (Solo meeting mode, etc.). Off by default.
- **Hardened invite-code inputs** — Invite-code fields now uniformly enforce uppercase display, `autoCapitalize="characters"`, `autoComplete="off"`, and `spellCheck={false}` for consistent, error-resistant entry.

## [1.5.0] - 2026-04-30

### Added

#### Moonshine Engine — New Default Speech Recognition
- **Moonshine Base bundled with the installer** — The default speech recognition engine ships with the app (~146 MB). No download required on first launch. The model is copied from `resourcesPath` to the writable user-data models folder automatically.
- **Multi-engine transcription architecture** — A unified `TranscriptionEngine` trait in Rust supports multiple backends. Switch between Moonshine and Whisper in **Settings > Speech Recognition Model** without restarting the app.
- **Moonshine ONNX backend** — Runs via ONNX Runtime with SIMD-optimized MLAS kernels and DirectML on Windows. Benchmarks: Moonshine Base 69 ms vs Whisper Tiny 1141 ms on x86 CPU (~16× faster with better WER on short-form speech).
- **Whisper still available** — Base / Small / Medium / Large-v3-turbo remain downloadable from Settings for multilingual or high-accuracy use cases.
- **"Restore bundled copy" action** — One-click action in Settings > Models restores the factory Moonshine Base files without re-downloading.
- **Transcript segments table** — New `transcript_segments` SQLite table stores incremental segment data for streaming and rollback.

#### Notes Page Redesign
- **Notebooks sidebar** — Organize entries into notebooks. Collapsible sidebar with creation, rename, and delete.
- **Streaming dictation** — Partial transcript tokens stream into the editor in real-time as you speak via `DictationStreamer`.
- **Live summarizer** — Real-time meeting summary updates while recording is in progress (`LiveSummarizer`).
- **Auto-filed AI notes** — Meeting notes are automatically created and filed to the active notebook when a meeting ends.
- **Responsive layout** — Notes page adapts to narrow windows; sidebar collapses gracefully.

#### Collaboration
- **Meeting notes collab server/client** — Peer-to-peer shared notes during live meetings. Host a session or join a room; notes sync in real-time across participants on the local network.
- **Meeting room panel** — In-app UI for starting or joining a collab session from the Meetings page.
- **Shared notes viewer** — Read-only viewer for participants receiving notes from the host.

#### Windows & VDI Dictation
- **Multi-round Windows VDI fixes** — Resolved silent-failure chain on corporate VDI environments: RMS gate now sanitizes near-zero audio, the dictation sanitizer no longer drops valid short utterances, and renderer-side handlers propagate results correctly.
- **Debug-log helper** — `debug-log.ts` utility captures structured audio pipeline events for future bisection without shipping verbose logs to end users.
- **Build script for Windows** — New `scripts/build-rust.ps1` PowerShell script mirrors the macOS/Linux shell script for Rust compilation on Windows.

#### Performance & Stability
- **AudioStreamManager** — Centralized audio stream lifecycle. All components share a single `getUserMedia` stream; no duplicate mic captures. Fixes resource leaks on rapid start/stop.
- **AI response caching** — `AIManager` caches recent completions to avoid redundant LLM calls during repeated polishing.
- **React ErrorBoundary** — `ErrorBoundary` component wraps major view trees; crashes in one panel no longer take down the whole window.
- **DB entries query optimization** — Entries storage queries restructured to use covering indexes; timeline load time reduced significantly on large databases.
- **Dictation streamer back-pressure** — `DictationStreamer` now applies back-pressure when the renderer is busy, preventing dropped partial tokens under load.
- **Tray menu refresh** — Tray menu rebuilds dynamically when recording state changes, keeping the menu item labels in sync.

#### Developer Experience
- **`scripts/dev.sh` improvements** — Detects missing Rust build and prints a clear remediation step before starting Electron.
- **`scripts/download-models.sh` overhaul** — Moonshine Base download, SHA-256 verification, and structured directory layout for all engine types.
- **`scripts/package.sh` overhaul** — Packaging now bundles Moonshine Base, entitlements plist, and BlackHole placeholder in one pass.

### Changed
- `electron-builder.config.js` — `extraResources` now includes the bundled Moonshine Base model directory and macOS entitlements plist.
- Settings > Speech Recognition — Engine selector and model picker consolidated into a single **Speech Recognition Model** card. Previously split across two separate UI sections.
- macOS installation notes updated — Installer is ad-hoc signed; `xattr -cr` must be run on both the DMG and the installed `.app` bundle.
- `.gitignore` expanded — Moonshine model files (`.onnx`, `.ort`, `.bin`) excluded from all subdirectories.

### Fixed
- **Copilot subscription detection** — `CopilotAdapter` now correctly handles the subscription check flow when the CLI is authenticated but the license query returns an unexpected format.
- **Claude adapter streaming** — Token delivery gaps under high LLM load resolved; stream no longer stalls on the first assistant response.
- **VAD false-positive on silence** — Web Audio VAD pipeline no longer triggers speech-start on mic open with no input.
- **Meeting summary broken in packaged app** — `LlmSubprocess` now resolves the binary path relative to `resourcesPath` in production builds.
- **Notes navigation away while recording** — Navigating away from the Notes page while a recording is active no longer orphans the audio stream.
- **`ironmic-llm` binary bundling** — Release workflow now correctly includes the compiled LLM subprocess binary.

---

## [1.3.3] - 2026-04-15

### Fixed
- **TTS Kokoro Download button persists after import** — The Kokoro TTS card checked `isTtsModelReady()` which requires both the model file AND voice files. After importing just the `.onnx` model, the card still showed "Download". Now tracks model file presence separately — shows "Imported" badge when the model exists but voices haven't been downloaded yet, and "Ready" when both are present.

---

## [1.4.0] - 2026-04-15

### Added

#### Audio Input Settings Page
- **New "Input" tab in Settings** — Dedicated page for microphone configuration and testing.
- **Microphone permission status** — Shows whether IronMic has mic access (granted/denied/not-determined) with platform-specific guidance for fixing denied permissions.
- **Active device info** — Displays current input device name, sample rate, channels, and sample format.
- **Available devices list** — Shows all detected input devices with their specs and which is the system default.
- **Real-time level meter** — Start monitoring to see live audio level and peak indicators. Color-coded: green (good), amber (loud), red (clipping). Detects "no audio" and warns if mic may be muted.
- **Test recording & playback** — Record a 5-second clip and play it back to verify audio quality before dictating.
- **Tips section** — Best practices for mic placement, level, and noise reduction.
- **Rust NAPI exports** — `listAudioDevices()` and `getCurrentAudioDevice()` enumerate cpal input devices with sample rate, channels, and default status.

#### Active Model Indicators
- **Section headers show active model** — Each model section (Speech Recognition, Text Cleanup, Chat Models, TTS, AI Assist) now displays a green badge showing which model is active/ready. Makes it instantly clear what's loaded without scrolling through cards.

### Fixed
- **Local LLM provider not selectable** — `isInstalled()` now returns true when model files exist, allowing the provider to appear in AI Chat after import.
- **TTS download button persists after import** — Tracks model file presence separately from full readiness.
- **GPU "Learn why" explainer** — CPU Mode card explains GPU requirements.

---

## [1.3.4] - 2026-04-15

### Fixed
- **Local LLM provider not selectable in AI Chat** — `isInstalled()` required the `ironmic-llm` binary which isn't bundled in release builds. Now considers local LLM "installed" when model files exist on disk. The provider shows up in AI Chat after importing a model. A clear error explains the binary requirement at runtime if inference is attempted without it.
- **TTS Kokoro Download button persists after import** — Tracks model file presence separately from full TTS readiness (model + voices). Shows "Imported" badge when `.onnx` exists but voices haven't been downloaded yet.
- **GPU "Learn why" explainer** — CPU Mode card now has a "Learn why" button with detailed explanation of GPU requirements.

---

## [1.3.2] - 2026-04-15

### Fixed
- **Model cards now refresh after import** — Importing a model via the import section now triggers a status refresh across all model sections (Whisper, Text Cleanup, Chat). Previously, importing a chat model would succeed but the card above still showed "Download" instead of "Ready".
- **Chat models section always visible** — The AI Assist Chat Models section (and its import area) no longer hides when `aiGetLocalModelStatus` returns empty. The import section is always accessible.
- **GPU "Learn why" explainer** — When GPU acceleration is unavailable, the CPU Mode card now shows a "Learn why" button that expands a detailed explanation (platform requirements, Metal feature flag, Intel vs Apple Silicon, build instructions).

---

## [1.3.0] - 2026-04-15

### Added

#### Meeting Templates & Structured Notes
- **5 builtin meeting templates** — Standup, 1-on-1, Discovery Call, Team Sync, and Retrospective. Each has tailored sections (action items, blockers, decisions, etc.) and an LLM prompt that extracts structured notes from the transcript.
- **Custom templates** — Create your own templates with configurable sections and prompts via the Meetings page.
- **Structured output** — Meeting notes are organized into labeled sections instead of a wall of text. Template-driven extraction with section-level granularity.
- **Meeting app auto-detection** — Opt-in detection of Zoom, Teams, and Google Meet by checking the frontmost window title. When detected, offers to start meeting mode. Off by default (Settings > Voice AI).
- **Meetings page** — New nav item with template picker, start/stop controls, live duration counter, and meeting history with expandable structured results.

#### One-Click Sharing & Export
- **ShareMenu on every entry** — New share button in the entry card actions bar with dropdown: Copy as Rich Text, Copy as Markdown, Copy as Plain Text, Save as File.
- **Rich clipboard (HTML)** — "Copy as Rich Text" pastes formatted text into Slack, Google Docs, email — headings, bold, bullet points preserved. Uses arboard's `set_html()` for dual HTML + plain-text clipboard.
- **Markdown export** — Formatted with date, duration, tags, and full text.
- **Save as File** — Native save dialog for `.md`, `.txt`, `.json` export.
- **Meeting export** — ShareMenu on meeting session cards exports structured notes or summary.

### Changed
- SQLite schema upgraded to v4 (meeting_templates table, meeting_sessions extended with template_id/structured_output/detected_app columns)
- MeetingDetector refactored to delegate summary generation to MeetingTemplateEngine when a template is selected

---

## [1.2.2] - 2026-04-14

### Added
- **Multi-part model import** — New "Import Multi-Part" button for models that are split into parts on GitHub Releases (Mistral 7B, Llama 3.1, Phi-3). Select all `.part0`, `.part1`, `.part2` files at once — IronMic sorts them by part number, concatenates them into one file, and verifies the SHA-256 checksum. No manual assembly needed.
- **GitHub Releases download links** — Import sections now show direct download links to your GitHub Releases (`models-v1` tag) for single-file models (Whisper, TTS). For multi-part models, each part is listed individually with its own download link, plus a HuggingFace link for the single-file alternative.
- **Two import modes side by side** — "Import Single File" for complete models, "Import Multi-Part" for split files. The multi-part button only appears in sections that have split models.

### Changed
- **Always-visible model import sections** — Every model category (Speech Recognition, Text Cleanup, Chat, TTS) now has a permanent "Import Model" section at the bottom, not hidden behind download errors.
- **Error messages direct to import** — When a download fails, the error tells you to use the import section below.
- **Download URLs default to GitHub Releases** — Single-file models link to your own GitHub Releases instead of HuggingFace. Multi-part models still link to HuggingFace for the single-file download option.

---

## [1.2.0] - 2026-04-14

### Added
- **Manual model import** — When a model download fails (corporate proxy, VPN, firewall), a banner appears offering to import model files manually. Users can download the model in their browser (which goes through the corporate proxy normally), then click "Import File" to load it into IronMic. The app validates the file, copies it to the correct location, and marks it as ready. Works for all model types: Whisper (.bin), LLM/chat (.gguf), and TTS (.onnx). The banner shows direct HuggingFace download links for each model and step-by-step instructions. Available in Settings > Models (all sections), Settings > Speech (TTS), and Settings > AI Assist (local models).

### Fixed
- **GitHub Releases downloads blocked by own security filter** — GitHub changed its release asset CDN from `objects.githubusercontent.com` to `release-assets.githubusercontent.com`, but IronMic's domain whitelist only included the old domain. Added `release-assets.githubusercontent.com` to both the model downloader's allowed domains and the network blocker's whitelist.

---

## [1.1.10] - 2026-04-14

### Fixed
- **Download error details now actually visible in the UI** — The error progress event now carries the full error message including URLs tried. All progress handlers (Whisper, LLM, chat models, TTS, AI Assist) read `errorDetail` from the progress event and display it inline. Previously, the progress event fired `status: 'error'` but didn't include the message, so the UI showed generic text like "Download failed" instead of the detailed URL breakdown.

---

## [1.1.9] - 2026-04-13

### Added
- **HTTP proxy configuration** — New proxy settings in Settings > Security. Supports HTTP, HTTPS, and SOCKS5 proxies for model downloads on corporate networks. Uses Electron's `session.setProxy()` which routes through Chromium's network stack (trusts system certs + handles CONNECT tunnels). Also respects standard `HTTPS_PROXY` / `HTTP_PROXY` environment variables. The Security Posture overview updates to show proxy status.

---

## [1.1.8] - 2026-04-13

### Fixed
- **Download errors now show which URLs were tried** — When a model download fails, the error message displays the primary URL and its error, then the fallback URL and its error. This applies to all model downloads: Whisper, text cleanup (Mistral), chat models (Llama3/Phi3), TTS (Kokoro), and TF.js ML models. Error text is displayed with `whitespace-pre-wrap` so the multi-line URL details render properly in all settings sections.

---

## [1.1.7] - 2026-04-13

### Fixed
- **Upload-models workflow: USE Lite download 403** — Google's TFHub GCS bucket now returns 403 for all TF.js model downloads (migrated to Kaggle). Changed USE to a placeholder archive like the other TF.js models. Semantic search gracefully disables when the model isn't present, falling back to keyword search. The USE model will be converted offline and uploaded manually in a future release.

---

## [1.1.6] - 2026-04-13

### Fixed
- **Download errors now visible in all model sections** — Chat model downloads (Llama3, Phi3) in both Models tab and AI Assist tab, and TTS model (Kokoro 82M) in Speech tab, now show inline error messages when downloads fail instead of silently swallowing errors.
- **Chat models (Llama3, Phi3) added to upload-models workflow** — These models were never uploaded to GitHub Releases, causing 404 on the primary URL. Added download, split (for GitHub 2GB limit), and upload steps. Also added MODEL_PARTS entry for Phi3.

---

## [1.1.5] - 2026-04-13

### Fixed
- **Model downloads blocked by app's own network filter** — Switching to Electron's `net` module in v1.1.3 caused downloads to go through the session's `webRequest` filter, which blocks all outbound traffic. Added a whitelist for model download domains (github.com, objects.githubusercontent.com, huggingface.co, xethub.hf.co) so HTTPS downloads to these trusted hosts pass through. All other outbound traffic remains blocked.

---

## [1.1.4] - 2026-04-13

### Fixed
- **App crash on launch: "Cannot find module ./shared/constants"** — The electron-builder files pattern was too narrow after v1.1.3 change, excluding `dist/shared/` from the asar archive. The main process imports `IPC_CHANNELS` and model constants from `../shared/constants` which compiled to `dist/shared/constants.js`. Changed to `dist/**/*` with negative patterns excluding build output directories.

---

## [1.1.3] - 2026-04-13

### Fixed
- **Analytics white screen on fresh install** — The analytics dashboard crashed with a blank white page when no dictation data existed. Each analytics API call now loads independently with safe fallbacks, so one failure doesn't blank the entire page. Added an error boundary that catches Recharts rendering crashes and shows a friendly recovery message.
- **"Self-signed certificate in certificate chain" when downloading models** — Model downloads used Node.js `https` module which doesn't trust the system certificate store. Switched to Electron's `net` module which uses the OS certificate store, fixing downloads on corporate networks, VPNs, and systems with proxy TLS interception. Falls back to Node.js `https` if Electron's net module is unavailable.

---

## [1.1.2] - 2026-04-13

### Fixed
- **Model downloads fail in packaged app** — `ENOENT: no such file or directory, mkdir .../IronMic.app/Contents/Resources/rust-core/models`. The model directory path was resolved at module load time (top-level `const`), but TypeScript import hoisting caused the module to load before `IRONMIC_MODELS_DIR` was set, so it fell back to a path inside the read-only `.app` bundle. Changed to lazy resolution so the env var is read at download time. This fixes all model downloads: Whisper, LLM, chat models (Llama3, Phi3), TTS, and TF.js ML models.

---

## [1.1.1] - 2026-04-13

### Fixed
- **Clippy CI failures** — Renamed `ChatModel::from_str()` to `ChatModel::parse()` to avoid `clippy::should_implement_trait` warning. Flattened manual `if let Some` iterator patterns in analytics top-words and source-breakdown aggregation. Added type alias for complex tuple in analytics recompute.

---

## [1.1.0] - 2026-04-13

### Added — On-Device Machine Learning (TensorFlow.js)

IronMic now includes 5 TensorFlow.js-powered ML features that run entirely on-device. All models are lightweight (<50MB total), all training data stays local, and everything works offline. A new **Voice AI** settings tab provides toggles and thresholds for each feature.

#### Feature 1: Intelligent Voice Activity Detection (3 parts + bonus)

- **Silent Efficiency Layer (VAD)** — Silero VAD model filters silence and background noise before audio reaches Whisper, reducing unnecessary transcription. Uses a dual-pipeline approach: Web Audio API captures real-time frames for VAD classification while Rust/cpal handles the official recording. Configurable sensitivity slider. Energy-based fallback when model is unavailable.
- **Conversational AI Turn Detection** — Detects when you've finished speaking and automatically triggers the transcription pipeline. Three modes: push-to-talk (default, existing behavior), auto-detect (silence timeout triggers stop, default 3s), and always-listening (continuous mic with persistent indicator). Creates a hands-free conversation loop: speak -> auto-transcribe -> AI responds -> TTS reads response -> recording resumes.
- **Context-Aware Voice Routing** — Automatically routes voice input based on your current screen. AI Chat screen routes to conversation, Notes/Editor routes to dictation, command keywords route to intent classification. Voice error recovery: say "no, I meant..." to undo and re-route.
- **Ambient Meeting Mode** — Passive listening with energy-based speaker turn detection. Auto-detects meeting end after sustained silence. Generates summary and action items via local LLM on meeting end. Meeting sessions stored with full transcript segments.

#### Feature 2: Intent Classification + Entity Extraction

- **Voice commands** — After Whisper transcribes, the intent classifier parses commands into structured actions. Supports: search, open_view, navigate, summarize, create_ticket, update_ticket, assign, set_status, add_label, comment.
- **Entity extraction** — Extracts ticket names, assignees, search queries, view names, and other entities from voice commands.
- **Rule-based V1** — Ships with regex pattern matching for immediate use, no model download needed.
- **LLM fallback** — When rule-based confidence is low, falls back to the local LLM for classification.
- **ActionRouter** — Maps classified intents to application actions (navigation, search, summarization, structured entry creation for future integrations).
- **Voice correction** — Say "no, I meant..." or "cancel" to undo the last command and re-classify.

#### Feature 3: Adaptive Notification Intelligence

- **In-app notification system** — New notification bell with unread badge, slide-out panel with notification cards. Sources: entry creation, analytics milestones, workflow suggestions, system events.
- **ML-powered ranking** — Small feedforward neural network learns which notifications you engage with vs. ignore. Starts with rule-based heuristics, begins ML ranking after ~50 interactions.
- **On-device training** — Model trains incrementally from your interaction patterns. Weights stored in SQLite. No data leaves the device.
- **Transparency** — Notifications show why they were ranked ("learning your preferences..." indicator during cold-start phase).

#### Feature 4: Auto-Discovered Workflows

- **Action logging** — Transparently logs action types (never content) as you use the app: create entries, search, dictate, use AI chat, play TTS, edit notes, etc.
- **Sequence mining** — Sliding-window algorithm detects repeating action patterns with temporal consistency (same day of week, same hour range).
- **Workflow suggestions** — Discovered patterns surface via the notification system with confidence scores. Users can save, name, dismiss, or edit workflows.
- **Next-action prediction** — Frequency-based predictor suggests what you might do next based on recent action history.

#### Feature 5: On-Device Semantic Search

- **Universal Sentence Encoder** — Generates 512-dimensional embeddings for all content using a ~30MB model running in the ML Web Worker.
- **Cosine similarity search** — Search by meaning, not just keywords. "find everything about authentication" returns semantically related entries even if they don't contain that exact word.
- **Incremental embedding** — New content is embedded on creation. Existing content can be bulk-indexed from Settings.
- **Merged search** — Semantic results combined with existing FTS5 keyword search for comprehensive results.

### Added — Infrastructure

- **TensorFlow.js runtime** — WebGL backend (falls back to CPU) with LRU model cache
- **ML Web Worker** — All TF.js inference runs in a dedicated Web Worker to keep the UI thread free. Typed message protocol with Promise-based client.
- **Web Audio API bridge** — Dual-pipeline audio capture: Web Audio + AudioWorklet for real-time VAD alongside Rust/cpal for Whisper recording
- **SQLite schema v3** — 11 new tables for ML features: vad_training_samples, intent_training_samples, voice_routing_log, meeting_sessions, notifications, notification_interactions, action_log, workflows, embeddings, ml_model_weights, tfjs_model_metadata
- **~50 new IPC channels** — Full CRUD for all ML data through the existing Electron IPC bridge
- **Voice AI settings tab** — Unified controls for all ML features with enable/disable toggles, sensitivity sliders, confidence thresholds, and "Delete all learned data" button
- **Notification UI** — NotificationBell component with unread badge and NotificationPanel slide-out drawer

### Changed

- **useRecordingStore** — Now integrates VAD: starts voice activity detection alongside recording, skips Whisper transcription when insufficient speech detected
- **SettingsPanel** — Added 7th tab (Voice AI) with Brain icon
- **Rust storage layer** — 8 new storage modules with ~40 CRUD functions
- **lib.rs** — ~50 new napi-rs exports for all ML storage operations
- **constants.ts** — ~50 new IPC channel definitions
- **preload/index.ts** — ~50 new typed preload API methods
- **types/index.ts** — New types: Notification, Workflow, MeetingSession, MLModelWeights, TurnDetectionMode, VoiceRoute, VoiceState

### Privacy

- All ML processing runs on-device via TensorFlow.js (renderer process Web Worker)
- VAD training stores MFCC audio features, never raw audio
- Action logging records action types only, never content
- All learned data stored in local SQLite, deletable per-feature or globally
- Total TF.js model bundle: ~46MB (well under 100MB budget)
- No new network calls introduced

---

## [1.0.15] - 2026-04-09

### Added
- **Analytics dashboard** — new analytics page with daily word counts, topic classification via local LLM, vocabulary richness metrics, streaks, and productivity comparison
- **LLM-powered topic classification** — batch processing of entries for topic tagging using local Mistral 7B

---

## [1.0.14] - 2026-04-08

### Fixed
- **Hardened release workflow** — merged Rust build and .node copy into a single step to prevent silent failures. Added pre-package verification that fails the build if the native addon or TTS voices are missing.
- **ModelManager resilience** — each IPC call (models, GPU status) now loads independently so one failure doesn't blank the entire Settings > Models section.

---

## [1.0.13] - 2026-04-08

### Fixed
- **Blank Models section in packaged app** — the release workflow built the Rust native addon but never copied it to `ironmic-core.node`, so electron-builder couldn't bundle it. The app fell back to JavaScript stubs with no model functions. Added a copy step that handles macOS (.dylib), Linux (.so), and Windows (.dll) correctly.

---

## [1.0.11] - 2026-04-07

### Changed
- **Models now hosted on GitHub Releases** — all model downloads (Whisper, LLM, TTS) now pull from `models-v1` release assets on the IronMic GitHub repo instead of HuggingFace. Eliminates external supply chain dependency. SHA-256 integrity verification on all files.
- **HuggingFace fallback** — if GitHub download fails after 3 retries, falls back to HuggingFace with a warning. Integrity still verified regardless of source.
- **LLM split-file download** — the 4.4 GB Mistral model is split into 3 parts (~1.5 GB each) on GitHub Releases (2 GB per-asset limit). Automatically reassembled and verified on download.
- **TTS voices bundled in installer** — all 15 English voice files (~7.5 MB total) are now included in the installer. Text-to-speech read-back works immediately without any download.
- **Per-variant Whisper downloads** — users can now download medium, small, and base Whisper models individually from Settings (previously only large-v3-turbo was downloadable).
- **LLM download button** — the Text Cleanup Model section now has a download button with progress tracking.
- **New `upload-models.yml` workflow** — manually-triggered GitHub Actions workflow to fetch models from HuggingFace, verify checksums, split the LLM, and upload all assets to a pinned models release.

---

## [1.0.10] - 2026-04-07

### Fixed
- **Model downloads broken in packaged builds** — model-downloader and all Rust model loaders (Whisper, LLM, TTS) used paths that don't exist in packaged apps (`__dirname` relative traversal and `env!("CARGO_MANIFEST_DIR")` compile-time path). Now uses `IRONMIC_MODELS_DIR` env var set by Electron main process, pointing to the user's app-data directory in production.
- **GPU always reports CPU-only in release builds** — release workflow was missing `--features metal,tts` flag, so Metal GPU support was compiled out. macOS builds now include `metal` feature; all platforms include `tts`.

---

## [1.0.9] - 2026-04-06

### Fixed
- **macOS DMG crash on launch** — Electron Framework failed to load due to code signing Team ID mismatch. Disabled code signing (`identity: null`) for unsigned builds so the main binary and framework signatures are consistent.
- **DictatePage crash** — `Cannot access 'editor' before initialization` error caused by `handleReadBack` callback referencing the TipTap editor before its `useEditor` declaration. Moved callback below the hook.

### Changed
- Added macOS unsigned-app install instructions to README (xattr quarantine removal + right-click Open)
- Removed hardened runtime entitlements from electron-builder config (not applicable without a signing certificate)

---

## [1.0.8] - 2026-04-06

### Added
- **Dictate page read-back** — new "Read Back" button reads editor content aloud via TTS, with pause/resume/stop controls
- **Dictate page persistence** — editor content survives navigation; drafts saved to localStorage automatically and restored on return
- **AI Assist settings tab** — new dedicated settings section for AI assistant configuration
- **AI model selection** — choose your model per provider (GPT-4.1 Mini default/free, GPT-4o, o3-mini, Claude Sonnet 4, Claude Opus 4, Claude Haiku 3.5, and more)
- **AI provider picker** — visual cards for GitHub Copilot and Claude Code CLI with live auth status and refresh
- **AI model passthrough** — selected model sent as `--model` flag to CLI adapters

### Changed
- AI enable toggle moved from General settings to dedicated AI Assist tab
- AI chat uses saved provider/model preferences instead of always auto-picking

---

## [1.0.6] - 2026-04-06

### Fixed
- Fix `cargo clippy --no-default-features -- -D warnings` (9 warnings)
  - Gate TTS-only code behind `#[cfg(feature = "tts")]`
  - Add `Default` impls for AudioRingBuffer, CaptureEngine, PlaybackEngine
  - Remove unused imports across lib.rs, kokoro.rs, playback.rs
- Fix `cargo test --no-default-features` (gate vocab test behind tts feature)
- Fix electron-builder packaging: 1024x1024 icon (was 256, below 512 minimum)
- Fix CI/release: run full `npm run build` (main + preload + renderer), not just vite
- Fix electron-builder auto-publish demanding GH_TOKEN (`--publish never`)
- Fix Linux .deb build: add author email for maintainer field
- Add macOS entitlements.mac.plist for hardened runtime (mic access, JIT)

### Added
- GitHub Releases workflow via `softprops/action-gh-release`
- Download section in README with link to Releases page
- `scripts/release.sh` — automated release script with version bumps, security scan, build verification, and git tag/push

---

## [1.0.0] - 2026-04-06

### Core Features
- **Voice-to-text transcription** via Whisper large-v3-turbo running locally through whisper.cpp
- **Text cleanup** via local Mistral 7B LLM — removes filler words, fixes grammar, polishes raw transcriptions
- **Text-to-speech** via Kokoro 82M ONNX — 15 English voices (American + British), word-level highlighting
- **Global hotkey** (Cmd+Shift+V / Ctrl+Shift+V) — record from anywhere, text copied to clipboard automatically
- **100% local processing** — no network calls, no cloud, no telemetry, no accounts

### Application
- **Dictate page** — TipTap rich text editor with voice input, full formatting toolbar, auto-save
- **Timeline** — scrollable card feed of all dictations with raw/polished toggle, pin, archive, delete
- **AI Assistant** — chat interface with session persistence, conversational voice mode, note attachment
- **Listen page** — text-to-speech with karaoke-style word highlighting, speed control, multiple voices
- **Notes** — notebook organization with tags, rich text editing, search
- **Search** — universal full-text search across dictations, AI sessions, and notes
- **Settings** — tabbed panel (General, Speech, Models, Data, Security) with model downloads and configuration

### Privacy & Security
- All audio processed in-memory only — never written to disk, buffers zeroed on drop
- Electron sandbox enabled with contextIsolation and nodeIntegration disabled
- SHA-256 checksum verification for all model downloads with domain-restricted HTTPS
- IPC input validation on all high-risk channels (buffer size limits, setting allowlists, prompt caps)
- Scoped environment variables for AI CLI child processes — no credential leakage
- XSS prevention — rehype-raw removed from AI markdown rendering
- Console log redaction — user content never logged in production
- Session timeout with configurable idle detection
- Clipboard auto-clear option
- Clear-on-exit option for sensitive data

### UI/UX
- Dark, light, and system theme support via CSS variable system
- Animated mic shield with state-based visuals (idle/recording/processing/success)
- Expandable sidebar navigation with grouped sections
- Toast notification system for cross-page feedback
- Welcome page with guided first-time setup and inline search
- Recording error recovery with auto-retry and force-reset

### Architecture
- Rust native addon via napi-rs (N-API) with feature-gated compilation
- cpal for cross-platform audio capture and output
- SQLite via rusqlite with FTS5 full-text search
- React 18 + Vite + Tailwind CSS frontend
- Zustand state management (7 stores)
- Electron 33 with IPC bridge via contextBridge

### Documentation
- SECURITY.md — comprehensive security policy and threat model
- AUDIT.md — code-referenced self-audit with 18 verified sections
- CLAUDE.md — full architecture reference and development guide
- README.md — user-facing documentation with quick start guide
