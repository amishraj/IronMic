import { create } from 'zustand';
import type { MeetingTemplate } from '../services/tfjs/MeetingTemplateEngine';
import type { MeetingResult } from '../services/tfjs/MeetingDetector';
import type { TranscriptSegment } from '../components/MeetingTranscriptPanel';

interface MeetingSession {
  id: string;
  started_at: string;
  ended_at?: string;
  speaker_count: number;
  summary?: string;
  action_items?: string;
  total_duration_seconds?: number;
  template_id?: string;
  structured_output?: string;
  detected_app?: string;
}

export type RoomMode = 'solo' | 'host' | 'participant';

export interface RoomParticipantSummary {
  id: string;
  displayName: string;
  joinedAt: number;
}

interface MeetingStore {
  // Room mode state (LAN multi-user)
  roomMode: RoomMode;
  roomCode: string | null;
  roomHostIp: string | null;
  roomHostPort: number | null;
  roomHostName: string | null;
  roomInviteString: string | null;
  roomParticipants: RoomParticipantSummary[];
  roomDisplayName: string;
  roomError: string | null;
  /** Self-mute during a live meeting. Source of truth is backend
   *  MeetingRecorder.state.isMicMuted, mirrored here via MEETING_RECORDING_STATE
   *  events. When true, no local STT and no segment broadcast. */
  isMicMuted: boolean;
  setIsMicMuted: (muted: boolean) => void;
  setRoomMode: (mode: RoomMode) => void;
  setRoomDisplayName: (name: string) => void;
  setRoomError: (err: string | null) => void;
  applyRoomState: (info: any) => void;
  applyParticipantUpdate: (msg: any) => void;
  resetRoomState: () => void;

  templates: MeetingTemplate[];
  sessions: MeetingSession[];
  activeResult: MeetingResult | null;
  detectedApp: string | null;

  // Granola-mode recording state
  segments: TranscriptSegment[];
  /** Live Moonshine session hypothesis — rendered as grey italic text in the
   *  transcript panel while the user is mid-utterance. Replaced (not appended)
   *  on each update; cleared on commit, session reset, and recording stop. */
  draftHypothesis: string;
  /** True when the active recording is using the Moonshine streaming session
   *  path (live grey-typing). False for the legacy chunked path (Whisper or
   *  Moonshine fallback). Driven by the recorder's MeetingRecordingState. */
  streamingMode: boolean;
  /** True when the active recording is using the dual-stream remote-meeting
   *  capture pipeline (mic + WASAPI loopback). Drives the gear-popover hint
   *  that streaming is disabled in this mode. */
  remoteCaptureMode: boolean;
  /** True when remote capture was requested but the loopback half failed to
   *  open. Used to surface a "loopback unavailable" indicator. */
  remoteCaptureLoopbackActive: boolean;
  selectedAudioDevice: string | null;
  isGranolaRecording: boolean;
  /** True while backend is finishing the previous recording (draining buffer + diarization).
   *  Blocks starting a new recording until it returns to idle. */
  isGranolaStopping: boolean;
  /** True while the recorder is mid-flight on a streaming↔chunked engine
   *  swap. Renderer reads this to show a spinner / "Switching engine…"
   *  indicator without unmounting the live meeting UI (which would happen
   *  if the swap flipped status through 'stopping'). Cleared by the
   *  recorder when the swap completes. */
  isEngineSwapping: boolean;
  /** Active session ID — kept in Zustand (not component local state) so it survives
   *  MeetingPage unmount when the user switches tabs mid-recording. */
  granolaSessionId: string | null;
  /** Unix ms timestamp when the current recording started — used by the timer so it
   *  shows accurate elapsed time after a tab switch/remount. */
  granolaRecordingStartedAt: number | null;
  /** Meeting IDs that are currently generating notes in the background. */
  processingMeetings: string[];
  /** Meeting IDs whose final audio chunk is still being transcribed in the
   *  background (after the user clicked End Meeting). The summary is already
   *  visible; this drives a non-blocking "Transcribing…" label. */
  transcribingMeetings: string[];

  // ── Per-meeting STT engine lifecycle ─────────────────────────────────────
  /**
   * Global `transcription_engine` value captured at meeting start, so we can
   * restore it on meeting end. Lives here (not in MeetingPage component state)
   * so it survives MeetingPage unmount when the user navigates to another tab
   * mid-meeting — the meeting itself runs in main and outlives the React tree.
   *
   * Always captured by `applyMeetingEngine()` BEFORE any swap or readiness
   * check, even if the meeting engine matches the prior — without this, a
   * subsequent live-switch via the gear popover would have nothing to
   * restore to on meeting end.
   *
   * Cleared by `restoreMeetingEngine()` after the swap-back. Not persisted —
   * if the renderer reloads mid-meeting the prior is lost; crash-recovery of
   * the dictation engine is out of scope (user fixes via Settings).
   */
  priorTranscriptionEngine: string | null;
  /** True once `applyMeetingEngine()` has executed (success or graceful no-op). */
  meetingEngineApplied: boolean;
  setPriorTranscriptionEngine: (engine: string | null) => void;
  setMeetingEngineApplied: (applied: boolean) => void;

