import { describe, it, expect } from 'vitest';
import { serializeNotebook, parseNotebook, getNotebookFilename } from '../notebookFormat';
import type { Notebook } from '../../types/notebook';

function makeNotebook(overrides: Partial<Notebook> = {}): Notebook {
  return {
    id: 'test-notebook',
    name: 'Test Notebook',
    cells: [
      { id: 'cell-1', type: 'code', content: 'const x = 1;' },
      { id: 'cell-2', type: 'markdown', content: '# Hello World' },
      { id: 'cell-3', type: 'code', content: 'console.log(x)' },
    ],
    createdAt: 1000000,
    updatedAt: 2000000,
    ...overrides,
  };
}

describe('serializeNotebook', () => {
  it('produces valid header with title and id', () => {
    const notebook = makeNotebook();
    const output = serializeNotebook(notebook);
    expect(output).toContain('// title: Test Notebook');
    expect(output).toContain('// id: test-notebook');
  });

  it('uses correct cell delimiters', () => {
    const notebook = makeNotebook();
    const output = serializeNotebook(notebook);
    expect(output).toContain('// %% [javascript]');
    expect(output).toContain('// %% [markdown]');
  });

  it('line-comments markdown (jupytext-native form)', () => {
    const notebook = makeNotebook();
    const output = serializeNotebook(notebook);
    expect(output).toContain('// # Hello World');
    // no /* */ block delimiters for markdown any more
    expect(output).not.toContain('/*');
    expect(output).not.toContain('*/');
  });

  it('includes code content directly', () => {
    const notebook = makeNotebook();
    const output = serializeNotebook(notebook);
    expect(output).toContain('const x = 1;');
    expect(output).toContain('console.log(x)');
  });

  it('tags collapsed cells with #collapse-cell on the delimiter', () => {
    const notebook = makeNotebook({
      cells: [
        { id: 'cell-1', type: 'code', content: 'const x = 1;', collapsed: true },
        { id: 'cell-2', type: 'markdown', content: '# Hi', collapsed: true },
        { id: 'cell-3', type: 'code', content: 'x' },
      ],
    });
    const output = serializeNotebook(notebook);
    expect(output).toContain('// %% [javascript] #collapse-cell\nconst x = 1;');
    expect(output).toContain('// %% [markdown] #collapse-cell');
    expect(output).toContain('// %% [javascript]\nx');
  });

  it('serializes combined cell tags', () => {
    const notebook = makeNotebook({
      cells: [
        {
          id: 'cell-1',
          type: 'code',
          content: 'const x = 1;',
          collapsed: true,
          skipped: true,
          outputCollapsed: true,
          readOnly: true,
        },
      ],
    });
    const output = serializeNotebook(notebook);
    expect(output).toContain('// %% [javascript] #collapse-cell #collapse-output #skip #readonly');
  });

  it('handles empty cells', () => {
    const notebook = makeNotebook({
      cells: [{ id: 'cell-1', type: 'code', content: '' }],
    });
    const output = serializeNotebook(notebook);
    expect(output).toContain('// %% [javascript]');
  });

  it('handles notebook with only markdown', () => {
    const notebook = makeNotebook({
      cells: [{ id: 'cell-1', type: 'markdown', content: 'Some text' }],
    });
    const output = serializeNotebook(notebook);
    expect(output).toContain('// %% [markdown]');
    expect(output).toContain('Some text');
  });
});

