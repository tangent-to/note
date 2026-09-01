/**
 * The local notebook library.
 *
 * Before this, a notebook's only durable home was a file: an exported `.js`, a
 * file owned by the `note serve` companion, or a URL it was imported from.
 * localStorage held exactly one autosave slot, overwritten on every keystroke
 * of whichever notebook was open, so there was no way to keep a second
 * notebook, and no way to list or reopen anything.
 *
 * The library is that missing home: every notebook you open or create gets an
 * entry in IndexedDB, keyed by its id. Closing a notebook (or opening another)
 * loses nothing — the entry stays until you delete it deliberately.
 *
 * Two ideas that used to be one, and must not be confused again:
 *
 *   - **Saved to the library** — automatic, debounced, silent, always. Nothing
 *     the user has to think about, and nothing that can prompt them.
 *   - **Synced to its origin** — the file on disk, or an exported `.js`. That
 *     is what Ctrl+S does and what `notebookDirty` tracks.
 *
 * Ids round-trip through the `.js` file (`// id:` in the frontmatter, see
 * fileOperations), so re-importing a file you already have reopens the same
 * entry instead of forking a duplicate.
 */
import { writable } from 'svelte/store';
import type { Notebook } from '../types/notebook';
import { NOTEBOOKS, idbRequest } from './idb';

/** Where a notebook came from, and where Ctrl+S should put it back. */
export type NotebookOrigin =
  | { kind: 'local' }
  | { kind: 'sample' }
  /** Owned by a `note serve` companion; `path` is the file it writes. */
  | { kind: 'disk'; path: string }
  | { kind: 'url'; href: string }
  | { kind: 'import'; filename: string };

/** A library row: everything the Storage panel needs, without the payload. */
export interface LibraryEntry {
  /** Library key — `libraryId(notebook.id, origin)`, not `notebook.id`. */
  id: string;
  /** The notebook's own id, as it round-trips through the `.js` file. */
  notebookId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  origin: NotebookOrigin;
  cellCount: number;
  /** Approximate stored size in bytes, for the panel's totals. */
  size: number;
}

export interface LibraryRecord extends LibraryEntry {
  notebook: Notebook;
}

/** Rows for the Storage panel, most recently opened first. */
export const libraryEntries = writable<LibraryEntry[]>([]);

/**
 * False when IndexedDB refused to open (private browsing, a blocked upgrade
 * from another tab, a full disk). The library still works for this session but
 * forgets everything on reload — so the UI has to say so, and the guards that
 * the library made unnecessary have to come back.
 */
export const libraryPersistent = writable(true);

/** Timestamp of the last successful library write, for the "saved" indicator. */
export const librarySavedAt = writable<number | null>(null);

// The single autosave slot the library replaces. Still read on first run to
// migrate it, and still written as a lifeboat when IndexedDB is unavailable.
const LEGACY_KEY = 'tangent-notebook-autosave';
const LEGACY_META_KEY = 'tangent-notebook-meta';

// Session-only fallback. Populated instead of IndexedDB when it is unavailable,
// so a private-mode session still behaves like a library until it is closed.
const memory = new Map<string, LibraryRecord>();
let persistent = true;

function degrade(error: unknown): void {
  if (persistent) {
    persistent = false;
    libraryPersistent.set(false);
    console.warn(
      'The notebook library could not use IndexedDB; notebooks are kept in memory ' +
        'for this session only.',
      error
    );
  }
}

// ─── Pure helpers (unit-tested; no IndexedDB, no stores) ─────────────────────

/**
 * Strip what cannot (or should not) be stored: `dom` outputs hold live
 * elements with circular references, and `table` outputs carry a window of
 * rows that dwarfs the rest of the file. Both are recomputed by re-running the
 * cell. The library and any future exporter store the same shape.
 */
export function serializableNotebook(notebook: Notebook): Notebook {
  return {
    ...notebook,
    cells: notebook.cells.map(cell => {
      if (!cell.output) return cell;
      // DOM elements can't be JSON-serialized (circular refs → throws)
      // Strip dom outputs; other types are safe strings/objects
      // `dom` can't be JSON-serialized at all (circular refs), and `table`
      // carries a window of rows that dwarfs everything else in the file — a
      // 50k-row table cost 59KB of markup per autosave. Both are recomputed by
      // re-running the cell.
      if (cell.output.type === 'dom' || cell.output.type === 'table') {
        return { ...cell, output: undefined };
      }
      return cell;
    })
  };
}

/**
 * The library key for a notebook from a given origin.
 *
 * Not simply `notebook.id`, because that id round-trips through the `.js` file
 * and is therefore shared by every copy of it: the one you edited locally, the
 * one a `note serve` companion owns, and the one behind a /gh/ link are three
 * different homes for the same identity. Keying by identity alone would make
 * opening a link silently overwrite local work — and keying by something
 * random would fork a new entry on every click of the same link. Keying by
 * (identity, origin) is idempotent per home: re-open a link and you land back
 * on the same entry, while your local copy sits untouched beside it.
 */
