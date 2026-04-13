/**
 * NotificationPanel — Slide-out drawer showing ranked notifications.
 */

import { useEffect } from 'react';
import { X, Check, Trash2, Clock, Brain } from 'lucide-react';
import { useNotificationStore } from '../stores/useNotificationStore';
import type { Notification } from '../types';

export function NotificationPanel() {
  const {
    notifications,
    panelOpen,
    togglePanel,
    loadNotifications,
    markRead,
    act,
    dismiss,
    learningPhase,
  } = useNotificationStore();

  useEffect(() => {
    if (panelOpen) {
      loadNotifications();
    }
  }, [panelOpen]);

  if (!panelOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30" onClick={togglePanel} />

      {/* Panel */}
      <div className="relative w-80 max-w-full bg-iron-bg border-l border-iron-border shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-iron-border">
          <h3 className="text-sm font-semibold text-iron-text">Notifications</h3>
          <button
            onClick={togglePanel}
            className="p-1 rounded text-iron-text-muted hover:text-iron-text hover:bg-iron-surface-hover transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Learning indicator */}
        {learningPhase && (
          <div className="px-4 py-2 bg-iron-accent/5 border-b border-iron-border flex items-center gap-2 text-xs text-iron-text-muted">
            <Brain className="w-3.5 h-3.5 text-iron-accent" />
            Learning your preferences...
          </div>
        )}

        {/* Notifications list */}
        <div className="flex-1 overflow-y-auto">
          {notifications.length === 0 ? (
            <div className="p-8 text-center text-xs text-iron-text-muted">
              No notifications yet
            </div>
          ) : (
            <div className="divide-y divide-iron-border">
              {notifications.map((n) => (
                <NotificationCard
                  key={n.id}
                  notification={n}
                  onRead={() => markRead(n.id)}
                  onAct={() => act(n.id)}
                  onDismiss={() => dismiss(n.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function NotificationCard({
  notification,
  onRead,
  onAct,
  onDismiss,
}: {
  notification: Notification;
  onRead: () => void;
  onAct: () => void;
  onDismiss: () => void;
}) {
  const isUnread = !notification.readAt;
  const age = getRelativeTime(notification.createdAt);

  return (
    <div
      className={`px-4 py-3 hover:bg-iron-surface-hover transition-colors cursor-pointer ${
        isUnread ? 'bg-iron-accent/5' : ''
      }`}
      onClick={onRead}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            {isUnread && (
              <span className="w-1.5 h-1.5 rounded-full bg-iron-accent flex-shrink-0" />
            )}
            <span className="text-xs font-medium text-iron-text truncate">
              {notification.title}
            </span>
          </div>
          {notification.body && (
            <p className="text-[11px] text-iron-text-muted mt-0.5 line-clamp-2">
              {notification.body}
            </p>
          )}
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-[10px] text-iron-text-muted flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {age}
            </span>
            <span className="text-[10px] text-iron-text-muted px-1.5 py-0.5 bg-iron-surface rounded">
              {notification.source}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); onAct(); }}
            className="p-1 rounded text-iron-text-muted hover:text-green-400 hover:bg-green-500/10 transition-colors"
            title="Act on this"
          >
            <Check className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDismiss(); }}
            className="p-1 rounded text-iron-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
            title="Dismiss"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function getRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
