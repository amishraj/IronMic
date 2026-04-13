/**
 * NotificationBell — Bell icon with unread count badge.
 * Toggles the NotificationPanel on click.
 */

import { useEffect } from 'react';
import { Bell } from 'lucide-react';
import { useNotificationStore } from '../stores/useNotificationStore';

export function NotificationBell() {
  const { unreadCount, togglePanel, refreshUnreadCount } = useNotificationStore();

  useEffect(() => {
    refreshUnreadCount();
    // Refresh every 30 seconds
    const interval = setInterval(refreshUnreadCount, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <button
      onClick={togglePanel}
      className="relative p-1.5 rounded-lg text-iron-text-secondary hover:text-iron-text hover:bg-iron-surface-hover transition-colors"
      title="Notifications"
    >
      <Bell className="w-4 h-4" />
      {unreadCount > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 rounded-full bg-iron-accent text-white text-[10px] font-bold flex items-center justify-center px-1">
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </button>
  );
}
