/**
 * Observable Notebooks 2.0 in and out.
 *
 * This is document interoperability, not runtime compatibility, and the line
 * between the two is the whole design: cells cross, behaviour does not. So the
 * cases below are as much about what the conversion *reports* as about what it
 * produces — a notebook that looks fine and quietly does not work is worse than
 * one that says what is missing.
 *
 * Format reference: https://observablehq.com/notebook-kit/kit
 */
import { describe, it, expect } from 'vitest';
import {
  dedent,
  escapeCellSource,
  looksLikeObservableNotebook,
  parseObservableNotebook,
  serializeObservableNotebook,
  summarizeLosses,
  unescapeCellSource,
  type Loss,
} from '../observableFormat';
import type { Notebook, NotebookCell } from '../../types/notebook';

const HELLO = `<!doctype html>
<notebook>
  <title>Hello, world!</title>
  <script id="1" type="text/markdown">
    # Hello, world!
  </script>
  <script id="2" type="module" pinned>
    1 + 2
  </script>
</notebook>
`;

function nb(cells: Partial<NotebookCell>[], name = 'Test'): Notebook {
  return {
    id: 'nb',
    name,
    createdAt: 0,
    updatedAt: 0,
    cells: cells.map((c, i) => ({
      id: c.id ?? `cell-${i + 1}`,
      type: c.type ?? 'code',
      content: c.content ?? '',
      ...c,
    })) as NotebookCell[],
  };
}

const kinds = (losses: Loss[]) => losses.map((l) => l.kind);

describe('looksLikeObservableNotebook', () => {
  it('recognises the root element, wherever it sits', () => {
    expect(looksLikeObservableNotebook(HELLO)).toBe(true);
    expect(looksLikeObservableNotebook('<notebook theme="air">')).toBe(true);
    expect(looksLikeObservableNotebook('<NOTEBOOK>')).toBe(true);
  });

  it('rejects ordinary HTML, which is most of the HTML in a directory', () => {
    expect(looksLikeObservableNotebook('<!doctype html><html><body>hi')).toBe(false);
    expect(looksLikeObservableNotebook('<div>notebook</div>')).toBe(false);
    expect(looksLikeObservableNotebook('')).toBe(false);
  });
});

describe('the </script> escape', () => {
  it('round-trips a literal script tag in cell source', () => {
    const source = '<h1>hi</h1><script>alert(1)</script>';
    expect(escapeCellSource(source)).toContain('<\\/script>');
    expect(unescapeCellSource(escapeCellSource(source))).toBe(source);
  });

  it('takes exactly one backslash off a run of them', () => {
    expect(unescapeCellSource('<\\/script>')).toBe('</script>');
    expect(unescapeCellSource('<\\\\/script>')).toBe('<\\/script>');
    expect(escapeCellSource('<\\/script>')).toBe('<\\\\/script>');
  });

  it('escapes an end tag whatever its case or spacing', () => {
    // An end tag is `</script` followed by whitespace or `>`, and the match is
    // case-insensitive. Escaping only the exact lowercase `</script>` wrote
    // files a real HTML parser cuts in half.
    expect(escapeCellSource('</SCRIPT>')).toBe('<\\/SCRIPT>');
    expect(escapeCellSource('</script foo>')).toBe('<\\/script foo>');
    expect(unescapeCellSource('<\\/SCRIPT>')).toBe('</SCRIPT>');
  });

  it('ends a cell on an uppercase or spaced end tag, as a browser would', () => {
    const html = '<notebook><script type="module" pinned>1</SCRIPT ><script type="module" pinned>2</script></notebook>';
    const { notebook } = parseObservableNotebook(html);
    expect(notebook.cells.map((c) => c.content)).toEqual(['1', '2']);
  });

  it('ignores script elements outside the notebook root', () => {
    const html = '<script src="analytics.js"></script><notebook><script type="module" pinned>1</script></notebook>';
    const { notebook } = parseObservableNotebook(html);
    expect(notebook.cells).toHaveLength(1);
    expect(notebook.cells[0].content).toBe('1');
  });

  it('does not end a cell on an escaped tag', () => {
    const html = `<notebook><title>T</title>
  <script id="1" type="text/html">
    <script>alert(1)<\\/script>
  </script>
  <script id="2" type="module" pinned>
    42
  </script>
</notebook>`;
    const { notebook } = parseObservableNotebook(html);
    expect(notebook.cells).toHaveLength(2);
    expect(notebook.cells[0].content).toBe('<script>alert(1)</script>');
    expect(notebook.cells[1].content).toBe('42');
  });
});

