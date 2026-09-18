/**
 * Resolving an unpinned import to the version it actually loads.
 *
 * Both answers come from hosts that say so out loud — jsDelivr in a header it
 * exposes to scripts, GitHub in its API — and a branch is resolved to a commit,
 * because pinning `@main` to `main` would pin nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveVersion } from '../pinImports';

const headers = (h: Record<string, string>) => new Response(null, { status: 200, headers: h });

describe('resolveVersion', () => {
  it('reads the version jsDelivr resolved a bare specifier to', async () => {
    const fetcher = vi.fn(async () => headers({ 'x-jsd-version': '7.9.0', 'x-jsd-version-type': 'version' }));
    expect(await resolveVersion('d3', fetcher as any)).toEqual({ version: '7.9.0', as: 'version' });
    expect(fetcher).toHaveBeenCalledWith('https://cdn.jsdelivr.net/npm/d3/+esm', { method: 'HEAD' });
  });

  it('turns a GitHub branch into the commit it points at', async () => {
    const fetcher = vi.fn(async (url: string) =>
      url.startsWith('https://api.github.com/repos/jmonlabs/studio/commits/main')
        ? new Response(JSON.stringify({ sha: 'd10371f41980abc' }))
        : headers({})
    );
    expect(await resolveVersion('https://cdn.jsdelivr.net/gh/jmonlabs/studio@main/src/index.js', fetcher as any))
      .toEqual({ version: 'd10371f', as: 'commit' });
  });

  it('reads esm.sh’s own header', async () => {
    const fetcher = vi.fn(async () => headers({ 'x-esm-path': '/d3@7.9.0/es2022/d3.mjs' }));
    expect(await resolveVersion('https://esm.sh/d3', fetcher as any)).toEqual({ version: '7.9.0', as: 'version' });
  });

  it('says nothing rather than guessing', async () => {
    // A host that does not report a version, a branch jsDelivr only echoes back,
    // and a request that fails.
    expect(await resolveVersion('https://example.com/lib.js', (async () => headers({})) as any)).toBeNull();
    expect(await resolveVersion('d3', (async () => headers({ 'x-jsd-version': 'main', 'x-jsd-version-type': 'branch' })) as any)).toBeNull();
    expect(await resolveVersion('d3', (async () => new Response(null, { status: 500 })) as any)).toBeNull();
    expect(await resolveVersion('d3', (async () => { throw new Error('offline'); }) as any)).toBeNull();
  });

  it('leaves an already pinned import alone, without asking anyone', async () => {
    const fetcher = vi.fn();
    expect(await resolveVersion('https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm', fetcher as any)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
