import { create } from 'zustand';
import type { MeetingTemplate } from '../services/tfjs/MeetingTemplateEngine';
import type { MeetingResult } from '../services/tfjs/MeetingDetector';

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

interface MeetingStore {
  templates: MeetingTemplate[];
  sessions: MeetingSession[];
  activeResult: MeetingResult | null;
  detectedApp: string | null;

  loadTemplates: () => Promise<void>;
  loadSessions: () => Promise<void>;
  createTemplate: (name: string, meetingType: string, sections: string[], llmPrompt: string) => Promise<void>;
  deleteTemplate: (id: string) => Promise<void>;
  setActiveResult: (result: MeetingResult | null) => void;
  setDetectedApp: (app: string | null) => void;
  deleteSession: (id: string) => Promise<void>;
}

export const useMeetingStore = create<MeetingStore>((set, get) => ({
  templates: [],
  sessions: [],
  activeResult: null,
  detectedApp: null,

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
}));
