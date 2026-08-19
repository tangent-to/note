import { describe, it, expect } from 'vitest';
import { ROW_WINDOW, tableSpec } from '../tableData';

/** A minimal stand-in for the Arquero surface the executor looks for. */
function fakeTable(rows: Record<string, unknown>[], columns?: string[]) {
  return {
    objects: (opts?: { limit?: number }) =>
      opts?.limit != null ? rows.slice(0, opts.limit) : rows,
    columnNames: () => columns ?? Object.keys(rows[0] ?? {}),
    numRows: () => rows.length,
  };
}

describe('tableSpec', () => {
  it('ignores values that are not tables', () => {
    expect(tableSpec(null)).toBeNull();
    expect(tableSpec([{ a: 1 }])).toBeNull();      // plain arrays go to the inspector
    expect(tableSpec({ objects: () => [] })).toBeNull();
  });

  it('captures columns, rows and the true row count', () => {
    const spec = tableSpec(fakeTable([{ a: 1, b: 'x' }, { a: 2, b: 'y' }]))!;
    expect(spec.columns).toEqual(['a', 'b']);
    expect(spec.rows).toEqual([{ a: 1, b: 'x' }, { a: 2, b: 'y' }]);
    expect(spec.totalRows).toBe(2);
  });

  it('sends a window of a large table and still reports the full count', () => {
    const rows = Array.from({ length: 50_000 }, (_, i) => ({ i }));
    const spec = tableSpec(fakeTable(rows))!;
    expect(spec.rows).toHaveLength(ROW_WINDOW);
    expect(spec.totalRows).toBe(50_000);          // the caller can say what is missing
  });

  it('types each column from its first defined value', () => {
    const spec = tableSpec(fakeTable([
      { n: null, s: null, b: null, d: null },
      { n: 3.5, s: 'text', b: false, d: new Date('2024-01-02T03:04:05Z') },
    ]))!;
    expect(spec.types).toEqual({ n: 'number', s: 'string', b: 'boolean', d: 'date' });
  });

  it('serializes dates so they survive the trip to the main thread', () => {
    const spec = tableSpec(fakeTable([{ d: new Date('2024-01-02T03:04:05Z') }]))!;
    expect(spec.rows[0].d).toBe('2024-01-02T03:04:05.000Z');
    expect(JSON.parse(JSON.stringify(spec))).toEqual(spec);   // round-trips intact
  });

  it('fills missing keys so every row has every column', () => {
    const spec = tableSpec(fakeTable([{ a: 1 }, { a: 2, b: 9 }], ['a', 'b']))!;
    expect(spec.rows).toEqual([{ a: 1, b: undefined }, { a: 2, b: 9 }]);
  });
});
