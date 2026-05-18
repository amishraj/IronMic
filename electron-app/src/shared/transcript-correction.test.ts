import { describe, it, expect } from 'vitest';
import { correctTranscript, __test__ } from './transcript-correction';

describe('correctTranscript — short-circuit', () => {
  it('returns original when terms is empty', () => {
    expect(correctTranscript('hello world', [])).toBe('hello world');
  });

  it('returns original when text is empty', () => {
    expect(correctTranscript('', ['Kubernetes'])).toBe('');
  });
});

describe('correctTranscript — false positives are guarded', () => {
  it('never replaces stop-list words', () => {
    expect(correctTranscript('the and is have', ['theta'])).toBe('the and is have');
  });

  it('never replaces tokens of length ≤ 3', () => {
    expect(correctTranscript('an and at', ['Ann'])).toBe('an and at');
  });

  it('preserves tokens with no plausible match', () => {
    expect(correctTranscript('hello world', ['Kubernetes'])).toBe('hello world');
  });

  it('does not replace on ambiguous tie', () => {
    // Two terms equally close → leave alone.
    const out = correctTranscript('helo', ['help', 'hero']);
    expect(out).toBe('helo');
  });
});

describe('correctTranscript — true positives', () => {
  it('corrects c↔k equivalence (coobernetes → Kubernetes)', () => {
    expect(correctTranscript('we use coobernetes', ['Kubernetes'])).toBe('we use Kubernetes');
  });

  it('corrects same-first-letter near miss for a name', () => {
    expect(correctTranscript('the aarrav team', ['Aarav'])).toBe('the Aarav team');
  });

  it('preserves UPPER case pattern', () => {
    expect(correctTranscript('COOBERNETES', ['Kubernetes'])).toBe('KUBERNETES');
  });

  it('lowercase input keeps proper-noun casing of dictionary term', () => {
    // The dictionary entry is "Kubernetes" — even when the user dictates
    // it lowercase, we substitute with the proper-noun spelling.
    expect(correctTranscript('coobernetes', ['Kubernetes'])).toBe('Kubernetes');
  });

  it('preserves Title case pattern', () => {
    expect(correctTranscript('Coobernetes', ['Kubernetes'])).toBe('Kubernetes');
  });

  it('expands multi-word participant names into single tokens', () => {
    // "Mary Ann Smith" splits into ["Mary","Ann","Smith"]; "Ann" is too short
    // to trigger so won't replace "an", but "Smith"/"Mary" should still be
    // correctable.
    const terms = ['Mary Ann Smith'];
    const out = correctTranscript('mery and smiht spoke up', terms);
    expect(out).toContain('Mary');
    expect(out).toContain('Smith');
  });
});

describe('correctTranscript — exact matches pass through unchanged', () => {
  it('idempotent on already-correct text', () => {
    const text = 'we use Kubernetes today';
    expect(correctTranscript(text, ['Kubernetes'])).toBe(text);
  });
});

describe('first-letter equivalence classes', () => {
  it('c ↔ k', () => {
    expect(__test__.firstLetterEquivalent('c', 'k')).toBe(true);
  });
  it('s ↔ z', () => {
    expect(__test__.firstLetterEquivalent('s', 'z')).toBe(true);
  });
  it('i ↔ y', () => {
    expect(__test__.firstLetterEquivalent('i', 'y')).toBe(true);
  });
  it('unrelated letters are not equivalent', () => {
    expect(__test__.firstLetterEquivalent('a', 'm')).toBe(false);
  });
});

describe('expandTerms', () => {
  it('splits multi-word terms on whitespace', () => {
    const out = __test__.expandTerms(['Mary Ann Smith']);
    expect(out).toContain('Mary');
    expect(out).toContain('Ann');
    expect(out).toContain('Smith');
  });

  it('drops stop words from term expansion', () => {
    const out = __test__.expandTerms(['the and Alice']);
    expect(out).not.toContain('the');
    expect(out).not.toContain('and');
    expect(out).toContain('Alice');
  });

  it('dedupes case-insensitively', () => {
    const out = __test__.expandTerms(['Alice', 'alice', 'ALICE']);
    expect(out.length).toBe(1);
  });
});

describe('detectCase / applyCase', () => {
  it('round-trips upper', () => {
    expect(__test__.applyCase('alice', __test__.detectCase('BOB'))).toBe('ALICE');
  });
  it('round-trips title', () => {
    expect(__test__.applyCase('alice', __test__.detectCase('Bob'))).toBe('Alice');
  });
  it('lower-input keeps proper-noun casing of term', () => {
    // Input is lowercase but the term has caps → preserve the term's casing
    // so "kubernetes" → "Kubernetes" rather than "kubernetes".
    expect(__test__.applyCase('Alice', __test__.detectCase('bob'))).toBe('Alice');
  });
  it('lower-input lowercases an all-lowercase term', () => {
    expect(__test__.applyCase('alice', __test__.detectCase('bob'))).toBe('alice');
  });
});

describe('damerauLevenshtein', () => {
  it('zero distance for identical strings', () => {
    expect(__test__.damerauLevenshtein('abc', 'abc')).toBe(0);
  });
  it('one for single substitution', () => {
    expect(__test__.damerauLevenshtein('abc', 'abd')).toBe(1);
  });
  it('one for transposition (Damerau)', () => {
    expect(__test__.damerauLevenshtein('abcd', 'abdc')).toBe(1);
  });
});
