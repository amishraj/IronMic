import { describe, it, expect } from 'vitest';
import { CopilotAdapter } from './CopilotAdapter';
import {
  getCuratedCopilotModels,
  mergeProbedIntoCurated,
  type ProbeResult,
} from './copilot-catalog';
import type { AIModel } from './types';

const adapter = new CopilotAdapter();

describe('parseCopilotHelpModels', () => {
  it('rejects prose tokens that match the loose char regex', () => {
    const help = `
      Usage: copilot [options]
      Options:
        --model <model>   Specify the AI model. Default: none.
                          Available: false, true, default
    `;
    const out = adapter.parseCopilotHelpModels(help);
    // None of "false", "true", "default" should be admitted as model ids
    // because they don't start with a known vendor prefix or contain '/'.
    expect(out.map((m) => m.id)).toEqual([]);
  });

  it('extracts known-vendor ids from a "Available:" comma list', () => {
    const help = `
      --model <model>
        Specify the AI model to use. Available: claude-haiku-4.5,
        claude-sonnet-4.5, gpt-5-mini, gpt-4.1
    `;
    const ids = adapter.parseCopilotHelpModels(help).map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'claude-haiku-4.5',
        'claude-sonnet-4.5',
        'gpt-5-mini',
        'gpt-4.1',
      ]),
    );
  });

  it('extracts ids from a bulleted --model section', () => {
    const help = `
      --model <model>
        - gpt-4.1
        - claude-haiku-4.5
        * gpt-5-mini
    `;
    const ids = adapter.parseCopilotHelpModels(help).map((m) => m.id).sort();
    expect(ids).toEqual(['claude-haiku-4.5', 'gpt-4.1', 'gpt-5-mini']);
  });
});

describe('parseGhModelsJson', () => {
  it('parses [{id, friendly_name}] shape', () => {
    const json = JSON.stringify([
      { id: 'openai/gpt-4o-mini', friendly_name: 'GPT-4o Mini' },
      { id: 'anthropic/claude-haiku-4.5', friendly_name: 'Claude Haiku 4.5' },
    ]);
    const out = adapter.parseGhModelsJson(json);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('openai/gpt-4o-mini');
    expect(out[0].label).toBe('GPT-4o Mini');
  });

  it('parses [{name}] shape and falls back to prettifyId for label', () => {
    const json = JSON.stringify([{ name: 'openai/gpt-4o' }]);
    const out = adapter.parseGhModelsJson(json);
    expect(out[0].id).toBe('openai/gpt-4o');
    expect(out[0].label).toBe('gpt-4o (openai)');
  });

  it('returns [] on malformed JSON', () => {
    expect(adapter.parseGhModelsJson('not json')).toEqual([]);
  });
});

describe('parseGhModelsTable', () => {
  it('extracts provider/model ids and assigns prettified labels', () => {
    const table = `
DISPLAY NAME            ID
GPT 4.1                 openai/gpt-4.1
Claude Haiku 4.5        anthropic/claude-haiku-4.5
    `;
    const out = adapter.parseGhModelsTable(table);
    const ids = out.map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining(['openai/gpt-4.1', 'anthropic/claude-haiku-4.5']),
    );
    const claude = out.find((m) => m.id === 'anthropic/claude-haiku-4.5')!;
    expect(claude.label).toBe('Claude Haiku 4.5');
  });

  it('skips header and separator rows', () => {
    const table = `
NAME    ID
---     ---
SomeApp openai/gpt-4o
    `;
    const ids = adapter.parseGhModelsTable(table).map((m) => m.id);
    expect(ids).toEqual(['openai/gpt-4o']);
  });
});

