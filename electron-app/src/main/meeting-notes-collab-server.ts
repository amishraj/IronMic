/**
 * MeetingNotesCollabServer — lightweight WebSocket server for collaborative
 * editing of FINISHED meeting notes.
 *
 * Unlike MeetingRoomServer (which coordinates live mic recording), this server
 * only handles notes synchronisation and presence for a meeting that has
 * already been recorded and summarised.
 *
 * Protocol (JSON over WebSocket):
 *
 *  Handshake
 *    client → host: { type: "join", sessionCode, displayName }
 *    host   → client: { type: "welcome", sessionId, notes, version,
 *                       participants, hostName, participantId }
 *    host   → client: { type: "rejected", reason }
 *
 *  Live editing
 *    any  → host:   { type: "draft", content }
 *    host → others: { type: "draft", content, peerId, peerName }
 *
 *  Saving
 *    any  → host:   { type: "save_request", content }
 *    host → all:    { type: "saved", content, version, savedBy }
 *
 *  Presence
 *    host → all:    { type: "presence", participants }
 *
 *  Teardown
 *    host → all:    { type: "collab_ended" }
 *
 * Privacy: bind is 0.0.0.0 (LAN only); no relay, no cloud.
 */

import * as os from 'os';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { app, BrowserWindow } from 'electron';
import { native } from './native-bridge';

export interface CollabParticipant {
  id: string;
  displayName: string;
  joinedAt: number;
}

export interface CollabServerInfo {
  active: boolean;
  sessionId: string | null;
  /** Note id this session is scoped to (derived from sessionId "note:<id>"). */
  sessionNoteId: string | null;
  hostName: string | null;
  ip: string | null;
  port: number | null;
  sessionCode: string | null;
  /** Invite string for sharing: "ip:port|sessionCode" (IPv6 wrapped in brackets). */
  inviteString: string | null;
  participants: CollabParticipant[];
  version: number;
}

interface ClientState {
  socket: WebSocket;
  participantId: string | null;
  displayName: string | null;
}

class MeetingNotesCollabServerManager {
  private wss: WebSocketServer | null = null;
  private clients: Map<WebSocket, ClientState> = new Map();
  private participants: Map<string, CollabParticipant> = new Map();

  private sessionId: string | null = null;
  /** Derived from sessionId "note:<id>"; the note this session edits. */
  private sessionNoteId: string | null = null;
  private hostName: string | null = null;
  private sessionCode: string | null = null;
  private boundIp: string | null = null;
  private boundPort: number | null = null;
  /** True when the bound address is IPv6 — invite string wraps in brackets. */
  private boundIsIpv6: boolean = false;
  private firewallRuleName: string | null = null;

  private currentNotes: string = '';
  private version: number = 0;

  // ── Public state ──────────────────────────────────────────────────────────

  isActive(): boolean { return this.wss !== null; }

