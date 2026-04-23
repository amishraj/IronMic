/**
 * NotesCollaborateModal — generic "collaborate on any note" modal.
 *
 * Tabs:
 *   - Create: starts a collab session for the active note (host). Uses the
 *     note ID as the session key with a "note:" prefix so the server knows
 *     not to write it to the meetings DB.
 *   - Join:   connects to someone else's note collab session as a
 *     participant. The joined note content is shown read-only-ish in a
 *     viewer panel until the user clicks "Edit".
 *
 * This reuses the existing meeting-notes collab WebSocket infrastructure
 * (server/client IPC, presence, draft/saved events) so the UX matches the
 * "Collaborate" button on a finished meeting exactly.
 */

import { useState, useEffect, useRef } from 'react';
import {
  Users, Copy, CheckCheck, Wifi, WifiOff, X, Loader2, Pencil, LogIn, Plus,
} from 'lucide-react';

interface Props {
  /** ID of the note the host wants to share, or null for join-only mode. */
  noteId: string | null;
  /** Initial contents for the Create flow. */
  initialNotes: string;
  /** Called with the latest notes when a remote save arrives (host side). */
  onNotesUpdated?: (notes: string, savedBy: string) => void;
  /** Called when a Join succeeds — parent typically opens a viewer. */
  onJoined?: (info: { sessionId: string; hostName: string; notes: string }) => void;
  onClose: () => void;
}

type Tab = 'create' | 'join';

interface CollabParticipant { id: string; displayName: string; joinedAt: number }

