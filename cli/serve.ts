/**
 * `note serve` - local companion for tangent/note.
 *
 * The browser sandbox cannot reach a git-tracked file on disk (Firefox has no
 * File System Access API by design), so a small local process owns the files
 * instead. It serves the app from localhost, so the page is same-origin with
 * this server and works identically in every browser, then keeps notebook
 * files and the open tabs in sync over a WebSocket:
 *
 *   disk -> app : files are watched, so edits from an editor or a coding
 *                 agent are pushed to the tab holding them.
 *   app -> disk : saving in the app writes that same file in place, so git
 *                 sees an ordinary diff instead of a fresh download.
 *
 * Every message is keyed by a path *relative to a root*, so one companion can
 * own a whole directory of notebooks rather than a single file. Which paths it
 * will touch is decided by notebookPaths.resolveWithin and nothing else: the
 * browser names files here, and any page can be pointed at localhost.
 *
 * Usage:
 *   deno run -A cli/serve.ts <notebook.js|directory> [more...] [--port 4321] [--dist dist]
 */
import {
  MAX_DEPTH,
  displayName,
  frontmatterId,
  frontmatterTitle,
  looksLikeNotebook,
  normalizeRoot,
  relativeTo,
  resolveWithin,
  shouldSkipDir,
} from "./notebookPaths.ts";

const DEFAULT_PORT = 4321;
const SYNC_PATH = "/__sync";
// A write lands as one or more fs events; coalesce them before reading.
const WATCH_DEBOUNCE_MS = 120;
// Enough to see the frontmatter fence and its title without reading a large
// file. The whole block is a handful of short comment lines.
const SNIFF_BYTES = 512;

interface Args {
  targets: string[];
  port: number;
  dist: string;
}

export function parseArgs(argv: string[]): Args {
  const targets: string[] = [];
  let port = DEFAULT_PORT;
  let dist = "dist";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") port = Number(argv[++i]);
    else if (a === "--dist") dist = argv[++i];
    else if (!a.startsWith("-")) targets.push(a);
  }
  return { targets, port, dist };
}

/** djb2, matching the app's cheap content-change hash. */
export function hashContent(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return String(hash >>> 0);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot >= 0 && MIME[path.slice(dot)]) || "application/octet-stream";
}

interface NotebookFile {
  /** Relative to the root, and the key for every message about this file. */
  path: string;
  /** The notebook's own title, so the app names it the way it names all the
   *  others. Falls back to the filename when the frontmatter has none. */
  name: string;
  /** The notebook's id, so the app can tell this file and a copy it already
   *  holds are the same notebook without opening it. */
  id: string | null;
}

/**
 * What the companion offers, and where it looks.
 *
 * A single file argument keeps its directory as the root, so the old
 * single-file invocation still works and simply offers one notebook.
 */
function resolveRoot(targets: string[], cwd: string): { root: string; initial: string | null } {
  if (targets.length === 0) {
    console.error(
      "Usage: note serve <notebook.js|directory> [more...] [--port N] [--dist DIR]",
    );
    Deno.exit(2);
  }

  const first = normalizeRoot(targets[0], cwd);
  let isDir = false;
  try {
    isDir = Deno.statSync(first).isDirectory;
  } catch {
    console.error(`Cannot read "${targets[0]}".`);
    Deno.exit(2);
  }

  if (isDir) return { root: first, initial: null };
  // A file: its directory becomes the root, and it is what the tab opens on.
  const root = first.slice(0, first.lastIndexOf("/")) || "/";
  return { root, initial: relativeTo(root, first) };
}

/** Walk `root` for notebooks, shallowly, skipping the heavy and the hidden. */
function discover(root: string): NotebookFile[] {
  const found: NotebookFile[] = [];

  const walk = (dir: string, depth: number) => {
    let entries: Iterable<Deno.DirEntry>;
    try {
      entries = Deno.readDirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        if (depth >= MAX_DEPTH || shouldSkipDir(entry.name)) continue;
        walk(absolute, depth + 1);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      let head: string;
      try {
        const handle = Deno.openSync(absolute, { read: true });
        const buffer = new Uint8Array(SNIFF_BYTES);
        const read = handle.readSync(buffer) ?? 0;
        handle.close();
        head = new TextDecoder().decode(buffer.subarray(0, read));
      } catch {
        continue;
      }
      if (!looksLikeNotebook(head)) continue;
      const path = relativeTo(root, absolute);
      if (path) {
        found.push({
          path,
          name: frontmatterTitle(head) ?? displayName(path),
          id: frontmatterId(head),
        });
      }
    }
  };

  walk(root, 0);
  found.sort((a, b) => a.path.localeCompare(b.path));
  return found;
}

