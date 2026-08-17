import { describe, it, expect } from 'vitest';
import { extractLastExpression as extract, isDisplayableExpression } from '../jsExecutor';

describe('extractLastExpression', () => {
  it('captures a simple trailing expression', () => {
    const cap = extract('const a = 1;\na + 2');
    expect(cap?.expression.trim()).toBe('a + 2');
  });

  it('captures a whole method chain that breaks across lines', () => {
    // Regression: a leading-dot continuation line must not be treated as the
    // whole expression (which parsed as "expected expression, got '.'").
    const code = [
      'ds.plot.ordiplot(model, {',
      '  type: "rda", width: 640,',
      '})',
      '  .show(Plot);',
    ].join('\n');
    const cap = extract(code);
    expect(cap).not.toBeNull();
    expect(cap!.expression.trim().startsWith('ds.plot.ordiplot')).toBe(true);
    expect(cap!.expression).toContain('.show(Plot)');
    // nothing dangling before it in this single-statement cell
    expect(cap!.before.trim()).toBe('');
  });

  it('captures a multi-line chain that follows earlier statements', () => {
    const code = [
      'const model = fit(data);',
      'model',
      '  .summary()',
      '  .toTable()',
    ].join('\n');
    const cap = extract(code);
    expect(cap).not.toBeNull();
    expect(cap!.expression.trim().startsWith('model')).toBe(true);
    expect(cap!.expression).toContain('.toTable()');
    expect(cap!.before).toContain('const model = fit(data);');
  });

  it('still stops at an explicit semicolon (no chain merge across statements)', () => {
    const code = 'foo();\n.bar';   // pathological; `;` is a hard boundary
    const cap = extract(code);
    // the trailing `.bar` after a `;` is its own (invalid) fragment, not merged
    expect(cap?.expression.trim()).toBe('.bar');
  });

  it('displays a last expression that contains a template literal', () => {
    // Regression: a backtick in the final expression (e.g. a plot title with
    // ${...}) must not make capture bail — the cell would silently not display.
    const cap = extract('Plot.plot({\n  title: `Yield ${k.toFixed(0)} kg`,\n  marks: [],\n})');
    expect(cap).not.toBeNull();
    expect(cap!.expression).toContain('Plot.plot');
  });

  it('handles a chain whose override arg carries a backtick title', () => {
    const cap = extract('ds.plot.ordiplot(m, {})\n  .show(Plot, { title: `RDA ${p.toFixed(3)}` })');
    expect(cap).not.toBeNull();
    expect(cap!.expression).toContain('ordiplot');
    expect(cap!.expression).toContain('.show');
  });

  it('handles nested template interpolation', () => {
    const cap = extract('render(`a ${b(`c ${d}`)} e`)');
    expect(cap).not.toBeNull();
    expect(cap!.expression).toContain('render');
  });

  it('does not treat ; inside a string or template as a boundary', () => {
    const cap = extract('const s = "a;b";\nrun(`x;${y}`)');
    expect(cap).not.toBeNull();
    expect(cap!.expression.trim()).toBe('run(`x;${y}`)');
  });
});

describe('isDisplayableExpression', () => {
  // A cell that is only a declaration must run as written. Wrapping it for
  // last-value display produced "expected expression, got keyword 'const'".
  const MULTILINE_DECL = [
    'const track = [',
    '    { pitch: 60, duration: 1, time: 0, velocity: 0.8 }, // C',
    '    { pitch: 62, duration: 1, time: 1, velocity: 0.8 }, // D',
    '];',
  ].join('\n');

  it('rejects a multi-line const declaration (the reported regression)', () => {
    const cap = extract(MULTILINE_DECL);
    // The whole cell is the candidate: there is no top-level boundary inside the
    // array literal, and the final line `];` used to look like an expression.
    expect(cap!.expression.trim().startsWith('const track')).toBe(true);
    expect(isDisplayableExpression(cap!.expression)).toBe(false);
  });

  it('rejects a multi-line let declaration ending in a call', () => {
    const code = 'let total = xs.reduce(\n  (a, b) => a + b,\n  0\n);';
    expect(isDisplayableExpression(extract(code)!.expression)).toBe(false);
  });

  it('still displays a trailing reference after a multi-line declaration', () => {
    const cap = extract(`${MULTILINE_DECL}\ntrack`);
    expect(cap!.expression.trim()).toBe('track');
    expect(isDisplayableExpression(cap!.expression)).toBe(true);
    expect(cap!.before).toContain('const track = [');
  });

  it.each([
    ['const x = 1', false],
    ['function foo() { return 1 }', false],
    ['async function foo() {}', false],
    ['class A {}', false],
    ['if (a) { b() }', false],
    ['for (const x of xs) { f(x) }', false],
    ['return 1', false],
    ['x = 5', false],
    ['window.foo = bar', false],
    ['count += 1', false],
    ['', false],
    ['  ;;  ', false],
    ['a + 2', true],
    ['track', true],
    ['a === b', true],
    ['a <= b', true],
    ['f(x)', true],
    ['await load()', true],
    // Dynamic import is an expression; an `import …` statement is not.
    ['import("d3")', true],
    ['import * as d3 from "d3"', false],
    ['Plot.plot({ marks: [] })', true],
    // A nested `=` must not suppress display: default params and declarations
    // inside a callback body are not top-level assignments.
    ['xs.map((x, i = 0) => x + i)', true],
    ['xs.map(x => { const y = x * 2; return y })', true],
  ])('%j → %s', (code, expected) => {
    expect(isDisplayableExpression(code as string)).toBe(expected);
  });

  it('ignores = inside strings, templates and comments', () => {
    expect(isDisplayableExpression('f("a = b")')).toBe(true);
    expect(isDisplayableExpression('f(`a = ${b}`)')).toBe(true);
    expect(isDisplayableExpression('f(x) // y = 1')).toBe(true);
  });
});
