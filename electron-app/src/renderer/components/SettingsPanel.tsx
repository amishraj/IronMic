import { useState, useEffect, useCallback, useRef } from 'react';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useSettingsIntentStore } from '../stores/useSettingsIntentStore';
import { DictionaryManager } from './DictionaryManager';
import { ModelManager } from './ModelManager';
import { ModelImportSection, ModelImportBanner } from './ModelImportBanner';
import { InputSettings } from './InputSettings';
import { DataManager } from './DataManager';
// HotkeyRecorder is no longer used — dictation gesture is hardcoded in
// main/keyboard-listener.ts. We render `DictationGestureDisplay` (defined
// below) as a read-only replacement.
import { getDictationGesture } from '../../shared/dictation-gesture';
import { prettifyModelId } from '../utils/prettify-model-id';
import { Toggle, Card } from './ui';
import {
  Settings, Bot, Volume2, Monitor, Sun, Moon, Shield, Keyboard,
  Cpu, Database, BookOpen, Lock, ClipboardCheck, Eye, EyeOff,
  Clock, AlertTriangle, CheckCircle, Info, Wifi, WifiOff, FileWarning,
  Trash2, HardDrive, Sparkles, RefreshCw, Download, Brain,
  Mic, Route, Users, Search, Bell, Workflow, Sliders, FlaskConical,
} from 'lucide-react';

type SettingsTab = 'general' | 'audio' | 'speech' | 'ai' | 'models' | 'data' | 'security' | 'voice-ai';

const TABS: { id: SettingsTab; label: string; icon: typeof Settings }[] = [
  { id: 'general', label: 'General', icon: Settings },
  { id: 'audio', label: 'Audio', icon: Mic },
  { id: 'speech', label: 'Speech', icon: Volume2 },
  { id: 'ai', label: 'AI Assist', icon: Sparkles },
  { id: 'voice-ai', label: 'Voice AI', icon: Brain },
  { id: 'models', label: 'Models', icon: Cpu },
  { id: 'data', label: 'Data', icon: Database },
  { id: 'security', label: 'Security', icon: Shield },
];

