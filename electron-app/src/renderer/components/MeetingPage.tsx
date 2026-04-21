import { useState, useEffect, useCallback } from 'react';
import { Mic, MicOff, Plus, Users, Clock, LayoutTemplate, Trash2, Wifi, LogIn, User, Share2 } from 'lucide-react';
import { Card, Badge, Button } from './ui';
import { MeetingSessionCard } from './MeetingSessionCard';
import { MeetingTemplateEditor } from './MeetingTemplateEditor';
import { MeetingTranscriptPanel } from './MeetingTranscriptPanel';
import { MeetingNotesPanel } from './MeetingNotesPanel';
import { MeetingDetailPage } from './MeetingDetailPage';
import { MeetingSharedNotesViewer } from './MeetingSharedNotesViewer';
import type { CollabParticipant } from './MeetingCollaboratePanel';
import { AudioModeSelector } from './AudioModeSelector';
import { MeetingRoomPanel } from './MeetingRoomPanel';
import { useMeetingStore } from '../stores/useMeetingStore';
import { meetingDetector, type MeetingState, type MeetingResult } from '../services/tfjs/MeetingDetector';
import type { MeetingTemplate, StructuredMeetingOutput } from '../services/tfjs/MeetingTemplateEngine';
import type { TranscriptSegment } from './MeetingTranscriptPanel';

