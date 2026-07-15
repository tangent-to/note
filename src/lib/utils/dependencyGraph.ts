// Lightweight static dependency analysis for notebook cells.
//
// We don't fully parse JavaScript. Instead we extract, per cell:
//   - `defines`: top-level names the cell introduces into the shared scope
//   - `reads`:   identifiers the cell references
//
// A cell B depends on cell A when B reads a name that A defines. This is the
// same idea Marimo uses for Python, adapted to our imperative shared-scope
// model. It's deliberately conservative: when in doubt it over-reports a
// dependency, which at worst marks a cell stale unnecessarily (safe) rather
// than missing a real staleness (unsafe).

export interface CellLike {
  id: string;
  type: 'code' | 'markdown';
  content: string;
  skipped?: boolean;
}

export interface CellAnalysis {
  defines: Set<string>;
  reads: Set<string>;
}

export interface RunRecord {
  at: number;
  hash: string;
}

// djb2 — small, fast, good enough to detect "content changed since last run".
export function hashCode(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return String(hash >>> 0);
}

// Blank out strings and comments in one left-to-right pass. A single scanner is
// required (not sequential regexes): a `//` or `/* */` comment may contain a
// backtick, and a string may contain `//` — so whichever construct opens FIRST
// wins. The old regex order (comments before strings) left a stray backtick from
// a commented-out template literal, which then swallowed the rest of the source
// and corrupted the dependency scan. Newlines are preserved so line-anchored
// (`^`) declaration regexes downstream still work; every other consumed char
// becomes a space.
function stripStringsAndComments(code: string): string {
  let out = '';
  let i = 0;
  const n = code.length;
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const ch = code[i];
    const next = code[i + 1];
    // line comment
    if (ch === '/' && next === '/') {
      let j = i + 2;
      while (j < n && code[j] !== '\n') j++;
      out += blank(code.slice(i, j));
      i = j;
      continue;
    }
    // block comment
    if (ch === '/' && next === '*') {
      let j = i + 2;
      while (j < n && !(code[j] === '*' && code[j + 1] === '/')) j++;
      j = Math.min(n, j + 2);
      out += blank(code.slice(i, j));
      i = j;
      continue;
    }
    // string / template literal (template interpolation is blanked wholesale too,
    // which is safe here: it only makes the scan miss reads inside `${…}`, so at
    // worst a dependency is under-reported for interpolated identifiers — a known,
    // acceptable limitation of this lightweight analyser)
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === quote) { j++; break; }
        j++;
      }
      out += blank(code.slice(i, j));
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// Pull binding names out of a destructuring pattern like `{a, b: c, d = 1}`
// or `[a, , ...rest]`.
function extractBindingNames(pattern: string): string[] {
  const names: string[] = [];
  const inner = pattern.replace(/^[{[]/, '').replace(/[}\]]$/, '');
  for (let part of inner.split(',')) {
    part = part.trim();
    if (!part) continue;
    part = part.split('=')[0].trim();          // drop default value
    if (part.includes(':')) part = part.split(':')[1].trim(); // {key: local}
    part = part.replace(/^\.\.\./, '');         // rest element
    const m = part.match(/^[A-Za-z_$][\w$]*/);
    if (m) names.push(m[0]);
  }
  return names;
}

