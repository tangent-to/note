import type { Notebook, NotebookCell } from "../types/notebook";

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
    // Collapsed cells carry a #hide tag on the delimiter so the state
    // survives a round-trip through the file.
    const tags = cell.collapsed ? " #hide" : "";
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
        currentCell.content = cellContent.join("\n").trim();
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
      // A #hide tag on the delimiter renders the cell collapsed in the UI.
      if (/(^|\s)#hide\b/.test(line)) {
        currentCell.collapsed = true;
      }

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
    currentCell.content = cellContent.join("\n").trim();
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