export function SettingsPanel() {
  const [tab, setTab] = useState<SettingsTab>('general');

  // Honor a cross-page intent (e.g. AIChat → "Enable cloud Voice Chat" deep-link).
  // Read once on mount and consume — focusKey is forwarded to the inner section
  // through the intent store, which keeps the value alive until the row scrolls
  // into view (handled inside AIAssistSettings).
  useEffect(() => {
    const intent = useSettingsIntentStore.getState();
    if (intent.pendingTab) {
      setTab(intent.pendingTab);
      // Don't consume focusKey here — the section consumes after scrolling.
      useSettingsIntentStore.setState({ pendingTab: null });
    }
  }, []);

  return (
    <div className="flex h-full">
      {/* Tab sidebar */}
      <div className="w-48 flex-shrink-0 border-r border-iron-border bg-iron-surface py-4">
        <div className="px-4 mb-4">
          <h2 className="text-sm font-semibold text-iron-text">Settings</h2>
        </div>
        <nav className="space-y-0.5 px-2">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                tab === id
                  ? 'bg-iron-accent/10 text-iron-accent-light'
                  : 'text-iron-text-secondary hover:bg-iron-surface-hover hover:text-iron-text'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </nav>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-lg mx-auto space-y-6 pb-16">
          {tab === 'general' && <GeneralSettings />}
          {tab === 'audio' && <InputSettings />}
          {tab === 'speech' && <SpeechSettings />}
          {tab === 'ai' && <AIAssistSettings />}
          {tab === 'models' && <ModelManager />}
          {tab === 'voice-ai' && <VoiceAISettings />}
          {tab === 'data' && <DataSettings />}
          {tab === 'security' && <SecuritySettings />}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// General
// ═══════════════════════════════════════════

function GeneralSettings() {
  const { hotkey, llmCleanupEnabled, polishFormatMode, theme, setHotkey, setLlmCleanup, setPolishFormatMode, setTheme } =
    useSettingsStore();
  // `hotkey` / `setHotkey` retained for backward compat with older settings
  // payloads; the dictation gesture itself is now hardcoded in
  // main/keyboard-listener.ts. Keep these in scope so changing the hotkey
  // recorder (if a user has the old setting screen up via cache) still
  // round-trips harmlessly.
  void hotkey;
  void setHotkey;

  return (
    <>
      <SectionHeader icon={Settings} title="General" description="Core preferences and behavior" />

      <DictationGestureDisplay />

      <SettingRow
        title="LLM Text Cleanup"
        description="Polish transcriptions with a local LLM"
        control={<Toggle checked={llmCleanupEnabled} onChange={setLlmCleanup} />}
      />

      <SettingRow
        title="Smart formatting"
        description="Polished notes and meeting summaries are formatted with headings, lists, and bold. Turn off for flat-text output."
        control={
          <Toggle
            checked={polishFormatMode === 'rich'}
            onChange={(checked) => setPolishFormatMode(checked ? 'rich' : 'plain')}
          />
        }
      />

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-iron-text">Theme</label>
        <div className="flex gap-1.5">
          {([
            { value: 'system', label: 'Auto', icon: Monitor },
            { value: 'light', label: 'Light', icon: Sun },
            { value: 'dark', label: 'Dark', icon: Moon },
          ] as const).map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              onClick={() => setTheme(value)}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                theme === value
                  ? 'bg-iron-accent/15 text-iron-accent-light border border-iron-accent/20'
                  : 'bg-iron-surface text-iron-text-muted border border-iron-border hover:border-iron-border-hover'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      <DictionaryManager />
    </>
  );
}

// ═══════════════════════════════════════════
// AI Assist
// ═══════════════════════════════════════════

interface AIModelOption {
  id: string;
  label: string;
  provider: string;
  source?: 'cli' | 'fallback' | 'static' | 'local' | 'curated';
  billing?: 'free' | 'paid' | 'unknown';
  description?: string;
  runIds?: { copilotCli?: string; ghModels?: string };
}

function AIAssistSettings() {
  const { aiEnabled, setAiEnabled } = useSettingsStore();
  const [provider, setProvider] = useState<string>('copilot');
  const [model, setModel] = useState<string>('');
  const [models, setModels] = useState<AIModelOption[]>([]);
  const [authState, setAuthState] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [localModels, setLocalModels] = useState<any[]>([]);
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);

  // Cloud opt-ins (relocated from Security & Privacy in v1.8.x). Kept in this
  // panel so all "what does AI Assist talk to?" controls live together.
  const [allowCloudPolish, setAllowCloudPolish] = useState(false);
  const [allowCloudVoiceChat, setAllowCloudVoiceChat] = useState(false);
  // Knowledge Q&A — Ask page settings. The cloud toggle is forward-looking:
  // manual-attach in AIChat is governed by the user's explicit provider
  // pick, but the future automatic-retrieval path (RAG retrieves chunks the
  // user didn't hand-pick) needs an explicit opt-in. Surfacing it now so the
  // posture is consistent with polish_allow_cloud / voice_chat_allow_cloud.
  const [knowledgeQaEnabled, setKnowledgeQaEnabled] = useState(true);
  const [knowledgeQaAllowCloud, setKnowledgeQaAllowCloud] = useState(false);
  const [indexStats, setIndexStats] = useState<{ total: number; indexed: number; byType: Record<string, number> } | null>(null);
  const [pendingFocusKey, setPendingFocusKey] = useState<string | null>(null);
  const polishToggleRef = useRef<HTMLDivElement | null>(null);
  const voiceChatToggleRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Inherit any focusKey set by the deep-link intent, then clear it from
    // the global store. Local state survives long enough for the scroll
    // effect below to fire after the row's ref attaches.
    const intent = useSettingsIntentStore.getState();
    if (intent.focusKey) {
      setPendingFocusKey(intent.focusKey);
      useSettingsIntentStore.getState().consume();
    }
  }, []);

  useEffect(() => {
    if (!pendingFocusKey || !aiEnabled) return;
    const target =
      pendingFocusKey === 'voice_chat_allow_cloud' ? voiceChatToggleRef.current :
      pendingFocusKey === 'polish_allow_cloud' ? polishToggleRef.current :
      null;
    if (target) {
      // Wait one frame for layout to settle, then scroll + flash the border.
      requestAnimationFrame(() => {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('ring-2', 'ring-iron-accent', 'rounded-lg');
        setTimeout(() => {
          target.classList.remove('ring-2', 'ring-iron-accent', 'rounded-lg');
          setPendingFocusKey(null);
        }, 1800);
      });
    }
  }, [pendingFocusKey, aiEnabled]);

  useEffect(() => {
    loadAiSettings();
    const cleanup = window.ironmic.onModelDownloadProgress((prog: any) => {
      if (prog.model?.startsWith('llm')) {
        setDownloadProgress(prog.percent || 0);
        if (prog.status === 'complete') {
          setDownloadingModel(null);
          setDownloadError(null);
          // Refresh local model status
          window.ironmic.aiGetLocalModelStatus?.().then((statuses: any[]) => {
            if (statuses) setLocalModels(statuses);
          }).catch(() => {});
        }
        if (prog.status === 'error') {
          setDownloadingModel(null);
          setDownloadError(prog.errorDetail || `Download failed for ${prog.model}`);
          setShowImport(true);
        }
      }
    });
    return cleanup;
  }, []);

  async function loadAiSettings() {
    const api = window.ironmic;
    const [prov, mod, auth, allModels, localModelStatus, polishCloud, voiceChatCloud] = await Promise.all([
      api.getSetting('ai_provider'),
      api.getSetting('ai_model'),
      api.aiGetAuthState(),
      api.aiGetModels(),
      api.aiGetLocalModelStatus?.() || Promise.resolve([]),
      api.getSetting('polish_allow_cloud'),
      api.getSetting('voice_chat_allow_cloud'),
    ]);
    if (prov) setProvider(prov);
    if (mod) setModel(mod);
    setAuthState(auth);
    setModels(allModels || []);
    if (localModelStatus) setLocalModels(localModelStatus);
    setAllowCloudPolish(polishCloud === 'true');
    setAllowCloudVoiceChat(voiceChatCloud === 'true');

    // Knowledge Q&A settings + index stats. Failures are silent — these
    // settings have safe defaults and the stats card just won't render.
    try {
      const [kqEnabled, kqCloud] = await Promise.all([
        api.getSetting('knowledge_qa_enabled'),
        api.getSetting('knowledge_qa_allow_cloud'),
      ]);
      setKnowledgeQaEnabled(kqEnabled !== 'false'); // default ON
      setKnowledgeQaAllowCloud(kqCloud === 'true'); // default OFF
    } catch { /* keep defaults */ }
    try {
      const statsJson = await api.ragGetIndexStats?.();
      if (statsJson) {
        const parsed = JSON.parse(statsJson);
        setIndexStats({
          total: parsed.total_chunks ?? 0,
          indexed: parsed.indexed_chunks ?? 0,
          byType: parsed.by_source_type ?? {},
        });
      }
    } catch { /* index card hidden when stats unavailable */ }
  }

  async function handleKnowledgeQaEnabledToggle(next: boolean) {
    setKnowledgeQaEnabled(next);
    await window.ironmic.setSetting('knowledge_qa_enabled', String(next));
  }

  async function handleKnowledgeQaCloudToggle(next: boolean) {
    if (next) {
      const ok = window.confirm(
        'Allow cloud Knowledge Q&A?\n\n' +
        'When enabled, the Ask page can send retrieved excerpts of your notes, ' +
        'dictations, and meetings to the authenticated Claude or Copilot CLI for ' +
        'higher-quality answers.\n\n' +
        'This is for the automatic-retrieval Q&A path. Manually attaching content ' +
        'in AI Chat already goes to whatever provider you have selected — that path ' +
        'is consent-by-action and is not gated by this toggle.\n\n' +
        'You can turn this off again at any time.',
      );
      if (!ok) return;
    }
    setKnowledgeQaAllowCloud(next);
    await window.ironmic.setSetting('knowledge_qa_allow_cloud', String(next));
  }

  async function handleRebuildIndex() {
    const ok = window.confirm(
      'Rebuild the Knowledge Q&A index?\n\n' +
      'This deletes every chunk and embedding, then immediately re-chunks ' +
      'every entry, meeting, and note in the background. Your underlying ' +
      'content is untouched. Useful if retrieval feels stale or you upgraded ' +
      'the embedding model.',
    );
    if (!ok) return;
    try {
      // Wipe the existing chunks/embeddings table first.
      await window.ironmic.ragRebuildIndex?.();
      setIndexStats({ total: 0, indexed: 0, byType: {} });
      // Then immediately kick the renderer-side indexer with `force` so the
      // user doesn't have to navigate to any page for the rebuild to start.
      // Indexer batches yield to retrieval queries, so this is safe to fire
      // and let run in the background.
      try {
        const { indexerService } = await import('../services/rag/IndexerService');
        void indexerService.kickOnce({ force: true });
      } catch (err) {
        console.warn('[settings] indexer kick after rebuild failed (non-fatal):', err);
      }
    } catch (err) {
      console.error('[settings] rebuild index failed:', err);
    }
  }

  /** Confirm before turning ON either cloud opt-in — they route user content
   *  off-device. Turning OFF is unconditional. Mirrors the prior pattern from
   *  the Security panel. */
  async function handleCloudPolishToggle(next: boolean) {
    if (next) {
      const ok = window.confirm(
        'Allow cloud polishing?\n\n' +
        'When enabled, IronMic will send your transcript text to the authenticated ' +
        'Claude or Copilot CLI for higher-quality cleanups. This is the only feature ' +
        'that sends transcript content off your device.\n\n' +
        'You can turn this off again at any time.',
      );
      if (!ok) return;
    }
    setAllowCloudPolish(next);
    await window.ironmic.setSetting('polish_allow_cloud', String(next));
  }

  async function handleCloudVoiceChatToggle(next: boolean) {
    if (next) {
      const ok = window.confirm(
        'Allow cloud Voice Chat?\n\n' +
        'When enabled, the conversational Voice Chat loop may send your raw spoken ' +
        'transcripts to the authenticated Claude or Copilot CLI. Useful for faster, ' +
        'higher-quality replies — but each turn auto-sends what you said.\n\n' +
        'Local Voice Chat (with the on-device LLM) stays available regardless.',
      );
      if (!ok) return;
    }
    setAllowCloudVoiceChat(next);
    await window.ironmic.setSetting('voice_chat_allow_cloud', String(next));
  }

  async function handleProviderChange(p: string) {
    setProvider(p);
    await window.ironmic.setSetting('ai_provider', p);
    // Set default model for new provider
    if (p === 'local') {
      // Pick first downloaded local model, or first available
      const downloaded = localModels.find((m: any) => m.downloaded);
      const defaultLocal = downloaded || localModels[0];
      if (defaultLocal) {
        setModel(defaultLocal.id);
        await window.ironmic.setSetting('ai_model', defaultLocal.id);
      }
    } else {
      const providerModels = models.filter((m) => m.provider === p);
      const defaultModel =
        providerModels.find((m) => m.billing === 'free') || providerModels[0];
      if (defaultModel) {
        setModel(defaultModel.id);
        await window.ironmic.setSetting('ai_model', defaultModel.id);
      }
    }
  }

  async function handleRefreshModels() {
    setRefreshingModels(true);
    try {
      const fresh = await window.ironmic.aiRefreshModels('copilot');
      if (Array.isArray(fresh)) {
        // Replace just the copilot entries; keep claude + local from the
        // existing aggregated `models` so the dropdown for those providers
        // doesn't disappear if the user is mid-switch.
        setModels((prev) => [
          ...prev.filter((m) => m.provider !== 'copilot'),
          ...fresh,
        ]);
      }
    } catch { /* ignore — UI shows fallback */ }
    setRefreshingModels(false);
  }

  async function handleModelChange(m: string) {
    setModel(m);
    await window.ironmic.setSetting('ai_model', m);
    if (provider === 'local') {
      await window.ironmic.setSetting('ai_local_model', m);
    }
  }

  async function handleRefreshAuth() {
    setRefreshing(true);
    try {
      const [auth, localModelStatus] = await Promise.all([
        window.ironmic.aiRefreshAuth(),
        window.ironmic.aiGetLocalModelStatus?.() || Promise.resolve([]),
      ]);
      setAuthState(auth);
      if (localModelStatus) setLocalModels(localModelStatus);
    } catch { /* ignore */ }
    setRefreshing(false);
  }

  async function handleDownloadLocalModel(modelId: string) {
    setDownloadingModel(modelId);
    setDownloadProgress(0);
    setDownloadError(null);
    try {
      await window.ironmic.downloadModel(modelId);
    } catch (err: any) {
      setDownloadingModel(null);
      setDownloadError(err.message || `Download failed for ${modelId}`);
      setShowImport(true);
    }
  }

  const providerModels = models.filter((m) => m.provider === provider);
  const claudeAuth = authState?.claude;
  const copilotAuth = authState?.copilot;
  const localAuth = authState?.local;

  return (
    <>
      <SectionHeader icon={Sparkles} title="AI Assist" description="Configure the AI assistant and model selection">
        {aiEnabled && provider && (
          <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/20">
            {provider === 'local' ? 'Local LLM' : provider === 'copilot' ? 'GitHub Copilot' : 'Claude'} — {model || 'default'}
          </span>
        )}
      </SectionHeader>

      <SettingRow
        icon={Bot}
        title="Enable AI Assistant"
        description="Chat with AI using CLI tools, API keys, or a local LLM"
        control={<Toggle checked={aiEnabled} onChange={setAiEnabled} />}
      />

      {aiEnabled && (
        <>
          {/* Provider selection */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-iron-text">Provider</label>
            <p className="text-xs text-iron-text-muted">Choose how AI Assist runs</p>
            <div className="grid grid-cols-3 gap-1.5 mt-2">
              {[
                { value: 'copilot', label: 'GitHub Copilot', sub: 'Free tier available' },
                { value: 'claude', label: 'Claude Code', sub: 'Anthropic API key' },
                { value: 'local', label: 'Local LLM', sub: 'Free — on device' },
              ].map(({ value, label, sub }) => {
                const auth = value === 'copilot' ? copilotAuth : value === 'claude' ? claudeAuth : localAuth;
                const isActive = provider === value;
                return (
                  <button
                    key={value}
                    onClick={() => handleProviderChange(value)}
                    className={`text-left px-3 py-2.5 rounded-lg text-xs transition-all ${
                      isActive
                        ? 'bg-iron-accent/15 text-iron-accent-light border border-iron-accent/20'
                        : 'bg-iron-surface text-iron-text-muted border border-iron-border hover:border-iron-border-hover'
                    }`}
                  >
                    <span className="font-medium">{label}</span>
                    <span className="block text-[10px] mt-0.5 opacity-70">{sub}</span>
                    {auth && (
                      <>
                        <span className={`block text-[10px] mt-1 ${auth.authenticated ? 'text-iron-success' : 'text-iron-warning'}`}>
                          {value === 'local'
                            ? (auth.authenticated ? '● Model ready' : '○ Download a model')
                            : (auth.authenticated ? '● Connected' : auth.installed ? '○ Not logged in' : '○ Not installed')}
                        </span>
                        {value !== 'local' && auth.binaryPath && (
                          <span className="block text-[9px] mt-0.5 text-iron-text-muted truncate" title={auth.binaryPath}>
                            {auth.binaryPath}
                          </span>
                        )}
                      </>
                    )}
                  </button>
                );
              })}
            </div>
            <button
              onClick={handleRefreshAuth}
              disabled={refreshing}
              className="flex items-center gap-1.5 text-[11px] text-iron-accent-light hover:underline mt-1"
            >
              <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
              {refreshing ? 'Checking...' : 'Refresh status'}
            </button>
          </div>

          {/* Model selection — CLI providers */}
          {provider !== 'local' && (() => {
            // For Copilot: surface the saved selection as an "orphaned" option
            // when it's not in the visible list. This keeps the dropdown in
            // sync with what sendMessage / polish will actually call —
            // critical post-restart before the user clicks Refresh models.
            const savedInList = providerModels.some((m) => m.id === model);
            const orphan =
              provider === 'copilot' && model && !savedInList
                ? { id: model, label: prettifyModelId(model), provider: 'copilot' as const, source: undefined, billing: 'unknown' as const, description: 'Last selection — click Refresh models to verify availability' }
                : null;
            const visible = orphan ? [orphan, ...providerModels] : providerModels;
            // Caption classifier: inspect the full list, not just [0].
            // all 'cli'      -> live subscription
            // all 'curated'  -> built-in catalog
            // mixed          -> low-confidence probe + curated supplements
            let copilotCaption: string | undefined;
            if (provider === 'copilot') {
              const sources = new Set(
                providerModels
                  .map((m) => m.source)
                  .filter((s): s is NonNullable<typeof s> => Boolean(s)),
              );
              if (providerModels.length === 0) {
                copilotCaption = 'Built-in catalog — click "Refresh models" to load your subscription';
              } else if (sources.size === 1 && sources.has('cli')) {
                copilotCaption = 'From your GitHub Copilot subscription';
              } else if (sources.size === 1 && sources.has('curated')) {
                copilotCaption = 'Built-in catalog — click "Refresh models" for your live subscription list';
              } else if (sources.has('cli') && sources.has('curated')) {
                copilotCaption = 'Live probe plus built-in fallback entries — click "Refresh models" again to retry';
              } else {
                copilotCaption = 'Built-in catalog — click "Refresh models" to load your subscription';
              }
            }
            return (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-iron-text">Model</label>
                  {provider === 'copilot' && (
                    <button
                      onClick={handleRefreshModels}
                      disabled={refreshingModels}
                      className="flex items-center gap-1.5 text-[11px] text-iron-accent-light hover:underline"
                      title="Query GitHub Copilot for the models your subscription supports"
                    >
                      <RefreshCw className={`w-3 h-3 ${refreshingModels ? 'animate-spin' : ''}`} />
                      {refreshingModels ? 'Loading...' : 'Refresh models'}
                    </button>
                  )}
                </div>
                <p className="text-xs text-iron-text-muted">
                  {provider === 'copilot'
                    ? copilotCaption
                    : 'Select which Claude model to use'}
                </p>
                <div className="space-y-1 mt-2">
                  {visible.map((m) => {
                    const isOrphan = orphan && m.id === orphan.id;
                    const isFree = m.billing === 'free';
                    return (
                      <button
                        key={m.id}
                        onClick={() => handleModelChange(m.id)}
                        className={`w-full text-left px-3 py-2.5 rounded-lg text-xs transition-all ${
                          model === m.id
                            ? 'bg-iron-accent/15 text-iron-accent-light border border-iron-accent/20'
                            : 'bg-iron-surface text-iron-text-secondary border border-iron-border hover:border-iron-border-hover'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <span className="font-medium">{m.label}</span>
                            {isFree && (
                              <span className="ml-1.5 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-iron-success/15 text-iron-success border border-iron-success/20">Free</span>
                            )}
                            {isOrphan && (
                              <span className="ml-1.5 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-iron-warning/15 text-iron-warning border border-iron-warning/20">Saved</span>
                            )}
                          </div>
                          {model === m.id && <CheckCircle className="w-3.5 h-3.5 text-iron-accent-light" />}
                        </div>
                        {m.description && (
                          <span className="block text-[10px] text-iron-text-muted mt-0.5">{m.description}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* Model selection — Local LLM with download */}
          {provider === 'local' && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-iron-text">Local Model</label>
              <p className="text-xs text-iron-text-muted">
                Download and select a local LLM. Models run entirely on your device.
              </p>
              {downloadError && (
                <div className="text-[11px] text-red-400 mt-1 whitespace-pre-wrap break-all">
                  {downloadError}
                  <p className="mt-1 text-iron-text-muted font-medium">
                    Use the import section below to add the model file manually.
                  </p>
                </div>
              )}
              {/* Always-visible AI model import */}
              <ModelImportSection
                sectionLabel="AI Chat"
                filter="chat"
                onImported={loadAiSettings}
                highlightOnError={showImport}
              />
              <div className="space-y-1.5 mt-2">
                {localModels.map((m: any) => {
                  const isSelected = model === m.id;
                  const isDownloading = downloadingModel === m.id;
                  const isCompatible = m.compatible !== false;
                  return (
                    <div
                      key={m.id}
                      className={`w-full text-left px-3 py-3 rounded-lg text-xs transition-all ${
                        !isCompatible
                          ? 'bg-iron-surface text-iron-text-muted border border-iron-border opacity-60'
                          : isSelected && m.downloaded
                          ? 'bg-iron-accent/15 text-iron-accent-light border border-iron-accent/20'
                          : 'bg-iron-surface text-iron-text-secondary border border-iron-border'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium">{m.label}</span>
                            <span className="text-[10px] text-iron-text-muted">{m.sizeLabel}</span>
                            {isCompatible ? (
                              <span className="ml-1 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-iron-success/15 text-iron-success border border-iron-success/20">Free</span>
                            ) : (
                              <span className="ml-1 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-iron-text-muted/15 text-iron-text-muted border border-iron-text-muted/20">Soon</span>
                            )}
                          </div>
                          <span className="block text-[10px] text-iron-text-muted mt-0.5">{m.description}</span>
                        </div>
                        <div className="flex-shrink-0 ml-2">
                          {!isCompatible ? (
                            <span className="text-[10px] text-iron-text-muted">Unavailable</span>
                          ) : m.downloaded ? (
                            isSelected ? (
                              <CheckCircle className="w-4 h-4 text-iron-accent-light" />
                            ) : (
                              <button
                                onClick={() => handleModelChange(m.id)}
                                className="px-2.5 py-1 text-[10px] font-medium rounded-md bg-iron-surface-hover text-iron-text-secondary hover:text-iron-text border border-iron-border"
                              >
                                Select
                              </button>
                            )
                          ) : isDownloading ? (
                            <span className="text-[10px] text-iron-text-muted">{downloadProgress}%</span>
                          ) : (
                            <button
                              onClick={() => handleDownloadLocalModel(m.id)}
                              className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded-md bg-gradient-accent text-white hover:shadow-glow transition-all"
                            >
                              <Download className="w-3 h-3" />
                              Download
                            </button>
                          )}
                        </div>
                      </div>
                      {isDownloading && (
                        <div className="mt-2 w-full h-1 bg-iron-surface-active rounded-full overflow-hidden">
                          <div className="h-full bg-gradient-accent rounded-full transition-all duration-300" style={{ width: `${downloadProgress}%` }} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Cloud opt-ins — the two AI Assist features that route user
              content off-device. Co-located here (relocated from Security &
              Privacy in v1.8.x) so the user has one place to manage them. */}
          <div ref={polishToggleRef}>
            <Card
              variant="default"
              padding="md"
              className={allowCloudPolish ? 'border-amber-500/40' : ''}
            >
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2 min-w-0 flex-1">
                    <Sparkles className="w-4 h-4 text-iron-text-muted mt-0.5 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-iron-text">Use cloud AI when authenticated (Claude / Copilot)</p>
                      <p className="text-xs text-iron-text-muted mt-0.5">
                        Off by default. IronMic processes everything locally. Turning this on
                        routes polish, meeting summarization, and other AI tasks through the
                        authenticated Claude or Copilot CLI. Live meeting summaries always
                        stay local regardless of this setting.
                      </p>
                    </div>
                  </div>
                  <Toggle checked={allowCloudPolish} onChange={handleCloudPolishToggle} />
                </div>
                {allowCloudPolish && (
                  <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-300">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                    <span>
                      Cloud polish is enabled. Polish runs will use Claude or Copilot when authenticated;
                      otherwise they fall back to the local LLM. The polish toggle in Notes shows a "via Claude" /
                      "via Copilot" / "via local" badge so you can confirm where each polish ran.
                    </span>
                  </div>
                )}
              </div>
            </Card>
          </div>

          <div ref={voiceChatToggleRef}>
            <Card
              variant="default"
              padding="md"
              className={allowCloudVoiceChat ? 'border-amber-500/40' : ''}
            >
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2 min-w-0 flex-1">
                    <Mic className="w-4 h-4 text-iron-text-muted mt-0.5 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-iron-text">Allow cloud Voice Chat (Claude / Copilot)</p>
                      <p className="text-xs text-iron-text-muted mt-0.5">
                        Off by default. The conversational Voice Chat loop auto-sends each turn the
                        moment you stop speaking. Local Voice Chat is always available; this opt-in
                        lets the same loop talk to your authenticated Claude or Copilot CLI.
                      </p>
                    </div>
                  </div>
                  <Toggle checked={allowCloudVoiceChat} onChange={handleCloudVoiceChatToggle} />
                </div>
                {allowCloudVoiceChat && (
                  <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-300">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                    <span>
                      Cloud Voice Chat is enabled. Each turn auto-sends to Claude or Copilot when
                      that provider is selected and authenticated. The overlay shows a "via Claude" /
                      "via Copilot" badge per turn so you always see where your speech went.
                    </span>
                  </div>
                )}
              </div>
            </Card>
          </div>

          {/* ── Search my IronMic (in AI Assistant) ────────────────────── */}
          <Card variant="default" padding="md">
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2 min-w-0 flex-1">
                  <Sparkles className="w-4 h-4 text-iron-text-muted mt-0.5 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-iron-text">Search my IronMic (in AI Assistant)</p>
                    <p className="text-xs text-iron-text-muted mt-0.5">
                      Surfaces a "Search my IronMic" button in the AI Assistant input row.
                      When toggled on per-chat, each send first retrieves the most relevant
                      chunks from your notes, dictations, and meetings, and injects them as
                      context. Turn this master setting off to hide the button entirely.
                    </p>
                  </div>
                </div>
                <Toggle checked={knowledgeQaEnabled} onChange={handleKnowledgeQaEnabledToggle} />
              </div>
            </div>
          </Card>

          {indexStats && (
            <Card variant="default" padding="md">
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2 min-w-0 flex-1">
                    <Info className="w-4 h-4 text-iron-text-muted mt-0.5 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-iron-text">Index status</p>
                      <p className="text-xs text-iron-text-muted mt-0.5">
                        <strong className="text-iron-text-secondary">{indexStats.total.toLocaleString()}</strong>{' '}
                        chunks indexed
                        {Object.keys(indexStats.byType).length > 0 && (
                          <>
                            {' '}({Object.entries(indexStats.byType).map(([k, v]) => `${v} ${k}`).join(', ')})
                          </>
                        )}.
                        Rebuilding starts from zero on next Ask page visit; safe to do if retrieval
                        feels stale.
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={handleRebuildIndex}
                    className="text-xs px-3 py-1.5 rounded-lg border border-iron-border text-iron-text-secondary hover:bg-iron-surface-hover transition-colors flex-shrink-0"
                  >
                    Rebuild
                  </button>
                </div>
              </div>
            </Card>
          )}

          {/* Info card — contextual per provider */}
          <Card variant="default" padding="md">
            <div className="flex items-start gap-2.5">
              <Info className="w-4 h-4 text-iron-text-muted flex-shrink-0 mt-0.5" />
              <div className="text-xs text-iron-text-muted leading-relaxed">
                {provider === 'local' ? (
                  <>
                    <p>
                      Local LLM runs <strong className="text-iron-text">entirely on your device</strong> — no internet connection or API keys required. All processing stays on-machine.
                    </p>
                    <p className="mt-1.5">
                      Models use 4-8 GB of RAM during inference. Performance depends on your hardware (CPU/GPU). Response times are typically a few seconds per message.
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      AI Assist uses your own CLI tools — <strong className="text-iron-text">GitHub CLI</strong> with the GitHub Models extension (<code className="text-[10px] bg-iron-surface-active px-1 py-0.5 rounded">gh models run</code>) or <strong className="text-iron-text">Claude Code CLI</strong> (<code className="text-[10px] bg-iron-surface-active px-1 py-0.5 rounded">claude</code>).
                    </p>
                    <p className="mt-1.5">
                      First-time GitHub Copilot setup: <code className="text-[10px] bg-iron-surface-active px-1 py-0.5 rounded">gh auth login</code> then <code className="text-[10px] bg-iron-surface-active px-1 py-0.5 rounded">gh extension install github/gh-models</code>.
                    </p>
                    <p className="mt-1.5">
                      Your credentials stay on your machine. IronMic never sees or stores your API keys — it calls the CLI directly.
                    </p>
                  </>
                )}
              </div>
            </div>
          </Card>
        </>
      )}
    </>
  );
}

// ═══════════════════════════════════════════
// Speech (TTS)
// ═══════════════════════════════════════════

interface TtsReadiness {
  ready: boolean;
  modelPresent: boolean;
  voicesPresent: boolean;
  selectedVoicePresent: boolean;
  selectedVoiceId: string;
  missingVoices: string[];
  espeakAvailable: boolean;
  espeakHint: string | null;
  modelPath: string;
  voicesDir: string;
}

function SpeechSettings() {
  const [autoReadback, setAutoReadback] = useState(false);
  const [voice, setVoice] = useState('af_heart');
  const [speed, setSpeed] = useState(1.0);
  const [voices, setVoices] = useState<any[]>([]);
  const [previewPlaying, setPreviewPlaying] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<TtsReadiness | null>(null);
  const [ttsModelDownloaded, setTtsModelDownloaded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [voicesProgress, setVoicesProgress] = useState<{ id: string; downloaded: number; total: number; status: string } | null>(null);
  const [voicesProgressCount, setVoicesProgressCount] = useState<{ done: number; total: number }>({ done: 0, total: 15 });

  const modelReady = readiness?.ready ?? false;

  useEffect(() => {
    loadTtsSettings();
    const cleanupModel = window.ironmic.onModelDownloadProgress((prog: any) => {
      if (prog.model === 'tts-model' || prog.model === 'tts-voices') {
        if (prog.model === 'tts-model') setDownloadProgress(prog.percent);
        if (prog.status === 'complete' && prog.model === 'tts-model') {
          setDownloading(false);
          setTtsModelDownloaded(true);
          loadTtsSettings(); // Re-check full readiness (model + voices)
        }
        if (prog.status === 'error') { setDownloading(false); setDownloadError(prog.errorDetail || 'TTS model download failed'); setShowImport(true); }
      }
    });
    const cleanupVoices = (window.ironmic as any).onTtsVoicesProgress?.((prog: any) => {
      setVoicesProgress(prog);
      if (prog.status === 'complete' || prog.status === 'verified') {
        setVoicesProgressCount(c => ({ ...c, done: Math.min(c.total, c.done + 1) }));
        // After the last voice resolves, refresh readiness so the UI flips green.
        if (prog.status === 'complete') void loadTtsSettings();
      }
    });
    return () => {
      cleanupModel();
      if (typeof cleanupVoices === 'function') cleanupVoices();
    };
  }, []);

  async function loadTtsSettings() {
    const api = window.ironmic;
    const [rb, v, s, voicesJson, readinessResult, modelsStatus] = await Promise.all([
      api.getSetting('tts_auto_readback'),
      api.getSetting('tts_voice'),
      api.getSetting('tts_speed'),
      api.ttsAvailableVoices(),
      (api as any).ttsGetReadiness?.(undefined) as Promise<TtsReadiness | undefined> | undefined,
      api.getModelStatus(),
    ]);
    setAutoReadback(rb !== 'false');
    if (readinessResult) {
      setReadiness(readinessResult);
      setVoicesProgressCount({ done: 15 - readinessResult.missingVoices.length, total: 15 });
    }
    // Check if just the .onnx model file exists (even without voices)
    const ttsStatus = modelsStatus?.files?.['tts-model'] || modelsStatus?.['tts-model'];
    setTtsModelDownloaded(
      (readinessResult?.modelPresent ?? false) ||
      (ttsStatus?.downloaded === true) || (ttsStatus?.sizeBytes > 0)
    );
    if (v) setVoice(v);
    if (s) setSpeed(parseFloat(s));
    try { setVoices(JSON.parse(voicesJson)); } catch { /* ignore */ }
  }

  async function handleDownloadModel() {
    setDownloading(true);
    setDownloadProgress(0);
    setDownloadError(null);
    try { await window.ironmic.downloadModel('tts'); }
    catch (err: any) { setDownloading(false); setDownloadError(err.message || 'TTS model download failed'); setShowImport(true); }
  }

  async function handleAutoReadbackToggle() {
    const val = !autoReadback;
    setAutoReadback(val);
    await window.ironmic.setSetting('tts_auto_readback', String(val));
  }

  async function handleVoiceChange(voiceId: string) {
    setVoice(voiceId);
    await window.ironmic.ttsSetVoice(voiceId);
    await window.ironmic.setSetting('tts_voice', voiceId);
  }

  async function handleSpeedChange(s: number) {
    setSpeed(s);
    await window.ironmic.ttsSetSpeed(s);
    await window.ironmic.setSetting('tts_speed', String(s));
  }

  async function previewVoice(voiceId: string) {
    const v = voices.find((x: any) => x.id === voiceId);
    if (!v) return;
    setPreviewPlaying(voiceId);
    try {
      await window.ironmic.ttsSetVoice(voiceId);
      await window.ironmic.synthesizeText(v.preview_text || v.previewText || 'Welcome to IronMic.');
    } catch { /* ignore */ }
    setPreviewPlaying(null);
  }

  const grouped = voices.reduce((acc: Record<string, any[]>, v: any) => {
    const lang = v.language === 'en-us' ? 'American English' : v.language === 'en-gb' ? 'British English' : v.language;
    if (!acc[lang]) acc[lang] = [];
    acc[lang].push(v);
    return acc;
  }, {});

  return (
    <>
      <SectionHeader icon={Volume2} title="Text-to-Speech" description="Voice engine, playback speed, and read-back">
        {ttsModelDownloaded && (
          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${modelReady ? 'bg-green-500/15 text-green-400 border border-green-500/20' : 'bg-amber-500/15 text-amber-400 border border-amber-500/20'}`}>
            Kokoro 82M {modelReady ? '— Ready' : '— Imported'}
          </span>
        )}
      </SectionHeader>

      <Card variant={modelReady ? 'default' : 'highlighted'} padding="md">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-iron-text">Kokoro 82M</p>
            <p className="text-xs text-iron-text-muted mt-0.5">
              {modelReady
                ? readiness && !readiness.selectedVoicePresent
                  ? `Ready — selected voice missing, falling back to af_heart`
                  : 'Local TTS engine ready (~165 MB)'
                : ttsModelDownloaded
                ? 'Model imported — click Repair to install missing assets'
                : 'Download the voice model (~165 MB)'}
            </p>
          </div>
          {modelReady ? (
            <StatusBadge status="success" label="Ready" />
          ) : downloading ? (
            <span className="text-xs text-iron-text-muted">{downloadProgress}%</span>
          ) : (
            <button onClick={handleDownloadModel} className="px-3 py-1.5 bg-gradient-accent text-white text-xs font-medium rounded-lg hover:shadow-glow transition-all">
              {ttsModelDownloaded ? 'Repair TTS' : 'Download'}
            </button>
          )}
        </div>

        {readiness && (
          <div className="mt-3 space-y-1.5 text-[11px] text-iron-text-muted">
            <div className="flex items-center justify-between">
              <span>Model file</span>
              <span className={readiness.modelPresent ? 'text-green-400' : 'text-amber-400'}>
                {readiness.modelPresent ? 'Installed' : `Missing — ${readiness.modelPath}`}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>Voice pack</span>
              <span className={readiness.voicesPresent && readiness.missingVoices.length === 0 ? 'text-green-400' : readiness.voicesPresent ? 'text-amber-400' : 'text-red-400'}>
                {15 - readiness.missingVoices.length}/15 installed
                {readiness.missingVoices.length > 0 && readiness.missingVoices.length <= 4 && (
                  <span className="ml-1">(missing: {readiness.missingVoices.join(', ')})</span>
                )}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>espeak-ng phonemizer</span>
              <span className={readiness.espeakAvailable ? 'text-green-400' : 'text-red-400'}>
                {readiness.espeakAvailable ? 'Available' : (readiness.espeakHint || 'Not installed')}
              </span>
            </div>
          </div>
        )}

        {downloading && (
          <div className="mt-2 w-full h-1 bg-iron-surface-active rounded-full overflow-hidden">
            <div className="h-full bg-gradient-accent rounded-full transition-all duration-300" style={{ width: `${downloadProgress}%` }} />
          </div>
        )}
        {voicesProgress && voicesProgress.status !== 'complete' && (
          <div className="mt-2 text-[11px] text-iron-text-muted">
            <div className="flex items-center justify-between">
              <span>Voice {voicesProgressCount.done + 1}/{voicesProgressCount.total} — {voicesProgress.id}</span>
              <span className={voicesProgress.status === 'error' ? 'text-red-400' : ''}>{voicesProgress.status}</span>
            </div>
            <div className="mt-1 w-full h-1 bg-iron-surface-active rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-accent rounded-full transition-all duration-300"
                style={{ width: voicesProgress.total > 0 ? `${Math.min(100, (voicesProgress.downloaded / voicesProgress.total) * 100)}%` : '0%' }}
              />
            </div>
          </div>
        )}
        {downloadError && (
          <div className="text-[11px] text-red-400 mt-2 whitespace-pre-wrap break-all">
            {downloadError}
            <p className="mt-1 text-iron-text-muted font-medium">
              Use the import section below to add the TTS model file manually.
            </p>
          </div>
        )}
      </Card>

      {/* Always-visible TTS import */}
      <ModelImportSection
        sectionLabel="TTS Voice"
        filter="tts"
        onImported={loadTtsSettings}
        highlightOnError={showImport}
      />

      <SettingRow
        title="Auto Read-Back"
        description="Automatically read text aloud after dictation completes"
        control={<Toggle checked={autoReadback} onChange={handleAutoReadbackToggle} />}
      />

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-iron-text">Default Speed</label>
        <div className="flex items-center gap-2">
          {[0.75, 1.0, 1.25, 1.5, 2.0].map((s) => (
            <button key={s} onClick={() => handleSpeedChange(s)} className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
              speed === s ? 'bg-iron-accent/15 text-iron-accent-light border border-iron-accent/20' : 'bg-iron-surface text-iron-text-muted border border-iron-border hover:border-iron-border-hover'
            }`}>{s}x</button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-iron-text">Voice</label>
        {Object.entries(grouped).map(([lang, langVoices]) => (
          <div key={lang}>
            <p className="text-[10px] font-semibold text-iron-text-muted uppercase tracking-wider mb-1">{lang}</p>
            <div className="grid grid-cols-2 gap-1.5">
              {(langVoices as any[]).map((v: any) => (
                <button key={v.id} onClick={() => handleVoiceChange(v.id)} className={`flex items-center justify-between px-3 py-2 rounded-lg text-xs transition-all ${
                  voice === v.id ? 'bg-iron-accent/10 border border-iron-accent/20 text-iron-accent-light' : 'bg-iron-surface border border-iron-border hover:border-iron-border-hover text-iron-text-secondary'
                }`}>
                  <span>{v.name}</span>
                  <button onClick={(e) => { e.stopPropagation(); previewVoice(v.id); }} className="p-0.5 rounded hover:bg-iron-surface-hover" title="Preview voice">
                    {previewPlaying === v.id ? <div className="w-3 h-3 border border-iron-accent border-t-transparent rounded-full animate-spin" /> : <Volume2 className="w-3 h-3" />}
                  </button>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ═══════════════════════════════════════════
// Data
// ═══════════════════════════════════════════

function DataSettings() {
  return (
    <>
      <SectionHeader icon={Database} title="Data Management" description="Storage, cleanup, and retention policies" />
      <DataManager />
    </>
  );
}

// ═══════════════════════════════════════════
// Security
// ═══════════════════════════════════════════

function SecuritySettings() {
  const [clipboardAutoClear, setClipboardAutoClear] = useState('off');
  const [sessionTimeout, setSessionTimeout] = useState('off');
  const [clearOnExit, setClearOnExit] = useState(false);
  const [aiDataConfirm, setAiDataConfirm] = useState(false);
  const [privacyMode, setPrivacyMode] = useState(false);
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyUrl, setProxyUrl] = useState('');
  const [proxySaved, setProxySaved] = useState(false);
  const [devFeaturesEnabled, setDevFeaturesEnabled] = useState(false);

  useEffect(() => {
    loadSecuritySettings();
  }, []);

  async function loadSecuritySettings() {
    const api = window.ironmic;
    const [clip, timeout, exit, aiConfirm, privacy, pEnabled, pUrl, devFeatures] = await Promise.all([
      api.getSetting('security_clipboard_auto_clear'),
      api.getSetting('security_session_timeout'),
      api.getSetting('security_clear_on_exit'),
      api.getSetting('security_ai_data_confirm'),
      api.getSetting('security_privacy_mode'),
      api.getSetting('proxy_enabled'),
      api.getSetting('proxy_url'),
      api.getSetting('dev_features_enabled'),
    ]);
    if (clip) setClipboardAutoClear(clip);
    if (timeout) setSessionTimeout(timeout);
    setClearOnExit(exit === 'true');
    setAiDataConfirm(aiConfirm === 'true');
    setPrivacyMode(privacy === 'true');
    setProxyEnabled(pEnabled === 'true');
    if (pUrl) setProxyUrl(pUrl);
    setDevFeaturesEnabled(devFeatures === 'true');
  }

  async function updateSetting(key: string, value: string) {
    await window.ironmic.setSetting(key, value);
  }

  return (
    <>
      <SectionHeader icon={Shield} title="Security & Privacy" description="Data protection, session controls, and privacy settings" />

      {/* Security posture overview */}
      <Card variant="default" padding="md" className="space-y-3">
        <p className="text-xs font-semibold text-iron-text-muted uppercase tracking-wider">Security Posture</p>
        <div className="space-y-2">
          <PostureItem icon={WifiOff} label="Network Isolation" detail={proxyEnabled ? `All traffic blocked except model downloads via proxy (${proxyUrl || 'not set'}).` : 'All outbound requests blocked. Only model downloads allowed on demand.'} status="strong" />
          <PostureItem icon={HardDrive} label="Audio Privacy" detail="Mic audio held in memory only. Buffers zeroed on drop. Never written to disk." status="strong" />
          <PostureItem icon={Lock} label="Context Isolation" detail="Renderer sandboxed from Node.js. Typed IPC bridge only." status="strong" />
          <PostureItem icon={FileWarning} label="Database Encryption" detail="SQLite database stored unencrypted on disk. Enable OS-level disk encryption (FileVault/BitLocker)." status="warning" />
          <PostureItem icon={ClipboardCheck} label="Clipboard" detail={clipboardAutoClear === 'off' ? 'Text remains in clipboard until overwritten. Enable auto-clear below.' : `Auto-cleared after ${clipboardAutoClear}`} status={clipboardAutoClear === 'off' ? 'warning' : 'strong'} />
        </div>
      </Card>

      {/* Cloud opt-ins for AI Assist (cloud polish, cloud Voice Chat) live
          in Settings → AI Assist as of v1.8.x. Co-located with provider /
          model selection so all "what does AI Assist talk to?" controls
          are in one place. */}

      {/* Proxy Configuration */}
      <Card variant="default" padding="md">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Wifi className="w-4 h-4 text-iron-text-muted" />
              <div>
                <p className="text-sm font-medium text-iron-text">HTTP Proxy</p>
                <p className="text-xs text-iron-text-muted">Route model downloads through a corporate proxy</p>
              </div>
            </div>
            <Toggle
              checked={proxyEnabled}
              onChange={async (v) => {
                setProxyEnabled(v);
                await updateSetting('proxy_enabled', String(v));
                setProxySaved(false);
              }}
            />
          </div>
          {proxyEnabled && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={proxyUrl}
                  onChange={(e) => { setProxyUrl(e.target.value); setProxySaved(false); }}
                  placeholder="http://proxy.company.com:8080"
                  className="flex-1 text-xs bg-iron-surface border border-iron-border rounded-lg px-3 py-2 text-iron-text placeholder:text-iron-text-muted focus:outline-none focus:border-iron-accent/50"
                />
                <button
                  onClick={async () => {
                    await updateSetting('proxy_url', proxyUrl.trim());
                    setProxySaved(true);
                    setTimeout(() => setProxySaved(false), 3000);
                  }}
                  className="px-3 py-1.5 text-xs font-medium bg-iron-accent/10 text-iron-accent-light rounded-lg hover:bg-iron-accent/20 transition-colors"
                >
                  {proxySaved ? 'Saved' : 'Save'}
                </button>
              </div>
              <p className="text-[10px] text-iron-text-muted">
                Supports HTTP/HTTPS/SOCKS5 proxies. Also respects HTTPS_PROXY and HTTP_PROXY environment variables.
                Examples: http://proxy:8080 &middot; http://user:pass@proxy:8080 &middot; socks5://proxy:1080
              </p>
            </div>
          )}
        </div>
      </Card>

      {/* Clipboard auto-clear */}
      <Card variant="default" padding="md">
        <div className="flex items-start gap-3">
          <ClipboardCheck className="w-4 h-4 text-iron-text-muted mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-iron-text">Clipboard Auto-Clear</p>
            <p className="text-xs text-iron-text-muted mt-0.5">
              Automatically clear the clipboard after copying dictation text
            </p>
            <div className="flex gap-1.5 mt-2">
              {[
                { value: 'off', label: 'Off' },
                { value: '15s', label: '15s' },
                { value: '30s', label: '30s' },
                { value: '60s', label: '1m' },
                { value: '120s', label: '2m' },
              ].map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => { setClipboardAutoClear(value); updateSetting('security_clipboard_auto_clear', value); }}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                    clipboardAutoClear === value
                      ? 'bg-iron-accent/15 text-iron-accent-light border border-iron-accent/20'
                      : 'bg-iron-surface text-iron-text-muted border border-iron-border hover:border-iron-border-hover'
                  }`}
                >{label}</button>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* Session timeout */}
      <Card variant="default" padding="md">
        <div className="flex items-start gap-3">
          <Clock className="w-4 h-4 text-iron-text-muted mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-iron-text">Session Timeout</p>
            <p className="text-xs text-iron-text-muted mt-0.5">
              Require interaction to resume after a period of inactivity
            </p>
            <div className="flex gap-1.5 mt-2">
              {[
                { value: 'off', label: 'Off' },
                { value: '5m', label: '5m' },
                { value: '15m', label: '15m' },
                { value: '30m', label: '30m' },
                { value: '60m', label: '1hr' },
              ].map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => { setSessionTimeout(value); updateSetting('security_session_timeout', value); }}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                    sessionTimeout === value
                      ? 'bg-iron-accent/15 text-iron-accent-light border border-iron-accent/20'
                      : 'bg-iron-surface text-iron-text-muted border border-iron-border hover:border-iron-border-hover'
                  }`}
                >{label}</button>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* Clear sessions on exit */}
      <SettingRow
        icon={Trash2}
        title="Clear Sessions on Exit"
        description="Wipe AI chat history and temporary data when the app closes"
        control={<Toggle checked={clearOnExit} onChange={(v) => { setClearOnExit(v); updateSetting('security_clear_on_exit', String(v)); }} />}
      />

      {/* AI data confirmation */}
      <SettingRow
        icon={Bot}
        title="AI Data Confirmation"
        description="Show a confirmation before sending text to AI CLI processes"
        control={<Toggle checked={aiDataConfirm} onChange={(v) => { setAiDataConfirm(v); updateSetting('security_ai_data_confirm', String(v)); }} />}
      />

      {/* Privacy mode */}
      <SettingRow
        icon={privacyMode ? EyeOff : Eye}
        title="Privacy Mode"
        description="Hide dictation text in the UI — show only timestamps and metadata"
        control={<Toggle checked={privacyMode} onChange={(v) => { setPrivacyMode(v); updateSetting('security_privacy_mode', String(v)); }} />}
      />

      {/* Data at rest info */}
      <Card variant="default" padding="md">
        <div className="flex items-start gap-3">
          <Info className="w-4 h-4 text-iron-accent-light mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-iron-text">Data at Rest</p>
            <p className="text-xs text-iron-text-muted mt-1 leading-relaxed">
              Your dictations are stored in a local SQLite database. AI chat sessions and notes are stored in the browser&apos;s local storage. Neither is encrypted by IronMic directly.
            </p>
            <p className="text-xs text-iron-text-muted mt-1.5 leading-relaxed">
              <strong className="text-iron-text">Recommendation:</strong> Enable full-disk encryption on your operating system (FileVault on macOS, BitLocker on Windows, LUKS on Linux) to protect all local data at rest.
            </p>
          </div>
        </div>
      </Card>

      {/* AI data flow info */}
      <Card variant="default" padding="md">
        <div className="flex items-start gap-3">
          <Info className="w-4 h-4 text-iron-accent-light mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-iron-text">AI Data Flow</p>
            <p className="text-xs text-iron-text-muted mt-1 leading-relaxed">
              When you use the AI assistant, your message text is passed to a locally-installed CLI (Claude Code or GitHub Copilot). The CLI then communicates with its cloud service using your own authenticated credentials.
            </p>
            <p className="text-xs text-iron-text-muted mt-1.5 leading-relaxed">
              IronMic itself makes <strong className="text-iron-text">zero network requests</strong>. The AI CLI is an external process on your machine that you&apos;ve separately authenticated.
            </p>
          </div>
        </div>
      </Card>

      {/* Network info */}
      <Card variant="default" padding="md">
        <div className="flex items-start gap-3">
          <WifiOff className="w-4 h-4 text-iron-success mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-iron-text">Network Policy</p>
            <p className="text-xs text-iron-text-muted mt-1 leading-relaxed">
              IronMic blocks all outbound HTTP, HTTPS, and WebSocket requests at the Electron process level. The only exception is model file downloads, which occur <strong className="text-iron-text">only when you explicitly click Download</strong> in the Models settings.
            </p>
            <p className="text-xs text-iron-text-muted mt-1.5 leading-relaxed">
              Model files are fetched from HuggingFace over HTTPS. No checksums are currently verified — this is a known limitation. Future releases will include SHA-256 verification.
            </p>
          </div>
        </div>
      </Card>

      {/* Developer features (last subsection — gated experimental controls) */}
      <div className="pt-2">
        <p className="text-xs font-semibold text-iron-text-muted uppercase tracking-wider mb-2">Developer</p>
        <SettingRow
          icon={FlaskConical}
          title="Developer features"
          description="Exposes legacy and experimental controls (Solo meeting mode, etc.). Off by default."
          control={
            <Toggle
              checked={devFeaturesEnabled}
              onChange={(v) => { setDevFeaturesEnabled(v); updateSetting('dev_features_enabled', String(v)); }}
            />
          }
        />
      </div>
    </>
  );
}

// ═══════════════════════════════════════════
// Voice AI (ML Features)
// ═══════════════════════════════════════════

function VoiceAISettings() {
  const [voiceRoutingEnabled, setVoiceRoutingEnabled] = useState(false);
  const [meetingModeEnabled, setMeetingModeEnabled] = useState(false);
  const [intentEnabled, setIntentEnabled] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [notificationThreshold, setNotificationThreshold] = useState(0.5);
  const [workflowsEnabled, setWorkflowsEnabled] = useState(false);
  const [workflowConfidence, setWorkflowConfidence] = useState(0.7);
  const [semanticSearchEnabled, setSemanticSearchEnabled] = useState(false);
  const [meetingAutoDetect, setMeetingAutoDetect] = useState(false);
  // Remote-meeting capture: dual-stream mic + WASAPI loopback so segments can
  // be tagged "You" / "Remote" at capture time without LLM diarization.
  // Windows-only in v1; non-Windows users see a disabled toggle with an
  // explanation pointing at the virtual-loopback setup modal.
  const [remoteCaptureEnabled, setRemoteCaptureEnabled] = useState(false);
  // Speaker diarization mode for the remote-meeting loopback stream.
  // 'off'       → Simple: one row per chunk labeled "Remote" (default, fast)
  // 'embedding' → Advanced: per-utterance rows with WeSpeaker [Speaker N]
  //               labels + post-meeting AHC refinement. Slower per chunk.
  const [diarizationAdvanced, setDiarizationAdvanced] = useState(false);
  const isWindows = navigator.userAgent.toLowerCase().includes('windows');

  useEffect(() => {
    (async () => {
      const ironmic = (window as any).ironmic;
      if (!ironmic) return;
      const val = (key: string, fallback: string) =>
        ironmic.getSetting(key).then((v: string | null) => v ?? fallback);

      setVoiceRoutingEnabled((await val('voice_routing_enabled', 'false')) === 'true');
      setMeetingModeEnabled((await val('meeting_mode_enabled', 'false')) === 'true');
      setIntentEnabled((await val('intent_classification_enabled', 'false')) === 'true');
      setNotificationsEnabled((await val('ml_notifications_enabled', 'false')) === 'true');
      setNotificationThreshold(parseFloat(await val('ml_notifications_threshold', '0.5')));
      setWorkflowsEnabled((await val('ml_workflows_enabled', 'false')) === 'true');
      setWorkflowConfidence(parseFloat(await val('ml_workflows_confidence', '0.7')));
      setSemanticSearchEnabled((await val('ml_semantic_search_enabled', 'false')) === 'true');
      setMeetingAutoDetect((await val('meeting_auto_detect_enabled', 'false')) === 'true');
      setRemoteCaptureEnabled((await val('meeting_remote_capture_enabled', 'false')) === 'true');
      setDiarizationAdvanced((await val('meeting_diarization_mode', 'off')) === 'embedding');
    })();
  }, []);

  const update = (key: string, value: string) => {
    const ironmic = (window as any).ironmic;
    if (ironmic) ironmic.setSetting(key, value);
  };

  const handleDeleteAllMLData = async () => {
    if (!confirm('Delete all learned ML data? This cannot be undone.')) return;
    const ironmic = (window as any).ironmic;
    if (ironmic?.mlDeleteAllData) await ironmic.mlDeleteAllData();
  };

  return (
    <>
      <SectionHeader icon={Brain} title="Voice AI" description="On-device machine learning features" />

      <Card>
        <div className="p-4 space-y-5">
          <div className="text-xs text-iron-text-muted mb-3">
            All ML processing runs entirely on your device. No data leaves this machine.
          </div>

          {/* Voice Routing */}
          <SettingRow
            icon={Route}
            title="Context-Aware Voice Routing"
            description="Automatically route voice input based on active screen"
            control={
              <Toggle
                checked={voiceRoutingEnabled}
                onChange={(v) => { setVoiceRoutingEnabled(v); update('voice_routing_enabled', String(v)); }}
              />
            }
          />

          {/* Meeting Mode */}
          <SettingRow
            icon={Users}
            title="Ambient Meeting Mode"
            description="Passive transcription with speaker detection and auto-summarization"
            control={
              <Toggle
                checked={meetingModeEnabled}
                onChange={(v) => { setMeetingModeEnabled(v); update('meeting_mode_enabled', String(v)); }}
              />
            }
          />
          <SettingRow
            icon={Monitor}
            title="Meeting App Auto-Detection"
            description="Detect when Zoom, Teams, or Google Meet is active and offer to start meeting mode. Only checks the frontmost window title — no deep process inspection."
            control={
              <Toggle
                checked={meetingAutoDetect}
                onChange={(v) => { setMeetingAutoDetect(v); update('meeting_auto_detect_enabled', String(v)); }}
              />
            }
          />
          <SettingRow
            icon={Users}
            title="Capture Remote Participants by Default"
            description={
              isWindows
                ? 'Run new meetings in dual-stream mode: your mic AND system audio (the remote participants you hear) are transcribed separately, so the transcript labels "You" vs "Remote" without LLM guessing. Recommended with headphones — speakers can leak remote audio back into your mic.'
                : 'Available on Windows only in v1. On macOS / Linux, install a virtual loopback driver (BlackHole, VB-CABLE, PulseAudio monitor sink) and pick it as the meeting audio device.'
            }
            control={
              <Toggle
                checked={remoteCaptureEnabled}
                disabled={!isWindows}
                onChange={(v) => { setRemoteCaptureEnabled(v); update('meeting_remote_capture_enabled', String(v)); }}
              />
            }
          />
          {remoteCaptureEnabled && isWindows && (
            <SettingRow
              icon={Users}
              title="Identify Individual Remote Speakers (Advanced)"
              description={
                'Off (Simple, default): all remote audio is labeled "Remote" and appears with the same low latency as your mic stream. ' +
                'On (Advanced): a local 26 MB WeSpeaker model assigns [Speaker 1], [Speaker 2]… labels to distinguish up to ~20 distinct voices. ' +
                'Advanced doubles the per-chunk processing cost and is best for meetings where knowing who said what matters more than instant transcript.'
              }
              control={
                <Toggle
                  checked={diarizationAdvanced}
                  onChange={(v) => {
                    setDiarizationAdvanced(v);
                    update('meeting_diarization_mode', v ? 'embedding' : 'off');
                    // Mark as explicitly user-chosen so the startup default
                    // reset (main/index.ts) won't override the choice.
                    update('meeting_diarization_user_overridden', 'true');
                  }}
                />
              }
            />
          )}

          <div className="border-t border-iron-border" />

          {/* Intent Classification */}
          <SettingRow
            icon={Sliders}
            title="Voice Commands"
            description="Classify voice input as commands (search, navigate, create)"
            control={
              <Toggle
                checked={intentEnabled}
                onChange={(v) => { setIntentEnabled(v); update('intent_classification_enabled', String(v)); }}
              />
            }
          />

          <div className="border-t border-iron-border" />

          {/* Notification Intelligence */}
          <SettingRow
            icon={Bell}
            title="Smart Notifications"
            description="Learn which notifications matter to you and rank by importance"
            control={
              <Toggle
                checked={notificationsEnabled}
                onChange={(v) => { setNotificationsEnabled(v); update('ml_notifications_enabled', String(v)); }}
              />
            }
          />
          {notificationsEnabled && (
            <div className="ml-10 space-y-2">
              <label className="text-xs text-iron-text-secondary">Ranking sensitivity: {notificationThreshold.toFixed(1)}</label>
              <input
                type="range" min="0.1" max="0.9" step="0.1"
                value={notificationThreshold}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setNotificationThreshold(v);
                  update('ml_notifications_threshold', String(v));
                }}
                className="w-full accent-iron-accent"
              />
            </div>
          )}

          {/* Workflow Discovery */}
          <SettingRow
            icon={Workflow}
            title="Workflow Discovery"
            description="Detect repeating action patterns and suggest automations"
            control={
              <Toggle
                checked={workflowsEnabled}
                onChange={(v) => { setWorkflowsEnabled(v); update('ml_workflows_enabled', String(v)); }}
              />
            }
          />
          {workflowsEnabled && (
            <div className="ml-10 space-y-2">
              <label className="text-xs text-iron-text-secondary">Confidence threshold: {workflowConfidence.toFixed(1)}</label>
              <input
                type="range" min="0.3" max="0.95" step="0.05"
                value={workflowConfidence}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setWorkflowConfidence(v);
                  update('ml_workflows_confidence', String(v));
                }}
                className="w-full accent-iron-accent"
              />
            </div>
          )}

          <div className="border-t border-iron-border" />

          {/* Semantic Search */}
          <SettingRow
            icon={Search}
            title="Semantic Search"
            description="AI-powered search that understands meaning, not just keywords"
            control={
              <Toggle
                checked={semanticSearchEnabled}
                onChange={(v) => { setSemanticSearchEnabled(v); update('ml_semantic_search_enabled', String(v)); }}
              />
            }
          />
        </div>
      </Card>

      {/* Data Management */}
      <Card>
        <div className="p-4 space-y-3">
          <h3 className="text-sm font-medium text-iron-text">ML Data Management</h3>
          <p className="text-xs text-iron-text-muted">
            All learned data is stored locally on your device. Deleting it resets all ML features to their initial state.
          </p>
          <button
            onClick={handleDeleteAllMLData}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-red-400 bg-red-500/10 rounded-lg hover:bg-red-500/20 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete all learned data
          </button>
        </div>
      </Card>
    </>
  );
}

// ═══════════════════════════════════════════
// Shared components
// ═══════════════════════════════════════════

/**
 * Read-only display of the active dictation gesture. Replaces the legacy
 * HotkeyRecorder because dictation is now triggered by a low-level keyboard
 * gesture in main/keyboard-listener.ts (uiohook), not Electron's
 * globalShortcut. The gesture isn't user-configurable yet — we surface what
 * it is so the user knows the keys to press.
 */
function DictationGestureDisplay() {
  const gesture = getDictationGesture();
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Keyboard className="w-4 h-4 text-iron-text-muted" />
        <label className="text-sm font-medium text-iron-text">Dictation gesture</label>
      </div>
      <div className="rounded-xl border border-iron-border bg-iron-surface px-4 py-3 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs text-iron-text-muted">Hands-free (tap to start, tap to stop)</div>
            <div className="text-sm font-semibold text-iron-text mt-0.5">{gesture.handsFree}</div>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs text-iron-text-muted">Push-to-talk (hold to talk, release to paste)</div>
            <div className="text-sm font-semibold text-iron-text mt-0.5">{gesture.pushToTalk}</div>
          </div>
        </div>
      </div>
      <p className="text-[11px] text-iron-text-muted">
        These gestures work both in the main app and in Forge mode. They're handled by a
        low-level keyboard listener so they can't be remapped here yet.
      </p>
    </div>
  );
}

function SectionHeader({ icon: Icon, title, description, children }: { icon: typeof Settings; title: string; description: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-2">
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-iron-accent/10 flex items-center justify-center">
          <Icon className="w-4 h-4 text-iron-accent-light" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-iron-text">{title}</h2>
          <p className="text-xs text-iron-text-muted">{description}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function SettingRow({ icon: Icon, title, description, control }: {
  icon?: typeof Settings; title: string; description: string; control: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        {Icon && <Icon className="w-4 h-4 text-iron-text-muted flex-shrink-0" />}
        <div>
          <p className="text-sm font-medium text-iron-text">{title}</p>
          <p className="text-xs text-iron-text-muted mt-0.5">{description}</p>
        </div>
      </div>
      {control}
    </div>
  );
}

function StatusBadge({ status, label }: { status: 'success' | 'warning'; label: string }) {
  return (
    <span className={`flex items-center gap-1 text-xs font-medium ${status === 'success' ? 'text-iron-success' : 'text-iron-warning'}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${status === 'success' ? 'bg-iron-success' : 'bg-iron-warning'}`} />
      {label}
    </span>
  );
}

function PostureItem({ icon: Icon, label, detail, status }: {
  icon: typeof Shield; label: string; detail: string; status: 'strong' | 'warning';
}) {
  return (
    <div className="flex items-start gap-2.5">
      <div className={`w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 ${
        status === 'strong' ? 'bg-iron-success/10 text-iron-success' : 'bg-iron-warning/10 text-iron-warning'
      }`}>
        {status === 'strong' ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
      </div>
      <div>
        <div className="flex items-center gap-2">
          <Icon className="w-3 h-3 text-iron-text-muted" />
          <p className="text-xs font-medium text-iron-text">{label}</p>
        </div>
        <p className="text-[11px] text-iron-text-muted mt-0.5">{detail}</p>
      </div>
    </div>
  );
}
