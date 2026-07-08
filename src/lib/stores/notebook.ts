import { writable, get } from 'svelte/store';
import type { Notebook, NotebookCell, NotebookFile } from '../types/notebook';
import { saveToLocalStorage } from '../utils/webPersistence';
import { computeStaleCells, hashCode, type RunRecord } from '../utils/dependencyGraph';

// Current notebook being edited
export const currentNotebook = writable<Notebook | null>(null);

// List of available notebook files
export const notebookFiles = writable<NotebookFile[]>([]);

// Recently opened files
export const recentFiles = writable<Array<{path: string; name: string; timestamp: number}>>([]);

// Currently selected cell
export const selectedCellId = writable<string | null>(null);

export const notebookDirty = writable(false);

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

// Forget all run history (e.g. on new/imported notebook or kernel reset).
export function resetStaleTracking(): void {
  cellRunInfo.clear();
  staleCells.set(new Set());
}

// Reactive mode: when on, running a cell automatically re-runs its downstream
// dependents in dependency order. Persisted across sessions.
const REACTIVE_KEY = 'tangent-reactive-mode';

function loadReactiveMode(): boolean {
  try {
    return localStorage.getItem(REACTIVE_KEY) === '1';
  } catch {
    return false;
  }
}

export const reactiveMode = writable<boolean>(loadReactiveMode());

reactiveMode.subscribe((on) => {
  try {
    localStorage.setItem(REACTIVE_KEY, on ? '1' : '0');
  } catch {
    // ignore persistence failures
  }
});

// Where cell outputs render relative to the cell content: 'below' (default,
// Jupyter-style) or 'above' (Observable-style). Persisted across sessions.
const OUTPUT_POSITION_KEY = 'tangent-output-position';

export type OutputPosition = 'below' | 'above';

function loadOutputPosition(): OutputPosition {
  try {
    return localStorage.getItem(OUTPUT_POSITION_KEY) === 'above' ? 'above' : 'below';
  } catch {
    return 'below';
  }
}

export const outputPosition = writable<OutputPosition>(loadOutputPosition());

outputPosition.subscribe((pos) => {
  try {
    localStorage.setItem(OUTPUT_POSITION_KEY, pos);
  } catch {
    // ignore persistence failures
  }
});

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

export function markNotebookClean(): void {
  notebookDirty.set(false);
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
}

// Schedule autosave with debouncing
function scheduleAutosave(): void {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
  }

  autosaveTimer = window.setTimeout(() => {
    // Save to localStorage for web persistence
    const notebook = get(currentNotebook);
    if (notebook) {
      saveToLocalStorage(notebook);
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
