/**
 * The lock: what a notebook's folder is pinned to.
 *
 * Freezing answers a question the cache alone cannot: *which* bytes. A cache
 * makes a notebook run offline; it does not stop it changing when a library
 * moves. Half of the imports in a real notebook point at a moving target —
 * `@main`, or a bare `d3` that resolves to whatever is newest today — so a
 * piece can sound different tomorrow without anything in the file changing.
 *
 * So the lock records, for every URL the folder's notebooks actually loaded,
 * the hash of what came back. Frozen, the cache answers everything; a URL that
 * is in the lock but missing from this browser is fetched once and checked
 * against its hash, which is what lets a frozen folder be cloned from git and
 * still be the same environment. A URL that is in neither is refused, because
 * a freeze that quietly let a new import through would not be a freeze.
 *
 * The lock is a file in the folder — human-readable, diffable, committed — so
 * the environment belongs to the work, not to this browser.
 */

export const LOCK_FILE = 'tangent.lock';
export const LOCK_FORMAT = 'tangent-lock';
export const LOCK_VERSION = 1;

export interface Lock {
  format: typeof LOCK_FORMAT;
  version: number;
  /** Whether the folder is frozen right now. */
  frozen: boolean;
  frozenAt: string | null;
  /** URL → `sha256-<base64>` of what it returned when frozen. */
  modules: Record<string, string>;
}

export function emptyLock(): Lock {
  return { format: LOCK_FORMAT, version: LOCK_VERSION, frozen: false, frozenAt: null, modules: {} };
}

/** Serialize with sorted URLs, so a diff shows what actually changed. */
export function serializeLock(lock: Lock): string {
  const modules: Record<string, string> = {};
  for (const url of Object.keys(lock.modules).sort()) modules[url] = lock.modules[url];
  return `${JSON.stringify({ ...lock, modules }, null, 2)}\n`;
}

/**
 * Read a lock file. Throws with a readable message rather than half-applying a
 * file it does not understand: freezing against a lock that was not understood
 * would pin the wrong things.
 */
export function parseLock(text: string): Lock {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${LOCK_FILE} is not valid JSON.`);
  }
  if (raw?.format !== LOCK_FORMAT) throw new Error(`${LOCK_FILE} is not a tangent lock file.`);
  if (typeof raw.version !== 'number' || raw.version > LOCK_VERSION) {
    throw new Error(`${LOCK_FILE} was written by a newer version of tangent/note.`);
  }
  const modules: Record<string, string> = {};
  for (const [url, hash] of Object.entries(raw.modules ?? {})) {
    if (typeof hash === 'string' && /^sha256-[A-Za-z0-9+/=]+$/.test(hash)) modules[url] = hash;
  }
  return {
    format: LOCK_FORMAT,
    version: LOCK_VERSION,
    frozen: raw.frozen === true,
    frozenAt: typeof raw.frozenAt === 'string' ? raw.frozenAt : null,
    modules,
  };
}

/** What changed between what is loaded now and what the lock pinned. */
export interface LockDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
}

export function diffLock(lock: Lock, current: Record<string, string>): LockDiff {
  const added: string[] = [];
  const changed: string[] = [];
  let unchanged = 0;
  for (const [url, hash] of Object.entries(current)) {
    const pinned = lock.modules[url];
    if (pinned === undefined) added.push(url);
    else if (pinned !== hash) changed.push(url);
    else unchanged++;
  }
  const removed = Object.keys(lock.modules).filter((url) => !(url in current));
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort(), unchanged };
}

/** A short, sortable name for a pinned URL, for the panel and the report. */
export function shortName(url: string): string {
  try {
    const { hostname, pathname } = new URL(url);
    const npm = /^\/(?:npm|gh)\/(.+?)(?:\/\+esm)?$/.exec(pathname);
    return npm ? npm[1] : `${hostname}${pathname}`;
  } catch {
    return url;
  }
}
