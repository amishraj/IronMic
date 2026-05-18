import { useState, useRef, useEffect, useCallback } from 'react';

const EMOJI_POOL = [
  '📝', '💡', '🎯', '🔥', '✨', '🚀', '💬', '🎵', '📌', '🧠',
  '📎', '🌟', '💎', '🎨', '🔔', '📖', '🪄', '⚡', '🌈', '🍀',
  '🦋', '🎤', '💻', '🔑', '📊', '🛠️', '🧩', '🌍', '🎁', '🏷️',
  '❤️', '🧲', '🔮', '🎶', '📢', '✅', '🌻', '🍕', '☕', '🎲',
  '🐝', '🐱', '🐶', '🦊', '🐼', '🦄', '🐸', '🦉', '🐙', '🦀',
  '🌸', '🌺', '🍉', '🍋', '🥑', '🍩', '🧁', '🎂', '🌮', '🍣',
  '🏀', '⚽', '🎸', '🎹', '🎭', '🏔️', '🌊', '🏝️', '🎪', '🎠',
  '💫', '🌙', '☀️', '🔥', '❄️', '🌪️', '🎃', '👻', '🤖', '👾',
];

export function pickRandomEmoji(): string {
  return EMOJI_POOL[Math.floor(Math.random() * EMOJI_POOL.length)];
}

interface NoteEmojiPickerProps {
  emoji: string;
  onChange: (emoji: string) => void;
  /** Override button sizing — merged with base layout classes. */
  buttonClassName?: string;
}

export function NoteEmojiPicker({ emoji, onChange, buttonClassName }: NoteEmojiPickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open, handleClickOutside]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={`bg-iron-accent/10 flex items-center justify-center hover:bg-iron-accent/20 transition-colors cursor-pointer select-none ${
          buttonClassName ?? 'w-8 h-8 rounded-xl text-base'
        }`}
        title="Change note icon"
      >
        <span className="leading-none">{emoji}</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1.5 z-40 w-[280px] bg-iron-surface border border-iron-border rounded-xl shadow-xl p-2 animate-fade-in">
          <div className="grid grid-cols-8 gap-0.5">
            {EMOJI_POOL.map((e, i) => (
              <button
                key={`${e}-${i}`}
                type="button"
                onClick={() => { onChange(e); setOpen(false); }}
                className={`w-8 h-8 rounded-lg flex items-center justify-center text-base hover:bg-iron-surface-hover transition-colors ${
                  e === emoji ? 'bg-iron-accent/15 ring-1 ring-iron-accent/30' : ''
                }`}
              >
                {e}
              </button>
            ))}
          </div>
          <div className="mt-1.5 pt-1.5 border-t border-iron-border flex justify-between items-center px-1">
            <span className="text-[10px] text-iron-text-muted">Pick an icon for this note</span>
            <button
              type="button"
              onClick={() => { onChange(pickRandomEmoji()); setOpen(false); }}
              className="text-[10px] text-iron-accent-light hover:text-iron-accent transition-colors font-medium px-1.5 py-0.5 rounded hover:bg-iron-accent/10"
            >
              Random
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
