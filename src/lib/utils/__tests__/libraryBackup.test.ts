/**
 * Library backups.
 *
 * A backup is only worth something if it comes back, so the round trip —
 * library, zip bytes, library — is tested whole, and so are the two promises a
 * restore makes: nothing newer here is overwritten by an older copy, and an
 * archive assembled by hand still restores from its files.
 */
import { describe, it, expect } from 'vitest';
import {
  DAY,
  backupFolderName,
  backupStatus,
  buildBackupEntries,
  parseBackupEntries,
  planRestore,
  summarizeRestore,
} from '../libraryBackup';
import { buildRecord, type LibraryEntry, type LibraryRecord } from '../notebookLibrary';
import type { DatasetRecord } from '../dataStore';
import { createZip, readZip } from '../zip';
import type { Notebook } from '../../types/notebook';

const NOW = new Date('2026-09-17T10:00:00');

function notebook(id: string, name: string, updatedAt = 1000, extra: Partial<Notebook> = {}): Notebook {
  return {
    id,
    name,
    createdAt: 500,
    updatedAt,
    cells: [
      { id: `${id}-md`, type: 'markdown', content: `# ${name}` },
      { id: `${id}-c1`, type: 'code', content: 'const tempo = 90;\ntempo * 2', output: { type: 'text', content: '180', timestamp: 1 } },
    ],
    ...extra,
  };
}

function record(nb: Notebook, origin: LibraryRecord['origin'] = { kind: 'local' }): LibraryRecord {
  return buildRecord(nb, origin, nb.updatedAt, undefined, false);
}

const dataset = (name: string, text: string, addedAt = 900): DatasetRecord => ({
  name,
  type: 'text/csv',
  size: text.length,
  addedAt,
  text,
});

const paths = (entries: { path: string }[]) => entries.map((e) => e.path);

describe('building a backup', () => {
  it('is a folder of .js notebooks, a data/ directory and an index', () => {
    const entries = buildBackupEntries(
      [record(notebook('a', 'Taaiot')), record(notebook('b', 'Luum'))],
      [dataset('penguins.csv', 'species\nAdelie\n')],
      NOW
    );
    const root = backupFolderName(NOW);
    expect(root).toBe('tangent-backup-2026-09-17');
    expect(paths(entries)).toEqual([
      `${root}/luum.js`,
      `${root}/taaiot.js`,
      `${root}/data/penguins.csv`,
      `${root}/.tangent/backup.json`,
    ]);
    // A real Tangent notebook the companion can open as it is.
    const js = new TextDecoder().decode(entries[1].data);
    expect(js).toContain('// title: Taaiot');
    expect(js).toContain('// %% [javascript]');
  });

  it('gives two notebooks with the same name different files', () => {
    const entries = buildBackupEntries(
      [record(notebook('a', 'untitled')), record(notebook('b', 'untitled'))],
      [],
      NOW
    );
    expect(paths(entries).filter((p) => p.endsWith('.js')).map((p) => p.split('/').pop())).toEqual([
      'untitled.js',
      'untitled-2.js',
    ]);
  });

  it('names files from accented titles readably', () => {
    const entries = buildBackupEntries([record(notebook('a', 'Mélodie d’été'))], [], NOW);
    expect(paths(entries)[0]).toMatch(/\/melodie-d-ete\.js$/);
  });
});

describe('the round trip', () => {
  it('brings back every notebook exactly, outputs and origins included', async () => {
    const records = [
      record(notebook('a', 'Taaiot', 2000)),
      record(notebook('b', 'Luum', 3000), { kind: 'url', href: 'https://example.com/luum.js' }),
    ];
    const datasets = [dataset('penguins.csv', 'species,mass\nAdelie,3750\n')];

    const zip = await createZip(buildBackupEntries(records, datasets, NOW));
    const parsed = parseBackupEntries(await readZip(zip));

    expect(parsed.exact).toBe(true);
    expect(parsed.warnings).toEqual([]);
    const byId = new Map(parsed.records.map((r) => [r.id, r]));
    for (const original of records) {
      const back = byId.get(original.id)!;
      expect(back.name).toBe(original.name);
      expect(back.updatedAt).toBe(original.updatedAt);
      expect(back.origin).toEqual(original.origin);
      // The .js format drops outputs; the index is what keeps them.
      expect(back.notebook.cells[1].output?.content).toBe('180');
      expect(back.notebook.cells.map((c) => c.content)).toEqual(original.notebook.cells.map((c) => c.content));
    }
    expect(parsed.datasets).toEqual(datasets);
  });

  it('restores from the files alone when the index is gone', async () => {
    // Someone unzipped the backup, deleted .tangent/, and zipped it again.
    const entries = buildBackupEntries([record(notebook('a', 'Taaiot'))], [dataset('p.csv', 'x\n1\n')], NOW)
      .filter((e) => !e.path.includes('.tangent/'));
    const parsed = parseBackupEntries(await readZip(await createZip(entries)), 42);

    expect(parsed.exact).toBe(false);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].id).toBe('a');
    expect(parsed.records[0].notebook.cells[1].content).toBe('const tempo = 90;\ntempo * 2');
    expect(parsed.datasets.map((d) => d.name)).toEqual(['p.csv']);
  });

  it('reads Observable notebooks and skips what it cannot use, saying so', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const parsed = parseBackupEntries([
      { path: 'folder/piece.html', data: enc('<notebook><title>Piece</title><script type="module" pinned>1</script></notebook>') },
      { path: 'folder/cover.png', data: new Uint8Array([137, 80, 78, 71]) },
      { path: 'folder/readme.md', data: enc('# notes') },
    ]);
    expect(parsed.records.map((r) => r.name)).toEqual(['Piece']);
    expect(parsed.datasets.map((d) => d.name)).toEqual(['readme.md']);
    expect(parsed.warnings.join(' ')).toMatch(/cover\.png/);
  });

  it('refuses an archive that is not a backup, or from a newer app', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(() => parseBackupEntries([{ path: '.tangent/backup.json', data: enc('{"format":"other"}') }])).toThrow(/not a tangent/);
    expect(() =>
      parseBackupEntries([{ path: '.tangent/backup.json', data: enc('{"format":"tangent-backup","version":99}') }])
    ).toThrow(/newer version/);
    expect(() => parseBackupEntries([{ path: '.tangent/backup.json', data: enc('{oops') }])).toThrow(/damaged/);
  });
});