describe('getCuratedCopilotModels', () => {
  it('every entry has both runIds.copilotCli and runIds.ghModels', () => {
    const curated = getCuratedCopilotModels();
    expect(curated.length).toBeGreaterThan(0);
    for (const m of curated) {
      expect(m.runIds?.copilotCli).toBeTruthy();
      expect(m.runIds?.ghModels).toBeTruthy();
      expect(m.provider).toBe('copilot');
      expect(m.source).toBe('curated');
    }
  });

  it('returns independent objects each call (no shared mutable state)', () => {
    const a = getCuratedCopilotModels();
    const b = getCuratedCopilotModels();
    expect(a).not.toBe(b);
    a[0].label = 'MUTATED';
    a[0].runIds!.copilotCli = 'mutated';
    expect(b[0].label).not.toBe('MUTATED');
    expect(b[0].runIds!.copilotCli).not.toBe('mutated');
  });
});

describe('mergeProbedIntoCurated', () => {
  const curated: AIModel[] = [
    {
      id: 'openai/gpt-5-mini',
      label: 'GPT-5 Mini',
      provider: 'copilot',
      source: 'curated',
      runIds: { copilotCli: 'gpt-5-mini', ghModels: 'openai/gpt-5-mini' },
    },
    {
      id: 'openai/gpt-4.1',
      label: 'GPT-4.1',
      provider: 'copilot',
      source: 'curated',
      runIds: { copilotCli: 'gpt-4.1', ghModels: 'openai/gpt-4.1' },
    },
  ];

  it('on empty probe, returns curated verbatim with source: curated', () => {
    const out = mergeProbedIntoCurated(
      { models: [], confidence: 'high' },
      curated,
    );
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.source === 'curated')).toBe(true);
  });

  it('high-confidence probe drops unmatched curated entries', () => {
    const probed: ProbeResult = {
      models: [
        {
          id: 'gpt-5-mini',
          label: 'gpt-5-mini',
          provider: 'copilot',
          runIds: { copilotCli: 'gpt-5-mini' },
        },
      ],
      confidence: 'high',
    };
    const out = mergeProbedIntoCurated(probed, curated);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('cli');
    // gpt-4.1 (unmatched curated) is dropped on high confidence.
    expect(out.find((m) => m.id === 'openai/gpt-4.1')).toBeUndefined();
  });

  it('high-confidence merge: bare probe id matches curated slash id and preserves runIds.ghModels', () => {
    const probed: ProbeResult = {
      models: [
        {
          id: 'gpt-5-mini',
          label: 'gpt-5-mini',
          provider: 'copilot',
          runIds: { copilotCli: 'gpt-5-mini' },
        },
      ],
      confidence: 'high',
    };
    const out = mergeProbedIntoCurated(probed, curated);
    const merged = out[0];
    expect(merged.runIds?.copilotCli).toBe('gpt-5-mini');
    // The curated ghModels must NOT be lost on a copilotCli-only probe.
    expect(merged.runIds?.ghModels).toBe('openai/gpt-5-mini');
  });

  it('low-confidence probe preserves unmatched curated entries as supplements', () => {
    const probed: ProbeResult = {
      models: [
        {
          id: 'gpt-5-mini',
          label: 'gpt-5-mini',
          provider: 'copilot',
          runIds: { copilotCli: 'gpt-5-mini' },
        },
      ],
      confidence: 'low',
    };
    const out = mergeProbedIntoCurated(probed, curated);
    expect(out).toHaveLength(2);
    const cli = out.find((m) => m.source === 'cli');
    const supplemental = out.find((m) => m.source === 'curated');
    expect(cli?.id).toBe('gpt-5-mini');
    expect(supplemental?.id).toBe('openai/gpt-4.1');
  });

  it('appends probe entries with no curated match', () => {
    const probed: ProbeResult = {
      models: [
        {
          id: 'experimental-zzz',
          label: 'Experimental',
          provider: 'copilot',
          runIds: { copilotCli: 'experimental-zzz' },
        },
      ],
      confidence: 'high',
    };
    const out = mergeProbedIntoCurated(probed, curated);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('experimental-zzz');
    expect(out[0].source).toBe('cli');
  });
});
