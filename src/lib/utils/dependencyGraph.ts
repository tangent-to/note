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

function stripStringsAndComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ');
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

  // A cell never depends on itself.
  for (const name of defines) reads.delete(name);

  return { defines, reads };
}

// Compute the set of cell ids that are stale: their last output no longer
// reflects the current state, because either the cell was edited since it ran,
// or an upstream dependency changed / ran more recently.
export function computeStaleCells(
  cells: CellLike[],
  runInfo: Map<string, RunRecord>
): Set<string> {
  const codeCells = cells.filter((c) => c.type === 'code');

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
