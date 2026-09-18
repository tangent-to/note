/**
 * Reading and writing files from cells.
 *
 * Names resolve relative to the notebook's folder, as in Jupyter; a save
 * encodes the value the way the file name asks; and without `note serve` the
 * same calls degrade (Storage datasets, downloads) instead of breaking the
 * notebook. The network is faked with a map of files standing in for the
 * companion.
 */
import { describe, it, expect, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import {
  companionStore,
  createFileApi,
  virtualStore,
  encodeForSave,
  fileUrl,
  mimeTypeOf,
  resolveName,
  type WorkingDirectory,
} from '../workingDirectory';

/**
 * Just enough of d3-dsv for these tests (no quoting). What is tested is the
 * wiring — typed passes autoType, array asks for rows, formats pick the
 * delimiter — not d3's parser, which the app loads from the CDN.
 */
function fakeD3() {
  const autoType = (row: Record<string, string>) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) out[k] = v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
    return out;
  };
  const rows = (sep: string) => (text: string) => text.trim().split('\n').map((line) => line.split(sep));
  const parse = (sep: string) => (text: string, row?: (r: any) => any) => {
    const [head, ...body] = rows(sep)(text);
    const objects: any = body.map((cells) => {
      const obj = Object.fromEntries(head.map((h, i) => [h, cells[i]]));
      return row ? row(obj) : obj;
    });
    objects.columns = head;
    return objects;
  };
  const format = (sep: string) => (data: Record<string, unknown>[]) => {
    const head = Object.keys(data[0] ?? {});
    return [head.join(sep), ...data.map((d) => head.map((h) => String(d[h])).join(sep))].join('\n');
  };
  return {
    autoType,
    csvParse: parse(','),
    tsvParse: parse('\t'),
    csvParseRows: rows(','),
    tsvParseRows: rows('\t'),
    csvFormat: format(','),
    tsvFormat: format('\t'),
  };
}
const d3 = fakeD3();

const WD = { kind: 'companion', base: 'http://localhost:4321', dir: 'compo/oa' } as const;
const getD3 = async () => d3;
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

