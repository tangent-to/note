import type { Notebook } from '../types/notebook';
import { ExportService } from './exportService';
import { applyCellTags, normalizeMarkdownContent, serializeNotebook } from './notebookFormat';
import {
  looksLikeObservableNotebook,
  parseObservableNotebook,
  serializeObservableNotebook,
  type Loss,
} from './observableFormat';
import { toast } from './toast';

const exportService = new ExportService();

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim() || 'notebook';
}

export function downloadText(text: string, filename: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Serialize a notebook to its `.js` source. Used both by the download path and
 * by the `note serve` companion, which writes the same bytes to disk.
 */
export async function exportNotebookSource(notebook: Notebook): Promise<string> {
  return (await exportService.exportNotebook(notebook, {
    includeCode: true,
    includeOutputs: true,
    includeTimestamps: false,
    theme: 'light',
    format: 'js'
  })) as string;
}

/**
 * Serialize a notebook for a path the companion owns, in that file's own
 * format.
 *
 * Discovery offers `.html` notebooks as well as `.js` ones, so saving has to
 * write back what it read: putting Tangent's `.js` source into a file whose
 * author writes Observable HTML would destroy it. Losses come back with the
 * content because a save to `.html` can be lossy and the reader should hear
 * about it — for a plain notebook the list is empty and nothing is said.
 */
export function serializeForPath(
  notebook: Notebook,
  path: string
): { content: string; losses: Loss[] } {
  if (path.toLowerCase().endsWith('.html')) {
    const { html, losses } = serializeObservableNotebook(notebook);
    return { content: html, losses };
  }
  return { content: serializeNotebook(notebook), losses: [] };
}

export async function saveNotebook(notebook: Notebook): Promise<void> {
  const baseName = slugify(notebook.name || 'notebook');
  const content = await exportNotebookSource(notebook);
  downloadText(content, `${baseName}.js`, 'text/javascript');
}

export function parseJSNotebook(text: string, filename = 'notebook.js') {
  const lines = text.split('\n');
  const metadata: Record<string, string> = {};
  const cells: any[] = [];
  let currentCell: any = null;
  let inMetadata = false;
  let markdownContent = '';
  let codeContent = '';

  const slugifyValue = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .trim();

  const deriveDefaultName = () => {
    if (!filename) return '';
    const base = filename.replace(/\.[^.]+$/, '');
    const spaced = base.replace(/[-_]+/g, ' ').trim();
    return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : '';
  };

  const defaultName = deriveDefaultName();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const withoutComment = trimmed.replace(/^\/\/\s*/, '');

    if (withoutComment === '---') {
      if (!inMetadata) {
        inMetadata = true;
      } else {
        inMetadata = false;
      }
      continue;
    }

    if (inMetadata) {
      const match = withoutComment.match(/^([\w-]+):\s*(.+)$/);
      if (match) {
        metadata[match[1]] = match[2].trim();
      }
      continue;
    }

    if (line.startsWith('// %% ')) {
      if (currentCell) {
        if (currentCell.type === 'markdown') {
          currentCell.content = normalizeMarkdownContent(markdownContent);
        } else if (currentCell.type === 'code') {
          currentCell.content = codeContent.trim();
        }
        cells.push(currentCell);
      }

      const typeMatch = line.match(/\/\/ %% \[(\w+)\]/);
      if (typeMatch) {
        const type = typeMatch[1];
        currentCell = {
          id: `cell-${cells.length + 1}`,
          type: type === 'javascript' ? 'code' : type,
          content: '',
          output: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        applyCellTags(currentCell, line);
        markdownContent = '';
        codeContent = '';
      }
      continue;
    }

    if (currentCell) {
      if (currentCell.type === 'markdown') {
        // Collect every line; normalizeMarkdownContent() strips the `//` line
        // comments (jupytext form) and/or the wrapping /* */ at finalization.
        markdownContent += line + '\n';
      } else if (currentCell.type === 'code') {
        codeContent += line + '\n';
      }
    }
  }

  if (currentCell) {
    if (currentCell.type === 'markdown') {
      currentCell.content = normalizeMarkdownContent(markdownContent);
    } else if (currentCell.type === 'code') {
      currentCell.content = codeContent.trim();
    }
    cells.push(currentCell);
  }

  const notebookName =
    (metadata.title && metadata.title.length > 0 ? metadata.title : defaultName) ||
    'Sample Notebook';
  const notebookId =
    (metadata.id && metadata.id.length > 0 ? metadata.id : slugifyValue(notebookName)) ||
    `notebook-${Date.now()}`;

  return {
    id: notebookId,
    name: notebookName,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    cells,
  };
}

/**
 * Read a notebook out of a file's text, picking the format by its content
 * rather than only its name.
 *
 * `.html` covers a great deal more than notebooks, so an Observable file is
 * recognised by its `<notebook>` root; anything else with that extension is
 * refused rather than parsed into an empty notebook.
 *
 * Returns whatever the conversion could not carry, which for an Observable
 * notebook is the interesting half: a file that imports cleanly and quietly
 * does not work is worse than one that says what is missing.
 */
export function parseNotebookFile(text: string, filename: string): { notebook: any; losses: Loss[] } {
  const name = filename.toLowerCase();
  if (name.endsWith('.html') || looksLikeObservableNotebook(text.slice(0, 2000))) {
    if (!looksLikeObservableNotebook(text.slice(0, 2000))) {
      throw new Error('that HTML file isn’t an Observable notebook');
    }
    return parseObservableNotebook(text, filename);
  }
  if (name.endsWith('.js')) return { notebook: parseJSNotebook(text, filename), losses: [] };
  return { notebook: JSON.parse(text), losses: [] };
}

// The filename is handed back too: it is what the library shows as the
// notebook's origin, and the browser gives no path to show instead.
export function importNotebookFromFile(
  callback: (notebook: any, filename: string, losses: Loss[]) => void
) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.js,.html';
  input.onchange = async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;

    try {
      const { notebook, losses } = parseNotebookFile(await file.text(), file.name);

      if (!notebook.id || !notebook.cells || !Array.isArray(notebook.cells)) {
        toast('That file isn’t a valid notebook.', 'error');
        return;
      }

      callback(notebook, file.name, losses);
    } catch (err: any) {
      console.error('Import failed:', err);
      toast('Couldn’t import the notebook: ' + err.message, 'error');
    }
  };
  input.click();
}
