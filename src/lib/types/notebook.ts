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
  /**
   * Force this cell's output to be shown as a structure rather than a frame
   * (tag: #inspect).
   *
   * An array of records renders as a sortable table, which is what you want for
   * rows and exactly not what you want when the question is "what shape is this
   * thing". A display choice, so it lives on the cell like the width tags do
   * rather than in the code — and it is applied when the output is rendered,
   * not when it runs, so toggling it never re-executes anything.
   */
  outputView?: "inspector";
}

export interface CellOutput {
  /** `widget` is a serialized ui.* control spec produced by the worker kernel,
   *  rendered as a live control on the main thread (see widgetHost.ts).
   *  `table` is the same idea for tabular values: columns, types, a window of
   *  rows and the true row count (see tableData.ts), rendered as a live sortable
   *  table on the main thread. */
  type: "text" | "html" | "json" | "error" | "dom" | "widget" | "table";

  /**
   * What the cell printed while it ran, kept apart from the value it produced.
   *
   * They used to be one string, joined with newlines — which meant a single
   * console.log turned a value's rendering into plain text (the JSON no longer
   * parsed), and a log before a chart or a table was dropped on the floor
   * entirely. Separated, the value keeps whatever rendering it deserves and the
   * printing is shown above it.
   */
  logs?: LogLine[];
  content: string | Element;
  timestamp: number;
  /**
   * Set when the worker kernel had to serialize a live DOM output, dropping
   * event listeners or scripts it depended on — the reader sees controls that
   * cannot respond. Transient: it describes this run, and is never persisted.
   */
  needsMainThread?: boolean;
}

/** One line a cell printed while it ran. */
export interface LogLine {
  level: "log" | "warn" | "error";
  text: string;
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
