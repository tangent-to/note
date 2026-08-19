import type { Notebook } from '../types/notebook';

const STORAGE_KEY = 'tangent-notebook-autosave';
const STORAGE_META_KEY = 'tangent-notebook-meta';

function serializableNotebook(notebook: Notebook): Notebook {
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

export function saveToLocalStorage(notebook: Notebook): void {
  try {
    const data = JSON.stringify(serializableNotebook(notebook));
    localStorage.setItem(STORAGE_KEY, data);
    localStorage.setItem(STORAGE_META_KEY, JSON.stringify({
      savedAt: Date.now(),
      name: notebook.name,
      cellCount: notebook.cells.length
    }));
  } catch (e) {
    console.warn('Failed to save to localStorage:', e);
  }
}

export function loadFromLocalStorage(): Notebook | null {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return null;
    const notebook = JSON.parse(data);
    if (!notebook.id || !notebook.cells || !Array.isArray(notebook.cells)) return null;
    return notebook;
  } catch {
    return null;
  }
}

export function getLocalStorageMeta(): { savedAt: number; name: string; cellCount: number } | null {
  try {
    const meta = localStorage.getItem(STORAGE_META_KEY);
    if (!meta) return null;
    return JSON.parse(meta);
  } catch {
    return null;
  }
}

export function clearLocalStorage(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_META_KEY);
  } catch {
    // ignore
  }
}
