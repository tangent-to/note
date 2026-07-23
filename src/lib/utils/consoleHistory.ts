/**
 * Pure input-history navigation for the console REPL. Kept free of any kernel
 * or DOM dependency so it can be unit-tested in isolation.
 *
 * `index` is the position currently recalled, or null when editing a fresh
 * ("live") line. `prev` steps toward older entries, `next` toward newer and
 * then back to the live line.
 *
 * The returned `value` is the text to place in the editor, or null to signal
 * "do nothing, let the keypress fall through" (empty history, or pressing down
 * while already on the live line). An empty string means "clear to a fresh line".
 */
export function navigateHistory(
  history: string[],
  index: number | null,
  direction: 'prev' | 'next'
): { index: number | null; value: string | null } {
  if (history.length === 0) return { index, value: null };

  if (direction === 'prev') {
    const nextIndex = index === null ? history.length - 1 : Math.max(0, index - 1);
    return { index: nextIndex, value: history[nextIndex] };
  }

  // direction === 'next'
  if (index === null) return { index: null, value: null };
  const nextIndex = index + 1;
  if (nextIndex >= history.length) return { index: null, value: '' };
  return { index: nextIndex, value: history[nextIndex] };
}