export function MeetingPage() {
  const {
    templates, sessions, activeResult, loadTemplates, loadSessions,
    createTemplate, deleteTemplate, deleteSession, setActiveResult,
    detectedApp, setDetectedApp,
    segments, addSegment, clearSegments,
    selectedAudioDevice, setSelectedAudioDevice,
    isGranolaRecording, setIsGranolaRecording,
    isGranolaStopping, setIsGranolaStopping,
    processingMeetings, markMeetingProcessing, unmarkMeetingProcessing,
    roomMode, setRoomMode, roomDisplayName, setRoomDisplayName,
    roomError, setRoomError, applyRoomState, applyParticipantUpdate, resetRoomState,
  } = useMeetingStore();

  // Join-room form state
  const [joinIp, setJoinIp] = useState('');
  const [joinPort, setJoinPort] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [joinInviteRaw, setJoinInviteRaw] = useState('');
  const [joining, setJoining] = useState(false);

  const [meetingState, setMeetingState] = useState<MeetingState>('idle');
  const [selectedTemplate, setSelectedTemplate] = useState<MeetingTemplate | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [durationMs, setDurationMs] = useState(0);
  const [detailSessionId, setDetailSessionId] = useState<string | null>(null);
  /** When set, open detail page with collab panel pre-opened (from Share icon) */
  const [collaborateSessionId, setCollaborateSessionId] = useState<string | null>(null);

  // ── Shared notes viewer (participant joining a host's notes collab) ──
  const [sharedNotesData, setSharedNotesData] = useState<{
    hostName: string | null;
    notes: string;
    participants: CollabParticipant[];
  } | null>(null);

  // Join shared notes form
  const [joinCollabInvite, setJoinCollabInvite] = useState('');
  const [joinCollabName, setJoinCollabName] = useState('');
  const [joinCollabError, setJoinCollabError] = useState<string | null>(null);
  const [joiningCollab, setJoiningCollab] = useState(false);

  // Granola mode — active session ID and current notes
  const [granolaSessionId, setGranolaSessionId] = useState<string | null>(null);
  const [granolaStructuredOutput, setGranolaStructuredOutput] = useState<StructuredMeetingOutput | null>(null);
  const [granolaPlainSummary, setGranolaPlainSummary] = useState<string | null>(null);
  const [granolaNotesGenerating, setGranolaNotesGenerating] = useState(false);

  // ── Granola mode: subscribe to live segment push events ──
  useEffect(() => {
    const unsubSegment = window.ironmic?.onMeetingSegmentReady?.((segment: TranscriptSegment) => {
      addSegment(segment);
    });
    const unsubState = window.ironmic?.onMeetingRecordingState?.((state: any) => {
      setIsGranolaRecording(state.status === 'recording');
      setIsGranolaStopping(state.status === 'stopping');
      if (state.status === 'idle') {
        setDurationMs(0);
      }
    });
    return () => {
      unsubSegment?.();
      unsubState?.();
    };
  }, []);

  // ── Room mode: subscribe to room state + participant events ──
  useEffect(() => {
    const unsubState = window.ironmic?.onMeetingRoomState?.((info: any) => {
      applyRoomState(info);
    });
    const unsubParticipant = window.ironmic?.onMeetingRoomParticipantUpdate?.((msg: any) => {
      applyParticipantUpdate(msg);
    });
    // Load persisted display name
    window.ironmic?.getSetting?.('meeting_display_name').then((v) => {
      if (v && typeof v === 'string') setRoomDisplayName(v);
    }).catch(() => {});
    return () => {
      unsubState?.();
      unsubParticipant?.();
    };
  }, []);

  // ── Load saved collab display name ──
  useEffect(() => {
    window.ironmic?.getSetting?.('meeting_collab_display_name')
      .then((v) => { if (v) setJoinCollabName(v); })
      .catch(() => {});
  }, []);

  // ── Join shared notes handler ──
  const parseCollabInvite = (raw: string): { ip: string; port: number; code: string } | null => {
    const parts = raw.trim().split(/[|\s]+/).filter(Boolean);
    if (parts.length < 2) return null;
    const [addr, code] = parts;
    const [ip, portStr] = addr.split(':');
    const port = Number(portStr);
    if (!ip || !Number.isFinite(port) || port <= 0 || !code) return null;
    return { ip, port, code: code.toUpperCase() };
  };

  const handleJoinSharedNotes = useCallback(async () => {
    const parsed = parseCollabInvite(joinCollabInvite);
    if (!parsed) {
      setJoinCollabError('Invalid invite string. Expected format: 192.168.x.x:PORT|CODE');
      return;
    }
    const displayName = joinCollabName.trim() || 'Viewer';
    setJoinCollabError(null);
    setJoiningCollab(true);
    try {
      // Persist display name
      window.ironmic?.setSetting?.('meeting_collab_display_name', displayName).catch(() => {});
      const result = await window.ironmic.meetingCollabJoin({
        hostIp: parsed.ip,
        hostPort: parsed.port,
        sessionCode: parsed.code,
        displayName,
      });
      const { info, notes } = result as any;
      setSharedNotesData({
        hostName: info?.hostName ?? null,
        notes: notes ?? '',
        participants: info?.participants ?? [],
      });
      setJoinCollabInvite('');
    } catch (err: any) {
      setJoinCollabError(err?.message ?? 'Could not connect to shared session');
    } finally {
      setJoiningCollab(false);
    }
  }, [joinCollabInvite, joinCollabName]);

  // ── Legacy ambient meeting detector + startup recovery ──
  useEffect(() => {
    loadTemplates();
    // Load sessions, then check for any stuck in 'generating' state and retry them
    loadSessions().then(() => {
      // Short delay so the sessions state has been set by loadSessions()
      setTimeout(() => {
        void recoverStuckSessions();
      }, 2000);
    });

    const unsub = meetingDetector.onStateChange((state) => {
      setMeetingState(state);
      if (state === 'idle') setDurationMs(0);
    });

    const handleDetection = (_event: any, data: any) => {
      setDetectedApp(data?.app || null);
    };
    window.ironmic?.onMeetingAppDetected?.(handleDetection);

    return () => { unsub(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live duration counter (Granola mode)
  useEffect(() => {
    if (!isGranolaRecording) return;
    const start = Date.now();
    const interval = setInterval(() => {
      setDurationMs(Date.now() - start);
    }, 1000);
    return () => clearInterval(interval);
  }, [isGranolaRecording]);

  // Live duration counter (legacy ambient mode)
  useEffect(() => {
    if (meetingState !== 'listening') return;
    const interval = setInterval(() => {
      setDurationMs(meetingDetector.getDurationMs());
    }, 1000);
    return () => clearInterval(interval);
  }, [meetingState]);

  const formatDuration = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  };

  // ── Granola mode start ──
  const handleGranolaStart = useCallback(async () => {
    // Defensive guard: if the previous recording is still wrapping up, the
    // backend will reject startRecording with "already active". Abort early
    // with a clear message so the renderer console doesn't show a cryptic
    // IPC error.
    if (isGranolaStopping || isGranolaRecording) {
      console.warn('[MeetingPage] Cannot start — previous recording still finalizing');
      return;
    }
    try {
      clearSegments();
      setGranolaStructuredOutput(null);
      setGranolaPlainSummary(null);
      setRoomError(null);

      // Create meeting session (with optional template)
      const sessionJson = await window.ironmic.meetingCreateWithTemplate(
        selectedTemplate?.id ?? null,
        detectedApp,
      );
      const session = JSON.parse(sessionJson);
      setGranolaSessionId(session.id);
      setDetectedApp(null);

      // Start the chunk recording loop via main process
      await window.ironmic.meetingStartRecording(
        session.id,
        selectedAudioDevice ?? null,
      );

      // If hosting, also spin up the LAN room server
      if (roomMode === 'host') {
        try {
          const info = await window.ironmic.meetingRoomHostStart(
            session.id,
            roomDisplayName || 'Host',
            selectedTemplate?.id ?? null,
          );
          applyRoomState(info);
        } catch (err: any) {
          console.error('[MeetingPage] Failed to start room server:', err);
          setRoomError(err?.message ?? 'Failed to start room');
        }
      }
    } catch (err) {
      console.error('[MeetingPage] Failed to start Granola recording:', err);
    }
  }, [selectedTemplate, detectedApp, selectedAudioDevice, roomMode, roomDisplayName, isGranolaStopping, isGranolaRecording]);

  // ── Join an existing room ──
  const parseInvite = (raw: string): { ip: string; port: number; code: string } | null => {
    // Accepts "ip:port|code" or "ip:port code" or whitespace-separated
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const sepMatch = trimmed.split(/[|\s]+/).filter(Boolean);
    if (sepMatch.length < 2) return null;
    const [addr, code] = sepMatch;
    const [ip, portStr] = addr.split(':');
    const port = Number(portStr);
    if (!ip || !Number.isFinite(port) || port <= 0 || !code) return null;
    return { ip, port, code: code.toUpperCase() };
  };

  const handleJoinRoom = useCallback(async () => {
    setRoomError(null);
    let ip = joinIp.trim();
    let port = Number(joinPort);
    let code = joinCode.trim().toUpperCase();
    const invite = parseInvite(joinInviteRaw);
    if (invite) {
      ip = invite.ip;
      port = invite.port;
      code = invite.code;
    }
    if (!ip || !port || !code) {
      setRoomError('Enter an invite string or all three fields (IP, port, code).');
      return;
    }
    if (!roomDisplayName || roomDisplayName.trim().length === 0) {
      setRoomError('Enter a display name so other participants can see who you are.');
      return;
    }
    setJoining(true);
    try {
      clearSegments();
      setGranolaStructuredOutput(null);
      setGranolaPlainSummary(null);
      const info = await window.ironmic.meetingRoomJoin({
        hostIp: ip,
        hostPort: port,
        roomCode: code,
        displayName: roomDisplayName,
        deviceName: selectedAudioDevice ?? null,
      });
      applyRoomState(info);
      // The client manages its own local session and recorder; mirror its id
      if (info?.sessionId) {
        setGranolaSessionId(info.sessionId);
      }
      // Reset form
      setJoinInviteRaw('');
      setJoinIp(''); setJoinPort(''); setJoinCode('');
    } catch (err: any) {
      console.error('[MeetingPage] Failed to join room:', err);
      setRoomError(err?.message ?? 'Failed to join room');
    } finally {
      setJoining(false);
    }
  }, [joinIp, joinPort, joinCode, joinInviteRaw, roomDisplayName, selectedAudioDevice]);

  // ── Granola mode stop ──
  // Returns the user to the idle meetings page immediately, then generates
  // notes asynchronously. The session card shows a "Processing notes…" badge
  // until generation finishes.
  const handleGranolaStop = useCallback(async () => {
    if (!granolaSessionId) return;
    const sessionId = granolaSessionId;
    // Capture duration before awaits — the state listener resets it when status=idle
    const durationSec = Math.round(durationMs / 1000);
    const templateSnapshot = selectedTemplate;

    // 1. Mark this meeting as processing IMMEDIATELY so when the UI flips back
    //    to the meetings list, the card already shows the "Processing…" badge
    //    instead of a blank gap. Also seed an optimistic structured_output so
    //    the card is rendered even before loadSessions() completes.
    markMeetingProcessing(sessionId);
    // Also flag the recorder as stopping right away (synchronously) so the
    // "Start Meeting" button disables immediately — we don't want to wait
    // for the backend 'stopping' state push, which can race with a fast click.
    setIsGranolaStopping(true);
    try {
      // Optimistic: ensure an entry exists in the sessions list right now.
      // The session was already created in startGranolaRecording, so just
      // refresh from DB. Don't await — let it happen in parallel.
      void loadSessions();
    } catch { /* ignore */ }

    // 2. Flip the UI back to the meetings page immediately so the user
    //    isn't staring at a blank/stuck view while we drain the buffer +
    //    run the LLM in the background.
    setGranolaSessionId(null);
    setGranolaStructuredOutput(null);
    setGranolaPlainSummary(null);
    setGranolaNotesGenerating(false);
    clearSegments();

    // Capture room mode before we reset state
    const roomModeSnapshot = roomMode;

    // 3. Background: do the actual stop + transcription + LLM. The user
    //    can keep interacting with the meetings list while this runs.
    void (async () => {
      try {
        // Tear down the LAN room first so participants get `meeting_ended`
        // before we start draining the audio buffer.
        if (roomModeSnapshot === 'host') {
          try { await window.ironmic.meetingRoomHostStop(); } catch (err) {
            console.warn('[MeetingPage] Failed to stop room server:', err);
          }
        } else if (roomModeSnapshot === 'participant') {
          try { await window.ironmic.meetingRoomLeave(); } catch (err) {
            console.warn('[MeetingPage] Failed to leave room:', err);
          }
        }
        resetRoomState();

        const result = await window.ironmic.meetingStopRecording();
        const { fullTranscript } = result as { fullTranscript: string };

        // Persist duration so the card shows the right "ended at" + length.
        try {
          await window.ironmic.meetingEnd(sessionId, 1, '', '', durationSec, '');
        } catch (err) {
          console.error('[MeetingPage] meetingEnd failed:', err);
        }
        await loadSessions();

        if (!fullTranscript || fullTranscript.trim().length === 0) {
          try {
            await window.ironmic.meetingSetStructuredOutput(sessionId, JSON.stringify({
              processingState: 'empty',
              sections: [],
              plainSummary: '',
            }));
          } catch (err) {
            console.error('[MeetingPage] Failed to mark session empty:', err);
          }
          await loadSessions();
          return;
        }

        await generateStructuredNotes(sessionId, fullTranscript, durationSec, templateSnapshot);

        // After notes are generated: if this was a hosted room, automatically open
        // the detail page with the Collaborate panel pre-opened. The host's
        // participants are already present on the LAN and are waiting to review/edit
        // the notes — this shortcut saves them having to navigate to the Share menu.
        if (roomModeSnapshot === 'host') {
          setCollaborateSessionId(sessionId);
        }
      } catch (err) {
        console.error('[MeetingPage] Background stop pipeline failed:', err);
      } finally {
        unmarkMeetingProcessing(sessionId);
        void loadSessions();
      }
    })();
  }, [granolaSessionId, durationMs, selectedTemplate]);

  const generateStructuredNotes = async (
    sessionId: string,
    transcript: string,
    durationSec: number,
    template: MeetingTemplate | null,
  ) => {
    // ── Step 0: Persist the transcript + processingState BEFORE calling the LLM.
    // This is the key durability fix: if the app crashes or is closed mid-generation,
    // the next startup can find this session, read the stored transcript, and retry.
    // We also notify the main process so it can warn on window close.
    try {
      await window.ironmic.meetingSetStructuredOutput(sessionId, JSON.stringify({
        processingState: 'generating',
        sections: [],
        plainSummary: '',
        // Store the raw transcript so recovery is possible on restart
        _recoveryTranscript: transcript,
        _recoveryTemplateId: template?.id ?? null,
        _recoveryDurationSec: durationSec,
      }));
    } catch (err) {
      console.error('[MeetingPage] Failed to persist recovery checkpoint:', err);
    }
    // Tell main process we're generating (for quit-confirmation dialog)
    window.ironmic?.notifyProcessingState?.(true);

    try {
      // Delegate to the shared summarizer so MeetingPage (initial generation) and
      // MeetingDetailPage (regenerate) share the same echo-guardrails + chunking.
      const { generateMeetingSummary } = await import('../services/meeting/SummaryGenerator');
      const structured = await generateMeetingSummary(transcript, template);

      // Flatten sections (or plainSummary) into the plain-text `summary` column so
      // list views still render a preview. Skip "None mentioned" placeholders.
      const summaryForColumn =
        structured.plainSummary ??
        structured.sections
          .filter(s => s.content && s.content.trim() !== 'None mentioned')
          .map(s => `## ${s.title}\n${s.content}`)
          .join('\n\n');

      try {
        await window.ironmic.meetingSetStructuredOutput(sessionId, JSON.stringify(structured));
      } catch (err) {
        console.error('[MeetingPage] Failed to save structured output:', err);
      }

      try {
        await window.ironmic.meetingEnd(sessionId, 1, summaryForColumn, '', durationSec, '');
      } catch (err) {
        console.error('[MeetingPage] Failed to finalize meeting:', err);
      }
    } finally {
      // Always release the processing-active flag so the quit guard doesn't
      // block the user forever if generation fails or throws.
      window.ironmic?.notifyProcessingState?.(false);
    }
  };

  /**
   * On mount: find any sessions whose structured_output.processingState is still
   * 'generating' — these were interrupted mid-generation by an app crash/close.
   * Re-trigger note generation using the transcript we saved as a recovery checkpoint.
   */
  const recoverStuckSessions = async () => {
    // Re-read the latest sessions directly from DB to avoid a stale closure
    let liveSessions: any[] = [];
    try {
      const raw = await window.ironmic.meetingList(50, 0);
      liveSessions = JSON.parse(raw);
    } catch { return; }

    for (const session of liveSessions) {
      let parsed: any = null;
      try {
        parsed = session.structured_output
          ? JSON.parse(session.structured_output)
          : null;
      } catch { /* malformed JSON, skip */ }

      if (!parsed || parsed.processingState !== 'generating') continue;

      const recoveryTranscript: string | undefined = parsed._recoveryTranscript;
      if (!recoveryTranscript || recoveryTranscript.trim().length < 20) {
        // No stored transcript → mark empty so the session doesn't stay stuck forever
        console.warn(`[MeetingPage] Recovery: no transcript for ${session.id}, marking empty`);
        try {
          await window.ironmic.meetingSetStructuredOutput(session.id, JSON.stringify({
            processingState: 'empty',
            sections: [],
            plainSummary: 'Note generation was interrupted before a transcript was saved.',
          }));
        } catch { /* ignore */ }
        continue;
      }

      const durationSec: number = parsed._recoveryDurationSec ?? 0;
      const templateId: string | null = parsed._recoveryTemplateId ?? null;

      console.info(`[MeetingPage] Recovery: retrying note generation for session ${session.id}`);
      markMeetingProcessing(session.id);

      // Resolve the template object if we stored a templateId
      let templateForRecovery: MeetingTemplate | null = null;
      if (templateId) {
        try {
          const raw = await window.ironmic.templateGet(templateId);
          templateForRecovery = raw ? JSON.parse(raw) : null;
        } catch { /* template gone, use none */ }
      }

      // Fire-and-forget the generation (same background pattern as handleGranolaStop)
      void (async () => {
        try {
          await generateStructuredNotes(session.id, recoveryTranscript, durationSec, templateForRecovery);
        } catch (err) {
          console.error(`[MeetingPage] Recovery generation failed for ${session.id}:`, err);
        } finally {
          unmarkMeetingProcessing(session.id);
          void loadSessions();
        }
      })();
    }
  };

  // ── Legacy ambient mode handlers ──
  const handleLegacyStart = async () => {
    try {
      await meetingDetector.start(selectedTemplate || undefined, detectedApp || undefined);
      setDetectedApp(null);
    } catch (err) {
      console.error('Failed to start meeting:', err);
    }
  };

  const handleLegacyStop = async () => {
    try {
      const result = await meetingDetector.stop();
      setActiveResult(result);
      loadSessions();
    } catch (err) {
      console.error('Failed to stop meeting:', err);
    }
  };

  const handleSaveTemplate = async (name: string, meetingType: string, sections: string[], llmPrompt: string) => {
    await createTemplate(name, meetingType, sections, llmPrompt);
    setShowEditor(false);
  };

  const isActive = isGranolaRecording || meetingState !== 'idle';

  // ── Shared notes viewer (participant) ──
  if (sharedNotesData) {
    return (
      <MeetingSharedNotesViewer
        hostName={sharedNotesData.hostName}
        initialNotes={sharedNotesData.notes}
        participants={sharedNotesData.participants}
        onLeave={() => setSharedNotesData(null)}
      />
    );
  }

  // ── Meeting detail view (opened from history, optionally with collab panel) ──
  if ((detailSessionId || collaborateSessionId) && !isActive) {
    const sid = collaborateSessionId ?? detailSessionId!;
    return (
      <MeetingDetailPage
        sessionId={sid}
        onBack={() => { setDetailSessionId(null); setCollaborateSessionId(null); }}
        onUpdated={loadSessions}
        openCollabOnMount={collaborateSessionId !== null}
      />
    );
  }

  // ── Two-panel layout when Granola recording is active ──
  if (isGranolaRecording) {
    return (
      <div className="flex flex-col h-full">
        {/* Header bar */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-iron-border bg-iron-surface shrink-0">
          <div className="flex items-center gap-3">
            <div className={`w-2.5 h-2.5 rounded-full ${isGranolaRecording ? 'bg-red-400 animate-pulse' : 'bg-amber-400 animate-pulse'}`} />
            <span className="text-sm font-medium text-iron-text">
              {isGranolaRecording ? 'Recording…' : 'Processing notes…'}
            </span>
            {isGranolaRecording && (
              <span className="text-xs text-iron-text-muted font-mono">{formatDuration(durationMs)}</span>
            )}
            {selectedTemplate && (
              <Badge variant="default" className="text-[10px]">
                <LayoutTemplate className="w-2.5 h-2.5 mr-1" />
                {selectedTemplate.name}
              </Badge>
            )}
          </div>
          {isGranolaRecording && (
            <button
              onClick={handleGranolaStop}
              className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium bg-red-500/15 text-red-400 rounded-lg border border-red-500/20 hover:bg-red-500/25 transition-colors"
            >
              <MicOff className="w-3.5 h-3.5" />
              {roomMode === 'participant' ? 'Leave Room' : 'End Meeting'}
            </button>
          )}
        </div>

        {/* Two-panel split */}
        <div className="flex flex-1 overflow-hidden divide-x divide-iron-border">
          {/* Panel A — AI notes (left ~55%) */}
          <div className="flex flex-col w-[55%] overflow-hidden">
            <div className="px-4 py-2 border-b border-iron-border shrink-0">
              <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">
                {roomMode === 'host' ? 'Room · Notes' : roomMode === 'participant' ? 'Room · Notes' : 'Notes'}
              </p>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {roomMode !== 'solo' && <MeetingRoomPanel />}
              <MeetingNotesPanel
                structuredOutput={granolaStructuredOutput}
                summary={granolaPlainSummary}
                isGenerating={granolaNotesGenerating}
              />
            </div>
          </div>

          {/* Panel B — Transcript (right ~45%) */}
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="px-4 py-2 border-b border-iron-border shrink-0">
              <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">Transcript</p>
            </div>
            <div className="flex-1 overflow-hidden px-4 py-3">
              <MeetingTranscriptPanel segments={segments} isLive={isGranolaRecording} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Default single-column layout (idle / legacy recording) ──
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-lg mx-auto space-y-6 px-4 py-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-iron-text">Meetings</h2>
      </div>

      {/* Detection banner */}
      {detectedApp && !isActive && (
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
              <Button size="sm" onClick={handleGranolaStart} disabled={isGranolaStopping || isGranolaRecording}>
                {isGranolaStopping ? 'Finishing…' : 'Start'}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Legacy ambient mode active panel */}
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
                </div>
              </div>
            </div>
            {meetingState === 'listening' && (
              <button
                onClick={handleLegacyStop}
                className="flex items-center gap-2 px-4 py-2 text-xs font-medium bg-red-500/15 text-red-400 rounded-lg border border-red-500/20 hover:bg-red-500/25 transition-colors"
              >
                <MicOff className="w-3.5 h-3.5" />
                End Meeting
              </button>
            )}
          </div>
        </Card>
      )}

      {/* Setup: template picker + audio device (when idle) */}
      {!isActive && (
        <div className="space-y-3">
          {/* Mode selector: Solo / Host a Room / Join a Room */}
          <div>
            <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider mb-2">Mode</p>
            <div className="grid grid-cols-3 gap-2">
              {[
                { key: 'solo', label: 'Solo', icon: <Mic className="w-3.5 h-3.5" /> },
                { key: 'host', label: 'Host Room', icon: <Wifi className="w-3.5 h-3.5" /> },
                { key: 'participant', label: 'Join Room', icon: <LogIn className="w-3.5 h-3.5" /> },
              ].map(opt => (
                <button
                  key={opt.key}
                  onClick={() => { setRoomMode(opt.key as any); setRoomError(null); }}
                  className={`flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg border text-xs transition-colors ${
                    roomMode === opt.key
                      ? 'bg-iron-accent/10 text-iron-accent-light border-iron-accent/20'
                      : 'bg-iron-surface text-iron-text-muted border-iron-border hover:border-iron-border-hover'
                  }`}
                >
                  {opt.icon}
                  <span className="font-medium">{opt.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Display name (only needed for room modes) */}
          {roomMode !== 'solo' && (
            <div>
              <label className="flex items-center gap-1.5 text-[11px] text-iron-text-muted uppercase tracking-wider mb-1">
                <User className="w-3 h-3" />
                Your display name
              </label>
              <input
                type="text"
                value={roomDisplayName}
                onChange={(e) => setRoomDisplayName(e.target.value)}
                placeholder="e.g. Alex"
                maxLength={64}
                className="w-full px-3 py-2 text-sm bg-iron-surface text-iron-text rounded-lg border border-iron-border focus:outline-none focus:border-iron-accent/40"
              />
            </div>
          )}

          {/* Join form: IP:Port + Room code, or paste invite */}
          {roomMode === 'participant' && (
            <div className="space-y-2 border border-iron-border rounded-xl p-3 bg-iron-surface/50">
              <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">Room invite</p>
              <input
                type="text"
                value={joinInviteRaw}
                onChange={(e) => setJoinInviteRaw(e.target.value)}
                placeholder="Paste invite: 192.168.1.12:54821|ABC234"
                className="w-full px-3 py-2 text-xs font-mono bg-iron-surface text-iron-text rounded-lg border border-iron-border focus:outline-none focus:border-iron-accent/40"
              />
              <p className="text-[10px] text-iron-text-muted text-center">— or enter manually —</p>
              <div className="grid grid-cols-3 gap-2">
                <input
                  type="text"
                  value={joinIp}
                  onChange={(e) => setJoinIp(e.target.value)}
                  placeholder="Host IP"
                  className="px-2 py-1.5 text-xs font-mono bg-iron-surface text-iron-text rounded-lg border border-iron-border focus:outline-none focus:border-iron-accent/40"
                />
                <input
                  type="text"
                  value={joinPort}
                  onChange={(e) => setJoinPort(e.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="Port"
                  className="px-2 py-1.5 text-xs font-mono bg-iron-surface text-iron-text rounded-lg border border-iron-border focus:outline-none focus:border-iron-accent/40"
                />
                <input
                  type="text"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                  placeholder="Code"
                  maxLength={6}
                  className="px-2 py-1.5 text-xs font-mono bg-iron-surface text-iron-text rounded-lg border border-iron-border focus:outline-none focus:border-iron-accent/40 tracking-widest"
                />
              </div>
              <Button
                onClick={handleJoinRoom}
                disabled={joining}
                className="w-full mt-1"
                icon={<LogIn className="w-4 h-4" />}
              >
                {joining ? 'Joining…' : 'Join Meeting'}
              </Button>
            </div>
          )}

          {/* Room error surface */}
          {roomError && (
            <div className="px-3 py-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg">
              {roomError}
            </div>
          )}

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

          {/* Audio device picker */}
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-iron-text-muted">Audio source</p>
            <AudioModeSelector
              selectedDevice={selectedAudioDevice}
              onDeviceChange={setSelectedAudioDevice}
            />
          </div>

          {/* Start button — only shown for solo + host modes; participant uses Join button */}
          {roomMode !== 'participant' && (
            <>
              <Button
                onClick={handleGranolaStart}
                className="w-full"
                icon={isGranolaStopping
                  ? <span className="w-4 h-4 rounded-full border-2 border-iron-accent-light/40 border-t-iron-accent-light animate-spin" />
                  : roomMode === 'host' ? <Wifi className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                disabled={
                  isGranolaStopping
                  || (roomMode === 'host' && (!roomDisplayName || roomDisplayName.trim().length === 0))
                }
              >
                {isGranolaStopping
                  ? 'Finishing previous meeting…'
                  : roomMode === 'host' ? 'Host Meeting Room' : 'Start Meeting'}
              </Button>
              {isGranolaStopping && (
                <p className="text-[10px] text-iron-text-muted text-center mt-1">
                  Transcribing the last few seconds and generating notes. You can start a new meeting once this finishes.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* Most recent result (legacy ambient mode) */}
      {activeResult && !isActive && (
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

      {/* Join Shared Notes section */}
      <div className="border border-iron-border/60 rounded-xl p-3 space-y-2 bg-iron-surface/50">
        <div className="flex items-center gap-2">
          <Share2 className="w-3.5 h-3.5 text-iron-text-muted" />
          <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">
            Join Shared Notes
          </p>
        </div>
        <p className="text-[10px] text-iron-text-muted">
          Paste an invite code from a colleague to view and edit their meeting notes.
        </p>
        <input
          type="text"
          value={joinCollabName}
          onChange={(e) => setJoinCollabName(e.target.value)}
          placeholder="Your display name"
          maxLength={64}
          className="w-full px-3 py-2 text-sm bg-iron-surface text-iron-text rounded-lg border border-iron-border focus:outline-none focus:border-iron-accent/40"
        />
        <div className="flex gap-2">
          <input
            type="text"
            value={joinCollabInvite}
            onChange={(e) => { setJoinCollabInvite(e.target.value); setJoinCollabError(null); }}
            onKeyDown={(e) => e.key === 'Enter' && handleJoinSharedNotes()}
            placeholder="192.168.x.x:PORT|CODE"
            className="flex-1 px-3 py-2 text-xs font-mono bg-iron-surface text-iron-text rounded-lg border border-iron-border focus:outline-none focus:border-iron-accent/40"
          />
          <button
            onClick={handleJoinSharedNotes}
            disabled={joiningCollab || !joinCollabInvite.trim()}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-iron-accent/10 text-iron-accent-light border border-iron-accent/20 rounded-lg hover:bg-iron-accent/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {joiningCollab
              ? <><span className="w-3 h-3 rounded-full border-2 border-iron-accent-light/50 border-t-iron-accent-light animate-spin" />Joining…</>
              : <><LogIn className="w-3 h-3" />Open Notes</>
            }
          </button>
        </div>
        {joinCollabError && (
          <p className="text-[10px] text-red-400">{joinCollabError}</p>
        )}
      </div>

      {/* Meeting history */}
      {sessions.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">History</p>
          {sessions.map(s => (
            <MeetingSessionCard
              key={s.id}
              session={s}
              onDelete={deleteSession}
              onOpen={() => setDetailSessionId(s.id)}
              onCollaborate={(id) => {
                // Open the detail page with the collaborate panel pre-opened
                setCollaborateSessionId(id);
              }}
            />
          ))}
        </div>
      )}
      </div>
    </div>
  );
}
