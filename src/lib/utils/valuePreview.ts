/**
 * Turning a cell's value into something the Observable inspector can render.
 *
 * The inspector is reached by a simple test in CellOutput: if the output text
 * parses as JSON, inspect it; otherwise show it as text. That worked for
 * objects and quietly failed for the arrays people actually have. An array
 * longer than 200 items was replaced by a summary — `Array(344) [{…}, {…} …]`,
 * built by pretty-printing the first ten items and joining them with commas —
 * which is not JSON, so it fell through to the text branch and arrived as the
 * wall of text this replaces. A dataset is nearly always longer than 200 rows,
 * so in practice the nice rendering was the case that never happened.
 *
 * So: shorten long arrays, but shorten them *into still-valid JSON*. The items
 * that were left out are named by a marker element, which the inspector shows
 * in place, so the preview never pretends to be the whole array.
 */

/** Items kept from any one array before the rest are summarised. */
export const MAX_ARRAY_ITEMS = 500;
/** How deep to walk before summarising a branch rather than copying it. */
export const MAX_DEPTH = 12;
/**
 * Ceiling on the JSON a single output carries. Outputs live in memory and in
 * the autosaved copy of the notebook, so an unbounded preview of a large frame
 * would be paid for on every keystroke's autosave, not just once on screen.
 */
export const MAX_JSON_CHARS = 200_000;

/** Stands in for the items a preview left out. */
export function moreMarker(hidden: number): string {
  return `… ${hidden.toLocaleString('en-US')} more item${hidden === 1 ? '' : 's'}`;
}

/**
 * A JSON-safe copy of `value` with long arrays cut short.
 *
 * Only arrays are shortened; objects are walked so that arrays nested inside
 * them are caught too, which is where the rows usually are.
 */
export function previewValue(value: any, maxItems: number = MAX_ARRAY_ITEMS): any {
  // Tracks the current path, not everything ever seen: the same object
  // appearing twice side by side is ordinary sharing, and calling it circular
  // would hide real data.
  const path = new WeakSet<object>();

  const walk = (v: any, depth: number): any => {
    if (v === null || typeof v !== 'object') return v;
    if (path.has(v)) return '[circular]';
    if (depth >= MAX_DEPTH) return Array.isArray(v) ? `Array(${v.length})` : '{…}';
    // Dates and anything else with toJSON already know how to serialise; walking
    // their internals would turn a date into an empty object.
    if (typeof (v as any).toJSON === 'function') return v;

    path.add(v);
    try {
      if (Array.isArray(v)) {
        const kept: any[] = v.slice(0, maxItems).map((item) => walk(item, depth + 1));
        if (v.length > maxItems) kept.push(moreMarker(v.length - maxItems));
        return kept;
      }
      const out: Record<string, any> = {};
      for (const [key, item] of Object.entries(v)) out[key] = walk(item, depth + 1);
      return out;
    } finally {
      path.delete(v);
    }
  };

  return walk(value, 0);
}

/**
 * The output text for a structured value: pretty JSON small enough to keep.
 *
 * Returns null when even a heavily cut preview would be too large, so the
 * caller can fall back to a plain description rather than store a megabyte.
 */
export function previewJson(value: any): string | null {
  for (const limit of [MAX_ARRAY_ITEMS, 50, 5]) {
    let json: string | undefined;
    try {
      json = JSON.stringify(previewValue(value, limit), null, 2);
    } catch {
      return null; // BigInt, or a getter that throws
    }
    if (json === undefined) return null; // a function, a symbol
    if (json.length <= MAX_JSON_CHARS) return json;
  }
  return null;
}

/** What to show when a value is too large to preview at all. */
export function describeValue(value: any): string {
  if (Array.isArray(value)) return `Array(${value.length.toLocaleString('en-US')}) — too large to display`;
  return `${value?.constructor?.name ?? 'Object'} — too large to display`;
}