export function NotesCollaborateModal({
  noteId,
  initialNotes,
  onNotesUpdated,
  onJoined,
  onClose,
}: Props) {
  const [tab, setTab] = useState<Tab>(noteId ? 'create' : 'join');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-iron-surface border border-iron-border rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-iron-border shrink-0">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-iron-accent-light" />
            <h2 className="text-sm font-medium text-iron-text">Collaborate on this note</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-iron-text-muted hover:bg-iron-surface-hover"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-iron-border shrink-0">
          <button
            disabled={!noteId}
            onClick={() => setTab('create')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors ${
              tab === 'create'
                ? 'text-iron-accent-light border-b-2 border-iron-accent'
                : 'text-iron-text-muted hover:text-iron-text disabled:opacity-40'
            }`}
          >
            <Plus className="w-3.5 h-3.5" />
            Create session
          </button>
          <button
            onClick={() => setTab('join')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors ${
              tab === 'join'
                ? 'text-iron-accent-light border-b-2 border-iron-accent'
                : 'text-iron-text-muted hover:text-iron-text'
            }`}
          >
            <LogIn className="w-3.5 h-3.5" />
            Join session
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'create' && noteId && (
            <CreatePanel
              noteId={noteId}
              initialNotes={initialNotes}
              onNotesUpdated={onNotesUpdated}
              onClose={onClose}
            />
          )}
          {tab === 'join' && (
            <JoinPanel onJoined={onJoined} onClose={onClose} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Create ──────────────────────────────────────────────────────────────────

function CreatePanel({
  noteId,
  initialNotes,
  onNotesUpdated,
  onClose,
}: {
  noteId: string;
  initialNotes: string;
  onNotesUpdated?: (notes: string, savedBy: string) => void;
  onClose?: () => void;
}) {
  const sessionId = `note:${noteId}`;
  const [collabInfo, setCollabInfo] = useState<any>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [ending, setEnding] = useState(false);
  const [drafting, setDrafting] = useState<{ peerId: string; peerName: string } | null>(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks live participant count in a ref so the cleanup function can read
  // the latest value without a stale closure.
  const participantsRef = useRef<CollabParticipant[]>([]);
  const [hostName] = useState(() => {
    try { return localStorage.getItem('ironmic-collab-display-name') || 'Host'; }
    catch { return 'Host'; }
  });

  // Start server + subscribe to events
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setStarting(true);
      setError(null);
      try {
        const info = await window.ironmic.meetingCollabStart(
          sessionId, hostName, initialNotes,
        );
        if (!cancelled) {
          setCollabInfo(info);
          participantsRef.current = info?.participants ?? [];
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? 'Could not start collaboration');
      } finally {
        if (!cancelled) setStarting(false);
      }
    })();

    const unsubState = window.ironmic?.onMeetingCollabState?.((info: any) => {
      if (!cancelled && info?.sessionId === sessionId) {
        setCollabInfo(info);
        participantsRef.current = info?.participants ?? [];
      }
    });
    const unsubNotes = window.ironmic?.onMeetingCollabNotesUpdated?.((data: any) => {
      if (cancelled) return;
      onNotesUpdated?.(data.notes, data.savedBy);
    });
    const unsubDraft = window.ironmic?.onMeetingCollabDraft?.((data: any) => {
      if (cancelled) return;
      setDrafting({ peerId: data.peerId, peerName: data.peerName });
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      draftTimerRef.current = setTimeout(() => setDrafting(null), 3000);
    });

    return () => {
      cancelled = true;
      unsubState?.();
      unsubNotes?.();
      unsubDraft?.();
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      // Keep the server alive when participants are still connected — the
      // parent page watches participant count and auto-stops when all leave.
      if (participantsRef.current.length === 0) {
        window.ironmic?.meetingCollabStop?.().catch(() => {});
      }
    };
  }, [sessionId, hostName]);

  const copyInvite = async () => {
    const invite = collabInfo?.inviteString;
    if (!invite) return;
    try {
      await window.ironmic.copyToClipboard(invite);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch { /* ignore */ }
  };

  const participants: CollabParticipant[] = collabInfo?.participants ?? [];

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-iron-text-muted leading-relaxed">
        You're hosting this note. Share the invite code with teammates on the
        same local network — they open IronMic, click Collaborate → Join, and
        paste the code. Everything stays on your LAN; no cloud relay.
      </p>

      <div className="flex items-center gap-2">
        {collabInfo?.active ? (
          <span className="flex items-center gap-1 text-[10px] text-green-400 bg-green-500/10 border border-green-500/20 px-2 py-1 rounded-full">
            <Wifi className="w-2.5 h-2.5" />
            Live
          </span>
        ) : starting ? (
          <span className="flex items-center gap-1 text-[10px] text-iron-text-muted">
            <Loader2 className="w-3 h-3 animate-spin" />
            Starting server…
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[10px] text-iron-text-muted bg-iron-surface-hover px-2 py-1 rounded-full">
            <WifiOff className="w-2.5 h-2.5" />
            Offline
          </span>
        )}
      </div>

      {error && (
        <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 leading-snug">
          {error}
        </div>
      )}

      {collabInfo?.active && (
        <>
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold text-iron-text-muted uppercase tracking-wider">
              Invite code
            </p>
            <div className="flex items-stretch gap-2">
              <div className="flex-1 font-mono text-[11px] bg-iron-surface-hover border border-iron-border rounded-lg px-3 py-2 text-iron-text select-all break-all leading-snug">
                {collabInfo.inviteString}
              </div>
              <button
                onClick={copyInvite}
                className={`flex items-center gap-1 px-2.5 py-2 text-[11px] rounded-lg border transition-colors shrink-0 ${
                  copied
                    ? 'bg-green-500/15 text-green-400 border-green-500/20'
                    : 'bg-iron-accent/10 text-iron-accent-light border-iron-accent/20 hover:bg-iron-accent/20'
                }`}
              >
                {copied ? <CheckCheck className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <div>
            <p className="text-[10px] font-semibold text-iron-text-muted uppercase tracking-wider mb-1.5">
              Connected
            </p>
            <p className="text-[11px] text-iron-text-muted mb-1.5">
              {participants.length === 0
                ? 'No one has joined yet.'
                : `${participants.length} viewer${participants.length === 1 ? '' : 's'} connected`}
            </p>
            {participants.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {participants.map((p) => (
                  <div
                    key={p.id}
                    className={`flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-full border transition-colors ${
                      drafting?.peerId === p.id
                        ? 'bg-amber-500/10 border-amber-500/20 text-amber-400'
                        : 'bg-iron-surface-hover border-iron-border text-iron-text'
                    }`}
                  >
                    <div className={`w-1.5 h-1.5 rounded-full ${
                      drafting?.peerId === p.id ? 'bg-amber-400' : 'bg-green-400'
                    }`} />
                    {p.displayName}
                    {drafting?.peerId === p.id && <Pencil className="w-2.5 h-2.5" />}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Explicit end-session control */}
          <div className="pt-2 border-t border-iron-border">
            <p className="text-[10px] text-iron-text-muted mb-2">
              Closing this panel keeps the session alive for connected participants.
              Use the button below to end it for everyone.
            </p>
            <button
              disabled={ending}
              onClick={async () => {
                setEnding(true);
                try {
                  await window.ironmic?.meetingCollabStop?.();
                } catch { /* ignore */ } finally {
                  setEnding(false);
                }
                onClose?.();
              }}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-red-400 bg-red-500/5 border border-red-500/15 rounded-lg hover:bg-red-500/15 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <X className="w-3.5 h-3.5" />
              {ending ? 'Ending…' : 'End session for everyone'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Join ────────────────────────────────────────────────────────────────────

function JoinPanel({
  onJoined,
  onClose,
}: {
  onJoined?: (info: { sessionId: string; hostName: string; notes: string }) => void;
  onClose: () => void;
}) {
  const [invite, setInvite] = useState('');
  const [displayName, setDisplayName] = useState(() => {
    try { return localStorage.getItem('ironmic-collab-display-name') || ''; }
    catch { return ''; }
  });
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleJoin = async () => {
    setError(null);
    const trimmed = invite.trim();
    // Expected format: "ip:port|sessionCode"
    const match = trimmed.match(/^([^:]+):(\d+)\|([A-Z0-9]+)$/);
    if (!match) {
      setError('Invite should look like "192.168.1.5:54321|ABC123DEF456".');
      return;
    }
    const name = displayName.trim() || 'Viewer';
    try {
      localStorage.setItem('ironmic-collab-display-name', name);
    } catch { /* ignore */ }

    setConnecting(true);
    try {
      const result: any = await window.ironmic.meetingCollabJoin({
        hostIp: match[1],
        hostPort: parseInt(match[2], 10),
        sessionCode: match[3],
        displayName: name,
      });
      onJoined?.({
        sessionId: result?.info?.sessionId ?? '',
        hostName: result?.info?.hostName ?? 'Host',
        notes: result?.notes ?? '',
      });
      onClose();
    } catch (err: any) {
      setError(err?.message ?? 'Could not join collaboration.');
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-iron-text-muted leading-relaxed">
        Paste the invite code someone shared with you. You'll see their note
        content live and can propose edits — saves sync to everyone connected.
      </p>

      <div className="space-y-1.5">
        <label className="text-[10px] font-semibold text-iron-text-muted uppercase tracking-wider">
          Your display name
        </label>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="e.g. Amish"
          className="w-full text-sm bg-iron-bg border border-iron-border rounded-lg px-3 py-2 text-iron-text placeholder:text-iron-text-muted focus:outline-none focus:border-iron-accent/50"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-[10px] font-semibold text-iron-text-muted uppercase tracking-wider">
          Invite code
        </label>
        <input
          value={invite}
          onChange={(e) => setInvite(e.target.value)}
          placeholder="192.168.1.5:54321|ABC123DEF456"
          className="w-full font-mono text-xs bg-iron-bg border border-iron-border rounded-lg px-3 py-2 text-iron-text placeholder:text-iron-text-muted focus:outline-none focus:border-iron-accent/50"
        />
      </div>

      {error && (
        <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 leading-snug">
          {error}
        </div>
      )}

      <button
        onClick={handleJoin}
        disabled={connecting || !invite.trim()}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium bg-iron-accent/15 text-iron-accent-light border border-iron-accent/20 rounded-lg hover:bg-iron-accent/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {connecting ? (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Connecting…
          </>
        ) : (
          <>
            <LogIn className="w-3.5 h-3.5" />
            Join session
          </>
        )}
      </button>
    </div>
  );
}
