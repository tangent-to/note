import { writable, derived, get, type Writable } from 'svelte/store';
import type { Notebook, NotebookCell, NotebookFile } from '../types/notebook';
import { putNotebook, rememberActiveNotebook, type NotebookOrigin } from '../utils/notebookLibrary';
import {
  computeStaleCells,
  findDuplicateDefinitions,
  hashCode,
  type RunRecord,
} from '../utils/dependencyGraph';

// Current notebook being edited
export const currentNotebook = writable<Notebook | null>(null);

// List of available notebook files
export const notebookFiles = writable<NotebookFile[]>([]);

// Recently opened files
export const recentFiles = writable<Array<{path: string; name: string; timestamp: number}>>([]);

// Currently selected cell
export const selectedCellId = writable<string | null>(null);

/**
 * The notebook differs from its **origin** — the file a `note serve` companion
 * owns, or the last exported `.js`. This is what Ctrl+S clears and what the
 * header's "modified" mark reflects.
 *
 * It is deliberately NOT "unsaved work". Every edit is written to the local
 * library a moment later (see scheduleAutosave), so nothing is ever at risk of
 * being lost by closing or switching notebooks. Conflating the two is what made
 * the old app prompt "save first?" before every navigation.
 */
export const notebookDirty = writable(false);

/** Where the current notebook came from; carried into its library entry. */
export const currentOrigin = writable<NotebookOrigin>({ kind: 'local' });

// Progress of a "run all" / "run stale" batch, for the thin bar on the header's
// bottom edge. `null` when idle; otherwise how many cells have finished of the
// total in the current batch.
export const runProgress = writable<{ done: number; total: number } | null>(null);

// Set of cell ids whose output is stale: an upstream dependency changed or ran
// more recently, or the cell was edited since it last ran.
export const staleCells = writable<Set<string>>(new Set());

// Per-cell record of the last run (when + content hash). Not persisted.
const cellRunInfo = new Map<string, RunRecord>();

// Record that a cell just ran with the given content.
export function recordCellRun(cellId: string, content: string): void {
  cellRunInfo.set(cellId, { at: Date.now(), hash: hashCode(content) });
}

// Recompute which cells are stale and publish to the store.
export function recomputeStaleCells(notebook: Notebook | null): void {
  staleCells.set(notebook ? computeStaleCells(notebook.cells, cellRunInfo) : new Set());
}

/** cellId -> the names it defines that another cell defines too (sorted). */
export function duplicateDefinitionsByCell(
  notebook: Notebook | null
): Map<string, string[]> {
  const byCell = new Map<string, string[]>();
  if (!notebook) return byCell;
  for (const [name, cellIds] of findDuplicateDefinitions(notebook.cells)) {
    for (const id of cellIds) {
      const names = byCell.get(id) ?? [];
      names.push(name);
      byCell.set(id, names);
    }
  }
  for (const names of byCell.values()) names.sort();
  return byCell;
}

// Names defined by two or more cells, per cell — a warning surfaced on the cell,
// since both definitions write the same shared-scope variable.
//
// Derived (not recomputed at call sites) so adding, deleting, skipping and
// retyping cells all stay in sync, and debounced because the scan re-analyses
// every cell in the notebook — the same reason staleness is debounced.
export const duplicateDefinitions = derived<typeof currentNotebook, Map<string, string[]>>(
  currentNotebook,
  (notebook, set) => {
    const timer = setTimeout(() => set(duplicateDefinitionsByCell(notebook)), 250);
    return () => clearTimeout(timer);
  },
  new Map()
);

// Forget all run history (e.g. on new/imported notebook or kernel reset).
export function resetStaleTracking(): void {
  cellRunInfo.clear();
  staleCells.set(new Set());
}

// A writable store backed by localStorage under `key`. The initial value comes
// from `parse` (which receives the raw stored string, or null when absent or
// when localStorage is unavailable); every change is written back as a string.
// Read/write failures (private mode, quota) are swallowed so the store still
// works purely in-memory.
function persistedStore<T>(key: string, parse: (raw: string | null) => T): Writable<T> {
  let initial: T;
  try {
    initial = parse(localStorage.getItem(key));
  } catch {
    initial = parse(null);
  }
  const store = writable<T>(initial);
  let warned = false;
  store.subscribe((value) => {
    try {
      localStorage.setItem(key, String(value));
    } catch (error) {
      // Storage can be unavailable (private mode) or full. Keep working purely
      // in memory, but say so once: the symptom is a setting that silently
      // forgets itself on reload, which is otherwise hard to place.
      if (!warned) {
        warned = true;
        console.warn(`Could not persist "${key}"; it will reset when the page reloads.`, error);
      }
    }
  });
  return store;
}

