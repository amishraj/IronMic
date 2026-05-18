import { describe, it, expect } from 'vitest';
import { buildPrompt, type PromptContext } from './promptBuilder';

function makeCtx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    today: '2026-05-11',
    scopeLabel: 'Last 7 days (May 4 – May 11)',
    attachedNotes: [],
    retrievedChunks: [
      { id: 'c1', label: 'Meeting Mon 9am — Standup', text: 'Auth bug rolled to Friday.' },
      { id: 'c2', label: 'Note — Project plan', text: 'Carol joins on-call next month.' },
    ],
    ...overrides,
  };
}

describe('promptBuilder — local route', () => {
  it('emits a messages array with system + user', () => {
    const shaped = buildPrompt(makeCtx(), 'What did Alice commit to?', { route: 'local' });
    expect(shaped.route).toBe('local');
    if (shaped.route !== 'local') throw new Error('unreachable');
    expect(shaped.messages[0].role).toBe('system');
    expect(shaped.messages[0].content).toContain("IronMic's knowledge assistant");
    expect(shaped.messages.at(-1)!.role).toBe('user');
    expect(shaped.messages.at(-1)!.content).toContain('What did Alice commit to?');
  });
});

describe('promptBuilder — Claude route', () => {
  it('with --append-system-prompt support, returns appendSystemPrompt + userPrompt', () => {
    const shaped = buildPrompt(makeCtx(), 'Summarize last week', {
      route: 'claude',
      claudeSupportsAppendSystemPrompt: true,
    });
    expect(shaped.route).toBe('claude');
    if (shaped.route !== 'claude') throw new Error('unreachable');
    if (!('appendSystemPrompt' in shaped)) throw new Error('unreachable');
    expect(shaped.appendSystemPrompt).toContain("IronMic's knowledge assistant");
    expect(shaped.userPrompt).toContain('Summarize last week');
    expect(shaped.userPrompt).not.toContain('<<IRONMIC SYSTEM');
  });

  it('without append-system-prompt support, falls back to <<IRONMIC SYSTEM>> delimiter', () => {
    const shaped = buildPrompt(makeCtx(), 'Summarize last week', {
      route: 'claude',
      claudeSupportsAppendSystemPrompt: false,
    });
    expect(shaped.route).toBe('claude');
    if (shaped.route !== 'claude') throw new Error('unreachable');
    if (!('userPrompt' in shaped)) throw new Error('unreachable');
    expect(shaped.userPrompt).toContain('<<IRONMIC SYSTEM');
    expect(shaped.userPrompt).toContain('<<END IRONMIC SYSTEM>>');
    expect(shaped.userPrompt).toContain('Summarize last week');
  });
});

describe('promptBuilder — Copilot route', () => {
  it('uses markdown role markers, NOT the <<IRONMIC SYSTEM>> delimiter', () => {
    const shaped = buildPrompt(makeCtx(), 'Summarize last week', { route: 'copilot' });
    expect(shaped.route).toBe('copilot');
    if (shaped.route !== 'copilot') throw new Error('unreachable');
    if (!('userPrompt' in shaped)) throw new Error('unreachable');
    expect(shaped.userPrompt).toContain('### INSTRUCTIONS');
    expect(shaped.userPrompt).toContain('### CONTEXT');
    expect(shaped.userPrompt).toContain('### QUESTION');
    expect(shaped.userPrompt).toContain('### ANSWER');
    expect(shaped.userPrompt).not.toContain('<<IRONMIC SYSTEM');
  });

  it('includes the system text (today + scope) under ### INSTRUCTIONS', () => {
    const shaped = buildPrompt(makeCtx(), 'Anything?', { route: 'copilot' });
    if (shaped.route !== 'copilot' || !('userPrompt' in shaped)) throw new Error('unreachable');
    expect(shaped.userPrompt).toContain("IronMic's knowledge assistant");
    expect(shaped.userPrompt).toContain('2026-05-11');
    expect(shaped.userPrompt).toContain('Last 7 days');
  });

  it('renders retrieved chunks with index labels under ### CONTEXT', () => {
    const shaped = buildPrompt(makeCtx(), 'q', { route: 'copilot' });
    if (shaped.route !== 'copilot' || !('userPrompt' in shaped)) throw new Error('unreachable');
    expect(shaped.userPrompt).toMatch(/\[1\] Meeting Mon 9am/);
    expect(shaped.userPrompt).toMatch(/\[2\] Note — Project plan/);
  });

  it('renders attached notes under ### CONTEXT with [A1] markers', () => {
    const shaped = buildPrompt(
      makeCtx({
        attachedNotes: [{ id: 'n1', title: 'Action items', body: 'Carol on call.' }],
      }),
      'q',
      { route: 'copilot' },
    );
    if (shaped.route !== 'copilot' || !('userPrompt' in shaped)) throw new Error('unreachable');
    expect(shaped.userPrompt).toContain('[Attached Notes');
    expect(shaped.userPrompt).toMatch(/\[A1\] Action items/);
    expect(shaped.userPrompt).toContain('Carol on call.');
  });

  it('omits ### CONTEXT block when both attached and retrieved are empty', () => {
    const shaped = buildPrompt(
      makeCtx({ attachedNotes: [], retrievedChunks: [] }),
      'q',
      { route: 'copilot' },
    );
    if (shaped.route !== 'copilot' || !('userPrompt' in shaped)) throw new Error('unreachable');
    expect(shaped.userPrompt).not.toContain('### CONTEXT');
    expect(shaped.userPrompt).toContain('### QUESTION');
  });

  it('puts the question literally under ### QUESTION (not just embedded in a sentence)', () => {
    const shaped = buildPrompt(makeCtx(), 'What did Alice commit to?', { route: 'copilot' });
    if (shaped.route !== 'copilot' || !('userPrompt' in shaped)) throw new Error('unreachable');
    // ### QUESTION should be immediately followed (after the blank line) by the question.
    expect(shaped.userPrompt).toMatch(/### QUESTION\n\nWhat did Alice commit to\?/);
  });
});