describe('parseNotebook', () => {
  it('round-trips through serialize/parse', () => {
    const original = makeNotebook();
    const serialized = serializeNotebook(original);
    const parsed = parseNotebook(serialized, 'test.js');

    expect(parsed.name).toBe('Test Notebook');
    expect(parsed.id).toBe('test-notebook');
    expect(parsed.cells).toHaveLength(3);
    expect(parsed.cells[0].type).toBe('code');
    expect(parsed.cells[0].content).toBe('const x = 1;');
    expect(parsed.cells[1].type).toBe('markdown');
    expect(parsed.cells[1].content).toBe('# Hello World');
    expect(parsed.cells[2].type).toBe('code');
    expect(parsed.cells[2].content).toBe('console.log(x)');
  });

  it('creates a default cell when input is empty', () => {
    const parsed = parseNotebook('', 'empty.js');
    expect(parsed.cells).toHaveLength(1);
    expect(parsed.cells[0].type).toBe('code');
  });

  it('accepts #hide, #hide-cell, and #hide-output as legacy aliases', () => {
    const parsed = parseNotebook(
      '// %% [javascript] #hide\na\n\n// %% [javascript] #hide-cell\nb\n\n// %% [javascript] #hide-output\nc',
      'test.js'
    );
    expect(parsed.cells[0].collapsed).toBe(true);
    expect(parsed.cells[1].collapsed).toBe(true);
    expect(parsed.cells[2].outputCollapsed).toBe(true);
    expect(parsed.cells[2].collapsed).toBeUndefined();
  });

  it('round-trips the collapsed state via the #collapse-cell tag', () => {
    const original = makeNotebook({
      cells: [
        { id: 'cell-1', type: 'code', content: 'const x = 1;', collapsed: true },
        { id: 'cell-2', type: 'code', content: 'x + 1' },
      ],
    });
    const parsed = parseNotebook(serializeNotebook(original), 'test.js');
    expect(parsed.cells[0].collapsed).toBe(true);
    expect(parsed.cells[1].collapsed).toBeUndefined();
  });

  it('round-trips skip, collapse-output, and readonly tags', () => {
    const original = makeNotebook({
      cells: [
        { id: 'cell-1', type: 'code', content: 'a', skipped: true },
        { id: 'cell-2', type: 'code', content: 'b', outputCollapsed: true },
        { id: 'cell-3', type: 'code', content: 'c', readOnly: true },
        { id: 'cell-4', type: 'code', content: 'd' },
      ],
    });
    const parsed = parseNotebook(serializeNotebook(original), 'test.js');
    expect(parsed.cells[0].skipped).toBe(true);
    expect(parsed.cells[1].outputCollapsed).toBe(true);
    expect(parsed.cells[2].readOnly).toBe(true);
    expect(parsed.cells[3].skipped).toBeUndefined();
    expect(parsed.cells[3].outputCollapsed).toBeUndefined();
    expect(parsed.cells[3].readOnly).toBeUndefined();
  });

  it('does not confuse #collapse-output with #collapse-cell', () => {
    const parsed = parseNotebook('// %% [javascript] #collapse-output\nconst x = 1;', 'test.js');
    expect(parsed.cells[0].outputCollapsed).toBe(true);
    expect(parsed.cells[0].collapsed).toBeUndefined();
  });

  it('extracts title from header', () => {
    const content = `// ---
// title: My Notebook
// id: my-nb
// ---

// %% [javascript]
42`;
    const parsed = parseNotebook(content);
    expect(parsed.name).toBe('My Notebook');
    expect(parsed.id).toBe('my-nb');
  });

  it('uses filename as fallback title', () => {
    const content = `// %% [javascript]
hello`;
    const parsed = parseNotebook(content, 'my-analysis.js');
    expect(parsed.name).toBe('my-analysis');
  });
});

describe('getNotebookFilename', () => {
  it('generates sanitized filename', () => {
    const nb = makeNotebook({ name: 'My Cool Notebook!' });
    expect(getNotebookFilename(nb)).toBe('my-cool-notebook-.js');
  });

  it('handles empty name', () => {
    const nb = makeNotebook({ name: '' });
    expect(getNotebookFilename(nb)).toBe('untitled.js');
  });
});