describe('dedent', () => {
  it('removes the indentation the format adds', () => {
    expect(dedent('\n    1 + 2\n  ')).toBe('1 + 2');
    expect(dedent('\n    const a = 1;\n    const b = 2;\n  ')).toBe('const a = 1;\nconst b = 2;');
  });

  it('keeps relative indentation, which is the code', () => {
    expect(dedent('\n    if (x) {\n      go();\n    }\n  ')).toBe('if (x) {\n  go();\n}');
  });

  it('leaves a blank line blank rather than slicing into the next one', () => {
    expect(dedent('\n    a\n\n    b\n  ')).toBe('a\n\nb');
  });
});

describe('importing', () => {
  it('reads the hello-world notebook from the spec', () => {
    const { notebook, losses } = parseObservableNotebook(HELLO);
    expect(notebook.name).toBe('Hello, world!');
    expect(notebook.cells).toHaveLength(2);
    expect(notebook.cells[0]).toMatchObject({ type: 'markdown', content: '# Hello, world!' });
    expect(notebook.cells[1]).toMatchObject({ type: 'code', content: '1 + 2' });
    expect(losses).toEqual([]);
  });

  it('keeps the file’s own cell ids, so a round trip leaves them put', () => {
    const { notebook } = parseObservableNotebook(HELLO);
    expect(notebook.cells.map((c) => c.id)).toEqual(['cell-1', 'cell-2']);
  });

  it('takes its identity from the filename, not the title', () => {
    // Observable Desktop titles every new notebook "untitled". A title-derived
    // id made two unrelated imports one notebook, the second replacing the
    // first in the library.
    const html = '<notebook><title>untitled</title><script type="module" pinned>1</script></notebook>';
    const a = parseObservableNotebook(html, 'taaiot.html').notebook;
    const b = parseObservableNotebook(html, 'template.html').notebook;
    expect(a.id).not.toBe(b.id);
    expect(a.name).toBe('untitled');
  });

  it('falls back to the title when there is no real filename', () => {
    expect(parseObservableNotebook('<notebook><title>My Piece</title></notebook>').notebook.id)
      .toBe('my-piece');
  });

  it('falls back to the filename when there is no title', () => {
    const { notebook } = parseObservableNotebook('<notebook><script type="module">1</script></notebook>', 'my-analysis.html');
    expect(notebook.name).toBe('My analysis');
  });

  it('folds an unpinned cell, because that is what its author asked for', () => {
    // Observable hides source unless a cell is pinned — the opposite of
    // Tangent's default, so ignoring the attribute would show code the author
    // deliberately put away.
    const { notebook } = parseObservableNotebook(
      '<notebook><script type="module">secret()</script><script type="module" pinned>shown()</script></notebook>'
    );
    expect(notebook.cells[0].collapsed).toBe(true);
    expect(notebook.cells[1].collapsed).toBeUndefined();
  });

  it('maps hidden to a collapsed output', () => {
    const { notebook } = parseObservableNotebook(
      '<notebook><script type="module" pinned hidden>rows</script></notebook>'
    );
    expect(notebook.cells[0].outputCollapsed).toBe(true);
  });

  it('carries a read-only notebook across as one, not as a lock per cell', () => {
    // Both formats lock whole notebooks, so this crosses exactly and reports
    // nothing. Stamping `readOnly` onto every cell said the same thing but was
    // no longer reversible as one act, nor recognisable as what the author
    // wrote.
    const { notebook, losses } = parseObservableNotebook(
      '<notebook readonly><script type="module" pinned>1</script></notebook>'
    );
    expect(notebook.readOnly).toBe(true);
    expect(notebook.cells[0].readOnly).toBeUndefined();
    expect(losses).toEqual([]);
  });

  it('keeps a foreign cell’s source but never runs it', () => {
    // Running SQL as JavaScript throws; dropping it loses the author's work.
    // Skipped keeps both promises.
    const { notebook, losses } = parseObservableNotebook(
      '<notebook><script type="application/sql" database="reporting">SELECT * FROM t</script></notebook>'
    );
    expect(notebook.cells[0].content).toBe('SELECT * FROM t');
    expect(notebook.cells[0].skipped).toBe(true);
    expect(kinds(losses)).toContain('SQL cell');
  });

  it('treats an unknown cell type the same way rather than guessing', () => {
    const { notebook, losses } = parseObservableNotebook(
      '<notebook><script type="application/vnd.future">whatever</script></notebook>'
    );
    expect(notebook.cells[0].skipped).toBe(true);
    expect(notebook.cells[0].content).toBe('whatever');
    expect(kinds(losses)).toContain('unknown cell type');
  });

  it('reports interpolation in prose, which Tangent renders literally', () => {
    // The single most common thing that breaks on the way in: `${…}` is how 2.0
    // gets dynamic values into Markdown, and Tangent's prose is static.
    const { losses } = parseObservableNotebook(
      '<notebook><script type="text/markdown">Hello, ${name}!</script></notebook>'
    );
    expect(kinds(losses)).toContain('interpolation in prose');
  });

  it('says nothing about prose that has no interpolation', () => {
    const { losses } = parseObservableNotebook(
      '<notebook><script type="text/markdown"># Plain heading</script></notebook>'
    );
    expect(losses).toEqual([]);
  });

  it('reports the runtime built-ins it cannot honour', () => {
    const { losses } = parseObservableNotebook(`<notebook>
  <script type="module" pinned>const n = view(Inputs.range([0, 10]))</script>
  <script type="module" pinned>const data = FileAttachment("d.csv").csv()</script>
  <script type="module" pinned>function* ticks() { yield 1; }</script>
</notebook>`);
    expect(kinds(losses)).toEqual(
      expect.arrayContaining(['view() input', 'FileAttachment', 'generator cell'])
    );
  });

  it('survives a file with no cells at all', () => {
    const { notebook, losses } = parseObservableNotebook('<notebook><title>Empty</title></notebook>');
    expect(notebook.cells).toEqual([]);
    expect(notebook.name).toBe('Empty');
    expect(losses).toEqual([]);
  });

  it('ignores an unterminated cell rather than swallowing the rest of the file', () => {
    const { notebook } = parseObservableNotebook(
      '<notebook><script type="module" pinned>1</script><script type="module">oops'
    );
    expect(notebook.cells).toHaveLength(1);
  });
});

