import { useState, useEffect, useCallback } from 'react';
import { useSettingsStore } from '../stores/useSettingsStore';
import { DictionaryManager } from './DictionaryManager';
import { ModelManager } from './ModelManager';
import { DataManager } from './DataManager';
import { HotkeyRecorder } from './HotkeyRecorder';
import { Toggle, Card } from './ui';
import {
  Settings, Bot, Volume2, Monitor, Sun, Moon, Shield, Keyboard,
  Cpu, Database, BookOpen, Lock, ClipboardCheck, Eye, EyeOff,
  Clock, AlertTriangle, CheckCircle, Info, Wifi, WifiOff, FileWarning,
  Trash2, HardDrive,
} from 'lucide-react';

type SettingsTab = 'general' | 'speech' | 'models' | 'data' | 'security';

const TABS: { id: SettingsTab; label: string; icon: typeof Settings }[] = [
  { id: 'general', label: 'General', icon: Settings },
  { id: 'speech', label: 'Speech', icon: Volume2 },
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
          {tab === 'models' && <ModelManager />}
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
  const { hotkey, llmCleanupEnabled, aiEnabled, theme, setHotkey, setLlmCleanup, setAiEnabled, setTheme } =
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

      <SettingRow
        icon={Bot}
        title="AI Assistant"
        description="Chat with AI via GitHub Copilot or Claude Code CLI"
        control={<Toggle checked={aiEnabled} onChange={setAiEnabled} />}
      />

      <DictionaryManager />
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

  useEffect(() => {
    loadTtsSettings();
    const cleanup = window.ironmic.onModelDownloadProgress((prog: any) => {
      if (prog.model === 'tts-model' || prog.model === 'tts-voices') {
        if (prog.model === 'tts-model') setDownloadProgress(prog.percent);
        if (prog.status === 'complete' && prog.model === 'tts-model') {
          setDownloading(false);
          setModelReady(true);
        }
        if (prog.status === 'error') setDownloading(false);
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
    try { await window.ironmic.downloadModel('tts'); }
    catch { setDownloading(false); }
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
      </Card>

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

  useEffect(() => {
    loadSecuritySettings();
  }, []);

  async function loadSecuritySettings() {
    const api = window.ironmic;
    const [clip, timeout, exit, aiConfirm, privacy] = await Promise.all([
      api.getSetting('security_clipboard_auto_clear'),
      api.getSetting('security_session_timeout'),
      api.getSetting('security_clear_on_exit'),
      api.getSetting('security_ai_data_confirm'),
      api.getSetting('security_privacy_mode'),
    ]);
    if (clip) setClipboardAutoClear(clip);
    if (timeout) setSessionTimeout(timeout);
    setClearOnExit(exit === 'true');
    setAiDataConfirm(aiConfirm === 'true');
    setPrivacyMode(privacy === 'true');
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
          <PostureItem icon={WifiOff} label="Network Isolation" detail="All outbound requests blocked. Only model downloads allowed on demand." status="strong" />
          <PostureItem icon={HardDrive} label="Audio Privacy" detail="Mic audio held in memory only. Buffers zeroed on drop. Never written to disk." status="strong" />
          <PostureItem icon={Lock} label="Context Isolation" detail="Renderer sandboxed from Node.js. Typed IPC bridge only." status="strong" />
          <PostureItem icon={FileWarning} label="Database Encryption" detail="SQLite database stored unencrypted on disk. Enable OS-level disk encryption (FileVault/BitLocker)." status="warning" />
          <PostureItem icon={ClipboardCheck} label="Clipboard" detail={clipboardAutoClear === 'off' ? 'Text remains in clipboard until overwritten. Enable auto-clear below.' : `Auto-cleared after ${clipboardAutoClear}`} status={clipboardAutoClear === 'off' ? 'warning' : 'strong'} />
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
