import { create } from 'zustand';

export type AIProvider = 'copilot' | 'claude';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  provider?: AIProvider;
  timestamp: number;
}

export interface AiSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  provider: AIProvider | null;
  createdAt: number;
  updatedAt: number;
}

interface AiChatStore {
  sessions: AiSession[];
  activeSessionId: string | null;

  // Getters
  activeSession: () => AiSession | null;

  // Actions
  createSession: (provider: AIProvider | null) => string;
  setActiveSession: (id: string) => void;
  addMessage: (sessionId: string, message: ChatMessage) => void;
  deleteSession: (id: string) => void;
  updateSessionTitle: (id: string, title: string) => void;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function deriveTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return 'New Chat';
  const text = first.content.slice(0, 60);
  return text.length < first.content.length ? text + '...' : text;
}

function loadSessions(): AiSession[] {
  try {
    const raw = localStorage.getItem('ironmic-ai-sessions');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveSessions(sessions: AiSession[]) {
  localStorage.setItem('ironmic-ai-sessions', JSON.stringify(sessions));
}

export const useAiChatStore = create<AiChatStore>((set, get) => ({
  sessions: loadSessions(),
  activeSessionId: null,

  activeSession: () => {
    const { sessions, activeSessionId } = get();
    return sessions.find((s) => s.id === activeSessionId) || null;
  },

  createSession: (provider) => {
    const id = generateId();
    const session: AiSession = {
      id,
      title: 'New Chat',
      messages: [],
      provider,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const sessions = [session, ...get().sessions];
    saveSessions(sessions);
    set({ sessions, activeSessionId: id });
    return id;
  },

  setActiveSession: (id) => {
    set({ activeSessionId: id });
  },

  addMessage: (sessionId, message) => {
    const sessions = get().sessions.map((s) => {
      if (s.id !== sessionId) return s;
      const messages = [...s.messages, message];
      const title = s.messages.length === 0 && message.role === 'user'
        ? deriveTitle(messages)
        : s.title;
      return { ...s, messages, title, updatedAt: Date.now() };
    });
    saveSessions(sessions);
    set({ sessions });
  },

  deleteSession: (id) => {
    const sessions = get().sessions.filter((s) => s.id !== id);
    saveSessions(sessions);
    const activeSessionId = get().activeSessionId === id ? null : get().activeSessionId;
    set({ sessions, activeSessionId });
  },

  updateSessionTitle: (id, title) => {
    const sessions = get().sessions.map((s) =>
      s.id === id ? { ...s, title } : s
    );
    saveSessions(sessions);
    set({ sessions });
  },
}));
