import { useState, useEffect, useCallback } from 'react';
import { useSettingsStore } from '../stores/useSettingsStore';
import { DictionaryManager } from './DictionaryManager';
import { ModelManager } from './ModelManager';
import { ModelImportSection, ModelImportBanner } from './ModelImportBanner';
import { DataManager } from './DataManager';
import { HotkeyRecorder } from './HotkeyRecorder';
import { Toggle, Card } from './ui';
import {
  Settings, Bot, Volume2, Monitor, Sun, Moon, Shield, Keyboard,
  Cpu, Database, BookOpen, Lock, ClipboardCheck, Eye, EyeOff,
  Clock, AlertTriangle, CheckCircle, Info, Wifi, WifiOff, FileWarning,
  Trash2, HardDrive, Sparkles, RefreshCw, Download, Brain,
  Mic, Route, Users, Search, Bell, Workflow, Sliders,
} from 'lucide-react';

type SettingsTab = 'general' | 'speech' | 'ai' | 'models' | 'data' | 'security' | 'voice-ai';

const TABS: { id: SettingsTab; label: string; icon: typeof Settings }[] = [
  { id: 'general', label: 'General', icon: Settings },
  { id: 'speech', label: 'Speech', icon: Volume2 },
  { id: 'ai', label: 'AI Assist', icon: Sparkles },
  { id: 'voice-ai', label: 'Voice AI', icon: Brain },
  { id: 'models', label: 'Models', icon: Cpu },
  { id: 'data', label: 'Data', icon: Database },
  { id: 'security', label: 'Security', icon: Shield },
];

