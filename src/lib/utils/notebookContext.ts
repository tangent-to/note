import { get } from 'svelte/store';
import { currentNotebook } from '../stores/notebook';
import { loadAIContext } from './aiContext';
import type { Notebook } from '../types/notebook';

// Build a textual snapshot of a notebook so it can be handed to the AI as a
// system prompt. Each cell is labelled with its index and type, and any
// (text) output is included, truncated to keep the prompt a reasonable size.

const MAX_CONTEXT_CHARS = 8000;
const MAX_OUTPUT_CHARS = 500;

export function buildNotebookContext(
  notebook: Notebook | null = get(currentNotebook),
  maxChars: number = MAX_CONTEXT_CHARS
): string {
  if (!notebook || notebook.cells.length === 0) return '';

  const parts: string[] = [`Notebook title: ${notebook.name}`];

  notebook.cells.forEach((cell, index) => {
    const label = cell.type === 'markdown' ? 'Markdown' : 'JavaScript';
    const content = cell.content.trim();
    parts.push(`--- Cell ${index + 1} [${label}] ---\n${content || '(empty)'}`);

    const output = cell.output;
    if (output && typeof output.content === 'string' && output.content.trim()) {
      const prefix = output.type === 'error' ? 'Error output' : 'Output';
      let text = output.content.trim();
      if (text.length > MAX_OUTPUT_CHARS) {
        text = text.slice(0, MAX_OUTPUT_CHARS) + ' …[truncated]';
      }
      parts.push(`${prefix}:\n${text}`);
    }
  });

  let context = parts.join('\n\n');
  if (context.length > maxChars) {
    context = context.slice(0, maxChars) + '\n…[notebook truncated]';
  }
  return context;
}

// Full system prompt for the chat assistant: a description of the assistant's
// role plus the current notebook as context.
export function buildSystemPrompt(notebook: Notebook | null = get(currentNotebook)): string {
  const intro =
    'You are an AI assistant embedded in Tangent, a local-first JavaScript notebook ' +
    'for data analysis and visualization. Help the user understand, write and debug ' +
    'code for their notebook. When you provide code, return runnable JavaScript in a ' +
    'fenced code block.\n\n' +
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
    '- To display a result, end the cell with an expression, or return a DOM node ' +
    '(e.g. an SVG/chart element) to render it.\n\n' +
    'Use the notebook below as context for your answers.';

  const reference = loadAIContext().trim();
  const context = buildNotebookContext(notebook);

  let prompt = intro;
  if (reference) prompt += `\n\n=== REFERENCE ===\n${reference}`;
  if (context) prompt += `\n\n=== CURRENT NOTEBOOK ===\n${context}`;
  return prompt;
}
