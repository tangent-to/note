/**
 * The imports a notebook makes, and whether they name a version.
 *
 * An unpinned import is the quiet way a notebook stops being itself: `import
 * "d3"` fetches whatever is newest today, so a piece can behave differently
 * tomorrow with nothing in its file changed. Pinning the version in the URL
 * fixes that in the best possible place — the notebook itself, which travels
 * with the work and needs nothing from this app to be reproducible elsewhere.
 *
 * jsDelivr's `+esm` bundles pin their own dependencies exactly
 * (`d3` pulls `/npm/d3-array@3.2.4/+esm`), so pinning the top level pins the
 * whole tree.
 *
 * Pure: finding, judging and rewriting. Asking a CDN what a specifier resolves
 * to is next door, in pinImports.ts.
 */

export interface ImportRef {
  /** The specifier as written: `d3`, or a full URL. */
  spec: string;
  /** Where the specifier sits in the code, so it can be rewritten in place. */
  start: number;
  end: number;
}

const PATTERNS = [
  /\bfrom\s*(['"])([^'"\n]+)\1/g,
  /\bimport\s*\(\s*(['"])([^'"\n]+)\1/g,
  /\bimport\s*(['"])([^'"\n]+)\1/g,
];

/** Every module specifier in a cell, in the order they appear, without repeats. */
export function findImports(code: string): ImportRef[] {
  const found = new Map<number, ImportRef>();
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) {
      const spec = match[2];
      const start = match.index + match[0].lastIndexOf(spec);
      found.set(start, { spec, start, end: start + spec.length });
    }
  }
  return [...found.values()].sort((a, b) => a.start - b.start);
}

export type ImportKind = 'bare' | 'jsdelivr-npm' | 'jsdelivr-gh' | 'esm-sh' | 'relative' | 'other';

export interface ImportVerdict {
  kind: ImportKind;
  /** True when the specifier names an exact version (or a commit). */
  pinned: boolean;
  /** Why it is not pinned, in the reader's terms. */
  reason?: string;
  /** The package or repo, for a message. */
  name?: string;
}

const NPM_PATH = /^\/npm\/((?:@[^/@]+\/)?[^/@]+)(?:@([^/]+))?(\/.*)?$/;
const GH_PATH = /^\/gh\/([^/]+\/[^/@]+)(?:@([^/]+))?(\/.*)?$/;
const ESM_PATH = /^\/((?:@[^/@]+\/)?[^/@]+)(?:@([^/]+))?(\/.*)?$/;

/** A version like `7.9.0`, or a git commit; not `main`, `latest` or `^7`. */
export function isExactVersion(version: string | undefined): boolean {
  if (!version) return false;
  if (/^v?\d+\.\d+\.\d+([-+].+)?$/.test(version)) return true;
  return /^[0-9a-f]{7,40}$/.test(version);
}

export function classifyImport(spec: string): ImportVerdict {
  if (/^(\.{1,2})?\//.test(spec) || spec.startsWith('data:') || spec.startsWith('blob:')) {
    return { kind: 'relative', pinned: true };
  }
  if (!/^https?:\/\//.test(spec)) {
    // A bare specifier — `d3`, `npm:tone` — is resolved to the CDN's newest.
    const name = spec.replace(/^npm:/, '');
    return { kind: 'bare', pinned: false, reason: 'no version: this loads whatever is newest today', name };
  }
  let url: URL;
  try {
    url = new URL(spec);
  } catch {
    return { kind: 'other', pinned: false, reason: 'not a URL this can read' };
  }
  if (url.hostname === 'cdn.jsdelivr.net') {
    const npm = NPM_PATH.exec(url.pathname);
    if (npm) {
      const [, name, version] = npm;
      return isExactVersion(version)
        ? { kind: 'jsdelivr-npm', pinned: true, name }
        : {
            kind: 'jsdelivr-npm',
            pinned: false,
            name,
            reason: version ? `“${version}” is a range, not a version` : 'no version: this loads whatever is newest today',
          };
    }
    const gh = GH_PATH.exec(url.pathname);
    if (gh) {
      const [, name, version] = gh;
      return isExactVersion(version)
        ? { kind: 'jsdelivr-gh', pinned: true, name }
        : {
            kind: 'jsdelivr-gh',
            pinned: false,
            name,
            reason: version ? `“${version}” is a branch, which moves` : 'no tag or commit: this follows the default branch',
          };
    }
  }
  if (url.hostname === 'esm.sh') {
    const esm = ESM_PATH.exec(url.pathname);
    const version = esm?.[2];
    return isExactVersion(version)
      ? { kind: 'esm-sh', pinned: true, name: esm?.[1] }
      : { kind: 'esm-sh', pinned: false, name: esm?.[1], reason: 'no version: this loads whatever is newest today' };
  }
  return { kind: 'other', pinned: true };
}

/** The URL a specifier actually fetches, mirroring the executor's resolution. */
export function resolvedUrl(spec: string): string | null {
  if (/^https?:\/\//.test(spec)) return spec;
  if (/^(\.{1,2})?\//.test(spec) || spec.includes(':')) {
    const bare = spec.replace(/^npm:/, '');
    if (bare === spec) return null;
    return `https://cdn.jsdelivr.net/npm/${bare}/+esm`;
  }
  return `https://cdn.jsdelivr.net/npm/${spec}/+esm`;
}

/** The specifier to write instead, once the version is known. */
export function pinSpecifier(spec: string, version: string): string | null {
  const verdict = classifyImport(spec);
  if (verdict.pinned) return null;
  if (verdict.kind === 'bare') {
    const name = spec.replace(/^npm:/, '');
    return `https://cdn.jsdelivr.net/npm/${name}@${version}/+esm`;
  }
  // Each host spells a package differently — npm has a scope, GitHub has an
  // owner and a repo — so the name is taken from the pattern that matched, not
  // from counting path segments.
  const url = new URL(spec);
  const rebuild = (pattern: RegExp, prefix: string) => {
    const match = pattern.exec(url.pathname);
    if (!match) return null;
    const [, name, , rest = ''] = match;
    url.pathname = `${prefix}${name}@${version}${rest}`;
    return url.toString();
  };
  if (verdict.kind === 'jsdelivr-npm') return rebuild(NPM_PATH, '/npm/');
  if (verdict.kind === 'jsdelivr-gh') return rebuild(GH_PATH, '/gh/');
  if (verdict.kind === 'esm-sh') return rebuild(ESM_PATH, '/');
  return null;
}

/** Rewrite a cell's specifiers in place. Positions come from findImports. */
export function applyPins(code: string, pins: Array<{ start: number; end: number; spec: string }>): string {
  let out = code;
  for (const pin of [...pins].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, pin.start) + pin.spec + out.slice(pin.end);
  }
  return out;
}
