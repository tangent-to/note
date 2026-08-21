/**
 * Syntax-level facts about a code cell, from a real JavaScript parse.
 *
 * Everything here uses @lezer/javascript — the same grammar the editor already
 * bundles for highlighting, so it costs no extra bytes — instead of regexes over
 * the source. That buys three things the regex scanners could not have:
 *
 *   - strings, template literals and comments are never mistaken for code, so a
 *     `const x = 1` inside a template literal is inert, not a declaration;
 *   - `reads` are *free* identifiers (scope-aware), not every word in the cell,
 *     so a callback's own parameter no longer looks like a notebook variable;
 *   - declarations are found by structure, so indentation, multiple declarators
 *     (`const a = 1, b = 2`) and `export const` all analyse correctly.
 *
 * Lezer is error-tolerant: a half-typed cell still parses, with `⚠` error nodes
 * where it could not make sense of the text. `hasSyntaxErrors` reports that, for
 * callers that need to fall back to leaving the source alone.
 */
import { parser } from '@lezer/javascript';
import type { SyntaxNode, SyntaxNodeRef, Tree } from '@lezer/common';

/** Scopes that hold `var` and function declarations. */
const FUNCTION_SCOPE = new Set([
  'Script',
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunction',
  'MethodDeclaration',
  'ClassDeclaration',
  'ClassExpression',
]);

/**
 * Scopes that additionally hold `let`/`const`/`catch`/loop bindings.
 *
 * `ForStatement` rather than its `ForSpec`/`ForOfSpec`: the loop body is a
 * *sibling* of the spec, so binding `for (const row of rows)` to the spec would
 * leave `row` unresolved inside the body.
 */
const BLOCK_SCOPE = new Set([
  'Block',
  'ClassBody',
  'ForStatement',
  'CatchClause',
  'SwitchBody',
]);

const isScope = (name: string) => FUNCTION_SCOPE.has(name) || BLOCK_SCOPE.has(name);

/** Pattern nodes worth descending into when collecting bound names. */
const PATTERN = new Set(['ObjectPattern', 'ArrayPattern', 'PatternProperty']);

// Parses are cached by source text: a single staleness pass analyses every cell
// several times over (downstream sets, staleness, duplicate names), and cell
// content rarely changes between those calls.
const CACHE_LIMIT = 400;
const treeCache = new Map<string, Tree>();

function parse(code: string): Tree {
  const hit = treeCache.get(code);
  if (hit) return hit;
  const tree = parser.parse(code);
  if (treeCache.size >= CACHE_LIMIT) {
    // Cheap eviction: drop the oldest insertion (Map preserves insertion order).
    const oldest = treeCache.keys().next();
    if (!oldest.done) treeCache.delete(oldest.value);
  }
  treeCache.set(code, tree);
  return tree;
}

/** True when the parser had to insert an error node — the cell does not compile. */
export function hasSyntaxErrors(code: string): boolean {
  let broken = false;
  parse(code).iterate({
    enter: (ref) => {
      if (ref.type.isError) { broken = true; return false; }
      return !broken;
    },
  });
  return broken;
}

/**
 * The name a node binds, or null when it binds nothing.
 *
 * `VariableDefinition` covers declarations, parameters, `catch` bindings, import
 * bindings and function/class names. Shorthand destructuring (`const {x} = o`)
 * is the exception: the grammar gives only `PatternProperty > PropertyName`, so
 * the property name is the binding — but only when no explicit target follows
 * it (`{y: z}` binds `z`, not `y`).
 */
function boundName(ref: SyntaxNodeRef, code: string): string | null {
  if (ref.name === 'VariableDefinition') return code.slice(ref.from, ref.to);
  if (ref.name === 'PropertyName' && ref.node.parent?.name === 'PatternProperty') {
    const hasExplicitTarget = ref.node.parent.getChild('VariableDefinition') !== null;
    if (!hasExplicitTarget) return code.slice(ref.from, ref.to);
  }
  return null;
}

