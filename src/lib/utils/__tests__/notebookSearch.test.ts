/**
 * Notebook-wide find and replace.
 *
 * Matching and replacing are the parts that can quietly corrupt code — a `$`
 * turned into a back-reference, a lookbehind that stops matching once cut out
 * of its context, a locked cell rewritten anyway — so they are pinned here.
 */
import { describe, it, expect } from 'vitest';
import {
  buildMatcher,
  expandReplacement,
  findInText,
  findMatches,
  replaceAll,
  replaceAllInText,
  replaceOne,
  undoReplaceAll,
} from '../notebookSearch';
import type { NotebookCell } from '../../types/notebook';

const cell = (id: string, content: string, extra: Partial<NotebookCell> = {}): NotebookCell =>
  ({ id, type: 'code', content, ...extra }) as NotebookCell;

describe('buildMatcher', () => {
  it('is no search for an empty query, not an error', () => {
    expect(buildMatcher({ query: '' })).toEqual({ regex: null, error: null });
  });

  it('treats a plain query literally', () => {
    const { regex } = buildMatcher({ query: 'a.b(c)' });
    expect(regex!.test('xa.b(c)y')).toBe(true);
    expect(buildMatcher({ query: 'a.b' }).regex!.test('axb')).toBe(false);
  });

  it('reports an unfinished regex instead of throwing', () => {
    // `(` on the way to `(a|b)` is a normal moment while typing.
    const result = buildMatcher({ query: '(a', regex: true });
    expect(result.regex).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it('ignores case unless asked not to', () => {
    expect(findInText('Tempo tempo', buildMatcher({ query: 'tempo' }).regex!)).toHaveLength(2);
    expect(findInText('Tempo tempo', buildMatcher({ query: 'tempo', caseSensitive: true }).regex!)).toHaveLength(1);
  });

  it('matches whole identifiers, $ included', () => {
    // `\b` would treat `$tempo` and `tempo$` as containing the word `tempo`.
    const re = buildMatcher({ query: 'tempo', wholeWord: true }).regex!;
    expect(findInText('tempo tempos $tempo tempo$ (tempo)', re)).toEqual([
      { from: 0, to: 5 },
      { from: 28, to: 33 },
    ]);
  });
});

describe('findMatches', () => {
  it('lists matches across cells, in document order', () => {
    const { matches } = findMatches(
      [cell('a', 'const tempo = 90;'), cell('b', 'no hit'), cell('c', 'play(tempo); tempo++')],
      { query: 'tempo' }
    );
    expect(matches).toEqual([
      { cellId: 'a', from: 6, to: 11 },
      { cellId: 'c', from: 5, to: 10 },
      { cellId: 'c', from: 13, to: 18 },
    ]);
  });

  it('searches prose cells too', () => {
    const { matches } = findMatches([cell('m', '## Tempo notes', { type: 'markdown' })], { query: 'tempo' });
    expect(matches).toHaveLength(1);
  });

  it('skips empty matches rather than listing one between every character', () => {
    expect(findMatches([cell('a', 'abc')], { query: 'x*', regex: true }).matches).toEqual([]);
  });

  it('passes the regex error through', () => {
    expect(findMatches([cell('a', 'x')], { query: '[', regex: true }).error).toBeTruthy();
  });
});

describe('expandReplacement', () => {
  const match = (() => {
    const m = /(?<note>[A-G])(\d)/.exec('C4')!;
    return m;
  })();

  it('expands numbered and named groups, the whole match, and $$', () => {
    expect(expandReplacement('$2-$1', match)).toBe('4-C');
    expect(expandReplacement('$<note>!', match)).toBe('C!');
    expect(expandReplacement('[$&]', match)).toBe('[C4]');
    expect(expandReplacement('$$1', match)).toBe('$1');
  });

  it('leaves a reference to a group that does not exist as written', () => {
    expect(expandReplacement('$9', match)).toBe('$9');
  });
});

describe('replaceOne', () => {
  it('replaces exactly the match at that position', () => {
    expect(replaceOne('tempo tempo tempo', 6, { query: 'tempo' }, 'bpm')).toBe('tempo bpm tempo');
  });

  it('keeps a $ literal in plain mode', () => {
    // Someone typing a dollar sign into the replace box means a dollar sign.
    expect(replaceOne('price', 0, { query: 'price' }, '$1')).toBe('$1');
  });

  it('expands groups in regex mode', () => {
    expect(replaceOne('pitch: 60', 0, { query: '(\\w+): (\\d+)', regex: true }, '$2 $1')).toBe('60 pitch');
  });

  it('keeps the context a lookbehind needs', () => {
    // Cut out of its surroundings, `(?<=x)a` no longer matches `a`.
    expect(replaceOne('xa ya', 1, { query: '(?<=x)a', regex: true }, 'B')).toBe('xB ya');
  });

  it('refuses a position where there is no match', () => {
    expect(replaceOne('tempo', 2, { query: 'tempo' }, 'x')).toBeNull();
  });
});

describe('replaceAllInText', () => {
  it('counts and replaces every match', () => {
    expect(replaceAllInText('a a a', { query: 'a' }, 'b')).toEqual({ text: 'b b b', count: 3 });
  });

  it('expands named groups for each match', () => {
    const out = replaceAllInText('C4 D5', { query: '(?<n>[A-G])(\\d)', regex: true }, '$<n>$2!');
    expect(out).toEqual({ text: 'C4! D5!', count: 2 });
  });

  it('keeps $ literal in plain mode here too', () => {
    expect(replaceAllInText('a a', { query: 'a' }, '$&').text).toBe('$& $&');
  });
});

describe('replaceAll across the notebook', () => {
  const unlocked = () => false;

  it('rewrites every matching cell and remembers what each held', () => {
    const cells = [cell('a', 'tempo'), cell('b', 'x'), cell('c', 'tempo tempo')];
    const result = replaceAll(cells, { query: 'tempo' }, 'bpm', unlocked);
    expect(result.cells.map((c) => c.content)).toEqual(['bpm', 'x', 'bpm bpm']);
    expect(result.replaced).toBe(3);
    expect(result.before).toEqual(new Map([['a', 'tempo'], ['c', 'tempo tempo']]));
    // Untouched cells are the same objects: nothing to re-render, nothing dirty.
    expect(result.cells[1]).toBe(cells[1]);
  });

  it('never rewrites a locked cell, and says how many it left', () => {
    const cells = [cell('a', 'tempo'), cell('b', 'tempo tempo', { readOnly: true })];
    const result = replaceAll(cells, { query: 'tempo' }, 'bpm', (c) => c.readOnly === true);
    expect(result.cells[1].content).toBe('tempo tempo');
    expect(result.replaced).toBe(1);
    expect(result.skippedLocked).toBe(2);
  });

  it('does nothing without a valid query', () => {
    const cells = [cell('a', 'tempo')];
    expect(replaceAll(cells, { query: '(', regex: true }, 'x', unlocked).cells).toBe(cells);
  });
});

describe('undoReplaceAll', () => {
  it('puts back what the replacement changed', () => {
    const original = [cell('a', 'tempo'), cell('b', 'tempo')];
    const done = replaceAll(original, { query: 'tempo' }, 'bpm', () => false);
    const after = new Map(done.cells.map((c) => [c.id, c.content]));
    const undone = undoReplaceAll(done.cells, done.before, after);
    expect(undone.cells.map((c) => c.content)).toEqual(['tempo', 'tempo']);
    expect(undone.restored).toBe(2);
  });

  it('does not undo what the reader typed since', () => {
    const done = replaceAll([cell('a', 'tempo'), cell('b', 'tempo')], { query: 'tempo' }, 'bpm', () => false);
    const after = new Map(done.cells.map((c) => [c.id, c.content]));
    const edited = done.cells.map((c) => (c.id === 'b' ? { ...c, content: 'bpm + edits' } : c));
    const undone = undoReplaceAll(edited, done.before, after);
    expect(undone.cells.map((c) => c.content)).toEqual(['tempo', 'bpm + edits']);
    expect(undone.changedSince).toBe(1);
  });
});
