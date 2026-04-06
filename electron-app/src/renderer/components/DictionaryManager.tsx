import { useState, useEffect } from 'react';
import { Plus, X, BookOpen } from 'lucide-react';
import { Button } from './ui';

export function DictionaryManager() {
  const [words, setWords] = useState<string[]>([]);
  const [newWord, setNewWord] = useState('');
  const [loading, setLoading] = useState(true);

  const loadWords = async () => {
    try {
      const result = await window.ironmic.listDictionary();
      setWords(result);
    } catch (err) { console.error('Failed to load dictionary:', err); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadWords(); }, []);

  const addWord = async () => {
    const trimmed = newWord.trim();
    if (!trimmed) return;
    try { await window.ironmic.addWord(trimmed); setNewWord(''); await loadWords(); }
    catch (err) { console.error('Failed to add word:', err); }
  };

  const removeWord = async (word: string) => {
    try { await window.ironmic.removeWord(word); await loadWords(); }
    catch (err) { console.error('Failed to remove word:', err); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <BookOpen className="w-4 h-4 text-iron-text-muted" />
        <h3 className="text-sm font-semibold text-iron-text">Custom Dictionary</h3>
      </div>
      <p className="text-xs text-iron-text-muted">
        Add domain-specific words to improve recognition accuracy.
      </p>

      <div className="flex gap-2">
        <input
          type="text"
          value={newWord}
          onChange={(e) => setNewWord(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addWord()}
          placeholder="Add a word..."
          className="flex-1 text-sm px-3 py-1.5 bg-iron-bg border border-iron-border rounded-lg text-iron-text placeholder:text-iron-text-muted focus:outline-none focus:border-iron-accent/50 focus:shadow-glow transition-all"
        />
        <Button size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={addWord}>
          Add
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {words.map((word) => (
          <span
            key={word}
            className="flex items-center gap-1 text-xs px-2.5 py-1 bg-iron-surface-active rounded-full text-iron-text-secondary border border-iron-border"
          >
            {word}
            <button onClick={() => removeWord(word)} className="text-iron-text-muted hover:text-iron-danger transition-colors">
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        {words.length === 0 && !loading && (
          <span className="text-xs text-iron-text-muted">No custom words added yet.</span>
        )}
      </div>
    </div>
  );
}
