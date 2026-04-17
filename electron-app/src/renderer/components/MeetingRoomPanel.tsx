import { useState } from 'react';
import { Copy, Check, Users, Wifi } from 'lucide-react';
import { useMeetingStore } from '../stores/useMeetingStore';

/**
 * MeetingRoomPanel — invite display and participants list, shown to the host
 * during an active LAN meeting room.
 */
export function MeetingRoomPanel() {
  const {
    roomCode, roomHostIp, roomHostPort, roomInviteString, roomParticipants,
  } = useMeetingStore();
  const [copied, setCopied] = useState(false);

  if (!roomCode || !roomHostIp || !roomHostPort) {
    return null;
  }

  const handleCopy = async () => {
    if (!roomInviteString) return;
    try {
      await navigator.clipboard.writeText(roomInviteString);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* ignore */ }
  };

  return (
    <div className="border border-iron-accent/20 bg-iron-accent/5 rounded-lg p-3 space-y-3">
      <div className="flex items-center gap-2">
        <Wifi className="w-3.5 h-3.5 text-iron-accent-light" />
        <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">
          Room is live
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-[10px] text-iron-text-muted uppercase tracking-wider mb-1">Address</p>
          <p className="text-sm font-mono text-iron-text">{roomHostIp}:{roomHostPort}</p>
        </div>
        <div>
          <p className="text-[10px] text-iron-text-muted uppercase tracking-wider mb-1">Room Code</p>
          <p className="text-sm font-mono text-iron-accent-light tracking-widest">{roomCode}</p>
        </div>
      </div>

      <button
        onClick={handleCopy}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium bg-iron-accent/15 text-iron-accent-light rounded-lg border border-iron-accent/20 hover:bg-iron-accent/25 transition-colors"
      >
        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        {copied ? 'Copied invite' : 'Copy invite string'}
      </button>

      <div>
        <div className="flex items-center gap-2 mb-2">
          <Users className="w-3.5 h-3.5 text-iron-text-muted" />
          <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">
            Participants ({roomParticipants.length})
          </p>
        </div>
        {roomParticipants.length === 0 ? (
          <p className="text-[11px] text-iron-text-muted">
            Waiting for participants. Share the invite string above.
          </p>
        ) : (
          <ul className="space-y-1">
            {roomParticipants.map(p => (
              <li key={p.id} className="flex items-center gap-2 text-xs text-iron-text">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                {p.displayName}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