describe('exporting', () => {
  it('writes the shape the spec describes', () => {
    const { html } = serializeObservableNotebook(
      nb([{ type: 'markdown', content: '# Hello, world!' }, { content: '1 + 2' }], 'Hello, world!')
    );
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<notebook>');
    expect(html).toContain('<title>Hello, world!</title>');
    expect(html).toContain('type="text/markdown"');
    expect(html).toContain('type="module"');
    expect(html.trimEnd().endsWith('</notebook>')).toBe(true);
  });

  it('pins code cells, or the export arrives with its code hidden', () => {
    // Observable's default is the opposite of Tangent's: no `pinned`, no source
    // on screen. An export that said nothing would look empty over there.
    const { html } = serializeObservableNotebook(nb([{ content: '1 + 2' }]));
    expect(html).toContain('type="module" pinned');
  });

  it('does not pin a cell the reader collapsed', () => {
    const { html } = serializeObservableNotebook(nb([{ content: 'setup()', collapsed: true }]));
    expect(html).toContain('type="module"');
    expect(html).not.toContain('pinned');
  });

  it('indents cell source by four spaces and escapes a script tag inside it', () => {
    const { html } = serializeObservableNotebook(
      nb([{ type: 'markdown', content: '<script>alert(1)</script>' }])
    );
    expect(html).toContain('    <script>alert(1)<\\/script>');
  });

  it('demotes a skipped cell to prose rather than letting it run', () => {
    // The format has no "never run this". Left as a code cell it would execute
    // on open, which is the one plainly wrong outcome.
    const { html, losses } = serializeObservableNotebook(
      nb([{ content: 'dropTable()', skipped: true }])
    );
    expect(html).not.toContain('type="module"');
    expect(html).toContain('type="text/markdown"');
    expect(html).toContain('dropTable()');
    expect(kinds(losses)).toContain('skipped cell');
  });

  it('exports a notebook-level lock as one', () => {
    const notebook = nb([{ content: 'a' }]);
    notebook.readOnly = true;
    const { html, losses } = serializeObservableNotebook(notebook);
    expect(html).toContain('<notebook readonly>');
    expect(losses).toEqual([]);
  });

  it('round-trips the lock', () => {
    const notebook = nb([{ content: 'a' }]);
    notebook.readOnly = true;
    const { html } = serializeObservableNotebook(notebook);
    expect(parseObservableNotebook(html).notebook.readOnly).toBe(true);
  });

  it('turns an all-locked notebook into a read-only one', () => {
    const { html, losses } = serializeObservableNotebook(
      nb([{ content: 'a', readOnly: true }, { content: 'b', readOnly: true }])
    );
    expect(html).toContain('<notebook readonly>');
    expect(kinds(losses)).not.toContain('locked cell');
  });

  it('reports a single locked cell, which has no equivalent', () => {
    const { html, losses } = serializeObservableNotebook(
      nb([{ content: 'a', readOnly: true }, { content: 'b' }])
    );
    expect(html).toContain('<notebook>');
    expect(kinds(losses)).toContain('locked cell');
  });

  it('reports the display state Observable has no word for', () => {
    const { losses } = serializeObservableNotebook(
      nb([
        { content: 'chart', outputWidth: 'full' },
        { content: 'rows', outputView: 'inspector' },
        { content: 'ui.slider("n", { max: 10 })' },
      ])
    );
    expect(kinds(losses)).toEqual(
      expect.arrayContaining(['output width', 'inspect view', 'ui.* input'])
    );
  });

  it('escapes the title rather than breaking the markup', () => {
    const { html } = serializeObservableNotebook(nb([], 'Fish & <chips>'));
    expect(html).toContain('<title>Fish &amp; &lt;chips&gt;</title>');
  });
});