export function analyzeCell(code: string): CellAnalysis {
  const defines = new Set<string>();
  const clean = stripStringsAndComments(code);

  // Top-level declarations (column 0 — matches how jsExecutor hoists to scope).
  for (const m of clean.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) defines.add(m[1]);
  for (const m of clean.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)) defines.add(m[1]);
  for (const m of clean.matchAll(/^class\s+([A-Za-z_$][\w$]*)/gm)) defines.add(m[1]);
  // Top-level destructuring declarations.
  for (const m of clean.matchAll(/^(?:const|let|var)\s*(\{[^}]*\}|\[[^\]]*\])\s*=/gm)) {
    for (const name of extractBindingNames(m[1])) defines.add(name);
  }
  // Explicit globals: `globalThis.foo = ...` / `window.foo = ...`. These are the
  // portable way to share mutable state across cells (valid in Deno/Zed too).
  // Bare assignments (`foo = ...`) are intentionally NOT treated as definitions:
  // they're implicit globals that throw under strict-mode ESM, so the notebook
  // format relies on declarations / explicit globals instead.
  for (const m of clean.matchAll(/^(?:globalThis|window)\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?![=>])/gm)) {
    defines.add(m[1]);
  }
  // Imported bindings (jsExecutor assigns these into the shared scope).
  for (const m of clean.matchAll(/import\s+(?:\*\s+as\s+([\w$]+)|([\w$]+)|\{([^}]+)\})\s+from\b/g)) {
    if (m[1]) defines.add(m[1]);
    if (m[2]) defines.add(m[2]);
    if (m[3]) {
      for (let part of m[3].split(',')) {
        part = part.trim();
        if (!part) continue;
        const asMatch = part.match(/\bas\s+([\w$]+)/);
        const name = asMatch ? asMatch[1] : part.match(/^[\w$]+/)?.[0];
        if (name) defines.add(name);
      }
    }
  }

  // Reads: every identifier that isn't a property access (`.foo`). We don't
  // bother filtering keywords/globals — `reads` is only ever intersected with
  // the set of names other cells define, so noise can't create false edges.
  const reads = new Set<string>();
  const noMembers = clean.replace(/\.\s*[A-Za-z_$][\w$]*/g, ' ');
  for (const m of noMembers.matchAll(/[A-Za-z_$][\w$]*/g)) reads.add(m[0]);

  // Reactive input bindings: `ui.slider("name", ...)` defines `name`. Scan the
  // ORIGINAL code (not `clean`) because the bound name is a string literal.
  for (const m of code.matchAll(/\bui\s*\.\s*(?:slider|number|checkbox|select|text)\s*\(\s*["']([A-Za-z_$][\w$]*)["']/g)) {
    defines.add(m[1]);
  }

  // A cell never depends on itself.
  for (const name of defines) reads.delete(name);

  return { defines, reads };
}

// Build per-cell analyses and a name -> producer-cells index in one pass.
function buildIndex(codeCells: CellLike[]) {
  const analyses = new Map<string, CellAnalysis>();
  const producersByName = new Map<string, string[]>();
  for (const cell of codeCells) {
    const analysis = analyzeCell(cell.content);
    analyses.set(cell.id, analysis);
    for (const name of analysis.defines) {
      const list = producersByName.get(name) ?? [];
      list.push(cell.id);
      producersByName.set(name, list);
    }
  }
  return { analyses, producersByName };
}

// Transitively collect cells that read any name in `seedNames` (following the
// dependency chain), optionally excluding one cell id.
function collectDownstream(
  codeCells: CellLike[],
  analyses: Map<string, CellAnalysis>,
  seedNames: Iterable<string>,
  excludeId?: string
): Set<string> {
  const downstream = new Set<string>();
  const frontierNames = new Set(seedNames);
  let changed = true;
  let guard = 0;
  while (changed && guard++ <= codeCells.length + 1) {
    changed = false;
    for (const cell of codeCells) {
      if (cell.id === excludeId || downstream.has(cell.id)) continue;
      const analysis = analyses.get(cell.id)!;
      let reads = false;
      for (const name of frontierNames) {
        if (analysis.reads.has(name)) { reads = true; break; }
      }
      if (reads) {
        downstream.add(cell.id);
        for (const name of analysis.defines) frontierNames.add(name);
        changed = true;
      }
    }
  }
  return downstream;
}

// All cells that transitively depend on `originId` (i.e. read a name it defines,
// directly or through a chain). Used by reactive mode to re-run dependents.
export function getDownstreamCells(cells: CellLike[], originId: string): Set<string> {
  const codeCells = cells.filter((c) => c.type === 'code');
  const { analyses } = buildIndex(codeCells);
  const origin = analyses.get(originId);
  if (!origin) return new Set();
  return collectDownstream(codeCells, analyses, origin.defines, originId);
}

// All cells that transitively depend on a single variable `name`. Used when a
// reactive input (e.g. a slider) changes its bound value.
export function getDependentsOfName(cells: CellLike[], name: string): Set<string> {
  const codeCells = cells.filter((c) => c.type === 'code');
  const { analyses } = buildIndex(codeCells);
  return collectDownstream(codeCells, analyses, [name]);
}

// Compute the set of cell ids that are stale: their last output no longer
// reflects the current state, because either the cell was edited since it ran,
// or an upstream dependency changed / ran more recently.
export function computeStaleCells(
  cells: CellLike[],
  runInfo: Map<string, RunRecord>
): Set<string> {
  // Skipped cells never run, so they can't be stale and their edits
  // shouldn't propagate staleness downstream.
  const codeCells = cells.filter((c) => c.type === 'code' && !c.skipped);
  const { analyses, producersByName } = buildIndex(codeCells);

  const stale = new Set<string>();

  // Base case: a cell that has run but whose content changed since is stale.
  for (const cell of codeCells) {
    const info = runInfo.get(cell.id);
    if (info && hashCode(cell.content) !== info.hash) stale.add(cell.id);
  }

  // Propagate staleness along dependency edges until it stops growing.
  let changed = true;
  let guard = 0;
  while (changed && guard++ <= codeCells.length + 1) {
    changed = false;
    for (const cell of codeCells) {
      if (stale.has(cell.id)) continue;
      const info = runInfo.get(cell.id);
      if (!info) continue; // never run → "not run", not "stale"

      const analysis = analyses.get(cell.id)!;
      let nowStale = false;
      for (const name of analysis.reads) {
        const producers = producersByName.get(name);
        if (!producers) continue;
        for (const producerId of producers) {
          if (producerId === cell.id) continue;
          if (stale.has(producerId)) { nowStale = true; break; }
          const producerInfo = runInfo.get(producerId);
          if (producerInfo && producerInfo.at > info.at) { nowStale = true; break; }
        }
        if (nowStale) break;
      }
      if (nowStale) {
        stale.add(cell.id);
        changed = true;
      }
    }
  }

  return stale;
}
