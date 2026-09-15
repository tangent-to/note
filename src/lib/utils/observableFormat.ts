/**
 * Observable Notebooks 2.0 (`.html`) in and out.
 *
 * The 2.0 format is HTML: a `<notebook>` root, an optional `<title>`, and one
 * `<script>` per cell whose `type` gives the cell's language. It is a document
 * format, and that is exactly how far this goes — the cells come across, the
 * runtime does not. Observable's runtime is reactive by construction, with
 * generator-driven inputs, `${…}` interpolation inside prose, and
 * `FileAttachment`; Tangent runs cells in dependency order with reactivity as
 * an option, has its own `ui.*` inputs and static Markdown. Those differences
 * do not survive a translation, so rather than pretend, every conversion
 * returns a list of what it could not carry and the caller shows it.
 *
 * Parsed by hand rather than with DOMParser: the escaping rule for `</script>`
 * inside cell source has to be undone anyway, the grammar is small and closed,
 * and keeping it to string functions means the CLI and the tests can use it
 * without a DOM.
 *
 * Format reference: https://observablehq.com/notebook-kit/kit
 */
import type { Notebook, NotebookCell } from '../types/notebook';

/** Something a conversion could not carry across, in the reader's terms. */
export interface Loss {
  /** Grouping key, so repeats collapse into one line with a count. */
  kind: string;
  /** What was affected, e.g. a cell number. */
  where?: string;
  /** What it means for the notebook now. */
  detail: string;
}

export interface ImportResult {
  notebook: Notebook;
  losses: Loss[];
}

export interface ExportResult {
  html: string;
  losses: Loss[];
}

/** 2.0 cell types, mapped to what Tangent can do with them. */
const CELL_TYPES: Record<string, { label: string; as: 'code' | 'markdown' | 'foreign' }> = {
  'module': { label: 'JavaScript', as: 'code' },
  'text/markdown': { label: 'Markdown', as: 'markdown' },
  'text/html': { label: 'HTML', as: 'markdown' },
  'text/x-typescript': { label: 'TypeScript', as: 'foreign' },
  'application/sql': { label: 'SQL', as: 'foreign' },
  'application/x-tex': { label: 'TeX', as: 'foreign' },
  'text/vnd.graphviz': { label: 'DOT', as: 'foreign' },
  'application/vnd.observable.javascript': { label: 'Observable JavaScript', as: 'foreign' },
  'application/vnd.node.javascript': { label: 'Node.js', as: 'foreign' },
  'text/x-python': { label: 'Python', as: 'foreign' },
  'text/x-r': { label: 'R', as: 'foreign' },
};

/**
 * Does this file's head look like a 2.0 notebook?
 *
 * Used to pick a parser for a `.html` file, and by `note serve` to tell a
 * notebook from the rest of the HTML in a directory — most of which is not one.
 */
export function looksLikeObservableNotebook(head: string): boolean {
  return /<notebook[\s>]/i.test(head);
}

/** Attributes off an open tag, with boolean attributes present as ''. */
function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  // Skip the tag name, then read name[=value] pairs.
  const body = tag.replace(/^<\s*[\w-]+/, '');
  const pattern = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

/**
 * Undo the format's `</script>` escaping.
 *
 * A literal `</script>` in cell source is written `<\/script>`, and a run of
 * backslashes in that position takes one more. So each sequence loses exactly
 * one backslash on the way in.
 */
export function unescapeCellSource(source: string): string {
  return source.replace(/<(\\+)\/script>/g, (_, slashes: string) =>
    `<${slashes.slice(1)}/script>`
  );
}

/** The inverse: add one backslash to any `</script>`-shaped sequence. */
export function escapeCellSource(source: string): string {
  return source.replace(/<(\\*)\/script>/g, (_, slashes: string) =>
    `<${slashes}\\/script>`
  );
}

/**
 * Remove the indentation the format adds inside `<script>`.
 *
 * The spec indents cell source by four spaces and trims those on read. Taking
 * the smallest indentation actually present handles that and stays correct for
 * files indented some other way, which the spec says it may allow later.
 */
export function dedent(source: string): string {
  const lines = source.replace(/^\n/, '').replace(/\s+$/, '').split('\n');
  let common = Infinity;
  for (const line of lines) {
    if (line.trim() === '') continue;
    common = Math.min(common, line.length - line.trimStart().length);
  }
  if (!Number.isFinite(common) || common === 0) return lines.join('\n');
  return lines.map((line) => line.slice(common)).join('\n');
}

/** Decode the handful of entities a title can carry. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function encodeEntities(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

interface RawCell {
  attrs: Record<string, string>;
  source: string;
}

/** Scan out the `<script>` cells, respecting the `</script>` escape. */
function scanCells(html: string): RawCell[] {
  const cells: RawCell[] = [];
  const open = /<script\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = open.exec(html)) !== null) {
    const from = open.lastIndex;
    // The first *unescaped* `</script>` ends the cell; an escaped one is part of
    // the source (an HTML cell that writes a script tag, say).
    let end = -1;
    for (let at = from; ; ) {
      const found = html.indexOf('</script>', at);
      if (found === -1) break;
      if (html[found - 1] === '\\') { at = found + 1; continue; }
      end = found;
      break;
    }
    if (end === -1) break; // unterminated: everything after this is not a cell
    cells.push({
      attrs: parseAttributes(`<script${match[1]}>`),
      source: unescapeCellSource(dedent(html.slice(from, end))),
    });
    open.lastIndex = end + '</script>'.length;
  }
  return cells;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .trim() || `notebook-${Date.now()}`
  );
}

