/**
 * Console REPL state, per notebook.
 *
 * The console evaluates expressions in the SAME kernel scope as the notebook
 * cells (RStudio style): defining `const y = ...` here makes `y` visible to
 * cells, and reading `nb.x` sees a cell's value. It routes through whichever
 * kernel is active, so scope is shared in both worker and main-thread modes.
 *
 * Since each notebook now has its own kernel and its own scope, the transcript
 * follows the notebook rather than the app. One shared transcript across tabs
 * read as a single conversation with a single scope while actually addressing
 * several — `a` typed twice, answering 3 and then 6, with nothing on screen to
 * say why. The recall history is per notebook for the same reason: those are
 * the commands you typed against *that* scope.
 */
import { get } from 'svelte/store';
import type { CellOutput, ConsoleEntry } from '../types/notebook';
import { kernelMode } from './notebook';
import { current, sessionStore } from './sessions';
import { kernel } from '../utils/kernelClient';
import { mainExecutor } from '../utils/mainExecutor';

export { navigateHistory } from '../utils/consoleHistory';
export type { ConsoleEntry };

export const consoleEntries = sessionStore<ConsoleEntry[]>((s) => s.consoleEntries, []);
// Submitted inputs, oldest first, for up/down recall.
export const consoleInputHistory = sessionStore<string[]>((s) => s.consoleHistory, []);

// Ids only have to be unique within one transcript, but a single counter keeps
// them unique across all of them too, so a keyed {#each} can never collide
// when the reader switches tabs.
let nextId = 1;

/** Evaluate console input in the active kernel, sharing the notebook scope. */
export async function evalInConsole(code: string): Promise<CellOutput> {
  return get(kernelMode) === 'worker'
    ? kernel.execute(code)
    : mainExecutor.executeCode(code);
}

export function pushConsoleEntry(input: string, output: CellOutput): void {
  const session = current();
  if (!session) return;
  session.consoleEntries.update((es) => [...es, { id: nextId++, input, output }]);
  // Collapse an immediately repeated command, like a shell history.
  session.consoleHistory.update((h) => (h[h.length - 1] === input ? h : [...h, input]));
}

export function clearConsole(): void {
  current()?.consoleEntries.set([]);
}