  getInfo(): CollabServerInfo {
    const host = this.boundIsIpv6 ? `[${this.boundIp}]` : this.boundIp;
    return {
      active: this.isActive(),
      sessionId: this.sessionId,
      sessionNoteId: this.sessionNoteId,
      hostName: this.hostName,
      ip: this.boundIp,
      port: this.boundPort,
      sessionCode: this.sessionCode,
      inviteString:
        host && this.boundPort && this.sessionCode
          ? `${host}:${this.boundPort}|${this.sessionCode}`
          : null,
      participants: Array.from(this.participants.values()),
      version: this.version,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(opts: {
    sessionId: string;
    hostName: string;
    notes: string;
    version?: number;
  }): Promise<CollabServerInfo> {
    // Idempotent: if already running for this session, just return current info.
    if (this.wss) {
      if (this.sessionId === opts.sessionId) return this.getInfo();
      // Different session — stop the old one first.
      await this.stop();
    }

    this.sessionId = opts.sessionId;
    this.sessionNoteId = opts.sessionId.startsWith('note:')
      ? opts.sessionId.slice(5)
      : null;
    this.hostName = (opts.hostName || 'Host').slice(0, 64);
    this.currentNotes = opts.notes;
    this.version = opts.version ?? 0;
    this.sessionCode = this.generateCode();

    const detected = this.detectLanAddress();
    if (!detected) {
      throw new Error(
        'Could not detect a LAN address. ' +
        'Make sure you are connected to a local network.',
      );
    }
    this.boundIp = detected.address;
    this.boundIsIpv6 = detected.family === 'IPv6';

    // Bind to dual-stack (::) so v4 and v6 clients both connect when an
    // IPv6 address is what the host advertises. For v4-only hosts the
    // 0.0.0.0 bind is fine.
    const bindHost = this.boundIsIpv6 ? '::' : '0.0.0.0';

    await new Promise<void>((resolve, reject) => {
      const wss = new WebSocketServer({ host: bindHost, port: 0 });
      wss.once('listening', () => {
        const addr = wss.address();
        if (typeof addr === 'object' && addr) this.boundPort = addr.port;
        this.wss = wss;
        resolve();
      });
      wss.once('error', reject);
      wss.on('connection', (ws: WebSocket) => this.handleConnection(ws));
    });

    if (this.boundPort) {
      this.addWindowsFirewallRule(this.boundPort);
      this.addMacFirewallRule();
    }
    this.pushStateToRenderer();
    return this.getInfo();
  }

  async stop(): Promise<void> {
    if (!this.wss) return;
    this.removeWindowsFirewallRule();
    this.broadcast({ type: 'collab_ended' });
    for (const ws of this.clients.keys()) {
      try { ws.close(1000, 'host stopped'); } catch { /* ignore */ }
    }
    await new Promise<void>((resolve) => { this.wss!.close(() => resolve()); });
    this.wss = null;
    this.clients.clear();
    this.participants.clear();
    this.sessionId = null;
    this.sessionNoteId = null;
    this.hostName = null;
    this.sessionCode = null;
    this.boundIp = null;
    this.boundPort = null;
    this.boundIsIpv6 = false;
    this.version = 0;
    this.pushStateToRenderer();
  }

  /**
   * Called when the HOST is typing — broadcasts a live draft preview so
   * participants see keystrokes in real-time without requiring an explicit save.
   */
  notifyDraft(content: string, hostName: string): void {
    if (!this.isActive()) return;
    this.broadcast({ type: 'draft', content, peerId: 'host', peerName: hostName });
  }

  /**
   * Called when the HOST saves notes locally (e.g. via the Edit UI).
   * Broadcasts the update to all connected participants so they see the
   * latest content without polling.
   */
  notifyNotesSaved(notes: string, savedBy: string): void {
    if (!this.isActive()) return;
    this.currentNotes = notes;
    this.version++;
    this.broadcast({ type: 'saved', content: notes, version: this.version, savedBy });
    this.pushStateToRenderer();
  }

  // ── Connection handling ───────────────────────────────────────────────────

  private handleConnection(ws: WebSocket): void {
    const state: ClientState = { socket: ws, participantId: null, displayName: null };
    this.clients.set(ws, state);
    ws.on('message', (raw: RawData) => this.handleMessage(state, raw.toString()));
    ws.on('close', () => this.handleDisconnect(state));
    ws.on('error', (err: Error) => {
      console.warn('[NotesCollabServer] client error:', err.message);
    });
  }

  private handleMessage(state: ClientState, raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── join ────────────────────────────────────────────────────────────────
    if (msg.type === 'join') {
      if (msg.sessionCode !== this.sessionCode) {
        this.send(state.socket, { type: 'rejected', reason: 'Invalid session code' });
        try { state.socket.close(4001, 'invalid code'); } catch { /* ignore */ }
        return;
      }
      const displayName = String(msg.displayName ?? 'Viewer').slice(0, 64).trim() || 'Viewer';
      const participantId = crypto.randomUUID();
      state.participantId = participantId;
      state.displayName = displayName;

      const p: CollabParticipant = { id: participantId, displayName, joinedAt: Date.now() };
      this.participants.set(participantId, p);

      this.send(state.socket, {
        type: 'welcome',
        sessionId: this.sessionId,
        sessionNoteId: this.sessionNoteId,
        notes: this.currentNotes,
        version: this.version,
        participants: Array.from(this.participants.values()),
        hostName: this.hostName,
        participantId,
      });

      // Tell everyone (including host) about the new participant
      this.broadcast(
        { type: 'presence', participants: Array.from(this.participants.values()) },
      );
      this.pushStateToRenderer();
      return;
    }

    // Remaining message types require an authenticated participant
    if (!state.participantId) return;

    // ── draft ──────────────────────────────────────────────────────────────
    if (msg.type === 'draft') {
      // Relay live typing preview to all OTHER participants (and the host renderer)
      this.broadcast(
        { type: 'draft', content: String(msg.content ?? ''), peerId: state.participantId, peerName: state.displayName },
        state.socket,
      );
      // Also forward to host's renderer so the host sees "X is editing…"
      this.pushDraftToRenderer(String(msg.content ?? ''), state.participantId!, state.displayName!);
      return;
    }

    // ── save_request ───────────────────────────────────────────────────────
    if (msg.type === 'save_request') {
      const content = String(msg.content ?? '');
      this.currentNotes = content;
      this.version++;
      // Persist to the host's local DB immediately
      this.persistNotes(content);
      const savedMsg = {
        type: 'saved',
        content,
        version: this.version,
        savedBy: state.displayName ?? 'Participant',
      };
      // Broadcast the committed version to everyone
      this.broadcast(savedMsg);
      // Also notify the host's renderer
      this.pushNotesSavedToRenderer(content, state.displayName ?? 'Participant');
      return;
    }
  }

  private handleDisconnect(state: ClientState): void {
    this.clients.delete(state.socket);
    if (state.participantId) {
      this.participants.delete(state.participantId);
      this.broadcast(
        { type: 'presence', participants: Array.from(this.participants.values()) },
      );
      this.pushStateToRenderer();
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private broadcast(msg: object, exclude?: WebSocket): void {
    const json = JSON.stringify(msg);
    for (const [ws, state] of this.clients) {
      if (ws === exclude) continue;
      if (!state.participantId) continue; // not yet authenticated
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(json); } catch { /* ignore */ }
      }
    }
  }

  private send(ws: WebSocket, msg: object): void {
    try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }

  private persistNotes(notes: string): void {
    if (!this.sessionId) return;
    // Generic note collab (from NotesPage) uses sessionIds prefixed with
    // "note:<id>". Those are client-side notes stored in localStorage — the
    // renderer handles persistence when it receives the 'saved' broadcast.
    // Skip the meetings-DB write to avoid creating orphan meeting rows.
    if (this.sessionId.startsWith('note:')) return;
    try {
      native.addon.meetingSetStructuredOutput(
        this.sessionId,
        JSON.stringify({
          sections: [{ key: 'summary', title: 'Summary', content: notes }],
          plainSummary: notes,
          processingState: 'done',
          hasUserEdits: true,
          collaborativeEdit: true,
          savedAt: new Date().toISOString(),
        }),
      );
    } catch (err) {
      console.error('[NotesCollabServer] Failed to persist notes:', err);
    }
  }

  private pushStateToRenderer(): void {
    const info = this.getInfo();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('ironmic:meeting-collab-state', info);
      }
    }
  }

