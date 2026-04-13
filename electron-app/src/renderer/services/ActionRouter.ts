/**
 * ActionRouter — Maps classified intents to application actions.
 *
 * Currently supports app-internal actions (navigation, search).
 * Future integrations (Jira, GitHub, etc.) will register additional
 * action handlers here.
 */

import type { ClassifiedIntent } from './tfjs/IntentClassifier';

export interface ActionResult {
  success: boolean;
  message: string;
  /** The action that was executed */
  action: string;
  /** Whether this action can be undone */
  undoable: boolean;
  /** Data needed to undo this action */
  undoData?: unknown;
}

type ActionHandler = (intent: ClassifiedIntent) => Promise<ActionResult>;

class ActionRouterImpl {
  private handlers = new Map<string, ActionHandler>();
  private lastAction: ActionResult | null = null;
  private lastIntent: ClassifiedIntent | null = null;

  constructor() {
    this.registerDefaults();
  }

  /**
   * Register a handler for an intent.
   */
  registerHandler(intent: string, handler: ActionHandler): void {
    this.handlers.set(intent, handler);
  }

  /**
   * Execute the action for a classified intent.
   */
  async execute(intent: ClassifiedIntent): Promise<ActionResult> {
    const handler = this.handlers.get(intent.intent);
    if (!handler) {
      return {
        success: false,
        message: `No handler registered for intent: ${intent.intent}`,
        action: intent.intent,
        undoable: false,
      };
    }

    try {
      const result = await handler(intent);
      this.lastAction = result;
      this.lastIntent = intent;

      // Log to voice routing for training
      const ironmic = (window as any).ironmic;
      if (ironmic?.intentLogRouting) {
        try {
          await ironmic.intentLogRouting('command', intent.intent, 'command');
        } catch { /* non-critical */ }
      }

      return result;
    } catch (err: any) {
      return {
        success: false,
        message: err.message || 'Action failed',
        action: intent.intent,
        undoable: false,
      };
    }
  }

  /**
   * Undo the last action (if undoable).
   */
  async undo(): Promise<ActionResult | null> {
    if (!this.lastAction?.undoable || !this.lastIntent) {
      return null;
    }

    // For now, undo support is limited
    const result = this.lastAction;
    this.lastAction = null;
    this.lastIntent = null;
    return result;
  }

  /**
   * Get the last executed action for correction tracking.
   */
  getLastAction(): { action: ActionResult; intent: ClassifiedIntent } | null {
    if (!this.lastAction || !this.lastIntent) return null;
    return { action: this.lastAction, intent: this.lastIntent };
  }

  // ── Default Handlers ──

  private registerDefaults(): void {
    // Search — navigate to search page with query
    this.registerHandler('search', async (intent) => {
      const query = intent.entities.search_query?.value || '';
      window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'search' }));
      // Small delay to let navigation complete
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('ironmic:search-query', { detail: query }));
      }, 100);
      return {
        success: true,
        message: query ? `Searching for "${query}"` : 'Opened search',
        action: 'search',
        undoable: false,
      };
    });

    // Open view — navigate to a named view
    this.registerHandler('open_view', async (intent) => {
      const view = intent.entities.view_name?.value || '';
      if (view) {
        window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: view }));
        return {
          success: true,
          message: `Opened ${view}`,
          action: 'open_view',
          undoable: false,
        };
      }
      return {
        success: false,
        message: 'Could not determine which view to open',
        action: 'open_view',
        undoable: false,
      };
    });

    // Navigate — same as open_view for now
    this.registerHandler('navigate', async (intent) => {
      return this.handlers.get('open_view')!(intent);
    });

    // Summarize — send to AI chat
    this.registerHandler('summarize', async (intent) => {
      const topic = intent.entities.search_query?.value;
      const prompt = topic
        ? `Summarize my recent dictations about: ${topic}`
        : 'Summarize my recent dictations';

      window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'ai-chat' }));
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('ironmic:ai-dictation', { detail: prompt }));
      }, 200);

      return {
        success: true,
        message: topic ? `Summarizing entries about "${topic}"` : 'Summarizing recent entries',
        action: 'summarize',
        undoable: false,
      };
    });

    // Create ticket — store as structured entry for future integration
    this.registerHandler('create_ticket', async (intent) => {
      const ticketName = intent.entities.ticket_name?.value || intent.rawTranscript;
      const ironmic = (window as any).ironmic;
      if (ironmic?.createEntry) {
        await ironmic.createEntry({
          rawTranscript: `[Command] Create ticket: ${ticketName}`,
          polishedText: ticketName,
          sourceApp: 'command:create_ticket',
        });
      }
      return {
        success: true,
        message: `Created ticket: "${ticketName}"`,
        action: 'create_ticket',
        undoable: true,
      };
    });

    // Assign — placeholder for future integration
    this.registerHandler('assign', async (intent) => {
      const assignee = intent.entities.assignee?.value || '';
      return {
        success: true,
        message: assignee ? `Assignment to "${assignee}" noted` : 'Assignment noted',
        action: 'assign',
        undoable: false,
      };
    });

    // Set status — placeholder
    this.registerHandler('set_status', async (intent) => {
      const status = intent.entities.status?.value || '';
      return {
        success: true,
        message: status ? `Status update to "${status}" noted` : 'Status update noted',
        action: 'set_status',
        undoable: false,
      };
    });

    // Comment — placeholder
    this.registerHandler('comment', async (intent) => {
      const text = intent.entities.comment_text?.value || intent.rawTranscript;
      return {
        success: true,
        message: 'Comment noted',
        action: 'comment',
        undoable: false,
      };
    });

    // Add label — placeholder
    this.registerHandler('add_label', async (intent) => {
      return {
        success: true,
        message: 'Label noted',
        action: 'add_label',
        undoable: false,
      };
    });

    // Update ticket — placeholder
    this.registerHandler('update_ticket', async (intent) => {
      return {
        success: true,
        message: 'Ticket update noted',
        action: 'update_ticket',
        undoable: false,
      };
    });
  }
}

/** Singleton instance */
export const actionRouter = new ActionRouterImpl();
