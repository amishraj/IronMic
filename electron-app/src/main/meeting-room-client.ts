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
        this.cleanupSocket();
        reject(err);
      });
      sock.once('close', () => {
        // If close happens before welcome, treat as failure
        if (!this.remoteSessionId) {
          this.cleanupSocket();
          reject(new Error(this.lastError ?? 'Connection closed before welcome'));
        }
      });
    });

    return this.getInfo();
  }

  /** Disconnect and stop the local recorder. */
  async disconnect(): Promise<void> {
    if (this.unsubSegment) { this.unsubSegment(); this.unsubSegment = null; }
    try {
      if (meetingRecorder.getActiveSessionId() === this.localSessionId && this.localSessionId) {
        await meetingRecorder.stopMeetingRecording();
      }
    } catch (err) {
      console.warn('[MeetingRoomClient] Failed to stop local recorder:', err);
    }
    this.localSessionId = null;
    if (this.socket) {
      try { this.socket.close(1000, 'leaving'); } catch { /* ignore */ }
    }
    this.cleanupSocket();
    this.pushStateToRenderer();
  }

  private async startLocalRecorder(deviceName: string | null): Promise<void> {
    // Create a local meeting session so segments have somewhere to live in
    // the participant's own DB. The session id is independent from the
    // host's authoritative session id.
    let createdId: string | null = null;
    try {
      const json = native.addon.createMeetingSession();
      const session = JSON.parse(json);
      createdId = session.id ?? null;
    } catch (err) {
      console.warn('[MeetingRoomClient] Could not create local meeting session, using ephemeral id:', err);
    }
    this.localSessionId = createdId ?? `local-${crypto.randomUUID()}`;

    // Forward each locally-produced segment up to the host
    this.unsubSegment = meetingRecorder.onSegment((seg) => this.forwardSegment(seg));

    await meetingRecorder.startMeetingRecording(this.localSessionId, deviceName);
  }

  private forwardSegment(seg: TranscriptSegment): void {
    // Don't forward segments we received via broadcast (would loop)
    if (seg.source === 'broadcast') return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify({
        type: 'segment',
        participantId: this.participantId,
        displayName: this.displayName,
        startMs: seg.start_ms,
        endMs: seg.end_ms,
        text: seg.text,
      }));
    } catch (err) {
      console.warn('[MeetingRoomClient] Failed to forward segment:', err);
    }
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'segment_broadcast' && msg.segment) {
      // Display incoming remote segment in this participant's transcript view
      const seg = msg.segment as TranscriptSegment;
      // Mark as broadcast so forwardSegment doesn't loop it back
      const tagged: TranscriptSegment = { ...seg, source: 'broadcast' };
      meetingRecorder.ingestRemoteSegment(tagged);
      return;
    }
    if (msg.type === 'meeting_ended') {
      void this.disconnect();
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

  private handleDisconnect(): void {
    if (this.unsubSegment) { this.unsubSegment(); this.unsubSegment = null; }
    this.cleanupSocket();
    this.pushStateToRenderer();
  }

  private cleanupSocket(): void {
    this.socket = null;
    this.hostName = null;
    this.participantId = null;
    this.remoteSessionId = null;
  }

  private pushStateToRenderer(): void {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length === 0) return;
    windows[0].webContents.send(IPC_CHANNELS.MEETING_ROOM_STATE, this.getInfo());
  }
}

export const meetingRoomClient = new MeetingRoomClientManager();