/** A tiny companion: GET and PUT on /__files against a map of files. */
function fakeCompanion(files: Record<string, string> = {}) {
  const disk = new Map(Object.entries(files));
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = decodeURIComponent(new URL(url).pathname.replace(/^\/__files\//, ''));
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if ((init?.method ?? 'GET') === 'PUT') {
      disk.set(path, decode(init!.body as Uint8Array));
      return new Response(JSON.stringify({ path, size: (init!.body as Uint8Array).length }), { status: 201 });
    }
    if (!disk.has(path)) return new Response(JSON.stringify({ error: `No file ${path}.` }), { status: 404 });
    return new Response(disk.get(path)!);
  });
  return { disk, calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

function api(overrides: Partial<Parameters<typeof createFileApi>[0]> = {}) {
  const companion = fakeCompanion({
    'compo/oa/penguins.csv': 'species,mass\nAdelie,3750\nGentoo,5000\n',
    'compo/oa/meta.json': '{"piece":"taaiot"}',
    'compo/shared/tempo.txt': '90',
  });
  const download = vi.fn();
  const deps = {
    store: () => companionStore(WD, companion.fetch),
    datasetText: async () => undefined,
    download,
    d3: getD3,
    ...overrides,
  };
  return { ...createFileApi(deps), companion, download };
}

describe('names', () => {
  it('resolve relative to the notebook’s folder, or from the root with a leading /', () => {
    expect(resolveName(WD, 'penguins.csv')).toBe('compo/oa/penguins.csv');
    expect(resolveName(WD, 'figures/fig1.svg')).toBe('compo/oa/figures/fig1.svg');
    expect(resolveName(WD, '../shared/tempo.txt')).toBe('compo/shared/tempo.txt');
    expect(resolveName(WD, '/shared/tempo.txt')).toBe('shared/tempo.txt');
    expect(resolveName({ ...WD, dir: '' }, 'a.csv')).toBe('a.csv');
  });

  it('are encoded per segment in the URL, accents and spaces included', () => {
    expect(fileUrl(WD, 'mélodie d’été.wav')).toBe(
      'http://localhost:4321/__files/compo/oa/m%C3%A9lodie%20d%E2%80%99%C3%A9t%C3%A9.wav'
    );
  });

  it('carry a mime type by extension', () => {
    expect(mimeTypeOf('a.CSV')).toBe('text/csv');
    expect(mimeTypeOf('fig.svg')).toBe('image/svg+xml');
    expect(mimeTypeOf('noext')).toBe('application/octet-stream');
  });
});

describe('FileAttachment with a working directory', () => {
  it('reads text, json and typed csv, the Observable way', async () => {
    const { FileAttachment } = api();
    expect(await FileAttachment('meta.json').json()).toEqual({ piece: 'taaiot' });
    const rows = await FileAttachment('penguins.csv').csv({ typed: true });
    expect(rows[0]).toEqual({ species: 'Adelie', mass: 3750 });
    expect(rows.columns).toEqual(['species', 'mass']);
    expect((await FileAttachment('penguins.csv').csv())[0].mass).toBe('3750');
    expect(await FileAttachment('penguins.csv').csv({ array: true })).toEqual([
      ['species', 'mass'], ['Adelie', '3750'], ['Gentoo', '5000'],
    ]);
    expect(await FileAttachment('../shared/tempo.txt').text()).toBe('90');
  });

  it('says which file is missing and where it looked', async () => {
    const { FileAttachment } = api();
    await expect(FileAttachment('nope.csv').text()).rejects.toThrow(/FileAttachment\("nope\.csv"\).*no file "nope\.csv" in compo\/oa\//);
  });

  it('gives the file’s own URL, for libraries that want one', async () => {
    const { FileAttachment } = api();
    expect(await FileAttachment('penguins.csv').url()).toBe('http://localhost:4321/__files/compo/oa/penguins.csv');
  });
});

describe('FileAttachment without note serve', () => {
  it('reads a dataset dropped into Storage instead', async () => {
    const { FileAttachment } = api({
      store: () => null,
      datasetText: async (name) => (name === 'penguins.csv' ? 'species,mass\nAdelie,3750\n' : undefined),
    });
    expect((await FileAttachment('penguins.csv').csv({ typed: true }))[0].mass).toBe(3750);
  });

  it('explains what to do when the file is in neither place', async () => {
    const { FileAttachment } = api({ store: () => null });
    await expect(FileAttachment('penguins.csv').text()).rejects.toThrow(/not a file served by note serve.*Storage panel/);
  });
});

describe('save', () => {
  it('writes next to the notebook, into subfolders too', async () => {
    const { save, companion } = api();
    expect(await save('out/summary.json', { n: 2 })).toEqual({ path: 'compo/oa/out/summary.json', size: 12 });
    expect(companion.disk.get('compo/oa/out/summary.json')).toBe('{\n  "n": 2\n}');
  });

  it('downloads instead when there is no folder to write to', async () => {
    const { save, download, companion } = api({ store: () => null });
    expect(await save('figures/fig1.svg', '<svg/>')).toEqual({ downloaded: 'figures/fig1.svg', size: 6 });
    expect(download).toHaveBeenCalledWith('fig1.svg', expect.any(Uint8Array), 'image/svg+xml');
    expect(companion.calls).toEqual([]);
  });

  it('passes the companion’s refusal through', async () => {
    const refusing = vi.fn(async () => new Response(JSON.stringify({ error: 'oa/piece.html is a notebook; save() will not overwrite it.' }), { status: 409 }));
    const { save } = api({ store: () => companionStore(WD, refusing as unknown as typeof fetch) });
    await expect(save('piece.html', 'x')).rejects.toThrow(/is a notebook/);
  });
});

describe('encodeForSave', () => {
  const enc = (name: string, value: unknown) => encodeForSave(name, value, getD3);

  it('writes strings, numbers and binary data as they are', async () => {
    expect(decode((await enc('a.txt', 'été')).bytes)).toBe('été');
    expect(decode((await enc('n.txt', 42)).bytes)).toBe('42');
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect([...(await enc('x.bin', bytes.subarray(1, 3))).bytes]).toEqual([2, 3]);
    expect([...(await enc('x.bin', bytes.buffer)).bytes]).toEqual([1, 2, 3, 4]);
    const blob = new Blob(['wav'], { type: 'audio/wav' });
    expect(await enc('a.wav', blob)).toEqual({ bytes: new TextEncoder().encode('wav'), mimeType: 'audio/wav' });
  });

  it('writes records as CSV or TSV when the name asks for it', async () => {
    const rows = [{ species: 'Adelie', mass: 3750 }];
    expect(decode((await enc('p.csv', rows)).bytes)).toBe('species,mass\nAdelie,3750');
    expect(decode((await enc('p.tsv', rows)).bytes)).toBe('species\tmass\nAdelie\t3750');
    expect(decode((await enc('p.json', rows)).bytes)).toBe(JSON.stringify(rows, null, 2));
  });

  it('writes a chart as a standalone SVG file', async () => {
    // Plot returns a <figure> around its <svg> when it has a legend; the file
    // wants the svg, and a standalone file needs the namespace.
    const { document } = parseHTML('<!doctype html><body></body>');
    const figure = document.createElement('figure');
    figure.innerHTML = '<svg width="10" height="10"><rect width="10" height="10"/></svg>';
    const svg = decode((await enc('fig.svg', figure)).bytes);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="10"/);
  });

  it('refuses what it cannot write, saying why', async () => {
    await expect(enc('a.txt', undefined)).rejects.toThrow(/nothing to save/);
    const { document } = parseHTML('<!doctype html><body></body>');
    await expect(enc('a.png', document.createElement('div'))).rejects.toThrow(/\.svg or \.html/);
    const circular: any = {};
    circular.self = circular;
    await expect(enc('a.json', circular)).rejects.toThrow(/cannot be written as JSON/);
  });
});

describe('the virtual folder, when nothing serves the notebook', () => {
  /** A stand-in for the browser's private file system. */
  function fakeOpfs(files: Record<string, string> = {}) {
    const disk = new Map(Object.entries(files));
    return {
      disk,
      backend: {
        async read(dir: string, name: string) {
          const text = disk.get(`${dir}/${name}`);
          return text === undefined ? null : { bytes: new TextEncoder().encode(text).buffer, type: '' };
        },
        async write(dir: string, name: string, bytes: Uint8Array) {
          disk.set(`${dir}/${name}`, decode(bytes));
          return { path: `${dir}/${name}`, size: bytes.length };
        },
      },
    };
  }

  const virtualApi = (files?: Record<string, string>) => {
    const opfs = fakeOpfs(files);
    const download = vi.fn();
    const wd = { kind: 'virtual', dir: 'notebooks/taaiot' } as const;
    return {
      ...createFileApi({
        store: () => virtualStore(wd, opfs.backend),
        datasetText: async () => undefined,
        download,
        d3: getD3,
      }),
      opfs,
      download,
    };
  };

  it('reads and writes the notebook’s own files', async () => {
    const { FileAttachment, save, opfs, download } = virtualApi({
      'notebooks/taaiot/penguins.csv': 'species,mass\nAdelie,3750\n',
    });
    expect((await FileAttachment('penguins.csv').csv({ typed: true }))[0].mass).toBe(3750);
    expect(await save('out/summary.json', { n: 1 })).toEqual({ path: 'notebooks/taaiot/out/summary.json', size: 12 });
    // A save is a file the notebook can read back, not a download it cannot.
    expect(download).not.toHaveBeenCalled();
    expect(await FileAttachment('out/summary.json').json()).toEqual({ n: 1 });
    expect(opfs.disk.size).toBe(2);
  });

  it('says where it looked when the file is not there', async () => {
    const { FileAttachment } = virtualApi();
    await expect(FileAttachment('nope.csv').text()).rejects.toThrow(/no file "nope\.csv" in this notebook’s files/);
  });
});