  loadTemplates: () => Promise<void>;
  loadSessions: () => Promise<void>;
  createTemplate: (name: string, meetingType: string, sections: string[], llmPrompt: string) => Promise<void>;
  deleteTemplate: (id: string) => Promise<void>;
  setActiveResult: (result: MeetingResult | null) => void;
  setDetectedApp: (app: string | null) => void;
  deleteSession: (id: string) => Promise<void>;

  // Granola-mode actions
  addSegment: (segment: TranscriptSegment) => void;
  clearSegments: () => void;
  setDraftHypothesis: (text: string) => void;
  setStreamingMode: (enabled: boolean) => void;
  setRemoteCaptureMode: (enabled: boolean) => void;
  setRemoteCaptureLoopbackActive: (active: boolean) => void;
  loadSegmentsForSession: (sessionId: string) => Promise<void>;
  setSelectedAudioDevice: (device: string | null) => void;
  setIsGranolaRecording: (recording: boolean) => void;
  setIsGranolaStopping: (stopping: boolean) => void;
  setIsEngineSwapping: (swapping: boolean) => void;
  setGranolaSessionId: (id: string | null) => void;
  setGranolaRecordingStartedAt: (ts: number | null) => void;

  markMeetingProcessing: (id: string) => void;
  unmarkMeetingProcessing: (id: string) => void;
  markMeetingTranscribing: (id: string) => void;
  unmarkMeetingTranscribing: (id: string) => void;
  /** Update an in-memory session (e.g. after title edit) without a DB reload. */
  patchSession: (id: string, patch: Partial<MeetingSession>) => void;
}

const DEFAULT_ROOM_STATE = {
  roomMode: 'host' as RoomMode,
  roomCode: null as string | null,
  roomHostIp: null as string | null,
  roomHostPort: null as number | null,
  roomHostName: null as string | null,
  roomInviteString: null as string | null,
  roomParticipants: [] as RoomParticipantSummary[],
  roomError: null as string | null,
};

