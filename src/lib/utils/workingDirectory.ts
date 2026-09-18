/**
 * A notebook's working directory, as cells see it: `FileAttachment` to read,
 * `save` to write.
 *
 * With `note serve`, the working directory is the real folder the notebook file
 * sits in, as in Jupyter: `FileAttachment("penguins.csv")` reads the file next
 * to the notebook, and `save("summary.json", data)` writes one there. Names can
 * reach into subfolders (`save("figures/fig1.svg", chart)` creates `figures/`),
 * and a leading `/` means the served root. Nothing outside the served directory
 * can be read or written; the companion refuses it.
 *
 * Without the companion the notebook still has a folder: its own, in the
 * browser's private file system (opfs.ts). The same calls work there, so a
 * notebook written against the working directory runs online too — what changes
 * is that the folder is storage rather than a place in a file manager, which is
 * why the Storage panel lists those files and can download them. Reads also fall
 * back to the datasets dropped into that panel. Where even that is unavailable,
 * a save becomes a download rather than an error.
 *
 * `FileAttachment` follows Observable's API, so notebooks move between the two
 * without rewriting their data loading.
 *
 * The network, the dataset store and the download are injected, so the rules
 * here are tested without a browser.
 */

/**
 * Where a notebook's files live.
 *
 * `companion` is a real folder on disk, served by note serve. `virtual` is the
 * notebook's own folder in the browser's private file system, which is what
 * there is when nothing serves the notebook — storage rather than a folder you
 * can open in a file manager, but a real working directory as far as a cell is
 * concerned.
 */
export type WorkingDirectory =
  | { kind: 'companion'; base: string; dir: string }
  | { kind: 'virtual'; dir: string };

/**
 * What a working directory can do. Two implementations, one contract, so
 * FileAttachment and save do not know which kind they are talking to.
 */
export interface FileStore {
  /** The file's bytes, or null when it is not there. */
  read(name: string): Promise<Response | null>;
  write(name: string, bytes: Uint8Array, mimeType: string): Promise<{ path: string; size: number }>;
  /** Where a missing file was looked for, for the error message. */
  describe(): string;
  /** A URL a library can fetch itself, where the store has one. */
  url?(name: string): string;
}

export interface FileApiDeps {
  /** The store for the cell running now, or null when it has no folder at all. */
  store: () => FileStore | null;
  /** A dataset's text from the Storage panel, or undefined. */
  datasetText: (name: string) => Promise<string | undefined>;
  /** Hand bytes to the reader as a download (no folder to write to). */
  download: (name: string, bytes: Uint8Array, mimeType: string) => void;
  /** d3, for csv/tsv parsing and formatting. */
  d3: () => Promise<any>;
}

const MIME: Record<string, string> = {
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  ndjson: 'application/x-ndjson',
  geojson: 'application/geo+json',
  html: 'text/html',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  mid: 'audio/midi',
  midi: 'audio/midi',
  pdf: 'application/pdf',
  js: 'text/javascript',
};

export function mimeTypeOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot >= 0 && MIME[name.slice(dot + 1).toLowerCase()]) || 'application/octet-stream';
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * The path a name refers to, relative to the served root.
 *
 * Relative names are joined to the notebook's folder; a leading `/` starts from
 * the root. `..` is resolved here for a readable path, but the companion is
 * what enforces the boundary.
 */
