/**
 * Console REPL state.
 *
 * The console evaluates expressions in the SAME kernel scope as the notebook
 * cells (RStudio style): defining `const y = ...` here makes `y` visible to
 * cells, and reading `nb.x` sees a cell's value. It routes through whichever
 * kernel is active, so scope is shared in both worker and main-thread modes.
 */
import { writable, get } from 'svelte/store';
import type { CellOutput } from '../types/notebook';
import { kernelMode } from './notebook';
import { kernel } from '../utils/kernelClient';
import { mainExecutor } from '../utils/mainExecutor';

export { navigateHistory } from '../utils/consoleHistory';

export interface ConsoleEntry {
  id: number;
  input: string;
  output: CellOutput;
}

export const consoleEntries = writable<ConsoleEntry[]>([]);
// Submitted inputs, oldest first, for up/down recall.
export const consoleInputHistory = writable<string[]>([]);

let nextId = 1;

/** Evaluate console input in the active kernel, sharing the notebook scope. */
export async function evalInConsole(code: string): Promise<CellOutput> {
  return get(kernelMode) === 'worker'
    ? kernel.execute(code)
    : mainExecutor.executeCode(code);
}

export function pushConsoleEntry(input: string, output: CellOutput): void {
  consoleEntries.update((es) => [...es, { id: nextId++, input, output }]);
  // Collapse an immediately repeated command, like a shell history.
  consoleInputHistory.update((h) => (h[h.length - 1] === input ? h : [...h, input]));
}

export function clearConsole(): void {
  consoleEntries.set([]);
}