export const useMeetingStore = create<MeetingStore>((set, get) => ({
  templates: [],
  sessions: [],
  activeResult: null,
  detectedApp: null,
  segments: [],
  draftHypothesis: '',
  streamingMode: false,
  remoteCaptureMode: false,
  remoteCaptureLoopbackActive: false,
  selectedAudioDevice: null,
  isGranolaRecording: false,
  isGranolaStopping: false,
  isEngineSwapping: false,
  granolaSessionId: null,
  granolaRecordingStartedAt: null,
  processingMeetings: [],
  transcribingMeetings: [],
  priorTranscriptionEngine: null,
  meetingEngineApplied: false,
  ...DEFAULT_ROOM_STATE,
  roomDisplayName: 'Me',
  isMicMuted: false,

  setIsMicMuted: (muted) => set({ isMicMuted: muted }),
  setRoomMode: (mode) => set({ roomMode: mode }),
  setRoomDisplayName: (name) => {
    set({ roomDisplayName: name });
    window.ironmic?.setSetting?.('meeting_display_name', name).catch(() => {});
  },
  setRoomError: (err) => set({ roomError: err }),
  applyRoomState: (info) => {
    if (!info) return;
    // Host server pushes RoomInfo; client pushes RoomClientInfo. We accept both.
    set({
      roomCode: info.roomCode ?? null,
      roomHostIp: info.ip ?? info.hostIp ?? null,
      roomHostPort: info.port ?? info.hostPort ?? null,
      roomHostName: info.hostName ?? null,
      roomInviteString: info.inviteString ?? null,
      roomParticipants: Array.isArray(info.participants)
        ? info.participants.map((p: any) => ({
            id: p.id, displayName: p.displayName, joinedAt: p.joinedAt,
          }))
        : get().roomParticipants,
      roomError: info.error ?? null,
    });
  },
  applyParticipantUpdate: (msg) => {
    if (!msg) return;
    if (msg.type === 'participant_joined') {
      set(state => state.roomParticipants.find(p => p.id === msg.participantId)
        ? state
        : { roomParticipants: [...state.roomParticipants, {
            id: msg.participantId, displayName: msg.displayName, joinedAt: Date.now(),
          }] });
    } else if (msg.type === 'participant_left') {
      set(state => ({ roomParticipants: state.roomParticipants.filter(p => p.id !== msg.participantId) }));
    }
  },
  resetRoomState: () => set({ ...DEFAULT_ROOM_STATE, isMicMuted: false }),

  loadTemplates: async () => {
    try {
      const json = await window.ironmic.templateList();
      const templates = JSON.parse(json);
      set({ templates });
    } catch (err) {
      console.error('[useMeetingStore] Failed to load templates:', err);
    }
  },

  loadSessions: async () => {
    try {
      const json = await window.ironmic.meetingList(50, 0);
      const sessions = JSON.parse(json);
      set({ sessions });
    } catch (err) {
      console.error('[useMeetingStore] Failed to load sessions:', err);
    }
  },

  createTemplate: async (name, meetingType, sections, llmPrompt) => {
    try {
      const sectionsJson = JSON.stringify(sections);
      const displayLayout = JSON.stringify({ order: sections });
      await window.ironmic.templateCreate(name, meetingType, sectionsJson, llmPrompt, displayLayout);
      await get().loadTemplates();
    } catch (err) {
      console.error('[useMeetingStore] Failed to create template:', err);
    }
  },

  deleteTemplate: async (id) => {
    try {
      await window.ironmic.templateDelete(id);
      await get().loadTemplates();
    } catch (err) {
      console.error('[useMeetingStore] Failed to delete template:', err);
    }
  },

  setActiveResult: (result) => set({ activeResult: result }),
  setDetectedApp: (app) => set({ detectedApp: app }),

  deleteSession: async (id) => {
    try {
      await window.ironmic.meetingDelete(id);
      await get().loadSessions();
    } catch (err) {
      console.error('[useMeetingStore] Failed to delete session:', err);
    }
  },

  // Granola-mode actions
  addSegment: (segment) =>
    set(state => ({ segments: [...state.segments, segment] })),

  clearSegments: () => set({ segments: [], draftHypothesis: '' }),

  setDraftHypothesis: (text) => set({ draftHypothesis: text }),
  setStreamingMode: (enabled) => set({ streamingMode: enabled }),
  setRemoteCaptureMode: (enabled) => set({ remoteCaptureMode: enabled }),
  setRemoteCaptureLoopbackActive: (active) => set({ remoteCaptureLoopbackActive: active }),

  loadSegmentsForSession: async (sessionId) => {
    try {
      const raw = await window.ironmic.listTranscriptSegments(sessionId);
      const segs = JSON.parse(raw) as TranscriptSegment[];
      set({ segments: segs });
    } catch (err) {
      console.error('[useMeetingStore] Failed to load segments:', err);
    }
  },

  setSelectedAudioDevice: (device) => {
    set({ selectedAudioDevice: device });
    // Persist choice to settings
    window.ironmic?.setSetting?.('meeting_audio_device', device ?? '').catch(() => {});
  },

  setIsGranolaRecording: (recording) => set({
    isGranolaRecording: recording,
    // Reset self-mute on every recording state transition (start AND stop) so
    // mute can never carry across sessions. This is the renderer-side mirror
    // of the backend reset in MeetingRecorder; backend remains source of truth.
    isMicMuted: false,
  }),
  setIsGranolaStopping: (stopping) => set({ isGranolaStopping: stopping }),
  setIsEngineSwapping: (swapping) => set({ isEngineSwapping: swapping }),
  setGranolaSessionId: (id) => set({ granolaSessionId: id }),
  setGranolaRecordingStartedAt: (ts) => set({ granolaRecordingStartedAt: ts }),

  markMeetingProcessing: (id) =>
    set(state => state.processingMeetings.includes(id)
      ? state
      : { processingMeetings: [...state.processingMeetings, id] }),
  unmarkMeetingProcessing: (id) =>
    set(state => ({ processingMeetings: state.processingMeetings.filter(x => x !== id) })),
  markMeetingTranscribing: (id) =>
    set(state => state.transcribingMeetings.includes(id)
      ? state
      : { transcribingMeetings: [...state.transcribingMeetings, id] }),
  unmarkMeetingTranscribing: (id) =>
    set(state => ({ transcribingMeetings: state.transcribingMeetings.filter(x => x !== id) })),
  patchSession: (id, patch) =>
    set(state => ({
      sessions: state.sessions.map(s => s.id === id ? { ...s, ...patch } : s),
    })),

  setPriorTranscriptionEngine: (engine) => set({ priorTranscriptionEngine: engine }),
  setMeetingEngineApplied: (applied) => set({ meetingEngineApplied: applied }),
}));
