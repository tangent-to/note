/**
 * Turning a tabular value into data the main thread can render.
 *
 * The worker kernel can only send strings, so a table built as DOM inside it
 * arrives with its behaviour stripped (see cellOutput.ts). Tables therefore
 * travel as data — columns, types, a window of rows, and the true row count —
 * and the live, sortable table is built on the main thread from that. It is the
 * same split the `ui.*` widgets already use.
 *
 * Only a window of rows is sent. A 50k-row table rendered whole produced ~15,000
 * pixels of output and 59KB of markup persisted on every autosave, and silently
 * dropped every row past the first 500 without saying so.
 */

/** How many rows travel with the output. The rest are summarised by `totalRows`. */
export const ROW_WINDOW = 1000;

/** Column types, used to revive values the JSON round trip would flatten. */
export type ColumnType = 'number' | 'string' | 'boolean' | 'date' | 'object';

export interface TableSpec {
  columns: string[];
  types: Record<string, ColumnType>;
  rows: Record<string, unknown>[];
  /** Rows in the source table, which may exceed `rows.length`. */
  totalRows: number;
}

const MAX_COLUMNS = 100;

function typeOf(value: unknown): ColumnType {
  if (value instanceof Date) return 'date';
  const t = typeof value;
  if (t === 'number' || t === 'bigint') return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'string') return 'string';
  return 'object';
}

/** Dates survive JSON as ISO strings; everything else is already portable. */
function serializeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return Number(value);
  return value;
}

/**
 * An Arquero-style table: `objects()`, `columnNames()` and `numRows()`. Plain
 * arrays are left to the inspector, which already handles them well.
 */
function looksTabular(value: any): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof value.objects === 'function' &&
    typeof value.columnNames === 'function' &&
    typeof value.numRows === 'function'
  );
}

export function tableSpec(value: any): TableSpec | null {
  if (!looksTabular(value)) return null;

  let totalRows = 0;
  try {
    totalRows = Number(value.numRows()) || 0;
  } catch {
    totalRows = 0;
  }

  let rows: any[];
  try {
    // `objects({limit})` is Arquero's own windowing; fall back to slicing for
    // tables that ignore the option.
    const result = value.objects({ limit: ROW_WINDOW });
    rows = Array.isArray(result) ? result : Array.from(result ?? []);
    if (rows.length > ROW_WINDOW) rows = rows.slice(0, ROW_WINDOW);
  } catch {
    return null;
  }
  if (rows.length === 0) return null;

  let columns: string[] = [];
  try {
    const named = value.columnNames();
    if (Array.isArray(named)) columns = named.slice(0, MAX_COLUMNS);
  } catch {
    columns = [];
  }
  if (columns.length === 0) {
    const seen = new Set<string>();
    for (const row of rows) {
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        for (const key of Object.keys(row)) seen.add(key);
      }
    }
    columns = [...seen].slice(0, MAX_COLUMNS);
  }
  if (columns.length === 0) return null;

  const types: Record<string, ColumnType> = {};
  for (const column of columns) {
    const sample = rows.find((row) => row?.[column] !== null && row?.[column] !== undefined);
    types[column] = sample ? typeOf(sample[column]) : 'string';
  }

  const windowed = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const column of columns) out[column] = serializeValue(row?.[column]);
    return out;
  });

  return { columns, types, rows: windowed, totalRows: Math.max(totalRows, windowed.length) };
}
