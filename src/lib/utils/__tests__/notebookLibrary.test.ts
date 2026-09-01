/**
 * The library's decision logic, without IndexedDB.
 *
 * Everything here is a pure function on purpose: the keying rule in particular
 * decides whether opening a link can silently overwrite local work, which is
 * not something to find out in a browser.
 */
import { describe, it, expect } from 'vitest';
import {
  buildRecord,
  entryOf,
  libraryId,
  originLabel,
  serializableNotebook,
  sortEntries,
  type LibraryEntry,
  type LibraryRecord,
} from '../notebookLibrary';
import type { Notebook } from '../../types/notebook';

function makeNotebook(over: Partial<Notebook> = {}): Notebook {
  return {
    id: 'notebook-1',
    name: 'Luum',
    cells: [{ id: 'c1', type: 'code', content: 'const x = 1' }],
    createdAt: 1000,
    updatedAt: 2000,
    ...over,
  };
}

describe('libraryId', () => {
  it('keys this browser’s own copy by the notebook id alone', () => {
    for (const origin of [
      { kind: 'local' } as const,
      { kind: 'sample' } as const,
      { kind: 'import', filename: 'luum.js' } as const,
    ]) {
      expect(libraryId('notebook-1', origin)).toBe('notebook-1');
    }
  });

  it('gives a link and a disk file their own keys', () => {
    // The id travels inside the .js file, so every copy of a notebook shares
    // it. Keying by identity alone would make opening a link overwrite the
    // local copy — the exact data loss the library exists to prevent.
    const local = libraryId('notebook-1', { kind: 'local' });
    const link = libraryId('notebook-1', { kind: 'url', href: 'https://x.dev/a.js' });
    const disk = libraryId('notebook-1', { kind: 'disk', path: '/home/e/a.js' });
    expect(new Set([local, link, disk]).size).toBe(3);
  });

  it('is idempotent per origin, so re-opening a link reuses its entry', () => {
    const origin = { kind: 'url', href: 'https://x.dev/a.js' } as const;
    expect(libraryId('notebook-1', origin)).toBe(libraryId('notebook-1', origin));
  });

  it('separates two files that carry the same notebook id', () => {
    expect(libraryId('nb', { kind: 'disk', path: '/a/n.js' })).not.toBe(
      libraryId('nb', { kind: 'disk', path: '/b/n.js' })
    );
  });
});

describe('originLabel', () => {
  it('names each kind of home the way the panel shows it', () => {
    expect(originLabel({ kind: 'local' })).toBe('local');
    expect(originLabel({ kind: 'sample' })).toBe('example');
    expect(originLabel({ kind: 'disk', path: '/home/e/rech/penguins.js' })).toBe('penguins.js');
    expect(originLabel({ kind: 'url', href: 'https://raw.githubusercontent.com/a/b.js' }))
      .toBe('raw.githubusercontent.com');
    expect(originLabel({ kind: 'import', filename: 'luum.js' })).toBe('luum.js');
  });

  it('falls back to the raw href when it will not parse', () => {
    expect(originLabel({ kind: 'url', href: 'not a url' })).toBe('not a url');
  });
});

describe('buildRecord', () => {
  it('carries forward what the notebook itself does not know', () => {
    const previous: LibraryEntry = {
      id: 'notebook-1',
      notebookId: 'notebook-1',
      name: 'Luum',
      createdAt: 500,
      updatedAt: 1500,
      lastOpenedAt: 1600,
      origin: { kind: 'import', filename: 'luum.js' },
      cellCount: 1,
      size: 10,
    };
    const record = buildRecord(makeNotebook(), undefined, 9999, previous);
    expect(record.createdAt).toBe(500);        // not the notebook's 1000
    expect(record.lastOpenedAt).toBe(1600);    // a write is not an open
    expect(record.origin).toEqual(previous.origin);
    expect(record.updatedAt).toBe(2000);       // this one does come from the doc
  });

  it('lets an explicit origin override the stored one', () => {
    const previous = buildRecord(makeNotebook(), { kind: 'local' }, 1);
    const moved = buildRecord(makeNotebook(), { kind: 'disk', path: '/a/n.js' }, 2, previous);
    expect(moved.origin).toEqual({ kind: 'disk', path: '/a/n.js' });
    expect(moved.id).toBe('notebook-1@file:/a/n.js');
    expect(moved.notebookId).toBe('notebook-1');
  });

  it('defaults a first-time entry to now and to local', () => {
    const record = buildRecord(makeNotebook({ createdAt: undefined as any }), undefined, 42);
    expect(record.createdAt).toBe(42);
    expect(record.lastOpenedAt).toBe(42);
    expect(record.origin).toEqual({ kind: 'local' });
  });

  it('stores a notebook whose outputs cannot be serialized', () => {
    // A `dom` output holds a live element with circular references. Storing it
    // raw would throw inside the autosave and lose the write entirely.
    const notebook = makeNotebook();
    const circular: any = { nodeName: 'DIV' };
    circular.self = circular;
    notebook.cells[0].output = { type: 'dom', content: circular, timestamp: 1 };
    const record = buildRecord(notebook, undefined, 1);
    expect(record.notebook.cells[0].output).toBeUndefined();
    expect(record.size).toBeGreaterThan(0);
  });

  it('counts cells and reports a size', () => {
    const record = buildRecord(makeNotebook(), undefined, 1);
    expect(record.cellCount).toBe(1);
    expect(record.size).toBe(JSON.stringify(record.notebook).length);
  });
});

