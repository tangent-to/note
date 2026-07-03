import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseImportRequest,
  decodeRedirect,
  githubUrlToRaw,
  fetchNotebookFromUrl,
} from '../urlImport';

describe('parseImportRequest', () => {
  it('returns null for a plain visit', () => {
    expect(parseImportRequest('/', '')).toBeNull();
  });

  it('resolves ?url= to the given https URL', () => {
    const req = parseImportRequest('/import', '?url=https://example.com/demos/plot.js');
    expect(req).toEqual({
      fetchUrl: 'https://example.com/demos/plot.js',
      filename: 'plot.js',
    });
  });

  it('accepts a bare ?=… as the url param', () => {
    const req = parseImportRequest('/import', '?=https://example.com/nb.js');
    expect(req?.fetchUrl).toBe('https://example.com/nb.js');
  });

  it('accepts ?url= on any path, not just /import', () => {
    const req = parseImportRequest('/', '?url=https://example.com/nb.js');
    expect(req?.fetchUrl).toBe('https://example.com/nb.js');
  });

  it('rewrites a github.com blob URL in ?url= to its raw form', () => {
    const req = parseImportRequest(
      '/import',
      '?url=' + encodeURIComponent('https://github.com/user/repo/blob/main/dir/nb.js')
    );
    expect(req).toEqual({
      fetchUrl: 'https://raw.githubusercontent.com/user/repo/main/dir/nb.js',
      filename: 'nb.js',
    });
  });

  it('rejects non-http(s) schemes in ?url=', () => {
    expect(parseImportRequest('/', '?url=javascript:alert(1)')).toBeNull();
    expect(parseImportRequest('/', '?url=file:///etc/passwd')).toBeNull();
    expect(parseImportRequest('/', '?url=not-a-url')).toBeNull();
  });

  it('maps /gh/owner/repo/file.js to the default branch raw URL', () => {
    const req = parseImportRequest('/gh/user/repo/file.js', '');
    expect(req).toEqual({
      fetchUrl: 'https://raw.githubusercontent.com/user/repo/HEAD/file.js',
      filename: 'file.js',
    });
  });

  it('keeps nested paths in /gh/ links', () => {
    const req = parseImportRequest('/gh/user/repo/examples/data/nb.js', '');
    expect(req?.fetchUrl).toBe('https://raw.githubusercontent.com/user/repo/HEAD/examples/data/nb.js');
  });

  it('supports a ref via /gh/owner/repo@ref/file.js', () => {
    const req = parseImportRequest('/gh/user/repo@v1.2/file.js', '');
    expect(req?.fetchUrl).toBe('https://raw.githubusercontent.com/user/repo/v1.2/file.js');
  });

  it('supports a pasted github.com path with /blob/ref/', () => {
    const req = parseImportRequest('/gh/user/repo/blob/main/dir/file.js', '');
    expect(req?.fetchUrl).toBe('https://raw.githubusercontent.com/user/repo/main/dir/file.js');
  });

  it('returns null for /gh/ links without a file path', () => {
    expect(parseImportRequest('/gh/user/repo', '')).toBeNull();
    expect(parseImportRequest('/gh/user', '')).toBeNull();
  });
});

describe('decodeRedirect', () => {
  it('returns null without a p param', () => {
    expect(decodeRedirect('')).toBeNull();
    expect(decodeRedirect('?url=https://example.com/nb.js')).toBeNull();
  });

  it('decodes a redirected path', () => {
    expect(decodeRedirect('?p=' + encodeURIComponent('/gh/user/repo/file.js'))).toEqual({
      pathname: '/gh/user/repo/file.js',
      search: '',
    });
  });

  it('splits a redirected path with a query', () => {
    expect(decodeRedirect('?p=' + encodeURIComponent('/import?url=https://x.co/nb.js'))).toEqual({
      pathname: '/import',
      search: '?url=https://x.co/nb.js',
    });
  });

  it('rejects values that are not absolute paths', () => {
    expect(decodeRedirect('?p=https://evil.example')).toBeNull();
  });
});

describe('githubUrlToRaw', () => {
  it('rewrites blob and raw file views', () => {
    expect(githubUrlToRaw(new URL('https://github.com/o/r/blob/main/a/b.js')))
      .toBe('https://raw.githubusercontent.com/o/r/main/a/b.js');
    expect(githubUrlToRaw(new URL('https://github.com/o/r/raw/main/b.js')))
      .toBe('https://raw.githubusercontent.com/o/r/main/b.js');
  });

  it('leaves non-file github URLs and other hosts alone', () => {
    expect(githubUrlToRaw(new URL('https://github.com/o/r'))).toBeNull();
    expect(githubUrlToRaw(new URL('https://example.com/o/r/blob/main/b.js'))).toBeNull();
  });
});

describe('fetchNotebookFromUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const jsNotebook = `// ---
// title: Remote
// id: remote-nb
// ---

// %% [javascript]
const a = 1;
`;

  function stubFetch(response: Partial<Response> | Error) {
    const impl = response instanceof Error
      ? () => Promise.reject(response)
      : () => Promise.resolve(response as Response);
    vi.stubGlobal('fetch', vi.fn(impl));
  }

  it('parses a .js notebook', async () => {
    stubFetch({ ok: true, text: () => Promise.resolve(jsNotebook) } as Response);
    const nb = await fetchNotebookFromUrl({ fetchUrl: 'https://x.co/nb.js', filename: 'nb.js' });
    expect(nb.id).toBe('remote-nb');
    expect(nb.name).toBe('Remote');
    expect(nb.cells).toHaveLength(1);
  });

  it('parses a .json notebook', async () => {
    const json = JSON.stringify({ id: 'j1', name: 'Json', cells: [{ id: 'c1', type: 'code', content: '1' }] });
    stubFetch({ ok: true, text: () => Promise.resolve(json) } as Response);
    const nb = await fetchNotebookFromUrl({ fetchUrl: 'https://x.co/nb.json', filename: 'nb.json' });
    expect(nb.id).toBe('j1');
  });

  it('rejects HTTP errors with the status code', async () => {
    stubFetch({ ok: false, status: 404 } as Response);
    await expect(fetchNotebookFromUrl({ fetchUrl: 'https://x.co/nb.js', filename: 'nb.js' }))
      .rejects.toThrow('404');
  });

  it('rejects network/CORS failures with a readable message', async () => {
    stubFetch(new TypeError('Failed to fetch'));
    await expect(fetchNotebookFromUrl({ fetchUrl: 'https://x.co/nb.js', filename: 'nb.js' }))
      .rejects.toThrow(/cross-origin|network/);
  });

  it('rejects content that yields no cells', async () => {
    stubFetch({ ok: true, text: () => Promise.resolve('<!doctype html><p>not a notebook</p>') } as Response);
    await expect(fetchNotebookFromUrl({ fetchUrl: 'https://x.co/nb.js', filename: 'nb.js' }))
      .rejects.toThrow('valid notebook');
  });
});
