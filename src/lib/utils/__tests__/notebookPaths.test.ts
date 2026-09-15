/**
 * The companion's path rules.
 *
 * `resolveWithin` is the security boundary of `note serve`: once the sync
 * protocol is keyed by path, the browser names files for a local process to
 * read and write, and any page can be pointed at localhost. These are the
 * cases that decide whether a path outside what the user handed on the command
 * line can ever be touched.
 */
import { describe, it, expect } from 'vitest';
import {
  displayName,
  frontmatterTitle,
  hasNotebookExtension,
  looksLikeAnyNotebook,
  looksLikeNotebook,
  looksLikeObservableNotebook,
  normalizeRoot,
  observableTitle,
  relativeTo,
  resolveWithin,
  shouldSkipDir,
} from '../../../../cli/notebookPaths';

const ROOT = '/home/e/notebooks';

describe('resolveWithin', () => {
  it('resolves a plain relative path under the root', () => {
    expect(resolveWithin(ROOT, 'luum.js')).toBe('/home/e/notebooks/luum.js');
    expect(resolveWithin(ROOT, 'rda/penguins.js')).toBe('/home/e/notebooks/rda/penguins.js');
  });

  it('collapses . and an inner .. that stays inside', () => {
    expect(resolveWithin(ROOT, './a/./b.js')).toBe('/home/e/notebooks/a/b.js');
    expect(resolveWithin(ROOT, 'a/../b.js')).toBe('/home/e/notebooks/b.js');
  });

  it('refuses anything that leaves the root', () => {
    for (const escape of [
      '../secrets.js',
      'a/../../secrets.js',
      '../../etc/passwd',
      '/etc/passwd',
      '/home/e/notebooks/luum.js', // absolute, even when it points back inside
    ]) {
      expect(resolveWithin(ROOT, escape)).toBeNull();
    }
  });

  it('refuses a NUL byte and an empty path', () => {
    expect(resolveWithin(ROOT, 'a\0.js')).toBeNull();
    expect(resolveWithin(ROOT, '')).toBeNull();
    expect(resolveWithin(ROOT, '.')).toBeNull();
    expect(resolveWithin(ROOT, './')).toBeNull();
  });

  it('does not let a prefix match pass for containment', () => {
    // /home/e/notebooks-private is not inside /home/e/notebooks.
    expect(relativeTo(ROOT, '/home/e/notebooks-private/x.js')).toBeNull();
  });
});

describe('relativeTo', () => {
  it('gives the path the client sees', () => {
    expect(relativeTo(ROOT, '/home/e/notebooks/luum.js')).toBe('luum.js');
    expect(relativeTo(ROOT, '/home/e/notebooks/rda/p.js')).toBe('rda/p.js');
  });

  it('is null for the root itself and for anything outside it', () => {
    expect(relativeTo(ROOT, ROOT)).toBeNull();
    expect(relativeTo(ROOT, '/etc/passwd')).toBeNull();
  });

  it('round-trips with resolveWithin', () => {
    const rel = 'rda/penguins.js';
    expect(relativeTo(ROOT, resolveWithin(ROOT, rel)!)).toBe(rel);
  });
});

describe('normalizeRoot', () => {
  it('makes a relative root absolute against the working directory', () => {
    expect(normalizeRoot('notebooks', '/home/e')).toBe('/home/e/notebooks');
    expect(normalizeRoot('./notebooks/', '/home/e')).toBe('/home/e/notebooks');
  });

  it('leaves an absolute root alone, minus the trailing slash', () => {
    expect(normalizeRoot('/srv/nb/', '/home/e')).toBe('/srv/nb');
  });
});

describe('looksLikeNotebook', () => {
  it('accepts the frontmatter fence the format opens with', () => {
    expect(looksLikeNotebook('// ---\n// title: Luum\n// ---\n')).toBe(true);
    expect(looksLikeNotebook('\n\n// ---\n// id: notebook-1\n')).toBe(true);
    expect(looksLikeNotebook('//---\n// title: x\n')).toBe(true);
  });

  it('rejects ordinary JavaScript', () => {
    // A repo is full of .js that is not a notebook; offering all of it would
    // bury the two files someone actually works in.
    expect(looksLikeNotebook('import foo from "bar";\n')).toBe(false);
    expect(looksLikeNotebook('// a normal comment\n// ---\n')).toBe(false);
    expect(looksLikeNotebook('')).toBe(false);
    expect(looksLikeNotebook('export const x = 1;')).toBe(false);
  });
});

