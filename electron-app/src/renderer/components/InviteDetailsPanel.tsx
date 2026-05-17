import { useState } from 'react';
import { Copy, Check, Wifi } from 'lucide-react';
import { useMeetingStore } from '../stores/useMeetingStore';

/**
 * InviteDetailsPanel — host-only invite block (address, room code, copy button).
 * Visibility is controlled by the Collaborate toggle in MeetingPage; the
 * participants list is rendered separately so it stays visible regardless.
 */
export function InviteDetailsPanel() {
  const { roomCode, roomHostIp, roomHostPort, roomInviteString } = useMeetingStore();
  const [copied, setCopied] = useState(false);

  if (!roomCode || !roomHostIp || !roomHostPort) return null;

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

      {/* Two-up on wide; stacked on narrow.
          `min-w-0` lets the children shrink below intrinsic content width so
          the address+port string ("10.147.59.102:63184" — 18 chars) can wrap
          via `break-all` instead of bleeding into the Room Code cell. The old
          `grid-cols-2` layout had no min-width-0 and so the IP/port forced
          the column wider than its share, overlapping the next column. */}
      <div className="flex flex-col sm:grid sm:grid-cols-2 gap-3">
        <div className="min-w-0">
          <p className="text-[10px] text-iron-text-muted uppercase tracking-wider mb-1">Address</p>
          <p className="text-sm font-mono text-iron-text break-all">{roomHostIp}:{roomHostPort}</p>
        </div>
        <div className="min-w-0">
          <p className="text-[10px] text-iron-text-muted uppercase tracking-wider mb-1">Room Code</p>
          <p className="text-sm font-mono text-iron-accent-light tracking-widest break-all">{roomCode}</p>
        </div>
      </div>

      <button
        onClick={handleCopy}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium bg-iron-accent/15 text-iron-accent-light rounded-lg border border-iron-accent/20 hover:bg-iron-accent/25 transition-colors"
      >
        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        {copied ? 'Copied invite' : 'Copy invite string'}
      </button>
    </div>
  );
}
