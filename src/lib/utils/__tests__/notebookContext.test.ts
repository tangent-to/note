/**
 * What the assistant is actually shown of the notebook.
 *
 * The first version concatenated every cell and cut the string at a fixed
 * length, so in any notebook long enough to matter the tail did not exist as
 * far as the model was concerned — it could neither mention those cells nor
 * avoid redefining what they already defined. These cases are about the budget:
 * that every cell survives in some form, and that the cell being edited is
 * never the one that got cut.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildNotebookContext, shareBudget } from '../notebookContext';
import type { Notebook, NotebookCell } from '../../types/notebook';

vi.mock('../aiContext', () => ({ loadAIContext: () => '' }));

function nb(cells: Partial<NotebookCell>[]): Notebook {
  return {
    id: 'nb',
    name: 'Test notebook',
    createdAt: 0,
    updatedAt: 0,
    cells: cells.map((c, i) => ({
      id: c.id ?? `cell-${i + 1}`,
      type: c.type ?? 'code',
      content: c.content ?? '',
      ...c,
    })) as NotebookCell[],
  };
}

describe('shareBudget', () => {
  it('gives everyone what they need when the budget covers it', () => {
    expect(shareBudget([10, 20, 30], 1000)).toEqual([10, 20, 30]);
  });

  it('hands a short item\u2019s leftovers to the long ones', () => {
    // An equal cut would mutilate the one-line cell to pay for the long one.
    expect(shareBudget([2, 100], 60)).toEqual([2, 58]);
  });

  it('splits evenly between items that all overflow', () => {
    expect(shareBudget([100, 100], 60)).toEqual([30, 30]);
  });

  it('gives nothing away when there is nothing to give', () => {
    expect(shareBudget([10, 10], 0)).toEqual([0, 0]);
    expect(shareBudget([10, 10], -5)).toEqual([0, 0]);
    expect(shareBudget([], 100)).toEqual([]);
  });
});

describe('buildNotebookContext', () => {
  it('is empty for nothing to describe', () => {
    expect(buildNotebookContext(null)).toBe('');
    expect(buildNotebookContext(nb([]))).toBe('');
  });

  it('numbers every cell, which is the address the rest of the feature uses', () => {
    const text = buildNotebookContext(nb([{ content: 'a' }, { content: 'b', type: 'markdown' }]));
    expect(text).toContain('--- Cell 1 [JavaScript] ---');
    expect(text).toContain('--- Cell 2 [Markdown] ---');
  });

  it('never drops a cell, however tight the budget', () => {
    // The defect this replaced: cells past the cut simply were not there.
    const notebook = nb(
      Array.from({ length: 30 }, (_, i) => ({ content: `const c${i} = ${'x'.repeat(200)}` }))
    );
    const text = buildNotebookContext(notebook, { maxChars: 1200 });
    for (let i = 1; i <= 30; i++) {
      expect(text).toContain(`--- Cell ${i} [JavaScript] ---`);
    }
  });

  it('writes the focus cell in full and marks it', () => {
    const long = 'const answer = ' + '9'.repeat(3000);
    const notebook = nb([
      { id: 'a', content: 'x'.repeat(3000) },
      { id: 'b', content: long },
    ]);
    const text = buildNotebookContext(notebook, { maxChars: 1500, focusCellId: 'b' });

    expect(text).toContain('<<< THE CELL IN QUESTION');
    // In full: an assistant that has seen half a cell will delete the rest.
    expect(text).toContain(long);
    // And the other one paid for it — here down to nothing, which is said
    // plainly rather than rendered as an empty cell.
    expect(text).not.toContain('x'.repeat(3000));
    expect(text).toContain('omitted');
  });

  it('keeps short cells whole while cutting the long one', () => {
    const notebook = nb([
      { content: 'const a = 1' },
      { content: 'const b = 2' },
      { content: 'z'.repeat(5000) },
    ]);
    const text = buildNotebookContext(notebook, { maxChars: 900 });
    expect(text).toContain('const a = 1');
    expect(text).toContain('const b = 2');
    expect(text).toContain('[cell truncated]');
  });

  it('reports a cell it had no room for rather than showing it as empty', () => {
    const notebook = nb(
      Array.from({ length: 20 }, () => ({ content: 'y'.repeat(500) }))
    );
    const text = buildNotebookContext(notebook, { maxChars: 700 });
    expect(text).toContain('omitted');
    expect(text).not.toContain('(empty)');
  });

  it('carries outputs, but not at the expense of the code', () => {
    const notebook = nb([
      { content: 'const x = 1', output: { type: 'text', content: '1', timestamp: 0 } },
    ]);
    const text = buildNotebookContext(notebook);
    expect(text).toContain('const x = 1');
    expect(text).toContain('Output:\n1');

    // When the budget cannot cover both, the code wins: an output without the
    // code that produced it tells the assistant nothing it can act on.
    const big = nb([
      { content: 'a'.repeat(400), output: { type: 'text', content: 'b'.repeat(400), timestamp: 0 } },
    ]);
    const tight = buildNotebookContext(big, { maxChars: 300 });
    expect(tight).toContain('aaa');
    expect(tight).not.toContain('Output:');
  });

  it('labels an error output as one', () => {
    const notebook = nb([
      { content: 'boom()', output: { type: 'error', content: 'Error: boom', timestamp: 0 } },
    ]);
    expect(buildNotebookContext(notebook)).toContain('Error output:');
  });

  it('flags a skipped cell, which does not run', () => {
    expect(buildNotebookContext(nb([{ content: 'a', skipped: true }])))
      .toContain('--- Cell 1 [JavaScript] skipped ---');
  });
});