export type KernelMode = 'worker' | 'main';
export type OutputPosition = 'below' | 'above';

// Reactive mode: when on, running a cell automatically re-runs its downstream
// dependents in dependency order. Persisted across sessions.
// Stored as 'true'/'false'; '1' is also accepted for backward compatibility.
export const reactiveMode = persistedStore<boolean>(
  'tangent-reactive-mode',
  (raw) => raw === 'true' || raw === '1',
);

// Where cells execute. 'worker' (default) runs code in a Web Worker kernel:
// the UI never freezes and runs can be stopped, but outputs are serialized
// (figures render as static HTML). 'main' is the legacy main-thread executor
// for notebooks that need live DOM outputs (interactive players, etc.).
export const kernelMode = persistedStore<KernelMode>(
  'tangent-kernel-mode',
  (raw) => (raw === 'main' ? 'main' : 'worker'),
);

// Where cell outputs render relative to the cell content: 'below' (default,
// Jupyter-style) or 'above' (Observable-style). Persisted across sessions.
export const outputPosition = persistedStore<OutputPosition>(
  'tangent-output-position',
  (raw) => (raw === 'above' ? 'above' : 'below'),
);

// Current file path (when a notebook is associated with a file)
export const currentFilePath = writable<string | null>(null);

// Execution order counter
let executionCounter = 0;

export function getNextExecutionOrder(): number {
  return ++executionCounter;
}

export function resetExecutionCounter(): void {
  executionCounter = 0;
}

// Undo stack for deleted cells
interface DeletedCellEntry {
  cell: NotebookCell;
  index: number;
  timestamp: number;
}

const deletedCellsStack: DeletedCellEntry[] = [];
const MAX_UNDO_STACK = 20;

export function pushDeletedCell(cell: NotebookCell, index: number): void {
  deletedCellsStack.push({ cell, index, timestamp: Date.now() });
  if (deletedCellsStack.length > MAX_UNDO_STACK) {
    deletedCellsStack.shift();
  }
}

export function popDeletedCell(): DeletedCellEntry | null {
  return deletedCellsStack.pop() || null;
}

export function hasDeletedCells(): boolean {
  return deletedCellsStack.length > 0;
}

// Autosave debounce timer
let autosaveTimer: number | null = null;
const AUTOSAVE_DELAY = 2000; // 2 seconds

export function markNotebookDirty(): void {
  notebookDirty.set(true);
  scheduleAutosave();
}

// Any change to the notebook schedules a library write, not just the ones that
// go through markNotebookDirty. Running a cell stores its output straight into
// the notebook without marking it dirty — an output is not an edit — so
// hanging the autosave off dirtiness alone would have persisted every keystroke
// and no result at all.
currentNotebook.subscribe((notebook) => {
  if (notebook) scheduleAutosave();
});

// Mark the notebook as matching its origin (just saved to disk, or just
// loaded from one). It does NOT cancel a pending library write: the two are
// independent now, and cancelling here used to mean a notebook loaded from a
// file never reached the library at all.
export function markNotebookClean(): void {
  notebookDirty.set(false);
}

// Write the current notebook to the local library, debounced.
//
// This is the "saved to the library" half of the split described on
// notebookDirty: automatic, silent, and never something the user is asked
// about. It does not clear notebookDirty — that tracks the origin, not this.
function scheduleAutosave(): void {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
  }

  autosaveTimer = window.setTimeout(() => {
    const notebook = get(currentNotebook);
    if (notebook) {
      rememberActiveNotebook(notebook.id);
      // Fire-and-forget: a library that cannot write degrades to memory and
      // says so through libraryPersistent, rather than failing an edit.
      void putNotebook(notebook, get(currentOrigin));
    }
    // Dispatch autosave event that the App component can listen to
    window.dispatchEvent(new CustomEvent('autosave-notebook'));
    autosaveTimer = null;
  }, AUTOSAVE_DELAY);
}

