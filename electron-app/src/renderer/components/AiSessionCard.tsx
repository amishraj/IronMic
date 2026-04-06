import { Sparkles, MessageSquare, Clock, Trash2, Pin } from 'lucide-react';
import { Card } from './ui';
import { useAiChatStore, type AiSession } from '../stores/useAiChatStore';
import type { Entry } from '../types';

interface AiSessionCardProps {
  /** All entries belonging to this session */
  entries: Entry[];
  sessionId: string;
  onDelete: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
}

export function AiSessionCard({ entries, sessionId, onDelete, onPin }: AiSessionCardProps) {
  const session = useAiChatStore((s) => s.sessions.find((sess) => sess.id === sessionId));

  // Derive timestamps from entries
  const sorted = [...entries].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const firstEntry = sorted[0];
  const lastEntry = sorted[sorted.length - 1];
  const firstTime = firstEntry ? new Date(firstEntry.createdAt) : null;
  const lastTime = lastEntry ? new Date(lastEntry.createdAt) : null;

  // Last user message — from the session store (full conversation) or fall back to entry text
  const lastUserMsg = session
    ? [...session.messages].reverse().find((m) => m.role === 'user')
    : null;

  const previewText = lastUserMsg?.content
    || lastEntry?.polishedText
    || lastEntry?.rawTranscript
    || 'AI conversation';

  // Message count from session
  const messageCount = session?.messages.length ?? entries.length;
  const isPinned = entries.some((e) => e.isPinned);

  const handleOpen = () => {
    window.dispatchEvent(new CustomEvent('ironmic:open-ai-session', { detail: sessionId }));
    window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'ai' }));
  };

  const handleDelete = () => {
    // Delete all entries in this session
    entries.forEach((e) => onDelete(e.id));
  };

  const handlePin = () => {
    // Pin/unpin the first entry as a proxy
    if (firstEntry) onPin(firstEntry.id, !isPinned);
  };

  const formatTime = (d: Date) =>
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  return (
    <Card
      variant={isPinned ? 'highlighted' : 'default'}
      padding="none"
      className="animate-fade-in relative overflow-hidden border-l-[3px] border-l-purple-500"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <div className="flex items-center gap-2 text-[11px] text-iron-text-muted">
          <button
            onClick={handleOpen}
            className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-400 border border-purple-500/20 hover:bg-purple-500/25 cursor-pointer transition-colors"
            title="Open AI session"
          >
            <Sparkles className="w-3 h-3" />
            <span className="text-[10px] font-semibold tracking-wide uppercase">AI</span>
          </button>
          <div className="flex flex-col gap-0.5">
            {firstTime && (
              <span>Started {formatTime(firstTime)}</span>
            )}
            {lastTime && firstTime && lastTime.getTime() !== firstTime.getTime() && (
              <span>Last active {formatTime(lastTime)}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 text-[10px] text-iron-text-muted">
          <MessageSquare className="w-3 h-3" />
          <span>{messageCount} msg{messageCount !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {/* Preview text — last user message */}
      <button
        onClick={handleOpen}
        className="w-full text-left px-4 pb-3 group"
      >
        <p className="text-sm leading-relaxed text-iron-text line-clamp-3">
          {previewText}
        </p>
        <span className="text-[10px] text-purple-400 opacity-0 group-hover:opacity-100 transition-opacity mt-1 inline-flex items-center gap-1">
          <MessageSquare className="w-2.5 h-2.5" />
          Open conversation
        </span>
      </button>

      {/* Actions */}
      <div className="flex items-center gap-1 px-3 py-2 border-t border-iron-border">
        <button
          onClick={handleOpen}
          className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium text-purple-400 hover:bg-purple-500/10 transition-colors"
          title="Continue this AI conversation"
        >
          <MessageSquare className="w-3 h-3" />
          Continue
        </button>
        <div className="flex-1" />
        <button
          onClick={handlePin}
          title={isPinned ? 'Unpin' : 'Pin'}
          className={`p-1.5 rounded-lg transition-colors ${
            isPinned
              ? 'text-iron-accent-light bg-iron-accent/10'
              : 'text-iron-text-muted hover:text-iron-text-secondary hover:bg-iron-surface-hover'
          }`}
        >
          <Pin className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={handleDelete}
          title="Delete session entries"
          className="p-1.5 rounded-lg text-iron-text-muted hover:text-iron-danger hover:bg-iron-danger/10 transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </Card>
  );
}
