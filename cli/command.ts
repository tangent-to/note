/**
 * The command line: what it accepts, what it says, and where it goes.
 *
 * Kept apart from serve.ts and install.ts, which both need Deno at module
 * scope and so cannot be imported by the test runner: that is the same
 * arrangement notebookPaths.ts is in, and for the same reason. Everything here
 * is a function of its arguments, which is the only reason it can be tested at
 * all.
 *
 * One more reason it is a file of its own: a test that imports a Deno module
 * drags it into the app's type check, where `Deno` and `import.meta.main` do
 * not exist and svelte-check says so. The app checks `src/`, and a test under
 * `src/` is part of that, so anything it reaches is checked with the app's
 * types rather than Deno's.
 */

/** What the binary is called, and what an install puts on PATH. */
export const NAME = "note";

/**
 * What the binary reports, and what install.ts prints.
 *
 * Kept next to the arguments rather than read from a manifest, because the
 * binary is the thing being asked and the manifests are not compiled into it.
 * A test holds this to package.json's version, so the two cannot drift.
 */
export const VERSION = "0.1.1";

/** The port the companion listens on unless told otherwise. */
export const DEFAULT_PORT = 4321;

export interface Args {
  targets: string[];
  port: number;
  dist: string;
  /** `note --help`: say what this is, and serve nothing. */
  help: boolean;
  /** `note --version`: say which build this is, and serve nothing. */
  version: boolean;
}

/** The one command, spelled the way an installed binary is invoked. */
export function help(): string {
  return `note ${VERSION}: the tangent/note companion.

  note serve <notebook.js|notebook.html|directory> [more...] [options]

Serves the app at http://localhost:${DEFAULT_PORT} and keeps the notebooks under
one root in step with the open tabs, both ways: cells read and write files
beside the notebook, saving lands in place so git sees an ordinary diff, and an
edit made in your editor turns up in the tab holding it.

Options:
  --port N     the port to listen on (default ${DEFAULT_PORT})
  --dist DIR   the built app to serve, when it is not the one this file finds
  --help       this text
  --version    which build this is

Install it with \`deno task install:note\`, which puts a \`note\` binary on your
PATH carrying its own copy of the app. From a clone, \`deno task build\` once and
then \`deno task serve <directory>\` runs it from here.`;
}

export function parseArgs(argv: string[], dist: string): Args {
  const targets: string[] = [];
  let port = DEFAULT_PORT;
  let help = false;
  let version = false;
  // `note serve ...` and a bare `note ...` are the same command. The subcommand
  // is what the installed binary is called with, and it is where any second
  // command would go; before it existed every invocation was a bare target.
  const rest = argv[0] === "serve" ? argv.slice(1) : argv;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--port") port = Number(rest[++i]);
    else if (a === "--dist") dist = rest[++i];
    else if (a === "--help" || a === "-h") help = true;
    else if (a === "--version" || a === "-v") version = true;
    else if (!a.startsWith("-")) targets.push(a);
  }
  return { targets, port, dist, help, version };
}

/** What the install recorded about the build it carried. */
export interface BuildInfo {
  /** The source it was built from, in full, so it can be pasted anywhere. */
  revision: string;
  /** When the install made it: what tells an update from a reinstall. */
  installed: string;
}

/** Whether an executable of this name is the runtime rather than a built binary. */
export function isRuntime(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "deno" || lower === "deno.exe";
}

/**
 * What `note --version` says.
 *
 * The version alone cannot answer "did that update land?", because it only
 * changes when package.json does. The build does, so the build is named here.
 */
export function versionText(info: BuildInfo | null): string {
  const built = info
    ? `${info.installed}  ${info.revision.slice(0, 7)}`
    : "unknown, not an installed build";
  return `note ${VERSION}\n  built    ${built}`;
}

/**
 * Where `deno install -g` puts executables.
 *
 * Deno resolves its install root from the environment and the home directory,
 * and appends `bin`; taking the same two steps means the binary lands beside
 * the ones `deno install` already made, and the PATH advice is the advice Deno
 * itself would give. `USERPROFILE` is the home on Windows, where `HOME` is
 * often not set at all.
 */
export function installDir(env: Record<string, string | undefined>): string {
  const root = env.DENO_INSTALL_ROOT || `${env.HOME || env.USERPROFILE || "."}/.deno`;
  return `${root}/bin`;
}

/** The compiled file's own name, which Windows needs an extension for. */
export function binaryName(os: string): string {
  return os === "windows" ? `${NAME}.exe` : NAME;
}
