/**
 * One open notebook, and everything that belongs to it alone.
 *
 * A notebook was never an object in this app: it was a dozen module-level
 * singletons — the document, the selection, the dirty flag, staleness, the
 * execution counter, the undo stack, run progress, one kernel. That is fine
 * with one notebook open and impossible with several, so all of it moves into
 * a NotebookSession, keyed by the notebook's own id — the same key the library
 * stores it under, so one notebook is one entry, one tab and one kernel however
 * it was reached.
 *
 * The stores every component already reads — `currentNotebook`,
 * `selectedCellId`, `staleCells`, … — are re-exported from stores/notebook as
 * *proxies* onto the active session (see `sessionStore`). That is what keeps
 * this change out of Notebook.svelte, Cell.svelte and the export service
 * entirely: they still read one notebook, it is just no longer the only one.
 */
import { derived, get, writable, type Writable } from 'svelte/store';
import type { ConsoleEntry, Notebook, NotebookCell } from '../types/notebook';
import { computeStaleCells, hashCode, type RunRecord } from '../utils/dependencyGraph';
import { disposeKernel, rekeyKernel, setActiveKernel } from '../utils/kernelClient';
import { disposeExecutor, rekeyExecutor, setActiveExecutor } from '../utils/mainExecutor';
import {
  putNotebook,
  rememberOpenSessions,
  type NotebookOrigin,
} from '../utils/notebookLibrary';

export interface DeletedCellEntry {
  cell: NotebookCell;
  index: number;
  timestamp: number;
}

export interface NotebookSession {
  /** The notebook's id: its library key, and its kernel's key. */
  readonly id: string;
  readonly notebook: Writable<Notebook>;
  readonly origin: Writable<NotebookOrigin>;
  readonly selectedCellId: Writable<string | null>;
  /** Differs from its origin (the file on disk, or the last exported .js). */
  readonly dirty: Writable<boolean>;
  readonly stale: Writable<Set<string>>;
  readonly runProgress: Writable<{ done: number; total: number } | null>;
  /**
   * The console REPL evaluates in this notebook's scope, so its transcript and
   * its recall history belong to this notebook too. Shared, they read as one
   * conversation with one scope while actually addressing several: `a` typed
   * twice in a row, answering 3 and then 6, with nothing on screen saying why.
   */
  readonly consoleEntries: Writable<ConsoleEntry[]>;
  readonly consoleHistory: Writable<string[]>;
  /** Per-cell record of the last run (when + content hash). Not persisted. */
  readonly cellRunInfo: Map<string, RunRecord>;
  execCounter: number;
  readonly undoStack: DeletedCellEntry[];
  autosaveTimer: ReturnType<typeof setTimeout> | null;
  /** Torn down when the notebook is closed. */
  stopAutosave: () => void;
}

const MAX_UNDO_STACK = 20;
const AUTOSAVE_DELAY = 2000;

/** Open notebooks, in tab order. */
export const sessions = writable<NotebookSession[]>([]);
export const activeSessionId = writable<string | null>(null);

export const activeSession = derived(
  [sessions, activeSessionId],
  ([list, id]) => list.find((s) => s.id === id) ?? null
);

/** The active session right now, for imperative code. */
export function current(): NotebookSession | null {
  return get(activeSession);
}

export function sessionById(id: string): NotebookSession | null {
  return get(sessions).find((s) => s.id === id) ?? null;
}

/**
 * A store that reads and writes whichever session is active.
 *
 * Reads republish when the active session changes *or* when that session's
 * own store emits; writes land on the active session and are dropped when
 * there is none, which is exactly what a UI with no notebook open should do.
 */
export function sessionStore<T>(
  pick: (session: NotebookSession) => Writable<T>,
  empty: T
): Writable<T> {
  const out = writable<T>(empty);
  let unbind: (() => void) | null = null;

  activeSession.subscribe((session) => {
    unbind?.();
    unbind = null;
    if (!session) {
      out.set(empty);
      return;
    }
    unbind = pick(session).subscribe((value) => out.set(value));
  });

  return {
    subscribe: out.subscribe,
    set: (value: T) => {
      const session = current();
      if (session) pick(session).set(value);
    },
    update: (fn: (value: T) => T) => {
      const session = current();
      if (session) pick(session).update(fn);
    },
  };
}

// ─── Autosave, per session ───────────────────────────────────────────────────

/**
 * Write this session's notebook to the library, debounced.
 *
 * Per session rather than "the open one": a notebook left running in a
 * background tab still finishes and still has to store its results. It is
 * driven by every change to the document, not by the dirty flag — storing a
 * cell's output is not an edit and does not mark a notebook dirty, so hanging
 * the autosave off dirtiness persisted every keystroke and no results at all.
 */
