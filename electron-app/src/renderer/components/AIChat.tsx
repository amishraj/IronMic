import { useState, useEffect, useRef, useCallback } from 'react';
import { Bot, Send, Mic, Square, RefreshCw, Sparkles, AlertCircle, Plus, MessageSquare, Trash2, X, Volume2, Pause, BookOpen, StickyNote, MessageCircle } from 'lucide-react';
import { useRecordingStore } from '../stores/useRecordingStore';
import { useAiChatStore, type ChatMessage, type AIProvider } from '../stores/useAiChatStore';
import { useTtsStore } from '../stores/useTtsStore';
import { NotePickerModal } from './NotePickerModal';
import type { Note } from '../stores/useNotesStore';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface AuthStatus {
  installed: boolean;
  authenticated: boolean;
  version: string | null;
}

export function AIChat() {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState('');
  const [provider, setProvider] = useState<AIProvider | null>(null);
  const [authState, setAuthState] = useState<{ copilot: AuthStatus; claude: AuthStatus; local: AuthStatus } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  const [showNotePicker, setShowNotePicker] = useState(false);
  const [attachedNotes, setAttachedNotes] = useState<Note[]>([]);
  const [conversational, setConversational] = useState(false);
  const conversationalRef = useRef(false);
  conversationalRef.current = conversational;

  const { sessions, activeSessionId, activeSession, createSession, setActiveSession, addMessage, deleteSession } =
    useAiChatStore();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { handleHotkeyPress, state: recordingState } = useRecordingStore();

  const session = activeSession();
  const messages = session?.messages ?? [];

  // Load auth & auto-create session on mount
  useEffect(() => {
    loadAuth();
  }, []);

  // Listen for streaming output
  useEffect(() => {
    const cleanupOutput = window.ironmic.onAiOutput((data: any) => {
      if (data.type === 'text' && data.content) {
        setStreaming((prev) => prev + data.content);
      }
    });
    const cleanupEnd = window.ironmic.onAiTurnEnd(() => {
      setStreaming('');
      setLoading(false);
    });
    return () => { cleanupOutput(); cleanupEnd(); };
  }, []);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streaming]);

  // Listen for navigate-to-session events (from EntryCard "Continue" button)
  useEffect(() => {
    const handler = (e: Event) => {
      const sessionId = (e as CustomEvent).detail;
      if (sessionId) setActiveSession(sessionId);
    };
    window.addEventListener('ironmic:open-ai-session', handler);
    return () => window.removeEventListener('ironmic:open-ai-session', handler);
  }, [setActiveSession]);

  async function loadAuth() {
    try {
      const state = await window.ironmic.aiGetAuthState();
      setAuthState(state);
      // Use saved provider preference, fall back to auto-pick
      const savedProvider = await window.ironmic.getSetting('ai_provider');
      if (savedProvider && (savedProvider === 'claude' || savedProvider === 'copilot' || savedProvider === 'local')) {
        const auth = savedProvider === 'claude' ? state.claude : savedProvider === 'copilot' ? state.copilot : state.local;
        if (auth?.authenticated) {
          setProvider(savedProvider as AIProvider);
          return;
        }
      }
      const best = await window.ironmic.aiPickProvider();
      setProvider(best as AIProvider | null);
    } catch (err) {
      console.error('Failed to load AI auth:', err);
    }
  }

  const sendText = useCallback(async (text: string): Promise<string | null> => {
    if (!text || loading || !provider) return null;

    // Get the current session ID directly from the store (avoids stale closure)
    let sessionId = useAiChatStore.getState().activeSessionId;
    if (!sessionId) {
      sessionId = createSession(provider);
    }

    // Build prompt with attached notes as context
    let fullPrompt = text;
    if (attachedNotes.length > 0) {
      const context = attachedNotes.map((n) =>
        `[Note: ${n.title || 'Untitled'}]\n${n.content}`
      ).join('\n\n');
      fullPrompt = `Context from my notes:\n\n${context}\n\n---\n\n${text}`;
      setAttachedNotes([]); // Clear after sending
    }

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };

    addMessage(sessionId, userMsg);
    setInput('');
    setLoading(true);
    setError(null);
    setStreaming('');

    try {
      // Resolve the model ID for the CURRENT provider. We can't just trust
      // the persisted `ai_model` setting — it may carry a stale cloud model
      // id (e.g. `claude-sonnet-4-...`) from a previous session that would
      // then be sent to the local LLM, which rejects it with "Unknown local
      // LLM model". Filter by provider convention: local model IDs start
      // with `llm`; cloud IDs do not. If the stored value doesn't match the
      // current provider's convention, drop it and let the main process
      // pick a reasonable default.
      const [genericModel, localModel] = await Promise.all([
        window.ironmic.getSetting('ai_model'),
        window.ironmic.getSetting('ai_local_model'),
      ]);
      let modelId: string | undefined;
      if (provider === 'local') {
        const candidate = localModel || genericModel;
        modelId = candidate && candidate.startsWith('llm') ? candidate : undefined;
      } else {
        // Cloud providers: accept the generic setting iff it's NOT a local id.
        modelId = genericModel && !genericModel.startsWith('llm') ? genericModel : undefined;
      }
      const response = await window.ironmic.aiSendMessage(fullPrompt, provider, modelId);

      const assistantMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: response,
        provider,
        timestamp: Date.now(),
      };
      addMessage(sessionId, assistantMsg);

      // In conversational mode: TTS the response, then auto-record
      if (conversationalRef.current && response.trim()) {
        const plainText = response
          .replace(/```[\s\S]*?```/g, '')
          .replace(/`([^`]+)`/g, '$1')
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/\*([^*]+)\*/g, '$1')
          .replace(/#{1,6}\s/g, '')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/[>\-|]/g, '')
          .replace(/\n{2,}/g, '. ')
          .replace(/\n/g, ' ')
          .trim();

        if (plainText) {
          try {
            await useTtsStore.getState().synthesizeAndPlay(plainText, assistantMsg.id);
            // Wait for TTS to finish, then auto-start recording
            const waitForTtsEnd = () => new Promise<void>((resolve) => {
              const check = setInterval(() => {
                const tts = useTtsStore.getState();
                if (tts.state === 'idle') {
                  clearInterval(check);
                  resolve();
                }
              }, 300);
              // Safety timeout: 2 minutes
              setTimeout(() => { clearInterval(check); resolve(); }, 120000);
            });
            await waitForTtsEnd();
            // If still in conversational mode, auto-start recording
            if (conversationalRef.current) {
              handleHotkeyPress('ai-chat');
            }
          } catch { /* TTS optional */ }
        }
      }

      return response;
    } catch (err: any) {
      setError(err.message || 'AI request failed');
      const errorMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'system',
        content: err.message || 'Request failed',
        timestamp: Date.now(),
      };
      addMessage(sessionId, errorMsg);
      return null;
    } finally {
      setLoading(false);
      setStreaming('');
    }
  }, [loading, provider, addMessage, createSession, handleHotkeyPress]);

  const handleSend = useCallback(() => {
    sendText(input.trim());
  }, [input, sendText]);

  // When the sidebar mic is used on the AI tab, receive the dictation
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent).detail;
      if (!text || typeof text !== 'string') return;
      const trimmed = text.trim();
      if (!trimmed) return;

      if (conversationalRef.current) {
        // Conversational mode: auto-send immediately
        sendText(trimmed);
      } else {
        // Normal mode: put in input field so user can review/edit before sending
        setInput((prev) => prev ? prev + ' ' + trimmed : trimmed);
        inputRef.current?.focus();
      }
    };
    window.addEventListener('ironmic:ai-dictation', handler);
    return () => window.removeEventListener('ironmic:ai-dictation', handler);
  }, [sendText]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleVoiceInput = useCallback(async () => {
    await handleHotkeyPress('ai-chat');
  }, [handleHotkeyPress]);

  const handleNewChat = () => {
    const id = createSession(provider);
    setActiveSession(id);
    setStreaming('');
    setError(null);
    window.ironmic.aiResetSession();
  };

  const noProvider = !provider;

  return (
    <div className="flex h-full bg-iron-bg">
      {/* Session sidebar */}
      {showSessions && (
        <div className="w-56 flex-shrink-0 border-r border-iron-border bg-iron-surface flex flex-col">
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-iron-border">
            <span className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">Sessions</span>
            <button
              onClick={handleNewChat}
              className="p-1 rounded-md text-iron-text-muted hover:text-iron-accent-light hover:bg-iron-surface-hover transition-colors"
              title="New chat"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {sessions.length === 0 && (
              <p className="text-[11px] text-iron-text-muted text-center py-6">No sessions yet</p>
            )}
            {sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => setActiveSession(s.id)}
                className={`w-full flex items-start gap-2 px-3 py-2 text-left transition-colors group ${
                  activeSessionId === s.id
                    ? 'bg-iron-accent/10 text-iron-text'
                    : 'text-iron-text-secondary hover:bg-iron-surface-hover'
                }`}
              >
                <MessageSquare className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 opacity-50" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{s.title}</p>
                  <p className="text-[10px] text-iron-text-muted mt-0.5">
                    {s.messages.length} message{s.messages.length !== 1 ? 's' : ''}
                  </p>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}
                  className="p-0.5 rounded opacity-0 group-hover:opacity-100 text-iron-text-muted hover:text-iron-danger transition-all"
                  title="Delete session"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-iron-border">
          <div className="flex items-center gap-2.5">
            <button
              onClick={() => setShowSessions(!showSessions)}
              className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${
                showSessions ? 'bg-iron-accent/15 text-iron-accent-light' : 'bg-iron-accent/10 text-iron-accent-light hover:bg-iron-accent/15'
              }`}
              title={showSessions ? 'Hide sessions' : 'Show sessions'}
            >
              <MessageSquare className="w-4 h-4" />
            </button>
            <div>
              <h3 className="text-sm font-semibold text-iron-text">
                {session?.title || 'AI Assistant'}
              </h3>
              <div className="flex items-center gap-2 mt-0.5">
                {provider && (
                  <div className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-iron-success" />
                    <span className="text-[10px] text-iron-text-muted capitalize">{provider}</span>
                  </div>
                )}
                {!provider && authState && (
                  <span className="text-[10px] text-iron-text-muted">No AI provider connected</span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {authState && (
              <div className="flex items-center gap-1 mr-2">
                <ProviderPill
                  name="Claude"
                  status={authState.claude}
                  active={provider === 'claude'}
                  onClick={() => authState.claude.authenticated && setProvider('claude')}
                />
                <ProviderPill
                  name="Copilot"
                  status={authState.copilot}
                  active={provider === 'copilot'}
                  onClick={() => authState.copilot.authenticated && setProvider('copilot')}
                />
                <ProviderPill
                  name="Local"
                  status={authState.local}
                  active={provider === 'local'}
                  onClick={() => authState.local?.authenticated && setProvider('local')}
                />
              </div>
            )}
            {/* Conversational mode toggle */}
            <button
              onClick={() => setConversational(!conversational)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all ${
                conversational
                  ? 'bg-iron-success/15 text-iron-success border border-iron-success/20'
                  : 'text-iron-text-muted hover:bg-iron-surface-hover'
              }`}
              title={conversational ? 'Conversational mode ON — click to turn off' : 'Turn on conversational mode (voice back-and-forth)'}
            >
              <MessageCircle className="w-3.5 h-3.5" />
              {conversational ? 'Voice Chat' : 'Voice Chat'}
            </button>
            <button
              onClick={() => loadAuth()}
              className="p-1.5 rounded-lg text-iron-text-muted hover:text-iron-text-secondary hover:bg-iron-surface-hover transition-colors"
              title="Refresh auth status"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleNewChat}
              className="p-1.5 rounded-lg text-iron-text-muted hover:text-iron-text-secondary hover:bg-iron-surface-hover transition-colors"
              title="New chat"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {messages.length === 0 && !loading && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-12 h-12 rounded-2xl bg-iron-accent/10 flex items-center justify-center mb-4">
                <Bot className="w-6 h-6 text-iron-accent-light" />
              </div>
              <p className="text-sm font-medium text-iron-text">AI Assistant</p>
              <p className="text-xs text-iron-text-muted mt-1 max-w-[280px]">
                {noProvider
                  ? 'No AI provider detected. Install and authenticate GitHub Copilot CLI or Claude Code CLI.'
                  : 'Ask anything. You can type or use the mic button to dictate your question.'}
              </p>
            </div>
          )}

          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}

          {loading && streaming && (
            <div className="flex gap-3">
              <div className="w-6 h-6 rounded-md bg-iron-accent/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Bot className="w-3.5 h-3.5 text-iron-accent-light" />
              </div>
              <div className="prose-chat text-sm text-iron-text leading-relaxed">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {streaming}
                </ReactMarkdown>
                <span className="inline-block w-1.5 h-4 bg-iron-accent ml-0.5 animate-pulse" />
              </div>
            </div>
          )}

          {loading && !streaming && (
            <div className="flex items-center gap-2 text-iron-text-muted">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-iron-accent animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-iron-accent animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-iron-accent animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
              <span className="text-xs">Thinking...</span>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="px-4 py-3 border-t border-iron-border">
          {error && (
            <div className="flex items-center gap-2 text-xs text-iron-danger mb-2">
              <AlertCircle className="w-3 h-3" />
              {error}
            </div>
          )}

          {/* Conversational mode indicator */}
          {conversational && (
            <div className="flex items-center gap-2 mb-2 px-1">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-iron-success opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-iron-success" />
              </span>
              <span className="text-[11px] text-iron-success font-medium">
                {recordingState === 'recording' ? 'Listening...' : loading ? 'AI is thinking...' : 'Voice chat active — speak or type'}
              </span>
            </div>
          )}

          {/* Attached notes preview */}
          {attachedNotes.length > 0 && (
            <div className="flex items-center gap-1.5 mb-2 flex-wrap">
              <span className="text-[10px] text-iron-text-muted">Context:</span>
              {attachedNotes.map((n) => (
                <span key={n.id} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/15">
                  <StickyNote className="w-2.5 h-2.5" />
                  {n.title || 'Untitled'}
                  <button onClick={() => setAttachedNotes((prev) => prev.filter((x) => x.id !== n.id))} className="ml-0.5 hover:text-iron-danger"><X className="w-2.5 h-2.5" /></button>
                </span>
              ))}
            </div>
          )}

          <div className="flex items-end gap-2">
            {/* Mic button */}
            <button
              onClick={handleVoiceInput}
              className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all flex-shrink-0 ${
                recordingState === 'recording'
                  ? 'bg-iron-danger text-white shadow-glow-danger animate-pulse-recording'
                  : 'bg-iron-surface-hover text-iron-text-muted hover:text-iron-text-secondary'
              }`}
              title={recordingState === 'recording' ? 'Stop recording' : 'Dictate message'}
            >
              <Mic className="w-4 h-4" />
            </button>

            {/* Add note/memory button */}
            <button
              onClick={() => setShowNotePicker(true)}
              className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all flex-shrink-0 ${
                attachedNotes.length > 0
                  ? 'bg-emerald-500/15 text-emerald-400'
                  : 'bg-iron-surface-hover text-iron-text-muted hover:text-iron-text-secondary'
              }`}
              title="Attach a note as context"
            >
              <BookOpen className="w-4 h-4" />
            </button>

            {/* Text input */}
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={noProvider ? 'No AI provider connected...' : 'Type a message or use the mic...'}
              disabled={noProvider}
              rows={1}
              className="flex-1 min-w-0 text-sm bg-iron-surface border border-iron-border rounded-xl text-iron-text placeholder:text-iron-text-muted px-4 py-2.5 resize-none transition-all focus:outline-none focus:border-iron-accent/50 focus:shadow-glow disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ maxHeight: '120px', minHeight: '40px' }}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement;
                target.style.height = 'auto';
                target.style.height = Math.min(target.scrollHeight, 120) + 'px';
              }}
            />

            {/* Send / Stop button */}
            <button
              onClick={loading ? () => window.ironmic.aiCancel() : handleSend}
              disabled={noProvider || (!input.trim() && !loading)}
              className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
                loading
                  ? 'bg-iron-danger/15 hover:bg-iron-danger/25'
                  : 'bg-iron-accent/15 hover:bg-iron-accent/25'
              }`}
              title={loading ? 'Stop' : 'Send'}
            >
              {loading ? (
                <Square className="w-4 h-4 text-iron-danger" />
              ) : (
                <Send className="w-4 h-4 text-iron-accent-light" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Note picker modal */}
      <NotePickerModal
        open={showNotePicker}
        onClose={() => setShowNotePicker(false)}
        onSelect={(note) => {
          setAttachedNotes((prev) => {
            if (prev.find((n) => n.id === note.id)) return prev;
            return [...prev, note];
          });
          setShowNotePicker(false);
        }}
        selectedIds={new Set(attachedNotes.map((n) => n.id))}
      />
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const { state: ttsState, activeEntryId, synthesizeAndPlay, stop } = useTtsStore();

  // Use message ID as the "entry ID" for TTS tracking
  const isThisPlaying = activeEntryId === message.id && (ttsState === 'playing' || ttsState === 'synthesizing');

  const handleReadAloud = async () => {
    if (isThisPlaying) {
      await stop();
    } else {
      // Strip markdown for cleaner TTS — remove common syntax
      const plainText = message.content
        .replace(/```[\s\S]*?```/g, '') // remove code blocks
        .replace(/`([^`]+)`/g, '$1')    // inline code → text
        .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
        .replace(/\*([^*]+)\*/g, '$1')     // italic
        .replace(/#{1,6}\s/g, '')          // headings
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
        .replace(/[>\-|]/g, '')            // blockquote, list, table chars
        .replace(/\n{2,}/g, '. ')          // paragraph breaks → pause
        .replace(/\n/g, ' ')
        .trim();
      if (plainText) {
        await synthesizeAndPlay(plainText, message.id);
      }
    }
  };

  if (isSystem) {
    return (
      <div className="flex justify-center">
        <span className="text-[11px] text-iron-danger bg-iron-danger/10 px-3 py-1 rounded-full">
          {message.content}
        </span>
      </div>
    );
  }

  return (
    <div className={`flex gap-3 group ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 mt-0.5 ${
        isUser ? 'bg-iron-accent/20' : 'bg-iron-accent/10'
      }`}>
        {isUser ? (
          <span className="text-[10px] font-bold text-iron-accent-light">U</span>
        ) : (
          <Bot className="w-3.5 h-3.5 text-iron-accent-light" />
        )}
      </div>
      <div className={`max-w-[80%] ${isUser ? 'text-right' : ''}`}>
        <div className={`inline-block text-sm leading-relaxed rounded-xl px-3.5 py-2 ${
          isUser
            ? 'bg-iron-accent/15 text-iron-text whitespace-pre-wrap'
            : 'bg-iron-surface text-iron-text border border-iron-border'
        }`}>
          {isUser ? (
            message.content
          ) : (
            <div className="prose-chat">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {message.content}
              </ReactMarkdown>
            </div>
          )}
        </div>
        {/* Actions row */}
        <div className={`flex items-center gap-2 mt-1 ${isUser ? 'justify-end' : ''}`}>
          {message.provider && !isUser && (
            <span className="text-[10px] text-iron-text-muted capitalize">via {message.provider}</span>
          )}
          <button
            onClick={handleReadAloud}
            className={`p-1 rounded-md transition-all ${
              isThisPlaying
                ? 'text-iron-accent-light bg-iron-accent/10'
                : 'text-iron-text-muted/0 group-hover:text-iron-text-muted hover:!text-iron-accent-light hover:bg-iron-surface-hover'
            }`}
            title={isThisPlaying ? 'Stop reading' : 'Read aloud'}
          >
            {isThisPlaying ? (
              <Pause className="w-3 h-3" />
            ) : (
              <Volume2 className="w-3 h-3" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProviderPill({ name, status, active, onClick }: {
  name: string; status: AuthStatus; active: boolean; onClick: () => void;
}) {
  const connected = status.installed && status.authenticated;

  return (
    <button
      onClick={onClick}
      disabled={!connected}
      className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium transition-all ${
        active
          ? 'bg-iron-accent/15 text-iron-accent-light border border-iron-accent/20'
          : connected
          ? 'text-iron-text-muted hover:bg-iron-surface-hover'
          : 'text-iron-text-muted/40 cursor-not-allowed'
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${
        connected ? 'bg-iron-success' : 'bg-iron-text-muted/30'
      }`} />
      {name}
    </button>
  );
}
