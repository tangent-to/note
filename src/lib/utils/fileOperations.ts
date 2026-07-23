import type { Notebook } from '../types/notebook';
import { ExportService } from './exportService';
import { applyCellTags, normalizeMarkdownContent } from './notebookFormat';
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

export function importNotebookFromFile(callback: (notebook: any) => void) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.js';
  input.onchange = async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      let notebook;

      if (file.name.toLowerCase().endsWith('.js')) {
        notebook = parseJSNotebook(text, file.name);
      } else {
        notebook = JSON.parse(text);
      }

      if (!notebook.id || !notebook.cells || !Array.isArray(notebook.cells)) {
        toast('That file isn’t a valid notebook.', 'error');
        return;
      }

      callback(notebook);
    } catch (err: any) {
      console.error('Import failed:', err);
      toast('Couldn’t import the notebook: ' + err.message, 'error');
    }
  };
  input.click();
}
