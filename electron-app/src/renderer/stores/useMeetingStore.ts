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
  selectedAudioDevice: string | null;
  isGranolaRecording: boolean;
  /** True while backend is finishing the previous recording (draining buffer + diarization).
   *  Blocks starting a new recording until it returns to idle. */
  isGranolaStopping: boolean;
  /** Meeting IDs that are currently generating notes in the background. */
  processingMeetings: string[];

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
  loadSegmentsForSession: (sessionId: string) => Promise<void>;
  setSelectedAudioDevice: (device: string | null) => void;
  setIsGranolaRecording: (recording: boolean) => void;
  setIsGranolaStopping: (stopping: boolean) => void;

  markMeetingProcessing: (id: string) => void;
  unmarkMeetingProcessing: (id: string) => void;
  /** Update an in-memory session (e.g. after title edit) without a DB reload. */
  patchSession: (id: string, patch: Partial<MeetingSession>) => void;
}

const DEFAULT_ROOM_STATE = {
  roomMode: 'solo' as RoomMode,
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
  selectedAudioDevice: null,
  isGranolaRecording: false,
  isGranolaStopping: false,
  processingMeetings: [],
  ...DEFAULT_ROOM_STATE,
  roomDisplayName: 'Me',

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
  resetRoomState: () => set({ ...DEFAULT_ROOM_STATE, roomMode: 'solo' }),

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

  clearSegments: () => set({ segments: [] }),

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

  setIsGranolaRecording: (recording) => set({ isGranolaRecording: recording }),
  setIsGranolaStopping: (stopping) => set({ isGranolaStopping: stopping }),

  markMeetingProcessing: (id) =>
    set(state => state.processingMeetings.includes(id)
      ? state
      : { processingMeetings: [...state.processingMeetings, id] }),
  unmarkMeetingProcessing: (id) =>
    set(state => ({ processingMeetings: state.processingMeetings.filter(x => x !== id) })),
  patchSession: (id, patch) =>
    set(state => ({
      sessions: state.sessions.map(s => s.id === id ? { ...s, ...patch } : s),
    })),
}));
