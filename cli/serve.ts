/**
 * `note serve` - local companion for tangent/note.
 *
 * The browser sandbox cannot reach a git-tracked file on disk (Firefox has no
 * File System Access API by design), so a small local process owns the file
 * instead. It serves the app from localhost, so the page is same-origin with
 * this server and works identically in every browser, then keeps the notebook
 * file and the open tab in sync over a WebSocket:
 *
 *   disk -> app : the file is watched, so edits from an editor or a coding
 *                 agent are pushed to the tab.
 *   app -> disk : saving in the app writes the same file in place, so git sees
 *                 an ordinary diff instead of a fresh download.
 *
 * Usage:
 *   deno run -A cli/serve.ts <notebook.js> [--port 4321] [--dist dist]
 */

const DEFAULT_PORT = 4321;
const SYNC_PATH = "/__sync";
// A write lands as one or more fs events; coalesce them before reading.
const WATCH_DEBOUNCE_MS = 120;

interface Args {
  file: string;
  port: number;
  dist: string;
}

function parseArgs(argv: string[]): Args {
  let file = "";
  let port = DEFAULT_PORT;
  let dist = "dist";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") port = Number(argv[++i]);
    else if (a === "--dist") dist = argv[++i];
    else if (!a.startsWith("-")) file = a;
  }
  if (!file) {
    console.error("Usage: note serve <notebook.js> [--port N] [--dist DIR]");
    Deno.exit(2);
  }
  return { file, port, dist };
}

/** Absolute, normalized path, so watcher events can be matched to the file. */
function resolvePath(path: string): string {
  return path.startsWith("/") ? path : `${Deno.cwd()}/${path}`.replace(/\/\.\//g, "/");
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

export function main(args: Args) {
  const { file, port, dist } = args;

  // Content this server wrote itself. The watcher fires for our own writes too,
  // and re-broadcasting them would bounce the tab back to what it just sent.
  let lastWrittenHash = "";
  const sockets = new Set<WebSocket>();

  const readFile = () => Deno.readTextFileSync(file);

  const broadcast = (msg: unknown) => {
    const payload = JSON.stringify(msg);
    for (const s of sockets) {
      if (s.readyState === WebSocket.OPEN) s.send(payload);
    }
  };

  /** Write via temp + rename so a reader never sees a half-written file. */
  const writeFile = (content: string) => {
    const tmp = `${file}.tangent-tmp`;
    Deno.writeTextFileSync(tmp, content);
    Deno.renameSync(tmp, file);
    lastWrittenHash = hashContent(content);
  };

  Deno.serve({ port, hostname: "127.0.0.1", onListen: () => {
    console.log(`tangent/note`);
    console.log(`  notebook  ${file}`);
    console.log(`  open      http://localhost:${port}`);
  } }, async (req) => {
    const url = new URL(req.url);

    if (url.pathname === SYNC_PATH) {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onopen = () => {
        sockets.add(socket);
        const content = readFile();
        socket.send(JSON.stringify({ type: "hello", file, content, hash: hashContent(content) }));
      };
      socket.onmessage = (event) => {
        let msg: any;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type !== "save" || typeof msg.content !== "string") return;
        // Refuse to clobber an edit that landed on disk since this tab loaded.
        const onDisk = readFile();
        const diskHash = hashContent(onDisk);
        if (msg.baseHash && msg.baseHash !== diskHash && !msg.force) {
          socket.send(JSON.stringify({ type: "conflict", content: onDisk, hash: diskHash }));
          return;
        }
        writeFile(msg.content);
        socket.send(JSON.stringify({ type: "saved", hash: lastWrittenHash }));
        console.log(`  saved     ${new Date().toLocaleTimeString()}`);
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

  // Watch the notebook and push external edits to the open tab.
  //
  // Watch the DIRECTORY, not the file: saving replaces the file via rename, and
  // an inode-level watch on the old path stops firing after the first save (so
  // later external edits would be missed). Directory events survive that, and
  // are filtered back down to this file.
  (async () => {
    const absolute = resolvePath(file);
    const dir = absolute.slice(0, absolute.lastIndexOf("/")) || ".";
    // NON-recursive: the notebook usually sits at a project root next to
    // node_modules, and a recursive watch would descend into all of it and
    // exhaust the OS inotify limit. We only need events for entries directly in
    // `dir`, which includes our file (and its temp -> rename on save).
    const watcher = Deno.watchFs(dir, { recursive: false });
    let timer: number | undefined;
    for await (const event of watcher) {
      if (!event.paths.some((p) => resolvePath(p) === absolute)) continue;
      clearTimeout(timer);
      timer = setTimeout(() => {
        let content: string;
        try { content = readFile(); } catch { return; }
        const hash = hashContent(content);
        if (hash === lastWrittenHash) return; // our own write echoing back
        console.log(`  reloaded  ${new Date().toLocaleTimeString()}`);
        broadcast({ type: "disk-change", content, hash });
      }, WATCH_DEBOUNCE_MS);
    }
  })();
}

if (import.meta.main) main(parseArgs(Deno.args));
