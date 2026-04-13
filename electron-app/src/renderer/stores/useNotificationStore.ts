/**
 * useNotificationStore — Manages in-app notification state.
 */

import { create } from 'zustand';
import { notificationRanker, type RankedNotification } from '../services/tfjs/NotificationRanker';
import type { Notification } from '../types';

interface NotificationStore {
  notifications: Notification[];
  unreadCount: number;
  panelOpen: boolean;
  mlReady: boolean;
  learningPhase: boolean; // True when < 50 interactions (rule-based mode)

  /** Load notifications from storage */
  loadNotifications: () => Promise<void>;
  /** Mark a notification as read */
  markRead: (id: string) => Promise<void>;
  /** Act on a notification */
  act: (id: string) => Promise<void>;
  /** Dismiss a notification */
  dismiss: (id: string) => Promise<void>;
  /** Create a new notification */
  create: (source: string, sourceId: string | null, type: string, title: string, body?: string) => Promise<void>;
  /** Toggle the notification panel */
  togglePanel: () => void;
  /** Initialize ranker */
  initRanker: () => Promise<void>;
  /** Refresh unread count */
  refreshUnreadCount: () => Promise<void>;
}

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  notifications: [],
  unreadCount: 0,
  panelOpen: false,
  mlReady: false,
  learningPhase: true,

  loadNotifications: async () => {
    const ironmic = (window as any).ironmic;
    if (!ironmic?.notificationList) return;

    try {
      const json = await ironmic.notificationList(50, 0, false);
      const notifications: Notification[] = JSON.parse(json);
      set({ notifications });
      await get().refreshUnreadCount();
    } catch (err) {
      console.warn('[NotificationStore] Failed to load notifications:', err);
    }
  },

  markRead: async (id) => {
    const ironmic = (window as any).ironmic;
    if (!ironmic?.notificationMarkRead) return;

    try {
      await ironmic.notificationMarkRead(id);
      await notificationRanker.recordInteraction(id, 'read');

      set((state) => ({
        notifications: state.notifications.map((n) =>
          n.id === id ? { ...n, readAt: new Date().toISOString() } : n
        ),
      }));
      await get().refreshUnreadCount();
    } catch (err) {
      console.warn('[NotificationStore] Failed to mark read:', err);
    }
  },

  act: async (id) => {
    const ironmic = (window as any).ironmic;
    if (!ironmic?.notificationAct) return;

    try {
      await ironmic.notificationAct(id);
      await notificationRanker.recordInteraction(id, 'acted');

      set((state) => ({
        notifications: state.notifications.map((n) =>
          n.id === id ? { ...n, actedOnAt: new Date().toISOString(), readAt: n.readAt || new Date().toISOString() } : n
        ),
      }));
      await get().refreshUnreadCount();
    } catch (err) {
      console.warn('[NotificationStore] Failed to act on notification:', err);
    }
  },

  dismiss: async (id) => {
    const ironmic = (window as any).ironmic;
    if (!ironmic?.notificationDismiss) return;

    try {
      await ironmic.notificationDismiss(id);
      await notificationRanker.recordInteraction(id, 'dismissed');

      set((state) => ({
        notifications: state.notifications.filter((n) => n.id !== id),
      }));
      await get().refreshUnreadCount();
    } catch (err) {
      console.warn('[NotificationStore] Failed to dismiss notification:', err);
    }
  },

  create: async (source, sourceId, type, title, body) => {
    const ironmic = (window as any).ironmic;
    if (!ironmic?.notificationCreate) return;

    try {
      const json = await ironmic.notificationCreate(source, sourceId, type, title, body);
      const notification: Notification = JSON.parse(json);
      set((state) => ({
        notifications: [notification, ...state.notifications],
        unreadCount: state.unreadCount + 1,
      }));
    } catch (err) {
      console.warn('[NotificationStore] Failed to create notification:', err);
    }
  },

  togglePanel: () => set((state) => ({ panelOpen: !state.panelOpen })),

  initRanker: async () => {
    try {
      await notificationRanker.initialize();
      set({
        mlReady: true,
        learningPhase: !notificationRanker.isMLActive(),
      });
    } catch (err) {
      console.warn('[NotificationStore] Ranker init failed:', err);
    }
  },

  refreshUnreadCount: async () => {
    const ironmic = (window as any).ironmic;
    if (!ironmic?.notificationGetUnreadCount) return;

    try {
      const count = await ironmic.notificationGetUnreadCount();
      set({ unreadCount: count });
    } catch {
      // non-critical
    }
  },
}));
