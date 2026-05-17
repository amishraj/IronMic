import { useState, useEffect, useCallback, useRef } from 'react';
import { Mic, MicOff, Plus, Users, Clock, LayoutTemplate, Trash2, Wifi, LogIn, User, Share2, PanelRightOpen, PanelRightClose, PhoneOff } from 'lucide-react';
import { Card, Badge, Button } from './ui';
import { MeetingSessionCard } from './MeetingSessionCard';
import { MeetingEngineGearButton } from './MeetingEngineGearButton';
import { MeetingTemplateEditor } from './MeetingTemplateEditor';
import { MeetingTranscriptPanel } from './MeetingTranscriptPanel';
import { MeetingNotesPanel } from './MeetingNotesPanel';
import { YourNotesPanel, type YourNotesPanelHandle } from './YourNotesPanel';
import { MeetingDetailPage } from './MeetingDetailPage';
import { AudioModeSelector } from './AudioModeSelector';
import { MeetingRoomPanel } from './MeetingRoomPanel';
import { InviteDetailsPanel } from './InviteDetailsPanel';
import { useMeetingStore } from '../stores/useMeetingStore';
import { meetingDetector, type MeetingState, type MeetingResult } from '../services/tfjs/MeetingDetector';
import type { MeetingTemplate, StructuredMeetingOutput } from '../services/tfjs/MeetingTemplateEngine';
import type { TranscriptSegment } from './MeetingTranscriptPanel';
import { upsertMeetingNoteEntry } from '../services/notebooks';
import { resolveMeetingTitle } from '../services/meetingTitle';
import { generateMeetingTitle } from '../services/meeting/SummaryGenerator';
import {
  applyMeetingEngine,
  restoreMeetingEngine,
} from '../services/meeting/meetingEngineLifecycle';
import { useDictationStore } from '../stores/useDictationStore';
import { useToastStore } from '../stores/useToastStore';

