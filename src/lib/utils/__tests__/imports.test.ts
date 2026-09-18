/**
 * Reading a notebook's imports.
 *
 * The rewriting is done by position, over the reader's own code, so finding the
 * specifier exactly — and never mistaking a pinned import for an unpinned one —
 * matters more here than anywhere else in this feature.
 */
import { describe, it, expect } from 'vitest';
import { applyPins, classifyImport, findImports, isExactVersion, pinSpecifier, resolvedUrl } from '../imports';

describe('findImports', () => {
  it('finds static, side-effect and dynamic imports', () => {
    const code = [
      'import * as d3 from "d3";',
      "import 'katex/dist/katex.min.css';",
      'const m = await import(`x`);',
      'const n = await import("https://cdn.jsdelivr.net/npm/tone/+esm");',
    ].join('\n');
    expect(findImports(code).map((i) => i.spec)).toEqual([
      'd3',
      'katex/dist/katex.min.css',
      'https://cdn.jsdelivr.net/npm/tone/+esm',
    ]);
  });

  it('points at the specifier itself, so a rewrite touches nothing else', () => {
    const code = 'import * as d3 from "d3";';
    const [ref] = findImports(code);
    expect(code.slice(ref.start, ref.end)).toBe('d3');
    expect(applyPins(code, [{ ...ref, spec: 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm' }]))
      .toBe('import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";');
  });

  it('rewrites several in one cell without shifting the others', () => {
    const code = 'import a from "a";\nimport b from "b";';
    const refs = findImports(code);
    expect(applyPins(code, [
      { ...refs[0], spec: 'A' },
      { ...refs[1], spec: 'B' },
    ])).toBe('import a from "A";\nimport b from "B";');
  });
});

describe('classifyImport', () => {
  const unpinned = (spec: string) => classifyImport(spec).pinned === false;

  it('calls a bare specifier unpinned', () => {
    expect(classifyImport('d3')).toMatchObject({ kind: 'bare', pinned: false, name: 'd3' });
    expect(classifyImport('npm:tone')).toMatchObject({ kind: 'bare', pinned: false, name: 'tone' });
    expect(classifyImport('@observablehq/plot')).toMatchObject({ kind: 'bare', name: '@observablehq/plot' });
  });

  it('reads a jsDelivr npm URL', () => {
    expect(classifyImport('https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm')).toMatchObject({ pinned: true, name: 'd3' });
    expect(classifyImport('https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6.17/+esm')).toMatchObject({ pinned: true, name: '@observablehq/plot' });
    expect(unpinned('https://cdn.jsdelivr.net/npm/d3/+esm')).toBe(true);
    expect(classifyImport('https://cdn.jsdelivr.net/npm/d3@^7/+esm').reason).toMatch(/range/);
  });

  it('knows a GitHub branch moves, and a tag or commit does not', () => {
    // The case in these notebooks: ten imports of studio@main.
    expect(classifyImport('https://cdn.jsdelivr.net/gh/jmonlabs/studio@main/src/index.js'))
      .toMatchObject({ kind: 'jsdelivr-gh', pinned: false, name: 'jmonlabs/studio' });
    expect(classifyImport('https://cdn.jsdelivr.net/gh/jmonlabs/algo@v2.1.0/src/index.js').pinned).toBe(true);
    expect(classifyImport('https://cdn.jsdelivr.net/gh/jmonlabs/algo@1b1b85b/src/index.js').pinned).toBe(true);
    expect(classifyImport('https://cdn.jsdelivr.net/gh/jmonlabs/show/src/index.js').reason).toMatch(/default branch/);
  });

  it('leaves relative paths and unknown hosts alone', () => {
    expect(classifyImport('./helpers.js').pinned).toBe(true);
    expect(classifyImport('https://example.com/lib.js').pinned).toBe(true);
  });

  it('does not take a range or a branch for a version', () => {
    expect(isExactVersion('7.9.0')).toBe(true);
    expect(isExactVersion('v2.1.0')).toBe(true);
    expect(isExactVersion('1b1b85b')).toBe(true);
    expect(isExactVersion('main')).toBe(false);
    expect(isExactVersion('^7')).toBe(false);
    expect(isExactVersion('latest')).toBe(false);
    expect(isExactVersion(undefined)).toBe(false);
  });
});

describe('resolvedUrl', () => {
  it('is what the executor would actually fetch', () => {
    expect(resolvedUrl('d3')).toBe('https://cdn.jsdelivr.net/npm/d3/+esm');
    expect(resolvedUrl('npm:tone')).toBe('https://cdn.jsdelivr.net/npm/tone/+esm');
    expect(resolvedUrl('https://esm.sh/d3')).toBe('https://esm.sh/d3');
  });
});

describe('pinSpecifier', () => {
  it('pins a bare specifier to a full, versioned URL', () => {
    expect(pinSpecifier('d3', '7.9.0')).toBe('https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm');
    expect(pinSpecifier('@observablehq/plot', '0.6.17')).toBe('https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6.17/+esm');
  });

  it('adds the version to a jsDelivr URL, keeping the rest of the path', () => {
    expect(pinSpecifier('https://cdn.jsdelivr.net/npm/d3/+esm', '7.9.0'))
      .toBe('https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm');
    expect(pinSpecifier('https://cdn.jsdelivr.net/gh/jmonlabs/studio@main/src/index.js', 'd10371f'))
      .toBe('https://cdn.jsdelivr.net/gh/jmonlabs/studio@d10371f/src/index.js');
    expect(pinSpecifier('https://esm.sh/d3', '7.9.0')).toBe('https://esm.sh/d3@7.9.0');
  });

  it('leaves alone what is already pinned', () => {
    expect(pinSpecifier('https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm', '8.0.0')).toBeNull();
    expect(pinSpecifier('./helpers.js', '1.0.0')).toBeNull();
  });
});