// Add file to recent files list
export function addToRecentFiles(path: string, name: string): void {
  recentFiles.update(files => {
    const filtered = files.filter(f => f.path !== path);
    return [
      { path, name, timestamp: Date.now() },
      ...filtered
    ].slice(0, 10); // Keep only 10 most recent
  });
}

// Create a new notebook
export function createNewNotebook(): Notebook {
  const now = Date.now();
  resetExecutionCounter();
  resetStaleTracking();
  const notebook = {
    id: `notebook-${now}`,
    name: 'Untitled Notebook',
    cells: [createNewCell()],
    createdAt: now,
    updatedAt: now
  };
  markNotebookClean();
  return notebook;
}

// Create a new cell
export function createNewCell(type: 'code' | 'markdown' = 'code'): NotebookCell {
  return {
    id: `cell-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    type,
    content: '',
    isRunning: false
  };
}

// Update cell content
export function updateCellContent(notebook: Notebook, cellId: string, content: string): Notebook {
  markNotebookDirty();
  return {
    ...notebook,
    cells: notebook.cells.map(cell =>
      cell.id === cellId ? { ...cell, content } : cell
    ),
    updatedAt: Date.now()
  };
}

// Add cell after specified cell
export function addCellAfter(notebook: Notebook, afterCellId: string, type: 'code' | 'markdown' = 'code'): Notebook {
  const cellIndex = notebook.cells.findIndex(cell => cell.id === afterCellId);
  const newCell = createNewCell(type);
  const newCells = [...notebook.cells];
  newCells.splice(cellIndex + 1, 0, newCell);
  markNotebookDirty();

  return {
    ...notebook,
    cells: newCells,
    updatedAt: Date.now()
  };
}

// Insert a cell directly above `beforeCellId`, for the insert bar over the
// first cell: without it the only way to open a notebook with a new cell was to
// add one below and drag it up.
export function addCellBefore(notebook: Notebook, beforeCellId: string, type: 'code' | 'markdown' = 'code'): Notebook {
  const cellIndex = notebook.cells.findIndex(cell => cell.id === beforeCellId);
  if (cellIndex === -1) return notebook;
  const newCells = [...notebook.cells];
  newCells.splice(cellIndex, 0, createNewCell(type));
  markNotebookDirty();

  return {
    ...notebook,
    cells: newCells,
    updatedAt: Date.now()
  };
}

// Delete cell (with undo support)
export function deleteCell(notebook: Notebook, cellId: string): Notebook {
  if (notebook.cells.length <= 1) return notebook; // Don't delete the last cell

  const cellIndex = notebook.cells.findIndex(c => c.id === cellId);
  if (cellIndex === -1) return notebook;

  // Push to undo stack
  pushDeletedCell(notebook.cells[cellIndex], cellIndex);
  markNotebookDirty();

  return {
    ...notebook,
    cells: notebook.cells.filter(cell => cell.id !== cellId),
    updatedAt: Date.now()
  };
}

// Undo last cell deletion
export function undoDeleteCell(notebook: Notebook): Notebook {
  const entry = popDeletedCell();
  if (!entry) return notebook;

  const newCells = [...notebook.cells];
  // Re-insert at original position (clamped to current length)
  const insertIdx = Math.min(entry.index, newCells.length);
  newCells.splice(insertIdx, 0, entry.cell);
  markNotebookDirty();

  return {
    ...notebook,
    cells: newCells,
    updatedAt: Date.now()
  };
}

// Move cell up
export function moveCellUp(notebook: Notebook, cellId: string): Notebook {
  const cellIndex = notebook.cells.findIndex(cell => cell.id === cellId);
  if (cellIndex <= 0) return notebook;

  const newCells = [...notebook.cells];
  [newCells[cellIndex - 1], newCells[cellIndex]] = [newCells[cellIndex], newCells[cellIndex - 1]];
  markNotebookDirty();

  return {
    ...notebook,
    cells: newCells,
    updatedAt: Date.now()
  };
}

// Move cell down
export function moveCellDown(notebook: Notebook, cellId: string): Notebook {
  const cellIndex = notebook.cells.findIndex(cell => cell.id === cellId);
  if (cellIndex >= notebook.cells.length - 1) return notebook;

  const newCells = [...notebook.cells];
  [newCells[cellIndex], newCells[cellIndex + 1]] = [newCells[cellIndex + 1], newCells[cellIndex]];
  markNotebookDirty();

  return {
    ...notebook,
    cells: newCells,
    updatedAt: Date.now()
  };
}
