/**
 * The desktop app, seen from the page.
 *
 * The page is the one a browser loads — the desktop app serves it from the same
 * companion over http — so nothing about the document says where it is running.
 * What does is Tauri's own bridge, injected into the window it opens. Every
 * desktop-only affordance hides behind this, and the browser build carries a
 * few lines rather than a dependency.
 */

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

function bridge(): Invoke | null {
  const tauri = (globalThis as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__;
  return typeof tauri?.core?.invoke === 'function' ? tauri.core.invoke : null;
}

/** Are we inside the desktop window rather than a browser tab? */
export function isDesktopApp(): boolean {
  return bridge() !== null;
}

/**
 * Open another folder of notebooks.
 *
 * Two ways in, because the page is not always in the desktop window: the app
 * can be opened in a browser of your choosing, pointed at the same companion.
 * Through the bridge when there is one, and otherwise through the companion,
 * which passes the request up to whoever started it — the only process here
 * with a window to put a native picker in. Either way the folder is remembered
 * and the app comes back on it: a companion owns one root, and the tabs, caches
 * and socket are all keyed to it.
 */
export async function openFolder(): Promise<void> {
  const invoke = bridge();
  if (invoke) {
    await invoke('open_folder');
    return;
  }
  await fetch('/__open-folder', { method: 'POST' });
}
