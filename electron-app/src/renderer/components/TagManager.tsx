import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { parseTags } from '../types';

interface TagManagerProps {
  entryId: string;
  tags: string | null;
  onUpdateTags: (id: string, tags: string[]) => void;
}

export function TagManager({ entryId, tags, onUpdateTags }: TagManagerProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [newTag, setNewTag] = useState('');
  const currentTags = parseTags(tags);

  const addTag = () => {
    const trimmed = newTag.trim();
    if (trimmed && !currentTags.includes(trimmed)) {
      onUpdateTags(entryId, [...currentTags, trimmed]);
    }
    setNewTag(''); setIsAdding(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      {currentTags.map((tag) => (
        <span key={tag} className="flex items-center gap-0.5 text-[10px] px-2 py-0.5 bg-iron-accent/10 text-iron-accent-light rounded-full border border-iron-accent/15">
          {tag}
          <button onClick={() => onUpdateTags(entryId, currentTags.filter((t) => t !== tag))} className="hover:text-iron-danger transition-colors">
            <X className="w-2.5 h-2.5" />
          </button>
        </span>
      ))}
      {isAdding ? (
        <input
          type="text" value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addTag(); if (e.key === 'Escape') { setIsAdding(false); setNewTag(''); } }}
          onBlur={addTag}
          placeholder="Tag"
          className="text-[10px] px-2 py-0.5 bg-iron-bg border border-iron-border rounded-full outline-none w-16 text-iron-text focus:border-iron-accent/50"
          autoFocus
        />
      ) : (
        <button onClick={() => setIsAdding(true)} className="flex items-center gap-0.5 text-[10px] px-2 py-0.5 text-iron-text-muted rounded-full hover:bg-iron-surface-hover transition-colors">
          <Plus className="w-2.5 h-2.5" /> Tag
        </button>
      )}
    </div>
  );
}
