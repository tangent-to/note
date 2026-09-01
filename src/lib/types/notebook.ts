export interface NotebookCell {
  id: string;
  type: "code" | "markdown";
  content: string;
  output?: CellOutput;
  isRunning?: boolean;
  executionOrder?: number;
  collapsed?: boolean;
  outputCollapsed?: boolean;
  /** Skipped cells are greyed out and excluded from execution (tag: #skip). */
  skipped?: boolean;
  /** Read-only cells can be run but not edited (tag: #readonly). */
  readOnly?: boolean;
  /** Output breakout layer: the output escapes the notebook column and
   *  renders wide (~1200px) or full-width (tags: #wide, #full). */
  outputWidth?: "wide" | "full";
}

export interface CellOutput {
  /** `widget` is a serialized ui.* control spec produced by the worker kernel,
   *  rendered as a live control on the main thread (see widgetHost.ts).
   *  `table` is the same idea for tabular values: columns, types, a window of
   *  rows and the true row count (see tableData.ts), rendered as a live sortable
   *  table on the main thread. */
  type: "text" | "html" | "json" | "error" | "dom" | "widget" | "table";
  content: string | Element;
  timestamp: number;
  /**
   * Set when the worker kernel had to serialize a live DOM output, dropping
   * event listeners or scripts it depended on — the reader sees controls that
   * cannot respond. Transient: it describes this run, and is never persisted.
   */
  needsMainThread?: boolean;
}

/** One console round-trip: what was typed, and what came back. */
export interface ConsoleEntry {
  id: number;
  input: string;
  output: CellOutput;
}

export interface Notebook {
  id: string;
  name: string;
  cells: NotebookCell[];
  createdAt: number;
  updatedAt: number;
}

export interface NotebookFile {
  path: string;
  name: string;
  lastModified: number;
}
