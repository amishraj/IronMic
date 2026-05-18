import { useState, useEffect, useRef, useCallback } from 'react';
import { Trash2, Download, ArrowDown, Filter, AlertTriangle, Info, Bug, AlertCircle } from 'lucide-react';
import { logCapture, type LogLevel, type LogEntry } from '../services/LogCapture';

const LEVEL_CONFIG: Record<LogLevel, { label: string; color: string; bgColor: string; icon: typeof Info }> = {
  debug: { label: 'DEBUG', color: 'text-iron-text-muted', bgColor: 'bg-iron-surface-active', icon: Bug },
  info: { label: 'INFO', color: 'text-blue-400', bgColor: 'bg-blue-500/10', icon: Info },
  warn: { label: 'WARN', color: 'text-yellow-400', bgColor: 'bg-yellow-500/10', icon: AlertTriangle },
  error: { label: 'ERROR', color: 'text-red-400', bgColor: 'bg-red-500/10', icon: AlertCircle },
};

export function LogsPage() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<Set<LogLevel>>(new Set(['info', 'warn', 'error']));
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const counts = useRef<Record<LogLevel, number>>({ debug: 0, info: 0, warn: 0, error: 0 });

  const refreshEntries = useCallback(() => {
    const filtered = logCapture.getFiltered(filter);
    setEntries(filtered);
    counts.current = logCapture.getCounts();
  }, [filter]);

  useEffect(() => {
    refreshEntries();
    const unsub = logCapture.subscribe(refreshEntries);
    return unsub;
  }, [refreshEntries]);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    // If user scrolled up, disable auto-scroll. If at bottom, re-enable.
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
  };

  const toggleLevel = (level: LogLevel) => {
    setFilter((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  const handleExport = () => {
    const text = logCapture.exportAsText();
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ironmic-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClear = () => {
    logCapture.clear();
    setEntries([]);
  };

  const currentCounts = logCapture.getCounts();

  // Apply search filter
  const displayEntries = search.trim()
    ? entries.filter((e) => e.message.toLowerCase().includes(search.toLowerCase()) || e.source?.toLowerCase().includes(search.toLowerCase()))
    : entries;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-iron-border bg-iron-surface/30">
        <div className="flex items-center gap-2">
          {/* Level filters */}
          {(Object.keys(LEVEL_CONFIG) as LogLevel[]).map((level) => {
            const config = LEVEL_CONFIG[level];
            const active = filter.has(level);
            const count = currentCounts[level];
            return (
              <button
                key={level}
                onClick={() => toggleLevel(level)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all ${
                  active
                    ? `${config.bgColor} ${config.color} border border-current/20`
                    : 'text-iron-text-muted/50 border border-transparent hover:text-iron-text-muted'
                }`}
              >
                {config.label}
                {count > 0 && (
                  <span className={`text-[10px] ${active ? 'opacity-70' : 'opacity-40'}`}>{count}</span>
                )}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          {/* Search */}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter logs..."
            className="w-40 px-2.5 py-1.5 text-[11px] bg-iron-surface border border-iron-border rounded-lg text-iron-text placeholder:text-iron-text-muted focus:outline-none focus:border-iron-accent/30"
          />

          {/* Auto-scroll indicator */}
          <button
            onClick={() => {
              setAutoScroll(true);
              if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            }}
            className={`p-1.5 rounded-lg transition-colors ${
              autoScroll ? 'text-iron-accent-light bg-iron-accent/10' : 'text-iron-text-muted hover:text-iron-text-secondary hover:bg-iron-surface-hover'
            }`}
            title={autoScroll ? 'Auto-scroll on' : 'Click to scroll to bottom'}
          >
            <ArrowDown className="w-3.5 h-3.5" />
          </button>

          {/* Export */}
          <button
            onClick={handleExport}
            className="p-1.5 rounded-lg text-iron-text-muted hover:text-iron-text-secondary hover:bg-iron-surface-hover transition-colors"
            title="Export logs as .txt"
          >
            <Download className="w-3.5 h-3.5" />
          </button>

          {/* Clear */}
          <button
            onClick={handleClear}
            className="p-1.5 rounded-lg text-iron-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
            title="Clear all logs"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Log entries */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto font-mono text-[11px] leading-relaxed bg-iron-bg"
      >
        {displayEntries.length === 0 && (
          <div className="flex items-center justify-center h-full text-iron-text-muted text-xs">
            {entries.length === 0 ? 'No logs captured yet. Use the app and logs will appear here.' : 'No logs match your filter.'}
          </div>
        )}

        {displayEntries.map((entry) => (
          <LogRow key={entry.id} entry={entry} search={search} />
        ))}
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-1.5 border-t border-iron-border bg-iron-surface/30 text-[10px] text-iron-text-muted">
        <span>{displayEntries.length} / {logCapture.getEntries().length} entries</span>
        <span>Max {1000} entries (oldest auto-removed)</span>
      </div>
    </div>
  );
}

function LogRow({ entry, search }: { entry: LogEntry; search: string }) {
  const config = LEVEL_CONFIG[entry.level];
  const Icon = config.icon;
  const time = new Date(entry.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 } as any);

  return (
    <div className={`flex items-start gap-2 px-4 py-1 border-b border-iron-border/30 hover:bg-iron-surface-hover/30 ${
      entry.level === 'error' ? 'bg-red-500/[0.03]' : entry.level === 'warn' ? 'bg-yellow-500/[0.02]' : ''
    }`}>
      <Icon className={`w-3 h-3 mt-0.5 flex-shrink-0 ${config.color}`} />
      <span className="text-iron-text-muted flex-shrink-0 w-20">{time}</span>
      {entry.source && (
        <span className="text-iron-accent-light flex-shrink-0 w-24 truncate" title={entry.source}>[{entry.source}]</span>
      )}
      <span className={`flex-1 break-all ${entry.level === 'error' ? 'text-red-300' : entry.level === 'warn' ? 'text-yellow-300' : 'text-iron-text-secondary'}`}>
        {search.trim() ? <HighlightText text={entry.message} query={search} /> : entry.message}
      </span>
    </div>
  );
}

function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx === -1) return <>{text}</>;

  return (
    <>
      {text.slice(0, idx)}
      <span className="bg-iron-accent/20 text-iron-accent-light rounded px-0.5">{text.slice(idx, idx + q.length)}</span>
      {text.slice(idx + q.length)}
    </>
  );
}
