/**
 * The library against a real IndexedDB (fake-indexeddb), rather than its pure
 * helpers.
 *
 * The pure logic is covered next door in notebookLibrary.test.ts. What is here
 * is everything that actually touches storage, and one path in particular:
 * `migrateLegacyAutosave` runs **once per browser**, reads the single slot
 * where a notebook used to live, and deletes it once the copy is stored. It is
 * the only irreversible thing in the library, it cannot be replayed to see
 * whether it worked, and a defect in it loses someone's only notebook.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import type { Notebook } from '../../types/notebook';

const LEGACY_KEY = 'tangent-notebook-autosave';
const LEGACY_META_KEY = 'tangent-notebook-meta';
const SESSION_KEY = 'tangent-open-notebooks';
const LEGACY_ACTIVE_KEY = 'tangent-active-notebook';

// Node has no localStorage here; the library must treat it as ordinary storage.
const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  },
});

const realIndexedDB = globalThis.indexedDB;

function deleteDatabase(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('tangent');
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

/**
 * A library module with no memory of the previous test: the module holds the
 * in-memory fallback map and the "is IndexedDB working" flag, so the module
 * registry has to be reset alongside the database.
 */
async function freshLibrary() {
  await deleteDatabase();
  store.clear();
  vi.resetModules();
  return import('../notebookLibrary');
}

function makeNotebook(id: string, over: Partial<Notebook> = {}): Notebook {
  return {
    id,
    name: id,
    cells: [{ id: `${id}-c1`, type: 'code', content: 'const x = 1' }],
    createdAt: 1000,
    updatedAt: 2000,
    ...over,
  };
}

const local = { kind: 'local' } as const;
const link = { kind: 'url', href: 'https://x.dev/a.js' } as const;

afterEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: realIndexedDB,
  });
});

describe('storing and reading notebooks', () => {
  it('round-trips a notebook through IndexedDB', async () => {
    const lib = await freshLibrary();
    const key = await lib.putNotebook(makeNotebook('a'), local);

    const record = await lib.getNotebookRecord(key);
    expect(record?.notebook.cells[0].content).toBe('const x = 1');
    expect(record?.origin).toEqual(local);
    expect(get(lib.libraryPersistent)).toBe(true);
  });

  it('keeps one notebook from two origins as two records', async () => {
    const lib = await freshLibrary();
    // The id travels in the .js file, so a link and a local copy share it.
    // One record for both would mean opening a link overwrites local work.
    const localKey = await lib.putNotebook(makeNotebook('a', { name: 'Mine' }), local);
    const linkKey = await lib.putNotebook(makeNotebook('a', { name: 'Theirs' }), link);

    expect(localKey).not.toBe(linkKey);
    expect((await lib.getNotebookRecord(localKey))?.name).toBe('Mine');
    expect((await lib.getNotebookRecord(linkKey))?.name).toBe('Theirs');

    await lib.refreshLibrary();
    expect(get(lib.libraryEntries)).toHaveLength(2);
  });

  it('updates a record rather than duplicating it', async () => {
    const lib = await freshLibrary();
    await lib.putNotebook(makeNotebook('a', { name: 'First' }), local);
    await lib.putNotebook(makeNotebook('a', { name: 'Second' }), local);

    await lib.refreshLibrary();
    const entries = get(lib.libraryEntries);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('Second');
  });

  it('carries lastOpenedAt across writes, and moves it only on an open', async () => {
    const lib = await freshLibrary();
    const key = await lib.putNotebook(makeNotebook('a'), local, { opened: true });
    const first = (await lib.getNotebookRecord(key))!.lastOpenedAt;

    await lib.putNotebook(makeNotebook('a', { name: 'edited' }), local);
    expect((await lib.getNotebookRecord(key))!.lastOpenedAt).toBe(first);

    await new Promise((r) => setTimeout(r, 2));
    await lib.putNotebook(makeNotebook('a'), local, { opened: true });
    expect((await lib.getNotebookRecord(key))!.lastOpenedAt).toBeGreaterThan(first);
  });

  it('deletes for good, and drops the row', async () => {
    const lib = await freshLibrary();
    const key = await lib.putNotebook(makeNotebook('a'), local);
    await lib.deleteNotebook(key);

    expect(await lib.getNotebookRecord(key)).toBeUndefined();
    expect(get(lib.libraryEntries)).toHaveLength(0);

    // And it stays deleted across a reload of the module.
    const reloaded = await import('../notebookLibrary');
    await reloaded.refreshLibrary();
    expect(get(reloaded.libraryEntries)).toHaveLength(0);
  });

  it('lists what is stored, alphabetically', async () => {
    const lib = await freshLibrary();
    await lib.putNotebook(makeNotebook('c', { name: 'test 2' }), local);
    await lib.putNotebook(makeNotebook('a', { name: 'test 10' }), local);
    await lib.putNotebook(makeNotebook('b', { name: 'test 1' }), local);

    vi.resetModules();
    const reloaded = await import('../notebookLibrary');
    await reloaded.refreshLibrary();
    expect(get(reloaded.libraryEntries).map((e) => e.name))
      .toEqual(['test 1', 'test 10', 'test 2']);
  });
});