describe('round-tripping', () => {
  it('brings a notebook back unchanged in everything that matters', () => {
    const original = nb(
      [
        { id: 'cell-1', type: 'markdown', content: '# Analysis\n\nSome prose.' },
        { id: 'cell-2', content: 'const data = [1, 2, 3];' },
        { id: 'cell-3', content: 'data.map((d) => d * 2)', collapsed: true },
        { id: 'cell-4', content: 'chart', outputCollapsed: true },
      ],
      'Analysis'
    );
    const { html } = serializeObservableNotebook(original);
    const { notebook: back } = parseObservableNotebook(html);

    expect(back.name).toBe('Analysis');
    expect(back.cells.map((c) => c.id)).toEqual(['cell-1', 'cell-2', 'cell-3', 'cell-4']);
    expect(back.cells.map((c) => c.type)).toEqual(['markdown', 'code', 'code', 'code']);
    expect(back.cells.map((c) => c.content)).toEqual(original.cells.map((c) => c.content));
    expect(back.cells[2].collapsed).toBe(true);
    expect(back.cells[3].outputCollapsed).toBe(true);
    // Not collapsed, and never claimed to be.
    expect(back.cells[1].collapsed).toBeUndefined();
  });

  it('keeps code that contains the tricky sequences', () => {
    const source = 'const t = "</script>";\nconst re = /a\\/b/;';
    const { html } = serializeObservableNotebook(nb([{ content: source }]));
    const { notebook } = parseObservableNotebook(html);
    expect(notebook.cells[0].content).toBe(source);
  });
});

