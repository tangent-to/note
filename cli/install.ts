#!/usr/bin/env -S deno run -A
/**
 * `deno task install:note` - a `note` binary on PATH, carrying the app.
 *
 * Deno can install a script, but the app cannot come with it: an install keeps
 * the module graph, and `dist/` is not in that graph. `deno compile --include`
 * can carry it, and that is the only bundler Deno has. So the install is two
 * steps and this file is the one that knows them: check there is an app to
 * carry, compile the companion with it inside, and put the result where Deno
 * puts its own binaries, so a bare `note` works from any directory.
 *
 * Usage:
 *   deno run -A cli/install.ts [--root DIR]
 *
 * `--root` means what it means to `deno install`: a root, with bin inside it.
 */
import { NAME, VERSION, binaryName, help, installDir } from "./command.ts";
import { defaultDist, filePath } from "./serve.ts";

/**
 * The one fact a binary cannot work out for itself: which source it was built
 * from, and when, which is what `note --version` reads back.
 *
 * It lives beside `dist` rather than inside it, because the app in `dist` is a
 * build product that CI owns and this is a note about the install. The name is
 * also the name the binary looks it up by, since an embedded file is found at
 * the path it was given.
 */
const STAMP = "note-build.json";

/**
 * The paths the compile is given, relative to the repository.
 *
 * They have to be relative and in this shape: a compiled binary looks up its
 * embedded files by the exact path they were given, and serve.ts finds the app
 * by resolving `../dist` against itself. From the repository root those two
 * agree on `dist`, which is the whole arrangement. Passing an absolute path
 * here would compile in a key the binary never asks for.
 */
function compileArgs(target: string): string[] {
  return [
    "compile",
    // The companion needs to read and write a folder, watch it, and listen.
    "--allow-all",
    "--include",
    "dist",
    "--include",
    STAMP,
    "-o",
    target,
    "cli/serve.ts",
  ];
}

/** The commit this is being built from, or "unknown" outside a checkout. */
async function gitRevision(repo: string): Promise<string> {
  try {
    const { success, stdout } = await new Deno.Command("git", {
      args: ["rev-parse", "HEAD"],
      cwd: repo,
      stdout: "piped",
      stderr: "null",
    }).output();
    const head = new TextDecoder().decode(stdout).trim();
    return success && head ? head : "unknown";
  } catch {
    // A tarball with no git in it, or no git on this machine. The install is
    // still worth having; it just cannot say what it was made from.
    return "unknown";
  }
}

export async function install(root?: string): Promise<void> {
  const repo = filePath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const dist = defaultDist();

  // The compile embeds `dist` beside this file, and that is where serve.ts
  // looks. If those two are not the same directory the binary would come out
  // carrying nothing, so say which is which rather than installing that.
  if (dist !== `${repo}/dist`) {
    console.error(`The app has to be built into "${repo}/dist" to be embedded; found it in "${dist}".`);
    Deno.exit(2);
  }

  // An app that is not there cannot be embedded, and the failure would
  // otherwise be a compiler error about a missing include.
  try {
    const index = await Deno.readTextFile(`${dist}/index.html`);
    if (!index) throw new Error("empty");
  } catch {
    console.error(`No built app in "${dist}". Run \`deno task build\` (or \`npm run build\`) first.`);
    Deno.exit(2);
  }

  const dir = root ? installDir({ DENO_INSTALL_ROOT: root }) : installDir(Deno.env.toObject());
  const target = `${dir}/${binaryName(Deno.build.os)}`;
  await Deno.mkdir(dir, { recursive: true });

  // Written before the compile, so it travels inside the binary and answers
  // `note --version` afterwards: which source this is, and when it was made.
  const info = { revision: await gitRevision(repo), installed: new Date().toISOString() };
  await Deno.writeTextFile(`${repo}/${STAMP}`, `${JSON.stringify(info, null, 2)}\n`);

  const command = new Deno.Command(Deno.execPath(), {
    args: compileArgs(target),
    cwd: repo,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  });
  const { success } = await command.output();
  if (!success) {
    console.error("Could not compile the companion.");
    Deno.exit(1);
  }

  const path = (Deno.env.get("PATH") || "").split(Deno.build.os === "windows" ? ";" : ":");
  console.log(`note ${VERSION}`);
  console.log(`  binary    ${target}`);
  console.log(`  app       ${dist}, inside the binary`);
  console.log(`  build     ${info.revision.slice(0, 7)}  ${info.installed}`);
  console.log(`  run       ${NAME} serve ~/notebooks`);
  if (!path.includes(dir)) {
    console.log(`  PATH      add ${dir} to your PATH:`);
    console.log(`            export PATH="${dir}:$PATH"`);
  }
}

if (import.meta.main) {
  const argv = Deno.args;
  const root = argv.indexOf("--root");
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(help());
  } else if (root >= 0 && !argv[root + 1]) {
    console.error("--root needs a directory to install into.");
    Deno.exit(2);
  } else {
    // As with `deno install --root`: a root, with bin inside it.
    await install(root >= 0 ? argv[root + 1] : undefined);
  }
}