/**
 * `{ a }` in an object *expression* reads `a`, but the grammar tags it
 * `PropertyDefinition` (same as `{ a: 1 }`), so it needs recognising by shape:
 * a lone child of its Property.
 */
function isShorthandRead(ref: SyntaxNodeRef): boolean {
  if (ref.name !== 'PropertyDefinition') return false;
  const node = ref.node;
  return (
    node.parent?.name === 'Property' &&
    node.prevSibling === null &&
    node.nextSibling === null
  );
}

/** `import { plot as p }` mentions `plot` as a VariableName; it is not a read. */
function insideImport(node: SyntaxNode): boolean {
  for (let p: SyntaxNode | null = node.parent; p; p = p.parent) {
    if (p.name === 'ImportDeclaration') return true;
  }
  return false;
}

/**
 * Identifiers the cell reads but does not bind anywhere in itself — i.e. the
 * names it expects the shared notebook scope (or a global) to provide.
 *
 * Two passes, because JavaScript hoists: the first collects what each scope
 * binds, the second resolves every identifier against its enclosing scopes.
 */
export function freeIdentifiers(code: string): Set<string> {
  const tree = parse(code);

  // Scopes are keyed by entry order, not by source offset: a function starting at
  // offset 0 would otherwise share a key with the Script node and leak its
  // parameters into the top-level scope.
  const scopeNames = new Map<number, Set<string>>();
  const namesOf = (key: number) => {
    let set = scopeNames.get(key);
    if (!set) scopeNames.set(key, (set = new Set()));
    return set;
  };

  let nextId = 0;
  const enclosing: number[] = [];
  tree.iterate({
    enter: (ref) => {
      if (isScope(ref.name)) {
        const id = nextId++;
        enclosing.push(id);
        namesOf(id);
      }
      const name = boundName(ref, code);
      if (name) {
        // A function or class *name* belongs to the scope around it, not to its
        // own body — otherwise its own recursive scope would swallow the name.
        const parent = ref.node.parent?.name;
        const ownName = parent === 'FunctionDeclaration' || parent === 'ClassDeclaration';
        const depth = enclosing.length - (ownName ? 2 : 1);
        namesOf(enclosing[Math.max(0, depth)] ?? 0).add(name);
      }
    },
    leave: (ref) => {
      if (isScope(ref.name)) enclosing.pop();
    },
  });

  const free = new Set<string>();
  let replayId = 0;
  const stack: number[] = [];
  tree.iterate({
    enter: (ref) => {
      if (isScope(ref.name)) stack.push(replayId++);
      const isRead = ref.name === 'VariableName' || isShorthandRead(ref);
      if (!isRead) return;
      if (ref.name === 'VariableName' && insideImport(ref.node)) return;
      const name = code.slice(ref.from, ref.to);
      for (let i = stack.length - 1; i >= 0; i--) {
        if (scopeNames.get(stack[i])?.has(name)) return;
      }
      free.add(name);
    },
    leave: (ref) => {
      if (isScope(ref.name)) stack.pop();
    },
  });

  return free;
}

/** Collect the names bound by a declaration's pattern, ignoring initialisers. */
function patternNames(declaration: SyntaxNode, code: string, into: Set<string>): void {
  for (let child = declaration.firstChild; child; child = child.nextSibling) {
    const name = boundName(child, code);
    if (name) {
      into.add(name);
      continue;
    }
    // Descend only through pattern structure, so a default value that happens to
    // be a function (`const {f = (a) => a} = o`) contributes no bindings.
    if (PATTERN.has(child.name)) patternNames(child, code, into);
  }
}