describe('shouldSkipDir', () => {
  it('skips the heavy and the hidden', () => {
    for (const name of ['node_modules', '.git', 'dist', '.svelte-kit', '.cache']) {
      expect(shouldSkipDir(name)).toBe(true);
    }
  });

  it('walks ordinary directories', () => {
    for (const name of ['notebooks', 'src', 'analyses', 'rda']) {
      expect(shouldSkipDir(name)).toBe(false);
    }
  });
});

describe('hasNotebookExtension', () => {
  it('sniffs only what could be a notebook', () => {
    expect(hasNotebookExtension('luum.js')).toBe(true);
    expect(hasNotebookExtension('notes.html')).toBe(true);
    expect(hasNotebookExtension('NOTES.HTML')).toBe(true);
    expect(hasNotebookExtension('data.csv')).toBe(false);
    expect(hasNotebookExtension('README.md')).toBe(false);
  });
});

describe('looksLikeObservableNotebook', () => {
  it('accepts the root element the 2.0 format opens with', () => {
    expect(looksLikeObservableNotebook('<!doctype html>\n<notebook>')).toBe(true);
    expect(looksLikeObservableNotebook('<notebook theme="air">')).toBe(true);
  });

  it('rejects the rest of the HTML in a directory', () => {
    // A tree holds far more HTML than it holds notebooks — built pages,
    // coverage reports, this app's own static exports. Offering all of it would
    // be worse than offering none.
    expect(looksLikeObservableNotebook('<!doctype html><html><head>')).toBe(false);
    expect(looksLikeObservableNotebook('<p>see the notebook</p>')).toBe(false);
    expect(looksLikeObservableNotebook('')).toBe(false);
  });

  it('is combined with the .js rule, not confused with it', () => {
    expect(looksLikeAnyNotebook('// ---\n// title: Luum\n')).toBe(true);
    expect(looksLikeAnyNotebook('<notebook>')).toBe(true);
    expect(looksLikeAnyNotebook('import foo from "bar";')).toBe(false);
  });
});

describe('observableTitle', () => {
  it('names a notebook the way its author did', () => {
    expect(observableTitle('<notebook>\n  <title>Hello, world!</title>')).toBe('Hello, world!');
  });

  it('decodes the entities a title carries', () => {
    expect(observableTitle('<title>Fish &amp; &lt;chips&gt;</title>')).toBe('Fish & <chips>');
  });

  it('is null when there is none, so the caller falls back to the filename', () => {
    expect(observableTitle('<notebook></notebook>')).toBeNull();
    expect(observableTitle('<title>   </title>')).toBeNull();
  });
});

describe('displayName', () => {
  it('is the filename without the extension', () => {
    expect(displayName('rda/penguins.js')).toBe('penguins');
    expect(displayName('luum.js')).toBe('luum');
    expect(displayName('notes/analysis.html')).toBe('analysis');
  });
});

describe('frontmatterTitle', () => {
  it('reads the title the app names the notebook by', () => {
    // Listing filenames instead would put two different names for the same
    // notebook side by side in one panel.
    const head = '// ---\n// title: Getting started with tangent/ds\n// id: nb-1\n// ---\n';
    expect(frontmatterTitle(head)).toBe('Getting started with tangent/ds');
  });

  it('tolerates spacing and no space after the slashes', () => {
    expect(frontmatterTitle('//---\n//title:Luum\n')).toBe('Luum');
    expect(frontmatterTitle('// ---\n//   title:   Luum   \n')).toBe('Luum');
  });

  it('is null when there is none, so the caller can fall back to the filename', () => {
    expect(frontmatterTitle('// ---\n// id: nb-1\n// ---\n')).toBeNull();
    expect(frontmatterTitle('')).toBeNull();
    expect(frontmatterTitle('// title is not a field here\n')).toBeNull();
  });
});
