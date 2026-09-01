/**
 * Client for the `note serve` companion (see cli/serve.ts).
 *
 * When the app is served by the CLI, notebook files on disk are the single
 * source of truth: saving writes that file in place (so git sees a normal
 * diff), and an edit made outside the app (an editor, a coding agent) is
 * pushed back to the tab holding it. When the app is served from anywhere else
 * the socket simply never connects and everything falls back to
 * download-based saving.
 *
 * Every message is keyed by a path relative to the companion's root, so one
 * companion can own a directory of notebooks and several tabs can each be
 * linked to their own file. `baseHash` is tracked per path for the same
 * reason: the conflict check is about one file, not about the connection.
 */
import { writable } from 'svelte/store';

export type SyncStatus = 'offline' | 'connecting' | 'connected';

export interface SyncFile {
  /** Relative to the companion's root; the key for every message about it. */
  path: string;
  name: string;
  /** The notebook's id, read from the file's frontmatter. Null when it has
   *  none — an older file, or one written by hand. */
  id: string | null;
}

export const syncStatus = writable<SyncStatus>('offline');
/** Absolute path of the directory the companion owns, for display. */
export const syncRoot = writable<string | null>(null);
/** Notebook files the companion is offering. */
export const syncFiles = writable<SyncFile[]>([]);

/** Why a file's content arrived. */
export type LoadReason = 'hello' | 'disk-change' | 'open';

type Handlers = {
  /** A file's content: the one to open on connect, a reply to open(), or an
   *  external edit. */
  onLoad: (path: string, content: string, reason: LoadReason) => void;
  /** Disk moved on since this tab loaded that file; the app decides what to do. */
  onConflict: (path: string, diskContent: string) => void;
  onSaved: (path: string) => void;
  /** The companion's file list changed. */
  onFiles?: (files: SyncFile[]) => void;
  /** A path the companion would not touch, or a file that has gone. */
  onRefused?: (path: string | null, message: string) => void;
};

let socket: WebSocket | null = null;
let handlers: Handlers | null = null;
// Hash of the content this tab last loaded or saved, per path, so the
// companion can tell whether we are about to overwrite someone else's edit.
const baseHashes = new Map<string, string>();

export interface SyncHello {
  root: string | null;
  files: SyncFile[];
  /** The file a single-file invocation was pointed at, if any. */
  initial: string | null;
}

/**
 * Try to connect to a companion on this origin. Resolves to the handshake when
 * one answered, or null when none did. Safe to call when none is running: the
 * socket just fails.
 */
export function connectSync(h: Handlers): Promise<SyncHello | null> {
  handlers = h;
  return new Promise((resolve) => {
    let settled = false;
    const done = (hello: SyncHello | null) => {
      if (settled) return;
      settled = true;
      resolve(hello);
    };

    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${proto}//${location.host}/__sync`);
    } catch {
      syncStatus.set('offline');
      return done(null);
    }

    syncStatus.set('connecting');
    // No companion on this origin: give up quickly and stay in download mode.
    const timeout = setTimeout(() => {
      if (socket && socket.readyState !== WebSocket.OPEN) socket.close();
      syncStatus.set('offline');
      done(null);
    }, 1500);

    socket.onmessage = (event) => {
      let msg: any;
      try { msg = JSON.parse(event.data); } catch { return; }

      switch (msg.type) {
        case 'hello': {
          clearTimeout(timeout);
          syncStatus.set('connected');
          const files: SyncFile[] = Array.isArray(msg.files) ? msg.files : [];
          syncRoot.set(msg.root ?? null);
          syncFiles.set(files);
          return done({ root: msg.root ?? null, files, initial: msg.initial ?? null });
        }
        case 'file': {
          baseHashes.set(msg.path, msg.hash ?? '');
          handlers?.onLoad(msg.path, msg.content, 'open');
          return;
        }
        case 'disk-change': {
          baseHashes.set(msg.path, msg.hash ?? '');
          handlers?.onLoad(msg.path, msg.content, 'disk-change');
          return;
        }
        case 'saved': {
          baseHashes.set(msg.path, msg.hash ?? '');
          handlers?.onSaved(msg.path);
          return;
        }
        case 'conflict': {
          handlers?.onConflict(msg.path, msg.content);
          return;
        }
        case 'files': {
          const files: SyncFile[] = Array.isArray(msg.files) ? msg.files : [];
          syncFiles.set(files);
          handlers?.onFiles?.(files);
          return;
        }
        case 'refused':
        case 'missing': {
          handlers?.onRefused?.(
            msg.path ?? null,
            msg.message ?? 'That notebook is no longer on disk.'
          );
          return;
        }
      }
    };

    socket.onerror = () => {
      clearTimeout(timeout);
      syncStatus.set('offline');
      done(null);
    };
    socket.onclose = () => {
      clearTimeout(timeout);
      syncStatus.set('offline');
      syncRoot.set(null);
      syncFiles.set([]);
      baseHashes.clear();
      done(null);
    };
  });
}

export function isSyncConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN;
}

/** Ask the companion for a file's content. It arrives through onLoad. */
export function openSyncFile(path: string): boolean {
  if (!isSyncConnected()) return false;
  socket!.send(JSON.stringify({ type: 'open', path }));
  return true;
}

/**
 * Write a notebook through the companion. Returns false when none is
 * connected, so the caller can fall back to a download.
 * `force` skips the on-disk conflict check (used after the user confirms).
 */
export function saveThroughSync(path: string, content: string, force = false): boolean {
  if (!isSyncConnected()) return false;
  socket!.send(JSON.stringify({
    type: 'save',
    path,
    content,
    baseHash: baseHashes.get(path) ?? null,
    force,
  }));
  return true;
}

/** Record the hash a tab is working from, e.g. after loading a file itself. */
export function noteBaseHash(path: string, hash: string): void {
  baseHashes.set(path, hash);
}
