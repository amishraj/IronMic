import { useState, useEffect, useMemo } from 'react';
import {
  Mic, Sparkles, Volume2, Brain, Download, ChevronRight, CheckCircle,
  AlertTriangle, HardDrive, Shield, Search, ArrowRight, StickyNote,
  MessageSquare, ChevronLeft,
} from 'lucide-react';
import { Card } from './ui';
import { useEntryStore } from '../stores/useEntryStore';
import { useAiChatStore } from '../stores/useAiChatStore';
import { useNotesStore } from '../stores/useNotesStore';
import micIdleImg from '../assets/mic-idle.png';

interface ModelInfo {
  downloaded: boolean;
  sizeLabel: string;
  name: string;
  purpose: string;
  required: boolean;
}

interface WelcomePageProps {
  onNavigate: (page: string) => void;
}

type ResultType = 'dictation' | 'ai-session' | 'note';

interface SearchResult {
  type: ResultType;
  id: string;
  title: string;
  preview: string;
  time: number;
  sessionId?: string;
}

export function WelcomePage({ onNavigate }: WelcomePageProps) {
  const [models, setModels] = useState<Record<string, ModelInfo>>({});
  const [loading, setLoading] = useState(true);
  const [hotkey, setHotkey] = useState('Cmd+Shift+V');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchPage, setSearchPage] = useState(0);
  const [entryCount, setEntryCount] = useState<number | null>(null);

  const entries = useEntryStore((s) => s.entries);
  const sessions = useAiChatStore((s) => s.sessions);
  const notes = useNotesStore((s) => s.notes);

  const RESULTS_PER_PAGE = 5;

  useEffect(() => {
    loadStatus();
  }, []);

  async function loadStatus() {
    try {
      const [status, hk, ttsReady, allEntries] = await Promise.all([
        window.ironmic.getModelStatus(),
        window.ironmic.getSetting('hotkey_record'),
        window.ironmic.isTtsModelReady(),
        window.ironmic.listEntries({ limit: 1, offset: 0, archived: false }),
      ]);
      if (hk) setHotkey(hk.replace('CommandOrControl', 'Cmd'));
      setEntryCount(allEntries?.length ?? 0);

      const files = status?.files || {};
      setModels({
        whisper: {
          downloaded: files.whisper?.downloaded || false,
          sizeLabel: '~1.5 GB',
          name: 'Whisper large-v3-turbo',
          purpose: 'Speech Recognition',
          required: true,
        },
        llm: {
          downloaded: files.llm?.downloaded || false,
          sizeLabel: '~4.4 GB',
          name: 'Mistral 7B Instruct',
          purpose: 'Text Cleanup',
          required: false,
        },
        tts: {
          downloaded: ttsReady,
          sizeLabel: '~170 MB',
          name: 'Kokoro 82M',
          purpose: 'Text-to-Speech',
          required: false,
        },
      });
    } catch { /* ignore */ }
    setLoading(false);
  }

  // Search logic (same as SearchPage, lightweight)
  const searchResults = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return [];
    const all: SearchResult[] = [];

    for (const entry of entries) {
      const isAi = entry.sourceApp?.startsWith('ai-chat');
      if (isAi) continue;
      const text = entry.polishedText || entry.rawTranscript;
      if (text.toLowerCase().includes(q) || entry.rawTranscript.toLowerCase().includes(q)) {
        all.push({ type: 'dictation', id: entry.id, title: 'Dictation', preview: text.slice(0, 100), time: new Date(entry.createdAt).getTime() });
      }
    }
    for (const session of sessions) {
      const allText = session.messages.map((m) => m.content).join(' ').toLowerCase();
      if (allText.includes(q) || session.title.toLowerCase().includes(q)) {
        const lastUser = [...session.messages].reverse().find((m) => m.role === 'user');
        all.push({ type: 'ai-session', id: session.id, sessionId: session.id, title: session.title, preview: lastUser?.content.slice(0, 100) || 'AI conversation', time: session.updatedAt });
      }
    }
    for (const note of notes) {
      if (note.title.toLowerCase().includes(q) || note.content.toLowerCase().includes(q) || note.tags.some((t) => t.toLowerCase().includes(q))) {
        all.push({ type: 'note', id: note.id, title: note.title || 'Untitled', preview: note.content.slice(0, 100).replace(/\n/g, ' ') || 'Empty note', time: note.updatedAt });
      }
    }
    all.sort((a, b) => b.time - a.time);
    return all;
  }, [searchQuery, entries, sessions, notes]);

  const totalPages = Math.ceil(searchResults.length / RESULTS_PER_PAGE);
  const pagedResults = searchResults.slice(searchPage * RESULTS_PER_PAGE, (searchPage + 1) * RESULTS_PER_PAGE);

  // Reset page when query changes
  useEffect(() => { setSearchPage(0); }, [searchQuery]);

  const handleResultClick = (result: SearchResult) => {
    if (result.type === 'ai-session' && result.sessionId) {
      window.dispatchEvent(new CustomEvent('ironmic:open-ai-session', { detail: result.sessionId }));
      onNavigate('ai');
    } else if (result.type === 'note') {
      useNotesStore.getState().setActiveNote(result.id);
      onNavigate('notes');
    } else {
      onNavigate('main');
    }
  };

  const allRequired = Object.values(models).filter((m) => m.required);
  const requiredReady = allRequired.every((m) => m.downloaded);
  const anyReady = Object.values(models).some((m) => m.downloaded);
  const hasContent = (entryCount ?? 0) > 0 || sessions.length > 0 || notes.length > 0;
  const isBrandNew = !anyReady && !hasContent;
  const isFirstTime = !anyReady;
  const missingWhisper = !models.whisper?.downloaded;
  const missingOptional = Object.entries(models).filter(([, m]) => !m.required && !m.downloaded);
  const hasMissingOptional = !isFirstTime && missingOptional.length > 0;

  const typeIcons: Record<ResultType, typeof Mic> = { dictation: Mic, 'ai-session': Sparkles, note: StickyNote };
  const typeColors: Record<ResultType, string> = { dictation: 'text-iron-accent-light bg-iron-accent/10', 'ai-session': 'text-purple-400 bg-purple-500/10', note: 'text-emerald-400 bg-emerald-500/10' };
  const typeLabels: Record<ResultType, string> = { dictation: 'Dictation', 'ai-session': 'AI Chat', note: 'Note' };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-10 pb-20">
        {/* Hero */}
        <div className="text-center mb-10">
          <img src={micIdleImg} alt="IronMic" className="w-32 h-32 mx-auto mb-5 object-contain" />
          <h1 className="text-2xl font-bold text-iron-text">
            {isBrandNew ? 'Welcome to IronMic' : 'IronMic'}
          </h1>
          <p className="text-sm text-iron-text-muted mt-2 max-w-md mx-auto leading-relaxed">
            {isBrandNew
              ? 'Speak freely. Transcribe locally. Everything runs on your machine — no cloud, no accounts, no data ever leaves your device.'
              : isFirstTime
              ? 'Local voice transcription and text-to-speech, built for privacy. Let\u2019s get you set up.'
              : 'Local transcription and text-to-speech — private, fast, and enterprise-ready.'}
          </p>
        </div>

        {/* Brand new: Getting Started steps */}
        {isBrandNew && (
          <div className="mb-10">
            <h2 className="text-base font-semibold text-iron-text mb-4">Getting Started</h2>
            <div className="space-y-3">
              <StepCard
                step={1}
                title="Download the speech recognition model"
                description="This is the only model you need to start dictating. It converts your voice to text using Whisper, running entirely on your machine."
                action={missingWhisper ? { label: 'Go to Settings', onClick: () => onNavigate('settings') } : undefined}
                done={!missingWhisper}
                highlight={missingWhisper}
              />
              <StepCard
                step={2}
                title="Try your first dictation"
                description={`Press ${hotkey} from anywhere on your computer, speak, then press it again. Your speech is transcribed and copied to your clipboard — ready to paste.`}
                action={!missingWhisper ? { label: 'Open Dictate', onClick: () => onNavigate('dictate') } : undefined}
                done={hasContent}
                disabled={missingWhisper}
              />
              <StepCard
                step={3}
                title="Explore optional features"
                description="Text cleanup polishes your raw transcriptions. Text-to-speech reads text back to you. Both are optional downloads in Settings."
                action={{ label: 'View in Settings', onClick: () => onNavigate('settings') }}
              />
            </div>
          </div>
        )}

        {/* First-time but not brand new (models missing, but has some content somehow) */}
        {isFirstTime && !isBrandNew && (
          <div className="mb-10">
            <Card variant="highlighted" padding="md">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-iron-warning/10 flex items-center justify-center flex-shrink-0">
                  <AlertTriangle className="w-4.5 h-4.5 text-iron-warning" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-iron-text">Models needed</p>
                  <p className="text-xs text-iron-text-muted mt-1 leading-relaxed">
                    IronMic needs the speech recognition model to transcribe your voice.
                    Download it in Settings to start dictating.
                  </p>
                  <button
                    onClick={() => onNavigate('settings')}
                    className="mt-3 flex items-center gap-1.5 text-xs font-medium text-iron-accent-light hover:underline"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Go to Settings
                  </button>
                </div>
              </div>
            </Card>
          </div>
        )}

        {/* Returning user: missing Whisper warning */}
        {!isFirstTime && missingWhisper && (
          <div className="mb-6">
            <Card variant="highlighted" padding="md">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-iron-warning/10 flex items-center justify-center flex-shrink-0">
                  <AlertTriangle className="w-4.5 h-4.5 text-iron-warning" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-iron-text">Speech recognition model missing</p>
                  <p className="text-xs text-iron-text-muted mt-0.5">
                    Dictation won't work without the Whisper model. Download it in Settings to get started.
                  </p>
                  <button
                    onClick={() => onNavigate('settings')}
                    className="mt-2 flex items-center gap-1.5 text-xs font-medium text-iron-accent-light hover:underline"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download now
                  </button>
                </div>
              </div>
            </Card>
          </div>
        )}

        {/* Quick search (only show when there's content to search) */}
        {hasContent && (
          <div className="mb-8">
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-iron-text-muted" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search dictations, chats, notes..."
                className="w-full text-sm bg-iron-surface border border-iron-border rounded-xl pl-11 pr-4 py-3 text-iron-text placeholder:text-iron-text-muted focus:outline-none focus:border-iron-accent/50 focus:shadow-glow transition-all"
              />
            </div>

            {/* Results */}
            {searchQuery.trim() && (
              <div className="mt-2 space-y-1.5">
                {pagedResults.length === 0 && (
                  <p className="text-xs text-iron-text-muted text-center py-4">No results for &ldquo;{searchQuery}&rdquo;</p>
                )}
                {pagedResults.map((r) => {
                  const Icon = typeIcons[r.type];
                  return (
                    <button
                      key={`${r.type}-${r.id}`}
                      onClick={() => handleResultClick(r)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left hover:bg-iron-surface-hover transition-colors group"
                    >
                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${typeColors[r.type]}`}>
                        <Icon className="w-3.5 h-3.5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-iron-text-muted">{typeLabels[r.type]}</span>
                          <span className="text-[10px] text-iron-text-muted">
                            {new Date(r.time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                          </span>
                        </div>
                        <p className="text-xs text-iron-text truncate">{r.title === 'Dictation' ? r.preview : r.title}</p>
                      </div>
                      <ArrowRight className="w-3.5 h-3.5 text-iron-text-muted/0 group-hover:text-iron-text-muted transition-colors flex-shrink-0" />
                    </button>
                  );
                })}

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-center gap-2 pt-2">
                    <button
                      onClick={() => setSearchPage((p) => Math.max(0, p - 1))}
                      disabled={searchPage === 0}
                      className="p-1 rounded text-iron-text-muted hover:text-iron-text-secondary disabled:opacity-30"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                    </button>
                    <span className="text-[10px] text-iron-text-muted">
                      {searchPage + 1} / {totalPages} ({searchResults.length} results)
                    </span>
                    <button
                      onClick={() => setSearchPage((p) => Math.min(totalPages - 1, p + 1))}
                      disabled={searchPage >= totalPages - 1}
                      className="p-1 rounded text-iron-text-muted hover:text-iron-text-secondary disabled:opacity-30"
                    >
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                {/* Link to full search */}
                {searchResults.length > 0 && (
                  <button
                    onClick={() => onNavigate('search')}
                    className="w-full text-center text-[11px] text-iron-accent-light hover:underline py-1"
                  >
                    Open full search
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Quick actions */}
        {!isBrandNew && (
          <div className="mb-8">
            <h2 className="text-base font-semibold text-iron-text mb-4">
              {isFirstTime ? 'Features' : 'Quick Start'}
            </h2>
            <div className="grid grid-cols-2 gap-3">
              <QuickAction icon={Mic} title="Dictate" description={`Press ${hotkey} anywhere to record`} onClick={() => onNavigate('dictate')} color="accent" disabled={!requiredReady} />
              <QuickAction icon={Sparkles} title="AI Assistant" description="Chat with a local AI" onClick={() => onNavigate('ai')} color="purple" />
              <QuickAction icon={Volume2} title="Listen" description="Hear text read aloud" onClick={() => onNavigate('listen')} color="emerald" disabled={!models.tts?.downloaded} />
              <QuickAction icon={Brain} title="Notes" description="Organize thoughts in notebooks" onClick={() => onNavigate('notes')} color="amber" />
            </div>
          </div>
        )}

        {/* Brand new: Model details */}
        {isBrandNew && (
          <div className="mb-8">
            <h2 className="text-base font-semibold text-iron-text mb-3">About the Models</h2>
            <p className="text-xs text-iron-text-muted mb-4 leading-relaxed">
              IronMic uses open-source models that run entirely on your hardware. Nothing is sent externally.
            </p>
            <div className="space-y-3">
              <ModelCard
                name="Whisper large-v3-turbo"
                purpose="Speech Recognition — converts your voice to text"
                size="~1.5 GB"
                downloaded={models.whisper?.downloaded || false}
                detail="This is the core engine. Without it, dictation won't work. It's OpenAI's most accurate speech recognition model, running locally via whisper.cpp."
                required
              />
              <ModelCard
                name="Mistral 7B Instruct (Q4)"
                purpose="Text Cleanup — polishes raw transcriptions"
                size="~4.4 GB"
                downloaded={models.llm?.downloaded || false}
                detail="Removes filler words (um, uh, like), fixes grammar, and cleans up your speech into polished text. Recommended if you have 16+ GB RAM."
              />
              <ModelCard
                name="Kokoro 82M (TTS)"
                purpose="Text-to-Speech — reads text back to you"
                size="~170 MB"
                downloaded={models.tts?.downloaded || false}
                detail="A small, fast neural voice engine with 15 English voices. Enables the listen feature and read-back. Lightweight — runs on any hardware."
              />
            </div>
          </div>
        )}

        {/* Returning user: model status */}
        {!isFirstTime && !isBrandNew && (
          <div className="mb-8">
            <h2 className="text-base font-semibold text-iron-text mb-3">Model Status</h2>
            <Card variant="default" padding="md">
              <div className="space-y-2">
                {Object.entries(models).map(([key, m]) => (
                  <div key={key} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {m.downloaded ? <CheckCircle className="w-4 h-4 text-iron-success" /> : <Download className="w-4 h-4 text-iron-text-muted" />}
                      <div>
                        <p className="text-xs font-medium text-iron-text">{m.name}</p>
                        <p className="text-[10px] text-iron-text-muted">{m.purpose} · {m.sizeLabel}</p>
                      </div>
                    </div>
                    {!m.downloaded && (
                      <button onClick={() => onNavigate('settings')} className="text-[10px] text-iron-accent-light hover:underline">Download</button>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}

        {/* Returning user: gentle nudge for optional models */}
        {hasMissingOptional && !missingWhisper && (
          <div className="mb-8">
            <Card variant="default" padding="md">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-iron-accent/10 flex items-center justify-center flex-shrink-0">
                  <Download className="w-4.5 h-4.5 text-iron-accent-light" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-iron-text">Enhance your experience</p>
                  <p className="text-xs text-iron-text-muted mt-0.5 leading-relaxed">
                    {missingOptional.map(([, m]) => m.name).join(' and ')} {missingOptional.length === 1 ? 'is' : 'are'} available to download.
                    {' '}{missingOptional.some(([k]) => k === 'llm') && 'Text cleanup polishes your raw transcriptions. '}
                    {missingOptional.some(([k]) => k === 'tts') && 'Text-to-speech lets you listen to any text read aloud.'}
                  </p>
                  <button
                    onClick={() => onNavigate('settings')}
                    className="mt-2 flex items-center gap-1.5 text-xs font-medium text-iron-accent-light hover:underline"
                  >
                    View in Settings <ChevronRight className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </Card>
          </div>
        )}

        {/* Security badge */}
        <Card variant="default" padding="md">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-iron-success/10 flex items-center justify-center flex-shrink-0">
              <Shield className="w-5 h-5 text-iron-success" />
            </div>
            <div>
              <p className="text-sm font-medium text-iron-text">100% Local & Private</p>
              <p className="text-xs text-iron-text-muted mt-0.5">
                All processing happens on your machine. No network calls, no telemetry, no accounts. Audio is processed in memory and never saved to disk.
              </p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function ModelCard({ name, purpose, size, downloaded, detail, required }: {
  name: string; purpose: string; size: string; downloaded: boolean; detail: string; required?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Card variant={required && !downloaded ? 'highlighted' : 'default'} padding="md">
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${downloaded ? 'bg-iron-success/10' : required ? 'bg-iron-warning/10' : 'bg-iron-surface-active'}`}>
            {downloaded ? <CheckCircle className="w-4 h-4 text-iron-success" /> : <HardDrive className="w-4 h-4 text-iron-text-muted" />}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-iron-text">{name}</p>
              {required && !downloaded && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-iron-warning/15 text-iron-warning border border-iron-warning/20">Required</span>}
            </div>
            <p className="text-xs text-iron-text-muted mt-0.5">{purpose} · {size}</p>
          </div>
        </div>
        {downloaded && <span className="text-[10px] font-medium text-iron-success flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-iron-success" />Ready</span>}
      </div>
      <button onClick={() => setExpanded(!expanded)} className="text-[11px] text-iron-accent-light mt-2 hover:underline flex items-center gap-1">
        <ChevronRight className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        {expanded ? 'Less info' : 'Learn more'}
      </button>
      {expanded && <p className="text-xs text-iron-text-muted mt-2 leading-relaxed pl-4 border-l-2 border-iron-border">{detail}</p>}
    </Card>
  );
}

function StepCard({ step, title, description, action, done, highlight, disabled }: {
  step: number; title: string; description: string;
  action?: { label: string; onClick: () => void };
  done?: boolean; highlight?: boolean; disabled?: boolean;
}) {
  return (
    <Card variant={highlight ? 'highlighted' : 'default'} padding="md">
      <div className={`flex items-start gap-3 ${disabled ? 'opacity-40' : ''}`}>
        <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold ${
          done ? 'bg-iron-success/10 text-iron-success' : 'bg-iron-accent/10 text-iron-accent-light'
        }`}>
          {done ? <CheckCircle className="w-4 h-4" /> : step}
        </div>
        <div className="flex-1">
          <p className={`text-sm font-medium ${done ? 'text-iron-text-muted line-through' : 'text-iron-text'}`}>{title}</p>
          <p className="text-xs text-iron-text-muted mt-0.5 leading-relaxed">{description}</p>
          {action && !done && !disabled && (
            <button
              onClick={action.onClick}
              className="mt-2 flex items-center gap-1.5 text-xs font-medium text-iron-accent-light hover:underline"
            >
              {action.label} <ChevronRight className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}

function QuickAction({ icon: Icon, title, description, onClick, color, disabled }: {
  icon: typeof Mic; title: string; description: string; onClick: () => void; color: string; disabled?: boolean;
}) {
  const colorMap: Record<string, string> = {
    accent: 'bg-iron-accent/10 text-iron-accent-light',
    purple: 'bg-purple-500/10 text-purple-400',
    emerald: 'bg-emerald-500/10 text-emerald-400',
    amber: 'bg-amber-500/10 text-amber-400',
  };
  return (
    <button onClick={onClick} disabled={disabled} className={`text-left p-4 rounded-xl border border-iron-border transition-all ${disabled ? 'opacity-40 cursor-not-allowed' : 'hover:border-iron-border-hover hover:bg-iron-surface-hover'}`}>
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center mb-2.5 ${colorMap[color]}`}><Icon className="w-4.5 h-4.5" /></div>
      <p className="text-sm font-medium text-iron-text">{title}</p>
      <p className="text-[11px] text-iron-text-muted mt-0.5">{description}</p>
    </button>
  );
}
