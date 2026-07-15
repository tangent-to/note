import { describe, it, expect } from 'vitest';
import { extractLastExpression as extract } from '../jsExecutor';

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