describe('planning a restore', () => {
  const parsedWith = (records: LibraryRecord[], datasets: DatasetRecord[] = []) =>
    ({ records, datasets, warnings: [], exact: true });

  it('adds what is missing and never replaces newer work with an older copy', () => {
    const parsed = parsedWith([
      record(notebook('missing', 'Missing', 1000)),
      record(notebook('older-here', 'Older here', 2000)),
      record(notebook('newer-here', 'Newer here', 2000)),
      record(notebook('same', 'Same', 2000)),
    ]);
    const plan = planRestore(
      parsed,
      new Map([
        ['older-here', { updatedAt: 1500 }],
        ['newer-here', { updatedAt: 2500 }],
        ['same', { updatedAt: 2000 }],
      ]),
      new Map()
    );
    expect(plan.put.map((r) => r.id)).toEqual(['missing', 'older-here']);
    expect(plan.keptNewer.map((r) => r.id)).toEqual(['newer-here']);
    expect(plan.unchanged.map((r) => r.id)).toEqual(['same']);

    const report = summarizeRestore(plan, parsed).join('\n');
    expect(report).toMatch(/Restored 2 notebooks/);
    expect(report).toMatch(/Kept 1 notebook that is newer here/);
  });

  it('keeps a dataset here that differs from the backup, and says how to take the backup’s', () => {
    const parsed = parsedWith([], [dataset('a.csv', 'new'), dataset('b.csv', 'same'), dataset('c.csv', 'backup')]);
    const plan = planRestore(parsed, new Map(), new Map([['b.csv', 'same'], ['c.csv', 'edited here']]));
    expect(plan.datasetsToAdd.map((d) => d.name)).toEqual(['a.csv']);
    expect(plan.datasetsUnchanged.map((d) => d.name)).toEqual(['b.csv']);
    expect(plan.datasetsConflicting.map((d) => d.name)).toEqual(['c.csv']);
    expect(summarizeRestore(plan, parsed).join('\n')).toMatch(/Delete it first/);
  });
});

describe('when to ask for a backup', () => {
  const now = NOW.getTime();
  const entry = (origin: LibraryEntry['origin'], updatedAt: number, createdAt = updatedAt - 1): LibraryEntry => ({
    id: String(Math.random()),
    name: 'n',
    createdAt,
    updatedAt,
    lastOpenedAt: updatedAt,
    origin,
    cellCount: 1,
    size: 1,
  });

  it('does not ask about notebooks that are files on disk', () => {
    const status = backupStatus([entry({ kind: 'disk', path: 'a.js' }, now - 30 * DAY)], [], null, now);
    expect(status).toEqual({ pending: 0, due: false });
  });

  it('does not ask about the untouched example', () => {
    const untouched = entry({ kind: 'sample' }, now - 30 * DAY, now - 30 * DAY);
    expect(backupStatus([untouched], [], null, now).pending).toBe(0);
    const edited = entry({ kind: 'sample' }, now - 2 * DAY, now - 30 * DAY);
    expect(backupStatus([edited], [], null, now).pending).toBe(1);
  });

  it('gives new work a day before the first reminder', () => {
    expect(backupStatus([entry({ kind: 'local' }, now - 2 * 60 * 60 * 1000)], [], null, now).due).toBe(false);
    expect(backupStatus([entry({ kind: 'local' }, now - 2 * DAY)], [], null, now).due).toBe(true);
  });

  it('then asks at most weekly, and only when something changed', () => {
    const lastBackup = now - 3 * DAY;
    expect(backupStatus([entry({ kind: 'local' }, now - DAY)], [], lastBackup, now).due).toBe(false);
    expect(backupStatus([entry({ kind: 'local' }, now - DAY)], [], now - 8 * DAY, now).due).toBe(true);
    expect(backupStatus([entry({ kind: 'local' }, now - 9 * DAY)], [], now - 8 * DAY, now)).toEqual({ pending: 0, due: false });
  });

  it('counts datasets added since, and respects a snooze', () => {
    const datasets = [{ name: 'p.csv', type: 'text/csv', size: 1, addedAt: now - 2 * DAY }];
    expect(backupStatus([], datasets, null, now)).toEqual({ pending: 1, due: true });
    expect(backupStatus([], datasets, null, now, now + DAY).due).toBe(false);
  });
});