export function resolveName(wd: WorkingDirectory, name: string): string {
  const joined = name.startsWith('/') ? name : `${wd.dir}/${name}`;
  const out: string[] = [];
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

export function fileUrl(wd: Extract<WorkingDirectory, { kind: 'companion' }>, name: string): string {
  const path = resolveName(wd, name).split('/').map(encodeURIComponent).join('/');
  return `${wd.base.replace(/\/+$/, '')}/__files/${path}`;
}

/** A folder on disk, through the companion. */
export function companionStore(
  wd: Extract<WorkingDirectory, { kind: 'companion' }>,
  doFetch: typeof fetch
): FileStore {
  return {
    describe: () => (wd.dir ? `${wd.dir}/` : 'the served directory'),
    url: (name) => fileUrl(wd, name),
    async read(name) {
      let response: Response;
      try {
        response = await doFetch(fileUrl(wd, name), { cache: 'no-store' });
      } catch {
        throw new Error('note serve is not reachable.');
      }
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(await responseError(response, `read failed (${response.status})`));
      return response;
    },
    async write(name, bytes, mimeType) {
      let response: Response;
      try {
        response = await doFetch(fileUrl(wd, name), {
          method: 'PUT',
          body: bytes.slice(),
          headers: { 'content-type': mimeType },
        });
      } catch {
        throw new Error('note serve is not reachable.');
      }
      if (!response.ok) throw new Error(await responseError(response, `write failed (${response.status})`));
      return (await response.json()) as { path: string; size: number };
    },
  };
}

export interface VirtualBackend {
  read(dir: string, name: string): Promise<{ bytes: ArrayBuffer; type: string } | null>;
  write(dir: string, name: string, bytes: Uint8Array): Promise<{ path: string; size: number }>;
}

/** The notebook's own folder in the browser's private file system. */
export function virtualStore(
  wd: Extract<WorkingDirectory, { kind: 'virtual' }>,
  backend: VirtualBackend
): FileStore {
  return {
    describe: () => 'this notebook’s files',
    async read(name) {
      const file = await backend.read(wd.dir, name);
      if (!file) return null;
      return new Response(file.bytes, { headers: { 'content-type': file.type || mimeTypeOf(name) } });
    },
    write: (name, bytes) => backend.write(wd.dir, name, bytes),
  };
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    if (body?.error) return body.error;
  } catch {
    // Not JSON; use the fallback.
  }
  return fallback;
}

/** Bytes for `save`, and the type they are. */
export async function encodeForSave(
  name: string,
  data: unknown,
  d3: () => Promise<any>
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const ext = extensionOf(name);
  const mimeType = mimeTypeOf(name);
  const text = (s: string) => ({ bytes: new TextEncoder().encode(s), mimeType });

  if (data === null || data === undefined) {
    throw new Error(`save("${name}"): there is nothing to save (the value is ${data}).`);
  }
  if (typeof data === 'string') return text(data);
  if (typeof data === 'number' || typeof data === 'boolean' || typeof data === 'bigint') return text(String(data));
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return { bytes: new Uint8Array(await data.arrayBuffer()), mimeType: data.type || mimeType };
  }
  if (data instanceof ArrayBuffer) return { bytes: new Uint8Array(data.slice(0)), mimeType };
  if (ArrayBuffer.isView(data)) {
    return { bytes: new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)), mimeType };
  }

  const node = data as any;
  if (typeof node.toBlob === 'function' && typeof node.getContext === 'function') {
    // A canvas: the picture, in the format the name asks for.
    const blob: Blob = await new Promise((resolve, reject) =>
      node.toBlob((b: Blob | null) => (b ? resolve(b) : reject(new Error(`save("${name}"): the canvas could not be encoded.`))), mimeType)
    );
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType };
  }
  if (typeof node.outerHTML === 'string') {
    if (ext === 'svg') {
      // A chart is often a <figure> around its <svg>; the file wants the svg.
      const svg = node.tagName?.toLowerCase() === 'svg' ? node : node.querySelector?.('svg');
      if (!svg) throw new Error(`save("${name}"): this element has no <svg> to save.`);
      let markup: string = svg.outerHTML;
      if (!/\sxmlns=/.test(markup.slice(0, markup.indexOf('>')))) {
        markup = markup.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
      }
      return text(markup);
    }
    if (ext === 'html' || ext === 'htm') return text(node.outerHTML);
    throw new Error(`save("${name}"): an element can be saved as .svg or .html.`);
  }

  if (Array.isArray(data) && (ext === 'csv' || ext === 'tsv')) {
    const lib = await d3();
    if (!lib) throw new Error(`save("${name}"): d3 is needed to write ${ext.toUpperCase()} and could not be loaded.`);
    return text(ext === 'csv' ? lib.csvFormat(data) : lib.tsvFormat(data));
  }

  try {
    return text(JSON.stringify(data, null, 2));
  } catch (error: any) {
    throw new Error(`save("${name}"): this value cannot be written as JSON (${error?.message ?? error}).`);
  }
}

