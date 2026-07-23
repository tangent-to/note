/**
 * Shared main-thread JavaScript executor.
 *
 * In main-thread kernel mode the notebook and the console REPL must evaluate
 * against the SAME scope. Each `new JavaScriptExecutor()` overwrites
 * `window.__tangent_scope` with a fresh object (see its constructor), so a
 * second instance would silently wipe the notebook's variables. Sharing a
 * single instance keeps one scope for cells and the console alike.
 *
 * (Worker mode has no such issue: the worker owns its own single executor.)
 */
import { JavaScriptExecutor } from './jsExecutor';

export const mainExecutor = new JavaScriptExecutor();