export function main(args: Args) {
  const { targets, port, dist } = args;
  const { root, initial } = resolveRoot(targets, Deno.cwd());

  let files = discover(root);
  // Content this server wrote itself, per path. The watcher fires for our own
  // writes too, and re-broadcasting them would bounce a tab back to what it
  // just sent.
  const lastWritten = new Map<string, string>();
  const sockets = new Set<WebSocket>();

  const broadcast = (msg: unknown) => {
    const payload = JSON.stringify(msg);
    for (const s of sockets) {
      if (s.readyState === WebSocket.OPEN) s.send(payload);
    }
  };

  /** Write via temp + rename so a reader never sees a half-written file. */
  const writeFile = (absolute: string, path: string, content: string) => {
    const tmp = `${absolute}.tangent-tmp`;
    Deno.writeTextFileSync(tmp, content);
    Deno.renameSync(tmp, absolute);
    lastWritten.set(path, hashContent(content));
  };

  const rescan = () => {
    const next = discover(root);
    const changed =
      next.length !== files.length ||
      next.some((f, i) =>
        f.path !== files[i].path || f.name !== files[i].name || f.id !== files[i].id
      );
    if (!changed) return;
    files = next;
    broadcast({ type: "files", files });
  };

  Deno.serve({ port, hostname: "127.0.0.1", onListen: () => {
    console.log(`tangent/note`);
    console.log(`  root      ${root}`);
    console.log(`  notebooks ${files.length}${initial ? ` (opening ${initial})` : ""}`);
    console.log(`  open      http://localhost:${port}`);
  } }, async (req) => {
    const url = new URL(req.url);

    if (url.pathname === SYNC_PATH) {
      const { socket, response } = Deno.upgradeWebSocket(req);

      socket.onopen = () => {
        sockets.add(socket);
        rescan();
        socket.send(JSON.stringify({ type: "hello", root, files, initial }));
      };

      socket.onmessage = (event) => {
        let msg: any;
        try { msg = JSON.parse(event.data); } catch { return; }

        const path = typeof msg.path === "string" ? msg.path : initial;
        if (!path) return;
        // The only gate on what this process reads and writes.
        const absolute = resolveWithin(root, path);
        if (!absolute) {
          socket.send(JSON.stringify({
            type: "refused",
            path: msg.path ?? null,
            message: "That path is outside the served directory.",
          }));
          return;
        }

        if (msg.type === "open") {
          let content: string;
          try {
            content = Deno.readTextFileSync(absolute);
          } catch {
            socket.send(JSON.stringify({ type: "missing", path }));
            return;
          }
          socket.send(JSON.stringify({
            type: "file", path, content, hash: hashContent(content),
          }));
          return;
        }

        if (msg.type === "save" && typeof msg.content === "string") {
          // Refuse to clobber an edit that landed on disk since this tab
          // loaded — unless the tab has already been told and asks again.
          let onDisk: string | null = null;
          try { onDisk = Deno.readTextFileSync(absolute); } catch { onDisk = null; }
          if (onDisk !== null) {
            const diskHash = hashContent(onDisk);
            if (msg.baseHash && msg.baseHash !== diskHash && !msg.force) {
              socket.send(JSON.stringify({
                type: "conflict", path, content: onDisk, hash: diskHash,
              }));
              return;
            }
          }
          writeFile(absolute, path, msg.content);
          socket.send(JSON.stringify({
            type: "saved", path, hash: lastWritten.get(path),
          }));
          console.log(`  saved     ${path}  ${new Date().toLocaleTimeString()}`);
          // A save can create a notebook the list did not have.
          rescan();
        }
      };

      socket.onclose = () => sockets.delete(socket);
      socket.onerror = () => sockets.delete(socket);
      return response;
    }

    // Static app. Unknown paths fall back to index.html (single-page app).
    let path = decodeURIComponent(url.pathname);
    if (path === "/" || !path.includes(".")) path = "/index.html";
    try {
      const body = await Deno.readFile(`${dist}${path}`);
      return new Response(body, { headers: { "content-type": contentType(path) } });
    } catch {
      try {
        const body = await Deno.readFile(`${dist}/index.html`);
        return new Response(body, { headers: { "content-type": MIME[".html"] } });
      } catch {
        return new Response(
          `Built app not found in "${dist}". Run \`npm run build\` first, or pass --dist.`,
          { status: 500 },
        );
      }
    }
  });

  // Watch for external edits and push them to whoever holds that file.
  //
  // Watch DIRECTORIES, not files: saving replaces a file via rename, and an
  // inode-level watch on the old path stops firing after the first save, so
  // later external edits would be missed. And non-recursively per directory
  // rather than recursively from the root: notebooks often sit next to
  // node_modules, and a recursive watch would descend into all of it and
  // exhaust the OS inotify limit. Directories are taken from the notebooks
  // actually discovered, so the count stays bounded by the work, not the tree.
  (async () => {
    const dirs = new Set<string>([root]);
    for (const file of files) {
      const absolute = resolveWithin(root, file.path);
      if (!absolute) continue;
      dirs.add(absolute.slice(0, absolute.lastIndexOf("/")));
    }

    let watcher: Deno.FsWatcher;
    try {
      watcher = Deno.watchFs([...dirs], { recursive: false });
    } catch (error) {
      console.error("  watch     unavailable:", error);
      return;
    }

    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    for await (const event of watcher) {
      for (const raw of event.paths) {
        if (!raw.endsWith(".js")) continue;
        const path = relativeTo(root, raw);
        if (!path) continue;
        clearTimeout(timers.get(path));
        timers.set(path, setTimeout(() => {
          timers.delete(path);
          let content: string;
          try {
            content = Deno.readTextFileSync(raw);
          } catch {
            rescan(); // deleted or moved
            return;
          }
          const hash = hashContent(content);
          if (hash === lastWritten.get(path)) return; // our own write echoing back
          console.log(`  reloaded  ${path}  ${new Date().toLocaleTimeString()}`);
          broadcast({ type: "disk-change", path, content, hash });
          rescan(); // a new file may have appeared
        }, WATCH_DEBOUNCE_MS));
      }
    }
  })();
}

if (import.meta.main) main(parseArgs(Deno.args));
