/**
 * Freezing a folder's environment, and thawing it.
 *
 * The lock lives in the folder (utils/environment.ts), the snapshot lives in
 * the browser's cache (the service worker), and this module keeps the two
 * agreeing: read the lock when a notebook's folder comes into view, apply it to
 * the cache, write it back when the reader freezes.
 *
 * Only a notebook served by note serve has a folder, so only such a notebook
 * can be frozen — a lock has to live somewhere, and "somewhere" is the folder
 * that git already tracks. One environment is active at a time: the folder of
 * the notebook on screen.
 */
import { get, writable } from 'svelte/store';
import { currentOrigin } from './notebook';
import { syncStatus } from '../utils/serverSync';
import { applyFrozen, snapshotModules } from '../utils/offlineCache';
import {
  LOCK_FILE,
  diffLock,
  emptyLock,
  parseLock,
  serializeLock,
  type Lock,
  type LockDiff,
} from '../utils/environment';

/** The lock of the folder on screen, or null when this notebook has no folder. */
export const currentLock = writable<Lock | null>(null);
/** The folder the lock belongs to, relative to the served root. */
export const lockFolder = writable<string | null>(null);

function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function lockUrl(folder: string): string {
  const path = folder ? `${folder}/${LOCK_FILE}` : LOCK_FILE;
  return `/__files/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** The folder of the notebook on screen, or null when it is not a file on disk. */
export function activeFolder(): string | null {
  const origin = get(currentOrigin);
  if (origin.kind !== 'disk' || get(syncStatus) !== 'connected') return null;
  return folderOf(origin.path);
}

/**
 * Read the folder's lock and put the cache into the state it describes.
 *
 * Called when the notebook on screen changes, so opening a frozen folder freezes
 * the cache, and leaving it thaws — the state belongs to the folder, not to the
 * browser.
 */
export async function loadEnvironment(): Promise<void> {
  const folder = activeFolder();
  lockFolder.set(folder);
  if (folder === null) {
    currentLock.set(null);
    await applyFrozen(null);
    return;
  }
  let lock: Lock | null = null;
  try {
    const response = await fetch(lockUrl(folder), { cache: 'no-store' });
    if (response.ok) lock = parseLock(await response.text());
  } catch {
    // No companion, or no lock file: an unfrozen folder.
  }
  currentLock.set(lock);
  await applyFrozen(lock?.frozen ? lock.modules : null);
}

async function writeLock(folder: string, lock: Lock): Promise<void> {
  const response = await fetch(lockUrl(folder), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: serializeLock(lock),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error ?? `Could not write ${LOCK_FILE} (${response.status}).`);
  }
}

export interface FreezeResult {
  lock: Lock;
  diff: LockDiff;
  count: number;
}

/**
 * Pin this folder to what its notebooks have actually loaded.
 *
 * What has not been loaded cannot be pinned — a soundfont is only fetched when
 * a note using it plays — so the honest gesture is Run All, then Freeze, and the
 * panel says so.
 */
export async function freezeEnvironment(): Promise<FreezeResult> {
  const folder = activeFolder();
  if (folder === null) {
    throw new Error('Freezing needs a notebook that note serve is serving: the lock is a file in its folder.');
  }
  const modules = await snapshotModules();
  if (!modules) throw new Error('The offline cache is not running, so there is nothing to freeze.');

  const previous = get(currentLock) ?? emptyLock();
  const lock: Lock = {
    ...emptyLock(),
    frozen: true,
    frozenAt: new Date().toISOString(),
    modules,
  };
  await writeLock(folder, lock);
  await applyFrozen(modules);
  currentLock.set(lock);
  return { lock, diff: diffLock(previous, modules), count: Object.keys(modules).length };
}

/** Go back to following the network, keeping the lock as the record of what was pinned. */
export async function unfreezeEnvironment(): Promise<void> {
  const folder = activeFolder();
  if (folder === null) return;
  const lock = get(currentLock) ?? emptyLock();
  const thawed: Lock = { ...lock, frozen: false };
  await writeLock(folder, thawed);
  await applyFrozen(null);
  currentLock.set(thawed);
}
