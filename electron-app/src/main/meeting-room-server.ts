/**
 * MeetingRoomServer — embedded WebSocket server for LAN-based collaborative
 * meetings.
 *
 * The host runs this server. Participants connect via meeting-room-client
 * over their local network. Each participant records their own mic locally
 * and forwards transcript segments to the host. The host:
 *   - Saves every segment (own + participants') to its local SQLite DB
 *   - Broadcasts every segment to all other participants so they see a
 *     unified live transcript
 *
 * Privacy: bind is to 0.0.0.0 (LAN only); no relay server, no NAT traversal,
 * no cloud. Connections are gated by a short room code shared via copy/paste.
 *
 * Message protocol (JSON over WebSocket):
 *   client → host: { type: "join", roomCode, displayName }
 *   host   → client: { type: "welcome", sessionId, hostName, templateId }
 *                 OR { type: "rejected", reason }
 *   client → host: { type: "segment", participantId, displayName, startMs, endMs, text }
 *   host   → all : { type: "segment_broadcast", segment }
 *   host   → all : { type: "participant_joined", participantId, displayName }
 *   host   → all : { type: "participant_left", participantId, displayName }
 *   host   → all : { type: "meeting_ended" }
 */

import { BrowserWindow } from 'electron';
import * as os from 'os';
import * as crypto from 'crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage } from 'http';
import { native } from './native-bridge';
import { meetingRecorder, type TranscriptSegment } from './meeting-recorder';
import { IPC_CHANNELS } from '../shared/constants';

export interface RoomParticipant {
  id: string;            // server-assigned UUID
  displayName: string;
  joinedAt: number;
  remoteAddress: string; // ip:port
}

export interface RoomInfo {
  active: boolean;
  sessionId: string | null;
  hostName: string | null;
  ip: string | null;
  port: number | null;
  roomCode: string | null;
  inviteString: string | null;  // "ip:port|roomCode"
  participants: RoomParticipant[];
}

interface ClientState {
  socket: WebSocket;
  participantId: string | null;
  displayName: string | null;
  remoteAddress: string;
}

class MeetingRoomServerManager {
  private wss: WebSocketServer | null = null;
  private clients: Map<WebSocket, ClientState> = new Map();
  private participants: Map<string, RoomParticipant> = new Map();
  private sessionId: string | null = null;
  private hostName: string | null = null;
  private templateId: string | null = null;
  private roomCode: string | null = null;
  private boundIp: string | null = null;
  private boundPort: number | null = null;
  private unsubSegment: (() => void) | null = null;

  /**
   * Detect the most likely LAN IPv4 address. Prefers private ranges (10/8,
   * 172.16/12, 192.168/16) and skips loopback / virtual / link-local.
   */
  private detectLanIp(): string | null {
    const ifaces = os.networkInterfaces();
    const candidates: string[] = [];
    for (const name of Object.keys(ifaces)) {
      // Skip likely-virtual interfaces by name
      if (/^(lo|docker|veth|tun|tap|utun|bridge|llw|awdl|anpi)/i.test(name)) continue;
      const list = ifaces[name] ?? [];
      for (const addr of list) {
        if (addr.family !== 'IPv4') continue;
        if (addr.internal) continue;
        if (addr.address.startsWith('169.254.')) continue; // link-local
        candidates.push(addr.address);
      }
    }
    // Prefer 192.168 → 10.* → 172.16-31 → anything else
    candidates.sort((a, b) => {
      const score = (ip: string) => {
        if (ip.startsWith('192.168.')) return 0;
        if (ip.startsWith('10.')) return 1;
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
        return 3;
      };
      return score(a) - score(b);
    });
    return candidates[0] ?? null;
  }

