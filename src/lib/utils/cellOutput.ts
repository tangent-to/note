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
export function isEmptyOutput(output: CellOutput | null | undefined): boolean {
  if (!output) return true;
  // A DOM node or a widget spec is always something to show.
  if (output.type === "dom") return output.content == null;
  if (output.type === "widget") return !output.content;
  return String(output.content ?? "").trim() === "";
}