export function libraryId(notebookId: string, origin: NotebookOrigin): string {
  switch (origin.kind) {
    case 'disk':
      return `${notebookId}@file:${origin.path}`;
    case 'url':
      return `${notebookId}@${origin.href}`;
    default:
      // 'local', 'sample' and 'import' all mean "this browser's own copy".
      return notebookId;
  }
}

/** Human label for an origin, shown next to a row in the Storage panel. */
export function originLabel(origin: NotebookOrigin): string {
  switch (origin.kind) {
    case 'disk':
      return origin.path.split('/').pop() || origin.path;
    case 'url':
      try {
        return new URL(origin.href).hostname;
      } catch {
        return origin.href;
      }
    case 'import':
      return origin.filename;
    case 'sample':
      return 'example';
    default:
      return 'local';
  }
}

/** Drop the payload: what the panel lists, and what the store publishes. */
export function entryOf(record: LibraryRecord): LibraryEntry {
  const { notebook: _notebook, ...entry } = record;
  return entry;
}

/**
 * Alphabetical, and only alphabetical.
 *
 * Sorting by last-opened seemed helpful and was not: opening a notebook moved
 * its row to the top of the list under the cursor that had just clicked it, so
 * the list rearranged itself exactly when the reader was using it as a map.
 * A fixed order means a row stays where you last saw it. Ties fall back to the
 * key so two notebooks of the same name keep a stable order between renders.
 */
export function sortEntries(entries: LibraryEntry[]): LibraryEntry[] {
  return [...entries].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );
}

/**
 * Build the record to store. `previous` carries forward the facts the notebook
 * itself does not know: when it first entered the library, when it was last
 * opened, and where it came from when the caller does not say.
 */
export function buildRecord(
  notebook: Notebook,
  origin: NotebookOrigin | undefined,
  now: number,
  previous?: LibraryRecord | LibraryEntry,
  opened = false
): LibraryRecord {
  const stored = serializableNotebook(notebook);
  let size = 0;
  try {
    size = JSON.stringify(stored).length;
  } catch {
    // A notebook that will not serialize is still worth an entry; it just has
    // no meaningful size to report.
    size = 0;
  }
  const resolvedOrigin = origin ?? previous?.origin ?? { kind: 'local' as const };
  return {
    id: libraryId(notebook.id, resolvedOrigin),
    notebookId: notebook.id,
    name: notebook.name,
    createdAt: previous?.createdAt ?? notebook.createdAt ?? now,
    updatedAt: notebook.updatedAt ?? now,
    lastOpenedAt: opened ? now : previous?.lastOpenedAt ?? now,
    origin: resolvedOrigin,
    cellCount: notebook.cells.length,
    size,
    notebook: stored,
  };
}

// ─── Storage ─────────────────────────────────────────────────────────────────

async function readAll(): Promise<LibraryRecord[]> {
  if (!persistent) return [...memory.values()];
  try {
    return await idbRequest<LibraryRecord[]>(NOTEBOOKS, 'readonly', (s) => s.getAll());
  } catch (error) {
    degrade(error);
    return [...memory.values()];
  }
}

/**
 * Update one row of the reactive list in place.
 *
 * The alternative — re-listing after every write — would re-read every stored
 * notebook *with its payload* on each pass of the two-second autosave, since
 * IndexedDB has no way to fetch part of a record. That is megabytes of reads
 * per few seconds of typing. A write already knows exactly which row changed.
 */
function upsertEntry(record: LibraryRecord): void {
  libraryEntries.update((list) =>
    sortEntries([...list.filter((e) => e.id !== record.id), entryOf(record)])
  );
}

async function write(record: LibraryRecord): Promise<void> {
  memory.set(record.id, record);
  upsertEntry(record);
  if (!persistent) {
    mirrorToLegacySlot(record);
    return;
  }
  try {
    await idbRequest(NOTEBOOKS, 'readwrite', (s) => s.put(record));
  } catch (error) {
    degrade(error);
    mirrorToLegacySlot(record);
  }
}

/**
 * Lifeboat for a session with no IndexedDB.
 *
 * Firefox's private windows have no IndexedDB but do have localStorage, and
 * that is where the old single-slot autosave lived — so without this, moving to
 * the library would have *taken away* durability from exactly the users who had
 * the least. One slot, last write wins: the old behaviour, no better and no
 * worse, and migrateLegacyAutosave reads it back on the next load.
 */
