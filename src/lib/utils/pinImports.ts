/**
 * Asking a CDN what an unpinned import actually resolved to.
 *
 * Both answers come from the network and both are readable from a page:
 * jsDelivr returns the resolved version in `x-jsd-version` and exposes it to
 * scripts (`access-control-expose-headers: *`), and GitHub's API turns a branch
 * into the commit it points at right now. esm.sh says it in `x-esm-path`.
 *
 * A branch is resolved to a commit rather than left as it is: `@main` is the
 * thing that moves, so pinning it to a name that still moves would pin nothing.
 *
 * `fetch` is injected, so the rules are tested without a network.
 */
import { classifyImport, resolvedUrl, type ImportVerdict } from './imports';

export interface Resolution {
  version: string;
  /** What the version is, for the report: a release, or a commit behind a branch. */
  as: 'version' | 'commit';
}

/** Read what a URL resolved to, or null when the host does not say. */
export async function resolveVersion(
  spec: string,
  doFetch: typeof fetch = fetch
): Promise<Resolution | null> {
  const verdict: ImportVerdict = classifyImport(spec);
  const url = resolvedUrl(spec);
  if (!url || verdict.pinned) return null;

  if (verdict.kind === 'jsdelivr-gh' && verdict.name) {
    // jsDelivr reports the branch back as a branch, so the commit has to come
    // from GitHub itself.
    const branch = /@([^/]+)/.exec(new URL(url).pathname)?.[1] ?? 'HEAD';
    try {
      const response = await doFetch(`https://api.github.com/repos/${verdict.name}/commits/${branch}`, {
        headers: { accept: 'application/vnd.github+json' },
      });
      if (!response.ok) return null;
      const commit = await response.json();
      const sha = typeof commit?.sha === 'string' ? commit.sha.slice(0, 7) : null;
      return sha ? { version: sha, as: 'commit' } : null;
    } catch {
      return null;
    }
  }

  try {
    const response = await doFetch(url, { method: 'HEAD' });
    if (!response.ok) return null;
    const jsd = response.headers.get('x-jsd-version');
    if (jsd && response.headers.get('x-jsd-version-type') === 'version') {
      return { version: jsd, as: 'version' };
    }
    const esm = response.headers.get('x-esm-path');
    const fromEsm = esm && /@([^/]+)\//.exec(esm)?.[1];
    if (fromEsm) return { version: fromEsm, as: 'version' };
    return null;
  } catch {
    return null;
  }
}
