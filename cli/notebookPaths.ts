/**
 * Path and discovery rules for the `note serve` companion.
 *
 * Kept apart from serve.ts, which needs Deno's filesystem at module scope and
 * so cannot be imported by the test runner. Everything here is a pure function
 * on strings — which matters most for `resolveWithin`: once the sync protocol
 * is keyed by path, the browser is naming files for a local process to read
 * and write, and "which paths am I willing to touch" stops being an internal
 * detail and becomes the boundary of the whole thing.
 */

/** Directories never worth walking for notebooks. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.svelte-kit',
  '.next',
  '.cache',
  'vendor',
  '__pycache__',
]);

/** How deep below a root directory to look. Deep trees are someone's source. */
export const MAX_DEPTH = 3;

export function shouldSkipDir(name: string): boolean {
  // Hidden directories are configuration, not work — and `.git` in particular
  // is enormous.
  return name.startsWith('.') || SKIP_DIRS.has(name);
}

/**
 * Does this file's head look like a tangent notebook?
 *
 * A repository is full of `.js` that is not a notebook, and offering all of it
 * would bury the two files someone actually works in. The format opens with a
 * `// ---` frontmatter fence (see fileOperations.parseJSNotebook), which is a
 * cheap and near-unambiguous signature — a plain script effectively never
 * starts with one.
 */
export function looksLikeNotebook(head: string): boolean {
  for (const line of head.split('\n', 5)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    return trimmed === '// ---' || trimmed === '//---';
  }
  return false;
}

/** Collapse `.` and `..`; returns null when the path climbs above its base. */
function normalizeSegments(path: string): string[] | null {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out;
}

/** Absolute, normalized, no trailing slash. */
export function normalizeRoot(root: string, cwd: string): string {
  const base = root.startsWith('/') ? root : `${cwd}/${root}`;
  const segments = normalizeSegments(base) ?? [];
  return `/${segments.join('/')}`;
}

/**
 * Turn a relative path from the client into an absolute one under `root`.
 *
 * Returns null for anything that would leave the root — an absolute path, a
 * `..` that climbs out, a NUL byte. The companion answers the browser, and a
 * page from anywhere could be pointed at localhost, so this refuses rather
 * than resolves: no path outside what the user handed on the command line is
 * ever read or written.
 */
export function resolveWithin(root: string, relative: string): string | null {
  if (relative.startsWith('/') || relative.includes('\0')) return null;
  const segments = normalizeSegments(relative);
  if (!segments || segments.length === 0) return null;
  return `${root}/${segments.join('/')}`;
}

/** The path the client sees: relative to its root, with `/` separators. */
export function relativeTo(root: string, absolute: string): string | null {
  if (absolute === root) return null;
  if (!absolute.startsWith(`${root}/`)) return null;
  return absolute.slice(root.length + 1);
}

/** A notebook's display name: its filename without the extension. */
export function displayName(relative: string): string {
  const base = relative.slice(relative.lastIndexOf('/') + 1);
  return base.replace(/\.js$/, '');
}
