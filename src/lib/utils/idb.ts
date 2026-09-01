/**
 * The one opener for the `tangent` IndexedDB database.
 *
 * Datasets and notebooks share a database, so they cannot each call
 * `indexedDB.open()` with a version of their own: whichever opened second
 * would either downgrade (VersionError) or race the first through
 * `onupgradeneeded`. Both go through here instead, and adding a store means
 * bumping VERSION and creating it in `upgrade`.
 *
 * Every helper resolves a fresh connection and closes it when the transaction
 * completes. Holding one open would block a later version upgrade in *another*
 * tab until this one is closed, which is exactly the deadlock `onblocked`
 * exists to report.
 */

export const DB_NAME = 'tangent';
export const DATASETS = 'datasets';
export const NOTEBOOKS = 'notebooks';

/** v1: datasets. v2: notebooks (the local notebook library). */
const VERSION = 2;

function upgrade(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(DATASETS)) {
    db.createObjectStore(DATASETS, { keyPath: 'name' });
  }
  if (!db.objectStoreNames.contains(NOTEBOOKS)) {
    db.createObjectStore(NOTEBOOKS, { keyPath: 'id' });
  }
}

export function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this browser context'));
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, VERSION);
    } catch (error) {
      // Some privacy modes throw here rather than firing onerror.
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    req.onupgradeneeded = () => upgrade(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open the database'));
    // Another tab still holds an older version open. Report it instead of
    // hanging: callers fall back to memory and can tell the user why.
    req.onblocked = () =>
      reject(new Error('Another tab is using an older version of the local database'));
  });
}

/** Run one request against one store, then close the connection. */
export function idbRequest<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let req: IDBRequest;
        try {
          const tx = db.transaction(store, mode);
          tx.oncomplete = () => db.close();
          tx.onabort = () => db.close();
          req = run(tx.objectStore(store));
        } catch (error) {
          db.close();
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error ?? new Error('Database request failed'));
      })
  );
}
