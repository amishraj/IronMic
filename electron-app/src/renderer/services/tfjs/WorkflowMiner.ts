/**
 * WorkflowMiner — Discovers repeating action patterns from the action log.
 *
 * Two-part approach:
 * 1. Deterministic sequence mining: sliding-window subsequence extraction,
 *    grouped by temporal pattern, filtered by confidence threshold.
 * 2. Next-action prediction (future): small GRU model trained on action sequences.
 *
 * Runs in the renderer (not Web Worker) since sequence mining is pure JS
 * and doesn't require TF.js.
 */

export interface DiscoveredWorkflow {
  actionSequence: string[];
  triggerPattern: {
    dayOfWeek?: number[];
    hourRange?: [number, number];
    frequency: number; // occurrences
  };
  confidence: number;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ActionEntry {
  actionType: string;
  timestamp: string;
  hourOfDay: number;
  dayOfWeek: number;
}

const MIN_SEQUENCE_LENGTH = 3;
const MAX_SEQUENCE_LENGTH = 8;
const MIN_OCCURRENCES = 3;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

export class WorkflowMiner {
  private confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD;

  setConfidenceThreshold(threshold: number): void {
    this.confidenceThreshold = threshold;
  }

  /**
   * Mine workflows from a list of action log entries.
   * Returns discovered patterns sorted by confidence.
   */
  mine(actions: ActionEntry[]): DiscoveredWorkflow[] {
    if (actions.length < MIN_SEQUENCE_LENGTH * MIN_OCCURRENCES) {
      return []; // Not enough data
    }

    const sequences = this.extractSequences(actions);
    const grouped = this.groupByPattern(sequences);
    const workflows = this.filterAndRank(grouped);

    return workflows;
  }

  /**
   * Predict the next action based on recent history.
   * V1: Simple frequency-based prediction (most common next action after this sequence).
   */
  predictNext(
    recentActions: string[],
    allActions: ActionEntry[],
  ): { action: string; confidence: number } | null {
    if (recentActions.length < 2 || allActions.length < 10) return null;

    // Look at the last 2-3 actions and find what typically follows
    const lookback = recentActions.slice(-3);
    const pattern = lookback.join('→');

    const nextCounts = new Map<string, number>();
    let totalFollows = 0;

    for (let i = 0; i < allActions.length - lookback.length; i++) {
      const window = allActions.slice(i, i + lookback.length).map((a) => a.actionType);
      if (window.join('→') === pattern && i + lookback.length < allActions.length) {
        const nextAction = allActions[i + lookback.length].actionType;
        nextCounts.set(nextAction, (nextCounts.get(nextAction) || 0) + 1);
        totalFollows++;
      }
    }

    if (totalFollows === 0) return null;

    // Find the most common next action
    let bestAction = '';
    let bestCount = 0;
    for (const [action, count] of nextCounts) {
      if (count > bestCount) {
        bestCount = count;
        bestAction = action;
      }
    }

    const confidence = bestCount / totalFollows;
    if (confidence < 0.3) return null; // Too uncertain

    return { action: bestAction, confidence };
  }

  // ── Internal ──

  /**
   * Extract all subsequences of length MIN..MAX from the action log.
   */
  private extractSequences(
    actions: ActionEntry[],
  ): Array<{
    sequence: string[];
    timestamps: string[];
    hours: number[];
    days: number[];
  }> {
    const results: Array<{
      sequence: string[];
      timestamps: string[];
      hours: number[];
      days: number[];
    }> = [];

    for (let len = MIN_SEQUENCE_LENGTH; len <= MAX_SEQUENCE_LENGTH; len++) {
      for (let i = 0; i <= actions.length - len; i++) {
        const window = actions.slice(i, i + len);
        results.push({
          sequence: window.map((a) => a.actionType),
          timestamps: window.map((a) => a.timestamp),
          hours: window.map((a) => a.hourOfDay),
          days: window.map((a) => a.dayOfWeek),
        });
      }
    }

    return results;
  }

