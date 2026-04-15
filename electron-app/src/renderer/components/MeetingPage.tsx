import { useState, useEffect } from 'react';
import { Mic, MicOff, Plus, Users, Clock, LayoutTemplate, Trash2 } from 'lucide-react';
import { Card, Badge, Button } from './ui';
import { MeetingSessionCard } from './MeetingSessionCard';
import { MeetingTemplateEditor } from './MeetingTemplateEditor';
import { useMeetingStore } from '../stores/useMeetingStore';
import { meetingDetector, type MeetingState, type MeetingResult } from '../services/tfjs/MeetingDetector';
import type { MeetingTemplate } from '../services/tfjs/MeetingTemplateEngine';

export function MeetingPage() {
  const { templates, sessions, activeResult, loadTemplates, loadSessions, createTemplate, deleteTemplate, deleteSession, setActiveResult, detectedApp, setDetectedApp } = useMeetingStore();
  const [meetingState, setMeetingState] = useState<MeetingState>('idle');
  const [selectedTemplate, setSelectedTemplate] = useState<MeetingTemplate | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [durationMs, setDurationMs] = useState(0);

  useEffect(() => {
    loadTemplates();
    loadSessions();

    // Listen for meeting state changes
    const unsub = meetingDetector.onStateChange((state) => {
      setMeetingState(state);
      if (state === 'idle') {
        setDurationMs(0);
      }
    });

    // Listen for meeting app detection events
    const handleDetection = (_event: any, data: any) => {
      setDetectedApp(data?.app || null);
    };
    window.ironmic?.onMeetingAppDetected?.(handleDetection);

    return () => { unsub(); };
  }, []);

  // Live duration counter
  useEffect(() => {
    if (meetingState !== 'listening') return;
    const interval = setInterval(() => {
      setDurationMs(meetingDetector.getDurationMs());
    }, 1000);
    return () => clearInterval(interval);
  }, [meetingState]);

  const handleStart = async () => {
    try {
      await meetingDetector.start(selectedTemplate || undefined, detectedApp || undefined);
      setDetectedApp(null);
    } catch (err) {
      console.error('Failed to start meeting:', err);
    }
  };

  const handleStop = async () => {
    try {
      const result = await meetingDetector.stop();
      setActiveResult(result);
      loadSessions();
    } catch (err) {
      console.error('Failed to stop meeting:', err);
    }
  };

  const formatDuration = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  };

  const handleSaveTemplate = async (name: string, meetingType: string, sections: string[], llmPrompt: string) => {
    await createTemplate(name, meetingType, sections, llmPrompt);
    setShowEditor(false);
  };

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-iron-text">Meetings</h2>
      </div>

      {/* Detection banner */}
      {detectedApp && meetingState === 'idle' && (
        <Card variant="highlighted" padding="md" className="border-iron-accent/20 bg-iron-accent/5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-iron-accent/15 flex items-center justify-center">
                <Users className="w-4 h-4 text-iron-accent-light" />
              </div>
              <div>
                <p className="text-sm font-medium text-iron-text">
                  {detectedApp.charAt(0).toUpperCase() + detectedApp.slice(1)} detected
                </p>
                <p className="text-[11px] text-iron-text-muted">Start meeting mode to capture notes?</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setDetectedApp(null)}
                className="px-2.5 py-1.5 text-xs text-iron-text-muted rounded-lg border border-iron-border hover:bg-iron-surface-hover transition-colors"
              >
                Dismiss
              </button>
              <Button size="sm" onClick={handleStart}>
                Start
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Active meeting panel */}
      {meetingState !== 'idle' && (
        <Card variant="highlighted" padding="md" className="border-green-500/20 bg-green-500/5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                meetingState === 'listening' ? 'bg-green-500/15 animate-pulse' : 'bg-iron-surface-active'
              }`}>
                {meetingState === 'listening' ? (
                  <Mic className="w-5 h-5 text-green-400" />
                ) : (
                  <div className="w-4 h-4 border-2 border-iron-accent border-t-transparent rounded-full animate-spin" />
                )}
              </div>
              <div>
                <p className="text-sm font-medium text-iron-text">
                  {meetingState === 'listening' ? 'Meeting in progress' : 'Processing...'}
                </p>
                <div className="flex items-center gap-3 text-[11px] text-iron-text-muted">
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {formatDuration(durationMs)}
                  </span>
                  {selectedTemplate && (
                    <span className="flex items-center gap-1">
                      <LayoutTemplate className="w-3 h-3" />
                      {selectedTemplate.name}
                    </span>
                  )}
                </div>
              </div>
            </div>
            {meetingState === 'listening' && (
              <button
                onClick={handleStop}
                className="flex items-center gap-2 px-4 py-2 text-xs font-medium bg-red-500/15 text-red-400 rounded-lg border border-red-500/20 hover:bg-red-500/25 transition-colors"
              >
                <MicOff className="w-3.5 h-3.5" />
                End Meeting
              </button>
            )}
          </div>
        </Card>
      )}

      {/* Template picker (when idle) */}
      {meetingState === 'idle' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">Meeting Templates</p>
            <button
              onClick={() => setShowEditor(!showEditor)}
              className="flex items-center gap-1 text-[11px] text-iron-accent-light hover:underline"
            >
              <Plus className="w-3 h-3" />
              New Template
            </button>
          </div>

          {showEditor && (
            <MeetingTemplateEditor onSave={handleSaveTemplate} onCancel={() => setShowEditor(false)} />
          )}

          <div className="grid grid-cols-2 gap-2">
            {/* No template option */}
            <button
              onClick={() => setSelectedTemplate(null)}
              className={`text-left px-3 py-2.5 rounded-xl text-xs transition-all border ${
                !selectedTemplate
                  ? 'bg-iron-accent/10 text-iron-accent-light border-iron-accent/20'
                  : 'bg-iron-surface text-iron-text-muted border-iron-border hover:border-iron-border-hover'
              }`}
            >
              <span className="font-medium">Generic</span>
              <span className="block text-[10px] mt-0.5 opacity-70">Free-form summary</span>
            </button>

            {templates.map(t => (
              <button
                key={t.id}
                onClick={() => setSelectedTemplate(t as MeetingTemplate)}
                className={`text-left px-3 py-2.5 rounded-xl text-xs transition-all border ${
                  selectedTemplate?.id === t.id
                    ? 'bg-iron-accent/10 text-iron-accent-light border-iron-accent/20'
                    : 'bg-iron-surface text-iron-text-muted border-iron-border hover:border-iron-border-hover'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{t.name}</span>
                  {!t.is_builtin && (
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteTemplate(t.id); }}
                      className="p-0.5 text-iron-text-muted hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="w-2.5 h-2.5" />
                    </button>
                  )}
                </div>
                <span className="block text-[10px] mt-0.5 opacity-70">{t.meeting_type}</span>
              </button>
            ))}
          </div>

          {/* Start button */}
          <Button
            onClick={handleStart}
            className="w-full"
            icon={<Mic className="w-4 h-4" />}
          >
            Start Meeting
          </Button>
        </div>
      )}

      {/* Most recent result */}
      {activeResult && meetingState === 'idle' && (
        <Card variant="default" padding="md" className="border-green-500/10">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Badge variant="success">Complete</Badge>
              <span className="text-xs text-iron-text-muted">
                {formatDuration(activeResult.totalDurationMs)} · {activeResult.speakerCount} speaker(s)
              </span>
            </div>
            {activeResult.structuredOutput ? (
              activeResult.structuredOutput.sections.map(s => (
                <div key={s.key}>
                  <h4 className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">{s.title}</h4>
                  <p className="text-xs text-iron-text mt-0.5 whitespace-pre-wrap">{s.content}</p>
                </div>
              ))
            ) : activeResult.summary ? (
              <p className="text-xs text-iron-text whitespace-pre-wrap">{activeResult.summary}</p>
            ) : (
              <p className="text-xs text-iron-text-muted">No summary generated.</p>
            )}
          </div>
        </Card>
      )}

      {/* Meeting history */}
      {sessions.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">History</p>
          {sessions.map(s => (
            <MeetingSessionCard key={s.id} session={s} onDelete={deleteSession} />
          ))}
        </div>
      )}
    </div>
  );
}
