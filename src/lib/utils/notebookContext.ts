import { get } from 'svelte/store';
import { currentNotebook } from '../stores/notebook';
import { loadAIContext } from './aiContext';
import type { Notebook, NotebookCell } from '../types/notebook';

/**
 * The notebook, written out so an assistant can read it *and* point at parts of
 * it.
 *
 * The first version concatenated every cell and cut the string at a fixed
 * length. That is fine for answering a question about the top of a notebook and
 * wrong for anything else: in a notebook long enough to matter, the tail simply
 * did not exist as far as the model was concerned — it never learned there were
 * cells 13 through 30, so it could neither mention them nor avoid redefining
 * what they already defined.
 *
 * So the budget is spent differently here. Every cell's header is written no
 * matter what, which costs a line and buys the notebook's true shape; the
 * bodies are then shared out, shortest first, so a notebook of small cells
 * arrives whole and only genuinely long cells are cut. And each cell carries a
 * number, which is the address the rest of the feature uses: "rewrite cell 3"
 * is a thing the model can say and we can resolve.
 */

const MAX_CONTEXT_CHARS = 24000;
const MAX_OUTPUT_CHARS = 500;

export interface ContextOptions {
  maxChars?: number;
  /**
   * The cell under discussion. It is written in full and marked, because an
   * assistant asked to rewrite a cell it has seen only the first half of will
   * confidently delete the rest.
   */
  focusCellId?: string | null;
}

/**
 * Share `budget` characters across items of the given lengths, shortest first.
 *
 * Each round offers an equal share of what is left; an item that needs less
 * than its share takes what it needs and returns the rest to the pool. The
 * effect is that shortening happens only where the length actually is — cutting
 * every cell to the same length would mutilate a one-line cell to pay for a
 * hundred-line one.
 */
export function shareBudget(lengths: number[], budget: number): number[] {
  const allowed = new Array<number>(lengths.length).fill(0);
  const shortestFirst = lengths.map((_, i) => i).sort((a, b) => lengths[a] - lengths[b]);

  let remaining = Math.max(0, budget);
  let unserved = shortestFirst.length;
  for (const i of shortestFirst) {
    const share = Math.floor(remaining / unserved);
    const take = Math.min(lengths[i], share);
    allowed[i] = take;
    remaining -= take;
    unserved--;
  }
  return allowed;
}

function clip(text: string, allowed: number, what: string): string {
  if (text.length <= allowed) return text;
  if (allowed <= 0) return `…[${what} omitted, ${text.length} chars]`;
  return `${text.slice(0, allowed)}\n…[${what} truncated]`;
}

function outputText(cell: NotebookCell): string {
  const output = cell.output;
  if (!output || typeof output.content !== 'string') return '';
  return output.content.trim();
}

function header(index: number, cell: NotebookCell, focused: boolean): string {
  const label = cell.type === 'markdown' ? 'Markdown' : 'JavaScript';
  const tags = [
    cell.skipped ? 'skipped' : null,
    cell.readOnly ? 'read-only' : null,
    focused ? '<<< THE CELL IN QUESTION' : null,
  ].filter(Boolean);
  return `--- Cell ${index + 1} [${label}]${tags.length ? ' ' + tags.join(' ') : ''} ---`;
}

