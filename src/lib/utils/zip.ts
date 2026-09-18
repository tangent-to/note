/**
 * Just enough ZIP to write a backup and read one back.
 *
 * No dependency: the compression itself is the platform's
 * (`CompressionStream('deflate-raw')`, in every current browser and in Node),
 * so what is left is the container — local headers, a central directory, CRC-32
 * — which is small, fixed and specified (PKWARE APPNOTE 6.3).
 *
 * Deliberately narrow. It writes what any unzip tool opens (UTF-8 names, stored
 * or deflated entries), and it reads the same, which covers a backup written
 * here and one re-zipped by hand with an ordinary tool. It refuses what it does
 * not implement — encryption, ZIP64 — with a message, rather than returning
 * garbage from an archive it only half understood.
 */

export interface ZipEntry {
  /** Forward slashes, relative. Directories are implied by the paths. */
  path: string;
  data: Uint8Array;
  modified?: Date;
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const UTF8_NAMES = 0x0800;
const STORED = 0;
const DEFLATED = 8;

let crcTable: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function transform(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  // Blob wants an ArrayBuffer-backed view; a subarray of a shared buffer is not one.
  const buffer = await new Response(new Blob([data.slice()]).stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(buffer);
}

/** MS-DOS date and time, which is what the format stores. Local time, 2s resolution. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function safePath(path: string): string {
  const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.split('/').some((part) => part === '..')) {
    throw new Error(`Refusing a path that climbs out of the archive: ${path}`);
  }
  return clean;
}

/** Build an archive. Entries are deflated when that makes them smaller. */
export async function createZip(entries: ZipEntry[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(safePath(entry.path));
    const crc = crc32(entry.data);
    const deflated = entry.data.length > 0 ? await transform(entry.data, new CompressionStream('deflate-raw')) : entry.data;
    const useDeflate = deflated.length < entry.data.length;
    const body = useDeflate ? deflated : entry.data;
    const method = useDeflate ? DEFLATED : STORED;
    const { time, date } = dosDateTime(entry.modified ?? new Date());

    if (body.length > 0xfffffffe || entry.data.length > 0xfffffffe || offset > 0xfffffffe) {
      throw new Error('This backup is too large for the archive format used (over 4 GB).');
    }

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, LOCAL, true);
    local.setUint16(4, 20, true); // version needed: 2.0
    local.setUint16(6, UTF8_NAMES, true);
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, entry.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);

    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, CENTRAL, true);
    record.setUint16(4, 20, true); // version made by
    record.setUint16(6, 20, true); // version needed
    record.setUint16(8, UTF8_NAMES, true);
    record.setUint16(10, method, true);
    record.setUint16(12, time, true);
    record.setUint16(14, date, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, body.length, true);
    record.setUint32(24, entry.data.length, true);
    record.setUint16(28, name.length, true);
    record.setUint16(30, 0, true); // extra
    record.setUint16(32, 0, true); // comment
    record.setUint16(34, 0, true); // disk
    record.setUint16(36, 0, true); // internal attributes
    record.setUint32(38, 0, true); // external attributes
    record.setUint32(42, offset, true);

    const localBytes = new Uint8Array(local.buffer);
    chunks.push(localBytes, name, body);
    central.push(new Uint8Array(record.buffer), name);
    offset += localBytes.length + name.length + body.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, END, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of all) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Read every file out of an archive. Directory entries are skipped. */
export async function readZip(bytes: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  // The end record sits in the last 22 bytes plus an optional comment.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === END) {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error('This file is not a ZIP archive.');

  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count === 0xffff || at === 0xffffffff) {
    throw new Error('This archive uses ZIP64, which is not supported.');
  }

  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== CENTRAL) throw new Error('The archive’s file list is damaged.');
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const path = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x1) throw new Error(`“${path}” is encrypted, which is not supported.`);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('This archive uses ZIP64, which is not supported.');
    }
    if (path.endsWith('/')) continue;

    if (view.getUint32(localOffset, true) !== LOCAL) throw new Error(`The entry for “${path}” is damaged.`);
    const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const body = bytes.subarray(start, start + compressedSize);

    let data: Uint8Array;
    if (method === STORED) data = body.slice();
    else if (method === DEFLATED) data = await transform(body, new DecompressionStream('deflate-raw'));
    else throw new Error(`“${path}” uses a compression method that is not supported (${method}).`);

    if (data.length !== size || crc32(data) !== crc) {
      throw new Error(`“${path}” does not match its checksum; the archive is damaged.`);
    }
    entries.push({ path: safePath(path), data });
  }
  return entries;
}
