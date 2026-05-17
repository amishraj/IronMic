/**
 * Loads and wraps the napi-rs Rust addon.
 * All heavy computation happens in Rust; Electron never touches audio or models directly.
 */

import path from 'path';

// The native addon will be loaded from the compiled .node file
// In development: ../rust-core/target/release/ironmic_core.node
// In production: bundled with the app
let nativeAddon: any = null;

function loadAddon(): any {
  if (nativeAddon) return nativeAddon;

  const possiblePaths = [
    // Development path
    path.join(__dirname, '..', '..', '..', 'rust-core', 'ironmic-core.node'),
    path.join(__dirname, '..', '..', '..', 'rust-core', 'target', 'release', 'ironmic_core.node'),
    // Production path (bundled)
    path.join(process.resourcesPath || '', 'ironmic-core.node'),
  ];

  for (const addonPath of possiblePaths) {
    try {
      const addon = require(addonPath);
      // Verify the addon actually has exported functions
      if (addon && typeof addon.getSetting === 'function') {
        nativeAddon = addon;
        if (process.env.NODE_ENV === 'development') {
          console.log(`[native-bridge] Loaded addon from: ${addonPath}`);
        }
        return nativeAddon;
      }
      if (process.env.NODE_ENV === 'development') {
        console.warn(`[native-bridge] Addon at ${addonPath} has no exports`);
      }
    } catch {
      // Try next path
    }
  }

  console.warn('[native-bridge] Native addon not available — using stubs');
  nativeAddon = createStubs();
  return nativeAddon;
}

