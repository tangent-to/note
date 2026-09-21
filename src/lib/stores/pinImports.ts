/**
 * "Pin imports": rewrite a notebook's unpinned imports to what they resolve to
 * right now.
 *
 * The version belongs in the notebook, not in a file beside it: the URL travels
 * with the work, is readable in a diff, and needs nothing from this app to be
 * reproducible somewhere else.
 */
import { get } from 'svelte/store';
import { currentNotebook, markNotebookDirty } from './notebook';
import { applyPins, classifyImport, findImports, pinSpecifier } from '../utils/imports';
import { resolveVersion } from '../utils/pinImports';

export interface PinReport {
  pinned: string[];
  /** Unpinned, but nothing could say what they resolve to. */
  unresolved: string[];
  /** Already naming a version or a commit. */
  alreadyPinned: number;
}

export async function pinNotebookImports(doFetch: typeof fetch = fetch): Promise<PinReport> {
  const notebook = get(currentNotebook);
  if (!notebook) return { pinned: [], unresolved: [], alreadyPinned: 0 };

  const report: PinReport = { pinned: [], unresolved: [], alreadyPinned: 0 };
  // One lookup per distinct specifier, however many cells use it.
  const resolved = new Map<string, string | null>();
  const cells = await Promise.all(
    notebook.cells.map(async (cell) => {
      if (cell.type !== 'code') return cell;
      const refs = findImports(cell.content);
      const pins: Array<{ start: number; end: number; spec: string }> = [];

      for (const ref of refs) {
        const verdict = classifyImport(ref.spec);
        if (verdict.pinned) {
          if (verdict.kind !== 'relative' && verdict.kind !== 'other') report.alreadyPinned++;
          continue;
        }
        if (!resolved.has(ref.spec)) {
          const resolution = await resolveVersion(ref.spec, doFetch);
          resolved.set(ref.spec, resolution ? pinSpecifier(ref.spec, resolution.version) : null);
        }
        const pinnedSpec = resolved.get(ref.spec) ?? null;
        if (!pinnedSpec) {
          if (!report.unresolved.includes(ref.spec)) report.unresolved.push(ref.spec);
          continue;
        }
        pins.push({ start: ref.start, end: ref.end, spec: pinnedSpec });
        const line = `${ref.spec} pinned to ${pinnedSpec}`;
        if (!report.pinned.includes(line)) {
          report.pinned.push(line);
        }
      }
      return pins.length > 0 ? { ...cell, content: applyPins(cell.content, pins) } : cell;
    })
  );

  if (report.pinned.length > 0) {
    markNotebookDirty();
    currentNotebook.update((nb) => (nb ? { ...nb, cells, updatedAt: Date.now() } : nb));
  }
  return report;
}
