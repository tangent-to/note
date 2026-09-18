/**
 * Backing up what exists only in this browser, and bringing it back.
 *
 * Without the companion, notebooks and datasets live in the browser's storage,
 * which the browser may clear under pressure and "clear site data" clears on
 * purpose. A backup is the reader's only copy elsewhere, so two properties
 * matter more than anything else here:
 *
 * - **It is a real folder.** Unzipped, the archive is `.js` notebooks and a
 *   `data/` directory that the companion (and the desktop app) can open as they
 *   are. A backup is also how work moves from the web to a local folder.
 * - **It restores exactly.** The `.js` files are for people and tools, but they
 *   do not carry outputs, origins or timestamps; `.tangent/backup.json` does,
 *   and a restore prefers it. An archive without it — one assembled by hand —
 *   still restores, from the files alone.
 *
 * Restoring never loses newer work: a notebook that is newer here than in the
 * backup is kept, and said so.
 *
 * The pure parts are in this file and tested; reading and writing the library
 * happens in stores/backup.ts.
 */
import type { Notebook } from '../types/notebook';
import { buildRecord, serializableNotebook, type LibraryEntry, type LibraryRecord } from './notebookLibrary';
import type { DatasetMeta, DatasetRecord } from './dataStore';
import { serializeNotebook } from './notebookFormat';
import { parseNotebookFile } from './fileOperations';
import type { ZipEntry } from './zip';

export const BACKUP_FORMAT = 'tangent-backup';
export const BACKUP_VERSION = 1;
export const MANIFEST = '.tangent/backup.json';

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: string;
  notebooks: Array<{ file: string; record: LibraryRecord }>;
  datasets: Array<{ file: string; meta: DatasetMeta }>;
  /** Files a notebook's cells wrote, kept in the browser for want of a folder. */
  files?: Array<{ notebook: string; file: string; name: string }>;
  /** Libraries as fetched, so the archive restores an environment that runs offline. */
  cache?: Array<{ url: string; file: string; type: string }>;
}

/** A file a notebook wrote into its own folder in the browser. */
export interface NotebookFile {
  name: string;
  bytes: Uint8Array;
}

/** One response kept from the network, as it was received. */
export interface CachedResponse {
  url: string;
  bytes: Uint8Array;
  type: string;
}