function startAutosave(session: NotebookSession): () => void {
  return session.notebook.subscribe(() => {
    if (session.autosaveTimer) clearTimeout(session.autosaveTimer);
    // Plain setTimeout, not window.setTimeout: nothing else in this module
    // needs a DOM, and keeping it that way is what lets the session lifecycle
    // be tested without one.
    session.autosaveTimer = setTimeout(() => {
      session.autosaveTimer = null;
      // Fire-and-forget: a library that cannot write degrades to memory and
      // says so through libraryPersistent, rather than failing an edit.
      void putNotebook(get(session.notebook), get(session.origin));
      globalThis.dispatchEvent?.(new CustomEvent('autosave-notebook'));
    }, AUTOSAVE_DELAY);
  });
}

/** Flush a pending write now, e.g. because the notebook is being closed. */
export function flushAutosave(session: NotebookSession): void {
  if (!session.autosaveTimer) return;
  clearTimeout(session.autosaveTimer);
  session.autosaveTimer = null;
  void putNotebook(get(session.notebook), get(session.origin));
}

// ─── Opening and closing ─────────────────────────────────────────────────────

/**
 * A notebook with the traces of a previous kernel removed.
 *
 * `executionOrder` says "this cell ran, as the nth run, in the kernel you have
 * now". A notebook reopened from the library comes back with the numbers its
 * last kernel gave it, into a kernel that has run nothing — so a reload showed
 * [12] beside cells whose variables no longer existed, and the next run was
 * numbered 1. `isRunning` is worse: stored mid-run, it came back as a spinner
 * that never stopped and a run button that stayed disabled.
 *
 * Outputs stay. They are still worth reading, and the file format does not keep
 * them anyway, so the library copy is the only place they survive.
 *
 * Returns the same object when there is nothing to strip, so opening a clean
 * notebook does not look like an edit.
 */
export function withoutRunState(notebook: Notebook): Notebook {
  const stale = notebook.cells.some((c) => c.executionOrder !== undefined || c.isRunning);
  if (!stale) return notebook;
  return {
    ...notebook,
    cells: notebook.cells.map((c) => {
      if (c.executionOrder === undefined && !c.isRunning) return c;
      const { executionOrder: _order, isRunning: _running, ...rest } = c;
      return rest as NotebookCell;
    }),
  };
}

/**
 * Reset what a session knows about runs, for a kernel that has just been
 * restarted: the counter starts again at 1, no cell counts as having run, and
 * nothing is stale, since staleness is measured against runs that no longer
 * exist. The kernel itself is restarted by the caller, which knows whether it
 * is a worker or the main thread.
 */
export function resetRunState(session: NotebookSession): void {
  session.execCounter = 0;
  session.cellRunInfo.clear();
  session.stale.set(new Set());
  session.notebook.update((nb) => (nb ? withoutRunState(nb) : nb));
}

function createSession(notebook: Notebook, origin: NotebookOrigin): NotebookSession {
  // A new session means a new kernel, which has run nothing yet.
  notebook = withoutRunState(notebook);
  const session: NotebookSession = {
    id: notebook.id,
    notebook: writable(notebook),
    origin: writable(origin),
    selectedCellId: writable(notebook.cells[0]?.id ?? null),
    dirty: writable(false),
    stale: writable(new Set<string>()),
    runProgress: writable(null),
    consoleEntries: writable<ConsoleEntry[]>([]),
    consoleHistory: writable<string[]>([]),
    cellRunInfo: new Map(),
    execCounter: 0,
    undoStack: [],
    autosaveTimer: null,
    stopAutosave: () => {},
  };
  session.stopAutosave = startAutosave(session);
  return session;
}

/**
 * Open a notebook in a session, or focus the one already holding it.
 *
 * Focusing rather than reopening matters: clicking a notebook you already have
 * open must not throw away its kernel, its outputs or its undo history — and
 * because identity is the notebook's id alone, reaching the same notebook a
 * second way (the library, then its file on disk) lands on that same tab
 * instead of opening a twin beside it.
 * `replaceContent` is for the one case where the same session must take new
 * bytes — the `note serve` companion pushing an edit made on disk.
 */
export function openSession(
  notebook: Notebook,
  origin: NotebookOrigin,
  opts: { replaceContent?: boolean } = {}
): NotebookSession {
  const id = notebook.id;
  const existing = sessionById(id);

  if (existing) {
    if (opts.replaceContent) {
      existing.notebook.set(notebook);
      existing.origin.set(origin);
      existing.cellRunInfo.clear();
      existing.stale.set(new Set());
      existing.execCounter = 0;
      existing.dirty.set(false);
    }
    setActive(id);
    return existing;
  }

  const session = createSession(notebook, origin);
  sessions.update((list) => [...list, session]);
  setActive(id);
  return session;
}

/**
 * Give an open notebook a new identity in place — Save As.
 *
 * The tab stays where it is and keeps everything that makes it worth keeping:
 * its kernel and variables, its outputs, its console, its undo history. Only
 * the key changes, and where it lives. The old identity's library entry is
 * flushed first and left alone, because the file it describes still exists.
 *
 * Returns null when there is nothing to move, or when another tab already is
 * the target notebook — two tabs on one identity is the state this module
 * exists to prevent.
 */
