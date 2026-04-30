/**
 * MeetingCollaboratePanel — shown by the HOST inside MeetingDetailPage.
 *
 * Responsibilities:
 *  - Start the notes collaboration WebSocket server for this session
 *  - Display the invite string so the host can copy & share it
 *  - Show a live presence list (who's connected and their draft state)
 *  - React to incoming saves from participants and call `onNotesUpdated`
 */

import { useState, useEffect, useRef } from 'react';
import { Users, Copy, CheckCheck, Wifi, WifiOff, X, Loader2, Pencil } from 'lucide-react';

export interface CollabParticipant {
  id: string;
  displayName: string;
  joinedAt: number;
}

interface Props {
  sessionId: string;
  /** Current notes text (passed so server can send to new joiners). */
  currentNotes: string;
  hostName: string;
  onClose: () => void;
  /** Called when a participant saves notes — host should apply the new content. */
  onNotesUpdated: (notes: string, savedBy: string) => void;
}

export function MeetingCollaboratePanel({
  sessionId,
  currentNotes,
  hostName,
  onClose,
  onNotesUpdated,
}: Props) {
  const [collabInfo, setCollabInfo] = useState<any>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [drafting, setDrafting] = useState<{ peerId: string; peerName: string; content: string } | null>(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep a ref to the latest onNotesUpdated so the subscription never captures
  // a stale closure (the effect only re-runs when sessionId changes, but
  // onNotesUpdated is a new arrow function on every parent render).
  const onNotesUpdatedRef = useRef(onNotesUpdated);
  useEffect(() => { onNotesUpdatedRef.current = onNotesUpdated; }, [onNotesUpdated]);

  // Start the collab server when this panel mounts
  useEffect(() => {
    let cancelled = false;
    const start = async () => {
      setStarting(true);
      setError(null);
      try {
        const info = await window.ironmic.meetingCollabStart(
          sessionId,
          hostName || 'Host',
          currentNotes,
        );
        if (!cancelled) setCollabInfo(info);
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? 'Could not start collaboration server');
      } finally {
        if (!cancelled) setStarting(false);
      }
    };
    start();

    // Subscribe to state updates (presence changes, etc.)
    const unsubState = window.ironmic?.onMeetingCollabState?.((info: any) => {
      if (!cancelled && info?.sessionId === sessionId) setCollabInfo(info);
    });

    // When a participant saves, call the latest onNotesUpdated via ref.
    const unsubNotes = window.ironmic?.onMeetingCollabNotesUpdated?.((data: any) => {
      if (!cancelled) onNotesUpdatedRef.current(data.notes, data.savedBy);
    });

    // Show "X is editing…" + their live draft content so the host can see what's changing.
    const unsubDraft = window.ironmic?.onMeetingCollabDraft?.((data: any) => {
      if (cancelled) return;
      setDrafting({ peerId: data.peerId, peerName: data.peerName, content: data.content ?? '' });
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      draftTimerRef.current = setTimeout(() => setDrafting(null), 4000);
    });

    return () => {
      cancelled = true;
      unsubState?.();
      unsubNotes?.();
      unsubDraft?.();
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      // Stop the server when the panel is closed
      window.ironmic?.meetingCollabStop?.().catch(() => {});
    };
  }, [sessionId]);

  // When notes change on the host side (host saved via Edit), broadcast to participants
  const prevNotesRef = useRef(currentNotes);
  useEffect(() => {
    if (currentNotes !== prevNotesRef.current && collabInfo?.active) {
      prevNotesRef.current = currentNotes;
      window.ironmic?.meetingCollabNotifySaved?.(currentNotes, hostName || 'Host').catch(() => {});
    }
  }, [currentNotes, collabInfo?.active]);

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
    <div className="bg-iron-surface border border-iron-border/80 rounded-xl p-4 space-y-3 shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="w-3.5 h-3.5 text-iron-accent-light" />
          <span className="text-[12px] font-semibold text-iron-text">Collaborate</span>
          {collabInfo?.active && (
            <span className="flex items-center gap-1 text-[10px] text-green-400 bg-green-500/10 border border-green-500/20 px-1.5 py-0.5 rounded-full">
              <Wifi className="w-2.5 h-2.5" />
              Live
            </span>
          )}
          {!collabInfo?.active && !starting && (
            <span className="flex items-center gap-1 text-[10px] text-iron-text-muted bg-iron-surface-hover px-1.5 py-0.5 rounded-full">
              <WifiOff className="w-2.5 h-2.5" />
              Offline
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded text-iron-text-muted hover:bg-iron-surface-hover transition-colors"
          aria-label="Close collaboration panel"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Loading */}
      {starting && (
        <div className="flex items-center gap-2 text-[11px] text-iron-text-muted py-1">
          <Loader2 className="w-3 h-3 animate-spin" />
          Starting collaboration server…
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 leading-snug">
          {error}
        </div>
      )}

      {/* Invite */}
      {collabInfo?.active && (
        <>
          <div className="space-y-1.5">
            <p className="text-[11px] text-iron-text-muted">
              Share this with colleagues on your local network:
            </p>
            <div className="flex items-stretch gap-2">
              <div className="flex-1 font-mono text-[11px] bg-iron-surface-hover border border-iron-border rounded-lg px-3 py-2 text-iron-text select-all break-all leading-snug">
                {collabInfo.inviteString}
              </div>
              <button
                onClick={copyInvite}
                title="Copy invite code"
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
            <p className="text-[10px] text-iron-text-muted">
              They open IronMic → Meetings → "Join shared notes" and paste this code.
            </p>
          </div>

          {/* Presence */}
          <div>
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
                    {drafting?.peerId === p.id && (
                      <Pencil className="w-2.5 h-2.5" />
                    )}
                  </div>
                ))}
              </div>
            )}
            {drafting && (
              <div className="mt-2 space-y-1">
                <p className="text-[10px] text-amber-400/80">
                  {drafting.peerName} is editing…
                </p>
                {drafting.content && (
                  <div className="text-[10px] text-iron-text-muted bg-iron-surface-hover border border-amber-500/15 rounded px-2 py-1.5 max-h-20 overflow-y-auto leading-relaxed line-clamp-4">
                    {drafting.content}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
