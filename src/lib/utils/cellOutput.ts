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
 * Handler properties that make a control a control.
 *
 * `addEventListener` is patched in the worker so a listener leaves a mark, but
 * `el.onclick = fn` leaves none: it is a property assignment, it never reaches
 * that patch, and it does not survive serialization either — linkedom writes
 * `<button>Play</button>` and the function is simply gone. So an output built
 * that way arrived as dead controls with no warning at all, which is the one
 * outcome the notice exists to prevent. Both spellings are ordinary; a player's
 * Play button is as likely to be written one way as the other.
 */
const HANDLER_PROPS = [
  'onclick',
  'ondblclick',
  'onmousedown',
  'onmouseup',
  'onmouseover',
  'onmouseenter',
  'onmousemove',
  'onpointerdown',
  'onpointerup',
  'ontouchstart',
  'onwheel',
  'onchange',
  'oninput',
  'onsubmit',
  'onkeydown',
  'onkeyup',
];

function hasHandlerProperty(node: any): boolean {
  for (const prop of HANDLER_PROPS) {
    if (typeof node[prop] === 'function') return true;
  }
  return false;
}

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

  if (root[LISTENER_FLAG] || hasHandlerProperty(root)) return true;
  const descendants =
    typeof root.querySelectorAll === 'function' ? root.querySelectorAll('*') : [];
  for (const node of descendants) {
    if ((node as any)[LISTENER_FLAG] || hasHandlerProperty(node)) return true;
  }
  return false;
}

/** More elements than this in one live output and the browser starts to struggle. */
export const MAX_OUTPUT_ELEMENTS = 5000;

/**
 * Is this live output too big to keep?
 *
 * Measures what is there now. The guard it replaces added up every node ever
 * inserted and never subtracted, so it measured churn, not size — and a live
 * output churns by design. A player that rewrites its time label and progress
 * as it plays inserts a fresh text node on every update; a few minutes into a
 * piece that crossed 5000 and the guard wiped a forty-element player mid-note.
 */
export function exceedsElementBudget(root: any, max: number = MAX_OUTPUT_ELEMENTS): boolean {
  if (!root || typeof root.querySelectorAll !== 'function') return false;
  return root.querySelectorAll('*').length > max;
}

/**
 * Did this batch of mutations add any element?
 *
 * Only an added element can grow the output toward the budget, so only then is
 * it worth recounting. A player's updates replace text nodes and never qualify,
 * which keeps the check free while something is playing.
 */
export function addsElements(mutations: Iterable<{ addedNodes: ArrayLike<any> }>): boolean {
  for (const mutation of mutations) {
    for (let i = 0; i < mutation.addedNodes.length; i++) {
      if (mutation.addedNodes[i]?.nodeType === 1) return true;
    }
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
