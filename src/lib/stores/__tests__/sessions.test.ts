/**
 * Session lifecycle and the proxy stores.
 *
 * These are the parts that decide whether one notebook can quietly write into
 * another: which session a store's write lands on, whether opening a notebook
 * you already have open throws away its state, and whether closing one leaves
 * the right neighbour on screen.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import type { Notebook } from '../../types/notebook';

// The library writes through IndexedDB and the kernel spawns Workers; neither
// exists in Node and neither is what these tests are about.
vi.mock('../../utils/notebookLibrary', () => ({
  libraryId: (id: string, origin: any) =>
    origin.kind === 'disk' ? `${id}@file:${origin.path}`
    : origin.kind === 'url' ? `${id}@${origin.href}`
    : id,
  putNotebook: vi.fn(async () => 'ok'),
  rememberOpenSessions: vi.fn(),
}));
vi.mock('../../utils/kernelClient', () => ({
  disposeKernel: vi.fn(),
  setActiveKernel: vi.fn(),
}));
vi.mock('../../utils/mainExecutor', () => ({
  disposeExecutor: vi.fn(),
  setActiveExecutor: vi.fn(),
}));

import {
  activeSessionId,
  closeSession,
  openSession,
  sessionById,
  sessions,
  sessionStore,
  setActive,
  nextExecutionOrderIn,
} from '../sessions';

function makeNotebook(id: string, name = id): Notebook {
  return {
    id,
    name,
    cells: [{ id: `${id}-c1`, type: 'code', content: '' }],
    createdAt: 1,
    updatedAt: 1,
  };
}

const local = { kind: 'local' } as const;

beforeEach(() => {
  for (const session of get(sessions)) closeSession(session.id);
  sessions.set([]);
  activeSessionId.set(null);
});

describe('openSession', () => {
  it('opens a notebook and makes it active', () => {
    const session = openSession(makeNotebook('a'), local);
    expect(get(sessions)).toHaveLength(1);
    expect(get(activeSessionId)).toBe(session.id);
  });

  it('focuses an already-open notebook instead of reopening it', () => {
    const first = openSession(makeNotebook('a'), local);
    first.selectedCellId.set('a-c1');
    nextExecutionOrderIn(first);
    openSession(makeNotebook('b'), local);

    const again = openSession(makeNotebook('a'), local);

    // Same session object: its kernel, outputs, selection and undo history are
    // exactly where they were. Reopening would have thrown all of that away.
    expect(again).toBe(first);
    expect(get(sessions)).toHaveLength(2);
    expect(get(again.selectedCellId)).toBe('a-c1');
    expect(again.execCounter).toBe(1);
    expect(get(activeSessionId)).toBe(first.id);
  });

  it('replaces content in place only when asked', () => {
    const session = openSession(makeNotebook('a', 'Before'), local);
    nextExecutionOrderIn(session);

    openSession(makeNotebook('a', 'After'), local);
    expect(get(session.notebook).name).toBe('Before');

    // The `note serve` companion pushing a disk edit is the one case that must
    // overwrite the tab rather than open a second one onto the same file.
    openSession(makeNotebook('a', 'After'), local, { replaceContent: true });
    expect(get(session.notebook).name).toBe('After');
    expect(session.execCounter).toBe(0);
    expect(get(sessions)).toHaveLength(1);
  });

  it('keeps the same notebook from two origins as two tabs', () => {
    // The id travels in the .js file, so a link and a local copy share it.
    // One tab for both would mean opening the link overwrites local work.
    openSession(makeNotebook('a'), local);
    openSession(makeNotebook('a'), { kind: 'url', href: 'https://x.dev/a.js' });
    expect(get(sessions)).toHaveLength(2);
  });
});

describe('closeSession', () => {
  it('focuses the neighbour on the right, else the one on the left', () => {
    const a = openSession(makeNotebook('a'), local);
    const b = openSession(makeNotebook('b'), local);
    const c = openSession(makeNotebook('c'), local);

    setActive(b.id);
    closeSession(b.id);
    expect(get(activeSessionId)).toBe(c.id);

    closeSession(c.id);
    expect(get(activeSessionId)).toBe(a.id);

    closeSession(a.id);
    expect(get(activeSessionId)).toBeNull();
    expect(get(sessions)).toHaveLength(0);
  });

  it('leaves the active tab alone when another one closes', () => {
    const a = openSession(makeNotebook('a'), local);
    const b = openSession(makeNotebook('b'), local);
    setActive(a.id);

    closeSession(b.id);
    expect(get(activeSessionId)).toBe(a.id);
    expect(sessionById(b.id)).toBeNull();
  });
});

describe('sessionStore', () => {
  it('reads and writes whichever session is active', () => {
    const selection = sessionStore<string | null>((s) => s.selectedCellId, null);
    const a = openSession(makeNotebook('a'), local);
    const b = openSession(makeNotebook('b'), local);

    // b is active (opened last).
    selection.set('written-to-b');
    expect(get(b.selectedCellId)).toBe('written-to-b');
    expect(get(a.selectedCellId)).toBe('a-c1');
    expect(get(selection)).toBe('written-to-b');

    setActive(a.id);
    expect(get(selection)).toBe('a-c1');
  });

  it('follows the active session’s own emissions', () => {
    const selection = sessionStore<string | null>((s) => s.selectedCellId, null);
    const a = openSession(makeNotebook('a'), local);
    a.selectedCellId.set('changed');
    expect(get(selection)).toBe('changed');
  });

  it('reads empty and drops writes when no notebook is open', () => {
    const selection = sessionStore<string | null>((s) => s.selectedCellId, null);
    expect(get(selection)).toBeNull();
    expect(() => selection.set('nowhere')).not.toThrow();
    expect(get(selection)).toBeNull();
  });

  it('does not leak a closed session’s value into the next active one', () => {
    const selection = sessionStore<string | null>((s) => s.selectedCellId, null);
    const a = openSession(makeNotebook('a'), local);
    const b = openSession(makeNotebook('b'), local);
    b.selectedCellId.set('b-only');
    expect(get(selection)).toBe('b-only');

    closeSession(b.id);
    expect(get(activeSessionId)).toBe(a.id);
    expect(get(selection)).toBe('a-c1');

    // The closed session must no longer drive the proxy.
    b.selectedCellId.set('ghost');
    expect(get(selection)).toBe('a-c1');
  });
});

describe('execution counters', () => {
  it('counts per notebook, not across them', () => {
    const a = openSession(makeNotebook('a'), local);
    const b = openSession(makeNotebook('b'), local);

    expect(nextExecutionOrderIn(a)).toBe(1);
    expect(nextExecutionOrderIn(a)).toBe(2);
    expect(nextExecutionOrderIn(b)).toBe(1);
    expect(nextExecutionOrderIn(a)).toBe(3);
  });
});

describe('the console belongs to a notebook', () => {
  it('keeps a transcript and a recall history per session', () => {
    // Regression: one shared transcript across tabs read as a single
    // conversation with a single scope while addressing several — `a` typed
    // twice, answering 3 then 6, with nothing on screen saying why.
    const a = openSession(makeNotebook('a'), local);
    const b = openSession(makeNotebook('b'), local);

    const entry = (id: number, input: string, value: string) => ({
      id, input, output: { type: 'text' as const, content: value, timestamp: 0 },
    });

    a.consoleEntries.set([entry(1, 'a', '3')]);
    a.consoleHistory.set(['a']);
    b.consoleEntries.set([entry(2, 'a', '6')]);
    b.consoleHistory.set(['a']);

    const entries = sessionStore<any[]>((s) => s.consoleEntries, []);
    const history = sessionStore<string[]>((s) => s.consoleHistory, []);

    setActive(a.id);
    expect(get(entries).map((e) => e.output.content)).toEqual(['3']);

    setActive(b.id);
    expect(get(entries).map((e) => e.output.content)).toEqual(['6']);
    expect(get(history)).toEqual(['a']);

    // Closing a notebook takes its transcript with it.
    closeSession(b.id);
    expect(get(entries).map((e) => e.output.content)).toEqual(['3']);
  });
});
