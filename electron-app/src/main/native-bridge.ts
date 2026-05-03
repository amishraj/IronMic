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

  // Export / Sharing
  copyHtmlToClipboard(html: string, fallbackText: string): void { this.addon.copyHtmlToClipboard(html, fallbackText); },
  exportEntryMarkdown(id: string): string { return this.addon.exportEntryMarkdown(id); },
  exportEntryJson(id: string): string { return this.addon.exportEntryJson(id); },
  exportEntryPlainText(id: string): string { return this.addon.exportEntryPlainText(id); },
  exportMeetingMarkdown(id: string): string { return this.addon.exportMeetingMarkdown(id); },
  textToHtml(text: string): string { return this.addon.textToHtml(text); },
};