export function rekeySession(
  oldId: string,
  notebook: Notebook,
  origin: NotebookOrigin
): NotebookSession | null {
  const old = sessionById(oldId);
  if (!old) return null;
  if (notebook.id !== oldId && sessionById(notebook.id)) return null;

  // Settle the old entry under its old key before the stores move on.
  flushAutosave(old);
  old.stopAutosave();

  const session: NotebookSession = {
    ...old,
    id: notebook.id,
    autosaveTimer: null,
    stopAutosave: () => {},
  };
  session.notebook.set(notebook);
  session.origin.set(origin);
  session.dirty.set(false);
  session.stopAutosave = startAutosave(session);

  rekeyKernel(oldId, notebook.id);
  rekeyExecutor(oldId, notebook.id);
  sessions.update((list) => list.map((s) => (s.id === oldId ? session : s)));

  if (get(activeSessionId) === oldId) setActive(notebook.id);
  else persistOpen();
  return session;
}

/** Make `id` the notebook on screen, and the one `kernel`/`nb` refer to. */
export function setActive(id: string | null): void {
  activeSessionId.set(id);
  setActiveKernel(id);
  setActiveExecutor(id);
  persistOpen();
}

/**
 * Close a notebook. Its library entry is untouched — closing a tab is not
 * deleting a notebook — but its kernel is: the worker dies here rather than
 * lingering for a notebook nobody can see.
 */
export function closeSession(id: string): void {
  const session = sessionById(id);
  if (!session) return;

  flushAutosave(session);
  session.stopAutosave();
  disposeKernel(id);
  disposeExecutor(id);

  const list = get(sessions);
  const index = list.findIndex((s) => s.id === id);
  const remaining = list.filter((s) => s.id !== id);
  sessions.set(remaining);

  if (get(activeSessionId) === id) {
    // Focus the neighbour on the right, else the one on the left, the way a
    // browser or an editor does; null when that was the last notebook.
    const next = remaining[index] ?? remaining[index - 1] ?? null;
    setActive(next?.id ?? null);
  } else {
    persistOpen();
  }
}

/**
 * Writing the session index is held back until the app has finished deciding
 * what to open.
 *
 * Otherwise the very first `sessions` emission — the empty one, at module load
 * — would persist `{ open: [], active: null }` over the index that boot is
 * about to read, and every reload would land on the sample notebook having
 * "forgotten" every tab.
 */
let persisting = false;

function persistOpen(): void {
  if (!persisting) return;
  rememberOpenSessions(
    get(sessions).map((s) => s.id),
    get(activeSessionId)
  );
}

/** Called once the boot path has opened whatever it is going to open. */
export function startPersistingSessions(): void {
  persisting = true;
  persistOpen();
}

// Opening, closing and reordering all change what is persisted.
sessions.subscribe(() => persistOpen());

// ─── Per-session helpers the stores module re-exports ────────────────────────

/**
 * Session-scoped versions of the run bookkeeping.
 *
 * A run must land in the notebook that started it, not in whichever tab the
 * reader has since clicked on. Long runs are exactly when someone goes to look
 * at something else, so the proxy stores — which always mean "the active
 * notebook" — are the wrong tool inside a run loop: they would file the
 * outputs, the execution counter and the progress bar under the wrong
 * notebook. The run path captures its session and calls these instead.
 */
export function recordCellRunIn(session: NotebookSession, cellId: string, content: string): void {
  session.cellRunInfo.set(cellId, { at: Date.now(), hash: hashCode(content) });
}

export function nextExecutionOrderIn(session: NotebookSession): number {
  return ++session.execCounter;
}

/** Recompute staleness for one session, from its own run history. */
export function recomputeStaleIn(session: NotebookSession): void {
  const notebook = get(session.notebook);
  session.stale.set(
    notebook ? computeStaleCells(notebook.cells, session.cellRunInfo) : new Set()
  );
}

export function recordCellRun(cellId: string, content: string): void {
  current()?.cellRunInfo.set(cellId, { at: Date.now(), hash: hashCode(content) });
}

export function nextExecutionOrder(): number {
  const session = current();
  if (!session) return 0;
  return ++session.execCounter;
}

export function resetExecutionCounter(): void {
  const session = current();
  if (session) session.execCounter = 0;
}

export function resetStaleTracking(): void {
  const session = current();
  if (!session) return;
  session.cellRunInfo.clear();
  session.stale.set(new Set());
}

export function pushDeletedCell(cell: NotebookCell, index: number): void {
  const session = current();
  if (!session) return;
  session.undoStack.push({ cell, index, timestamp: Date.now() });
  if (session.undoStack.length > MAX_UNDO_STACK) session.undoStack.shift();
}

export function popDeletedCell(): DeletedCellEntry | null {
  return current()?.undoStack.pop() ?? null;
}

export function hasDeletedCells(): boolean {
  return (current()?.undoStack.length ?? 0) > 0;
}
