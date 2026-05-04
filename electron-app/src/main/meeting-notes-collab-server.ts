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
import * as net from 'net';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { app, BrowserWindow, shell } from 'electron';
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
  /** True once we've shown the macOS firewall guidance this session, to avoid re-nagging. */
  private firewallPromptedThisSession: boolean = false;

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
      // Loopback bind sanity check — proves the socket is listening locally.
      // It does NOT prove a remote host can pass the OS firewall; the guidance
      // copy in notifyFirewallIssue() makes that distinction.
      this.runLoopbackBindCheck(this.boundPort).catch(() => { /* warning emitted inside */ });
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
    this.firewallPromptedThisSession = false;
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
    // Generic note collab uses sessionIds prefixed with "note:<id>". Those
    // are client-side notes stored in localStorage — the renderer handles
    // persistence when it receives the 'saved' broadcast. Skip the
    // meetings-DB write to avoid creating orphan meeting rows.
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
   * connections. `socketfilterfw --add` requires root; on failure we surface
   * a renderer modal with two recovery actions (open settings, or run an
   * elevated AppleScript that adds the rule).
   */
  private addMacFirewallRule(): void {
    if (process.platform !== 'darwin') return;
    const appPath = this.getMacAppPath();
    const fw = '/usr/libexec/ApplicationFirewall/socketfilterfw';
    exec(`"${fw}" --add "${appPath}" && "${fw}" --unblockapp "${appPath}"`, (err) => {
      if (err && !this.firewallPromptedThisSession) {
        this.firewallPromptedThisSession = true;
        this.notifyFirewallIssue(
          'macOS Firewall is blocking inbound connections to IronMic. ' +
          'Participants on other machines (especially Windows) will time out ' +
          'when trying to join. Allow IronMic now to fix it.',
          ['open-settings', 'elevate'],
        );
      }
    });
  }

  /**
   * Resolve the path that macOS Application Firewall should allow. In packaged
   * builds this is the .app bundle ("/Applications/IronMic.app"), not the
   * helper executable. In dev we fall back to the Electron binary.
   */
  private getMacAppPath(): string {
    if (!app.isPackaged) return app.getPath('exe');
    // exe path is like /Applications/IronMic.app/Contents/MacOS/IronMic
    const exe = app.getPath('exe');
    const idx = exe.indexOf('.app/');
    if (idx === -1) return exe;
    return exe.slice(0, idx + 4); // include ".app"
  }

  /**
   * Open the macOS Firewall pane in System Settings. Triggered by the user
   * clicking the "Open Firewall settings" action on the warning modal.
   */
  openMacFirewallSettings(): void {
    if (process.platform !== 'darwin') return;
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Firewall')
      .catch((err) => console.warn('[NotesCollabServer] openExternal failed:', err));
  }

  /**
   * Run socketfilterfw --add + --unblockapp under `osascript` with admin
   * privileges. Triggered by the user clicking "Allow with admin password".
   * Returns ok=true on success; ok=false with a message otherwise.
   */
  async requestMacFirewallElevation(): Promise<{ ok: boolean; message?: string }> {
    if (process.platform !== 'darwin') {
      return { ok: false, message: 'Only available on macOS' };
    }
    const appPath = this.getMacAppPath();
    const fw = '/usr/libexec/ApplicationFirewall/socketfilterfw';
    // Escape for the inner shell: backslash-quotes inside a double-quoted bash
    // arg, then backslash-quote those for the AppleScript string literal.
    const shellQuote = (s: string) => `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
    const innerCmd = `${shellQuote(fw)} --add ${shellQuote(appPath)} && ${shellQuote(fw)} --unblockapp ${shellQuote(appPath)}`;
    // For AppleScript we need to escape backslashes and double-quotes again.
    const appleScriptInner = innerCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `do shell script "${appleScriptInner}" with administrator privileges`;
    return new Promise((resolve) => {
      exec(`osascript -e ${shellQuote(script)}`, (err, _stdout, stderr) => {
        if (err) {
          // User cancelled, or osascript reported an error.
          const msg = (stderr || err.message || '').trim();
          const cancelled = /User cancelled|-128/i.test(msg);
          resolve({
            ok: false,
            message: cancelled
              ? 'Firewall change was cancelled.'
              : `Could not allow IronMic through the firewall: ${msg}`,
          });
          return;
        }
        // Success \u2014 refresh the loopback check and clear the prompt latch so
        // a future failure can re-prompt.
        this.firewallPromptedThisSession = false;
        resolve({ ok: true });
      });
    });
  }

  /**
   * Confirms the WSS is actually accepting on the bound port from this same
   * machine. Useful as a sanity check that bind succeeded \u2014 does NOT prove
   * remote reachability through the OS firewall.
   */
  private async runLoopbackBindCheck(port: number): Promise<void> {
    // Always loopback over IPv4 — both 0.0.0.0 and dual-stack :: accept 127.0.0.1
    // connections. ::1 alone is flaky on dual-stack binds across platforms.
    // Only warn the user if the WSS itself has stopped listening; transient
    // connect errors during normal session start aren't worth alarming about.
    if (!this.wss) return;
    await new Promise<void>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port, family: 4 });
      let settled = false;
      const done = (ok: boolean, err?: Error) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch { /* ignore */ }
        if (!ok && this.wss) {
          // Server is still up but loopback failed — log only, don't alarm
          // the user (most often a benign timing race during startup).
          console.warn(
            `[NotesCollabServer] loopback sanity check failed on port ${port}` +
            (err ? `: ${err.message}` : ''),
          );
        }
        resolve();
      };
      socket.once('connect', () => done(true));
      socket.once('error', (err) => done(false, err));
      setTimeout(() => done(false, new Error('loopback connect timed out')), 5000);
    });
  }

  private notifyFirewallIssue(
    message: string,
    actions: Array<'open-settings' | 'elevate'> = [],
  ): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('ironmic:meeting-collab-firewall-warning', { message, actions });
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
    const virtualInterfacePattern = /(loopback|virtual|vmware|virtualbox|vbox|vmnet|vboxnet|hyper-v|vethernet|wsl|docker|bluetooth|tailscale|zerotier|utun|awdl|bridge|tunnel|vpn)/i;
    for (const name of Object.keys(ifaces)) {
      if (/^(lo|docker|veth|tun|tap|utun|bridge|llw|awdl|anpi|vmnet|vboxnet)/i.test(name)) continue;
      if (virtualInterfacePattern.test(name)) continue;
      for (const addr of ifaces[name] ?? []) {
        if (addr.internal) continue;
        if (addr.family === 'IPv4') {
          if (addr.address.startsWith('169.254.')) continue;
          // CGNAT (RFC 6598, 100.64.0.0/10) — used by Tailscale and some
          // carrier NATs; not reachable from peers on the regular LAN.
          if (this.isCgnatV4(addr.address)) continue;
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

  /** True if the IPv4 address falls in 100.64.0.0/10 (RFC 6598 CGNAT). */
  private isCgnatV4(address: string): boolean {
    const parts = address.split('.');
    if (parts.length !== 4) return false;
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    if (a !== 100) return false;
    return b >= 64 && b <= 127;
  }

  private generateCode(): string {
    const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from(crypto.randomBytes(6))
      .map(b => alpha[b % alpha.length])
      .join('');
  }
}

export const meetingNotesCollabServer = new MeetingNotesCollabServerManager();
