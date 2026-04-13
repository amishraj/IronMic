/**
 * useWorkflowStore — Manages workflow discovery, action logging, and suggestions.
 */

import { create } from 'zustand';
import { workflowMiner, type DiscoveredWorkflow, type ActionEntry } from '../services/tfjs/WorkflowMiner';
import { useNotificationStore } from './useNotificationStore';
import type { Workflow } from '../types';

interface WorkflowStore {
  enabled: boolean;
  workflows: Workflow[];
  /** Next action suggestion based on recent history */
  nextActionSuggestion: { action: string; confidence: number } | null;
  /** Whether discovery is currently running */
  discoveryRunning: boolean;
  /** Recent action types for next-action prediction */
  recentActions: string[];

  setEnabled: (enabled: boolean) => void;
  /** Log a user action (called from IPC middleware or stores) */
  logAction: (actionType: string, metadata?: Record<string, unknown>) => Promise<void>;
  /** Run workflow discovery on accumulated action data */
  runDiscovery: () => Promise<void>;
  /** Load saved workflows from storage */
  loadWorkflows: () => Promise<void>;
  /** Save a discovered workflow */
  saveWorkflow: (id: string, name: string) => Promise<void>;
  /** Dismiss a workflow suggestion */
  dismissWorkflow: (id: string) => Promise<void>;
  /** Predict the next action */
  predictNext: () => Promise<void>;
  /** Load settings */
  loadFromSettings: () => Promise<void>;
}

export const useWorkflowStore = create<WorkflowStore>((set, get) => ({
  enabled: false,
  workflows: [],
  nextActionSuggestion: null,
  discoveryRunning: false,
  recentActions: [],

  setEnabled: (enabled) => set({ enabled }),

  logAction: async (actionType, metadata) => {
    if (!get().enabled) return;

    const ironmic = (window as any).ironmic;
    if (!ironmic?.logAction) return;

    try {
      await ironmic.logAction(actionType, metadata ? JSON.stringify(metadata) : undefined);

      // Track recent actions for next-action prediction
      set((state) => ({
        recentActions: [...state.recentActions.slice(-9), actionType],
      }));

      // Predict next action after logging
      get().predictNext();
    } catch (err) {
      console.warn('[WorkflowStore] Failed to log action:', err);
    }
  },

  runDiscovery: async () => {
    if (!get().enabled || get().discoveryRunning) return;

    const ironmic = (window as any).ironmic;
    if (!ironmic?.queryActionLog) return;

    set({ discoveryRunning: true });

    try {
      // Get action log for the last 30 days
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const logJson = await ironmic.queryActionLog(
        thirtyDaysAgo.toISOString(),
        now.toISOString(),
      );
      const actions: ActionEntry[] = JSON.parse(logJson).map((a: any) => ({
        actionType: a.action_type,
        timestamp: a.timestamp,
        hourOfDay: a.hour_of_day,
        dayOfWeek: a.day_of_week,
      }));

      // Run the miner
      const discovered = workflowMiner.mine(actions);

      // Save new workflows to storage
      for (const workflow of discovered) {
        try {
          await ironmic.workflowCreate(
            JSON.stringify(workflow.actionSequence),
            JSON.stringify(workflow.triggerPattern),
            workflow.confidence,
            workflow.occurrenceCount,
          );

          // Create notification for discovered workflow
          const notifStore = useNotificationStore.getState();
          if (notifStore.create) {
            const desc = workflow.actionSequence.join(' → ');
            await notifStore.create(
              'workflow',
              null,
              'workflow_suggestion',
              'New workflow discovered',
              `Pattern: ${desc} (seen ${workflow.occurrenceCount} times)`,
            );
          }
        } catch {
          // May already exist
        }
      }

      // Reload workflows from storage
      await get().loadWorkflows();

      console.log(`[WorkflowStore] Discovery complete: ${discovered.length} workflows found`);
    } catch (err) {
      console.warn('[WorkflowStore] Discovery failed:', err);
    } finally {
      set({ discoveryRunning: false });
    }
  },

  loadWorkflows: async () => {
    const ironmic = (window as any).ironmic;
    if (!ironmic?.workflowList) return;

    try {
      const json = await ironmic.workflowList(false);
      const workflows: Workflow[] = JSON.parse(json);
      set({ workflows });
    } catch (err) {
      console.warn('[WorkflowStore] Failed to load workflows:', err);
    }
  },

  saveWorkflow: async (id, name) => {
    const ironmic = (window as any).ironmic;
    if (!ironmic?.workflowSave) return;

    try {
      await ironmic.workflowSave(id, name);
      await get().loadWorkflows();
    } catch (err) {
      console.warn('[WorkflowStore] Failed to save workflow:', err);
    }
  },

  dismissWorkflow: async (id) => {
    const ironmic = (window as any).ironmic;
    if (!ironmic?.workflowDismiss) return;

    try {
      await ironmic.workflowDismiss(id);
      set((state) => ({
        workflows: state.workflows.filter((w) => w.id !== id),
      }));
    } catch (err) {
      console.warn('[WorkflowStore] Failed to dismiss workflow:', err);
    }
  },

  predictNext: async () => {
    const { recentActions, enabled } = get();
    if (!enabled || recentActions.length < 3) {
      set({ nextActionSuggestion: null });
      return;
    }

    const ironmic = (window as any).ironmic;
    if (!ironmic?.queryActionLog) return;

    try {
      // Get recent action log for prediction
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const logJson = await ironmic.queryActionLog(
        sevenDaysAgo.toISOString(),
        now.toISOString(),
      );
      const allActions: ActionEntry[] = JSON.parse(logJson).map((a: any) => ({
        actionType: a.action_type,
        timestamp: a.timestamp,
        hourOfDay: a.hour_of_day,
        dayOfWeek: a.day_of_week,
      }));

      const prediction = workflowMiner.predictNext(recentActions, allActions);
      set({ nextActionSuggestion: prediction });
    } catch {
      set({ nextActionSuggestion: null });
    }
  },

  loadFromSettings: async () => {
    const ironmic = (window as any).ironmic;
    if (!ironmic) return;

    const enabled = (await ironmic.getSetting('ml_workflows_enabled')) === 'true';
    const confidence = parseFloat((await ironmic.getSetting('ml_workflows_confidence')) || '0.7');

    workflowMiner.setConfidenceThreshold(confidence);
    set({ enabled });

    if (enabled) {
      await get().loadWorkflows();
    }
  },
}));
