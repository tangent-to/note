// Static dependency analysis for notebook cells.
//
// Per cell, from a real JavaScript parse (see jsSyntax):
//   - `defines`: top-level names the cell introduces into the shared scope
//   - `reads`:   free identifiers — names it uses but does not bind itself
//
// A cell B depends on cell A when B reads a name that A defines. This is the
// same idea Marimo uses for Python, adapted to our imperative shared-scope
// model.
//
// Remaining imprecision errs toward over-reporting a dependency, which at worst
// marks a cell stale unnecessarily (safe) rather than missing a real staleness
// (unsafe): reads include ordinary globals (`console`, `Math`), and a `var`
// inside a block is treated as block-scoped.

import { freeIdentifiers, topLevelDefinitions } from './jsSyntax';

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

// A single staleness pass analyses every cell three or four times over (duplicate
// names, staleness, execution order, downstream sets), so results are cached by
// source text. Treat the returned sets as read-only.
const ANALYSIS_CACHE_LIMIT = 400;
const analysisCache = new Map<string, CellAnalysis>();

export function analyzeCell(code: string): CellAnalysis {
  const cached = analysisCache.get(code);
  if (cached) return cached;

  // `defines` are the names the cell publishes into the shared scope; `reads`
  // are the free identifiers it expects someone else to provide. Both come from
  // a real parse (see jsSyntax), so strings, comments, property names and a
  // callback's own parameters can no longer masquerade as notebook variables.
  const defines = topLevelDefinitions(code);
  const reads = freeIdentifiers(code);

  // A cell never depends on itself: a name it both binds and reads (a ui.* input
  // it also uses, say) is its own.
  for (const name of defines) reads.delete(name);

  const analysis: CellAnalysis = { defines, reads };
  if (analysisCache.size >= ANALYSIS_CACHE_LIMIT) {
    const oldest = analysisCache.keys().next();
    if (!oldest.done) analysisCache.delete(oldest.value);
  }
  analysisCache.set(code, analysis);
  return analysis;
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

// Names defined by more than one cell, mapped to the ids of the cells defining
// them (in document order). Returns only the conflicting names.
//
// Top-level declarations become plain writes into one shared scope object (see
// jsExecutor's transformForScope), so a name declared in two cells is a single
// variable: whichever cell ran last wins, `const` included. Reactive re-runs
// make that worse — a dependent cell is re-run for ANY producer of a name it
// reads, so an earlier cell's value can overwrite a later cell's. Observable and
// Marimo reject duplicate definitions outright; we surface a warning instead, so
// existing notebooks keep running.
//
// Skipped cells are excluded: they never run, so they cannot collide.
export function findDuplicateDefinitions(cells: CellLike[]): Map<string, string[]> {
  const codeCells = cells.filter((c) => c.type === 'code' && !c.skipped);
  const { producersByName } = buildIndex(codeCells);

  const duplicates = new Map<string, string[]>();
  for (const [name, producers] of producersByName) {
    // A cell can name the same binding twice (`let x` then `x` via ui.slider);
    // that is one producer, not a conflict.
    const distinct = [...new Set(producers)];
    if (distinct.length > 1) duplicates.set(name, distinct);
  }
  return duplicates;
}

/**
 * Cell ids in dependency order: every cell comes after the cells that define the
 * names it reads. Ties are broken by document order, so a notebook whose cells
 * already read top-to-bottom is unchanged — this only matters when a cell sits
 * above the cell it depends on, where document order would run it with a stale
 * (or missing) value and Run All needed a second pass to converge.
 *
 * `only` restricts the result without changing the ordering: dependencies are
 * resolved across the whole notebook, then the result is filtered, so running a
 * subset (stale cells, reactive dependents) still respects edges that pass
 * through cells that are not being run.
 *
 * Cycles cannot be ordered. Rather than dropping those cells, the earliest one in
 * document order is emitted to break the cycle and ordering continues — the same
 * outcome document order would have given, applied only where it is unavoidable.
 */
export function executionOrder(cells: CellLike[], only?: Set<string>): string[] {
  const codeCells = cells.filter((c) => c.type === 'code' && !c.skipped);
  const { analyses, producersByName } = buildIndex(codeCells);

  const position = new Map<string, number>();
  codeCells.forEach((cell, index) => position.set(cell.id, index));

  // Edges producer -> consumer, plus an in-degree per consumer.
  const consumers = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const cell of codeCells) {
    indegree.set(cell.id, 0);
    consumers.set(cell.id, new Set());
  }
  for (const cell of codeCells) {
    const seen = new Set<string>();
    for (const name of analyses.get(cell.id)!.reads) {
      for (const producerId of producersByName.get(name) ?? []) {
        if (producerId === cell.id || seen.has(producerId)) continue;
        seen.add(producerId);
        consumers.get(producerId)!.add(cell.id);
        indegree.set(cell.id, indegree.get(cell.id)! + 1);
      }
    }
  }

  const remaining = new Set(codeCells.map((c) => c.id));
  const earliest = (ids: Iterable<string>) => {
    let best: string | null = null;
    for (const id of ids) {
      if (best === null || position.get(id)! < position.get(best)!) best = id;
    }
    return best;
  };

  const ordered: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => indegree.get(id) === 0);
    // No ready cell means every remaining cell is in a cycle; break it at the
    // earliest cell so ordering can continue.
    const next = earliest(ready.length > 0 ? ready : remaining)!;
    remaining.delete(next);
    ordered.push(next);
    for (const consumer of consumers.get(next)!) {
      if (remaining.has(consumer)) indegree.set(consumer, indegree.get(consumer)! - 1);
    }
  }

  return only ? ordered.filter((id) => only.has(id)) : ordered;
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
