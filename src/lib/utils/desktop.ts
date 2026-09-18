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
 * The native folder picker is on the other side of the bridge, and so is the
 * restart that follows: a companion owns one root, and the tabs, caches and
 * socket are all keyed to it.
 */
export async function openFolder(): Promise<void> {
  await bridge()?.('open_folder');
}