  private generateRoomCode(): string {
    // 6-character upper-case alphanumeric, no ambiguous chars (0/O/I/1)
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const buf = crypto.randomBytes(6);
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += alphabet[buf[i] % alphabet.length];
    }
    return code;
  }

  isActive(): boolean {
    return this.wss !== null;
  }

  getInfo(): RoomInfo {
    return {
      active: this.isActive(),
      sessionId: this.sessionId,
      hostName: this.hostName,
      ip: this.boundIp,
      port: this.boundPort,
      roomCode: this.roomCode,
      inviteString: this.boundIp && this.boundPort && this.roomCode
        ? `${this.boundIp}:${this.boundPort}|${this.roomCode}`
        : null,
      participants: Array.from(this.participants.values()),
    };
  }

  /**
   * Start the WebSocket server bound to the LAN IP on a random port.
   */
  async start(opts: {
    sessionId: string;
    hostName: string;
    templateId?: string | null;
  }): Promise<RoomInfo> {
    if (this.wss) {
      throw new Error('Room server already running');
    }
    this.sessionId = opts.sessionId;
    this.hostName = opts.hostName || 'Host';
    this.templateId = opts.templateId ?? null;
    this.roomCode = this.generateRoomCode();

    const ip = this.detectLanIp();
    if (!ip) {
      throw new Error('Could not detect a LAN IPv4 address. Are you connected to a network?');
    }
    this.boundIp = ip;

    // Bind on 0.0.0.0 so participants on the LAN can connect, but advertise
    // the specific LAN IP in the invite. Port=0 → kernel picks a free port.
    await new Promise<void>((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({ host: '0.0.0.0', port: 0 });
        this.wss.on('listening', () => {
          const addr = this.wss!.address();
          if (typeof addr === 'object' && addr) {
            this.boundPort = addr.port;
          }
          resolve();
        });
        this.wss.on('error', (err: Error) => {
          reject(err);
        });
        this.wss.on('connection', (socket: WebSocket, req: IncomingMessage) => this.handleConnection(socket, req.socket.remoteAddress ?? 'unknown'));
      } catch (err) {
        reject(err);
      }
    });

    // Subscribe to local recorder segments so we can broadcast them.
    this.unsubSegment = meetingRecorder.onSegment((seg) => this.broadcastSegment(seg));

    this.pushStateToRenderer();
    return this.getInfo();
  }

  /** Stop the WebSocket server and notify participants. */
  async stop(): Promise<void> {
    if (!this.wss) return;
    this.broadcast({ type: 'meeting_ended' });
    if (this.unsubSegment) {
      this.unsubSegment();
      this.unsubSegment = null;
    }
    for (const client of this.clients.keys()) {
      try { client.close(1000, 'meeting ended'); } catch { /* ignore */ }
    }
    await new Promise<void>((resolve) => {
      this.wss!.close(() => resolve());
    });
    this.wss = null;
    this.clients.clear();
    this.participants.clear();
    this.sessionId = null;
    this.hostName = null;
    this.templateId = null;
    this.roomCode = null;
    this.boundIp = null;
    this.boundPort = null;
    this.pushStateToRenderer();
  }

  private handleConnection(socket: WebSocket, remoteAddress: string): void {
    const state: ClientState = {
      socket,
      participantId: null,
      displayName: null,
      remoteAddress,
    };
    this.clients.set(socket, state);

    socket.on('message', (raw: RawData) => this.handleMessage(state, raw.toString()));
    socket.on('close', () => this.handleDisconnect(state));
    socket.on('error', (err: Error) => {
      console.warn('[MeetingRoomServer] client socket error:', err.message);
    });
  }

  private handleMessage(state: ClientState, raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); }
    catch { return; }

    if (msg.type === 'join') {
      // Validate room code
      if (msg.roomCode !== this.roomCode) {
        try {
          state.socket.send(JSON.stringify({ type: 'rejected', reason: 'Invalid room code' }));
          state.socket.close(4001, 'invalid room code');
        } catch { /* ignore */ }
        return;
      }
      const displayName = String(msg.displayName ?? 'Participant').slice(0, 64).trim() || 'Participant';
      const participantId = crypto.randomUUID();
      state.participantId = participantId;
      state.displayName = displayName;
      const participant: RoomParticipant = {
        id: participantId,
        displayName,
        joinedAt: Date.now(),
        remoteAddress: state.remoteAddress,
      };
      this.participants.set(participantId, participant);

      try {
        state.socket.send(JSON.stringify({
          type: 'welcome',
          sessionId: this.sessionId,
          hostName: this.hostName,
          templateId: this.templateId,
          participantId,
        }));
      } catch (err) {
        console.warn('[MeetingRoomServer] failed to send welcome:', err);
      }

      // Broadcast join + push state to host UI
      this.broadcast({ type: 'participant_joined', participantId, displayName }, state.socket);
      this.pushStateToRenderer();
      return;
    }

    // All other messages require the client to have joined first.
    if (!state.participantId || !state.displayName) {
      return;
    }

    if (msg.type === 'segment') {
      // Persist remote segment to the host's DB with source=participant:{name}
      // so the speaker label is naturally the participant's name.
      const startMs = Number(msg.startMs ?? 0);
      const endMs = Number(msg.endMs ?? startMs);
      const text = String(msg.text ?? '').slice(0, 50_000);
      if (!text || !this.sessionId) return;
      const source = `participant:${state.displayName}`;

      let persisted: TranscriptSegment;
      const speakerLabel = state.displayName;
      try {
        if (typeof native.addon.addTranscriptSegment === 'function') {
          const json = native.addon.addTranscriptSegment(
            this.sessionId,
            speakerLabel,
            startMs,
            endMs,
            text,
            source,
          );
          persisted = JSON.parse(json) as TranscriptSegment;
        } else {
          persisted = {
            id: `remote-${crypto.randomUUID()}`,
            session_id: this.sessionId,
            speaker_label: speakerLabel,
            start_ms: startMs,
            end_ms: endMs,
            text,
            source,
            participant_id: state.participantId,
            confidence: null,
            created_at: new Date().toISOString(),
          };
        }
      } catch (err) {
        console.warn('[MeetingRoomServer] Failed to persist remote segment:', err);
        persisted = {
          id: `remote-${crypto.randomUUID()}`,
          session_id: this.sessionId,
          speaker_label: speakerLabel,
          start_ms: startMs,
          end_ms: endMs,
          text,
          source,
          participant_id: state.participantId,
          confidence: null,
          created_at: new Date().toISOString(),
        };
      }

      // Tag with participant id for downstream consumers
      persisted.participant_id = state.participantId;

      // Forward to the host's local recorder so the host UI sees the segment
      // in its live transcript view alongside its own segments.
      meetingRecorder.ingestRemoteSegment(persisted);

      // Rebroadcast to all OTHER participants so everyone sees a unified view
      this.broadcast({ type: 'segment_broadcast', segment: persisted }, state.socket);
    }
  }

  private handleDisconnect(state: ClientState): void {
    this.clients.delete(state.socket);
    if (state.participantId) {
      const p = this.participants.get(state.participantId);
      this.participants.delete(state.participantId);
      this.broadcast({
        type: 'participant_left',
        participantId: state.participantId,
        displayName: p?.displayName ?? state.displayName ?? 'Unknown',
      });
      this.pushStateToRenderer();
    }
  }

  /** Broadcast a JSON message to all connected participants (optionally excluding one). */
  private broadcast(msg: any, exclude?: WebSocket): void {
    if (!this.wss) return;
    const payload = JSON.stringify(msg);
    for (const client of this.clients.keys()) {
      if (client === exclude) continue;
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(payload); } catch { /* ignore */ }
      }
    }
  }

  /** Forward a locally-produced segment to every participant. */
  private broadcastSegment(seg: TranscriptSegment): void {
    // Don't loop-broadcast segments that originated from a remote participant.
    if (seg.source.startsWith('participant:')) return;
    this.broadcast({ type: 'segment_broadcast', segment: seg });
  }

  private pushStateToRenderer(): void {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length === 0) return;
    windows[0].webContents.send(IPC_CHANNELS.MEETING_ROOM_STATE, this.getInfo());
  }
}

export const meetingRoomServer = new MeetingRoomServerManager();
