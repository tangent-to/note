import { writable } from 'svelte/store';

// Local, private dataset cache.
//
// Files dropped into the Data panel are read in the browser (File API) and
// stored in IndexedDB. Nothing is uploaded or bundled into the deployed site,
// so CSV/JSON data never has to be served publicly. The cache survives reloads;
// cells read it through the `data()` accessor (see jsExecutor.setupDataAccess).

export interface DatasetMeta {
  name: string;
  type: string;
  size: number;
  addedAt: number;
}

export interface DatasetRecord extends DatasetMeta {
  text: string;
}

const DB_NAME = 'tangent';
const STORE = 'datasets';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'name' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = run(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
      })
  );
}

// Reactive list of dataset metadata (no text payload) for the UI.
export const datasets = writable<DatasetMeta[]>([]);

export async function refreshDatasets(): Promise<void> {
  try {
    const all = await request<DatasetRecord[]>('readonly', (s) => s.getAll());
    datasets.set(
      all
        .map(({ text: _text, ...meta }) => meta)
        .sort((a, b) => a.name.localeCompare(b.name))
    );
  } catch (error) {
    console.warn('Failed to list datasets:', error);
    datasets.set([]);
  }
}

export function getDataset(name: string): Promise<DatasetRecord | undefined> {
  return request<DatasetRecord | undefined>('readonly', (s) => s.get(name));
}

export function listDatasetNames(): Promise<string[]> {
  return request<IDBValidKey[]>('readonly', (s) => s.getAllKeys()).then(
    (keys) => keys.map(String)
  );
}

export async function deleteDataset(name: string): Promise<void> {
  await request('readwrite', (s) => s.delete(name));
  await refreshDatasets();
}

// Read a dropped file as text and cache it. Returns the names actually stored.
export async function addFiles(files: Iterable<File>): Promise<string[]> {
  const added: string[] = [];
  for (const file of files) {
    try {
      const text = await file.text();
      const record: DatasetRecord = {
        name: file.name,
        type: file.type || inferType(file.name),
        size: file.size,
        addedAt: Date.now(),
        text,
      };
      await request('readwrite', (s) => s.put(record));
      added.push(file.name);
    } catch (error) {
      console.warn(`Failed to store dataset "${file.name}":`, error);
    }
  }
  if (added.length) {
    // Ask the browser to keep this origin's storage so the cache is not evicted
    // under storage pressure. Best-effort; ignored where unsupported.
    try {
      await (navigator.storage as any)?.persist?.();
    } catch {
      // ignore
    }
    await refreshDatasets();
  }
  return added;
}

function inferType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.tsv')) return 'text/tab-separated-values';
  if (lower.endsWith('.json') || lower.endsWith('.ndjson')) return 'application/json';
  return 'text/plain';
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
