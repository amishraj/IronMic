/**
 * MeetingRoomClient — connects to a host's MeetingRoomServer over the LAN.
 *
 * On the participant side:
 *   - Connect to ws://hostIp:port and send a join message with the room code
 *     and display name
 *   - Run the local MeetingRecorder so the participant's own mic produces
 *     transcript segments
 *   - Forward each segment to the host as { type: "segment", ... }
 *   - Receive segment_broadcast events from the host (other participants'
 *     speech) and persist them locally so the participant has a full
 *     transcript view too
 *   - On meeting_ended, stop the local recorder
 */

import { BrowserWindow } from 'electron';
import * as crypto from 'crypto';
import { WebSocket, type RawData } from 'ws';
import { native } from './native-bridge';
import { meetingRecorder, type TranscriptSegment } from './meeting-recorder';
import { IPC_CHANNELS } from '../shared/constants';

export interface RoomClientInfo {
  connected: boolean;
  hostIp: string | null;
  hostPort: number | null;
  hostName: string | null;
  sessionId: string | null;       // participant's local mirror session
  remoteSessionId: string | null; // host's authoritative session id
  displayName: string | null;
  participantId: string | null;
  error: string | null;
  /** Shared Your Notes html provided by the host on welcome. The renderer
   *  uses this to pre-fill YourNotesPanel for late joiners — without it, a
   *  participant who joins after the host has typed sees an empty editor
   *  until the next notes_update lands. Null if the host had no notes. */
  welcomeNotesHtml: string | null;
  /** Version of the welcome notes payload (matches host's notesVersion). */
  welcomeNotesVersion: number | null;
}

class MeetingRoomClientManager {
  private socket: WebSocket | null = null;
  private hostIp: string | null = null;
  private hostPort: number | null = null;
  private hostName: string | null = null;
  private displayName: string | null = null;
  private participantId: string | null = null;
  private remoteSessionId: string | null = null;
  private localSessionId: string | null = null;
  private unsubSegment: (() => void) | null = null;
  private lastError: string | null = null;
  /** Shared Your Notes html captured from the host's `welcome` payload. The
   *  renderer reads this from getInfo()/connect() return value and pre-fills
   *  YourNotesPanel for late joiners. Cleared on disconnect/cleanup so a
   *  later rejoin can't surface stale state. */
  private welcomeNotesHtml: string | null = null;
  private welcomeNotesVersion: number | null = null;
  /** Last AI summary received from the host, kept so we can persist it to
   *  the participant's local mirror session at meeting end (the participant
   *  doesn't run their own LiveSummarizer — they only see the host's). */
  private lastSummary: string = '';
  private lastSummaryAt: number | null = null;
  /** Last host-set title received via welcome or `title_update`. Used as
   *  fallback when `meeting_ended` doesn't carry `finalTitle` (older host
   *  builds). */
  private lastTitle: string | null = null;
  /** Welcome-payload transcript snapshot. Staged here because localSessionId
   *  doesn't exist yet at welcome time; drained inside startLocalRecorder
   *  AFTER startMeetingRecording (which wipes recorder.segments). */
  private welcomeSegments: TranscriptSegment[] = [];
  /** Welcome-payload summary, drained alongside welcomeSegments. */
  private welcomeSummaryPayload: {
    summary: string;
    segmentCount: number;
    generatedAt: number;
    insufficient: boolean;
  } | null = null;
  /** 30s safety-net timer started when MEETING_ROOM_HOST_ENDED is dispatched
   *  to the renderer. If MEETING_ROOM_PARTICIPANT_FINALIZED doesn't arrive
   *  back (renderer crash, navigation killed the listener, etc.) we clear
   *  client state automatically so getInfo() doesn't keep reporting a dead
   *  session forever. */
  private finalizeWatchdog: NodeJS.Timeout | null = null;

  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  getInfo(): RoomClientInfo {
    return {
      connected: this.isConnected(),
      hostIp: this.hostIp,
      hostPort: this.hostPort,
      hostName: this.hostName,
      sessionId: this.localSessionId,
      remoteSessionId: this.remoteSessionId,
      displayName: this.displayName,
      participantId: this.participantId,
      error: this.lastError,
      welcomeNotesHtml: this.welcomeNotesHtml,
      welcomeNotesVersion: this.welcomeNotesVersion,
    };
  }