  private pushNotesSavedToRenderer(notes: string, savedBy: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('ironmic:meeting-collab-notes-updated', {
          notes, savedBy, version: this.version, sessionId: this.sessionId,
        });
      }
    }
  }

  private pushDraftToRenderer(content: string, peerId: string, peerName: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('ironmic:meeting-collab-draft', { content, peerId, peerName });
      }
    }
  }

  private addWindowsFirewallRule(port: number): void {
    if (process.platform !== 'win32') return;
    const name = `IronMic-Collab-${port}`;
    this.firewallRuleName = name;
    exec(
      `netsh advfirewall firewall add rule name="${name}" dir=in action=allow protocol=TCP localport=${port}`,
      (err) => {
        if (err) {
          console.warn(
            `[NotesCollabServer] Could not add Windows Firewall rule for port ${port}: ${err.message}`,
          );
          this.notifyFirewallIssue(
            'Windows Firewall blocked IronMic from auto-allowing collaboration. ' +
            'Open Windows Security \u2192 Firewall & network protection \u2192 ' +
            'Allow an app through firewall, then enable IronMic on Private networks.',
          );
        } else {
          console.info(`[NotesCollabServer] Windows Firewall rule added: ${name}`);
        }
      },
    );
  }

  private removeWindowsFirewallRule(): void {
    if (process.platform !== 'win32' || !this.firewallRuleName) return;
    const name = this.firewallRuleName;
    this.firewallRuleName = null;
    exec(`netsh advfirewall firewall delete rule name="${name}"`, () => {});
  }

  /**
   * macOS application firewall is per-app, not per-port. Adding the running
   * IronMic binary as an allowed app + unblocking it covers inbound LAN
   * connections. Requires the firewall daemon to be enabled; failures are
   * non-fatal and surfaced to the renderer.
   */
  private addMacFirewallRule(): void {
    if (process.platform !== 'darwin') return;
    const appPath = app.getPath('exe');
    const fw = '/usr/libexec/ApplicationFirewall/socketfilterfw';
    exec(`"${fw}" --add "${appPath}" && "${fw}" --unblockapp "${appPath}"`, (err) => {
      if (err) {
        // socketfilterfw needs root for --add. We try anyway in case the
        // user pre-approved IronMic; surface a hint if it failed.
        this.notifyFirewallIssue(
          'macOS Firewall may block participants from reaching this Mac. ' +
          'Open System Settings \u2192 Network \u2192 Firewall \u2192 Options, ' +
          'add IronMic and set it to Allow incoming connections.',
        );
      }
    });
  }

  private notifyFirewallIssue(message: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('ironmic:meeting-collab-firewall-warning', { message });
      }
    }
  }

  /**
   * Pick the best LAN address to advertise. Prefer IPv4 (better firewall
   * support, simpler UX) and fall back to non-link-local IPv6 if no IPv4
   * is available. Skips loopback, virtual, VPN, and link-local addresses.
   */
  private detectLanAddress(): { address: string; family: 'IPv4' | 'IPv6' } | null {
    const ifaces = os.networkInterfaces();
    type Cand = { name: string; address: string; family: 'IPv4' | 'IPv6' };
    const candidates: Cand[] = [];
    const virtualInterfacePattern = /(loopback|virtual|vmware|virtualbox|vbox|hyper-v|vethernet|wsl|docker|bluetooth|tailscale|zerotier|utun|awdl|bridge|tunnel|vpn)/i;
    for (const name of Object.keys(ifaces)) {
      if (/^(lo|docker|veth|tun|tap|utun|bridge|llw|awdl|anpi)/i.test(name)) continue;
      if (virtualInterfacePattern.test(name)) continue;
      for (const addr of ifaces[name] ?? []) {
        if (addr.internal) continue;
        if (addr.family === 'IPv4') {
          if (addr.address.startsWith('169.254.')) continue;
          candidates.push({ name, address: addr.address, family: 'IPv4' });
        } else if (addr.family === 'IPv6') {
          // skip link-local and unique-local fc00::/7? keep ULA, drop fe80
          if (addr.address.toLowerCase().startsWith('fe80')) continue;
          candidates.push({ name, address: addr.address.split('%')[0], family: 'IPv6' });
        }
      }
    }
    candidates.sort((a, b) => {
      const score = (c: Cand) => {
        let s = 100;
        if (c.family === 'IPv4') s -= 50; // strongly prefer IPv4
        const nm = c.name.toLowerCase();
        if (/(wi-?fi|wlan|wireless|ethernet|en\d+|eth\d+)/i.test(nm)) s -= 20;
        if (c.family === 'IPv4') {
          if (c.address.startsWith('192.168.')) s -= 6;
          else if (c.address.startsWith('10.')) s -= 5;
          else if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(c.address)) s -= 4;
        }
        return s;
      };
      return score(a) - score(b);
    });
    const best = candidates[0];
    return best ? { address: best.address, family: best.family } : null;
  }

  private generateCode(): string {
    const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from(crypto.randomBytes(6))
      .map(b => alpha[b % alpha.length])
      .join('');
  }
}

export const meetingNotesCollabServer = new MeetingNotesCollabServerManager();