describe('summarizeLosses', () => {
  it('collapses repeats into one line with a count and the places', () => {
    const lines = summarizeLosses([
      { kind: 'SQL cell', where: 'cell 2', detail: 'kept but skipped' },
      { kind: 'SQL cell', where: 'cell 5', detail: 'kept but skipped' },
      { kind: 'theme', detail: 'dropped' },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('SQL cell ×2 (cell 2, cell 5): kept but skipped');
    expect(lines[1]).toBe('theme: dropped');
  });

  it('is empty for a clean conversion', () => {
    expect(summarizeLosses([])).toEqual([]);
  });
});

describe('choosing a format by the file', () => {
  it('reads an Observable file, and Tangent’s own, each with its own parser', async () => {
    const { parseNotebookFile, serializeForPath } = await import('../fileOperations');

    const observable = parseNotebookFile(HELLO, 'hello.html');
    expect(observable.notebook.cells).toHaveLength(2);

    const tangent = parseNotebookFile('// ---\n// title: T\n// ---\n\n// %% [javascript]\n1 + 1\n', 't.js');
    expect(tangent.notebook.name).toBe('T');
    expect(tangent.losses).toEqual([]);
  });

  it('recognises an Observable notebook that is not named .html', () => {
    // A link to a notebook is as likely to end in a path segment as in .html.
    expect(looksLikeObservableNotebook(HELLO.slice(0, 2000))).toBe(true);
  });

  it('refuses HTML that is not a notebook rather than making an empty one', async () => {
    const { parseNotebookFile } = await import('../fileOperations');
    expect(() => parseNotebookFile('<!doctype html><html><body>404', 'page.html')).toThrow(
      /isn’t an Observable notebook/
    );
  });

  it('writes back the format the file is in', async () => {
    const { serializeForPath } = await import('../fileOperations');
    const notebook = nb([{ content: '1 + 1' }], 'Round trip');

    // Saving Tangent's .js source into someone's Observable .html would
    // destroy it; this is the guard against that.
    expect(serializeForPath(notebook, '/n/a.html').content).toContain('<notebook>');
    expect(serializeForPath(notebook, '/n/a.js').content).toContain('// %% [javascript]');
  });

  it('reports what an in-place save to .html would lose', async () => {
    const { serializeForPath } = await import('../fileOperations');
    const notebook = nb([{ content: 'dropTable()', skipped: true }]);
    expect(kinds(serializeForPath(notebook, '/n/a.html').losses)).toContain('skipped cell');
    expect(serializeForPath(notebook, '/n/a.js').losses).toEqual([]);
  });
});

describe('the .js writer, reached through an Observable import', () => {
  it('does not lose cells whose prose carries a section break', async () => {
    // Found by round-tripping a real Observable notebook through Tangent's own
    // format: 44 cells went in and 16 came back, because the guide's prose uses
    // `---` between sections.
    const { parseNotebookFile, serializeForPath } = await import('../fileOperations');
    const html = `<notebook><title>Guide</title>
  <script id="1" type="text/markdown">
    ---

    ## Installing
  </script>
  <script id="2" type="module" pinned>
    npm.install()
  </script>
</notebook>`;
    const { notebook } = parseObservableNotebook(html);
    const js = serializeForPath(notebook, '/x/guide.js').content;
    const back = parseNotebookFile(js, 'guide.js').notebook;

    expect(back.cells).toHaveLength(2);
    expect(back.cells[1].content).toBe('npm.install()');
  });
});
