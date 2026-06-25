import { get } from 'svelte/store';
import { currentNotebook } from '../stores/notebook';
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
    'for data analysis and visualization (libraries available include Observable Plot, ' +
    'Plotly, D3.js, Vega-Lite and Arquero). Help the user understand, write and debug ' +
    'code for their notebook. When you provide code, return runnable JavaScript in a ' +
    'fenced code block. Use the notebook below as context for your answers.';

  const context = buildNotebookContext(notebook);
  return context ? `${intro}\n\n=== CURRENT NOTEBOOK ===\n${context}` : intro;
}
