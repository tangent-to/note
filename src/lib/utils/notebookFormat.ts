import type { Notebook, NotebookCell } from "../types/notebook";

/**
 * Cell tags carried on the `// %%` delimiter line, e.g.
 * `// %% [javascript] #collapse-cell #skip`. Unknown tags are ignored so
 * the format stays forward-compatible.
 */
export function serializeCellTags(cell: Pick<NotebookCell, "collapsed" | "skipped" | "outputCollapsed" | "readOnly">): string {
  const tags = [
    cell.collapsed ? "#collapse-cell" : null,
    cell.outputCollapsed ? "#collapse-output" : null,
    cell.skipped ? "#skip" : null,
    cell.readOnly ? "#readonly" : null,
  ].filter(Boolean);
  return tags.length ? ` ${tags.join(" ")}` : "";
}

/** Apply the tags found on a delimiter line to a freshly parsed cell. */
export function applyCellTags(cell: NotebookCell, delimiterLine: string): void {
  const tags = new Set(
    (delimiterLine.match(/#[\w-]+/g) ?? []).map((t) => t.slice(1)),
  );
  // "hide-cell"/"hide" and "hide-output" are accepted as legacy aliases.
  if (tags.has("collapse-cell") || tags.has("hide-cell") || tags.has("hide")) cell.collapsed = true;
  if (tags.has("collapse-output") || tags.has("hide-output")) cell.outputCollapsed = true;
  if (tags.has("skip")) cell.skipped = true;
  if (tags.has("readonly")) cell.readOnly = true;
}

/**
 * Serialize a notebook to Jupytext-style format
 * Format:
 * // %% [markdown]
 * /*
 * # Markdown content
 * *\/
 *
 * // %% [javascript]
 * const a = 3;
 */
export function serializeNotebook(notebook: Notebook): string {
  const lines: string[] = [];

  // Add notebook metadata as a comment header
  lines.push(`// ---`);
  lines.push(`// title: ${notebook.name || "Untitled"}`);
  lines.push(`// id: ${notebook.id}`);
  lines.push(`// ---`);
  lines.push("");

  // Serialize each cell
  notebook.cells.forEach((cell, index) => {
    // Cell state (collapsed/skipped/…) rides on the delimiter as tags so
    // it survives a round-trip through the file.
    const tags = serializeCellTags(cell);
    // Add cell delimiter
    if (cell.type === "markdown") {
      lines.push(`// %% [markdown]${tags}`);
      lines.push("/*");
      // Add markdown content, ensuring each line is preserved
      const content = cell.content.trim();
      if (content) {
        lines.push(content);
      }
      lines.push("*/");
    } else {
      lines.push(`// %% [javascript]${tags}`);
      // Add code content directly
      const content = cell.content.trim();
      if (content) {
        lines.push(content);
      }
    }

    // Add blank line between cells (except after last cell)
    if (index < notebook.cells.length - 1) {
      lines.push("");
    }
  });

  return lines.join("\n");
}

/**
 * Normalize the raw body of a `// %% [markdown]` cell into plain markdown.
 *
 * tangent/note writes markdown inside a `/* … *\/` block, but round-tripping the
 * file through Jupyter/jupytext line-comments every cell line with `//` —
 * including the block delimiters — turning
 *
 *   /*                 ->  // /*
 *   ## Heading         ->  // ## Heading
 *   *\/                ->  // *\/
 *
 * so the `/*` guard in the parser never fires and the cell reads as commented
 * noise (blank when rendered). Detect that fully-commented form, strip the `//`
 * prefix, then drop any wrapping `/* … *\/` delimiters. A native (uncommented)
 * cell is returned unchanged.
 */
function normalizeMarkdownContent(raw: string): string {
  let lines = raw.split("\n");
  const nonEmpty = lines.filter((l) => l.trim() !== "");
  const allCommented =
    nonEmpty.length > 0 && nonEmpty.every((l) => l.trim().startsWith("//"));
  if (allCommented) {
    // Remove one leading `// ` (or bare `//`) per line, preserving indentation.
    lines = lines.map((l) => l.replace(/^(\s*)\/\/ ?/, "$1"));
  }
  // Trim blank edges, then drop wrapping /* … */ if present.
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length && lines[0].trim() === "/*") lines.shift();
  if (lines.length && lines[lines.length - 1].trim() === "*/") lines.pop();
  return lines.join("\n").trim();
}

/**
 * Parse a Jupytext-style notebook into our internal format
 */
export function parseNotebook(
  content: string,
  filename: string = "notebook",
): Notebook {
  const lines = content.split("\n");

  // Extract metadata from header
  let title = filename.replace(/\.(js|txt)$/, "");
  let notebookId = `notebook-${Date.now()}`;

  let i = 0;
  // Skip any lines before the header block
  while (i < lines.length && lines[i].trim() !== "// ---") {
    i++;
  }
  // No header at all: start over and parse the whole file as cells.
  if (i >= lines.length) {
    i = 0;
  }
  // Parse header metadata if present
  if (lines[i]?.trim() === "// ---") {
    i++;
    while (i < lines.length && lines[i]?.trim() !== "// ---") {
      const line = lines[i].trim();
      if (line.startsWith("// title:")) {
        title = line.substring("// title:".length).trim();
      } else if (line.startsWith("// id:")) {
        notebookId = line.substring("// id:".length).trim();
      }
      i++;
    }
    if (lines[i]?.trim() === "// ---") {
      i++; // Skip closing ---
    }
  }

  const cells: NotebookCell[] = [];
  let currentCell: NotebookCell | null = null;
  let inMarkdownBlock = false;
  let cellContent: string[] = [];

  // Parse cells
  while (i < lines.length) {
    const line = lines[i];

    // Check for cell delimiter
    if (line.trim().startsWith("// %%")) {
      // Save previous cell if exists
      if (currentCell) {
        currentCell.content = currentCell.type === "markdown"
          ? normalizeMarkdownContent(cellContent.join("\n"))
          : cellContent.join("\n").trim();
        cells.push(currentCell);
        cellContent = [];
      }

      // Parse cell type
      const match = line.match(/\/\/ %%\s*\[(\w+)\]/);
      const cellType = match ? match[1] : "javascript";

      currentCell = {
        id: `cell-${Date.now()}-${cells.length}`,
        type: cellType === "markdown" ? "markdown" : "code",
        content: "",
        output: null,
        isRunning: false,
      };
      applyCellTags(currentCell, line);

      // Check if next line starts a markdown block
      if (
        cellType === "markdown" && i + 1 < lines.length &&
        lines[i + 1].trim() === "/*"
      ) {
        inMarkdownBlock = true;
        i++; // Skip the /*
      }
    } else if (inMarkdownBlock && line.trim() === "*/") {
      // End of markdown block
      inMarkdownBlock = false;
    } else if (currentCell) {
      // Add line to current cell content
      cellContent.push(line);
    }

    i++;
  }
  // Save last cell
  if (currentCell) {
    currentCell.content = currentCell.type === "markdown"
      ? normalizeMarkdownContent(cellContent.join("\n"))
      : cellContent.join("\n").trim();
    cells.push(currentCell);
  }

  // If no cells were parsed, create a default empty cell
  if (cells.length === 0) {
    cells.push({
      id: `cell-${Date.now()}`,
      type: "code",
      content: "",
      output: null,
      isRunning: false,
    });
  }

  const now = Date.now();
  return {
    id: notebookId,
    name: title,
    cells,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Get the file extension for the text format
 */
export function getNotebookExtension(): string {
  return ".js";
}

/**
 * Generate a filename for a notebook
 */
export function getNotebookFilename(notebook: Notebook): string {
  const name = notebook.name || "untitled";
  // Sanitize filename
  const safeName = name.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  return `${safeName}${getNotebookExtension()}`;
}
