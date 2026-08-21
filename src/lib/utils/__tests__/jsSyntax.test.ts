import { describe, it, expect } from 'vitest';
import {
  freeIdentifiers,
  hasSyntaxErrors,
  topLevelDeclarations,
  topLevelDefinitions,
  topLevelNamesToCopy,
} from '../jsSyntax';

const defs = (code: string) => [...topLevelDefinitions(code)].sort();
const free = (code: string) => [...freeIdentifiers(code)].sort();

describe('topLevelDefinitions', () => {
  it('finds declarations, functions, classes and every declarator', () => {
    expect(defs('const a = 1, b = 2;\nlet c;\nvar d = 3;\nfunction f() {}\nclass G {}'))
      .toEqual(['G', 'a', 'b', 'c', 'd', 'f']);
  });

  it('finds destructuring bindings, including shorthand and rest', () => {
    expect(defs('const { x, y: z, w = 1, ...others } = o;\nconst [p, , q] = arr;'))
      .toEqual(['others', 'p', 'q', 'w', 'x', 'z']);
  });

  it('ignores declarations nested in functions, blocks and loops', () => {
    expect(defs('function f(p) { const inner = p; }\nif (c) { const b = 1; }\nfor (const r of rs) {}'))
      .toEqual(['f']);
  });

  it('ignores code inside strings, template literals and comments', () => {
    // The regex scanner rewrote/counted these; a parse cannot.
    expect(defs('const sql = `\nconst injected = 1\n`;\n// const commented = 2\n/* const block = 3 */'))
      .toEqual(['sql']);
  });

  it('sees an indented top-level declaration', () => {
    expect(defs('  const indented = 1;')).toEqual(['indented']);
  });

  it('looks through export wrappers', () => {
    expect(defs('export const shared = 1;\nexport function fn() {}')).toEqual(['fn', 'shared']);
  });

  it('collects import bindings', () => {
    expect(defs('import * as aq from "arquero";\nimport Plot, { plot as p } from "@observablehq/plot";'))
      .toEqual(['Plot', 'aq', 'p']);
  });

  it('treats explicit globals as definitions but not bare assignments or updates', () => {
    expect(defs('globalThis.count = 3;\nwindow["w"] = 1;\ntemp = 5;\nglobalThis.count += 1;'))
      .toEqual(['count', 'w']);
  });

  it('treats a ui.* binding as a definition, wherever it appears', () => {
    expect(defs('const el = ui.slider("threshold", { max: 10 });')).toEqual(['el', 'threshold']);
  });
});

describe('freeIdentifiers', () => {
  it('excludes parameters, locals and loop bindings', () => {
    expect(free('function f(p) {\n  const local = p + outer;\n  return local;\n}'))
      .toEqual(['outer']);
    expect(free('for (const row of rows) { total += row.v; }')).toEqual(['rows', 'total']);
    expect(free('xs.map(x => x * n)')).toEqual(['n', 'xs']);
  });

  it('excludes catch bindings and class members but keeps free reads', () => {
    expect(free('try { risky() } catch (e) { report(e) }')).toEqual(['report', 'risky']);
    expect(free('class C { m(x) { return x + y } }')).toEqual(['y']);
  });

  it('ignores property names, keywords, strings and comments', () => {
    expect(free('const t = obj.value + "text"; // note about total\nreturn t;')).toEqual(['obj']);
  });

  it('reads identifiers inside template interpolation', () => {
    // The old scanner blanked whole template literals and missed these.
    expect(free('render(`total: ${count}`)')).toEqual(['count', 'render']);
  });

  it('counts an object-literal shorthand as a read', () => {
    expect(free('send({ pitch, velocity: v })')).toEqual(['pitch', 'send', 'v']);
  });

  it('does not count the source name of an aliased import as a read', () => {
    expect(free('import { plot as p } from "@observablehq/plot";')).toEqual([]);
  });

  it('sees a name used before its own declaration as bound (hoisting)', () => {
    expect(free('run();\nfunction run() { go() }')).toEqual(['go']);
  });
});

describe('topLevelDeclarations', () => {
  it('reports each declarator with its initialiser range', () => {
    const code = 'const a = 1, b = compute(2);';
    const [decl] = topLevelDeclarations(code);
    expect(decl.keyword).toBe('const');
    expect(decl.declarators?.map((d) => d.name)).toEqual(['a', 'b']);
    const [, second] = decl.declarators!;
    expect(code.slice(second.init!.from, second.init!.to)).toBe('compute(2)');
  });

  it('reports a declarator with no initialiser', () => {
    const [decl] = topLevelDeclarations('let pending;');
    expect(decl.declarators).toEqual([{ name: 'pending', from: 4, to: 11, init: null }]);
  });

  it('marks destructuring declarations as not rewritable', () => {
    expect(topLevelDeclarations('const { a } = o;')[0].declarators).toBeNull();
  });

  it('excludes the trailing semicolon from the declaration range', () => {
    const code = 'const x = [1, 2];';
    const [decl] = topLevelDeclarations(code);
    expect(code.slice(decl.from, decl.to)).toBe('const x = [1, 2]');
  });

  it('ignores declarations that only look top-level', () => {
    expect(topLevelDeclarations('if (c) { const nested = 1; }')).toEqual([]);
    expect(topLevelDeclarations('const s = `\nconst injected = 1\n`;')).toHaveLength(1);
  });
});

describe('topLevelNamesToCopy', () => {
  const copied = (code: string) => topLevelNamesToCopy(code).sort();

  it('lists top-level function declarations only', () => {
    expect(copied('function a() {}\nconst b = function c() {};\nif (1) { function d() {} }'))
      .toEqual(['a']);
  });

  it('lists class declarations, which the rewriter also leaves in place', () => {
    expect(copied('class Wide {}\nconst k = new Wide();')).toEqual(['Wide']);
  });

  it('lists destructuring bindings, which cannot be rewritten in place', () => {
    // Regression: `const { Ornament } = lib` published nothing, so the next
    // cell died on "Ornament is not defined" — the whole point of this list.
    expect(copied('const { Scale, Ornament } = jm.theory.harmony;'))
      .toEqual(['Ornament', 'Scale']);
    expect(copied('const { x, y: z, w = 1, ...others } = o;\nconst [p, , q] = arr;'))
      .toEqual(['others', 'p', 'q', 'w', 'x', 'z']);
  });

  it('takes every name of a declaration that mixes plain and destructured', () => {
    // The declaration is left alone as a whole, so `a` needs copying too.
    expect(copied('const a = 1, { b } = o;')).toEqual(['a', 'b']);
  });

  it('leaves plain declarations out — the rewriter already shares those', () => {
    expect(copied('const a = 1, b = 2;\nlet c;\nvar d = 3;')).toEqual([]);
  });

  it('ignores patterns that are not top-level declarations', () => {
    expect(copied('function f({ p }) { const { q } = p; }\nfor (const { r } of rs) {}'))
      .toEqual(['f']);
  });

  it('ignores export wrappers, which the executor cannot run at all', () => {
    expect(copied('export const { a } = o;\nexport function fn() {}')).toEqual([]);
  });
});

describe('hasSyntaxErrors', () => {

  it('detects a broken cell, and accepts a valid one', () => {
    expect(hasSyntaxErrors('const x = ;')).toBe(true);
    expect(hasSyntaxErrors('const x = [1,\n  2,\n];')).toBe(false);
  });
});
