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
 * Without the companion there is no folder to read or write, so the same calls
 * degrade rather than break: reads come from the datasets dropped into the
 * Storage panel, and a save becomes a download. A notebook written against the
 * working directory still runs online.
 *
 * `FileAttachment` follows Observable's API, so notebooks move between the two
 * without rewriting their data loading.
 *
 * The network, the dataset store and the download are injected, so the rules
 * here are tested without a browser.
 */

export interface WorkingDirectory {
  /** Where the companion is, e.g. `http://localhost:4321`. */
  base: string;
  /** The notebook's folder, relative to the served root; `''` at the root. */
  dir: string;
}

export interface FileApiDeps {
  /** The working directory for the cell running now, or null when there is none. */
  workingDirectory: () => WorkingDirectory | null;
  fetch: typeof fetch;
  /** A dataset's text from the Storage panel, or undefined. */
  datasetText: (name: string) => Promise<string | undefined>;
  /** Hand bytes to the reader as a download (no working directory). */
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

export function fileUrl(wd: WorkingDirectory, name: string): string {
  const path = resolveName(wd, name).split('/').map(encodeURIComponent).join('/');
  return `${wd.base.replace(/\/+$/, '')}/__files/${path}`;
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

  /** The file's bytes, from the working directory or the Storage panel. */
  async function read(name: string): Promise<Response> {
    const wd = deps.workingDirectory();
    if (!wd) {
      const text = await deps.datasetText(name);
      if (text === undefined) throw noDirectory(name);
      return new Response(text, { headers: { 'content-type': mimeTypeOf(name) } });
    }
    let response: Response;
    try {
      response = await deps.fetch(fileUrl(wd, name), { cache: 'no-store' });
    } catch {
      throw new Error(`FileAttachment("${name}"): note serve is not reachable.`);
    }
    if (!response.ok) {
      const where = wd.dir ? `${wd.dir}/` : 'the served directory';
      const fallback = response.status === 404 ? `no file "${name}" in ${where}` : `read failed (${response.status})`;
      throw new Error(`FileAttachment("${name}"): ${await responseError(response, fallback)}`);
    }
    return response;
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
        const wd = deps.workingDirectory();
        if (wd) return fileUrl(wd, name);
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
    const wd = deps.workingDirectory();

    if (!wd) {
      // No folder to write to: hand it over as a download, the one way a
      // browser page can put a file on the reader's disk.
      deps.download(name.slice(name.lastIndexOf('/') + 1), bytes, mimeType);
      return { downloaded: name, size: bytes.length };
    }

    let response: Response;
    try {
      response = await deps.fetch(fileUrl(wd, name), {
        method: 'PUT',
        body: bytes.slice(),
        headers: { 'content-type': mimeType },
      });
    } catch {
      throw new Error(`save("${name}"): note serve is not reachable.`);
    }
    if (!response.ok) {
      throw new Error(`save("${name}"): ${await responseError(response, `write failed (${response.status})`)}`);
    }
    return (await response.json()) as { path: string; size: number };
  }

  return { FileAttachment, save };
}
