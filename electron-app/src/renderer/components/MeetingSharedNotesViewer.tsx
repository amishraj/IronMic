/**
 * MeetingSharedNotesViewer — rendered when a PARTICIPANT connects to a host's
 * notes collaboration session.
 *
 * Shows the meeting notes, lets the participant edit them, and syncs changes
 * back to the host (who persists and re-broadcasts).  Presence indicators
 * show who else is viewing.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, Save, Users, Wifi, WifiOff, Loader2, Pencil, X } from 'lucide-react';
import type { CollabParticipant } from './MeetingCollaboratePanel';

interface Props {
  hostName: string | null;
  initialNotes: string;
  participants: CollabParticipant[];
  onLeave: () => void;
}

export function MeetingSharedNotesViewer({
  hostName,
  initialNotes,
  participants: initialParticipants,
  onLeave,
}: Props) {
  const [notes, setNotes] = useState(initialNotes);
  const [participants, setParticipants] = useState<CollabParticipant[]>(initialParticipants);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialNotes);
  const [saving, setSaving] = useState(false);
  const [savedBy, setSavedBy] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);
  const [drafting, setDrafting] = useState<{ peerName: string } | null>(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Notes updated by host or another participant
    const unsubNotes = window.ironmic?.onMeetingCollabNotesUpdated?.((data: any) => {
      setNotes(data.notes ?? '');
      setDraft(data.notes ?? '');
      setSavedBy(data.savedBy ?? null);
      setTimeout(() => setSavedBy(null), 3000);
    });

    // State updates (presence, connection)
    const unsubState = window.ironmic?.onMeetingCollabState?.((info: any) => {
      setConnected(info?.connected ?? false);
      setParticipants(info?.participants ?? []);
    });

    // Draft preview from another participant
    const unsubDraft = window.ironmic?.onMeetingCollabDraft?.((data: any) => {
      setDrafting({ peerName: data.peerName });
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      draftTimerRef.current = setTimeout(() => setDrafting(null), 3000);
    });

    // Host ended the session
    const unsubEnded = window.ironmic?.onMeetingCollabEnded?.(() => {
      setConnected(false);
    });

    return () => {
      unsubNotes?.();
      unsubState?.();
      unsubDraft?.();
      unsubEnded?.();
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      if (draftSendTimerRef.current) clearTimeout(draftSendTimerRef.current);
    };
  }, []);

  // Throttled draft send (every 1 s while typing)
  const handleDraftChange = useCallback((value: string) => {
    setDraft(value);
    if (draftSendTimerRef.current) clearTimeout(draftSendTimerRef.current);
    draftSendTimerRef.current = setTimeout(() => {
      window.ironmic?.meetingCollabSendDraft?.(value).catch(() => {});
    }, 800);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await window.ironmic.meetingCollabSaveNotes(draft);
      // The host will broadcast 'saved' → onMeetingCollabNotesUpdated fires → setNotes
      setEditing(false);
    } catch (err) {
      console.error('[SharedNotesViewer] Save failed:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleLeave = async () => {
    try { await window.ironmic.meetingCollabLeave(); } catch { /* ignore */ }
    onLeave();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-iron-border bg-iron-surface shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={handleLeave}
            className="p-1.5 rounded-lg text-iron-text-muted hover:bg-iron-surface-hover transition-colors"
            title="Leave shared session"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-iron-text truncate">
                {hostName ? `${hostName}'s Meeting` : 'Shared Meeting'}
              </p>
              {connected ? (
                <span className="flex items-center gap-1 text-[10px] text-green-400 bg-green-500/10 border border-green-500/20 px-1.5 py-0.5 rounded-full">
                  <Wifi className="w-2.5 h-2.5" />
                  Connected
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[10px] text-iron-text-muted bg-iron-surface-hover px-1.5 py-0.5 rounded-full">
                  <WifiOff className="w-2.5 h-2.5" />
                  Disconnected
                </span>
              )}
            </div>
            {savedBy && (
              <p className="text-[10px] text-green-400/80">Saved by {savedBy}</p>
            )}
            {drafting && !savedBy && (
              <p className="text-[10px] text-amber-400/80">{drafting.peerName} is editing…</p>
            )}
          </div>
        </div>

        {/* Presence + actions */}
        <div className="flex items-center gap-2">
          {/* Participant avatars */}
          {participants.length > 0 && (
            <div className="flex items-center gap-1">
              <Users className="w-3 h-3 text-iron-text-muted" />
              <div className="flex -space-x-1">
                {participants.slice(0, 4).map((p) => (
                  <div
                    key={p.id}
                    title={p.displayName}
                    className="w-5 h-5 rounded-full bg-iron-accent/20 border border-iron-border flex items-center justify-center text-[9px] font-semibold text-iron-accent-light uppercase"
                  >
                    {p.displayName.charAt(0)}
                  </div>
                ))}
                {participants.length > 4 && (
                  <div className="w-5 h-5 rounded-full bg-iron-surface-hover border border-iron-border flex items-center justify-center text-[9px] text-iron-text-muted">
                    +{participants.length - 4}
                  </div>
                )}
              </div>
            </div>
          )}

          {editing ? (
            <>
              <button
                onClick={() => { setEditing(false); setDraft(notes); }}
                className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-iron-text-muted rounded-lg border border-iron-border hover:bg-iron-surface-hover transition-colors"
              >
                <X className="w-3.5 h-3.5" />
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !connected}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-iron-accent/15 text-iron-accent-light rounded-lg border border-iron-accent/20 hover:bg-iron-accent/25 transition-colors disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            <button
              onClick={() => { setEditing(true); setDraft(notes); }}
              disabled={!connected}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-iron-text-muted rounded-lg border border-iron-border hover:bg-iron-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title={connected ? 'Edit notes' : 'Reconnect to edit'}
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6">
          {!connected && (
            <div className="mb-4 text-xs text-iron-text-muted bg-iron-surface-hover border border-iron-border/50 rounded-lg px-4 py-3">
              The host has ended the collaboration session. The notes shown below are the last synced version.
            </div>
          )}

          {editing ? (
            <textarea
              value={draft}
              onChange={(e) => handleDraftChange(e.target.value)}
              autoFocus
              className="w-full min-h-[400px] bg-iron-surface border border-iron-border rounded-lg px-3 py-2 text-sm text-iron-text leading-relaxed focus:outline-none focus:border-iron-accent/40 font-mono resize-none"
              placeholder="Write your meeting notes here…"
            />
          ) : (
            <div className="text-sm text-iron-text leading-relaxed whitespace-pre-wrap">
              {notes || (
                <span className="text-iron-text-muted italic">No notes yet.</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
