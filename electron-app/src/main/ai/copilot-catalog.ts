import type { AIModel } from './types';

export interface ProbeResult {
  models: AIModel[];
  /**
   * 'high'  — structured output we trust as authoritative (gh models list,
   *           copilot --list-models). Probe replaces curated unmatched.
   * 'low'   — heuristic text scrape (copilot help). Probe supplements
   *           curated, doesn't replace.
   */
  confidence: 'high' | 'low';
}

/**
 * Built-in best-effort fallback list of GitHub Copilot models. Returned
 * fresh on every call so callers can mutate without affecting subsequent
 * lookups.
 *
 * NOT authoritative — GitHub's supported set changes (GPT-5 retired
 * 2026-02-17, o3-mini retired 2025-10-23). Real availability comes from
 * `Refresh models`. Treat `billing` as a hint, not a contract.
 */
export function getCuratedCopilotModels(): AIModel[] {
  const entries: Array<Omit<AIModel, 'provider'>> = [
    {
      id: 'openai/gpt-4.1',
      label: 'GPT-4.1 (openai)',
      source: 'curated',
      billing: 'unknown',
      description: 'Built-in catalog — click Refresh for live availability',
      runIds: { copilotCli: 'gpt-4.1', ghModels: 'openai/gpt-4.1' },
    },
    {
      id: 'openai/gpt-4o',
      label: 'GPT-4o (openai)',
      source: 'curated',
      billing: 'unknown',
      description: 'Built-in catalog — click Refresh for live availability',
      runIds: { copilotCli: 'gpt-4o', ghModels: 'openai/gpt-4o' },
    },
    {
      id: 'openai/gpt-5-mini',
      label: 'GPT-5 Mini (openai)',
      source: 'curated',
      billing: 'unknown',
      description: 'Built-in catalog — click Refresh for live availability',
      runIds: { copilotCli: 'gpt-5-mini', ghModels: 'openai/gpt-5-mini' },
    },
    {
      id: 'anthropic/claude-sonnet-4.5',
      label: 'Claude Sonnet 4.5 (anthropic)',
      source: 'curated',
      billing: 'unknown',
      description: 'Built-in catalog — click Refresh for live availability',
      runIds: {
        copilotCli: 'claude-sonnet-4.5',
        ghModels: 'anthropic/claude-sonnet-4.5',
      },
    },
    {
      id: 'anthropic/claude-haiku-4.5',
      label: 'Claude Haiku 4.5 (anthropic)',
      source: 'curated',
      billing: 'free',
      description: 'Built-in catalog — click Refresh for live availability',
      runIds: {
        copilotCli: 'claude-haiku-4.5',
        ghModels: 'anthropic/claude-haiku-4.5',
      },
    },
  ];
  return entries.map((e) => ({
    ...e,
    provider: 'copilot',
    runIds: e.runIds ? { ...e.runIds } : undefined,
  }));
}

/**
 * Merge a probe result into the curated baseline.
 *
 * - Match by canonical id, runIds.copilotCli, or runIds.ghModels — so a
 *   probe returning bare `gpt-5-mini` matches curated `openai/gpt-5-mini`.
 * - Field-by-field merge: probe wins for id/label, runIds are deep-merged
 *   so we never drop a curated ghModels mapping when copilot-cli probed.
 * - High-confidence probes drop unmatched curated entries (probe is
 *   authoritative). Low-confidence probes preserve them as supplements.
 * - Empty probe returns curated verbatim.
 */
export function mergeProbedIntoCurated(
  probed: ProbeResult,
  curated: AIModel[],
): AIModel[] {
  if (probed.models.length === 0) {
    return curated.map((m) => ({ ...m, source: 'curated' }));
  }

  const curatedByKey = new Map<string, AIModel>();
  for (const c of curated) {
    curatedByKey.set(c.id, c);
    if (c.runIds?.copilotCli) curatedByKey.set(c.runIds.copilotCli, c);
    if (c.runIds?.ghModels) curatedByKey.set(c.runIds.ghModels, c);
  }

  const matchedCurated = new Set<AIModel>();
  const out: AIModel[] = [];

  for (const p of probed.models) {
    const candidates = [
      p.id,
      p.runIds?.copilotCli,
      p.runIds?.ghModels,
    ].filter((k): k is string => typeof k === 'string' && k.length > 0);

    let match: AIModel | undefined;
    for (const k of candidates) {
      const hit = curatedByKey.get(k);
      if (hit) {
        match = hit;
        break;
      }
    }

    if (match) {
      matchedCurated.add(match);
      out.push({
        ...match,
        ...p,
        source: 'cli',
        runIds: { ...match.runIds, ...p.runIds },
      });
    } else {
      out.push({ ...p, source: 'cli' });
    }
  }

  if (probed.confidence === 'low') {
    for (const c of curated) {
      if (!matchedCurated.has(c)) {
        out.push({ ...c, source: 'curated' });
      }
    }
  }

  return out;
}
