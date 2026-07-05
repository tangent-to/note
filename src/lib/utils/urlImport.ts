import type { Notebook } from '../types/notebook';
import { parseJSNotebook } from './fileOperations';

/** A notebook to open from a link, resolved to a directly fetchable URL. */
export interface ImportRequest {
  /** URL the notebook text is fetched from. */
  fetchUrl: string;
  /** Filename used to pick a parser and derive a default title. */
  filename: string;
}

const RAW_GITHUB = 'https://raw.githubusercontent.com';

function filenameFromPath(pathname: string): string {
  return pathname.split('/').filter(Boolean).pop() || 'notebook.js';
}

/** Rewrite a github.com file URL (/owner/repo/blob/ref/path) to its
 *  raw.githubusercontent.com equivalent, which serves the file with CORS
 *  headers. Returns null for URLs that aren't a GitHub file view. */
export function githubUrlToRaw(url: URL): string | null {
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null;
  const seg = url.pathname.split('/').filter(Boolean);
  if (seg.length >= 5 && (seg[2] === 'blob' || seg[2] === 'raw')) {
    const [owner, repo, , ref, ...path] = seg;
    return `${RAW_GITHUB}/${owner}/${repo}/${ref}/${path.join('/')}`;
  }
  return null;
}

/**
 * Recognize a notebook link in the page URL. Two forms are supported:
 *
 *   /import?url=https://…    fetch the notebook from any URL (github.com
 *                            file URLs are rewritten to their raw form).
 *                            The `url` param works on any path, and a bare
 *                            `?=https://…` is accepted too.
 *   /gh/owner/repo/path.js   fetch from a GitHub repo's default branch.
 *                            A ref can be given as /gh/owner/repo@ref/path.js,
 *                            and a pasted github.com path like
 *                            /gh/owner/repo/blob/ref/path.js also works.
 *
 * Returns null when the URL doesn't request an import.
 */
export function parseImportRequest(pathname: string, search: string): ImportRequest | null {
  const params = new URLSearchParams(search);
  const urlParam = params.get('url') ?? params.get('');
  if (urlParam) {
    let parsed: URL;
    try {
      parsed = new URL(urlParam);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    const fetchUrl = githubUrlToRaw(parsed) ?? parsed.href;
    return { fetchUrl, filename: filenameFromPath(new URL(fetchUrl).pathname) };
  }

  const seg = pathname.split('/').filter(Boolean);
  if (seg[0] !== 'gh' || seg.length < 4) return null;
  const owner = seg[1];
  let repo = seg[2];
  let ref = 'HEAD';
  let path = seg.slice(3);
  const at = repo.indexOf('@');
  if (at > 0) {
    ref = repo.slice(at + 1);
    repo = repo.slice(0, at);
  } else if ((path[0] === 'blob' || path[0] === 'raw') && path.length >= 3) {
    ref = path[1];
    path = path.slice(2);
  }
  return {
    fetchUrl: `${RAW_GITHUB}/${owner}/${repo}/${ref}/${path.join('/')}`,
    filename: filenameFromPath(path.join('/')),
  };
}

/** The GitHub Pages 404 shim (public/404.html) can't serve the SPA for deep
 *  links like /gh/…, so it bounces to /?p=<original path+query>. Decode that
 *  back into the original pathname/search, or null when not a redirect. */
export function decodeRedirect(search: string): { pathname: string; search: string } | null {
  const p = new URLSearchParams(search).get('p');
  if (!p || !p.startsWith('/')) return null;
  const q = p.indexOf('?');
  return q === -1
    ? { pathname: p, search: '' }
    : { pathname: p.slice(0, q), search: p.slice(q) };
}

/** True when two notebooks have the same identity and cell content — used
 *  to skip the "save your local notebook?" prompt when a link resolves to
 *  exactly what's already loaded (e.g. re-clicking the same link). Outputs
 *  and view state (collapsed, etc.) are ignored: content is the work. */
export function notebooksEquivalent(a: Notebook, b: Notebook): boolean {
  return (
    a.id === b.id &&
    a.cells.length === b.cells.length &&
    a.cells.every(
      (cell, i) =>
        cell.type === b.cells[i].type &&
        cell.content.trim() === b.cells[i].content.trim(),
    )
  );
}

/** Fetch and parse the notebook behind an ImportRequest. Throws with a
 *  human-readable message on network/CORS errors, HTTP errors, or content
 *  that isn't a notebook. */
export async function fetchNotebookFromUrl(request: ImportRequest): Promise<Notebook> {
  let res: Response;
  try {
    // 'no-cache' revalidates with the server instead of trusting the HTTP
    // cache: raw.githubusercontent.com serves max-age=300, so the default
    // mode would keep opening a stale copy for up to 5 minutes after the
    // file changed (longer for hosts with bigger max-age).
    res = await fetch(request.fetchUrl, { cache: 'no-cache' });
  } catch {
    throw new Error('the file couldn’t be fetched (network error, or the host doesn’t allow cross-origin requests)');
  }
  if (!res.ok) {
    throw new Error(`the server responded with ${res.status}`);
  }
  const text = await res.text();
  const notebook = request.filename.toLowerCase().endsWith('.json')
    ? JSON.parse(text)
    : parseJSNotebook(text, request.filename);
  // parseJSNotebook yields zero cells for arbitrary text (e.g. an HTML error
  // page), so an empty notebook means the URL didn't point at a notebook.
  if (!notebook?.id || !Array.isArray(notebook.cells) || notebook.cells.length === 0) {
    throw new Error('the file isn’t a valid notebook');
  }
  return notebook;
}
