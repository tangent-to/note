/**
 * The preview an output carries for a structured value.
 *
 * CellOutput decides between the Observable inspector and a block of plain text
 * by one test: does the output text parse as JSON. So "stays valid JSON" is not
 * a nicety here, it is the whole feature — the previous version summarised any
 * array over 200 items into a string that could not parse, and every array big
 * enough to be worth looking at lost the inspector because of it.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_ARRAY_ITEMS,
  MAX_JSON_CHARS,
  describeValue,
  moreMarker,
  previewJson,
  previewValue,
} from '../valuePreview';

describe('previewValue', () => {
  it('leaves a short array exactly as it is', () => {
    expect(previewValue([1, 2, 3])).toEqual([1, 2, 3]);
    expect(previewValue([{ a: 1 }])).toEqual([{ a: 1 }]);
  });

  it('shortens a long array and names what it left out', () => {
    const rows = Array.from({ length: 344 }, (_, i) => ({ i }));
    const preview = previewValue(rows, 10);
    expect(preview).toHaveLength(11);
    expect(preview[9]).toEqual({ i: 9 });
    expect(preview[10]).toBe('… 334 more items');
  });

  it('says "item" for exactly one left out', () => {
    expect(moreMarker(1)).toBe('… 1 more item');
    expect(moreMarker(1000)).toBe('… 1,000 more items');
  });

  it('reaches arrays nested inside objects, which is where rows live', () => {
    const value = { name: 'penguins', rows: Array.from({ length: 50 }, (_, i) => i) };
    const preview = previewValue(value, 5);
    expect(preview.name).toBe('penguins');
    expect(preview.rows).toEqual([0, 1, 2, 3, 4, '… 45 more items']);
  });

  it('survives a cycle instead of throwing', () => {
    const a: any = { name: 'a' };
    a.self = a;
    expect(previewValue(a)).toEqual({ name: 'a', self: '[circular]' });
  });

  it('does not mistake ordinary sharing for a cycle', () => {
    // The same object twice, side by side, is not a loop; reporting it as one
    // would hide real data.
    const shared = { v: 1 };
    expect(previewValue([shared, shared])).toEqual([{ v: 1 }, { v: 1 }]);
  });

  it('leaves dates to their own serialisation', () => {
    // Walking a Date's own properties turns it into {}.
    const preview = previewValue({ at: new Date('2024-01-02T03:04:05Z') });
    expect(JSON.parse(JSON.stringify(preview)).at).toBe('2024-01-02T03:04:05.000Z');
  });

  it('summarises a branch deeper than it will walk', () => {
    let deep: any = { end: true };
    for (let i = 0; i < 40; i++) deep = { next: deep };
    const json = JSON.stringify(previewValue(deep));
    expect(json).toContain('{…}');
  });
});

describe('previewJson', () => {
  it('produces JSON that parses, which is what selects the inspector', () => {
    const rows = Array.from({ length: 344 }, (_, i) => ({ species: 'Adelie', i }));
    const json = previewJson(rows)!;
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toEqual({ species: 'Adelie', i: 0 });
  });

  it('keeps a 344-row frame whole, since it fits', () => {
    const rows = Array.from({ length: 344 }, (_, i) => ({ i }));
    expect(JSON.parse(previewJson(rows)!)).toHaveLength(344);
    expect(rows.length).toBeLessThan(MAX_ARRAY_ITEMS);
  });

  it('stays inside the size ceiling for a big frame', () => {
    const rows = Array.from({ length: 60000 }, (_, i) => ({
      i, name: `row ${i}`, value: i * 1.5, group: i % 7,
    }));
    const json = previewJson(rows)!;
    expect(json.length).toBeLessThanOrEqual(MAX_JSON_CHARS);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.stringify(JSON.parse(json))).toContain('more items');
  });

  it('gives up rather than storing something enormous', () => {
    // A handful of items, each far past the ceiling on its own.
    const huge = Array.from({ length: 4 }, () => ({ blob: 'x'.repeat(MAX_JSON_CHARS) }));
    expect(previewJson(huge)).toBeNull();
    expect(describeValue(huge)).toBe('Array(4) — too large to display');
  });

  it('returns null for values JSON cannot express', () => {
    expect(previewJson({ n: 1n })).toBeNull();
    expect(previewJson(() => 1)).toBeNull();
  });

  it('describes a plain object it could not preview', () => {
    expect(describeValue({})).toBe('Object — too large to display');
  });
});
