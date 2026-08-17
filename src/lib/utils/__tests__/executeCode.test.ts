/**
 * End-to-end checks for JavaScriptExecutor.executeCode.
 *
 * Runs in plain Node with the same linkedom-backed globals the worker kernel
 * installs (see workers/kernel.worker.ts), which is enough for cells that only
 * touch data — no real browser needed.
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
  const executor = new JavaScriptExecutor();
  const output = await executor.executeCode(code);
  return { output, vars: executor.getVariables() };
}

describe('executeCode', () => {
  const TRACK = [
    'const track = [',
    '    { pitch: 60, duration: 1, time: 0, velocity: 0.8 }, // C',
    '    { pitch: 62, duration: 1, time: 1, velocity: 0.8 }, // D',
    '    { pitch: 64, duration: 1, time: 2, velocity: 0.8 }, // E',
    '];',
  ].join('\n');

  it('defines a multi-line declaration with no trailing reference', async () => {
    // Regression: this failed with "expected expression, got keyword 'const'",
    // and the variable was only defined if the cell ended in a bare `track`.
    const { output, vars } = await run(TRACK);
    expect(output.type).not.toBe('error');
    expect(vars.track).toHaveLength(3);
    expect(vars.track[0].pitch).toBe(60);
  });

  it('still displays the value when the cell ends in a reference', async () => {
    const { output, vars } = await run(`${TRACK}\ntrack.length`);
    expect(output.type).toBe('text');
    expect(String(output.content)).toContain('3');
    expect(vars.track).toHaveLength(3);
  });

  it('defines a multi-line let bound to a multi-line call', async () => {
    const { output, vars } = await run('let total = [1, 2, 3].reduce(\n  (a, b) => a + b,\n  0\n);');
    expect(output.type).not.toBe('error');
    expect(vars.total).toBe(6);
  });

  it('runs a trailing block statement and keeps its declarations', async () => {
    const { output, vars } = await run('const xs = [];\nfor (const i of [1, 2]) {\n  xs.push(i * 2);\n}');
    expect(output.type).not.toBe('error');
    expect(vars.xs).toEqual([2, 4]);
  });

  it('displays a trailing multi-line expression', async () => {
    const { output } = await run('const n = 2;\n[1, 2, 3]\n  .map(x => x * n)\n  .join(",")');
    expect(String(output.content)).toContain('2,4,6');
  });

  // Hoisting is driven by the same parse as the dependency analysis, so what a
  // cell is reported to define and what it actually shares cannot drift apart.
  it('shares every declarator of a multi-name declaration', async () => {
    const { vars } = await run('const width = 640, height = 400;');
    expect(vars.width).toBe(640);
    expect(vars.height).toBe(400);   // the regex rewrote only the first name
  });

  it('shares an indented top-level declaration', async () => {
    const { vars } = await run('  const indented = 7;');
    expect(vars.indented).toBe(7);
  });

  it('shares a declaration with no initialiser', async () => {
    const { vars } = await run('let pending;');
    expect(Object.prototype.hasOwnProperty.call(vars, 'pending')).toBe(true);
    expect(vars.pending).toBeUndefined();
  });

  it('leaves a declaration inside a template literal untouched', async () => {
    // The regex rewrote this into the string, corrupting the value.
    const { vars } = await run('const snippet = `\nconst inner = 1\n`;');
    expect(vars.snippet).toBe('\nconst inner = 1\n');
    expect(Object.prototype.hasOwnProperty.call(vars, 'inner')).toBe(false);
  });

  it('keeps declarations nested in a function private to the cell', async () => {
    const { vars } = await run('function make() {\n  const secret = 1;\n  return secret;\n}\nmake();');
    expect(typeof vars.make).toBe('function');
    expect(Object.prototype.hasOwnProperty.call(vars, 'secret')).toBe(false);
  });

  it('reports a syntax error instead of mangling the cell', async () => {
    const { output } = await run('const oops = ;');
    expect(output.type).toBe('error');
  });

  it('makes a declared variable readable in a later cell', async () => {
    const { JavaScriptExecutor } = await import('../jsExecutor');
    const executor = new JavaScriptExecutor();
    await executor.executeCode('const base = [1, 2, 3];');
    const second = await executor.executeCode('base.map(n => n * 2)');
    expect(String(second.content)).toContain('2');
    expect(String(second.content)).toContain('6');
  });
});