function createStubs(): Record<string, (...args: any[]) => any> {
  return {
    startRecording: () => console.log('[stub] startRecording'),
    stopRecording: () => Buffer.alloc(0),
    isRecording: () => false,
    transcribe: async () => '[stub transcription]',
    transcribeShort: async () => '[stub transcription short]',
    polishText: async (text: string) => text,
    createEntry: (entry: any) => ({ id: 'stub-id', ...entry, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), displayMode: 'polished', isPinned: false, isArchived: false, tags: null }),
    getEntry: () => null,
    updateEntry: (_id: string, updates: any) => updates,
    deleteEntry: () => {},
    listEntries: () => [],
    pinEntry: () => {},
    archiveEntry: () => {},
    addWord: () => {},
    removeWord: () => {},
    listDictionary: () => [],
    refreshTranscriptionDictionary: () => 0,
    transcribeWithContext: async () => '[stub transcription with context]',
    getSetting: (key: string) => {
      const defaults: Record<string, string> = {
        hotkey_record: 'CommandOrControl+Shift+V',
        llm_cleanup_enabled: 'true',
        default_view: 'timeline',
        theme: 'system',
      };
      return defaults[key] ?? null;
    },
    setSetting: () => {},
    copyToClipboard: () => {},
    registerHotkey: () => {},
    getPipelineState: () => 'idle',
    resetPipelineState: () => {},
    getModelStatus: () => ({
      whisper: { loaded: false, name: 'whisper-large-v3-turbo', sizeBytes: 0 },
      llm: { loaded: false, name: 'mistral-7b-instruct-q4', sizeBytes: 0 },
    }),
    loadWhisperModel: () => {},
    getWhisperSystemInfo: () => '[stub: system info not available]',
    setWhisperNThreads: (_n: number) => {},
    // Engine management — Moonshine + Whisper multi-engine layer
    setTranscriptionEngine: (_kind: string) => {},
    getTranscriptionEngine: () => 'moonshine-base',
    listAvailableEngines: () => JSON.stringify([
      { kind: 'moonshine-base', isActive: true, isLoaded: false },
    ]),
    nativeFeatures: () => JSON.stringify({
      whisper: false,
      metal: false,
      llm: false,
      tts: false,
      platform: process.platform,
      arch: process.arch,
      stub: true,
    }),
    // Analytics stubs
    analyticsRecomputeToday: () => {},
    analyticsBackfill: async () => 0,
    analyticsGetOverview: (_period: string) => JSON.stringify({ totalWords: 0, totalSentences: 0, totalEntries: 0, totalDurationSeconds: 0, avgWordsPerMinute: 0, uniqueWords: 0, avgSentenceLength: 0, period: _period }),
    analyticsGetDailyTrend: () => '[]',
    analyticsGetTopWords: () => '[]',
    analyticsGetSourceBreakdown: () => '{}',
    analyticsGetVocabularyRichness: () => JSON.stringify({ ttr: 0, uniqueCount: 0, totalCount: 0 }),
    analyticsGetStreaks: () => JSON.stringify({ currentStreak: 0, longestStreak: 0, lastActiveDate: '' }),
    analyticsGetProductivityComparison: () => JSON.stringify({ thisPeriodWords: 0, prevPeriodWords: 0, changePercent: 0, periodLabel: 'week' }),
    analyticsGetTopicBreakdown: () => '[]',
    analyticsGetTopicTrends: () => '[]',
    analyticsClassifyTopicsBatch: async () => 0,
    analyticsGetUnclassifiedEntries: () => '[]',
    analyticsSaveEntryTopics: () => {},
    analyticsGetUnclassifiedCount: () => 0,
    // Moonshine streaming session API stubs (returns sensible no-ops so the
    // app works against older addon builds — canStream gate prevents use)
    moonshineSessionSupports: () => false,
    moonshineSessionAppend: async () => '',
    moonshineSessionCommit: async () => '',
    moonshineSessionReset: () => {},
    // Meeting recording stubs (Granola mode)
    startRecordingFromDevice: () => {},
    drainRecordingBuffer: () => Buffer.alloc(0),
    // Dual-stream meeting capture stubs (remote-meeting mode).
    // Real impls live in rust-core/src/audio/meeting_capture.rs +
    // loopback_windows.rs. The stub claims no loopback so renderer falls
    // back to single-stream behavior on un-rebuilt addons.
    startMeetingRecordingDual: () => {},
    drainMeetingBuffers: () => ({ mic: Buffer.alloc(0), loopback: null, loopbackActive: false }),
    stopMeetingRecordingDual: () => ({ mic: Buffer.alloc(0), loopback: null, loopbackActive: false }),
    meetingHasLoopback: () => false,
    resetMeetingRecordingDual: () => {},
    addTranscriptSegment: () => JSON.stringify({ id: 'stub', session_id: '', speaker_label: null, start_ms: 0, end_ms: 0, text: '', source: 'meeting', participant_id: null, confidence: null, created_at: new Date().toISOString() }),
    listTranscriptSegments: () => '[]',
    updateSegmentSpeaker: () => {},
    assembleFullTranscript: () => '',
    // Meeting session stubs — newer Rust builds add these; stubs keep the app
    // functional when the addon hasn't been (re-)built yet.
    createMeetingSession: () => JSON.stringify({ id: `stub-session-${Date.now()}`, created_at: new Date().toISOString() }),
    createMeetingSessionWithTemplate: (_templateId?: string, _detectedApp?: string) => JSON.stringify({ id: `stub-session-${Date.now()}`, created_at: new Date().toISOString() }),
    endMeetingSession: () => {},
    getMeetingSession: () => 'null',
    listMeetingSessions: () => '[]',
    deleteMeetingSession: () => {},
    setMeetingStructuredOutput: () => {},
    setMeetingStructuredOutputJson: () => {},
    setMeetingParticipants: () => {},
    addMeetingParticipant: () => {},
    markMeetingParticipantLeft: () => {},
    getMeetingParticipants: () => '[]',
    // 1.6 meeting overhaul stubs
    addTranscriptSegmentWithRemoteId: (sessionId: string, _label: any, startMs: number, endMs: number, text: string, source: string, remoteId: string) =>
      JSON.stringify({ id: `stub-${Date.now()}`, session_id: sessionId, speaker_label: null, start_ms: startMs, end_ms: endMs, text, source, participant_id: null, confidence: null, created_at: new Date().toISOString(), remote_segment_id: remoteId }),
    findLatestLocalSessionForRemote: () => 'null',
    getMaxMeetingSequence: () => 0,
    reopenMeetingSession: () => {},
    // User notes (Slice 0 / migration v10). Stubs let dev mode work without
    // a rebuilt addon; real implementations live in rust-core/src/storage/user_notes.rs.
    userNotesCreate: (note: any) => ({
      id: note.id ?? 'stub-note-' + Date.now(),
      title: note.title ?? '',
      content: note.content ?? '',
      polishedContent: note.polishedContent ?? null,
      displayMode: note.displayMode ?? 'raw',
      notebookId: note.notebookId ?? null,
      tags: note.tags ?? '[]',
      isPinned: note.isPinned ?? false,
      createdAt: note.createdAt ?? new Date().toISOString(),
      updatedAt: note.updatedAt ?? new Date().toISOString(),
    }),
    userNotesGet: () => null,
    userNotesUpdate: (id: string, updates: any) => ({
      id,
      title: '',
      content: '',
      polishedContent: null,
      displayMode: 'raw',
      notebookId: null,
      tags: '[]',
      isPinned: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...updates,
    }),
    userNotesDelete: () => {},
    userNotesList: () => [],
    userNotesBulkImport: () => 0,
    userNotebooksCreate: (name: string, color: string) => ({
      id: 'stub-nb-' + Date.now(),
      name,
      color,
      createdAt: new Date().toISOString(),
    }),
    userNotebooksRename: () => {},
    userNotebooksDelete: () => {},
    userNotebooksList: () => [],
    // Knowledge Q&A / RAG stubs — graceful fallback when the addon is older
    // than v13 / hasn't been rebuilt. Renderer code already null-checks
    // these via optional chaining; stubs return shapes the orchestrator
    // can handle ("no chunks indexed yet, no hits, no work to do").
    ragChunkEntry: () => 0,
    ragChunkUserNote: () => 0,
    ragChunkMeeting: () => 0,
    ragListUnchunkedSources: () => '[]',
    ragClassifyIntent: () => JSON.stringify({ intent: 'Topic', filters: {}, scope_label: 'All time' }),
    ragRetrieveHybrid: () => JSON.stringify({ hits: [], fts_count: 0, vector_count: 0, vector_used: false }),
    ragGetIndexStats: () => JSON.stringify({ active_model: 'bge-small-en-v1.5', total_chunks: 0, indexed_chunks: 0, by_source_type: {} }),
    ragDeleteChunksForSource: () => 0,
    ragRebuildIndex: () => 0,
    ragSetActiveModel: () => {},
    ragGetUnembeddedChunks: () => '[]',
    ragStoreChunkEmbeddings: () => 0,
  };
}

