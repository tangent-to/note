/**
 * Client for the `note serve` companion (see cli/serve.ts).
 *
 * When the app is served by the CLI, the notebook file on disk is the single
 * source of truth: saving writes that file in place (so git sees a normal
 * diff), and an edit made outside the app (an editor, a coding agent) is pushed
 * back to the tab. When the app is served from anywhere else the socket simply
 * never connects and everything falls back to download-based saving.
 */
import { writable } from 'svelte/store';

export type SyncStatus = 'offline' | 'connecting' | 'connected';

export const syncStatus = writable<SyncStatus>('offline');
/** Path of the file the companion owns, for display. */
export const syncFile = writable<string | null>(null);

type Handlers = {
  /** Initial file content, and any later external edit. */
  onLoad: (content: string, reason: 'hello' | 'disk-change') => void;
  /** Disk moved on since this tab loaded; the app decides what to do. */
  onConflict: (diskContent: string) => void;
  onSaved: () => void;
};

let socket: WebSocket | null = null;
let handlers: Handlers | null = null;
// Hash of the content this tab last loaded or saved, so the companion can tell
// whether we are about to overwrite someone else's edit.
let baseHash: string | null = null;

/**
 * Try to connect to a companion on this origin. Resolves to true if one
 * answered. Safe to call when none is running: the socket just fails.
 */
export function connectSync(h: Handlers): Promise<boolean> {
  handlers = h;
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${proto}//${location.host}/__sync`);
    } catch {
      syncStatus.set('offline');
      return done(false);
    }

    syncStatus.set('connecting');
    // No companion on this origin: give up quickly and stay in download mode.
    const timeout = setTimeout(() => {
      if (socket && socket.readyState !== WebSocket.OPEN) socket.close();
      syncStatus.set('offline');
      done(false);
    }, 1500);

    socket.onmessage = (event) => {
      let msg: any;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'hello') {
        clearTimeout(timeout);
        syncStatus.set('connected');
        syncFile.set(msg.file ?? null);
        baseHash = msg.hash ?? null;
        handlers?.onLoad(msg.content, 'hello');
        return done(true);
      }
      if (msg.type === 'disk-change') {
        baseHash = msg.hash ?? null;
        handlers?.onLoad(msg.content, 'disk-change');
        return;
      }
      if (msg.type === 'saved') {
        baseHash = msg.hash ?? null;
        handlers?.onSaved();
        return;
      }
      if (msg.type === 'conflict') {
        handlers?.onConflict(msg.content);
        return;
      }
    };

    socket.onerror = () => {
      clearTimeout(timeout);
      syncStatus.set('offline');
      done(false);
    };
    socket.onclose = () => {
      clearTimeout(timeout);
      syncStatus.set('offline');
      syncFile.set(null);
      done(false);
    };
  });
}

export function isSyncConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN;
}

/**
 * Write the notebook through the companion. Returns false when no companion is
 * connected, so the caller can fall back to a download.
 * `force` skips the on-disk conflict check (used after the user confirms).
 */
export function saveThroughSync(content: string, force = false): boolean {
  if (!isSyncConnected()) return false;
  socket!.send(JSON.stringify({ type: 'save', content, baseHash, force }));
  return true;
}