export interface BackupExtras {
  /** notebook id → the files that notebook wrote. */
  files?: Map<string, NotebookFile[]>;
  /** The module cache, for a backup that still runs with no network. */
  cache?: CachedResponse[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `tangent-backup-2026-09-17`, the folder the archive unpacks into. */
export function backupFolderName(now: Date): string {
  return `tangent-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function slug(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'notebook'
  );
}

/** A file name not yet taken in `used`: `name.js`, then `name-2.js`… */
function unique(base: string, ext: string, used: Set<string>): string {
  let candidate = `${base}${ext}`;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base}-${n}${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/** The files of a backup, ready to zip. Pure, so its shape is tested. */
export function buildBackupEntries(
  records: LibraryRecord[],
  datasets: DatasetRecord[],
  now: Date,
  extras: BackupExtras = {}
): ZipEntry[] {
  const root = backupFolderName(now);
  const entries: ZipEntry[] = [];
  const used = new Set<string>();
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: now.toISOString(),
    notebooks: [],
    datasets: [],
  };

  for (const record of [...records].sort((a, b) => a.name.localeCompare(b.name))) {
    const own = extras.files?.get(record.id) ?? [];
    // A notebook with files of its own gets a folder, so unzipping gives the
    // working directory back rather than everyone's files in one heap.
    const base = slug(record.name);
    const folder = own.length > 0 ? unique(base, '', used) : null;
    const file = folder ? `${folder}/${base}.js` : unique(base, '.js', used);
    entries.push({
      path: `${root}/${file}`,
      data: encoder.encode(serializeNotebook(record.notebook)),
      modified: new Date(record.updatedAt),
    });
    manifest.notebooks.push({ file, record: { ...record, notebook: serializableNotebook(record.notebook) } });
    for (const own_file of own) {
      const path = `${folder}/${own_file.name}`;
      entries.push({ path: `${root}/${path}`, data: own_file.bytes, modified: now });
      (manifest.files ??= []).push({ notebook: record.id, file: path, name: own_file.name });
    }
  }

  const usedData = new Set<string>();
  for (const dataset of [...datasets].sort((a, b) => a.name.localeCompare(b.name))) {
    const safe = dataset.name.replace(/[/\\]/g, '_');
    const dot = safe.lastIndexOf('.');
    const file = `data/${unique(dot > 0 ? safe.slice(0, dot) : safe, dot > 0 ? safe.slice(dot) : '', usedData)}`;
    const { text, ...meta } = dataset;
    entries.push({ path: `${root}/${file}`, data: encoder.encode(text), modified: new Date(dataset.addedAt) });
    manifest.datasets.push({ file, meta });
  }

  // The libraries themselves, under .tangent/ where they are out of the way:
  // this is what makes a restored backup run with no network.
  (extras.cache ?? []).forEach((response, index) => {
    const file = `.tangent/cache/${String(index).padStart(4, '0')}`;
    entries.push({ path: `${root}/${file}`, data: response.bytes, modified: now });
    (manifest.cache ??= []).push({ url: response.url, file, type: response.type });
  });

  entries.push({
    path: `${root}/${MANIFEST}`,
    data: encoder.encode(JSON.stringify(manifest, null, 2)),
    modified: now,
  });
  return entries;
}

export interface ParsedBackup {
  records: LibraryRecord[];
  datasets: DatasetRecord[];
  /** notebook id → files to put back in its folder. */
  files: Map<string, NotebookFile[]>;
  /** Libraries to put back in the offline cache. */
  cache: CachedResponse[];
  /** Things in the archive that were not restored, and why. */
  warnings: string[];
  /** True when `.tangent/backup.json` was found and used. */
  exact: boolean;
}

const TEXT_DATA = /\.(csv|tsv|json|ndjson|txt|md|geojson)$/i;

function inferType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.tsv')) return 'text/tab-separated-values';
  if (lower.endsWith('.json') || lower.endsWith('.ndjson') || lower.endsWith('.geojson')) return 'application/json';
  return 'text/plain';
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Read an unzipped archive back into library records and datasets. */
export function parseBackupEntries(entries: ZipEntry[], now: number = Date.now()): ParsedBackup {
  const warnings: string[] = [];
  const manifestEntry = entries.find((e) => e.path === MANIFEST || e.path.endsWith(`/${MANIFEST}`));

  if (manifestEntry) {
    const base = manifestEntry.path.slice(0, manifestEntry.path.length - MANIFEST.length);
    let manifest: BackupManifest;
    try {
      manifest = JSON.parse(decoder.decode(manifestEntry.data));
    } catch {
      throw new Error('The backup’s index (.tangent/backup.json) is damaged.');
    }
    if (manifest.format !== BACKUP_FORMAT) {
      throw new Error('This archive is not a tangent/note backup.');
    }
    if (manifest.version > BACKUP_VERSION) {
      throw new Error('This backup was made by a newer version of tangent/note. Update the app to restore it.');
    }

    const byPath = new Map(entries.map((e) => [e.path, e]));
    const datasets: DatasetRecord[] = [];
    for (const { file, meta } of manifest.datasets ?? []) {
      const entry = byPath.get(`${base}${file}`);
      if (!entry) {
        warnings.push(`${meta.name}: missing from the archive, not restored.`);
        continue;
      }
      datasets.push({ ...meta, text: decoder.decode(entry.data) });
    }
    const files = new Map<string, NotebookFile[]>();
    for (const entry of manifest.files ?? []) {
      const found = byPath.get(`${base}${entry.file}`);
      if (!found) {
        warnings.push(`${entry.name}: missing from the archive, not restored.`);
        continue;
      }
      const list = files.get(entry.notebook) ?? [];
      list.push({ name: entry.name, bytes: found.data });
      files.set(entry.notebook, list);
    }

    const cache: CachedResponse[] = [];
    for (const entry of manifest.cache ?? []) {
      const found = byPath.get(`${base}${entry.file}`);
      if (found) cache.push({ url: entry.url, bytes: found.data, type: entry.type });
    }

    return {
      records: (manifest.notebooks ?? []).map((n) => n.record),
      datasets,
      files,
      cache,
      warnings,
      exact: true,
    };
  }

  // No index: an archive assembled by hand, or a folder zipped by an ordinary
  // tool. Notebooks and text data still come back; outputs and origins do not
  // exist in the files, so there is nothing more to recover.
  const records: LibraryRecord[] = [];
  const datasets: DatasetRecord[] = [];
  const seenIds = new Map<string, string>();
  for (const entry of entries) {
    const name = basename(entry.path);
    if (/\.(js|html)$/i.test(name)) {
      let notebook: Notebook;
      try {
        notebook = parseNotebookFile(decoder.decode(entry.data), name).notebook;
      } catch (error: any) {
        warnings.push(`${entry.path}: not a notebook (${error?.message ?? 'unreadable'}).`);
        continue;
      }
      if (!notebook?.cells?.length) {
        warnings.push(`${entry.path}: no cells found, skipped.`);
        continue;
      }
      if (seenIds.has(notebook.id)) {
        warnings.push(`${entry.path}: same notebook as ${seenIds.get(notebook.id)}, skipped.`);
        continue;
      }
      seenIds.set(notebook.id, entry.path);
      records.push(buildRecord(notebook, { kind: 'import', filename: name }, now));
    } else if (TEXT_DATA.test(name)) {
      datasets.push({
        name,
        type: inferType(name),
        size: entry.data.length,
        addedAt: now,
        text: decoder.decode(entry.data),
      });
    } else {
      warnings.push(`${entry.path}: not a notebook or text data, skipped.`);
    }
  }
  return { records, datasets, files: new Map(), cache: [], warnings, exact: false };
}

export interface RestorePlan {
  /** Not here yet, or older here than in the backup: written. */
  put: LibraryRecord[];
  /** Newer here than in the backup: left as it is. */
  keptNewer: LibraryRecord[];
  /** Identical in time to the backup: nothing to do. */
  unchanged: LibraryRecord[];
  datasetsToAdd: DatasetRecord[];
  /** Same name here with the same content. */
  datasetsUnchanged: DatasetRecord[];
  /** Same name here with different content: the one here is kept. */
  datasetsConflicting: DatasetRecord[];
}

/**
 * Decide what a restore writes. Nothing newer here is ever replaced by an older
 * copy: a backup is a floor to fall back to, not a snapshot to roll back to.
 */
export function planRestore(
  parsed: ParsedBackup,
  existing: Map<string, { updatedAt: number }>,
  existingDatasets: Map<string, string>
): RestorePlan {
  const plan: RestorePlan = {
    put: [],
    keptNewer: [],
    unchanged: [],
    datasetsToAdd: [],
    datasetsUnchanged: [],
    datasetsConflicting: [],
  };
  for (const record of parsed.records) {
    const here = existing.get(record.id);
    if (!here || here.updatedAt < record.updatedAt) plan.put.push(record);
    else if (here.updatedAt > record.updatedAt) plan.keptNewer.push(record);
    else plan.unchanged.push(record);
  }
  for (const dataset of parsed.datasets) {
    const here = existingDatasets.get(dataset.name);
    if (here === undefined) plan.datasetsToAdd.push(dataset);
    else if (here === dataset.text) plan.datasetsUnchanged.push(dataset);
    else plan.datasetsConflicting.push(dataset);
  }
  return plan;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One line per outcome, for the report shown after a restore. */
export function summarizeRestore(plan: RestorePlan, parsed: ParsedBackup): string[] {
  const lines: string[] = [];
  if (plan.put.length) lines.push(`Restored ${plural(plan.put.length, 'notebook')}: ${plan.put.map((r) => r.name).join(', ')}.`);
  if (plan.keptNewer.length) {
    lines.push(
      `Kept ${plural(plan.keptNewer.length, 'notebook')} that ${plan.keptNewer.length === 1 ? 'is' : 'are'} newer here than in the backup: ${plan.keptNewer.map((r) => r.name).join(', ')}.`
    );
  }
  if (plan.unchanged.length) lines.push(`${plural(plan.unchanged.length, 'notebook')} already up to date.`);
  if (plan.datasetsToAdd.length) lines.push(`Restored ${plural(plan.datasetsToAdd.length, 'dataset')}: ${plan.datasetsToAdd.map((d) => d.name).join(', ')}.`);
  if (plan.datasetsUnchanged.length) lines.push(`${plural(plan.datasetsUnchanged.length, 'dataset')} already here.`);
  if (plan.datasetsConflicting.length) {
    lines.push(
      `Kept the version here of ${plural(plan.datasetsConflicting.length, 'dataset')} that differ${plan.datasetsConflicting.length === 1 ? 's' : ''} from the backup: ${plan.datasetsConflicting.map((d) => d.name).join(', ')}. Delete it first to restore the backup's.`
    );
  }
  if (parsed.files.size > 0) {
    const count = [...parsed.files.values()].reduce((n, list) => n + list.length, 0);
    lines.push(`Restored ${plural(count, 'file')} that ${count === 1 ? 'a notebook' : 'notebooks'} had written.`);
  }
  if (parsed.cache.length > 0) {
    lines.push(`Restored ${plural(parsed.cache.length, 'library file')}, so these notebooks run without a network.`);
  }
  if (!parsed.exact && (plan.put.length || plan.datasetsToAdd.length)) {
    lines.push('This archive has no tangent/note index, so outputs and where notebooks came from were not in it.');
  }
  lines.push(...parsed.warnings);
  if (lines.length === 0) lines.push('The backup was empty.');
  return lines;
}

