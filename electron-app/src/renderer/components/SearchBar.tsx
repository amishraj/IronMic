import { Search, X } from 'lucide-react';

interface SearchBarProps {
  query: string;
  onQueryChange: (query: string) => void;
}

export function SearchBar({ query, onQueryChange }: SearchBarProps) {
  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-iron-text-muted" />
      <input
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search dictations..."
        className="w-full pl-9 pr-8 py-2 text-sm bg-iron-bg border border-iron-border rounded-lg text-iron-text placeholder:text-iron-text-muted transition-all hover:border-iron-border-hover focus:outline-none focus:border-iron-accent/50 focus:shadow-glow"
      />
      {query && (
        <button
          onClick={() => onQueryChange('')}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-iron-text-muted hover:text-iron-text-secondary transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