export function buildNotebookContext(
  notebook: Notebook | null = get(currentNotebook),
  options: ContextOptions = {}
): string {
  const { maxChars = MAX_CONTEXT_CHARS, focusCellId = null } = options;
  if (!notebook || notebook.cells.length === 0) return '';

  const cells = notebook.cells;
  const focusIndex = cells.findIndex((c) => c.id === focusCellId);

  const intro =
    `Notebook title: ${notebook.name}\n` +
    `${cells.length} cell${cells.length === 1 ? '' : 's'}, numbered below. ` +
    `Refer to a cell by its number.`;
  const headers = cells.map((cell, i) => header(i, cell, i === focusIndex));

  // Headers are non-negotiable, so they come off the top.
  const fixed = intro.length + headers.reduce((n, h) => n + h.length + 4, 0);
  let budget = Math.max(0, maxChars - fixed);

  const contents = cells.map((c) => c.content.trim());
  const outputs = cells.map(outputText);

  // The focus cell is served before the pool is shared, and never clipped.
  if (focusIndex >= 0) {
    budget = Math.max(0, budget - contents[focusIndex].length);
  }

  const contentBudget = contents.map((text, i) => (i === focusIndex ? 0 : text.length));
  const contentAllowed = shareBudget(contentBudget, budget);
  const spentOnContent = contentAllowed.reduce((n, v) => n + v, 0);

  // Outputs are worth having but never at the cost of the code that produced
  // them, so they share only what the bodies left behind.
  const outputBudget = outputs.map((text, i) =>
    i === focusIndex ? 0 : Math.min(text.length, MAX_OUTPUT_CHARS)
  );
  const outputAllowed = shareBudget(outputBudget, budget - spentOnContent);

  const parts: string[] = [intro];
  cells.forEach((cell, i) => {
    const focused = i === focusIndex;
    const body = focused
      ? contents[i]
      : clip(contents[i], contentAllowed[i], 'cell');
    parts.push(`${headers[i]}\n${body || '(empty)'}`);

    if (!outputs[i]) return;
    const kind = cell.output?.type === 'error' ? 'Error output' : 'Output';
    const shown = focused
      ? clip(outputs[i], MAX_OUTPUT_CHARS, 'output')
      : clip(outputs[i], outputAllowed[i], 'output');
    if (outputAllowed[i] > 0 || focused) parts.push(`${kind}:\n${shown}`);
  });

  return parts.join('\n\n');
}

const RUNTIME_NOTES =
  'Runtime (important):\n' +
  '- This runs in the BROWSER, not Node.js. Never use Node APIs (require, module, ' +
  'createRequire, fs, process, __dirname).\n' +
  '- Import libraries as browser ESM from a CDN, e.g. ' +
  'import * as d3 from "https://cdn.jsdelivr.net/npm/d3/+esm"; a bare specifier like ' +
  'import * as aq from "arquero" also works (resolved from jsDelivr). Top-level await ' +
  'is allowed.\n' +
  '- d3 and Plot (Observable Plot) are preloaded as globals; Plotly, Vega-Lite and ' +
  'Arquero are available via import. \n' +
  '- Variables declared with const/let are shared across cells; use globalThis.x for ' +
  'mutable cross-cell state.\n' +
  '- `width` is a builtin holding the current output-area width in pixels (like ' +
  "Observable's width): size charts with Plot.plot({ width }).\n" +
  '- To display a result, end the cell with an expression, or return a DOM node ' +
  '(e.g. an SVG/chart element) to render it.';

/** Assemble a system prompt: role, runtime notes, the user's reference, the notebook. */
export function composeSystemPrompt(role: string, context: string): string {
  const reference = loadAIContext().trim();
  let prompt = `${role}\n\n${RUNTIME_NOTES}`;
  if (reference) prompt += `\n\n=== REFERENCE ===\n${reference}`;
  if (context) prompt += `\n\n=== CURRENT NOTEBOOK ===\n${context}`;
  return prompt;
}

// Full system prompt for the chat assistant: a description of the assistant's
// role plus the current notebook as context.
export function buildSystemPrompt(
  notebook: Notebook | null = get(currentNotebook),
  focusCellId: string | null = null
): string {
  const role =
    'You are an AI assistant embedded in Tangent, a local-first JavaScript notebook ' +
    'for data analysis and visualization. Help the user understand, write and debug ' +
    'code for their notebook. When you provide code, return runnable JavaScript in a ' +
    'fenced code block.\n\n' +
    'Use the notebook below as context for your answers.';
  return composeSystemPrompt(role, buildNotebookContext(notebook, { focusCellId }));
}
