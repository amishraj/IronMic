import { Users } from 'lucide-react';
import { useMeetingStore } from '../stores/useMeetingStore';

/**
 * MeetingRoomPanel — participants list, shown to the host and joiners during
 * an active LAN meeting room. The invite block (address + room code + copy)
 * lives in InviteDetailsPanel and is toggled separately by the Collaborate
 * button in MeetingPage so a host can hide it during screen-share.
 */
export function MeetingRoomPanel() {
  const { roomCode, roomHostIp, roomHostPort, roomParticipants } = useMeetingStore();

  // Only render once the room is established. Participants list is empty
  // during the brief "starting room" window, but we don't want a flash of
  // "Waiting for participants" before the room info even arrives.
  if (!roomCode || !roomHostIp || !roomHostPort) return null;

  return (
    <div className="border border-iron-border bg-iron-surface/50 rounded-lg p-3">
      <div className="flex items-center gap-2 mb-2">
        <Users className="w-3.5 h-3.5 text-iron-text-muted" />
        <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">
          Participants ({roomParticipants.length})
        </p>
      </div>
      {roomParticipants.length === 0 ? (
        <p className="text-[11px] text-iron-text-muted">
          Waiting for participants. Share the invite string with them.
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
  );
}
