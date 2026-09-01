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
    expect(tableSpec({ objects: () => [] })).toBeNull();
    expect(tableSpec([])).toBeNull();
    // Arrays of things that are not records: a structure, not a frame.
    expect(tableSpec([1, 2, 3])).toBeNull();
    expect(tableSpec(['a', 'b'])).toBeNull();
    expect(tableSpec([[1, 2], [3, 4]])).toBeNull();
    expect(tableSpec([new Date(), new Date()])).toBeNull();
    expect(tableSpec([{ a: 1 }, 'not a row'])).toBeNull();
    // An object with no fields has no columns to show.
    expect(tableSpec([{}, {}])).toBeNull();
  });

  describe('a plain array of records', () => {
    // These used to go to the inspector, on the grounds that it handles arrays
    // well. It does — but a frame of 344 rows read as a nest of expandable
    // objects is not how anyone wants to look at data, and the table was
    // already sortable, windowed and bounded in height.
    it('is a table', () => {
      const spec = tableSpec([{ a: 1, b: 'x' }, { a: 2, b: 'y' }])!;
      expect(spec.columns).toEqual(['a', 'b']);
      expect(spec.types).toEqual({ a: 'number', b: 'string' });
      expect(spec.rows).toEqual([{ a: 1, b: 'x' }, { a: 2, b: 'y' }]);
      expect(spec.totalRows).toBe(2);
    });

    it('reports the true length while sending only a window', () => {
      const rows = Array.from({ length: 50000 }, (_, i) => ({ i }));
      const spec = tableSpec(rows)!;
      expect(spec.rows).toHaveLength(1000);
      expect(spec.totalRows).toBe(50000);
    });

    it('takes columns from every row it sends, not just the first few', () => {
      // A field that only appears later still deserves a column.
      const rows: Record<string, unknown>[] = Array.from({ length: 30 }, () => ({ a: 1 }));
      rows.push({ a: 1, late: 'yes' });
      expect(tableSpec(rows)!.columns).toEqual(['a', 'late']);
    });

    it('leaves a class instance to the inspector', () => {
      // Its own keys are not fields, and reading them as columns produces a
      // table of nonsense.
      class Point { constructor(public x = 1, public y = 2) {} }
      expect(tableSpec([new Point(), new Point()])).toBeNull();
    });

    it('leaves a bag of unrelated objects alone', () => {
      const junk = Array.from({ length: 20 }, (_, i) => ({ [`key${i}`]: i }));
      // 20 rows sharing no keys is 20 columns — still a table, if a wide one.
      expect(tableSpec(junk)).not.toBeNull();
      const wider = Array.from({ length: 20 }, (_, i) =>
        Object.fromEntries(Array.from({ length: 10 }, (_, j) => [`k${i}_${j}`, j]))
      );
      expect(tableSpec(wider)).toBeNull();
    });

    it('serializes dates the same way it does for a real table', () => {
      const spec = tableSpec([{ d: new Date('2024-01-02T03:04:05Z') }])!;
      expect(spec.types.d).toBe('date');
      expect(spec.rows[0].d).toBe('2024-01-02T03:04:05.000Z');
    });
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
