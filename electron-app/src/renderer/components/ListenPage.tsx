import { useState, useRef, useEffect } from 'react';
import { Volume2, Play, Pause, Square, Trash2, Info } from 'lucide-react';
import { useTtsStore } from '../stores/useTtsStore';
import { HighlightedText } from './HighlightedText';
import { Card } from './ui';

interface ListenEntry {
  id: string;
  text: string;
  createdAt: number;
}

export function ListenPage() {
  const [input, setInput] = useState('');
  const [entries, setEntries] = useState<ListenEntry[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const {
    state: ttsState, timestamps, currentTimeMs, activeEntryId, durationMs,
    synthesizeAndPlay, play, pause, stop, setSpeed, speed,
  } = useTtsStore();

  const handleSubmit = () => {
    const text = input.trim();
    if (!text) return;
    const entry: ListenEntry = {
      id: Date.now().toString(),
      text,
      createdAt: Date.now(),
    };
    setEntries((prev) => [entry, ...prev]);
    setInput('');
    // Auto-play immediately
    synthesizeAndPlay(text, entry.id);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handlePlayEntry = (entry: ListenEntry) => {
    if (activeEntryId === entry.id && ttsState === 'playing') {
      pause();
    } else if (activeEntryId === entry.id && ttsState === 'paused') {
      play();
    } else {
      synthesizeAndPlay(entry.text, entry.id);
    }
  };

  const handleRemoveEntry = (id: string) => {
    if (activeEntryId === id) stop();
    setEntries((prev) => prev.filter((e) => e.id !== id));
  };

  const progressPercent = durationMs > 0 ? Math.min((currentTimeMs / durationMs) * 100, 100) : 0;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 pt-6 pb-4">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center">
              <Volume2 className="w-5 h-5 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-iron-text">Listen</h2>
              <p className="text-xs text-iron-text-muted">Hear text read aloud, privately on your machine</p>
            </div>
          </div>

          {/* Info banner */}
          <Card variant="default" padding="md" className="mb-4">
            <div className="flex items-start gap-2.5">
              <Info className="w-4 h-4 text-iron-accent-light mt-0.5 flex-shrink-0" />
              <p className="text-xs text-iron-text-muted leading-relaxed">
                Paste or type any text below and it will be read aloud to you using the local Kokoro voice engine.
                Everything stays on your device — nothing is sent anywhere.
                The first playback may take a moment to start as the engine warms up.
                You can adjust the voice and speed in <button onClick={() => window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'settings' }))} className="text-iron-accent-light hover:underline">Settings</button>.
              </p>
            </div>
          </Card>

          {/* Text input */}
          <div className="relative">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Paste or type text you want to hear read aloud..."
              rows={4}
              className="w-full text-sm bg-iron-surface border border-iron-border rounded-xl text-iron-text placeholder:text-iron-text-muted px-4 py-3 resize-none transition-all focus:outline-none focus:border-iron-accent/50 focus:shadow-glow"
            />
            <div className="flex items-center justify-between mt-2">
              <span className="text-[10px] text-iron-text-muted">
                {input.trim() ? `${input.trim().split(/\s+/).length} words` : 'Enter + Send or Shift+Enter for new line'}
              </span>
              <button
                onClick={handleSubmit}
                disabled={!input.trim()}
                className="flex items-center gap-2 px-4 py-2 bg-gradient-accent text-white text-xs font-medium rounded-lg hover:shadow-glow transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <Volume2 className="w-3.5 h-3.5" />
                Read Aloud
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Entries */}
      <div className="flex-1 overflow-y-auto px-6 pb-6">
        <div className="max-w-2xl mx-auto space-y-3">
          {entries.length === 0 && (
            <div className="text-center py-16">
              <Volume2 className="w-10 h-10 text-iron-text-muted/20 mx-auto mb-3" />
              <p className="text-sm text-iron-text-muted">No listen entries yet</p>
              <p className="text-xs text-iron-text-muted mt-1">Type or paste text above to get started</p>
            </div>
          )}

          {entries.map((entry) => {
            const isThis = activeEntryId === entry.id;
            const isPlaying = isThis && ttsState === 'playing';
            const isPaused = isThis && ttsState === 'paused';
            const isSynthesizing = isThis && ttsState === 'synthesizing';
            const isActive = isPlaying || isPaused || isSynthesizing;

            return (
              <Card key={entry.id} variant={isActive ? 'highlighted' : 'default'} padding="none" className="overflow-hidden">
                {/* Content with word highlighting */}
                <div className="px-5 pt-4 pb-3">
                  <div className="text-sm leading-relaxed text-iron-text">
                    <HighlightedText
                      text={entry.text}
                      timestamps={isThis ? timestamps : []}
                      currentTimeMs={currentTimeMs}
                      isPlaying={isPlaying}
                    />
                  </div>
                  <p className="text-[10px] text-iron-text-muted mt-2">
                    {new Date(entry.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                    {' · '}
                    {entry.text.trim().split(/\s+/).length} words
                  </p>
                </div>

                {/* Progress bar */}
                {isActive && (
                  <div className="w-full h-1 bg-iron-surface-active">
                    <div
                      className="h-full bg-emerald-500 transition-all duration-100"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                )}

                {/* Controls */}
                <div className="flex items-center gap-2 px-4 py-2 border-t border-iron-border">
                  {/* Play/Pause */}
                  <button
                    onClick={() => handlePlayEntry(entry)}
                    disabled={isSynthesizing}
                    className={`p-2 rounded-lg transition-all ${
                      isPlaying
                        ? 'bg-emerald-500/15 text-emerald-400'
                        : 'text-iron-text-muted hover:text-iron-text-secondary hover:bg-iron-surface-hover'
                    } disabled:opacity-40`}
                    title={isPlaying ? 'Pause' : 'Play'}
                  >
                    {isSynthesizing ? (
                      <div className="w-4 h-4 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
                    ) : isPlaying ? (
                      <Pause className="w-4 h-4" />
                    ) : (
                      <Play className="w-4 h-4" />
                    )}
                  </button>

                  {/* Stop */}
                  {isActive && (
                    <button
                      onClick={() => stop()}
                      className="p-2 rounded-lg text-iron-text-muted hover:text-iron-danger hover:bg-iron-danger/10 transition-all"
                      title="Stop"
                    >
                      <Square className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {/* Speed */}
                  {isActive && (
                    <div className="flex items-center gap-1 ml-2">
                      {[0.75, 1.0, 1.25, 1.5, 2.0].map((s) => (
                        <button
                          key={s}
                          onClick={() => setSpeed(s)}
                          className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-all ${
                            speed === s
                              ? 'bg-emerald-500/15 text-emerald-400'
                              : 'text-iron-text-muted hover:text-iron-text-secondary'
                          }`}
                        >
                          {s}x
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="flex-1" />

                  {/* Remove */}
                  <button
                    onClick={() => handleRemoveEntry(entry.id)}
                    className="p-2 rounded-lg text-iron-text-muted hover:text-iron-danger hover:bg-iron-danger/10 transition-all"
                    title="Remove"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
