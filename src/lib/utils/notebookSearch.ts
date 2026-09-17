/**
 * Find and replace across a whole notebook.
 *
 * Across the notebook rather than inside one editor: every cell is its own small
 * CodeMirror, so an editor-level search would only ever see the few lines of the
 * cell the caret happens to be in. The question people ask is "where else do I
 * use `tempo`", and the answer spans cells.
 *
 * Pure functions on cell sources, so the matching and the replacing — the parts
 * that can quietly corrupt code — are tested without a DOM.
 */
import type { NotebookCell } from '../types/notebook';

export interface SearchOptions {
  query: string;
  caseSensitive?: boolean;
  /** Treat the query as a regular expression. */
  regex?: boolean;
  /** Only match where the query is not part of a longer identifier. */
  wholeWord?: boolean;
}

export interface Match {
  cellId: string;
  from: number;
  to: number;
}

export type Matcher = { regex: RegExp; error: null } | { regex: null; error: string | null };

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The regular expression a search runs, or why there is none.
 *
 * An empty query is no search, not an error. An invalid regex is an error the
 * bar shows while the reader is still typing it — `(` on the way to `(a|b)` —
 * rather than a thrown exception.
 */
export function buildMatcher(options: SearchOptions): Matcher {
  const { query, caseSensitive = false, regex = false, wholeWord = false } = options;
  if (!query) return { regex: null, error: null };

  let source = regex ? query : escapeRegex(query);
  // `\b` is wrong for identifiers that start or end with `$`, which JavaScript
  // allows; lookarounds on the identifier characters are what "whole word"
  // means in code.
  if (wholeWord) source = `(?<![\\w$])(?:${source})(?![\\w$])`;

  try {
    return { regex: new RegExp(source, caseSensitive ? 'gu' : 'giu'), error: null };
  } catch (error: any) {
    return { regex: null, error: error?.message ?? 'Invalid regular expression' };
  }
}

/**
 * Every match in one text, in order.
 *
 * Empty matches are skipped: a pattern like `a*` matches nothing between every
 * character, and a result list of hundreds of invisible hits helps nobody —
 * nor does replacing them.
 */
export function findInText(text: string, regex: RegExp): Array<{ from: number; to: number }> {
  const found: Array<{ from: number; to: number }> = [];
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    found.push({ from: match.index, to: match.index + match[0].length });
  }
  return found;
}

/** Every match in the notebook, cell by cell in document order. */
export function findMatches(cells: NotebookCell[], options: SearchOptions): { matches: Match[]; error: string | null } {
  const matcher = buildMatcher(options);
  if (!matcher.regex) return { matches: [], error: matcher.error };
  const matches: Match[] = [];
  for (const cell of cells) {
    for (const range of findInText(cell.content, matcher.regex)) {
      matches.push({ cellId: cell.id, ...range });
    }
  }
  return { matches, error: null };
}

/**
 * Expand `$1`, `$<name>`, `$&` and `$$` in a replacement, the way
 * String.prototype.replace does — for one match at a time.
 *
 * Replace-one cannot hand the job to String.replace: that would replace every
 * match, or re-run the pattern on the matched text alone and lose whatever a
 * lookbehind or an anchor needed from around it.
 */
export function expandReplacement(replacement: string, match: RegExpExecArray): string {
  return replacement.replace(/\$(\$|&|<([^>]+)>|(\d{1,2}))/g, (whole, token, name, digits) => {
    if (token === '$') return '$';
    if (token === '&') return match[0];
    if (name !== undefined) return match.groups?.[name] ?? '';
    const index = Number(digits);
    if (index >= 1 && index < match.length) return match[index] ?? '';
    return whole;
  });
}

/**
 * Replace the one match starting at `from` in `text`.
 *
 * In plain (non-regex) mode the replacement is literal: a `$` someone types into
 * a replace box meaning a dollar sign must not turn into a back-reference.
 */
export function replaceOne(text: string, from: number, options: SearchOptions, replacement: string): string | null {
  const matcher = buildMatcher(options);
  if (!matcher.regex) return null;
  const re = new RegExp(matcher.regex.source, matcher.regex.flags);
  re.lastIndex = from;
  const match = re.exec(text);
  if (!match || match.index !== from || match[0].length === 0) return null;
  const inserted = options.regex ? expandReplacement(replacement, match) : replacement;
  return text.slice(0, from) + inserted + text.slice(from + match[0].length);
}

/** Replace every match in one text. Returns the new text and how many went. */
export function replaceAllInText(
  text: string,
  options: SearchOptions,
  replacement: string
): { text: string; count: number } {
  const matcher = buildMatcher(options);
  if (!matcher.regex) return { text, count: 0 };
  let count = 0;
  const out = text.replace(new RegExp(matcher.regex.source, matcher.regex.flags), (...args) => {
    const whole = args[0] as string;
    if (whole.length === 0) return whole;
    count++;
    if (!options.regex) return replacement;
    // Rebuild an exec-shaped result for the expander from replace's arguments.
    const hasGroups = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null;
    const groups = hasGroups ? (args[args.length - 1] as Record<string, string>) : undefined;
    const captures = args.slice(1, hasGroups ? -3 : -2) as string[];
    const match = Object.assign([whole, ...captures], { groups, index: 0, input: text }) as unknown as RegExpExecArray;
    return expandReplacement(replacement, match);
  });
  return { text: out, count };
}

export interface ReplaceAllResult {
  /** The cells with their new content, in the notebook's order. */
  cells: NotebookCell[];
  replaced: number;
  /** Matches left alone because their cell is locked. */
  skippedLocked: number;
  /** What each changed cell held before, so the whole operation can be undone. */
  before: Map<string, string>;
}

/**
 * Replace every match in the notebook.
 *
 * A locked cell is left alone and counted, never silently rewritten: locking a
 * cell is a promise that its content will not change without being unlocked.
 */
export function replaceAll(
  cells: NotebookCell[],
  options: SearchOptions,
  replacement: string,
  isLocked: (cell: NotebookCell) => boolean
): ReplaceAllResult {
  const before = new Map<string, string>();
  let replaced = 0;
  let skippedLocked = 0;
  const matcher = buildMatcher(options);
  if (!matcher.regex) return { cells, replaced, skippedLocked, before };

  const next = cells.map((cell) => {
    const hits = findInText(cell.content, matcher.regex!).length;
    if (hits === 0) return cell;
    if (isLocked(cell)) {
      skippedLocked += hits;
      return cell;
    }
    const { text, count } = replaceAllInText(cell.content, options, replacement);
    if (text === cell.content) return cell;
    before.set(cell.id, cell.content);
    replaced += count;
    return { ...cell, content: text };
  });

  return { cells: next, replaced, skippedLocked, before };
}

/**
 * Undo a replace-all, cell by cell.
 *
 * A cell edited since the replacement is not rolled back: undoing the replace
 * must not also undo whatever the reader typed afterwards. Those are reported so
 * the reader knows which cells still hold the replaced text.
 */
export function undoReplaceAll(
  cells: NotebookCell[],
  before: Map<string, string>,
  after: Map<string, string>
): { cells: NotebookCell[]; restored: number; changedSince: number } {
  let restored = 0;
  let changedSince = 0;
  const next = cells.map((cell) => {
    if (!before.has(cell.id)) return cell;
    if (cell.content !== after.get(cell.id)) {
      changedSince++;
      return cell;
    }
    restored++;
    return { ...cell, content: before.get(cell.id)! };
  });
  return { cells: next, restored, changedSince };
}