describe('entryOf and sortEntries', () => {
  it('drops the payload from a row', () => {
    const record = buildRecord(makeNotebook(), undefined, 1) as LibraryRecord;
    expect('notebook' in entryOf(record)).toBe(false);
    expect(entryOf(record).name).toBe('Luum');
  });

  it('lists alphabetically, ignoring when anything was opened', () => {
    // Regression: ordering by last-opened made a row jump to the top of the
    // list the moment it was clicked, moving the map out from under the reader.
    const at = (id: string, name: string, lastOpenedAt: number): LibraryEntry => ({
      id, notebookId: id, name, createdAt: 0, updatedAt: 0,
      lastOpenedAt, origin: { kind: 'local' }, cellCount: 0, size: 0,
    });
    const entries = [at('1', 'test 2', 1), at('2', 'test 10', 5), at('3', 'test 1', 99)];
    expect(sortEntries(entries).map((e) => e.name)).toEqual(['test 1', 'test 10', 'test 2']);
    // Opening "test 2" must not reorder anything.
    entries[0].lastOpenedAt = 1000;
    expect(sortEntries(entries).map((e) => e.name)).toEqual(['test 1', 'test 10', 'test 2']);
  });

  it('keeps same-named entries in a stable order', () => {
    const same = (id: string): LibraryEntry => ({
      id, notebookId: 'nb', name: 'Same', createdAt: 0, updatedAt: 0,
      lastOpenedAt: 0, origin: { kind: 'local' }, cellCount: 0, size: 0,
    });
    expect(sortEntries([same('b'), same('a')]).map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('does not mutate its input', () => {
    const entries = [
      { id: 'a', notebookId: 'a', name: 'a', createdAt: 0, updatedAt: 0, lastOpenedAt: 1, origin: { kind: 'local' } as const, cellCount: 0, size: 0 },
      { id: 'b', notebookId: 'b', name: 'b', createdAt: 0, updatedAt: 0, lastOpenedAt: 2, origin: { kind: 'local' } as const, cellCount: 0, size: 0 },
    ];
    sortEntries(entries);
    expect(entries.map((e) => e.name)).toEqual(['a', 'b']);
  });
});

describe('serializableNotebook', () => {
  it('drops dom and table outputs, keeps the rest', () => {
    const notebook = makeNotebook({
      cells: [
        { id: 'a', type: 'code', content: '', output: { type: 'dom', content: 'x', timestamp: 1 } },
        { id: 'b', type: 'code', content: '', output: { type: 'table', content: '[]', timestamp: 1 } },
        { id: 'c', type: 'code', content: '', output: { type: 'text', content: '42', timestamp: 1 } },
        { id: 'd', type: 'code', content: '' },
      ],
    });
    const [a, b, c, d] = serializableNotebook(notebook).cells;
    expect(a.output).toBeUndefined();
    expect(b.output).toBeUndefined();
    expect(c.output?.content).toBe('42');
    expect(d.output).toBeUndefined();
  });
});

describe('buildRecord: opening vs writing', () => {
  it('only an open moves lastOpenedAt', () => {
    const first = buildRecord(makeNotebook(), undefined, 100, undefined, true);
    expect(first.lastOpenedAt).toBe(100);

    // An autosave two hours later is a write, not an open: the Storage panel's
    // "most recently opened first" ordering must not drift with typing.
    const written = buildRecord(makeNotebook(), undefined, 7_300_000, first);
    expect(written.lastOpenedAt).toBe(100);

    const reopened = buildRecord(makeNotebook(), undefined, 9_000_000, written, true);
    expect(reopened.lastOpenedAt).toBe(9_000_000);
  });
});