function mirrorToLegacySlot(record: LibraryRecord): void {
  try {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(record.notebook));
    localStorage.setItem(
      LEGACY_META_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        name: record.name,
        cellCount: record.cellCount,
      })
    );
  } catch {
    // Storage full or blocked too. Nothing left to try; the in-memory copy
    // still serves this session, and libraryPersistent already says so.
  }
}

/**
 * Read the whole library and publish the list. This is the one place that pays
 * for reading every payload, so it runs at boot and when the Storage panel is
 * opened — not on the autosave path, which uses upsertEntry.
 */
export async function refreshLibrary(): Promise<void> {
  const all = await readAll();
  libraryEntries.set(sortEntries(all.map(entryOf)));
}

export async function getNotebookRecord(id: string): Promise<LibraryRecord | undefined> {
  if (!persistent) return memory.get(id);
  try {
    return await idbRequest<LibraryRecord | undefined>(NOTEBOOKS, 'readonly', (s) => s.get(id));
  } catch (error) {
    degrade(error);
    return memory.get(id);
  }
}

/**
 * Store (or update) a notebook. Called by the debounced autosave, so it must
 * stay cheap and must never throw into the caller: a library that cannot write
 * degrades to memory rather than interrupting the person typing.
 */
export async function putNotebook(
  notebook: Notebook,
  origin?: NotebookOrigin,
  opts: { opened?: boolean } = {}
): Promise<string> {
  const key = libraryId(notebook.id, origin ?? { kind: 'local' });
  const previous = await getNotebookRecord(key);
  const record = buildRecord(notebook, origin, Date.now(), previous, opts.opened);
  await write(record);
  librarySavedAt.set(Date.now());
  return record.id;
}

/** Delete for good. Only ever from an explicit, confirmed user action. */
export async function deleteNotebook(id: string): Promise<void> {
  memory.delete(id);
  libraryEntries.update((list) => list.filter((e) => e.id !== id));
  if (persistent) {
    try {
      await idbRequest(NOTEBOOKS, 'readwrite', (s) => s.delete(id));
    } catch (error) {
      degrade(error);
    }
  }
}

// ─── The active notebook, across reloads ─────────────────────────────────────

const SESSION_KEY = 'tangent-open-notebooks';
/** The pre-tabs pointer to a single notebook. Read once, to migrate. */
const LEGACY_ACTIVE_KEY = 'tangent-active-notebook';

export interface OpenSessions {
  /** Library keys of the open tabs, in tab order. */
  open: string[];
  /** Which of them is on screen. */
  active: string | null;
}

/**
 * Which notebooks are open, and which is on screen.
 *
 * In localStorage rather than the library: it has to be readable before
 * IndexedDB has opened, and it is a handful of short strings. It records
 * *identity only* — reopening a tab still reads the notebook itself from the
 * library, so a change made in another tab is never overwritten by a stale
 * copy carried in the session index.
 */
export function rememberOpenSessions(open: string[], active: string | null): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ open, active } satisfies OpenSessions));
  } catch {
    // Non-fatal: the next load just opens whatever the library lists first.
  }
}

export function lastOpenSessions(): OpenSessions {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.open)) {
        return {
          open: parsed.open.filter((id: unknown) => typeof id === 'string'),
          active: typeof parsed.active === 'string' ? parsed.active : null,
        };
      }
    }
    // Before tabs there was one pointer to one notebook. Carry it over so an
    // upgrade reopens what the reader had, rather than dropping them on the
    // sample notebook.
    const legacy = localStorage.getItem(LEGACY_ACTIVE_KEY);
    if (legacy) return { open: [legacy], active: legacy };
  } catch {
    // fall through
  }
  return { open: [], active: null };
}

// ─── Migration from the single-slot autosave ─────────────────────────────────

/**
 * Move the one notebook the old autosave slot could hold into the library.
 *
 * The legacy keys are dropped only once the copy is safely stored: if the
 * library had to degrade to memory, that slot is still the only durable copy of
 * the user's work and must stay exactly where it is.
 *
 * Returns the id of the migrated notebook, if there was one.
 */
export async function migrateLegacyAutosave(): Promise<string | null> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let notebook: Notebook;
  try {
    notebook = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!notebook?.id || !Array.isArray(notebook.cells)) return null;

  const key = libraryId(notebook.id, { kind: 'local' });
  const existing = await getNotebookRecord(key);
  // A library entry already covers it (a reload after a partial migration, or
  // the same notebook opened from a file since). Never overwrite the newer one.
  if (!existing || (notebook.updatedAt ?? 0) > existing.updatedAt) {
    await putNotebook(notebook);
  }

  if (persistent) {
    try {
      localStorage.removeItem(LEGACY_KEY);
      localStorage.removeItem(LEGACY_META_KEY);
    } catch {
      // Leaving them is harmless; the next run re-runs an idempotent migration.
    }
  }
  return key;
}
