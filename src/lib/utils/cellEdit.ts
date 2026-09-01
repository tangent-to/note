/**
 * Asking the assistant to rewrite one cell, and reading its answer back.
 *
 * Deliberately narrow. The assistant is told which cell it is rewriting, it is
 * given that cell in full, and it is asked for the cell's whole new content and
 * nothing else — no patch format to misapply, no cell to choose, no file to
 * write. What comes back is a proposal, and the notebook does not change until
 * the reader accepts it.
 */
import { composeSystemPrompt, buildNotebookContext } from './notebookContext';
import type { Notebook, NotebookCell } from '../types/notebook';

export interface CellTarget {
  cell: NotebookCell;
  /** 1-based, matching the numbering the context uses. */
  number: number;
}

/** The cell an edit would apply to, with the address the prompt gives it. */
export function targetCell(notebook: Notebook | null, cellId: string | null): CellTarget | null {
  if (!notebook || !cellId) return null;
  const index = notebook.cells.findIndex((c) => c.id === cellId);
  if (index === -1) return null;
  return { cell: notebook.cells[index], number: index + 1 };
}

export function buildCellEditPrompt(notebook: Notebook, target: CellTarget): string {
  const kind = target.cell.type === 'markdown' ? 'Markdown' : 'JavaScript';
  const role =
    `You are editing one cell of the notebook below: cell ${target.number} (${kind}), ` +
    `marked "THE CELL IN QUESTION".\n\n` +
    `Reply with the complete new content of that cell and nothing else — no ` +
    `explanation, no commentary, and do not repeat any other cell. Put it in a ` +
    `single fenced code block. Keep everything the user did not ask you to change, ` +
    `including comments and formatting. If the request cannot be done by editing ` +
    `this one cell, reply with the cell unchanged and say why in a comment.`;
  return composeSystemPrompt(role, buildNotebookContext(notebook, { focusCellId: target.cell.id }));
}

/**
 * Pull the cell's new content out of a reply.
 *
 * Fenced blocks win when present: models add a sentence before the code however
 * firmly they are told not to, and that sentence is not part of the cell. With
 * no fence the whole reply is the content, which is what a one-line markdown
 * edit usually looks like.
 */
export function extractCodeFromMessage(message: string): string {
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = fence.exec(message)) !== null) {
    blocks.push(match[1].replace(/\s+$/, ''));
  }
  return blocks.length > 0 ? blocks.join('\n\n') : message.trim();
}