describe('parseNotebook - Jupyter/jupytext-commented markdown', () => {
  it('recovers markdown from //-commented cells (with wrapping /* */)', () => {
    // What jupytext writes when it round-trips a note markdown cell: every line
    // line-commented, including the /* */ delimiters.
    const src = [
      '// %% [markdown]',
      '// /*',
      '// ## Section title',
      '//',
      '// A paragraph of prose.',
      '// */',
      '',
      '// %% [javascript]',
      'const x = 1;',
    ].join('\n');
    const nb = parseNotebook(src, 'nb.js');
    const md = nb.cells.find((c) => c.type === 'markdown');
    expect(md).toBeTruthy();
    expect(md!.content).toBe('## Section title\n\nA paragraph of prose.');
    expect(nb.cells.find((c) => c.type === 'code')!.content).toBe('const x = 1;');
  });

  it('recovers markdown from //-commented cells without /* */ delimiters', () => {
    const src = [
      '// %% [markdown]',
      '// # Heading',
      '// text',
      '// %% [javascript]',
      'const y = 2;',
    ].join('\n');
    const nb = parseNotebook(src, 'nb.js');
    expect(nb.cells.find((c) => c.type === 'markdown')!.content).toBe('# Heading\ntext');
  });

  it('still parses the native /* */ markdown block unchanged', () => {
    const src = [
      '// %% [markdown]',
      '/*',
      '## Native',
      'body',
      '*/',
      '// %% [javascript]',
      'const z = 3;',
    ].join('\n');
    const nb = parseNotebook(src, 'nb.js');
    expect(nb.cells.find((c) => c.type === 'markdown')!.content).toBe('## Native\nbody');
  });

  it('round-trips: serialize then parse a jupytext-commented file', () => {
    const commented = [
      '// %% [markdown]',
      '// /*',
      '// hello',
      '// */',
    ].join('\n');
    const nb = parseNotebook(commented, 'nb.js');
    const out = serializeNotebook(nb);
    expect(out).toContain('// hello');
    // and re-parsing the serialized output is stable
    expect(parseNotebook(out, 'nb.js').cells.find((c) => c.type === 'markdown')!.content).toBe('hello');
  });
});

describe('markdown serialization round-trip (// form)', () => {
  it('content -> serialize -> parse is lossless (headings, blanks, code fences)', () => {
    const md = '## Title\n\nA paragraph with a `code span`.\n\n- bullet 1\n- bullet 2\n\n    indented code line';
    const nb = makeNotebook({ cells: [{ id: 'm', type: 'markdown', content: md }] });
    const out = serializeNotebook(nb);
    // written as // lines, no block delimiters
    expect(out).toContain('// ## Title');
    expect(out).toContain('//\n'); // blank line as bare //
    const back = parseNotebook(out, 'nb.js').cells.find((c) => c.type === 'markdown')!.content;
    expect(back).toBe(md);
  });

  it('preserves a markdown line that itself starts with //', () => {
    const md = '// this is literally in the text';
    const nb = makeNotebook({ cells: [{ id: 'm', type: 'markdown', content: md }] });
    const back = parseNotebook(serializeNotebook(nb), 'nb.js').cells.find((c) => c.type === 'markdown')!.content;
    expect(back).toBe(md);
  });
});

// The import / URL-load path uses parseJSNotebook (a second parser); it must
// handle the // markdown form too, or imported files show blank markdown cells.
import { parseJSNotebook } from '../fileOperations';

describe('parseJSNotebook - markdown formats', () => {
  it('reads //-commented markdown (the format note now writes)', () => {
    const src = [
      '// ---', '// title: T', '// id: t', '// ---', '',
      '// %% [markdown]',
      '// ## Heading',
      '//',
      '// body',
      '',
      '// %% [javascript]',
      'const x = 1;',
    ].join('\n');
    const nb = parseJSNotebook(src, 't.js');
    const md = nb.cells.find((c: any) => c.type === 'markdown');
    expect(md.content).toBe('## Heading\n\nbody');
    expect(nb.cells.find((c: any) => c.type === 'code').content).toBe('const x = 1;');
  });

  it('still reads the legacy /* */ markdown block', () => {
    const src = ['// %% [markdown]', '/*', '## Old', 'body', '*/', '// %% [javascript]', 'a'].join('\n');
    expect(parseJSNotebook(src, 't.js').cells.find((c: any) => c.type === 'markdown').content).toBe('## Old\nbody');
  });
});
