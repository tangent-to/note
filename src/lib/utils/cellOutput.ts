/**
 * Helpers for reasoning about a cell's output before rendering it.
 */
import type { CellOutput } from "../types/notebook";

/**
 * True when an output carries nothing for the reader — no text, no DOM node.
 *
 * A cell whose last statement is not a displayable expression (`const track =
 * […]`, a `for` loop, an assignment) still returns an output object, just with
 * empty content. Callers use this to skip the output frame entirely instead of
 * rendering an empty box with a copy button under the code.
 */
/**
 * Property stamped on any element that had an event listener attached while the
 * worker kernel was executing (see kernel.worker.ts). It is a JS property, not
 * an attribute, so it never appears in the serialized HTML.
 */
export const LISTENER_FLAG = '__tangentHadListener';

/**
 * True when serializing this DOM output to HTML would break it.
 *
 * The worker kernel can only hand back markup, so anything that depends on code
 * running after insertion is lost: `addEventListener` handlers (a player's Play
 * button, a chart's tooltips) and `<script>` tags, which never execute when
 * inserted as HTML. Callers use this to tell the reader that the output needs
 * the main-thread kernel, instead of showing them dead controls.
 *
 * An output containing an `<iframe>` is exempt: the frame loads and runs its own
 * scripts after insertion, which is exactly how libraries targeting notebook
 * kernels ship interactive output.
 */
export function lostInteractivity(root: any): boolean {
  if (!root || typeof root !== 'object') return false;

  const html = typeof root.outerHTML === 'string' ? root.outerHTML : '';
  if (/<iframe\b/i.test(html)) return false;
  if (/<script\b/i.test(html)) return true;

  if (root[LISTENER_FLAG]) return true;
  const descendants =
    typeof root.querySelectorAll === 'function' ? root.querySelectorAll('*') : [];
  for (const node of descendants) {
    if ((node as any)[LISTENER_FLAG]) return true;
  }
  return false;
}

export function isEmptyOutput(output: CellOutput | null | undefined): boolean {
  if (!output) return true;
  // What the cell printed counts as output even when it returned nothing —
  // a cell whose whole point is a console.log must still get a frame.
  if (output.logs && output.logs.length > 0) return false;
  // A DOM node or a widget spec is always something to show.
  if (output.type === "dom") return output.content == null;
  if (output.type === "widget") return !output.content;
  return String(output.content ?? "").trim() === "";
}