  /**
   * Group identical sequences and aggregate temporal patterns.
   */
  private groupByPattern(
    sequences: Array<{
      sequence: string[];
      timestamps: string[];
      hours: number[];
      days: number[];
    }>,
  ): Map<
    string,
    {
      sequence: string[];
      occurrences: number;
      hours: number[];
      days: number[];
      timestamps: string[];
    }
  > {
    const groups = new Map<
      string,
      {
        sequence: string[];
        occurrences: number;
        hours: number[];
        days: number[];
        timestamps: string[];
      }
    >();

    for (const seq of sequences) {
      const key = seq.sequence.join('→');
      const existing = groups.get(key);
      if (existing) {
        existing.occurrences++;
        existing.hours.push(...seq.hours);
        existing.days.push(...seq.days);
        existing.timestamps.push(...seq.timestamps);
      } else {
        groups.set(key, {
          sequence: seq.sequence,
          occurrences: 1,
          hours: [...seq.hours],
          days: [...seq.days],
          timestamps: [...seq.timestamps],
        });
      }
    }

    return groups;
  }

  /**
   * Filter by minimum occurrences and compute confidence scores.
   */
  private filterAndRank(
    groups: Map<
      string,
      {
        sequence: string[];
        occurrences: number;
        hours: number[];
        days: number[];
        timestamps: string[];
      }
    >,
  ): DiscoveredWorkflow[] {
    const workflows: DiscoveredWorkflow[] = [];

    for (const [, group] of groups) {
      if (group.occurrences < MIN_OCCURRENCES) continue;

      // Compute temporal consistency
      const hourConsistency = this.computeConsistency(group.hours, 24);
      const dayConsistency = this.computeConsistency(group.days, 7);

      // Confidence = combination of frequency and temporal consistency
      const frequencyScore = Math.min(1, group.occurrences / 10);
      const temporalScore = (hourConsistency + dayConsistency) / 2;
      const confidence = frequencyScore * 0.6 + temporalScore * 0.4;

      if (confidence < this.confidenceThreshold) continue;

      // Determine trigger pattern
      const dominantDay = this.findDominant(group.days);
      const hourRange = this.findRange(group.hours);

      const timestamps = group.timestamps.sort();

      workflows.push({
        actionSequence: group.sequence,
        triggerPattern: {
          dayOfWeek: dominantDay !== null ? [dominantDay] : undefined,
          hourRange: hourRange,
          frequency: group.occurrences,
        },
        confidence,
        occurrenceCount: group.occurrences,
        firstSeenAt: timestamps[0],
        lastSeenAt: timestamps[timestamps.length - 1],
      });
    }

    // Sort by confidence descending
    workflows.sort((a, b) => b.confidence - a.confidence);

    // Deduplicate: remove subsequences of longer workflows
    return this.deduplicateWorkflows(workflows);
  }

  /**
   * Compute how consistent a set of values is (0 = random, 1 = all same).
   */
  private computeConsistency(values: number[], range: number): number {
    if (values.length === 0) return 0;

    const counts = new Map<number, number>();
    for (const v of values) {
      counts.set(v, (counts.get(v) || 0) + 1);
    }

    // Find the most common value
    let maxCount = 0;
    for (const count of counts.values()) {
      if (count > maxCount) maxCount = count;
    }

    return maxCount / values.length;
  }

  private findDominant(values: number[]): number | null {
    const counts = new Map<number, number>();
    for (const v of values) {
      counts.set(v, (counts.get(v) || 0) + 1);
    }

    let best = -1;
    let bestCount = 0;
    for (const [val, count] of counts) {
      if (count > bestCount) {
        bestCount = count;
        best = val;
      }
    }

    // Only return if > 50% of values
    return bestCount > values.length * 0.5 ? best : null;
  }

  private findRange(hours: number[]): [number, number] | undefined {
    if (hours.length === 0) return undefined;
    const min = Math.min(...hours);
    const max = Math.max(...hours);
    // Only return a range if it's reasonably tight (within 4 hours)
    if (max - min <= 4) return [min, max];
    return undefined;
  }

  private deduplicateWorkflows(workflows: DiscoveredWorkflow[]): DiscoveredWorkflow[] {
    const result: DiscoveredWorkflow[] = [];
    const seen = new Set<string>();

    for (const w of workflows) {
      const key = w.actionSequence.join('→');
      // Skip if a longer workflow already contains this sequence
      let isSubsequence = false;
      for (const existing of result) {
        const existingKey = existing.actionSequence.join('→');
        if (existingKey.includes(key) && existingKey !== key) {
          isSubsequence = true;
          break;
        }
      }
      if (!isSubsequence && !seen.has(key)) {
        result.push(w);
        seen.add(key);
      }
    }

    return result;
  }
}

/** Singleton instance */
export const workflowMiner = new WorkflowMiner();