export const native = {
  get addon() {
    return loadAddon();
  },

  startRecording(): void { this.addon.startRecording(); },
  stopRecording(): Buffer { return this.addon.stopRecording(); },
  isRecording(): boolean { return this.addon.isRecording(); },
  transcribe(audioBuffer: Buffer): Promise<string> { return this.addon.transcribe(audioBuffer); },
  polishText(rawText: string): Promise<string> { return this.addon.polishText(rawText); },

  createEntry(entry: any): any { return this.addon.createEntry(entry); },
  getEntry(id: string): any { return this.addon.getEntry(id); },
  updateEntry(id: string, updates: any): any { return this.addon.updateEntry(id, updates); },
  deleteEntry(id: string): void { this.addon.deleteEntry(id); },
  listEntries(opts: any): any[] { return this.addon.listEntries(opts); },
  pinEntry(id: string, pinned: boolean): void { this.addon.pinEntry(id, pinned); },
  archiveEntry(id: string, archived: boolean): void { this.addon.archiveEntry(id, archived); },

  addWord(word: string): void { this.addon.addWord(word); },
  removeWord(word: string): void { this.addon.removeWord(word); },
  listDictionary(): string[] { return this.addon.listDictionary(); },
  /**
   * Reload the persisted dictionary from SQLite into the active transcription
   * engine. Cheap, idempotent. Older addon binaries lack this export — we
   * silently no-op so the app stays compatible.
   */
  refreshTranscriptionDictionary(): number {
    if (typeof this.addon.refreshTranscriptionDictionary === 'function') {
      return this.addon.refreshTranscriptionDictionary() ?? 0;
    }
    return 0;
  },
  /**
   * Transcribe with per-call context terms (meeting participant names).
   * Whisper layers them onto initial_prompt; Moonshine ignores them.
   * Falls back to plain `transcribe()` on older addon binaries.
   */
  transcribeWithContext(audioBuffer: Buffer, terms: string[]): Promise<string> {
    if (typeof this.addon.transcribeWithContext === 'function') {
      return this.addon.transcribeWithContext(audioBuffer, JSON.stringify(terms));
    }
    return this.addon.transcribe(audioBuffer);
  },

  getSetting(key: string): string | null { return this.addon.getSetting(key); },
  setSetting(key: string, value: string): void { this.addon.setSetting(key, value); },

  copyToClipboard(text: string): void { this.addon.copyToClipboard(text); },

  registerHotkey(accelerator: string): void { this.addon.registerHotkey(accelerator); },
  getPipelineState(): string { return this.addon.getPipelineState(); },
  resetPipelineState(): void { this.addon.resetPipelineState(); },
  getModelStatus(): any { return this.addon.getModelStatus(); },
  loadWhisperModel(): void { this.addon.loadWhisperModel(); },
  getWhisperSystemInfo(): string {
    return typeof this.addon.getWhisperSystemInfo === 'function'
      ? this.addon.getWhisperSystemInfo()
      : '[getWhisperSystemInfo not available in this build]';
  },
  setWhisperNThreads(n: number): void {
    if (typeof this.addon.setWhisperNThreads === 'function') {
      this.addon.setWhisperNThreads(n);
    }
  },

  // ── Multi-engine transcription (Phase 1 redesign) ──
  // setTranscriptionEngine swaps the active backend at runtime.
  // The next transcribe() call lazy-loads the new model.
  setTranscriptionEngine(kind: string): void {
    if (typeof this.addon.setTranscriptionEngine === 'function') {
      this.addon.setTranscriptionEngine(kind);
    } else {
      console.warn(
        '[native-bridge] setTranscriptionEngine not available in this build — ' +
          'Rust addon predates the engine-multi feature. Continuing with default Whisper engine.',
      );
    }
  },
  getTranscriptionEngine(): string {
    if (typeof this.addon.getTranscriptionEngine === 'function') {
      return this.addon.getTranscriptionEngine();
    }
    return 'moonshine-base';
  },
  listAvailableEngines(): Array<{ kind: string; isActive: boolean; isLoaded: boolean }> {
    if (typeof this.addon.listAvailableEngines !== 'function') {
      return [{ kind: 'moonshine-base', isActive: true, isLoaded: false }];
    }
    try {
      return JSON.parse(this.addon.listAvailableEngines());
    } catch (err) {
      console.warn('[native-bridge] listAvailableEngines parse failed:', err);
      return [];
    }
  },
  nativeFeatures(): { whisper: boolean; metal: boolean; llm: boolean; tts: boolean; platform: string; arch: string; stub?: boolean } {
    if (typeof this.addon.nativeFeatures !== 'function') {
      // Older addon binary — assume nothing is wired.
      return { whisper: false, metal: false, llm: false, tts: false, platform: process.platform, arch: process.arch, stub: true };
    }
    try { return JSON.parse(this.addon.nativeFeatures()); }
    catch { return { whisper: false, metal: false, llm: false, tts: false, platform: process.platform, arch: process.arch, stub: true }; }
  },

  // ── Moonshine streaming session API ────────────────────────────────────────
  // Optional — only present in builds compiled with the engine-multi feature.
  // DictationStreamer checks moonshineSessionSupports() before using these.
  moonshineSessionSupports(): boolean {
    return typeof this.addon.moonshineSessionSupports === 'function'
      ? this.addon.moonshineSessionSupports()
      : false;
  },
  moonshineSessionAppend(buffer: Buffer): Promise<string> {
    return this.addon.moonshineSessionAppend(buffer);
  },
  moonshineSessionCommit(): Promise<string> {
    return this.addon.moonshineSessionCommit();
  },
  moonshineSessionReset(): void {
    if (typeof this.addon.moonshineSessionReset === 'function') {
      this.addon.moonshineSessionReset();
    }
  },

  // ── Dual-stream meeting capture (remote-meeting mode) ─────────────────────
  // Mic + WASAPI loopback into separate ring buffers, so segments can be
  // tagged 'mic' vs 'loopback' at capture time instead of relying on LLM
  // diarization. Only the Windows target ships a working loopback half;
  // other platforms (and un-rebuilt addons) return loopbackActive=false and
  // the recorder falls back to mic-only.
  meetingDualSupported(): boolean {
    return typeof this.addon.startMeetingRecordingDual === 'function'
      && typeof this.addon.drainMeetingBuffers === 'function'
      && typeof this.addon.stopMeetingRecordingDual === 'function';
  },
  startMeetingRecordingDual(micDeviceName: string | null, loopbackMode: string): void {
    if (typeof this.addon.startMeetingRecordingDual === 'function') {
      this.addon.startMeetingRecordingDual(micDeviceName ?? undefined, loopbackMode);
    } else {
      throw new Error('Dual-stream meeting capture not supported by this addon build');
    }
  },
  drainMeetingBuffers(): { mic: Buffer; loopback: Buffer | null; loopbackActive: boolean } {
    const raw = this.addon.drainMeetingBuffers();
    return {
      mic: raw.mic,
      loopback: raw.loopback ?? null,
      loopbackActive: !!raw.loopbackActive,
    };
  },
  stopMeetingRecordingDual(): { mic: Buffer; loopback: Buffer | null; loopbackActive: boolean } {
    const raw = this.addon.stopMeetingRecordingDual();
    return {
      mic: raw.mic,
      loopback: raw.loopback ?? null,
      loopbackActive: !!raw.loopbackActive,
    };
  },
  meetingHasLoopback(): boolean {
    if (typeof this.addon.meetingHasLoopback === 'function') {
      return !!this.addon.meetingHasLoopback();
    }
    return false;
  },
  resetMeetingRecordingDual(): void {
    if (typeof this.addon.resetMeetingRecordingDual === 'function') {
      this.addon.resetMeetingRecordingDual();
    }
  },

  // Audio devices
  listAudioDevices(): string { return this.addon.listAudioDevices(); },
  getCurrentAudioDevice(): string { return this.addon.getCurrentAudioDevice(); },

  // Meeting templates
  createMeetingTemplate(name: string, meetingType: string, sections: string, llmPrompt: string, displayLayout: string): string { return this.addon.createMeetingTemplate(name, meetingType, sections, llmPrompt, displayLayout); },
  getMeetingTemplate(id: string): string { return this.addon.getMeetingTemplate(id); },
  listMeetingTemplates(): string { return this.addon.listMeetingTemplates(); },
  updateMeetingTemplate(id: string, name: string, meetingType: string, sections: string, llmPrompt: string, displayLayout: string): void { this.addon.updateMeetingTemplate(id, name, meetingType, sections, llmPrompt, displayLayout); },
  deleteMeetingTemplate(id: string): void { this.addon.deleteMeetingTemplate(id); },
  createMeetingSessionWithTemplate(templateId?: string, detectedApp?: string): string {
    // Prefer the richer export added in the meeting-recording POC build.
    // Fall back to the older createMeetingSession() so the app works on any
    // compiled addon version (e.g. a colleague whose Rust build is behind).
    if (typeof this.addon.createMeetingSessionWithTemplate === 'function') {
      return this.addon.createMeetingSessionWithTemplate(templateId, detectedApp);
    }
    console.warn('[native-bridge] createMeetingSessionWithTemplate not found — falling back to createMeetingSession()');
    if (typeof this.addon.createMeetingSession === 'function') {
      return this.addon.createMeetingSession();
    }
    // Last resort: return a stub so the UI doesn't crash
    console.warn('[native-bridge] createMeetingSession also not found — using in-memory stub');
    return JSON.stringify({ id: `local-${Date.now()}`, created_at: new Date().toISOString() });
  },
  setMeetingStructuredOutput(id: string, structuredOutput: string): void {
    if (typeof this.addon.setMeetingStructuredOutput === 'function') {
      this.addon.setMeetingStructuredOutput(id, structuredOutput);
    } else if (typeof this.addon.setMeetingStructuredOutputJson === 'function') {
      this.addon.setMeetingStructuredOutputJson(id, structuredOutput);
    } else {
      console.warn('[native-bridge] setMeetingStructuredOutput not found in addon — notes will not be persisted to DB');
    }
  },

  // ── Meeting participant roster (v1.6) ────────────────────────────────────
  // Persists historical roster (host + every joiner with leftAt timestamps).
  // All four exports degrade silently on older addon binaries that predate
  // the v7 schema migration — the renderer tolerates missing rosters.
  setMeetingParticipants(sessionId: string, participantsJson: string): void {
    if (typeof this.addon.setMeetingParticipants === 'function') {
      this.addon.setMeetingParticipants(sessionId, participantsJson);
    }
  },
  addMeetingParticipant(sessionId: string, participantJson: string): void {
    if (typeof this.addon.addMeetingParticipant === 'function') {
      this.addon.addMeetingParticipant(sessionId, participantJson);
    }
  },
  markMeetingParticipantLeft(sessionId: string, participantId: string, leftAt: number): void {
    if (typeof this.addon.markMeetingParticipantLeft === 'function') {
      this.addon.markMeetingParticipantLeft(sessionId, participantId, leftAt);
    }
  },
  getMeetingParticipants(sessionId: string): string {
    if (typeof this.addon.getMeetingParticipants === 'function') {
      return this.addon.getMeetingParticipants(sessionId);
    }
    return '[]';
  },

  // ── 1.6 meeting overhaul ────────────────────────────────────────────────
  // Cross-machine segment identity for participant rejoin dedup.
  // Falls back to the old non-deduping path on older addon binaries (which
  // means rejoin-after-leave duplicates segments — acceptable degradation
  // since legacy builds also lack the unique index).
  addTranscriptSegmentWithRemoteId(
    sessionId: string,
    speakerLabel: string | null,
    startMs: number,
    endMs: number,
    text: string,
    source: string,
    remoteSegmentId: string,
  ): string {
    if (typeof this.addon.addTranscriptSegmentWithRemoteId === 'function') {
      return this.addon.addTranscriptSegmentWithRemoteId(sessionId, speakerLabel, startMs, endMs, text, source, remoteSegmentId);
    }
    if (typeof this.addon.addTranscriptSegment === 'function') {
      return this.addon.addTranscriptSegment(sessionId, speakerLabel, startMs, endMs, text, source);
    }
    return JSON.stringify({ id: `local-${Date.now()}`, session_id: sessionId, speaker_label: speakerLabel, start_ms: startMs, end_ms: endMs, text, source, participant_id: null, confidence: null, created_at: new Date().toISOString() });
  },

  /** Returns `{ id, ended_at } | null` (already JSON-decoded) for the most
   *  recent local mirror session linked to a remote (host) session id —
   *  including ended rows. Used by the participant rejoin flow. */
  findLatestLocalSessionForRemote(remoteId: string): { id: string; ended_at: string | null } | null {
    if (typeof this.addon.findLatestLocalSessionForRemote !== 'function') return null;
    try {
      const raw = this.addon.findLatestLocalSessionForRemote(remoteId);
      if (!raw || raw === 'null') return null;
      return JSON.parse(raw);
    } catch (err) {
      console.warn('[native-bridge] findLatestLocalSessionForRemote parse failed:', err);
      return null;
    }
  },

  getMaxMeetingSequence(): number {
    if (typeof this.addon.getMaxMeetingSequence === 'function') {
      try { return Number(this.addon.getMaxMeetingSequence()) || 0; }
      catch { return 0; }
    }
    return 0;
  },

  reopenMeetingSession(id: string): void {
    if (typeof this.addon.reopenMeetingSession === 'function') {
      this.addon.reopenMeetingSession(id);
    }
  },

  // Export / Sharing
  copyHtmlToClipboard(html: string, fallbackText: string): void { this.addon.copyHtmlToClipboard(html, fallbackText); },
  exportEntryMarkdown(id: string): string { return this.addon.exportEntryMarkdown(id); },
  exportEntryJson(id: string): string { return this.addon.exportEntryJson(id); },
  exportEntryPlainText(id: string): string { return this.addon.exportEntryPlainText(id); },
  exportMeetingMarkdown(id: string): string { return this.addon.exportMeetingMarkdown(id); },
  textToHtml(text: string): string { return this.addon.textToHtml(text); },
};
