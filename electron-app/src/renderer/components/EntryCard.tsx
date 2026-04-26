import { useState, memo } from 'react';
import { Pin, Archive, Trash2, Clock, Sparkles, MessageSquare } from 'lucide-react';
import { RawPolishedToggle } from './RawPolishedToggle';
import { PlaybackControls } from './PlaybackControls';
import { HighlightedText } from './HighlightedText';
import { ShareMenu } from './ShareMenu';
import { Card } from './ui';
import { parseTags, parseTitleTag } from '../types';
import { useTtsStore } from '../stores/useTtsStore';
import type { Entry } from '../types';

/** Parse sourceApp to check if it's an AI entry and extract the session ID */
function parseAiSource(sourceApp: string | null): { isAi: boolean; sessionId: string | null } {
  if (!sourceApp) return { isAi: false, sessionId: null };
  if (sourceApp === 'ai-chat') return { isAi: true, sessionId: null };
  if (sourceApp.startsWith('ai-chat:')) return { isAi: true, sessionId: sourceApp.slice(8) };
  return { isAi: false, sessionId: null };
}

interface EntryCardProps {
  entry: Entry;
  onDelete: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onArchive: (id: string, archived: boolean) => void;
  onPolish: (id: string) => void;
  onTagClick?: (tag: string) => void;
  /** True while this entry's polish pass is running. Drives the spinner
   *  in RawPolishedToggle. */
  isPolishing?: boolean;
}

function EntryCardInner({ entry, onDelete, onPin, onArchive, onPolish, onTagClick, isPolishing }: EntryCardProps) {
  const [displayMode, setDisplayMode] = useState<'raw' | 'polished'>(
    entry.polishedText ? 'polished' : 'raw'
  );
  const { state: ttsState, timestamps, currentTimeMs, activeEntryId } = useTtsStore();

  const text = displayMode === 'polished' && entry.polishedText
    ? entry.polishedText
    : entry.rawTranscript;

  const isThisPlaying = activeEntryId === entry.id && (ttsState === 'playing' || ttsState === 'paused');

  const tags = parseTags(entry.tags);
  const noteTitle = parseTitleTag(entry.tags);
  const time = new Date(entry.createdAt).toLocaleString();

  const { isAi, sessionId } = parseAiSource(entry.sourceApp);

  const handleContinueInAi = () => {
    // Navigate to AI tab and open this session
    if (sessionId) {
      window.dispatchEvent(new CustomEvent('ironmic:open-ai-session', { detail: sessionId }));
    }
    window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'ai' }));
  };

  return (
    <Card
      variant={entry.isPinned ? 'highlighted' : 'default'}
      padding="none"
      className={`animate-fade-in relative overflow-hidden ${isAi ? 'border-l-[3px] border-l-purple-500' : ''}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <div className="flex items-center gap-2 text-[11px] text-iron-text-muted">
          {isAi ? (
            <button
              onClick={sessionId ? handleContinueInAi : undefined}
              className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-400 border border-purple-500/20 ${
                sessionId ? 'hover:bg-purple-500/25 cursor-pointer transition-colors' : ''
              }`}
              title={sessionId ? 'Open AI session' : 'AI-generated entry'}
            >
              <Sparkles className="w-3 h-3" />
              <span className="text-[10px] font-semibold tracking-wide uppercase">AI</span>
            </button>
          ) : (
            <Clock className="w-3 h-3" />
          )}
          <span>{time}</span>
          {entry.durationSeconds && (
            <span className="text-iron-text-muted">· {entry.durationSeconds.toFixed(1)}s</span>
          )}
          {entry.sourceApp && !isAi && (
            <span className="text-iron-text-muted">· {entry.sourceApp}</span>
          )}
        </div>
        <RawPolishedToggle
          displayMode={displayMode}
          hasPolished={!!entry.polishedText}
          onToggle={() => setDisplayMode((m) => (m === 'raw' ? 'polished' : 'raw'))}
          onPolishNow={() => onPolish(entry.id)}
          isPolishing={isPolishing}
        />
      </div>

      {noteTitle && (
        <div className="px-4 pt-0.5 pb-1">
          <p className="text-sm font-semibold text-iron-text truncate">{noteTitle}</p>
        </div>
      )}

      {/* Content */}
      <div className="text-sm leading-relaxed whitespace-pre-wrap px-4 pb-3 text-iron-text">
        <HighlightedText
          text={text}
          timestamps={isThisPlaying ? timestamps : []}
          currentTimeMs={currentTimeMs}
          isPlaying={isThisPlaying && ttsState === 'playing'}
        />
      </div>

      {/* Tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1 px-4 pb-3">
          {tags.map((tag) => (
            <button
              key={tag}
              onClick={() => onTagClick?.(tag)}
              className="text-[10px] px-2 py-0.5 bg-iron-accent/10 text-iron-accent-light rounded-full border border-iron-accent/15 hover:bg-iron-accent/20 transition-colors"
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-1 px-3 py-2 border-t border-iron-border">
        <PlaybackControls text={text} entryId={entry.id} compact />
        <ShareMenu entryId={entry.id} text={text} rawText={entry.rawTranscript} />
        {isAi && sessionId && (
          <>
            <div className="w-px h-4 bg-iron-border mx-0.5" />
            <button
              onClick={handleContinueInAi}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium text-purple-400 hover:bg-purple-500/10 transition-colors"
              title="Continue this AI conversation"
            >
              <MessageSquare className="w-3 h-3" />
              Continue
            </button>
          </>
        )}
        <div className="w-px h-4 bg-iron-border mx-0.5" />
        <ActionBtn
          onClick={() => onPin(entry.id, !entry.isPinned)}
          active={entry.isPinned}
          icon={<Pin className="w-3.5 h-3.5" />}
          title={entry.isPinned ? 'Unpin' : 'Pin'}
        />
        <ActionBtn
          onClick={() => onArchive(entry.id, true)}
          icon={<Archive className="w-3.5 h-3.5" />}
          title="Archive"
        />
        <ActionBtn
          onClick={() => onDelete(entry.id)}
          icon={<Trash2 className="w-3.5 h-3.5" />}
          title="Delete"
          danger
        />
      </div>
    </Card>
  );
}

/**
 * Stable memo comparator: only re-render when the entry's content changes or
 * the polish state flips. Avoids O(n) re-renders across the entire Timeline
 * when a single entry is updated.
 */
export const EntryCard = memo(EntryCardInner, (prev, next) =>
  prev.entry.id === next.entry.id &&
  prev.entry.updatedAt === next.entry.updatedAt &&
  prev.entry.displayMode === next.entry.displayMode &&
  prev.entry.isPinned === next.entry.isPinned &&
  prev.isPolishing === next.isPolishing,
);

function ActionBtn({ onClick, icon, title, active, danger }: {
  onClick: () => void; icon: React.ReactNode; title: string; active?: boolean; danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`p-1.5 rounded-lg transition-colors ${
        active
          ? 'text-iron-accent-light bg-iron-accent/10'
          : danger
          ? 'text-iron-text-muted hover:text-iron-danger hover:bg-iron-danger/10'
          : 'text-iron-text-muted hover:text-iron-text-secondary hover:bg-iron-surface-hover'
      }`}
    >
      {icon}
    </button>
  );
}
