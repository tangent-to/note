/**
 * The diff a reader accepts a cell rewrite from.
 *
 * The whole safety story of letting an assistant edit cells rests on this being
 * accurate: if a changed line renders as unchanged, the reader approves an edit
 * they never saw.
 */
import { describe, it, expect } from 'vitest';
import { diffLines, diffStat } from '../lineDiff';

const render = (before: string, after: string) =>
  diffLines(before, after).map((l) => `${l.op === 'add' ? '+' : l.op === 'remove' ? '-' : ' '}${l.text}`);

describe('diffLines', () => {
  it('marks nothing when nothing changed', () => {
    expect(render('a\nb', 'a\nb')).toEqual([' a', ' b']);
    expect(diffStat(diffLines('a\nb', 'a\nb'))).toEqual({ added: 0, removed: 0 });
  });

  it('keeps the untouched lines around a single edit', () => {
    // The common case, and the one that has to read well: one line changed in
    // the middle of a cell the model otherwise left alone.
    expect(render('a\nb\nc', 'a\nB\nc')).toEqual([' a', '-b', '+B', ' c']);
  });

  it('reports pure insertions and pure deletions', () => {
    expect(render('a\nc', 'a\nb\nc')).toEqual([' a', '+b', ' c']);
    expect(render('a\nb\nc', 'a\nc')).toEqual([' a', '-b', ' c']);
  });

  it('handles an empty side', () => {
    expect(render('', 'a')).toEqual(['-', '+a']);
    expect(render('a\nb', '')).toEqual(['-a', '-b', '+']);
  });

  it('does not turn a trailing newline into a phantom line', () => {
    expect(render('a\n', 'a\n')).toEqual([' a']);
    expect(diffStat(diffLines('const x = 1\n', 'const x = 1'))).toEqual({ added: 0, removed: 0 });
  });

  it('counts what changed', () => {
    const stat = diffStat(diffLines('a\nb\nc', 'a\nB\nC\nd'));
    expect(stat).toEqual({ added: 3, removed: 2 });
  });

  it('finds the common lines rather than replacing wholesale', () => {
    // A moved block still shares its lines; showing the cell as entirely
    // rewritten would bury the one line that actually differs.
    const lines = diffLines(
      'const a = 1\nconst b = 2\nconst c = 3',
      'const a = 1\nconst c = 3'
    );
    expect(diffStat(lines)).toEqual({ added: 0, removed: 1 });
    expect(lines.filter((l) => l.op === 'same')).toHaveLength(2);
  });

  it('falls back to a wholesale replacement on a pathological paste', () => {
    const huge = Array.from({ length: 1600 }, (_, i) => `line ${i}`).join('\n');
    const lines = diffLines(huge, 'small');
    expect(lines.every((l) => l.op !== 'same')).toBe(true);
    expect(diffStat(lines)).toEqual({ added: 1, removed: 1600 });
  });
});