export function MeetingPage() {
  const {
    templates, sessions, activeResult, loadTemplates, loadSessions,
    createTemplate, deleteTemplate, deleteSession, setActiveResult,
    detectedApp, setDetectedApp,
    segments, addSegment, clearSegments,
    draftHypothesis, setDraftHypothesis,
    streamingMode, setStreamingMode,
    selectedAudioDevice, setSelectedAudioDevice,
    isGranolaRecording, setIsGranolaRecording,
    isGranolaStopping, setIsGranolaStopping,
    granolaSessionId, setGranolaSessionId,
    granolaRecordingStartedAt, setGranolaRecordingStartedAt,
    processingMeetings, markMeetingProcessing, unmarkMeetingProcessing,
    roomMode, setRoomMode, roomDisplayName, setRoomDisplayName,
    roomError, setRoomError, applyRoomState, applyParticipantUpdate, resetRoomState,
    isMicMuted, setIsMicMuted,
  } = useMeetingStore();

  // Join-room form state
  const [joinIp, setJoinIp] = useState('');
  const [joinPort, setJoinPort] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [joinInviteRaw, setJoinInviteRaw] = useState('');
  const [joining, setJoining] = useState(false);

  const [meetingState, setMeetingState] = useState<MeetingState>('idle');
  const [selectedTemplate, setSelectedTemplate] = useState<MeetingTemplate | null>(null);
  // Whether the user has explicitly clicked a template since this component
  // mounted. Once true, the default-template effect stops overriding their
  // pick — clicking a template button is a user choice that beats any
  // global default.
  const userOverrodeTemplateRef = useRef(false);
  // Declared early so the meetings-list UX state below (which references it
  // in openDetail / scroll-restore effect / etc.) can resolve at module
  // init time. Originally lived further down with the granola state.
  const [detailSessionId, setDetailSessionId] = useState<string | null>(null);

  // ── Meetings list UX state ──
  /** Scroll-position preservation across detail open → back. The list
   *  unmounts when detailSessionId is set, so we capture scrollTop before
   *  navigating in and restore it once the list remounts. */
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const savedScrollYRef = useRef<number>(0);

  /** Whether to show meetings that captured no audio (processingState
   *  'empty'). Persisted in localStorage so the user's choice survives
   *  reload. Default false — they're noise on a busy list. */
  const SHOW_EMPTY_KEY = 'ironmic-meetings-show-empty';
  const [showEmptyMeetings, setShowEmptyMeetings] = useState<boolean>(() => {
    try { return localStorage.getItem(SHOW_EMPTY_KEY) === 'true'; }
    catch { return false; }
  });
  const toggleShowEmpty = useCallback((next: boolean) => {
    setShowEmptyMeetings(next);
    try { localStorage.setItem(SHOW_EMPTY_KEY, String(next)); } catch { /* ignore */ }
  }, []);

  /** Multi-select state for bulk delete. Click a card's mic icon to enter
   *  selection mode; the icon becomes a checkbox and subsequent card
   *  clicks toggle selection instead of opening detail. The floating
   *  action bar at the bottom gives Delete + Cancel. */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectionMode = selectedIds.size > 0;
  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  /** Open a meeting's detail view, capturing the current scroll position
   *  first so the back-nav useLayoutEffect can restore it. Bypassed when
   *  selectionMode is on (in which case the card click toggles selection
   *  instead of navigating). */
  const openDetail = useCallback((id: string) => {
    if (listScrollRef.current) {
      savedScrollYRef.current = listScrollRef.current.scrollTop;
    }
    setDetailSessionId(id);
  }, []);

  /** Restore scroll position whenever we transition from "in detail view"
   *  back to the list. useLayoutEffect (not useEffect) so the scroll set
   *  happens BEFORE the browser paints — otherwise the user briefly sees
   *  the list scrolled to top. */
  useEffect(() => {
    if (detailSessionId !== null) return;
    const el = listScrollRef.current;
    if (!el) return;
    // setTimeout 0 lets layout settle first (sessions list re-renders may
    // run after this effect; restoring before the children mount would
    // clamp scrollTop to 0). One frame is enough on every machine I tested.
    const t = setTimeout(() => {
      if (listScrollRef.current) listScrollRef.current.scrollTop = savedScrollYRef.current;
    }, 0);
    return () => clearTimeout(t);
  }, [detailSessionId]);

  /** Bulk delete confirmed selected meetings. Uses the existing
   *  deleteSession action so each delete triggers the same downstream
   *  cleanup (transcript_segments cascade, notebook entry orphaning, etc.)
   *  as a single delete via the per-card trash button. */
  const deleteSelected = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const count = selectedIds.size;
    const ok = window.confirm(
      `Delete ${count} meeting${count === 1 ? '' : 's'}?\n\n` +
        `This will permanently remove the selected meetings, their transcripts, and notes. This cannot be undone.`,
    );
    if (!ok) return;
    for (const id of Array.from(selectedIds)) {
      try { await deleteSession(id); }
      catch (err) { console.warn(`[MeetingPage] bulk delete failed for ${id}:`, err); }
    }
    clearSelection();
  }, [selectedIds, clearSelection]);
  const [showEditor, setShowEditor] = useState(false);
  const [durationMs, setDurationMs] = useState(0);
  // (detailSessionId moved up above so the meetings-list UX hooks can
  //  reference it before it would otherwise be declared.)

  // Granola mode — current notes (session ID lives in Zustand to survive tab switches)
  const [granolaStructuredOutput, setGranolaStructuredOutput] = useState<StructuredMeetingOutput | null>(null);
  const [granolaPlainSummary, setGranolaPlainSummary] = useState<string | null>(null);
  const [granolaNotesGenerating, setGranolaNotesGenerating] = useState(false);
  // Live AI summary streamed from main-process LiveSummarizer (updates every few chunks).
  const [liveSummary, setLiveSummary] = useState<string>('');
  const [liveSummaryGeneratedAt, setLiveSummaryGeneratedAt] = useState<number | null>(null);
  /** True when the summarizer judged the transcript + user notes too thin
   *  to produce faithful bullets. We show a "waiting for more content"
   *  message instead of running the LLM and risking hallucinated filler. */
  const [liveSummaryInsufficient, setLiveSummaryInsufficient] = useState<boolean>(true);
  // User can collapse the transcript panel when they want to focus on the notes side.
  const [transcriptCollapsed, setTranscriptCollapsed] = useState(false);
  // Ref to the YourNotesPanel so handleGranolaStop can synchronously flush
  // any in-flight debounced save before stopMeetingRecording runs its final
  // summary pass. Without this, notes typed in the last <800ms would be lost.
  const yourNotesRef = useRef<YourNotesPanelHandle>(null);
  // Tracks the active session id for the onMeetingLiveSummary subscriber so it
  // can drop stale payloads from a previous meeting (e.g. a slow LLM finishing
  // after the user already stopped + started a new session).
  const granolaSessionIdRef = useRef<string | null>(null);
  // Welcome-time shared Your Notes html captured from meetingRoomJoin so the
  // participant's panel pre-fills before any subsequent notes_update arrives.
  // Cleared on leave/end.
  const [welcomeNotesHtml, setWelcomeNotesHtml] = useState<string | undefined>(undefined);

  // Live meeting title — editable by host, read-only on participant. Defaults
  // to the local "Meeting #N" placeholder until the host (or solo user)
  // provides one. Synced live via the room server's title_update broadcast.
  const [granolaTitle, setGranolaTitle] = useState<string>('');
  const [granolaSequence, setGranolaSequence] = useState<number | null>(null);
  // Debounce handle for committing title edits via IPC. 600ms to balance
  // responsiveness vs. WebSocket spam. Refers nothing across renders that
  // would cause a stale-closure issue.
  const titleCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Developer features escape hatch (Settings → Security & Privacy → Developer).
  // When false (default), Solo mode is hidden and an active Solo selection is
  // silently snapped to Host on mount. Source of truth is the SQLite setting.
  const [devFeaturesEnabled, setDevFeaturesEnabled] = useState(false);

  // Whether the host's invite-details panel is shown during a live host meeting.
  // Toggled by the in-toolbar Collaborate button. View-local; not persisted.
  const [showInviteDetails, setShowInviteDetails] = useState(true);

  // ── Granola mode: subscribe to live segment push events ──
  useEffect(() => {
    const unsubSegment = window.ironmic?.onMeetingSegmentReady?.((segment: TranscriptSegment) => {
      addSegment(segment);
    });
    const unsubDraft = window.ironmic?.onMeetingDraftReady?.((payload) => {
      setDraftHypothesis(payload?.hypothesis ?? '');
    });
    const unsubState = window.ironmic?.onMeetingRecordingState?.((state: any) => {
      setIsGranolaRecording(state.status === 'recording');
      setIsGranolaStopping(state.status === 'stopping');
      // Mirror the recorder's streamingMode so the empty-state copy and any
      // future UI affordances can branch on it. Defaults to false on idle.
      setStreamingMode(!!state.streamingMode && state.status === 'recording');
      // Mirror backend self-mute. Backend is source of truth — we never flip
      // isMicMuted optimistically; the renderer's toolbar button calls IPC
      // and waits for the recording-state event to update the store.
      setIsMicMuted(!!state.isMicMuted);
      if (state.status === 'recording') {
        // Keep Zustand store in sync with the backend on every push event.
        // This is the recovery path: if the component remounted (tab switch)
        // while recording was active, the next chunk-boundary push restores
        // granolaSessionId so the "End Meeting" button works again.
        if (state.sessionId) setGranolaSessionId(state.sessionId);
        if (state.startedAt) setGranolaRecordingStartedAt(state.startedAt);
      } else if (state.status === 'idle') {
        setDurationMs(0);
        setGranolaSessionId(null);
        setGranolaRecordingStartedAt(null);
        setDraftHypothesis('');
        setWelcomeNotesHtml(undefined);
      }
    });
    const unsubLive = window.ironmic?.onMeetingLiveSummary?.((payload: any) => {
      // Drop payloads that don't belong to THIS machine's active session.
      // For the host this is the host session id; for participants it's the
      // local mirror id (the room client overrides the broadcast payload's
      // sessionId before forwarding it to the renderer).
      if (!payload?.sessionId) return;
      if (granolaSessionIdRef.current && payload.sessionId !== granolaSessionIdRef.current) return;
      setLiveSummary(payload.summary || '');
      setLiveSummaryGeneratedAt(payload.generatedAt || Date.now());
      setLiveSummaryInsufficient(!!payload.insufficient);
    });
    return () => {
      unsubSegment?.();
      unsubDraft?.();
      unsubState?.();
      unsubLive?.();
    };
  }, []);

  // Reset live summary whenever a new session starts (idle→recording transition
  // already nulls granolaSessionId via the state handler above; watch for new id).
  useEffect(() => {
    if (!isGranolaRecording) {
      // Clear stale live summary when not actively recording.
      setLiveSummary('');
      setLiveSummaryGeneratedAt(null);
      setLiveSummaryInsufficient(true);
    }
  }, [isGranolaRecording]);

  // Keep the ref in sync so the onMeetingLiveSummary subscription (registered
  // once at mount) can filter by the latest active session without re-binding.
  useEffect(() => {
    granolaSessionIdRef.current = granolaSessionId;
  }, [granolaSessionId]);

  // When the active session id appears (recording starts, or component remounts
  // mid-meeting), hydrate the AI Notes panel from any running summary already
  // persisted to structured_output. The summarizer writes liveAiSummary on
  // every emit, so this catches cases where the renderer mounts after the
  // first few summary passes have already run on the main side.
  useEffect(() => {
    if (!granolaSessionId || !isGranolaRecording) return;
    let cancelled = false;
    void (async () => {
      try {
        const raw = await window.ironmic?.meetingGet?.(granolaSessionId);
        if (cancelled || !raw) return;
        const session = JSON.parse(raw);
        const structuredRaw = session?.structured_output;
        if (typeof structuredRaw !== 'string') return;
        const structured = JSON.parse(structuredRaw);
        const stored = structured?.liveAiSummary;
        const storedAt = structured?.liveAiSummaryAt;
        if (typeof stored === 'string' && stored.trim().length > 0) {
          // Only adopt the persisted summary if we don't already have a fresher
          // in-memory one (the subscriber may have already populated it).
          setLiveSummary((prev) => prev && prev.trim().length > 0 ? prev : stored);
          if (typeof storedAt === 'number') {
            setLiveSummaryGeneratedAt((prev) => prev ?? storedAt);
          }
          setLiveSummaryInsufficient(false);
        }
        // Hydrate title + sequence from persisted structured_output. Useful
        // on remount mid-meeting (tab switch) and on rejoin (reopened row
        // already carries the prior title/sequence by design).
        const storedTitle = structured?.title;
        if (typeof storedTitle === 'string') {
          setGranolaTitle((prev) => prev || storedTitle);
        }
        const storedSeq = structured?.sequence;
        if (typeof storedSeq === 'number') {
          setGranolaSequence((prev) => prev ?? storedSeq);
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [granolaSessionId, isGranolaRecording]);

  // Reset title state on idle so the next meeting starts clean.
  useEffect(() => {
    if (!isGranolaRecording) {
      setGranolaTitle('');
      setGranolaSequence(null);
      if (titleCommitTimerRef.current) {
        clearTimeout(titleCommitTimerRef.current);
        titleCommitTimerRef.current = null;
      }
    }
  }, [isGranolaRecording]);

  // ── Tray / notification quick action: auto-start a meeting ──
  // Listens for the event dispatched by Layout when the user clicks the
  // tray's "Quick Start Meeting" or the auto-detect meeting notification.
  useEffect(() => {
    const handler = () => {
      // Only auto-start from idle — don't double-start or interrupt an
      // active/finishing meeting.
      if (isGranolaRecording || isGranolaStopping) return;
      void handleGranolaStart();
    };
    window.addEventListener('ironmic:quick-action-meeting', handler);
    return () => window.removeEventListener('ironmic:quick-action-meeting', handler);
    // handleGranolaStart is stable across renders via useCallback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGranolaRecording, isGranolaStopping]);

  // ── Room mode: subscribe to room state + participant events ──
  useEffect(() => {
    const unsubState = window.ironmic?.onMeetingRoomState?.((info: any) => {
      applyRoomState(info);
      // Hydrate title from room state pushes — this picks up the host's
      // initial title at room-start, plus any title_update broadcasts
      // (participants on other machines see this too via the title_update
      // event below; the room-state push is the authoritative current state).
      if (typeof info?.title === 'string') {
        setGranolaTitle(info.title);
      }
    });
    const unsubParticipant = window.ironmic?.onMeetingRoomParticipantUpdate?.((msg: any) => {
      applyParticipantUpdate(msg);
    });
    // Live title sync (participant): host's debounced commits land here.
    const unsubTitle = window.ironmic?.onMeetingRoomTitleUpdate?.((payload) => {
      // Match against either the participant's local mirror id or the host's
      // session id so the right update wins regardless of which side we're
      // on. The host is also a recipient of its own broadcasts in the
      // current implementation? No — the server broadcasts to authenticated
      // clients only, so the host's own renderer doesn't get echoed back.
      // For the host, room-state push above handles the update.
      setGranolaTitle(payload?.title ?? '');
    });
    // Host-ended → renderer-driven finalize. The participant's local mirror
    // session is the one we finalize; the payload carries the host's
    // authoritative final summary/title to overwrite stale local state.
    const unsubHostEnded = window.ironmic?.onMeetingRoomHostEnded?.((payload) => {
      const localId = payload?.localSessionId;
      // Snapshot the live durationMs / template / roomMode at the moment the
      // event fires — the state-update flush below clears them.
      const durationSec = Math.round(durationMs / 1000);
      const templateSnapshot = selectedTemplate;
      const roomModeSnapshot = roomMode;

      if (!localId) return;
      // Only act if this matches the meeting we're currently in. A stray
      // event from a stale connection should be a no-op.
      if (granolaSessionIdRef.current && granolaSessionIdRef.current !== localId) return;

      // Mirror the user-driven stop: mark processing, flip UI, clear state.
      markMeetingProcessing(localId);
      setIsGranolaStopping(true);
      try { void loadSessions(); } catch { /* ignore */ }
      setGranolaSessionId(null);
      setGranolaRecordingStartedAt(null);
      setGranolaStructuredOutput(null);
      setGranolaPlainSummary(null);
      setGranolaNotesGenerating(false);
      clearSegments();

      void finalizeAndExitMeeting({
        sessionId: localId,
        durationSec,
        template: templateSnapshot,
        roomModeSnapshot,
        skipRoomTeardown: true,
        hostSummaryOverride: payload?.finalSummary ?? null,
        hostTitleOverride: payload?.finalTitle ?? null,
      });
    });
    // Load persisted display name
    window.ironmic?.getSetting?.('meeting_display_name').then((v) => {
      if (v && typeof v === 'string') setRoomDisplayName(v);
    }).catch(() => {});
    return () => {
      unsubState?.();
      unsubParticipant?.();
      unsubTitle?.();
      unsubHostEnded?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Reset invite-details visibility on each recording start ──
  // Default to "shown" for every new meeting; the user explicitly hides it
  // via the Collaborate button if they want it off-screen during a share.
  useEffect(() => {
    if (isGranolaRecording) setShowInviteDetails(true);
  }, [isGranolaRecording]);

  // ── Load dev_features_enabled and snap legacy Solo → Host when off ──
  // Runs on mount (i.e. every time the user navigates to the Meetings page),
  // so toggling the setting in another tab takes effect on next visit without
  // any cross-component event plumbing.
  useEffect(() => {
    window.ironmic?.getSetting?.('dev_features_enabled')
      .then((v) => {
        const enabled = v === 'true';
        setDevFeaturesEnabled(enabled);
        if (!enabled && useMeetingStore.getState().roomMode === 'solo') {
          setRoomMode('host');
        }
      })
      .catch(() => {});
  }, [setRoomMode]);

  // ── Resolve the user's `meeting_default_template` setting to an actual
  // template object once templates have loaded. Without this, every meeting
  // started without an explicit template click runs the no-template path
  // (plainSummarize → flat bullets), and the new "Auto" template seeded by
  // migration v10 never actually runs. The userOverrodeTemplateRef guard
  // ensures a click in the template picker is sticky for the session.
  useEffect(() => {
    if (userOverrodeTemplateRef.current) return;
    if (!templates || templates.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const id = await window.ironmic.getSetting('meeting_default_template');
        if (cancelled) return;
        if (!id) return;
        const match = templates.find((t: MeetingTemplate) => t.id === id);
        if (match) setSelectedTemplate(match);
      } catch { /* setting unavailable → keep null */ }
    })();
    return () => { cancelled = true; };
  }, [templates]);

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

  // Listen for cross-component requests to open a specific meeting detail
  // (fired by SearchPage when the user clicks a meeting search result).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const targetId = typeof detail === 'string'
        ? detail
        : detail && typeof detail === 'object' && typeof (detail as any).id === 'string'
        ? (detail as any).id
        : null;
      if (!targetId) return;
      setDetailSessionId(targetId);
    };
    window.addEventListener('ironmic:open-meeting', handler);
    return () => window.removeEventListener('ironmic:open-meeting', handler);
  }, []);

  // Live duration counter (Granola mode).
  // Uses granolaRecordingStartedAt from the store — not a fresh Date.now() — so
  // the timer shows the true elapsed time after a tab switch / component remount.
  useEffect(() => {
    if (!isGranolaRecording) return;
    const startedAt = granolaRecordingStartedAt ?? Date.now();
    // Update immediately so there's no 1-second blank on remount
    setDurationMs(Date.now() - startedAt);
    const interval = setInterval(() => {
      setDurationMs(Date.now() - startedAt);
    }, 1000);
    return () => clearInterval(interval);
  }, [isGranolaRecording, granolaRecordingStartedAt]);

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
    // Cross-feature guard: dictation and meeting recording both own the cpal
    // stream exclusively, so we can't have both running. Show a friendly
    // toast instead of letting the native layer throw "already recording".
    const dictationStatus = useDictationStore.getState().status;
    if (dictationStatus !== 'idle') {
      useToastStore.getState().show({
        type: 'info',
        message: 'Dictation is running — click Done on the Notes page before starting a meeting.',
        durationMs: 6000,
        action: {
          label: 'Go to Notes',
          onClick: () => window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'notes' })),
        },
      });
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
      setGranolaRecordingStartedAt(Date.now());
      setDetectedApp(null);

      // Assign a stable sequential number ("Meeting #N") as the default
      // title. Use indexed Rust aggregate over `structured_output.sequence`
      // — replaces the old `meetingList(9999, 0)` JSON scan that became
      // O(N) on slower laptops with many past meetings.
      try {
        let maxSeq = 0;
        try { maxSeq = await window.ironmic.meetingGetMaxSequence(); }
        catch { /* fall through to legacy fallback */ }
        let sequence: number;
        if (maxSeq > 0) {
          sequence = maxSeq + 1;
        } else {
          // First-run fallback: no prior sequence numbers exist. Pull a
          // total-count once (rare path) so pre-existing legacy meetings
          // get retroactive numbers without making this O(N) on every start.
          try {
            const listRaw = await window.ironmic.meetingList(9999, 0);
            const allSessions = JSON.parse(listRaw) || [];
            sequence = allSessions.length;
          } catch { sequence = 1; }
        }
        setGranolaSequence(sequence);
        setGranolaTitle('');
        await window.ironmic.meetingSetStructuredOutput(
          session.id,
          JSON.stringify({ sequence, processingState: 'recording' }),
        );
      } catch (err) {
        console.warn('[MeetingPage] Failed to assign meeting sequence number:', err);
      }

      // Swap to the meeting's preferred transcription engine (default
      // Whisper Large) BEFORE starting the recorder so the first chunk
      // already uses the meeting engine. applyMeetingEngine never throws —
      // any failure surfaces as a toast and we proceed on the prior
      // engine. The prior is captured in useMeetingStore for
      // restoreMeetingEngine() on meeting end.
      await applyMeetingEngine();

      // Start the chunk recording loop via main process. Pass the host's
      // display name so the recorder can seed both contextTerms (Whisper
      // bias + fuzzy correction) and the persisted participant roster.
      //
      // Rollback semantics: if meetingStartRecording throws AFTER we
      // already swapped the engine, restore the prior so dictation isn't
      // stuck on the meeting engine after a failed start. restoreMeetingEngine
      // never throws, so the original `err` is what gets re-thrown to the
      // outer catch.
      try {
        await window.ironmic.meetingStartRecording(
          session.id,
          selectedAudioDevice ?? null,
          undefined,
          roomDisplayName || null,
        );
      } catch (err) {
        await restoreMeetingEngine();
        throw err;
      }

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
      // Participant also starts a local recorder inside meetingRoomJoin, so
      // the meeting engine swap applies here too. The participant uses
      // their own machine's `meeting_transcription_engine` setting — the
      // host's choice is NOT synced over the room protocol.
      await applyMeetingEngine();
      let info: any;
      try {
        info = await window.ironmic.meetingRoomJoin({
          hostIp: ip,
          hostPort: port,
          roomCode: code,
          displayName: roomDisplayName,
          deviceName: selectedAudioDevice ?? null,
        });
      } catch (err) {
        await restoreMeetingEngine();
        throw err;
      }
      applyRoomState(info);
      // The client manages its own local session and recorder; mirror its id
      if (info?.sessionId) {
        setGranolaSessionId(info.sessionId);
        setGranolaRecordingStartedAt(Date.now());
      }
      // Pre-fill Your Notes with whatever the host already typed before we
      // joined, so the panel shows the shared state immediately rather than
      // waiting for the next notes_update broadcast.
      if (info && typeof info.welcomeNotesHtml === 'string') {
        setWelcomeNotesHtml(info.welcomeNotesHtml);
      } else {
        setWelcomeNotesHtml(undefined);
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
  /**
   * Shared finalize path used by:
   *   (a) the user clicking "End Meeting" / "Leave Room" — `skipRoomTeardown=false`
   *   (b) the host ending the meeting from another machine — participant
   *       receives `MEETING_ROOM_HOST_ENDED`, which calls this with
   *       `skipRoomTeardown=true` (transport already gone) plus the host's
   *       final summary/title to overwrite stale local state.
   *
   * Stop ordering matters: meetingStopRecording MUST complete before the
   * room teardown so the recorder's final segment is broadcast to every
   * participant before sockets close. Pre-fix, host stop tore down the room
   * first and participants lost the last sentence.
   */
  const finalizeAndExitMeeting = useCallback(async (opts: {
    sessionId: string;
    durationSec: number;
    template: MeetingTemplate | null;
    roomModeSnapshot: 'solo' | 'host' | 'participant';
    skipRoomTeardown: boolean;
    hostSummaryOverride?: string | null;
    hostTitleOverride?: string | null;
  }) => {
    const { sessionId, durationSec, template, roomModeSnapshot, skipRoomTeardown,
            hostSummaryOverride, hostTitleOverride } = opts;
    try {
      // 1. Stop recording FIRST. This drains the final chunk + flushes the
      //    LiveSummarizer; the resulting segment is emitted to the room
      //    server's onSegment subscription synchronously, BEFORE we tear
      //    down. If we tore down the room first, the final segment would
      //    never reach participants.
      const result = await window.ironmic.meetingStopRecording();
      const { fullTranscript, liveSummary, liveInsufficient } = result as {
        fullTranscript: string;
        liveSummary?: string;
        liveInsufficient?: boolean;
      };

      // 2. Host-only: explicitly broadcast the freshly-flushed final summary
      //    so participants see it BEFORE the meeting_ended packet arrives.
      //    meeting_ended also carries it as a durable fallback.
      if (roomModeSnapshot === 'host' && !skipRoomTeardown && liveSummary && liveSummary.trim().length > 0) {
        try { await window.ironmic.meetingRoomBroadcastFinalSummary(sessionId, liveSummary); }
        catch (err) { console.warn('[MeetingPage] Failed to broadcast final summary:', err); }
      }

      // 3. Tear down the room transport now that the wire has the final
      //    state. Host stop broadcasts `meeting_ended` (with finalSummary,
      //    finalTitle, finalSegmentCount) and closes sockets. Participant
      //    leave-transport closes the socket but preserves localSessionId
      //    on main so the renderer-owned finalize works.
      if (!skipRoomTeardown) {
        if (roomModeSnapshot === 'host') {
          try { await window.ironmic.meetingRoomHostStop(); } catch (err) {
            console.warn('[MeetingPage] Failed to stop room server:', err);
          }
        } else if (roomModeSnapshot === 'participant') {
          try { await window.ironmic.meetingRoomLeaveTransport(); } catch (err) {
            console.warn('[MeetingPage] Failed to leave room transport:', err);
          }
        }
      }
      resetRoomState();

      // 4. Persist meetingEnd. Host overrides win — when finalize is driven
      //    by MEETING_ROOM_HOST_ENDED, the participant's local
      //    meetingStopRecording().liveSummary may be stale or empty (their
      //    summarizer never ran), so prefer the host's summary if it's set.
      const summaryForEnd = hostSummaryOverride && hostSummaryOverride.trim().length > 0
        ? hostSummaryOverride
        : '';
      try {
        await window.ironmic.meetingEnd(sessionId, 1, summaryForEnd, '', durationSec, '');
      } catch (err) {
        console.error('[MeetingPage] meetingEnd failed:', err);
      }

      // 5. Lay down host overrides BEFORE the auto-file Notes upsert in the
      //    finally block reads structured_output. Title in particular: the
      //    auto-file path uses so.title to name the Notes entry, so it must
      //    land first, not after.
      if (hostTitleOverride || hostSummaryOverride) {
        try {
          const rawForOverride = await window.ironmic.meetingGet(sessionId);
          let merged: any = {};
          if (rawForOverride) {
            try { merged = JSON.parse(JSON.parse(rawForOverride)?.structured_output || '{}'); }
            catch { merged = {}; }
          }
          if (hostTitleOverride && hostTitleOverride.length > 0) {
            merged.title = hostTitleOverride;
            merged.titleSource = 'user';
          }
          if (hostSummaryOverride && hostSummaryOverride.trim().length > 0) {
            merged.plainSummary = hostSummaryOverride;
            merged.sections = [{ key: 'summary', title: 'Summary', content: hostSummaryOverride }];
            merged.processingState = 'done';
          }
          await window.ironmic.meetingSetStructuredOutput(sessionId, JSON.stringify(merged));
        } catch (err) {
          console.warn('[MeetingPage] Failed to write host overrides:', err);
        }
      }

      await loadSessions();

      // Decide on the finalize-summary path. If we already wrote host
      // overrides, the structured_output is good — skip the local LLM.
      const haveHostFinalState = !!(hostSummaryOverride && hostSummaryOverride.trim().length > 0);

      if (!haveHostFinalState) {
        if (!fullTranscript || fullTranscript.trim().length === 0) {
          await finalizeInsufficient(sessionId, 'empty');
        } else if (liveInsufficient && (!liveSummary || !liveSummary.trim())) {
          await finalizeInsufficient(sessionId, 'insufficient');
        } else {
          // Always run the structured pass through a template — never the
          // flat-bullets plainSummarize path. If `template` is null (rare:
          // first-launch race before the meeting_default_template effect
          // resolves, or a meeting started during template loading), fall
          // back to the Default builtin so the output is still structured.
          // The live summary is just the in-flight ticker; the final
          // summary is the template-driven structured one.
          const effectiveTemplate =
            template ?? templates.find((t: MeetingTemplate) => t.id === 'builtin-auto') ?? templates[0] ?? null;
          await generateStructuredNotes(sessionId, fullTranscript, durationSec, effectiveTemplate as MeetingTemplate | null);
        }
        await loadSessions();
      }
    } catch (err) {
      console.error('[MeetingPage] finalize pipeline failed:', err);
    } finally {
      // ── Guaranteed Notes-sidebar auto-file ──────────────────────────────
      // Runs after EVERY processing path. Re-reads from DB so the latest
      // persisted state (including host overrides above) is what gets filed.
      try {
        const rawFinal = await window.ironmic.meetingGet(sessionId);
        if (rawFinal) {
          const latestSession = JSON.parse(rawFinal);
          let so: any = {};
          try { so = JSON.parse(latestSession.structured_output || '{}'); } catch {}

          const plainText = (so.plainSummary || latestSession.summary || '').trim();

          // A4 invariant: `'failed'` carries SUMMARY_UNAVAILABLE_MESSAGE in
          // `plainSummary`, which would otherwise auto-file as a notebook
          // entry titled after the failure message. Skip the upsert and the
          // AI-title call entirely for failed meetings. (`'empty'` is also
          // excluded by the existing `plainText` truthy check, since
          // word-count-guarded entries return `plainSummary: ''`.)
          if (plainText && so.processingState !== 'generating' && so.processingState !== 'failed') {
            // If no title is set (or only an AI-generated one was), try to
            // produce a better one from the content. Never overwrite a
            // user-authored title (titleSource === 'user').
            if (!so.title || so.titleSource === 'ai') {
              const aiTitle = await generateMeetingTitle(plainText);
              if (aiTitle) {
                so.title = aiTitle;
                so.titleSource = 'ai';
              }
            }
            const title = resolveMeetingTitle(latestSession, so);

            // Pull the full transcript from the session record (the same
            // record we just re-read). `fullTranscript` from the outer
            // try block is out of scope here — finally has its own scope
            // and `let` declared inside try doesn't escape.
            const sessionTranscript: string =
              (typeof latestSession?.full_transcript === 'string' && latestSession.full_transcript.trim())
                ? latestSession.full_transcript
                : plainText;
            const entryId = await upsertMeetingNoteEntry({
              existingEntryId: so.notebookEntryId ?? null,
              sessionId,
              title,
              // Polished side: the markdown summary. upsertMeetingNoteEntry
              // runs convertMarkdown internally so the editor gets the rich
              // JSON projection and renders headings/bold/lists rather than
              // showing literal `## TL;DR` source.
              polishedMarkdown: plainText,
              // Raw side: the full meeting transcript. Falls back to the
              // markdown summary if for some reason the transcript isn't
              // available — better to have something than nothing on the
              // raw side.
              rawTranscript: sessionTranscript,
            });
            if (entryId !== so.notebookEntryId || so.title) {
              await window.ironmic.meetingSetStructuredOutput(
                sessionId,
                JSON.stringify({ ...so, notebookEntryId: entryId }),
              );
            }
          }
        }
      } catch (err) {
        console.warn('[MeetingPage] Auto-file to Notes sidebar failed:', err);
      }

      // Restore the dictation engine that was active before this meeting.
      // Lives in the finally so it runs even when an upstream step threw;
      // restoreMeetingEngine never throws, so it can't mask anything.
      await restoreMeetingEngine();

      unmarkMeetingProcessing(sessionId);
      setIsGranolaStopping(false);
      setIsGranolaRecording(false);

      // Tell main it can wipe its preserved client state now that finalize
      // is done. Only relevant in the host-ended path; the user-driven path
      // either teardown-stopped the host server (no client state to clear)
      // or invoked leave-transport (matching invoke needed).
      if (skipRoomTeardown) {
        try { await window.ironmic.meetingRoomParticipantFinalized(); }
        catch (err) { console.warn('[MeetingPage] participantFinalized failed:', err); }
      }
      void loadSessions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleGranolaStop = useCallback(async () => {
    if (!granolaSessionId) return;
    const sessionId = granolaSessionId;
    const durationSec = Math.round(durationMs / 1000);
    const templateSnapshot = selectedTemplate;
    const roomModeSnapshot = roomMode;

    try { await yourNotesRef.current?.flush(); }
    catch (err) { console.warn('[MeetingPage] YourNotes flush failed:', err); }

    markMeetingProcessing(sessionId);
    setIsGranolaStopping(true);
    try { void loadSessions(); } catch { /* ignore */ }

    // Flip UI back to meetings list immediately
    setGranolaSessionId(null);
    setGranolaRecordingStartedAt(null);
    setGranolaStructuredOutput(null);
    setGranolaPlainSummary(null);
    setGranolaNotesGenerating(false);
    clearSegments();

    // Background pipeline. The user can keep interacting with the list.
    void finalizeAndExitMeeting({
      sessionId,
      durationSec,
      template: templateSnapshot,
      roomModeSnapshot,
      skipRoomTeardown: false,
    });
  }, [granolaSessionId, durationMs, selectedTemplate, roomMode, finalizeAndExitMeeting]);

  /**
   * Mark a session as having insufficient content to summarize.
   * `reason` distinguishes "empty" (no speech captured at all) from
   * "insufficient" (some speech but not enough to summarize faithfully).
   * In both cases we preserve any userNotes and skip the LLM.
   */
  const finalizeInsufficient = async (
    sessionId: string,
    reason: 'empty' | 'insufficient',
  ) => {
    try {
      // Preserve existing userNotes when marking the session.
      let existing: any = {};
      try {
        const raw = await window.ironmic.meetingGet(sessionId);
        if (raw) {
          const session = JSON.parse(raw);
          if (session?.structured_output) {
            try { existing = JSON.parse(session.structured_output) || {}; }
            catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }

      const payload: any = {
        ...existing,
        processingState: reason,
        sections: [],
        plainSummary: '',
      };
      // Strip recovery keys (no longer needed).
      delete payload._recoveryTranscript;
      delete payload._recoveryTemplateId;
      delete payload._recoveryDurationSec;

      await window.ironmic.meetingSetStructuredOutput(sessionId, JSON.stringify(payload));
    } catch (err) {
      console.error('[MeetingPage] finalizeInsufficient failed:', err);
    }
  };

  /**
   * Persist the live AI summary as the final meeting record — no redundant
   * LLM pass on the full transcript. Preserves any userNotes that the user
   * saved via the Your Notes panel during the meeting.
   */
  const finalizeWithLiveSummary = async (
    sessionId: string,
    liveSummary: string,
    template: MeetingTemplate | null,
  ) => {
    try {
      // Read the current structured_output so we preserve userNotes + any
      // other keys (e.g. _recoveryTranscript) that might be there. Also
      // capture the session record itself so we can resolve the title (which
      // needs detected_app for the fallback chain).
      let existing: any = {};
      let liveSession: any = null;
      try {
        const raw = await window.ironmic.meetingGet(sessionId);
        if (raw) {
          liveSession = JSON.parse(raw);
          if (liveSession?.structured_output) {
            try { existing = JSON.parse(liveSession.structured_output) || {}; }
            catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }

      // Build the final record.
      //   Section 1: "AI Notes" — the live bullet summary (which already
      //              tries to integrate user notes at the LLM level).
      //   Section 2 (conditional): "Your Notes" — the raw user-authored
      //              notes rendered as plain text. This is a belt-and-braces
      //              guarantee: even if the LLM ignored the user notes in
      //              its output, they are still visible in the final record.
      const sectionTitle = template?.sections?.[0] || 'AI Notes';
      const sectionKey = (sectionTitle as string).toLowerCase().replace(/\s+/g, '_');

      const sections: Array<{ key: string; title: string; content: string }> = [
        { key: sectionKey, title: sectionTitle, content: liveSummary.trim() },
      ];

      // Append a "Your Notes" section if the user wrote anything. Strip HTML
      // tags for a clean plain-text rendering in the notes panel. The HTML
      // version is still preserved in existing.userNotes for the detail page.
      const userNotesHtml: string | undefined = existing?.userNotes;
      if (typeof userNotesHtml === 'string' && userNotesHtml.trim()) {
        const plain = userNotesHtml
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
          .replace(/<li[^>]*>/gi, '- ')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        if (plain) {
          sections.push({ key: 'your_notes', title: 'Your Notes', content: plain });
        }
      }

      // Even on the live-summary path (no template), run the markdown
      // pipeline so the bullets render with bold/code/links instead of
      // plaintext. Failure is non-fatal — falls back to text-only display.
      let liveHtmlContent: string | null = null;
      try {
        const projections = await (window as any).ironmic?.convertMarkdown?.(liveSummary.trim());
        if (projections?.html) liveHtmlContent = projections.html;
      } catch { /* ignore */ }

      const finalStructured = {
        ...existing,
        processingState: 'done',
        sections,
        plainSummary: liveSummary.trim(),
        // htmlContent populated from the live-bullets markdown so the
        // detail page + notes panel render formatting (bold names,
        // inline code refs, etc.) instead of flat text.
        ...(liveHtmlContent ? { htmlContent: liveHtmlContent } : {}),
        // Strip recovery keys — no longer needed
        _recoveryTranscript: undefined,
        _recoveryTemplateId: undefined,
        _recoveryDurationSec: undefined,
      };
      // Clean undefined keys so JSON.stringify doesn't leave them in.
      Object.keys(finalStructured).forEach(k => {
        if ((finalStructured as any)[k] === undefined) delete (finalStructured as any)[k];
      });

      // Try AI title from content if no user-authored title exists.
      const liveSummaryTrim = liveSummary.trim();
      if (
        liveSummaryTrim &&
        (!(finalStructured as any).title || (finalStructured as any).titleSource === 'ai')
      ) {
        const aiTitle = await generateMeetingTitle(liveSummaryTrim);
        if (aiTitle) {
          (finalStructured as any).title = aiTitle;
          (finalStructured as any).titleSource = 'ai';
        }
      }

      try {
        // Live-summary path: polished side is the bullet summary, raw side
        // is the full meeting transcript pulled from the session record.
        // Falls back to the summary if the transcript wasn't persisted
        // (older sessions, certain failure modes) — at least the polished
        // view stays correct.
        const liveTranscript: string =
          (typeof liveSession?.full_transcript === 'string' && liveSession.full_transcript.trim())
            ? liveSession.full_transcript
            : liveSummaryTrim;
        const entryId = await upsertMeetingNoteEntry({
          existingEntryId: (finalStructured as any).notebookEntryId ?? null,
          sessionId,
          title: resolveMeetingTitle(liveSession, finalStructured as any),
          polishedMarkdown: liveSummaryTrim,
          rawTranscript: liveTranscript,
        });
        (finalStructured as any).notebookEntryId = entryId;
      } catch (err) {
        console.warn('[MeetingPage] Live-summary notebook auto-file failed:', err);
      }

      await window.ironmic.meetingSetStructuredOutput(sessionId, JSON.stringify(finalStructured));
    } catch (err) {
      console.error('[MeetingPage] finalizeWithLiveSummary failed:', err);
    }
  };

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
      // Build the metadata context (date + attendees) from the session
      // record so the Default template can render accurate Date /
      // Attendees sections instead of guessing or omitting.
      const summaryContext = await buildSummaryContextForSession(sessionId);
      const structured = await generateMeetingSummary(transcript, template, summaryContext);

      // Flatten sections (or plainSummary) into the plain-text `summary` column so
      // list views still render a preview. Skip "None mentioned" placeholders.
      const summaryForColumn =
        structured.plainSummary ??
        structured.sections
          .filter(s => s.content && s.content.trim() !== 'None mentioned')
          .map(s => `## ${s.title}\n${s.content}`)
          .join('\n\n');

      // Auto-file into "Meeting Notes" notebook so this meeting is discoverable
      // alongside regular notes (and by the AI assistant across one corpus).
      // Upsert by notebookEntryId so regenerations don't stack duplicates.
      //
      // A4 invariant: skip auto-file entirely for `'failed'` summaries. The
      // SUMMARY_UNAVAILABLE_MESSAGE placeholder would otherwise create a
      // notebook entry whose body is "A meeting summary could not be
      // generated…" and whose title is AI-generated from that string. The
      // meeting still appears in history; the user retries via the detail
      // page's Regenerate button.
      try {
        if ((structured as any).processingState === 'failed') {
          throw new Error('SKIP_AUTOFILE_FAILED');
        }
        // Try AI-generated title from content if no user title is set.
        if (
          summaryForColumn.trim() &&
          (!(structured as any).title || (structured as any).titleSource === 'ai')
        ) {
          const aiTitle = await generateMeetingTitle(summaryForColumn);
          if (aiTitle) {
            (structured as any).title = aiTitle;
            (structured as any).titleSource = 'ai';
          }
        }

        // Need detected_app for the title fallback chain.
        let sessionForTitle: { detected_app?: string | null } | null = null;
        try {
          const raw = await window.ironmic.meetingGet(sessionId);
          if (raw) sessionForTitle = JSON.parse(raw);
        } catch { /* ignore */ }

        const existingNotebookEntryId = (structured as any).notebookEntryId ?? null;
        const entryId = await upsertMeetingNoteEntry({
          existingEntryId: existingNotebookEntryId,
          sessionId,
          title: resolveMeetingTitle(sessionForTitle, structured as any),
          // Polished side: structured markdown summary (rendered as rich
          // content in the editor via convertMarkdown). Raw side: the
          // verbatim transcript that was just summarized.
          polishedMarkdown: summaryForColumn,
          rawTranscript: transcript,
        });
        (structured as any).notebookEntryId = entryId;
      } catch (err: any) {
        // Skipped on purpose for `'failed'` summaries (see A4 guard above).
        // Log at debug level so it's distinguishable from real failures.
        if (err?.message === 'SKIP_AUTOFILE_FAILED') {
          console.debug('[MeetingPage] Skipped notebook auto-file for failed summary');
        } else {
          console.warn('[MeetingPage] Notebook auto-file failed (non-fatal):', err);
        }
      }

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

  // ── Meeting detail view (opened from history) ──
  if (detailSessionId && !isActive) {
    return (
      <MeetingDetailPage
        sessionId={detailSessionId}
        onBack={() => {
          // Closing the detail re-mounts the list. The useLayoutEffect
          // tied to detailSessionId restores the scroll position from
          // savedScrollYRef so the user lands on the same card they
          // opened, not at the top of the list.
          setDetailSessionId(null);
        }}
        onUpdated={loadSessions}
      />
    );
  }

  // ── Two-panel layout when Granola recording is active ──
  if (isGranolaRecording) {
    return (
      <div className="flex flex-col h-full">
        {/* Header bar */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-iron-border bg-iron-surface shrink-0">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${isGranolaRecording ? 'bg-red-400 animate-pulse' : 'bg-amber-400 animate-pulse'}`} />
            <span className="text-sm font-medium text-iron-text shrink-0">
              {isGranolaRecording ? 'Recording…' : 'Processing notes…'}
            </span>
            {isGranolaRecording && (
              <span className="text-xs text-iron-text-muted font-mono shrink-0">{formatDuration(durationMs)}</span>
            )}
            {/* Live meeting title — host & solo can edit, participant is
                read-only (input disabled and styled flat). Saves debounced
                via meetingSetTitle, which (host) broadcasts to participants
                AND (host or solo) persists to structured_output.title so the
                saved card uses this name without any post-meeting edit. */}
            {isGranolaRecording && granolaSessionId && (
              <input
                type="text"
                value={granolaTitle}
                disabled={roomMode === 'participant'}
                placeholder={granolaSequence != null ? `Meeting #${granolaSequence}` : 'Meeting'}
                aria-label={roomMode === 'participant' ? 'Meeting title (set by host)' : 'Meeting title'}
                title={roomMode === 'participant' ? 'Set by host' : 'Edit meeting title'}
                onChange={(e) => {
                  const next = e.target.value;
                  setGranolaTitle(next);
                  if (roomMode === 'participant') return; // disabled in UI; defense-in-depth
                  if (titleCommitTimerRef.current) clearTimeout(titleCommitTimerRef.current);
                  const sessionId = granolaSessionId;
                  if (!sessionId) return;
                  titleCommitTimerRef.current = setTimeout(() => {
                    titleCommitTimerRef.current = null;
                    void window.ironmic.meetingSetTitle(sessionId, next.trim().length > 0 ? next : null)
                      .catch((err: unknown) => console.warn('[MeetingPage] meetingSetTitle failed:', err));
                  }, 600);
                }}
                onBlur={() => {
                  // Flush any pending debounced save on blur so a quick
                  // type-then-click doesn't lose the last edit.
                  if (titleCommitTimerRef.current && roomMode !== 'participant' && granolaSessionId) {
                    clearTimeout(titleCommitTimerRef.current);
                    titleCommitTimerRef.current = null;
                    void window.ironmic.meetingSetTitle(granolaSessionId, granolaTitle.trim().length > 0 ? granolaTitle : null)
                      .catch((err: unknown) => console.warn('[MeetingPage] meetingSetTitle failed:', err));
                  }
                }}
                className={`flex-1 min-w-0 max-w-md px-2 py-1 text-sm rounded-md border transition-colors ${
                  roomMode === 'participant'
                    ? 'bg-transparent border-transparent text-iron-text-muted cursor-default'
                    : 'bg-iron-surface-hover border-iron-border text-iron-text focus:outline-none focus:ring-2 focus:ring-iron-accent/30 focus:border-iron-accent/40'
                }`}
              />
            )}
            {selectedTemplate && (
              <Badge variant="default" className="text-[10px] shrink-0">
                <LayoutTemplate className="w-2.5 h-2.5 mr-1" />
                {selectedTemplate.name}
              </Badge>
            )}
          </div>
          {isGranolaRecording && (
            // Toolbar — buttons collapse to icons-only below `lg` (1024px)
            // so the full toolbar fits comfortably alongside the title input
            // on narrow viewports. `hidden lg:inline` on the labels keeps
            // text on wide screens. `whitespace-nowrap` on the button itself
            // prevents the icon+label from wrapping mid-render when the
            // viewport is right at the breakpoint.
            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
              {/* Mic on/off — privacy boundary. When muted: no local STT, no
                  segment broadcast, no final-drain on stop. Backend is source
                  of truth; we only invoke the IPC and the state event flips
                  the store. */}
              <button
                onClick={async () => {
                  if (!granolaSessionId) return;
                  try {
                    await window.ironmic.meetingSetMicMuted(granolaSessionId, !isMicMuted);
                  } catch (err) {
                    console.warn('[MeetingPage] meetingSetMicMuted failed:', err);
                  }
                }}
                disabled={!granolaSessionId}
                className={`flex items-center gap-1.5 px-2 py-1.5 lg:px-2.5 text-xs rounded-lg border transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed ${
                  isMicMuted
                    ? 'bg-red-500/15 text-red-400 border-red-500/30 hover:bg-red-500/25'
                    : 'text-iron-text-muted border-iron-border hover:bg-iron-surface-hover'
                }`}
                title={isMicMuted ? 'Unmute microphone' : 'Mute microphone'}
                aria-label={isMicMuted ? 'Unmute microphone' : 'Mute microphone'}
              >
                {isMicMuted ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
                <span className="hidden lg:inline">{isMicMuted ? 'Mic off' : 'Mic on'}</span>
              </button>
              {/* Collaborate toggle — host only. Hides/shows the invite block
                  (IP/port/code) so it can be kept off-screen during a share. */}
              {roomMode === 'host' && (
                <button
                  onClick={() => setShowInviteDetails(v => !v)}
                  className={`flex items-center gap-1.5 px-2 py-1.5 lg:px-2.5 text-xs rounded-lg border transition-colors whitespace-nowrap ${
                    showInviteDetails
                      ? 'bg-iron-accent/15 text-iron-accent-light border-iron-accent/20'
                      : 'text-iron-text-muted border-iron-border hover:bg-iron-surface-hover'
                  }`}
                  title={showInviteDetails ? 'Hide invite details' : 'Show invite details'}
                  aria-label={showInviteDetails ? 'Hide invite details' : 'Show invite details'}
                >
                  <Share2 className="w-3.5 h-3.5" />
                  <span className="hidden lg:inline">Collaborate</span>
                </button>
              )}
              {/* Meeting engine gear — live-switch during recording. Selection
                  applies on the next 30 s chunk; meetingEngineLifecycle handles
                  readiness + DB rollback. */}
              <MeetingEngineGearButton isRecording={true} />
              <button
                onClick={handleGranolaStop}
                className="px-2 py-1.5 lg:px-3 text-xs font-medium bg-red-500/15 text-red-400 rounded-lg border border-red-500/20 hover:bg-red-500/25 transition-colors whitespace-nowrap"
                title={roomMode === 'participant' ? 'Leave Room' : 'End Meeting'}
                aria-label={roomMode === 'participant' ? 'Leave Room' : 'End Meeting'}
              >
                <PhoneOff className="w-3.5 h-3.5 lg:hidden inline" />
                <span className="hidden lg:inline">
                  {roomMode === 'participant' ? 'Leave Room' : 'End Meeting'}
                </span>
              </button>
            </div>
          )}
        </div>

        {/*
          Three-panel layout — responsive:
          ≥768px (md): AI Notes | Your Notes | Transcript  (three columns)
          < 768px:     AI Notes | Your Notes  (top, flex-row)
                       ─── Transcript strip ───          (bottom, 220px, collapsible)

          Transcript is collapsible via the button in its header. When collapsed
          it shrinks to a thin vertical rail on wide screens, or a title bar
          strip on narrow screens.
        */}
        <div className="flex flex-col flex-1 overflow-hidden md:flex-row md:divide-x md:divide-iron-border">

          {/* ── Primary area: AI Notes + Your Notes ── */}
          <div className="flex flex-1 min-h-0 overflow-hidden divide-x divide-iron-border">

            {/* Panel A — AI Notes */}
            <div className="flex flex-col flex-1 overflow-hidden min-w-0">
              <div className="px-4 py-2 border-b border-iron-border shrink-0 flex items-center justify-between">
                <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">
                  {roomMode === 'host' ? 'Room · AI Notes' : roomMode === 'participant' ? 'Room · AI Notes' : 'AI Notes'}
                </p>
                {isGranolaRecording && liveSummaryGeneratedAt && (
                  <span className="text-[10px] text-emerald-400 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Live
                  </span>
                )}
              </div>
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
                {roomMode === 'host' && showInviteDetails && <InviteDetailsPanel />}
                {roomMode !== 'solo' && <MeetingRoomPanel />}
                {isGranolaRecording ? (
                  <div className="bg-iron-surface border border-iron-border rounded-lg p-3">
                    {liveSummaryInsufficient || !liveSummary ? (
                      /* No LLM call has been made yet, OR the summarizer decided
                         the input is too thin to produce faithful bullets. We
                         deliberately do NOT show fabricated placeholder content. */
                      <div className="text-xs text-iron-text-muted italic leading-relaxed">
                        <div className="mb-1.5 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-iron-text-muted/60 animate-pulse" />
                          <span>Waiting for substantive content…</span>
                        </div>
                        <div className="text-iron-text-muted/80">
                          AI notes will appear once there's enough spoken content or typed notes to summarize faithfully. Keep talking, or type a note on the right →
                        </div>
                      </div>
                    ) : (
                      <div className="text-sm text-iron-text leading-relaxed whitespace-pre-wrap">
                        {liveSummary}
                      </div>
                    )}
                    {liveSummaryGeneratedAt && !liveSummaryInsufficient && liveSummary && (
                      <div className="mt-2 text-[10px] text-iron-text-muted">
                        Updated {new Date(liveSummaryGeneratedAt).toLocaleTimeString()}
                      </div>
                    )}
                  </div>
                ) : (
                  <MeetingNotesPanel
                    structuredOutput={granolaStructuredOutput}
                    summary={granolaPlainSummary}
                    isGenerating={granolaNotesGenerating}
                  />
                )}
              </div>
            </div>

            {/* Panel B — Your Notes (middle on wide) */}
            <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
              <div className="flex-1 overflow-hidden p-3">
                <YourNotesPanel
                  ref={yourNotesRef}
                  sessionId={granolaSessionId}
                  isActive={isGranolaRecording}
                  initialHtml={welcomeNotesHtml}
                />
              </div>
            </div>

          </div>{/* end primary row */}

          {/* Panel C — Transcript (rightmost on wide, bottom strip on narrow)
              Collapsible: when collapsed, shrinks to a thin bar with just the
              header + expand button. Uses shrink-0 so the primary area keeps
              its flexible share of the remaining space. */}
          <div
            className={[
              'flex flex-col shrink-0 border-t border-iron-border overflow-hidden',
              // Narrow viewport height
              transcriptCollapsed ? 'h-10' : 'h-[220px]',
              // Wide viewport: right column, full height, border via parent divide-x
              'md:border-t-0 md:h-auto',
              transcriptCollapsed
                ? 'md:w-10 md:min-w-[40px]'
                : 'md:w-[32%] md:min-w-[260px] md:max-w-[40%]',
            ].join(' ')}
          >
            {/* Collapsed rail on wide viewports: vertical "Transcript" label + expand button */}
            {transcriptCollapsed ? (
              <button
                onClick={() => setTranscriptCollapsed(false)}
                title="Show transcript"
                className="flex flex-row md:flex-col items-center justify-center gap-2 w-full h-full text-iron-text-muted hover:text-iron-accent-light hover:bg-iron-surface-hover transition-colors"
              >
                <PanelRightOpen className="w-4 h-4" />
                <span className="text-[11px] font-semibold uppercase tracking-wider md:[writing-mode:vertical-rl] md:rotate-180">
                  Transcript
                </span>
              </button>
            ) : (
              <>
                <div className="px-4 py-2 border-b border-iron-border shrink-0 flex items-center justify-between">
                  <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">
                    Transcript
                    {segments.length > 0 && (
                      <span className="normal-case font-normal text-iron-text-muted/70 ml-1.5">
                        · {segments.length}
                      </span>
                    )}
                  </p>
                  <button
                    onClick={() => setTranscriptCollapsed(true)}
                    title="Collapse transcript"
                    className="p-1 rounded text-iron-text-muted hover:text-iron-accent-light hover:bg-iron-surface-hover transition-colors"
                  >
                    <PanelRightClose className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex-1 overflow-hidden px-4 py-3">
                  <MeetingTranscriptPanel
                    segments={segments}
                    isLive={isGranolaRecording}
                    draftHypothesis={draftHypothesis}
                    streamingMode={streamingMode}
                  />
                </div>
              </>
            )}
          </div>

        </div>
      </div>
    );
  }

  // ── Default single-column layout (idle / legacy recording) ──
  return (
    <div className="h-full overflow-y-auto" ref={listScrollRef}>
      <div className="max-w-lg mx-auto space-y-6 px-4 py-6">
      {/* Page header — big branded title on the left, display-name editor
          on the right (it rarely changes, so an inline pill saves vertical
          space vs. a labeled input below). Hidden in Solo mode where the
          name isn't broadcast to anyone. */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-iron-accent/10 flex items-center justify-center">
            <Users className="w-5 h-5 text-iron-accent-light" />
          </div>
          <h2 className="text-2xl font-semibold text-iron-text tracking-tight">Meetings</h2>
        </div>
        {roomMode !== 'solo' && (
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-iron-border bg-iron-surface focus-within:border-iron-accent/40 transition-colors">
            <User className="w-3.5 h-3.5 text-iron-text-muted shrink-0" />
            <input
              type="text"
              value={roomDisplayName}
              onChange={(e) => setRoomDisplayName(e.target.value)}
              placeholder="Your name"
              maxLength={64}
              aria-label="Your display name"
              title="Your display name (shown to other participants)"
              className="bg-transparent text-sm text-iron-text placeholder:text-iron-text-muted focus:outline-none w-[140px]"
            />
          </div>
        )}
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
                className="px-4 py-2 text-xs font-medium bg-red-500/15 text-red-400 rounded-lg border border-red-500/20 hover:bg-red-500/25 transition-colors"
              >
                End Meeting
              </button>
            )}
          </div>
        </Card>
      )}

      {/* Setup: template picker + audio device (when idle) */}
      {!isActive && (
        <div className="space-y-3">
          {/* Mode selector — left-aligned compact pill segmented control.
              Track uses a neutral tint so the active pill (white/semi-white)
              pops clearly in both light and dark mode. */}
          <div>
            <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider mb-2">Mode</p>
            <div
              role="radiogroup"
              aria-label="Meeting mode"
              className="inline-flex items-center gap-0.5 p-0.5 rounded-full border border-iron-border bg-black/[0.06] dark:bg-white/[0.08]"
            >
              {[
                { key: 'host', label: 'Host', icon: <Wifi className="w-3.5 h-3.5" /> },
                { key: 'participant', label: 'Join', icon: <LogIn className="w-3.5 h-3.5" /> },
                ...(devFeaturesEnabled
                  ? [{ key: 'solo', label: 'Solo', icon: <Mic className="w-3.5 h-3.5" /> }]
                  : []),
              ].map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  role="radio"
                  aria-checked={roomMode === opt.key}
                  onClick={() => { setRoomMode(opt.key as any); setRoomError(null); }}
                  className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-medium transition-all select-none ${
                    roomMode === opt.key
                      ? 'bg-white dark:bg-white/20 text-iron-text dark:text-white shadow-sm'
                      : 'text-iron-text-muted hover:text-iron-text'
                  }`}
                >
                  {opt.icon}
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Join form: IP:Port + Room code, or paste invite */}
          {roomMode === 'participant' && (
            <div className="space-y-2 border border-iron-border rounded-xl p-3 bg-iron-surface/50 mt-1">
              <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">Room invite</p>
              <input
                type="text"
                value={joinInviteRaw}
                onChange={(e) => setJoinInviteRaw(e.target.value.toUpperCase())}
                placeholder="Paste invite: 192.168.1.12:54821|ABC234"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                className="w-full px-3 py-2 text-xs font-mono bg-iron-surface text-iron-text rounded-lg border border-iron-border focus:outline-none focus:border-iron-accent/40"
              />
              <p className="text-[10px] text-iron-text-muted text-center">— or enter manually —</p>
              <div className="grid grid-cols-3 gap-2">
                <input
                  type="text"
                  value={joinIp}
                  onChange={(e) => setJoinIp(e.target.value)}
                  placeholder="Host IP"
                  autoComplete="off"
                  spellCheck={false}
                  className="px-2 py-1.5 text-xs font-mono bg-iron-surface text-iron-text rounded-lg border border-iron-border focus:outline-none focus:border-iron-accent/40"
                />
                <input
                  type="text"
                  value={joinPort}
                  onChange={(e) => setJoinPort(e.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="Port"
                  autoComplete="off"
                  spellCheck={false}
                  className="px-2 py-1.5 text-xs font-mono bg-iron-surface text-iron-text rounded-lg border border-iron-border focus:outline-none focus:border-iron-accent/40"
                />
                <input
                  type="text"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                  placeholder="Code"
                  maxLength={6}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
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

          <div className="flex items-center justify-between mt-3">
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

          {/* No "Generic / no template" button — every meeting runs through
              a template so the output is always structured. The Default
              template (builtin-auto) is auto-selected on mount via the
              meeting_default_template setting effect. */}
          <div className="grid grid-cols-2 gap-2">
            {templates.map(t => (
              <button
                key={t.id}
                onClick={() => {
                  userOverrodeTemplateRef.current = true;
                  setSelectedTemplate(t as MeetingTemplate);
                }}
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

          {/* Meeting transcription engine picker (pre-recording).
              Persists `meeting_transcription_engine`; applyMeetingEngine
              picks it up when the user presses Start. Defaults to Whisper
              Large for accuracy — meetings process in 30 s+ chunks so
              latency doesn't matter. */}
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-iron-text-muted">Transcription engine</p>
            <MeetingEngineGearButton isRecording={false} />
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

      {/* Meeting history — grouped by date bucket (Today / Yesterday /
          This week / Last week / This month / Earlier) for at-a-glance
          orientation on long lists. groupSessionsByDate sorts each bucket
          newest-first internally and returns buckets in chronological
          order so the most recent group is at the top. */}
      {sessions.length > 0 && (() => {
        // Filter out empty meetings (processingState === 'empty') unless
        // the user has opted to show them. Done at MeetingPage level so
        // grouping reflects only what's actually rendered (buckets that
        // become empty after filtering disappear, no confusing headers).
        const filtered = showEmptyMeetings
          ? sessions
          : sessions.filter((s) => !isSessionEmpty(s));
        const hiddenCount = sessions.length - filtered.length;
        const grouped = groupSessionsByDate(filtered);
        return (
          <div className="space-y-3">
            {/* Empty-meeting filter — settings-style toggle. The label
                describes the SETTING ("Show empty meetings"), the switch
                state describes the VALUE (on = shown, off = hidden). This
                avoids the imperative-vs-status confusion of the prior
                segmented control while staying compact. When OFF, the
                hidden-count badge sits next to the label so users can see
                what they're missing. */}
            <div className="flex items-center justify-end">
              <button
                type="button"
                role="switch"
                aria-checked={showEmptyMeetings}
                onClick={() => toggleShowEmpty(!showEmptyMeetings)}
                title={showEmptyMeetings
                  ? 'Hide meetings with no audio captured'
                  : 'Show meetings with no audio captured'}
                className="flex items-center gap-2 group select-none"
              >
                <span className="text-[11px] text-iron-text-muted group-hover:text-iron-text transition-colors">
                  Show empty meetings
                </span>
                {!showEmptyMeetings && hiddenCount > 0 && (
                  <span className="px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-iron-accent/10 text-iron-accent-light">
                    {hiddenCount} hidden
                  </span>
                )}
                {/* iOS-style track + thumb. Tailwind-only — no extra CSS.
                    The track recolors on state; the thumb slides 14px
                    (track width 32px - thumb width 14px - 2px padding × 2). */}
                <span
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                    showEmptyMeetings ? 'bg-iron-accent' : 'bg-iron-border'
                  }`}
                  aria-hidden="true"
                >
                  <span
                    className={`inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform ${
                      showEmptyMeetings ? 'translate-x-3.5' : 'translate-x-0.5'
                    }`}
                  />
                </span>
              </button>
            </div>
            {grouped.length > 0 ? (
              <div className="space-y-5">
                {grouped.map(([label, group]) => (
                  <div key={label} className="space-y-2">
                    <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">{label}</p>
                    {group.map(s => (
                      <MeetingSessionCard
                        key={s.id}
                        session={s}
                        onDelete={deleteSession}
                        onOpen={openDetail}
                        selectionMode={selectionMode}
                        selected={selectedIds.has(s.id)}
                        onToggleSelect={toggleSelection}
                      />
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-iron-text-muted italic px-1 py-2">
                {hiddenCount > 0
                  ? `${hiddenCount} meeting${hiddenCount === 1 ? '' : 's'} with no audio hidden — switch to "Show all" above to see ${hiddenCount === 1 ? 'it' : 'them'}.`
                  : 'No meetings yet.'}
              </p>
            )}
          </div>
        );
      })()}

      {/* Floating bulk-action bar — visible only in selection mode. Sits
          above the page bottom so it doesn't shift the list layout. */}
      {selectionMode && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-xl shadow-depth-lg bg-iron-surface border border-iron-border animate-slide-up">
          <span className="text-xs text-iron-text font-medium">
            {selectedIds.size} selected
          </span>
          <button
            onClick={clearSelection}
            className="px-3 py-1.5 rounded-lg text-xs text-iron-text-muted hover:text-iron-text hover:bg-iron-surface-hover transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={deleteSelected}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-red-300 bg-red-500/10 border border-red-500/20 hover:bg-red-500/20 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete {selectedIds.size}
          </button>
        </div>
      )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// "No audio captured" detection — used by the empty-meetings filter
// ─────────────────────────────────────────────────────────────────────────

/**
 * True when the session never captured speech worth summarizing — its
 * structured_output.processingState is 'empty'. The card UI also shows
 * an "Insufficient" badge for meetings where some audio was captured but
 * not enough to summarize; we treat those as keepers (the user might
 * still want their raw transcript), so only 'empty' is filtered.
 */
/**
 * Pull attendees from the session's v7 `participants` roster for the
 * SummaryGenerator's Attendees section. Returns undefined when no
 * roster entry resolves to a non-empty display name — generateMeetingSummary
 * then skips the metadata block and the Default template prompt omits
 * the Attendees section.
 *
 * Date is intentionally NOT in the context — the meeting detail header
 * shows it above the notes; we don't want a duplicate inside the body.
 */
async function buildSummaryContextForSession(
  sessionId: string,
): Promise<{ attendees?: string[] } | undefined> {
  try {
    const raw = await window.ironmic.meetingGet(sessionId);
    if (!raw) return undefined;
    const session = JSON.parse(raw);
    if (typeof session?.participants !== 'string' || !session.participants.trim()) {
      return undefined;
    }
    try {
      const roster = JSON.parse(session.participants);
      if (!Array.isArray(roster)) return undefined;
      const names = roster
        .map((p: any) => (typeof p?.displayName === 'string' ? p.displayName.trim() : ''))
        .filter((s: string) => s.length > 0);
      return names.length > 0 ? { attendees: names } : undefined;
    } catch {
      return undefined;
    }
  } catch {
    return undefined;
  }
}

function isSessionEmpty(session: { structured_output?: string }): boolean {
  if (!session.structured_output) return false;
  try {
    const parsed = JSON.parse(session.structured_output);
    return parsed?.processingState === 'empty';
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Date-bucket grouping for the meeting history list
// ─────────────────────────────────────────────────────────────────────────

/**
 * Bucket meeting sessions by their `started_at` date relative to "now":
 *   Today / Yesterday / This week (older than yesterday, within the
 *   current Sun-Sat week) / Last week / This month / Earlier.
 *
 * Returns an array of [bucketLabel, sessions[]] pairs in display order
 * (most recent bucket first). Each bucket's sessions are sorted
 * newest-first internally. Buckets that end up empty are omitted so we
 * don't render a header with no cards beneath it.
 *
 * Why this lives here and not in a util module: only this list view
 * cares about it, and the bucket boundaries (calendar day vs ISO week)
 * are coupled to the user-visible labels — moving them to a generic
 * helper would force the labels into a separate i18n surface for no
 * benefit while the rest of the app uses raw timestamps.
 */
function groupSessionsByDate<T extends { started_at: string }>(
  sessions: readonly T[],
): Array<[string, T[]]> {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  // Start of this calendar week (Sunday). Day-of-week 0 = Sun.
  const startOfThisWeek = startOfToday - now.getDay() * 24 * 60 * 60 * 1000;
  const startOfLastWeek = startOfThisWeek - 7 * 24 * 60 * 60 * 1000;
  const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  const buckets: Record<string, T[]> = {
    Today: [],
    Yesterday: [],
    'This week': [],
    'Last week': [],
    'This month': [],
    Earlier: [],
  };

  for (const s of sessions) {
    const t = Date.parse(s.started_at);
    if (Number.isNaN(t)) {
      buckets.Earlier.push(s);
      continue;
    }
    if (t >= startOfToday) buckets.Today.push(s);
    else if (t >= startOfYesterday) buckets.Yesterday.push(s);
    else if (t >= startOfThisWeek) buckets['This week'].push(s);
    else if (t >= startOfLastWeek) buckets['Last week'].push(s);
    else if (t >= startOfThisMonth) buckets['This month'].push(s);
    else buckets.Earlier.push(s);
  }

  // Sort each bucket newest-first, then drop empty ones.
  const order = ['Today', 'Yesterday', 'This week', 'Last week', 'This month', 'Earlier'];
  return order
    .map<[string, T[]]>((label) => {
      const arr = buckets[label].slice().sort(
        (a, b) => Date.parse(b.started_at) - Date.parse(a.started_at),
      );
      return [label, arr];
    })
    .filter(([, arr]) => arr.length > 0);
}