export const DAY = 24 * 60 * 60 * 1000;

export interface BackupStatus {
  /** Notebooks and datasets that exist only in this browser and changed since the last backup. */
  pending: number;
  /** Whether to ask for a backup now. */
  due: boolean;
}

/**
 * Should the panel ask for a backup?
 *
 * Only for work that exists nowhere else: a notebook linked to a file on disk is
 * already safe, and the bundled example can be fetched again unless it was
 * edited. And not the minute something changes — work gets a day before the
 * first reminder, and a week between later ones — so the reminder stays worth
 * reading.
 */
export function backupStatus(
  entries: LibraryEntry[],
  datasets: DatasetMeta[],
  lastBackup: number | null,
  now: number,
  snoozedUntil: number | null = null
): BackupStatus {
  const since = lastBackup ?? 0;
  const changed: number[] = [];
  for (const entry of entries) {
    if (entry.origin.kind === 'disk') continue;
    if (entry.origin.kind === 'sample' && entry.updatedAt <= entry.createdAt) continue;
    if (entry.updatedAt > since) changed.push(entry.updatedAt);
  }
  for (const dataset of datasets) {
    if (dataset.addedAt > since) changed.push(dataset.addedAt);
  }

  const pending = changed.length;
  if (pending === 0 || (snoozedUntil !== null && now < snoozedUntil)) return { pending, due: false };
  const due = lastBackup === null
    ? now - Math.min(...changed) >= DAY
    : now - lastBackup >= 7 * DAY;
  return { pending, due };
}