/** The `globalThis.x = …` / `window["x"] = …` form, which shares `x` explicitly. */
function explicitGlobalName(statement: SyntaxNode, code: string): string | null {
  if (statement.name !== 'ExpressionStatement') return null;
  const assign = statement.firstChild;
  if (!assign || assign.name !== 'AssignmentExpression') return null;
  if (assign.getChild('Equals') === null) return null;        // `+=` is not a definition
  const target = assign.firstChild;
  if (!target || target.name !== 'MemberExpression') return null;
  const object = target.firstChild;
  if (!object || object.name !== 'VariableName') return null;
  const objectName = code.slice(object.from, object.to);
  if (objectName !== 'globalThis' && objectName !== 'window') return null;

  const property = target.getChild('PropertyName');
  if (property) return code.slice(property.from, property.to);
  const subscript = target.getChild('String');            // window["x"] = …
  if (subscript) {
    const raw = code.slice(subscript.from, subscript.to).slice(1, -1);
    return /^[A-Za-z_$][\w$]*$/.test(raw) ? raw : null;
  }
  return null;
}

const INPUT_KINDS = new Set(['slider', 'number', 'checkbox', 'select', 'text']);

/** Names bound by reactive inputs: `ui.slider("threshold", …)` defines `threshold`. */
function inputBindings(tree: Tree, code: string): string[] {
  const names: string[] = [];
  tree.iterate({
    enter: (ref) => {
      if (ref.name !== 'CallExpression') return;
      const callee = ref.node.firstChild;
      if (!callee || callee.name !== 'MemberExpression') return;
      const object = callee.firstChild;
      const method = callee.getChild('PropertyName');
      if (!object || object.name !== 'VariableName' || !method) return;
      if (code.slice(object.from, object.to) !== 'ui') return;
      if (!INPUT_KINDS.has(code.slice(method.from, method.to))) return;
      const literal = ref.node.getChild('ArgList')?.getChild('String');
      if (!literal) return;
      const name = code.slice(literal.from, literal.to).slice(1, -1);
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
    },
  });
  return names;
}

/**
 * Names the cell publishes into the shared notebook scope: top-level
 * declarations (including destructuring and every declarator of a multi-name
 * declaration), function and class declarations, import bindings, explicit
 * `globalThis`/`window` assignments, and reactive input bindings.
 *
 * Only *top-level* statements count, matching how the executor hoists — a
 * declaration inside a function or block stays private to the cell. `export`
 * wrappers are looked through, since the notebook file is a module on disk.
 */
export function topLevelDefinitions(code: string): Set<string> {
  const tree = parse(code);
  const defines = new Set<string>();

  for (let stmt = tree.topNode.firstChild; stmt; stmt = stmt.nextSibling) {
    let node = stmt;
    if (node.name === 'ExportDeclaration') {
      const inner = node.firstChild?.nextSibling ?? null;   // skip the `export` keyword
      if (!inner) continue;
      node = inner;
    }
    switch (node.name) {
      case 'VariableDeclaration':
        patternNames(node, code, defines);
        break;
      case 'FunctionDeclaration':
      case 'ClassDeclaration': {
        const name = node.getChild('VariableDefinition');
        if (name) defines.add(code.slice(name.from, name.to));
        break;
      }
      case 'ImportDeclaration': {
        node.getChildren('VariableDefinition').forEach((n) =>
          defines.add(code.slice(n.from, n.to))
        );
        node
          .getChild('ImportGroup')
          ?.getChildren('VariableDefinition')
          .forEach((n) => defines.add(code.slice(n.from, n.to)));
        break;
      }
      default: {
        const global = explicitGlobalName(node, code);
        if (global) defines.add(global);
      }
    }
  }

  for (const name of inputBindings(tree, code)) defines.add(name);
  return defines;
}

export interface Declarator {
  name: string;
  /** Range of the bound name itself. */
  from: number;
  to: number;
  /** Range of the initialiser, or null for `let x;`. */
  init: { from: number; to: number } | null;
}

export interface TopLevelDeclaration {
  keyword: 'const' | 'let' | 'var';
  /** Range of the whole declaration, `;` excluded. */
  from: number;
  to: number;
  /** Range of the `const`/`let`/`var` keyword. */
  keywordFrom: number;
  keywordTo: number;
  /** Present only when every declarator binds a plain name (no destructuring). */
  declarators: Declarator[] | null;
  /** `export const x = …` — the keyword must stay put, so callers skip these. */
  exported: boolean;
}

