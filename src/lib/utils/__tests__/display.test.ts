/**
 * Observable's `display`, in Tangent.
 *
 * Observable's display is a list — call it as often as you like, anywhere in a
 * cell — while Tangent's cell output is one typed thing, captured from the
 * cell's last expression. Rather than pick one model, the list decides the
 * shape: one displayed value becomes the cell's value and keeps its full
 * rendering, several stack into one DOM output.
 *
 * The shapes below are the ones `display` actually takes in real notebooks. The
 * obvious shim — `const display = (v) => v` — handles only the first two and
 * fails *silently* on the rest, which is why it isn't what this does.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { parseHTML } from 'linkedom';

const g = globalThis as any;

beforeAll(() => {
  const dom = parseHTML('<!doctype html><html><head></head><body></body></html>');
  g.document = dom.document;
  for (const key of ['Node', 'Element', 'HTMLElement', 'Text', 'CustomEvent'] as const) {
    if ((dom as any)[key] && !g[key]) g[key] = (dom as any)[key];
  }
  if (!g.window) g.window = g;
});

async function run(code: string) {
  const { JavaScriptExecutor } = await import('../jsExecutor');
  return new JavaScriptExecutor().executeCode(code);
}

const text = (output: any) => String(output.content ?? '');

describe('one displayed value keeps its typed rendering', () => {
  it('shows a trailing display', async () => {
    const out = await run('display("hello");');
    expect(out.type).toBe('text');
    expect(text(out)).toBe('hello');
  });

  it('shows a display that is not the last statement', async () => {
    // `display = v => v` shows nothing here: the captured last expression is
    // the console.log, not the display.
    const out = await run('display("first");\nconst done = true;');
    expect(text(out)).toBe('first');
  });

  it('shows a display from inside a block', async () => {
    // And nothing here either: a block is not a displayable expression.
    const out = await run('if (true) { display("inside"); }');
    expect(text(out)).toBe('inside');
  });

  it('renders a displayed frame as the sortable table, not as text', async () => {
    // The point of the single-value regime: routing every display through the
    // DOM would have cost this its table.
    const out = await run('display([{ a: 1, b: "x" }, { a: 2, b: "y" }]);');
    expect(out.type).toBe('table');
    const spec = JSON.parse(text(out));
    expect(spec.columns).toEqual(['a', 'b']);
    expect(spec.totalRows).toBe(2);
  });

  it('renders a displayed node as the node itself', async () => {
    const out = await run('const p = document.createElement("p");\np.textContent = "live";\ndisplay(p);');
    expect(out.type).toBe('dom');
    expect((out.content as any).outerHTML).toBe('<p>live</p>');
  });
});

describe('several displayed values stack', () => {
  it('keeps both, in the order they were displayed', async () => {
    // `display = v => v` keeps only the second.
    const out = await run('display("first");\ndisplay("second");');
    expect(out.type).toBe('dom');
    const html = (out.content as any).outerHTML;
    expect(html).toContain('first');
    expect(html).toContain('second');
    expect(html.indexOf('first')).toBeLessThan(html.indexOf('second'));
  });

  it('works from a loop, where the shim shows nothing at all', async () => {
    const out = await run('for (const n of [1, 2, 3]) display(n);');
    const html = (out.content as any).outerHTML;
    for (const n of ['1', '2', '3']) expect(html).toContain(n);
  });

  it('shows the cell’s own last expression alongside what it displayed', async () => {
    const out = await run('display("shown");\n"trailing"');
    const html = (out.content as any).outerHTML;
    expect(html).toContain('shown');
    expect(html).toContain('trailing');
  });

  it('mixes nodes and plain values', async () => {
    const out = await run(
      'const p = document.createElement("p");\np.textContent = "node";\ndisplay(p);\ndisplay(42);'
    );
    const html = (out.content as any).outerHTML;
    expect(html).toContain('<p>node</p>');
    expect(html).toContain('42');
  });

  it('takes several values in one call, as Observable does', async () => {
    const out = await run('display("a", "b");');
    const html = (out.content as any).outerHTML;
    expect(html).toContain('a');
    expect(html).toContain('b');
  });
});

describe('what display does not change', () => {
  it('leaves an ordinary cell exactly as it was', async () => {
    expect(text(await run('1 + 2'))).toBe('3');
    expect(text(await run('const x = 5;\nx * 2'))).toBe('10');
    expect((await run('const y = 1;')).type).toBe('text');
  });

  it('does not show a value the cell only computed', async () => {
    // display() returns undefined on purpose: if it returned its argument, a
    // trailing display would be captured as the last expression as well, and
    // two calls would leave only the second.
    const out = await run('const v = display("once");\nv');
    const html = out.type === 'dom' ? (out.content as any).outerHTML : text(out);
    expect(html).toContain('once');
    expect(html.match(/once/g)).toHaveLength(1);
  });

  it('lets a cell define its own display without being overwritten', async () => {
    // seedBuiltin backs off once a cell assigns the name itself.
    const out = await run('const display = (v) => `custom:${v}`;\ndisplay("x")');
    expect(text(out)).toBe('custom:x');
  });

  it('forgets the previous run’s list', async () => {
    const { JavaScriptExecutor } = await import('../jsExecutor');
    const executor = new JavaScriptExecutor();
    await executor.executeCode('display("old");');
    const out = await executor.executeCode('"new"');
    expect(text(out)).toBe('new');
  });
});

describe('the Variables panel', () => {
  it('does not list display, which is API rather than data', async () => {
    const { JavaScriptExecutor } = await import('../jsExecutor');
    const executor = new JavaScriptExecutor();
    await executor.executeCode('const rows = [1, 2];\ndisplay(rows);');
    const vars = executor.getVariables();
    expect(Object.keys(vars)).toContain('rows');
    expect(Object.keys(vars)).not.toContain('display');
  });

  it('does list a display the reader defined themselves', async () => {
    const { JavaScriptExecutor } = await import('../jsExecutor');
    const executor = new JavaScriptExecutor();
    await executor.executeCode('const display = (v) => v;');
    expect(Object.keys(executor.getVariables())).toContain('display');
  });

  it('still lists a value builtin like width', async () => {
    const { JavaScriptExecutor } = await import('../jsExecutor');
    const executor = new JavaScriptExecutor();
    executor.setBuiltin('width', 640);
    expect(executor.getVariables().width).toBe(640);
  });
});