  /**
   * Connect to a host, then start the local mic recorder. The provided
   * audio device (if any) is used for the participant's own mic.
   */
  async connect(opts: {
    hostIp: string;
    hostPort: number;
    roomCode: string;
    displayName: string;
    deviceName?: string | null;
  }): Promise<RoomClientInfo> {
    if (this.socket) {
      throw new Error('Already connected to a room');
    }
    this.hostIp = opts.hostIp;
    this.hostPort = opts.hostPort;
    this.displayName = opts.displayName;
    this.lastError = null;

    const url = `ws://${opts.hostIp}:${opts.hostPort}`;

    await new Promise<void>((resolve, reject) => {
      const sock = new WebSocket(url, { handshakeTimeout: 7_000 });
      this.socket = sock;
      const onOpen = () => {
        sock.send(JSON.stringify({
          type: 'join',
          roomCode: opts.roomCode,
          displayName: opts.displayName,
        }));
      };
      const onMessage = (raw: RawData) => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'rejected') {
          this.lastError = msg.reason ?? 'Rejected';
          try { sock.close(); } catch { /* ignore */ }
          reject(new Error(this.lastError ?? 'rejected'));
          return;
        }
        if (msg.type === 'welcome') {
          this.hostName = msg.hostName ?? null;
          this.remoteSessionId = msg.sessionId ?? null;
          this.participantId = msg.participantId ?? crypto.randomUUID();
          // Capture host-set title so the renderer can show it in the live
          // header. Participant input is read-only; this is the single
          // source of truth on the participant side.
          this.lastTitle = typeof msg.title === 'string' ? msg.title : null;
          // Capture the shared Your Notes seed so the renderer can pre-fill
          // YourNotesPanel via the connect() return value. The DB-side persist
          // happens later, after localSessionId exists (in startLocalRecorder).
          if (typeof msg.notesHtml === 'string') {
            this.welcomeNotesHtml = msg.notesHtml;
            this.welcomeNotesVersion = Number.isFinite(Number(msg.notesVersion))
              ? Number(msg.notesVersion)
              : null;
          } else {
            this.welcomeNotesHtml = null;
            this.welcomeNotesVersion = null;
          }
          // Stage the historical transcript + latest summary. Drained later
          // inside startLocalRecorder once localSessionId exists AND after
          // startMeetingRecording has wiped recorder.segments — otherwise
          // the wipe would erase the historical segments we just ingested.
          if (Array.isArray(msg.segments)) {
            this.welcomeSegments = msg.segments as TranscriptSegment[];
          } else {
            this.welcomeSegments = [];
          }
          if (typeof msg.summary === 'string') {
            const generatedAt = Number.isFinite(Number(msg.summaryGeneratedAt))
              ? Number(msg.summaryGeneratedAt)
              : Date.now();
            const segmentCount = Number.isFinite(Number(msg.summarySegmentCount))
              ? Number(msg.summarySegmentCount)
              : 0;
            this.welcomeSummaryPayload = {
              summary: msg.summary,
              segmentCount,
              generatedAt,
              insufficient: !!msg.summaryInsufficient,
            };
          } else {
            this.welcomeSummaryPayload = null;
          }
          // Swap onMessage to the steady-state handler
          sock.off('message', onMessage);
          sock.on('message', (r: RawData) => this.handleMessage(r.toString()));
          // Wire the post-welcome disconnect handler here using `sock` so
          // TypeScript keeps the concrete ws.WebSocket type (not the DOM
          // WebSocket, which has no .on() and which the lib:DOM tsconfig
          // introduces as a global, causing the narrowed type to become never
          // when accessed through this.socket after an await boundary).
          sock.on('close', () => this.handleDisconnect());
          // Start local recorder for the participant's own mic
          void this.startLocalRecorder(opts.deviceName ?? null).then(() => {
            this.pushStateToRenderer();
            resolve();
          }).catch((err: Error) => {
            this.lastError = err?.message ?? 'Failed to start local recorder';
            reject(err);
          });
          return;
        }
      };
      sock.once('open', onOpen);
      sock.on('message', onMessage);
      sock.once('error', (err: Error) => {
        this.lastError = err?.message ?? 'Connection error';
        // Pre-welcome failure — nothing meaningful to preserve. Full wipe.
        this.cleanupSocketOnly();
        this.clearMeetingStateAfterFinalized();
        reject(err);
      });
      sock.once('close', () => {
        // If close happens before welcome, treat as failure.
        if (!this.remoteSessionId) {
          this.cleanupSocketOnly();
          this.clearMeetingStateAfterFinalized();
          reject(new Error(this.lastError ?? 'Connection closed before welcome'));
        }
      });
    });

    return this.getInfo();
  }

  /** Full disconnect: stops the local recorder AND clears all state. Used by
   *  unexpected error paths and as a fallback. Renderer-driven exits should
   *  use `disconnectTransport()` instead so the renderer can finalize against
   *  preserved session ids before main wipes them. */
  async disconnect(): Promise<void> {
    if (this.unsubSegment) { this.unsubSegment(); this.unsubSegment = null; }
    try {
      if (meetingRecorder.getActiveSessionId() === this.localSessionId && this.localSessionId) {
        await meetingRecorder.stopMeetingRecording();
      }
    } catch (err) {
      console.warn('[MeetingRoomClient] Failed to stop local recorder:', err);
    }
    if (this.socket) {
      try { this.socket.close(1000, 'leaving'); } catch { /* ignore */ }
    }
    this.cleanupSocketOnly();
    this.clearMeetingStateAfterFinalized();
    this.pushStateToRenderer();
  }

  /** Transport-only disconnect: closes the socket and unsubscribes from the
   *  local recorder, but leaves `localSessionId / remoteSessionId / lastSummary
   *  / lastTitle` in place so the renderer's `finalizeAndExitMeeting` can
   *  attribute the finalize correctly. The renderer MUST call
   *  `participantFinalized()` once it's done — the watchdog handles the case
   *  where it doesn't (renderer crash/nav). */
  async disconnectTransport(): Promise<void> {
    if (this.unsubSegment) { this.unsubSegment(); this.unsubSegment = null; }
    if (this.socket) {
      try { this.socket.close(1000, 'leaving'); } catch { /* ignore */ }
    }
    this.cleanupSocketOnly();
    // Don't push state here — `localSessionId` etc. are still set so the
    // renderer can read them via getInfo() during finalize.
  }

  /** Called by the renderer (via MEETING_ROOM_PARTICIPANT_FINALIZED) once
   *  finalizeAndExitMeeting has completed. Wipes the durable client state
   *  that disconnectTransport intentionally preserved. */
  participantFinalized(): void {
    if (this.finalizeWatchdog) {
      clearTimeout(this.finalizeWatchdog);
      this.finalizeWatchdog = null;
    }
    this.clearMeetingStateAfterFinalized();
    this.pushStateToRenderer();
  }

  private async startLocalRecorder(deviceName: string | null): Promise<void> {
    // Rejoin path: if the participant has already had a local mirror session
    // for this host (matched by `linkedRemoteSessionId`), reuse that row so
    // their History shows ONE card per meeting instead of one-per-attempt.
    // The lookup includes ENDED rows — if the participant cleanly left a
    // prior visit (which finalizes the row), we'll reopen it.
    let localId: string | null = null;
    let reusedEnded = false;
    if (this.remoteSessionId) {
      const found = native.findLatestLocalSessionForRemote(this.remoteSessionId);
      if (found && typeof found.id === 'string') {
        localId = found.id;
        reusedEnded = !!found.ended_at;
      }
    }

    if (!localId) {
      try {
        const json = native.addon.createMeetingSession();
        const session = JSON.parse(json);
        localId = session.id ?? null;
      } catch (err) {
        console.warn('[MeetingRoomClient] Could not create local meeting session, using ephemeral id:', err);
      }
      if (!localId) localId = `local-${crypto.randomUUID()}`;
      // Stamp the linkage so a future rejoin finds this row.
      if (this.remoteSessionId) {
        this.mergeStructuredOutput(localId, { linkedRemoteSessionId: this.remoteSessionId });
      }
    } else if (reusedEnded) {
      // Reopen path: clear sealed-state columns, then merge structured_output
      // to drop stale finalize-time keys while preserving durable ones (title,
      // sequence, linkedRemoteSessionId, userNotes).
      try { native.reopenMeetingSession(localId); }
      catch (err) { console.warn('[MeetingRoomClient] reopenMeetingSession failed:', err); }
      this.mergeStructuredOutput(localId, {
        processingState: 'recording',
        plainSummary: null,
        sections: null,
        notebookEntryId: null,
      });
    }

    this.localSessionId = localId;

    // localSessionId now exists — best-effort persist the welcome-payload
    // notes + title to the participant's local DB so post-meeting view
    // reflects the host's content.
    if (this.welcomeNotesHtml && this.localSessionId) {
      this.persistNotesToLocal(this.welcomeNotesHtml);
    }
    if (this.lastTitle && this.localSessionId) {
      this.mergeStructuredOutput(this.localSessionId, { title: this.lastTitle });
    }

    // Forward each locally-produced segment up to the host
    this.unsubSegment = meetingRecorder.onSegment((seg) => this.forwardSegment(seg));

    await meetingRecorder.startMeetingRecording(this.localSessionId, deviceName);

    // Drain the welcome snapshot AFTER startMeetingRecording: the recorder
    // wipes its in-memory segments[] on start, so ingesting historical
    // segments before the wipe would lose them. Order: history first, then
    // any live segment_broadcast packets that race in via handleMessage. The
    // (session_id, remote_segment_id) DB unique index dedups across both
    // orderings AND across rejoins (welcome may replay segments we already
    // have from a prior visit).
    if (this.welcomeSegments.length > 0) {
      for (const seg of this.welcomeSegments) {
        this.applyInboundSegment(seg);
      }
      this.welcomeSegments = [];
    }
    if (this.welcomeSummaryPayload) {
      this.applySummaryPayload(this.welcomeSummaryPayload);
      this.welcomeSummaryPayload = null;
    }
  }

  /** Read-modify-write helper for structured_output JSON. Pass null values to
   *  delete keys; non-null values overwrite or insert. Other keys are
   *  preserved unchanged (durable checkpoint state across reopen). */
  private mergeStructuredOutput(sessionId: string, patch: Record<string, unknown>): void {
    try {
      let merged: Record<string, unknown> = {};
      try {
        const raw = native.addon.getMeetingSession(sessionId);
        if (raw && raw !== 'null') {
          const session = JSON.parse(raw);
          const structuredRaw = session?.structured_output;
          if (typeof structuredRaw === 'string') {
            const parsed = JSON.parse(structuredRaw);
            if (parsed && typeof parsed === 'object') merged = parsed as Record<string, unknown>;
          }
        }
      } catch { /* fall through with empty merged */ }
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      native.setMeetingStructuredOutput(sessionId, JSON.stringify(merged));
    } catch (err) {
      console.warn('[MeetingRoomClient] mergeStructuredOutput failed:', (err as Error)?.message);
    }
  }

  /** Process a segment received from the host (welcome snapshot or live
   *  segment_broadcast). The DB unique index on (session_id, remote_segment_id)
   *  is the source of truth for dedup — re-applying the same segment is a
   *  no-op, which is essential for the rejoin welcome-replay case. Normalizes
   *  the source so the renderer's "Me" detection still works.
   *
   *  Origin identity precedence: `seg.originSegmentId` (host-stamped) takes
   *  priority over `seg.id` because participant-forwarded segments are stored
   *  on the host with a host-minted `id` but carry the participant's local
   *  id as `remote_segment_id`/`originSegmentId`. Without this, the
   *  participant's own pre-leave speech would replay with a host id that
   *  doesn't match their original local row → duplicate. */
  private applyInboundSegment(seg: TranscriptSegment & { originSegmentId?: string | null }): void {
    if (!seg || typeof seg.id !== 'string' || seg.id.length === 0) return;
    const remoteId = (seg.originSegmentId && seg.originSegmentId.length > 0) ? seg.originSegmentId : seg.id;

    // Renderer's isOwnSegment() (MeetingTranscriptPanel) treats anything
    // that isn't 'broadcast' or 'participant:*' as the local mic ("Me").
    // Host-originated segments arrive with source='meeting' — normalize them
    // to 'broadcast' so they don't get mislabeled on the participant's UI.
    // Other-participant segments arrive with 'participant:<name>'; preserve.
    const inboundSource = typeof seg.source === 'string' && seg.source.startsWith('participant:')
      ? seg.source
      : 'broadcast';

    let localSeg: TranscriptSegment | null = null;
    if (this.localSessionId) {
      try {
        const json = native.addTranscriptSegmentWithRemoteId(
          this.localSessionId,
          seg.speaker_label ?? 'Participant',
          Number(seg.start_ms ?? 0),
          Number(seg.end_ms ?? seg.start_ms ?? 0),
          seg.text ?? '',
          inboundSource,
          remoteId,
        );
        localSeg = JSON.parse(json) as TranscriptSegment;
      } catch (err) {
        console.warn('[MeetingRoomClient] persist inbound segment failed:', (err as Error)?.message);
      }
    }

    const ingestable: TranscriptSegment = localSeg
      ? { ...localSeg, source: inboundSource }
      : { ...seg, session_id: this.localSessionId ?? seg.session_id, source: inboundSource };
    meetingRecorder.ingestRemoteSegment(ingestable);
  }

  /** Apply a host-broadcast (or welcome-staged) summary payload: persist if
   *  substantive and dispatch MEETING_LIVE_SUMMARY IPC with the local mirror
   *  session id so the renderer's session-equality check accepts it. */
  private applySummaryPayload(p: { summary: string; segmentCount: number; generatedAt: number; insufficient: boolean }): void {
    if (p.summary.trim().length > 0 && !p.insufficient) {
      this.lastSummary = p.summary;
      this.lastSummaryAt = p.generatedAt;
      this.persistSummaryToLocal(p.summary, p.generatedAt);
    }
    const windows = BrowserWindow.getAllWindows();
    if (windows.length === 0) return;
    windows[0].webContents.send(IPC_CHANNELS.MEETING_LIVE_SUMMARY, {
      sessionId: this.localSessionId,
      summary: p.summary,
      segmentCount: p.segmentCount,
      generatedAt: p.generatedAt,
      insufficient: p.insufficient,
    });
  }

  /** Persist the latest shared notes html to the participant's local mirror
   *  session. Best-effort — the host is the authoritative store. */
  private persistNotesToLocal(html: string): void {
    if (!this.localSessionId) return;
    try {
      let merged: Record<string, unknown> = {};
      try {
        const raw = native.addon.getMeetingSession(this.localSessionId);
        if (raw && raw !== 'null') {
          const session = JSON.parse(raw);
          const structuredRaw = session?.structured_output;
          if (typeof structuredRaw === 'string') {
            const parsed = JSON.parse(structuredRaw);
            if (parsed && typeof parsed === 'object') merged = parsed as Record<string, unknown>;
          }
        }
      } catch { /* fall through with empty merged */ }
      merged.userNotes = html;
      native.setMeetingStructuredOutput(this.localSessionId, JSON.stringify(merged));
    } catch (err) {
      console.warn('[MeetingRoomClient] persistNotesToLocal failed:', (err as Error)?.message);
    }
  }

  /** Best-effort write the latest broadcast AI summary to this participant's
   *  local mirror session so the post-meeting detail view has a record. */
  private persistSummaryToLocal(summary: string, generatedAt: number): void {
    if (!this.localSessionId) return;
    try {
      let merged: Record<string, unknown> = {};
      try {
        const raw = native.addon.getMeetingSession(this.localSessionId);
        if (raw && raw !== 'null') {
          const session = JSON.parse(raw);
          const structuredRaw = session?.structured_output;
          if (typeof structuredRaw === 'string') {
            const parsed = JSON.parse(structuredRaw);
            if (parsed && typeof parsed === 'object') merged = parsed as Record<string, unknown>;
          }
        }
      } catch { /* fall through with empty merged */ }
      merged.liveAiSummary = summary;
      merged.liveAiSummaryAt = generatedAt;
      native.setMeetingStructuredOutput(this.localSessionId, JSON.stringify(merged));
    } catch (err) {
      console.warn('[MeetingRoomClient] persistSummaryToLocal failed:', (err as Error)?.message);
    }
  }

  /** Forward this machine's locally-typed Your Notes html to the host so it
   *  can be merged into the shared document and rebroadcast to all peers. */
  sendNotesUpdate(html: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (typeof html !== 'string') return;
    try {
      this.socket.send(JSON.stringify({
        type: 'notes_update',
        html,
        originId: this.participantId,
      }));
    } catch (err) {
      console.warn('[MeetingRoomClient] sendNotesUpdate failed:', (err as Error)?.message);
    }
  }

  private forwardSegment(seg: TranscriptSegment): void {
    // Don't forward segments we received via broadcast (would loop)
    if (seg.source === 'broadcast') return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    // Privacy backstop: if this participant is self-muted, suppress outbound
    // mic-derived segments to the host. The recorder's audio gate normally
    // prevents the segment from being produced; this is defense-in-depth.
    if (meetingRecorder.isMicMuted()) return;
    try {
      this.socket.send(JSON.stringify({
        type: 'segment',
        participantId: this.participantId,
        displayName: this.displayName,
        startMs: seg.start_ms,
        endMs: seg.end_ms,
        text: seg.text,
        // Round-trip our local segment id so it ends up as the host's row's
        // `remote_segment_id`, which then comes back to us as `originSegmentId`
        // on rebroadcast / next welcome — letting the dedup index recognize
        // the participant's own speech across leave/rejoin.
        originSegmentId: seg.id,
      }));
    } catch (err) {
      console.warn('[MeetingRoomClient] Failed to forward segment:', err);
    }
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'segment_broadcast' && msg.segment) {
      // Shared path with the welcome drain: dedup by inbound id, normalize
      // source for renderer labeling, persist to local mirror DB, push to
      // recorder. If a packet races welcome (delivered before the drain
      // runs), the dedup set ensures the same segment isn't applied twice.
      this.applyInboundSegment(msg.segment as TranscriptSegment);
      return;
    }
    if (msg.type === 'summary_broadcast') {
      // Host produced a live AI Notes summary. Reuse the same path the
      // welcome drain uses so behavior stays consistent across delivery
      // channels.
      const summary = typeof msg.summary === 'string' ? msg.summary : '';
      const generatedAt = Number.isFinite(Number(msg.generatedAt)) ? Number(msg.generatedAt) : Date.now();
      const segmentCount = Number.isFinite(Number(msg.segmentCount)) ? Number(msg.segmentCount) : 0;
      this.applySummaryPayload({
        summary,
        segmentCount,
        generatedAt,
        insufficient: !!msg.insufficient,
      });
      return;
    }
    if (msg.type === 'notes_update') {
      if (typeof msg.html !== 'string') return;
      const versionRaw = Number(msg.version);
      const version = Number.isFinite(versionRaw) ? versionRaw : 0;
      // Best-effort persist to local mirror session.
      this.persistNotesToLocal(msg.html);
      const windows = BrowserWindow.getAllWindows();
      if (windows.length === 0) return;
      windows[0].webContents.send(IPC_CHANNELS.MEETING_USER_NOTES_BROADCAST, {
        sessionId: this.localSessionId,
        html: msg.html,
        version,
        originId: typeof msg.originId === 'string' ? msg.originId : null,
      });
      return;
    }
    if (msg.type === 'title_update') {
      const t = typeof msg.title === 'string' ? msg.title : null;
      this.lastTitle = t;
      // Persist host-set title onto the participant's local mirror so the
      // post-meeting card uses the host's name even before any final
      // broadcast arrives.
      if (this.localSessionId) {
        this.mergeStructuredOutput(this.localSessionId, { title: t });
      }
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0) {
        windows[0].webContents.send(IPC_CHANNELS.MEETING_ROOM_TITLE_UPDATE, {
          sessionId: this.localSessionId,
          title: t,
        });
      }
      return;
    }
    if (msg.type === 'meeting_ended') {
      // Capture durable last-state from the packet (with in-memory fallbacks
      // for older host builds that don't include the fields). Snapshot
      // BEFORE we clear anything — clearMeetingStateAfterFinalized() runs
      // when the renderer fires participantFinalized().
      const finalSummary = typeof msg.finalSummary === 'string' && msg.finalSummary.length > 0
        ? msg.finalSummary
        : (this.lastSummary || null);
      const finalSummaryAt = Number.isFinite(Number(msg.finalSummaryAt))
        ? Number(msg.finalSummaryAt)
        : this.lastSummaryAt;
      const finalTitle = typeof msg.finalTitle === 'string' && msg.finalTitle.length > 0
        ? msg.finalTitle
        : this.lastTitle;
      const localSessionId = this.localSessionId;

      // Persist final title now (don't wait for renderer) so the participant's
      // saved card has the host's name even if finalize is delayed/crashes.
      if (localSessionId && finalTitle) {
        this.mergeStructuredOutput(localSessionId, { title: finalTitle });
      }

      // Notify the renderer so it can run finalizeAndExitMeeting against the
      // local mirror session. Renderer is responsible for stopping the
      // recorder (transport-only disconnect leaves localSessionId intact).
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0) {
        windows[0].webContents.send(IPC_CHANNELS.MEETING_ROOM_HOST_ENDED, {
          localSessionId,
          finalSummary,
          finalSummaryAt,
          finalTitle,
          finalSegmentCount: Number.isFinite(Number(msg.finalSegmentCount))
            ? Number(msg.finalSegmentCount)
            : null,
        });
      }

      // Safety net: if the renderer never fires participantFinalized()
      // (crash, navigation away, listener teardown), we still need to clear
      // client state eventually so getInfo()/room state push doesn't keep
      // reporting a dead session.
      if (this.finalizeWatchdog) clearTimeout(this.finalizeWatchdog);
      this.finalizeWatchdog = setTimeout(() => {
        this.finalizeWatchdog = null;
        if (this.localSessionId === localSessionId) {
          console.warn('[MeetingRoomClient] participantFinalized timeout — auto-clearing client state');
          this.clearMeetingStateAfterFinalized();
          this.pushStateToRenderer();
        }
      }, 30_000);

      void this.disconnectTransport();
      return;
    }
    if (msg.type === 'participant_joined' || msg.type === 'participant_left') {
      // Forward to renderer for the participants list
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0) {
        windows[0].webContents.send(IPC_CHANNELS.MEETING_ROOM_PARTICIPANT_UPDATE, msg);
      }
    }
  }

  /** Unexpected socket close (network glitch / server crashed without
   *  meeting_ended). Treat as a full disconnect — clear everything. */
  private handleDisconnect(): void {
    if (this.unsubSegment) { this.unsubSegment(); this.unsubSegment = null; }
    this.cleanupSocketOnly();
    this.clearMeetingStateAfterFinalized();
    this.pushStateToRenderer();
  }

  /** Socket-level state only. Safe to call without losing finalize-relevant
   *  data (localSessionId, remoteSessionId, lastSummary, lastTitle). */
  private cleanupSocketOnly(): void {
    this.socket = null;
    // Clear welcome staging — those buffers exist purely to bridge welcome
    // → startLocalRecorder, and a partially-drained set must not leak into
    // a future connect.
    this.welcomeSegments = [];
    this.welcomeSummaryPayload = null;
  }

  /** Clears the durable client-side meeting state that disconnectTransport
   *  intentionally preserved. Called once the renderer has finalized the
   *  mirror session (via MEETING_ROOM_PARTICIPANT_FINALIZED) or by the
   *  watchdog after a renderer-crash timeout. */
  private clearMeetingStateAfterFinalized(): void {
    this.localSessionId = null;
    this.remoteSessionId = null;
    this.hostName = null;
    this.participantId = null;
    this.welcomeNotesHtml = null;
    this.welcomeNotesVersion = null;
    this.lastSummary = '';
    this.lastSummaryAt = null;
    this.lastTitle = null;
  }

  private pushStateToRenderer(): void {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length === 0) return;
    windows[0].webContents.send(IPC_CHANNELS.MEETING_ROOM_STATE, this.getInfo());
  }
}

export const meetingRoomClient = new MeetingRoomClientManager();
