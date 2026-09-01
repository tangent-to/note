/**
 * Main-thread executors, one per open notebook.
 *
 * In main-thread kernel mode the notebook and the console REPL must evaluate
 * against the SAME scope, and two notebooks must not share one: opening a
 * second notebook used to inherit the first one's variables, so a cell that
 * referenced a name it never defined found the other notebook's value instead
 * of failing.
 *
 * There is still only one `window.__tangent_scope`, because that is what cells
 * are compiled against. The active notebook's executor claims it (see
 * `JavaScriptExecutor.activate`), which is safe even mid-run: a `with` block
 * captures its scope object on entry, so a suspended cell keeps its own.
 *
 * `mainExecutor` is a proxy onto whichever executor is active, so every call
 * site reads the same as it did when there was one.
 */
import { JavaScriptExecutor } from './jsExecutor';

const executors = new Map<string, JavaScriptExecutor>();
let activeId: string | null = null;

export function executorFor(id: string): JavaScriptExecutor {
  let executor = executors.get(id);
  if (!executor) {
    executor = new JavaScriptExecutor();
    executors.set(id, executor);
  }
  return executor;
}

/** Make `id`'s executor the one `window.__tangent_scope` and `nb` refer to. */
export function setActiveExecutor(id: string | null): void {
  activeId = id;
  if (id) executorFor(id).activate();
}

export function disposeExecutor(id: string): void {
  executors.delete(id);
  if (activeId === id) activeId = null;
}

/**
 * The active notebook's executor. Reading a property re-resolves it, so a call
 * always lands on whichever notebook is on screen.
 */
export const mainExecutor: JavaScriptExecutor = new Proxy({} as JavaScriptExecutor, {
  get(_target, prop, receiver) {
    // Before the first notebook opens there is nothing to run against; a
    // throwaway executor keeps callers from having to null-check.
    const executor = executorFor(activeId ?? '__unbound__');
    const value = Reflect.get(executor, prop, receiver);
    return typeof value === 'function' ? value.bind(executor) : value;
  },
});