/**
 * Read a 2.0 notebook into Tangent's model.
 *
 * Cells arrive in document order with their source intact. What cannot run
 * here — a SQL cell, a `view()` input, `${…}` in prose — is still carried, but
 * reported, because a notebook that looks fine and quietly does not work is
 * worse than one that says what is missing.
 */
export function parseObservableNotebook(html: string, filename = 'notebook.html'): ImportResult {
  const losses: Loss[] = [];
  const notebookTag = /<notebook\b[^>]*>/i.exec(html);
  const notebookAttrs = notebookTag ? parseAttributes(notebookTag[0]) : {};

  const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(html);
  const fallback = filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
  const name =
    (titleMatch ? decodeEntities(titleMatch[1]).trim() : '') ||
    (fallback ? fallback.charAt(0).toUpperCase() + fallback.slice(1) : '') ||
    'Untitled Notebook';

  // A notebook-level lock has no equivalent here, so it becomes a lock on every
  // cell — the same restriction, expressed the only way Tangent can.
  const readonly = 'readonly' in notebookAttrs;

  const cells: NotebookCell[] = [];
  scanCells(html).forEach((raw, index) => {
    const number = index + 1;
    const type = (raw.attrs.type || 'module').toLowerCase();
    const known = CELL_TYPES[type];
    const cell: NotebookCell = {
      // Keep the 2.0 identifier when there is one, so a round trip through
      // Tangent leaves the file's cell identities where the author put them.
      id: raw.attrs.id ? `cell-${raw.attrs.id}` : `cell-${number}`,
      type: 'code',
      content: raw.source,
    };

    if (!known) {
      cell.skipped = true;
      losses.push({
        kind: 'unknown cell type',
        where: `cell ${number}`,
        detail: `\`${type}\` isn't a cell type Tangent knows. Its source is kept, and the cell is skipped so it never runs.`,
      });
    } else if (known.as === 'markdown') {
      cell.type = 'markdown';
      if (/\$\{/.test(raw.source)) {
        losses.push({
          kind: 'interpolation in prose',
          where: `cell ${number}`,
          detail:
            'Observable evaluates `${…}` inside Markdown and HTML; Tangent renders prose statically, so those expressions show as written.',
        });
      }
      if (type === 'text/html') {
        // Markdown cells render HTML, so the source works as-is — worth saying
        // once, because the cell changed kind on the way in.
        losses.push({
          kind: 'HTML cell',
          where: `cell ${number}`,
          detail: 'Imported as a text cell. Markdown renders HTML, so it should look the same.',
        });
      }
    } else if (known.as === 'foreign') {
      cell.skipped = true;
      losses.push({
        kind: `${known.label} cell`,
        where: `cell ${number}`,
        detail: `Tangent runs JavaScript only. The source is kept and the cell is skipped so it never runs.`,
      });
    }

    // `pinned` shows a cell's source; without it Observable hides the code. The
    // default is the opposite of Tangent's, so an unpinned cell comes in folded
    // — which is what its author asked for, and one click undoes it.
    if (known && known.as === 'code' && !('pinned' in raw.attrs)) cell.collapsed = true;
    if ('hidden' in raw.attrs) cell.outputCollapsed = true;
    if (readonly) cell.readOnly = true;

    if (known?.as === 'code') {
      for (const [pattern, kind, detail] of RUNTIME_GAPS) {
        if (pattern.test(raw.source)) {
          losses.push({ kind, where: `cell ${number}`, detail });
        }
      }
    }

    cells.push(cell);
  });

  if (readonly) {
    losses.push({
      kind: 'read-only notebook',
      detail: 'Tangent locks cells, not notebooks, so every cell was imported locked. Unlock from a cell’s menu.',
    });
  }
  if (notebookAttrs.theme) {
    losses.push({
      kind: 'theme',
      detail: `The \`${notebookAttrs.theme}\` theme was dropped; Tangent has its own light and dark themes.`,
    });
  }

  return {
    notebook: {
      id: slugify(name),
      name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cells,
    },
    losses,
  };
}

/**
 * Observable built-ins with no counterpart here.
 *
 * Matched on the source text, which is coarse — a mention inside a string
 * counts. That is the right way round for a warning: a false positive costs a
 * line in a report, a false negative costs a cell that silently does nothing.
 */
const RUNTIME_GAPS: Array<[RegExp, string, string]> = [
  [
    /\bview\s*\(/,
    'view() input',
    'Observable’s `view()` returns a generator that re-runs dependent cells as the input moves. Tangent has its own `ui.*` inputs; this cell needs rewriting.',
  ],
  [
    /\bFileAttachment\s*\(/,
    'FileAttachment',
    'Files are resolved relative to the notebook in Observable. Tangent loads data from its Storage panel or over the network.',
  ],
  [
    /\bfunction\s*\*|\byield\b/,
    'generator cell',
    'A generator drives re-runs on every yield in Observable. Tangent runs a cell once per run.',
  ],
  [
    /\binvalidation\b|\bvisibility\b/,
    'invalidation / visibility',
    'These lifecycle promises have no equivalent in Tangent.',
  ],
];

/**
 * Write a notebook out as a 2.0 file.
 *
 * Tangent is close to a subset here — JavaScript and prose — so most of a
 * notebook crosses intact. What does not is display state Observable has no
 * word for, and two things worth being careful about: a skipped cell would
 * *run* over there, and `ui.*` inputs are Tangent's own.
 */
export function serializeObservableNotebook(notebook: Notebook): ExportResult {
  const losses: Loss[] = [];
  const lines: string[] = ['<!doctype html>'];

  // A notebook where every cell is locked is a read-only notebook, which the
  // format does have a word for.
  const codeOrProse = notebook.cells.length > 0;
  const allReadOnly = codeOrProse && notebook.cells.every((cell) => cell.readOnly);
  lines.push(allReadOnly ? '<notebook readonly>' : '<notebook>');
  lines.push(`  <title>${encodeEntities(notebook.name || 'Untitled Notebook')}</title>`);

  const indent = (source: string) =>
    escapeCellSource(source.trim())
      .split('\n')
      .map((line) => (line === '' ? '' : `    ${line}`))
      .join('\n');

  notebook.cells.forEach((cell, index) => {
    const number = index + 1;
    // A cell's id is `cell-<n>` when it came from a 2.0 file; keep that number
    // so the file's identities survive the round trip.
    const idMatch = /^cell-(\d+)$/.exec(cell.id);
    const id = idMatch ? idMatch[1] : String(number);

    if (cell.skipped) {
      // The format has no way to say "never run this". Left as a code cell it
      // would run on open, which is the one outcome that is plainly wrong, so
      // it is demoted to prose: every character is kept, nothing executes.
      losses.push({
        kind: 'skipped cell',
        where: `cell ${number}`,
        detail:
          'Observable has no skipped cells, and this one would have run. Exported as a text cell holding its source, so it is preserved but inert.',
      });
      const fence = '```' + (cell.type === 'markdown' ? 'md' : 'js');
      lines.push(`  <script id="${id}" type="text/markdown">`);
      lines.push(indent(`${fence}\n${cell.content.trim()}\n\`\`\``));
      lines.push('  </script>');
      return;
    }

    const attrs = [`id="${id}"`];
    if (cell.type === 'markdown') {
      attrs.push('type="text/markdown"');
    } else {
      attrs.push('type="module"');
      // Observable hides source unless a cell is pinned — the opposite default,
      // so an export that said nothing would arrive with all its code hidden.
      if (!cell.collapsed) attrs.push('pinned');
    }
    if (cell.outputCollapsed) attrs.push('hidden');

    lines.push(`  <script ${attrs.join(' ')}>`);
    lines.push(indent(cell.content));
    lines.push('  </script>');

    if (cell.type === 'code' && /\bui\s*\./.test(cell.content)) {
      losses.push({
        kind: 'ui.* input',
        where: `cell ${number}`,
        detail: 'Tangent’s `ui.*` inputs are its own. In Observable, use `view(Inputs.…)` instead.',
      });
    }
    if (cell.outputWidth) {
      losses.push({
        kind: 'output width',
        where: `cell ${number}`,
        detail: `\`#${cell.outputWidth}\` has no equivalent; the output will use Observable's own width.`,
      });
    }
    if (cell.outputView === 'inspector') {
      losses.push({
        kind: 'inspect view',
        where: `cell ${number}`,
        detail: '`#inspect` has no equivalent; Observable always inspects.',
      });
    }
    if (cell.readOnly && !allReadOnly) {
      losses.push({
        kind: 'locked cell',
        where: `cell ${number}`,
        detail: 'Observable locks whole notebooks, not single cells, so this cell exports unlocked.',
      });
    }
  });

  lines.push('</notebook>');
  lines.push('');

  return { html: lines.join('\n'), losses };
}

/** Collapse a report into one line per kind, for a toast or a panel. */
export function summarizeLosses(losses: Loss[]): string[] {
  const byKind = new Map<string, Loss[]>();
  for (const loss of losses) {
    const list = byKind.get(loss.kind);
    if (list) list.push(loss);
    else byKind.set(loss.kind, [loss]);
  }
  return [...byKind.entries()].map(([kind, list]) => {
    const where = list.map((l) => l.where).filter(Boolean);
    const scope = where.length > 0 ? ` (${where.join(', ')})` : '';
    return `${kind}${list.length > 1 ? ` ×${list.length}` : ''}${scope}: ${list[0].detail}`;
  });
}
