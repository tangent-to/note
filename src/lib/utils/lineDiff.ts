/**
 * A line diff, for showing what a proposed cell rewrite would actually change.
 *
 * The whole safety story of letting an assistant edit cells rests on the reader
 * being able to see the change before accepting it, and "here is the new
 * version" is not that: a model asked to fix one line happily returns the cell
 * with a comment reworded and a variable renamed, and pasted side by side
 * nobody notices. So the change is shown as a change.
 *
 * Classic LCS. Cells are tens of lines, so the quadratic table is nothing; the
 * guard below is for the pathological paste, where a diff nobody could read is
 * worth less than saying plainly that the whole thing was replaced.
 */

export type DiffOp = 'same' | 'add' | 'remove';

export interface DiffLine {
  op: DiffOp;
  text: string;
}

/** Above this many lines on either side, report a wholesale replacement. */
const MAX_DIFF_LINES = 1500;

function splitLines(text: string): string[] {
  // A trailing newline is not a final empty line anyone wants to see marked as
  // added or removed.
  return text.replace(/\n$/, '').split('\n');
}

export function diffLines(before: string, after: string): DiffLine[] {
  if (before === after) return splitLines(before).map((text) => ({ op: 'same' as const, text }));

  const a = splitLines(before);
  const b = splitLines(after);

  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [
      ...a.map((text) => ({ op: 'remove' as const, text })),
      ...b.map((text) => ({ op: 'add' as const, text })),
    ];
  }

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ op: 'remove', text: a[i] });
      i++;
    } else {
      out.push({ op: 'add', text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ op: 'remove', text: a[i++] });
  while (j < b.length) out.push({ op: 'add', text: b[j++] });

  return out;
}

/** How many lines the change touches, for a one-line summary. */
export function diffStat(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.op === 'add') added++;
    else if (line.op === 'remove') removed++;
  }
  return { added, removed };
}
