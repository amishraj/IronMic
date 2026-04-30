/**
 * MeetingNotesCollabClient — connects to a host's MeetingNotesCollabServer
 * so a participant can view and collaboratively edit a finished meeting's notes.
 *
 * Unlike MeetingRoomClient (which records mic audio), this client is read/write
 * only: it receives the current notes on join, can send draft updates for live
 * preview, and send save_request to commit changes.
 */

import { WebSocket, type RawData } from 'ws';
import { BrowserWindow } from 'electron';
import type { CollabParticipant } from './meeting-notes-collab-server';

export interface CollabClientInfo {
  connected: boolean;
  hostIp: string | null;
  hostPort: number | null;
  sessionId: string | null;
  participantId: string | null;
  displayName: string | null;
  hostName: string | null;
  version: number;
  participants: CollabParticipant[];
}

class MeetingNotesCollabClientManager {
  private ws: WebSocket | null = null;

  private hostIp: string | null = null;
  private hostPort: number | null = null;
  private sessionId: string | null = null;
  private participantId: string | null = null;
  private displayName: string | null = null;
  private hostName: string | null = null;
  private version: number = 0;
  private participants: CollabParticipant[] = [];

  // ── Public state ──────────────────────────────────────────────────────────

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  getInfo(): CollabClientInfo {
    return {
      connected: this.isConnected(),
      hostIp: this.hostIp,
      hostPort: this.hostPort,
      sessionId: this.sessionId,
      participantId: this.participantId,
      displayName: this.displayName,
      hostName: this.hostName,
      version: this.version,
      participants: this.participants,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async connect(opts: {
    hostIp: string;
    hostPort: number;
    sessionCode: string;
    displayName: string;
  }): Promise<{ info: CollabClientInfo; notes: string }> {
    if (this.ws) await this.disconnect();

    this.hostIp = opts.hostIp;
    this.hostPort = opts.hostPort;
    this.displayName = opts.displayName.slice(0, 64).trim() || 'Viewer';

    return new Promise((resolve, reject) => {
      // Bracket IPv6 literals (containing ":") for the WebSocket URL.
      const host = opts.hostIp.includes(':') ? `[${opts.hostIp}]` : opts.hostIp;
      const url = `ws://${host}:${opts.hostPort}`;
      const ws = new WebSocket(url, { handshakeTimeout: 8000 });
      this.ws = ws;

      const timeout = setTimeout(() => {
        ws.terminate();
        reject(new Error('Connection timed out (8 s). Check the invite string.'));
      }, 10_000);

      ws.once('open', () => {
        ws.send(JSON.stringify({
          type: 'join',
          sessionCode: opts.sessionCode,
          displayName: this.displayName,
        }));
      });

      ws.on('message', (raw: RawData) => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.type === 'welcome') {
          clearTimeout(timeout);
          this.sessionId = msg.sessionId ?? null;
          this.participantId = msg.participantId ?? null;
          this.hostName = msg.hostName ?? null;
          this.version = msg.version ?? 0;
          this.participants = msg.participants ?? [];
          this.pushStateToRenderer();
          resolve({ info: this.getInfo(), notes: String(msg.notes ?? '') });
        } else if (msg.type === 'rejected') {
          clearTimeout(timeout);
          ws.close();
          this.ws = null;
          reject(new Error(`Host rejected connection: ${msg.reason ?? 'unknown reason'}`));
        } else {
          // Regular messages while connected
          this.handleMessage(msg);
        }
      });

      ws.on('error', (err: Error) => {
        clearTimeout(timeout);
        this.ws = null;
        const isUnreachable = err.message.includes('EHOSTUNREACH') || err.message.includes('ENETUNREACH');
        const isRefused = err.message.includes('ECONNREFUSED');
        let msg: string;
        if (isUnreachable) {
          msg =
            `Cannot reach ${opts.hostIp}:${opts.hostPort}. ` +
            'If the host is on Windows, IronMic may be blocked by Windows Firewall — ' +
            'open Windows Security → Firewall & network protection → Allow an app through firewall, ' +
            'then allow IronMic. If the host is on macOS, check that a firewall or VPN is not ' +
            'blocking inbound TCP connections.';
        } else if (isRefused) {
          msg = `Connection refused at ${opts.hostIp}:${opts.hostPort}. Make sure the host has started the collaboration session and the invite string is correct.`;
        } else {
          msg = `WebSocket error: ${err.message}`;
        }
        reject(new Error(msg));
      });

      ws.on('close', () => {
        clearTimeout(timeout);
        const wasConnected = this.ws !== null;
        this.ws = null;
        if (wasConnected) this.pushStateToRenderer();
      });
    });
  }

  async disconnect(): Promise<void> {
    if (!this.ws) return;
    try { this.ws.close(1000, 'leaving'); } catch { /* ignore */ }
    this.ws = null;
    this.sessionId = null;
    this.participantId = null;
    this.hostName = null;
    this.version = 0;
    this.participants = [];
    this.pushStateToRenderer();
  }

  // ── Send helpers ─────────────────────────────────────────────────────────

  /** Send live draft preview (throttle from the caller). */
  sendDraft(content: string): void {
    if (!this.isConnected()) return;
    try { this.ws!.send(JSON.stringify({ type: 'draft', content })); } catch { /* ignore */ }
  }

  /** Commit and save the current content. Host will broadcast back. */
  saveNotes(content: string): void {
    if (!this.isConnected()) return;
    try { this.ws!.send(JSON.stringify({ type: 'save_request', content })); } catch { /* ignore */ }
  }

  // ── Incoming message handling ─────────────────────────────────────────────

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case 'draft':
        this.broadcastEvent('ironmic:meeting-collab-draft', {
          content: msg.content,
          peerId: msg.peerId,
          peerName: msg.peerName,
        });
        break;

      case 'saved':
        this.version = msg.version ?? this.version + 1;
        this.broadcastEvent('ironmic:meeting-collab-notes-updated', {
          notes: msg.content,
          savedBy: msg.savedBy,
          version: this.version,
        });
        break;

      case 'presence':
        this.participants = msg.participants ?? [];
        this.pushStateToRenderer();
        break;

      case 'collab_ended':
        if (this.ws) {
          try { this.ws.close(1000, 'host ended'); } catch { /* ignore */ }
          this.ws = null;
        }
        this.pushStateToRenderer();
        this.broadcastEvent('ironmic:meeting-collab-ended', {});
        break;
    }
  }

  // ── Renderer push ─────────────────────────────────────────────────────────

  private pushStateToRenderer(): void {
    this.broadcastEvent('ironmic:meeting-collab-state', this.getInfo());
  }

  private broadcastEvent(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  }
}

export const meetingNotesCollabClient = new MeetingNotesCollabClientManager();
