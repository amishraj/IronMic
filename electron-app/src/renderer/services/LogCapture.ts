/**
 * LogCapture — intercepts console.log/warn/error and stores entries in a circular buffer.
 * Also captures unhandled errors and promise rejections.
 * Singleton: import { logCapture } from './LogCapture' anywhere to access the log store.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  timestamp: number;
  level: LogLevel;
  message: string;
  source?: string; // extracted from [tag] prefix if present
}

type LogListener = () => void;

const MAX_ENTRIES = 1000;

class LogCaptureService {
  private entries: LogEntry[] = [];
  private nextId = 1;
  private listeners: Set<LogListener> = new Set();
  private installed = false;

  /** Install console interceptors. Call once at app startup. */
  install() {
    if (this.installed) return;
    this.installed = true;

    const origLog = console.log.bind(console);
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);
    const origDebug = console.debug.bind(console);

    console.log = (...args: any[]) => {
      origLog(...args);
      this.capture('info', args);
    };

    console.warn = (...args: any[]) => {
      origWarn(...args);
      this.capture('warn', args);
    };

    console.error = (...args: any[]) => {
      origError(...args);
      this.capture('error', args);
    };

    console.debug = (...args: any[]) => {
      origDebug(...args);
      this.capture('debug', args);
    };

    // Capture unhandled errors
    window.addEventListener('error', (event) => {
      this.add('error', `Unhandled: ${event.message}`, 'window.onerror');
    });

    // Capture unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason instanceof Error
        ? `${event.reason.message}\n${event.reason.stack?.split('\n').slice(0, 3).join('\n')}`
        : String(event.reason);
      this.add('error', `Unhandled rejection: ${reason}`, 'promise');
    });

    // Periodically fetch main process errors (they can't push to renderer easily)
    this.pollMainProcessErrors();
    setInterval(() => this.pollMainProcessErrors(), 5000);
  }

  private mainErrorsSeen = 0;

  private async pollMainProcessErrors() {
    try {
      const ironmic = (window as any).ironmic;
      if (!ironmic?.getMainErrors) return;
      const errors: Array<{ time: string; message: string }> = await ironmic.getMainErrors();
      // Only add new ones
      for (let i = this.mainErrorsSeen; i < errors.length; i++) {
        this.add('error', errors[i].message, 'main-process');
      }
      this.mainErrorsSeen = errors.length;
    } catch { /* ignore — preload may not have this method yet */ }
  }

  private capture(level: LogLevel, args: any[]) {
    const message = args.map((a) => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a, null, 0); }
      catch { return String(a); }
    }).join(' ');

    // Extract source from [tag] prefix pattern, e.g. "[recording] ..."
    let source: string | undefined;
    const tagMatch = message.match(/^\[([^\]]+)\]\s*/);
    if (tagMatch) {
      source = tagMatch[1];
    }

    this.add(level, message, source);
  }

  private add(level: LogLevel, message: string, source?: string) {
    const entry: LogEntry = {
      id: this.nextId++,
      timestamp: Date.now(),
      level,
      message,
      source,
    };

    this.entries.push(entry);

    // Circular buffer — trim when over limit
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }

    // Notify listeners
    for (const listener of this.listeners) {
      try { listener(); } catch { /* don't let listener errors break logging */ }
    }
  }

  /** Get all captured log entries. */
  getEntries(): LogEntry[] {
    return this.entries;
  }

  /** Get entries filtered by level. */
  getFiltered(levels: Set<LogLevel>): LogEntry[] {
    return this.entries.filter((e) => levels.has(e.level));
  }

  /** Clear all entries. */
  clear() {
    this.entries = [];
    this.nextId = 1;
    this.notify();
  }

  /** Subscribe to log updates. Returns unsubscribe function. */
  subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Get entry count by level. */
  getCounts(): Record<LogLevel, number> {
    const counts: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const entry of this.entries) {
      counts[entry.level]++;
    }
    return counts;
  }

  /** Export all logs as a downloadable text blob. */
  exportAsText(): string {
    return this.entries.map((e) => {
      const time = new Date(e.timestamp).toISOString();
      const src = e.source ? ` [${e.source}]` : '';
      return `${time} ${e.level.toUpperCase().padEnd(5)}${src} ${e.message}`;
    }).join('\n');
  }

  private notify() {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* ignore */ }
    }
  }
}

export const logCapture = new LogCaptureService();
