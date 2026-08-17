import { describe, it, expect, beforeAll } from 'vitest';
import { parseHTML } from 'linkedom';
import { exportService } from '../exportService';
import type { Notebook } from '../../types/notebook';

// escapeHTML builds a throwaway element, so the export needs a `document`.
beforeAll(() => {
  const g = globalThis as any;
  if (!g.document) g.document = parseHTML('<!doctype html><body></body>').document;
});

function notebookWith(cells: any[]): Notebook {
  return {
    id: 'nb', name: 'Test', cells,
    createdAt: 0, updatedAt: 0,
  } as Notebook;
}

const codeCell = (content: string, output?: any) => ({
  id: `c-${content.length}`, type: 'code', content, output,
});

/** The inline export embeds a replay runtime as a <script> in the HTML. */
async function inlineExport(notebook: Notebook): Promise<string> {
  return (exportService as any).exportToHTMLInline(notebook, {
    includeCode: true, includeOutputs: true, includeTimestamps: false, theme: 'light',
  });
}

describe('exportToHTMLInline', () => {
  const DECL = 'const track = [\n  { pitch: 60 },\n  { pitch: 62 },\n];';

  it('emits a replay script that is valid JavaScript', async () => {
    // Regression: the runtime lives inside a TS template literal, so a stray
    // backtick (or ${) in it silently breaks the emitted script.
    const html = await inlineExport(notebookWith([codeCell(DECL)]));
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });

  it('falls back to the cell as written when the value capture would not parse', async () => {
    const html = await inlineExport(notebookWith([codeCell(DECL)]));
    // The runtime validates its own rewrite and reverts to `promoted`.
    expect(html).toContain('const promoted = code;');
    expect(html).toContain('catch (e) { code = promoted; }');
  });

  it('omits the Out block for a cell that displays nothing', async () => {
    const empty = await inlineExport(
      notebookWith([codeCell(DECL, { type: 'text', content: '', timestamp: 1 })]),
    );
    const shown = await inlineExport(
      notebookWith([codeCell('1 + 1', { type: 'text', content: '2', timestamp: 1 })]),
    );
    expect(empty).not.toContain('Out [1]:');
    expect(shown).toContain('Out [1]:');
  });
});