describe('migrating the pre-library autosave slot', () => {
  it('moves the notebook in and clears the old slot', async () => {
    const lib = await freshLibrary();
    localStorage.setItem(LEGACY_KEY, JSON.stringify(makeNotebook('old', { name: 'Rescued' })));
    localStorage.setItem(LEGACY_META_KEY, JSON.stringify({ savedAt: 1, name: 'Rescued', cellCount: 1 }));

    const key = await lib.migrateLegacyAutosave();

    expect(key).toBe('old');
    expect((await lib.getNotebookRecord('old'))?.name).toBe('Rescued');
    // Only once the copy is safely stored.
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_META_KEY)).toBeNull();
  });

  it('is idempotent, and does not resurrect a notebook deleted since', async () => {
    const lib = await freshLibrary();
    localStorage.setItem(LEGACY_KEY, JSON.stringify(makeNotebook('old')));

    await lib.migrateLegacyAutosave();
    await lib.deleteNotebook('old');

    // The slot is gone, so a second pass finds nothing to bring back.
    expect(await lib.migrateLegacyAutosave()).toBeNull();
    expect(await lib.getNotebookRecord('old')).toBeUndefined();
  });

  it('never overwrites a newer library entry', async () => {
    const lib = await freshLibrary();
    await lib.putNotebook(makeNotebook('old', { name: 'Newer', updatedAt: 9000 }), local);
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify(makeNotebook('old', { name: 'Stale', updatedAt: 1 }))
    );

    await lib.migrateLegacyAutosave();
    expect((await lib.getNotebookRecord('old'))?.name).toBe('Newer');
  });

  it('does take over an older library entry', async () => {
    const lib = await freshLibrary();
    await lib.putNotebook(makeNotebook('old', { name: 'Older', updatedAt: 1 }), local);
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify(makeNotebook('old', { name: 'Fresher', updatedAt: 9000 }))
    );

    await lib.migrateLegacyAutosave();
    expect((await lib.getNotebookRecord('old'))?.name).toBe('Fresher');
  });

  it('leaves junk alone rather than throwing', async () => {
    const lib = await freshLibrary();
    expect(await lib.migrateLegacyAutosave()).toBeNull();

    localStorage.setItem(LEGACY_KEY, 'not json');
    expect(await lib.migrateLegacyAutosave()).toBeNull();

    localStorage.setItem(LEGACY_KEY, JSON.stringify({ id: 'x' })); // no cells
    expect(await lib.migrateLegacyAutosave()).toBeNull();

    // Nothing was destroyed on the way past.
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull();
  });
});

describe('when IndexedDB will not open', () => {
  async function libraryWithoutIDB() {
    await deleteDatabase();
    store.clear();
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
    vi.resetModules();
    return import('../notebookLibrary');
  }

  it('keeps working in memory and says so', async () => {
    const lib = await libraryWithoutIDB();
    const key = await lib.putNotebook(makeNotebook('a'), local);

    expect(get(lib.libraryPersistent)).toBe(false);
    expect((await lib.getNotebookRecord(key))?.name).toBe('a');
    expect(get(lib.libraryEntries)).toHaveLength(1);
  });

  it('mirrors the notebook to the old slot, so a reload still finds it', async () => {
    // Firefox private windows have no IndexedDB but do have localStorage, and
    // that slot is where the notebook used to live. Degrading to memory alone
    // would take durability away from the readers who have the least of it.
    const lib = await libraryWithoutIDB();
    await lib.putNotebook(makeNotebook('a', { name: 'Lifeboat' }), local);

    const mirrored = JSON.parse(localStorage.getItem(LEGACY_KEY)!);
    expect(mirrored.name).toBe('Lifeboat');
    expect(JSON.parse(localStorage.getItem(LEGACY_META_KEY)!).cellCount).toBe(1);
  });

  it('does not clear the old slot it could not replace', async () => {
    const lib = await libraryWithoutIDB();
    localStorage.setItem(LEGACY_KEY, JSON.stringify(makeNotebook('old', { name: 'Only copy' })));

    await lib.migrateLegacyAutosave();

    // The library is in memory only, so this slot is still the sole durable
    // copy of the reader's work. Deleting it here would be the one way this
    // whole feature could lose a notebook outright.
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull();
    expect(JSON.parse(localStorage.getItem(LEGACY_KEY)!).name).toBe('Only copy');
  });
});

describe('the session index', () => {
  it('round-trips the open tabs and the active one', async () => {
    const lib = await freshLibrary();
    lib.rememberOpenSessions(['a', 'b', 'c'], 'b');
    expect(lib.lastOpenSessions()).toEqual({ open: ['a', 'b', 'c'], active: 'b' });
  });

  it('carries over the single pointer from before tabs', async () => {
    const lib = await freshLibrary();
    localStorage.setItem(LEGACY_ACTIVE_KEY, 'the-one-i-had');
    expect(lib.lastOpenSessions()).toEqual({
      open: ['the-one-i-had'],
      active: 'the-one-i-had',
    });
  });

  it('reads empty rather than throwing on junk', async () => {
    const lib = await freshLibrary();
    localStorage.setItem(SESSION_KEY, 'not json');
    expect(lib.lastOpenSessions()).toEqual({ open: [], active: null });

    localStorage.setItem(SESSION_KEY, JSON.stringify({ open: 'nope', active: 5 }));
    expect(lib.lastOpenSessions()).toEqual({ open: [], active: null });
  });

  it('records identity only, so a stale copy can never be restored over a newer one', async () => {
    const lib = await freshLibrary();
    lib.rememberOpenSessions(['a'], 'a');
    const raw = localStorage.getItem(SESSION_KEY)!;
    expect(raw).not.toContain('cells');
    expect(raw).not.toContain('content');
  });
});
