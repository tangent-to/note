import { describe, it, expect } from 'vitest';
import { slugify, parseJSNotebook } from '../fileOperations';

describe('slugify', () => {
  it('converts to lowercase with dashes', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('strips leading and trailing dashes', () => {
    expect(slugify('--hello--')).toBe('hello');
  });

  it('replaces multiple special chars with single dash', () => {
    expect(slugify('foo@#$bar')).toBe('foo-bar');
  });

  it('returns "notebook" for empty input', () => {
    expect(slugify('')).toBe('notebook');
  });
});

describe('parseJSNotebook', () => {
  it('marks cells tagged #hide-cell as collapsed', () => {
    const text = `// %% [javascript] #hide-cell
const secret = 42;

// %% [javascript]
secret * 2

// %% [markdown] #hide-cell
/*
# Hidden notes
*/`;
    const nb = parseJSNotebook(text, 'test.js');
    expect(nb.cells).toHaveLength(3);
    expect(nb.cells[0].collapsed).toBe(true);
    expect(nb.cells[0].content).toBe('const secret = 42;');
    expect(nb.cells[1].collapsed).toBeUndefined();
    expect(nb.cells[2].collapsed).toBe(true);
  });

  it('parses #skip, #hide-output, and #readonly tags', () => {
    const text = `// %% [javascript] #skip
legacy();

// %% [javascript] #hide-output #readonly
setup();`;
    const nb = parseJSNotebook(text, 'test.js');
    expect(nb.cells[0].skipped).toBe(true);
    expect(nb.cells[0].collapsed).toBeUndefined();
    expect(nb.cells[1].outputCollapsed).toBe(true);
    expect(nb.cells[1].readOnly).toBe(true);
    expect(nb.cells[1].collapsed).toBeUndefined();
  });

  it('parses a simple JS notebook', () => {
    const text = `// ---
// title: Test
// id: test-id
// ---

// %% [javascript]
const a = 1;

// %% [markdown]
/*
# Title
*/

// %% [javascript]
console.log(a);`;

    const nb = parseJSNotebook(text, 'test.js');
    expect(nb.name).toBe('Test');
    expect(nb.id).toBe('test-id');
    expect(nb.cells).toHaveLength(3);
    expect(nb.cells[0].type).toBe('code');
    expect(nb.cells[0].content).toBe('const a = 1;');
    expect(nb.cells[1].type).toBe('markdown');
    expect(nb.cells[1].content).toBe('# Title');
    expect(nb.cells[2].type).toBe('code');
    expect(nb.cells[2].content).toBe('console.log(a);');
  });

  it('derives name from filename when no title', () => {
    const text = `// %% [javascript]
42`;
    const nb = parseJSNotebook(text, 'climate-data.js');
    expect(nb.name).toBe('Climate data');
  });

  it('handles empty input', () => {
    const nb = parseJSNotebook('', 'empty.js');
    expect(nb.cells).toHaveLength(0);
  });

  it('handles multiple code cells', () => {
    const text = `// %% [javascript]
const a = 1

// %% [javascript]
const b = 2

// %% [javascript]
a + b`;

    const nb = parseJSNotebook(text);
    expect(nb.cells).toHaveLength(3);
    expect(nb.cells[2].content).toBe('a + b');
  });
});