/**
 * Top-level `const`/`let`/`var` declarations, with the ranges needed to rewrite
 * them into shared-scope writes. `declarators` is null for destructuring
 * declarations, which the executor leaves alone.
 */
export function topLevelDeclarations(code: string): TopLevelDeclaration[] {
  const tree = parse(code);
  const found: TopLevelDeclaration[] = [];

  for (let stmt = tree.topNode.firstChild; stmt; stmt = stmt.nextSibling) {
    const exported = stmt.name === 'ExportDeclaration';
    const node = exported ? stmt.firstChild?.nextSibling ?? null : stmt;
    if (!node || node.name !== 'VariableDeclaration') continue;

    const keywordNode = node.firstChild;
    if (!keywordNode) continue;
    const keyword = code.slice(keywordNode.from, keywordNode.to);
    if (keyword !== 'const' && keyword !== 'let' && keyword !== 'var') continue;

    // Walk the declarator list: a name, then optionally `=` and an initialiser,
    // separated by commas. Anything that is not a plain name (a pattern) makes
    // the whole declaration ineligible for rewriting.
    const declarators: Declarator[] = [];
    let simple = true;
    let current: Declarator | null = null;
    for (let child = keywordNode.nextSibling; child; child = child.nextSibling) {
      if (child.name === 'VariableDefinition') {
        current = {
          name: code.slice(child.from, child.to),
          from: child.from,
          to: child.to,
          init: null,
        };
        declarators.push(current);
        continue;
      }
      if (child.name === ',' || child.name === ';') continue;
      if (child.name === 'Equals') continue;
      if (PATTERN.has(child.name)) { simple = false; break; }
      // Any other node in declarator position is the initialiser expression.
      if (current) current.init = { from: child.from, to: child.to };
    }

    // `;` is a sibling inside the declaration; trim it from the reported range.
    const semi = node.getChild(';');
    found.push({
      keyword,
      from: node.from,
      to: semi ? semi.from : node.to,
      keywordFrom: keywordNode.from,
      keywordTo: keywordNode.to,
      declarators: simple && declarators.length > 0 ? declarators : null,
      exported,
    });
  }

  return found;
}

/** True when any declarator of `declaration` destructures instead of naming. */
function bindsPattern(declaration: SyntaxNode): boolean {
  for (let child = declaration.firstChild; child; child = child.nextSibling) {
    if (PATTERN.has(child.name)) return true;
  }
  return false;
}

/**
 * Names bound by top-level declarations that stay *declarations* after the
 * executor's rewrite, and so bind only inside the cell's own function scope:
 *
 *   - `function` and `class` declarations, which are never rewritten;
 *   - destructuring declarations, which `topLevelDeclarations` reports as
 *     unrewritable (`declarators: null`) because the pattern cannot become a
 *     plain assignment target.
 *
 * The executor copies these into the shared scope once the cell body has run.
 * Without that copy a `const { Thing } = lib` publishes nothing, and the next
 * cell fails with "Thing is not defined" even though the dependency graph says
 * the name is defined — see `topLevelDefinitions`, which counts it.
 *
 * `export` wrappers are excluded: the executor's IIFE cannot run an export
 * statement at all, so such a cell never gets far enough for a copy to matter.
 */
export function topLevelNamesToCopy(code: string): string[] {
  const tree = parse(code);
  const names = new Set<string>();

  for (let stmt = tree.topNode.firstChild; stmt; stmt = stmt.nextSibling) {
    switch (stmt.name) {
      case 'FunctionDeclaration':
      case 'ClassDeclaration': {
        const name = stmt.getChild('VariableDefinition');
        if (name) names.add(code.slice(name.from, name.to));
        break;
      }
      case 'VariableDeclaration':
        // A declaration mixing plain and destructured declarators
        // (`const a = 1, { b } = o`) is left alone whole, so both names need
        // copying — which is exactly what patternNames collects.
        if (bindsPattern(stmt)) patternNames(stmt, code, names);
        break;
    }
  }

  return [...names];
}
