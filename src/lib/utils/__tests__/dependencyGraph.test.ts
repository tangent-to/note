import { describe, it, expect } from 'vitest';
import { analyzeCell, computeStaleCells, hashCode, type CellLike, type RunRecord } from '../dependencyGraph';

describe('analyzeCell', () => {
  it('extracts top-level definitions', () => {
    const { defines } = analyzeCell('const a = 1;\nlet b = 2;\nfunction c() {}\nclass D {}');
    expect([...defines].sort()).toEqual(['D', 'a', 'b', 'c']);
  });

  it('extracts destructuring bindings', () => {
    const { defines } = analyzeCell('const { x, y: z } = obj;\nconst [p, q] = arr;');
    expect([...defines].sort()).toEqual(['p', 'q', 'x', 'z']);
  });

  it('captures reads but not property accesses or its own defines', () => {
    const { reads } = analyzeCell('const total = price * qty;\ntotal.toFixed(2);');
    expect(reads.has('price')).toBe(true);
    expect(reads.has('qty')).toBe(true);
    expect(reads.has('toFixed')).toBe(false); // property access
    expect(reads.has('total')).toBe(false);   // own definition
  });

  it('treats explicit globals as definitions but not bare assignments', () => {
    // Bare `temp = ...` is a non-portable implicit global → not a definition.
    // `globalThis.count = ...` is the portable explicit form → a definition.
    const { defines } = analyzeCell('temp = aq.fromCSV(data);\nglobalThis.count = 3;');
    expect(defines.has('temp')).toBe(false);
    expect(defines.has('count')).toBe(true);
  });

  it('does not mistake comparisons or arrows for definitions', () => {
    const { defines } = analyzeCell('ready === true;\nconst fn = () => 1;');
    expect(defines.has('ready')).toBe(false);
    expect(defines.has('fn')).toBe(true);
  });

  it('treats imported bindings as definitions', () => {
    const { defines } = analyzeCell('import * as aq from "arquero";\nimport Plot from "@observablehq/plot";\nimport { mean, sum as total } from "d3";');
    expect([...defines].sort()).toEqual(['Plot', 'aq', 'mean', 'total']);
  });

  it('ignores identifiers inside strings and comments', () => {
    const { reads } = analyzeCell('// uses foo\nconst s = "bar baz";');
    expect(reads.has('foo')).toBe(false);
    expect(reads.has('bar')).toBe(false);
  });
});

describe('computeStaleCells', () => {
  const cells: CellLike[] = [
    { id: 'a', type: 'code', content: 'const x = 1;' },
    { id: 'b', type: 'code', content: 'const y = x + 1;' },
    { id: 'c', type: 'code', content: 'console.log(y);' },
  ];

  function runInfoAt(times: Record<string, number>): Map<string, RunRecord> {
    const map = new Map<string, RunRecord>();
    for (const c of cells) {
      if (times[c.id] !== undefined) {
        map.set(c.id, { at: times[c.id], hash: hashCode(c.content) });
      }
    }
    return map;
  }

  it('reports nothing stale when all ran in order with matching hashes', () => {
    const stale = computeStaleCells(cells, runInfoAt({ a: 1, b: 2, c: 3 }));
    expect(stale.size).toBe(0);
  });

  it('marks an edited cell and its transitive dependents stale', () => {
    const runInfo = runInfoAt({ a: 1, b: 2, c: 3 });
    // 'a' was edited since it ran (hash no longer matches).
    const edited = cells.map((c) => (c.id === 'a' ? { ...c, content: 'const x = 99;' } : c));
    const stale = computeStaleCells(edited, runInfo);
    expect(stale.has('a')).toBe(true); // edited
    expect(stale.has('b')).toBe(true); // reads x
    expect(stale.has('c')).toBe(true); // reads y (transitive)
  });

  it('marks a downstream cell stale when its dependency ran more recently', () => {
    // 'a' ran after 'b' (e.g. user re-ran 'a' only).
    const stale = computeStaleCells(cells, runInfoAt({ a: 5, b: 2, c: 6 }));
    expect(stale.has('b')).toBe(true);  // depends on x, which ran later
    expect(stale.has('a')).toBe(false);
  });

  it('tracks dependencies through const declarations (portable cross-cell style)', () => {
    const nbCells: CellLike[] = [
      { id: 'load', type: 'code', content: 'const temp = aq.fromCSV(raw);' },
      { id: 'view', type: 'code', content: 'temp.slice(0, 8);' },
    ];
    const runInfo = new Map<string, RunRecord>([
      ['load', { at: 1, hash: hashCode(nbCells[0].content) }],
      ['view', { at: 2, hash: hashCode(nbCells[1].content) }],
    ]);
    // Re-run 'load' more recently than 'view'.
    runInfo.set('load', { at: 5, hash: hashCode(nbCells[0].content) });
    const stale = computeStaleCells(nbCells, runInfo);
    expect(stale.has('view')).toBe(true);
  });

  it('does not mark never-run cells as stale', () => {
    const stale = computeStaleCells(cells, runInfoAt({ a: 1 }));
    expect(stale.has('b')).toBe(false);
    expect(stale.has('c')).toBe(false);
  });
});