export function SettingsPanel() {
  const [tab, setTab] = useState<SettingsTab>('general');

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
  const { hotkey, llmCleanupEnabled, theme, setHotkey, setLlmCleanup, setTheme } =
    useSettingsStore();

  return (
    <>
      <SectionHeader icon={Settings} title="General" description="Core preferences and behavior" />

      <HotkeyRecorder value={hotkey} onChange={setHotkey} />

      <SettingRow
        title="LLM Text Cleanup"
        description="Polish transcriptions with a local LLM"
        control={<Toggle checked={llmCleanupEnabled} onChange={setLlmCleanup} />}
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
  free: boolean;
  description: string;
}

function AIAssistSettings() {
  const { aiEnabled, setAiEnabled } = useSettingsStore();
  const [provider, setProvider] = useState<string>('copilot');
  const [model, setModel] = useState<string>('gpt-4.1-mini');
  const [models, setModels] = useState<AIModelOption[]>([]);
  const [authState, setAuthState] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [localModels, setLocalModels] = useState<any[]>([]);
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);

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
    const [prov, mod, auth, allModels, localModelStatus] = await Promise.all([
      api.getSetting('ai_provider'),
      api.getSetting('ai_model'),
      api.aiGetAuthState(),
      api.aiGetModels(),
      api.aiGetLocalModelStatus?.() || Promise.resolve([]),
    ]);
    if (prov) setProvider(prov);
    if (mod) setModel(mod);
    setAuthState(auth);
    setModels(allModels || []);
    if (localModelStatus) setLocalModels(localModelStatus);
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
      const defaultModel = providerModels.find((m) => m.free) || providerModels[0];
      if (defaultModel) {
        setModel(defaultModel.id);
        await window.ironmic.setSetting('ai_model', defaultModel.id);
      }
    }
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
      <SectionHeader icon={Sparkles} title="AI Assist" description="Configure the AI assistant and model selection" />

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
                      <span className={`block text-[10px] mt-1 ${auth.authenticated ? 'text-iron-success' : 'text-iron-warning'}`}>
                        {value === 'local'
                          ? (auth.authenticated ? '● Model ready' : '○ Download a model')
                          : (auth.authenticated ? '● Connected' : auth.installed ? '○ Not logged in' : '○ Not installed')}
                      </span>
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
          {provider !== 'local' && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-iron-text">Model</label>
              <p className="text-xs text-iron-text-muted">
                {provider === 'copilot'
                  ? 'Select which model GitHub Copilot should use'
                  : 'Select which Claude model to use'}
              </p>
              <div className="space-y-1 mt-2">
                {providerModels.map((m) => (
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
                        {m.free && (
                          <span className="ml-1.5 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-iron-success/15 text-iron-success border border-iron-success/20">Free</span>
                        )}
                      </div>
                      {model === m.id && <CheckCircle className="w-3.5 h-3.5 text-iron-accent-light" />}
                    </div>
                    <span className="block text-[10px] text-iron-text-muted mt-0.5">{m.description}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

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
                      AI Assist uses your own CLI tools — <strong className="text-iron-text">GitHub Copilot CLI</strong> (<code className="text-[10px] bg-iron-surface-active px-1 py-0.5 rounded">gh copilot</code>) or <strong className="text-iron-text">Claude Code CLI</strong> (<code className="text-[10px] bg-iron-surface-active px-1 py-0.5 rounded">claude</code>).
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

function SpeechSettings() {
  const [autoReadback, setAutoReadback] = useState(false);
  const [voice, setVoice] = useState('af_heart');
  const [speed, setSpeed] = useState(1.0);
  const [voices, setVoices] = useState<any[]>([]);
  const [previewPlaying, setPreviewPlaying] = useState<string | null>(null);
  const [modelReady, setModelReady] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);

  useEffect(() => {
    loadTtsSettings();
    const cleanup = window.ironmic.onModelDownloadProgress((prog: any) => {
      if (prog.model === 'tts-model' || prog.model === 'tts-voices') {
        if (prog.model === 'tts-model') setDownloadProgress(prog.percent);
        if (prog.status === 'complete' && prog.model === 'tts-model') {
          setDownloading(false);
          setModelReady(true);
        }
        if (prog.status === 'error') { setDownloading(false); setDownloadError(prog.errorDetail || 'TTS model download failed'); setShowImport(true); }
      }
    });
    return cleanup;
  }, []);

  async function loadTtsSettings() {
    const api = window.ironmic;
    const [rb, v, s, voicesJson, ready] = await Promise.all([
      api.getSetting('tts_auto_readback'),
      api.getSetting('tts_voice'),
      api.getSetting('tts_speed'),
      api.ttsAvailableVoices(),
      api.isTtsModelReady(),
    ]);
    setAutoReadback(rb !== 'false');
    setModelReady(ready);
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
      <SectionHeader icon={Volume2} title="Text-to-Speech" description="Voice engine, playback speed, and read-back" />

      <Card variant={modelReady ? 'default' : 'highlighted'} padding="md">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-iron-text">Kokoro 82M</p>
            <p className="text-xs text-iron-text-muted mt-0.5">
              {modelReady ? 'Local TTS engine ready (~165 MB)' : 'Download the voice model (~165 MB)'}
            </p>
          </div>
          {modelReady ? (
            <StatusBadge status="success" label="Ready" />
          ) : downloading ? (
            <span className="text-xs text-iron-text-muted">{downloadProgress}%</span>
          ) : (
            <button onClick={handleDownloadModel} className="px-3 py-1.5 bg-gradient-accent text-white text-xs font-medium rounded-lg hover:shadow-glow transition-all">
              Download
            </button>
          )}
        </div>
        {downloading && (
          <div className="mt-2 w-full h-1 bg-iron-surface-active rounded-full overflow-hidden">
            <div className="h-full bg-gradient-accent rounded-full transition-all duration-300" style={{ width: `${downloadProgress}%` }} />
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

  useEffect(() => {
    loadSecuritySettings();
  }, []);

  async function loadSecuritySettings() {
    const api = window.ironmic;
    const [clip, timeout, exit, aiConfirm, privacy, pEnabled, pUrl] = await Promise.all([
      api.getSetting('security_clipboard_auto_clear'),
      api.getSetting('security_session_timeout'),
      api.getSetting('security_clear_on_exit'),
      api.getSetting('security_ai_data_confirm'),
      api.getSetting('security_privacy_mode'),
      api.getSetting('proxy_enabled'),
      api.getSetting('proxy_url'),
    ]);
    if (clip) setClipboardAutoClear(clip);
    if (timeout) setSessionTimeout(timeout);
    setClearOnExit(exit === 'true');
    setAiDataConfirm(aiConfirm === 'true');
    setPrivacyMode(privacy === 'true');
    setProxyEnabled(pEnabled === 'true');
    if (pUrl) setProxyUrl(pUrl);
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
    </>
  );
}

// ═══════════════════════════════════════════
// Voice AI (ML Features)
// ═══════════════════════════════════════════

function VoiceAISettings() {
  const { getSetting, setSetting } = useSettingsStore();
  const [vadEnabled, setVadEnabled] = useState(true);
  const [vadSensitivity, setVadSensitivity] = useState(0.5);
  const [turnDetectionMode, setTurnDetectionMode] = useState('push-to-talk');
  const [turnTimeout, setTurnTimeout] = useState(3000);
  const [voiceRoutingEnabled, setVoiceRoutingEnabled] = useState(false);
  const [meetingModeEnabled, setMeetingModeEnabled] = useState(false);
  const [intentEnabled, setIntentEnabled] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [notificationThreshold, setNotificationThreshold] = useState(0.5);
  const [workflowsEnabled, setWorkflowsEnabled] = useState(false);
  const [workflowConfidence, setWorkflowConfidence] = useState(0.7);
  const [semanticSearchEnabled, setSemanticSearchEnabled] = useState(false);

  useEffect(() => {
    (async () => {
      const ironmic = (window as any).ironmic;
      if (!ironmic) return;
      const val = (key: string, fallback: string) =>
        ironmic.getSetting(key).then((v: string | null) => v ?? fallback);

      setVadEnabled((await val('vad_enabled', 'true')) === 'true');
      setVadSensitivity(parseFloat(await val('vad_sensitivity', '0.5')));
      setTurnDetectionMode(await val('turn_detection_mode', 'push-to-talk'));
      setTurnTimeout(parseInt(await val('turn_detection_timeout_ms', '3000'), 10));
      setVoiceRoutingEnabled((await val('voice_routing_enabled', 'false')) === 'true');
      setMeetingModeEnabled((await val('meeting_mode_enabled', 'false')) === 'true');
      setIntentEnabled((await val('intent_classification_enabled', 'false')) === 'true');
      setNotificationsEnabled((await val('ml_notifications_enabled', 'false')) === 'true');
      setNotificationThreshold(parseFloat(await val('ml_notifications_threshold', '0.5')));
      setWorkflowsEnabled((await val('ml_workflows_enabled', 'false')) === 'true');
      setWorkflowConfidence(parseFloat(await val('ml_workflows_confidence', '0.7')));
      setSemanticSearchEnabled((await val('ml_semantic_search_enabled', 'false')) === 'true');
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

          {/* VAD */}
          <SettingRow
            icon={Mic}
            title="Voice Activity Detection"
            description="Filter silence and noise before transcription for faster processing"
            control={
              <Toggle
                checked={vadEnabled}
                onChange={(v) => { setVadEnabled(v); update('vad_enabled', String(v)); }}
              />
            }
          />
          {vadEnabled && (
            <div className="ml-10 space-y-2">
              <label className="text-xs text-iron-text-secondary">Sensitivity: {vadSensitivity.toFixed(1)}</label>
              <input
                type="range" min="0" max="1" step="0.1"
                value={vadSensitivity}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setVadSensitivity(v);
                  update('vad_sensitivity', String(v));
                }}
                className="w-full accent-iron-accent"
              />
              <div className="flex justify-between text-[10px] text-iron-text-muted">
                <span>Less sensitive</span>
                <span>More sensitive</span>
              </div>
            </div>
          )}

          <div className="border-t border-iron-border" />

          {/* Turn Detection */}
          <SettingRow
            icon={Volume2}
            title="Turn Detection Mode"
            description="How IronMic detects when you're done speaking"
            control={
              <select
                value={turnDetectionMode}
                onChange={(e) => {
                  setTurnDetectionMode(e.target.value);
                  update('turn_detection_mode', e.target.value);
                }}
                className="text-xs bg-iron-surface border border-iron-border rounded px-2 py-1 text-iron-text"
              >
                <option value="push-to-talk">Push to Talk</option>
                <option value="auto-detect">Auto Detect</option>
                <option value="always-listening">Always Listening</option>
              </select>
            }
          />
          {turnDetectionMode !== 'push-to-talk' && (
            <div className="ml-10 space-y-2">
              <label className="text-xs text-iron-text-secondary">Silence timeout: {(turnTimeout / 1000).toFixed(1)}s</label>
              <input
                type="range" min="1000" max="10000" step="500"
                value={turnTimeout}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  setTurnTimeout(v);
                  update('turn_detection_timeout_ms', String(v));
                }}
                className="w-full accent-iron-accent"
              />
            </div>
          )}
          {turnDetectionMode === 'always-listening' && (
            <div className="ml-10 p-2 bg-yellow-500/10 rounded text-xs text-yellow-400 flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              Microphone will stay active. A red indicator will be shown at all times.
            </div>
          )}

          <div className="border-t border-iron-border" />

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

function SectionHeader({ icon: Icon, title, description }: { icon: typeof Settings; title: string; description: string }) {
  return (
    <div className="flex items-center gap-2.5 mb-2">
      <div className="w-8 h-8 rounded-lg bg-iron-accent/10 flex items-center justify-center">
        <Icon className="w-4 h-4 text-iron-accent-light" />
      </div>
      <div>
        <h2 className="text-lg font-semibold text-iron-text">{title}</h2>
        <p className="text-xs text-iron-text-muted">{description}</p>
      </div>
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