export interface FileApi {
  FileAttachment: (name: string) => FileAttachmentHandle;
  save: (name: string, data: unknown) => Promise<{ path: string; size: number } | { downloaded: string; size: number }>;
}

export interface FileAttachmentHandle {
  name: string;
  mimeType: string;
  url(): Promise<string>;
  blob(): Promise<Blob>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json(): Promise<any>;
  csv(options?: { typed?: boolean; array?: boolean }): Promise<any>;
  tsv(options?: { typed?: boolean; array?: boolean }): Promise<any>;
  image(): Promise<HTMLImageElement>;
}

export function createFileApi(deps: FileApiDeps): FileApi {
  const noDirectory = (name: string) =>
    new Error(
      `FileAttachment("${name}"): this notebook is not a file served by note serve, so it has no ` +
        `working directory. Drop "${name}" into the Storage panel to read it here.`
    );

  /**
   * The file's bytes: the working directory first, then the datasets dropped
   * into the Storage panel — a notebook written before it had a folder still
   * finds its data.
   */
  async function read(name: string): Promise<Response> {
    const store = deps.store();
    if (store) {
      try {
        const response = await store.read(name);
        if (response) return response;
      } catch (error: any) {
        throw new Error(`FileAttachment("${name}"): ${error?.message ?? error}`);
      }
    }
    const text = await deps.datasetText(name);
    if (text !== undefined) return new Response(text, { headers: { 'content-type': mimeTypeOf(name) } });
    if (store) throw new Error(`FileAttachment("${name}"): no file "${name}" in ${store.describe()}.`);
    throw noDirectory(name);
  }

  function FileAttachment(name: string): FileAttachmentHandle {
    if (typeof name !== 'string' || !name) throw new Error('FileAttachment needs a file name.');
    const parse = async (kind: 'csv' | 'tsv', options: { typed?: boolean; array?: boolean } = {}) => {
      const text = await (await read(name)).text();
      const lib = await deps.d3();
      if (!lib) throw new Error(`FileAttachment("${name}").${kind}(): d3 could not be loaded.`);
      const rows = kind === 'csv' ? 'csvParseRows' : 'tsvParseRows';
      const objects = kind === 'csv' ? 'csvParse' : 'tsvParse';
      if (options.array) return lib[rows](text, options.typed ? lib.autoType : undefined);
      return lib[objects](text, options.typed ? lib.autoType : undefined);
    };

    return {
      name,
      mimeType: mimeTypeOf(name),
      async url() {
        const direct = deps.store()?.url?.(name);
        if (direct) return direct;
        return URL.createObjectURL(await (await read(name)).blob());
      },
      async blob() {
        return (await read(name)).blob();
      },
      async arrayBuffer() {
        return (await read(name)).arrayBuffer();
      },
      async text() {
        return (await read(name)).text();
      },
      async json() {
        return JSON.parse(await (await read(name)).text());
      },
      csv: (options) => parse('csv', options),
      tsv: (options) => parse('tsv', options),
      async image() {
        if (typeof Image === 'undefined') {
          throw new Error(`FileAttachment("${name}").image() needs the main-thread kernel; in the worker, use .url() or .blob().`);
        }
        const src = await this.url();
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error(`FileAttachment("${name}").image(): the image could not be loaded.`));
          img.src = src;
        });
      },
    };
  }

  async function save(name: string, data: unknown) {
    if (typeof name !== 'string' || !name) throw new Error('save needs a file name, e.g. save("summary.json", value).');
    const { bytes, mimeType } = await encodeForSave(name, data, deps.d3);
    const store = deps.store();

    if (!store) {
      // Nowhere to write: hand it over as a download, the one way a browser
      // page with no file system can put a file on the reader's disk.
      deps.download(name.slice(name.lastIndexOf('/') + 1), bytes, mimeType);
      return { downloaded: name, size: bytes.length };
    }
    try {
      return await store.write(name, bytes, mimeType);
    } catch (error: any) {
      throw new Error(`save("${name}"): ${error?.message ?? error}`);
    }
  }

  return { FileAttachment, save };
}
