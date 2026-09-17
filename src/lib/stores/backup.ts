/**
 * Backing up the library, restoring it, and knowing when to ask.
 *
 * The decisions — what goes in an archive, what a restore may overwrite, when a
 * reminder is due — are pure and tested in utils/libraryBackup.ts. This module
 * does the reading and writing, and holds the two facts that have to outlive a
 * reload: when the last backup was made, and until when a reminder is snoozed.
 */
import { derived, get, readable, writable } from 'svelte/store';
import {
  allNotebookRecords,
  buildRecord,
  libraryEntries,
  putNotebook,
  refreshLibrary,
  type LibraryRecord,
} from '../utils/notebookLibrary';
import { allDatasets, datasets, putDataset, refreshDatasets } from '../utils/dataStore';
import {
  DAY,
  backupFolderName,
  backupStatus,
  buildBackupEntries,
  parseBackupEntries,
  planRestore,
  summarizeRestore,
} from '../utils/libraryBackup';
import { createZip, readZip } from '../utils/zip';
import { sessionById, sessions, withoutRunState } from './sessions';

export const LAST_BACKUP_KEY = 'tangent-last-backup';
export const BACKUP_SNOOZE_KEY = 'tangent-backup-snoozed-until';

function readNumber(key: string): number | null {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeNumber(key: string, value: number | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch {
    // Not remembered across a reload; the status still works for this session.
  }
}

export const lastBackupAt = writable<number | null>(readNumber(LAST_BACKUP_KEY));
export const backupSnoozedUntil = writable<number | null>(readNumber(BACKUP_SNOOZE_KEY));

/** Re-evaluate "is a reminder due" as time passes, not only when data changes. */
const clock = readable(Date.now(), (set) => {
  const timer = setInterval(() => set(Date.now()), 60_000);
  return () => clearInterval(timer);
});

export const backupState = derived(
  [libraryEntries, datasets, lastBackupAt, backupSnoozedUntil, clock],
  ([$entries, $datasets, $last, $snoozed, $now]) => backupStatus($entries, $datasets, $last, $now, $snoozed)
);

/**
 * Whether the browser has agreed to keep this site's storage. Null until
 * checked, or where the browser does not say.
 */
export const storagePersisted = writable<boolean | null>(null);

export async function checkStoragePersisted(): Promise<void> {
  try {
    const persisted = await navigator.storage?.persisted?.();
    storagePersisted.set(typeof persisted === 'boolean' ? persisted : null);
  } catch {
    storagePersisted.set(null);
  }
}

/** Ask the browser to keep this site's storage. Firefox asks the reader. */
export async function requestStoragePersistence(): Promise<boolean> {
  try {
    const granted = Boolean(await navigator.storage?.persist?.());
    storagePersisted.set(granted);
    return granted;
  } catch {
    return false;
  }
}

/**
 * Everything the library holds, as a zip archive.
 *
 * Open tabs contribute what is on screen rather than their last autosave: a
 * backup made a second after typing should contain the typing.
 */
export async function createLibraryBackup(now = new Date()): Promise<{
  bytes: Uint8Array;
  filename: string;
  notebooks: number;
  datasets: number;
}> {
  const stored = await allNotebookRecords();
  const byId = new Map<string, LibraryRecord>(stored.map((r) => [r.id, r]));
  for (const session of get(sessions)) {
    const notebook = get(session.notebook);
    if (notebook) {
      byId.set(notebook.id, buildRecord(notebook, get(session.origin), now.getTime(), byId.get(notebook.id)));
    }
  }
  const data = await allDatasets();
  const bytes = await createZip(buildBackupEntries([...byId.values()], data, now));
  return { bytes, filename: `${backupFolderName(now)}.zip`, notebooks: byId.size, datasets: data.length };
}

/** Record that a backup was made, which also clears any snooze. */
export function markBackedUp(at = Date.now()): void {
  lastBackupAt.set(at);
  writeNumber(LAST_BACKUP_KEY, at);
  backupSnoozedUntil.set(null);
  writeNumber(BACKUP_SNOOZE_KEY, null);
}

export function snoozeBackupReminder(days = 3): void {
  const until = Date.now() + days * DAY;
  backupSnoozedUntil.set(until);
  writeNumber(BACKUP_SNOOZE_KEY, until);
}

/**
 * Restore an archive into the library. Returns the report to show.
 *
 * "Newer" is judged against what is on screen for an open notebook, not its
 * last autosave, so a restore cannot overwrite typing that has not been stored
 * yet. A notebook that is restored while open is replaced in its tab too —
 * otherwise the tab's next autosave would write the old content straight back.
 */
export async function restoreLibraryBackup(bytes: Uint8Array): Promise<string[]> {
  const parsed = parseBackupEntries(await readZip(bytes));

  const existing = new Map<string, { updatedAt: number }>();
  for (const record of await allNotebookRecords()) existing.set(record.id, { updatedAt: record.updatedAt });
  for (const session of get(sessions)) {
    const notebook = get(session.notebook);
    if (!notebook) continue;
    const stored = existing.get(notebook.id)?.updatedAt ?? 0;
    existing.set(notebook.id, { updatedAt: Math.max(stored, notebook.updatedAt ?? 0) });
  }
  const existingDatasets = new Map((await allDatasets()).map((d) => [d.name, d.text]));

  const plan = planRestore(parsed, existing, existingDatasets);
  for (const record of plan.put) {
    const session = sessionById(record.id);
    if (session) {
      session.notebook.set(withoutRunState(record.notebook));
      session.origin.set(record.origin);
    }
    await putNotebook(record.notebook, record.origin);
  }
  for (const dataset of plan.datasetsToAdd) await putDataset(dataset);

  await Promise.all([refreshLibrary(), refreshDatasets()]);
  return summarizeRestore(plan, parsed);
}
