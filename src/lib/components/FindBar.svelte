<script lang="ts">
  /**
   * Find and replace across the notebook on screen.
   *
   * Opened by Ctrl/Cmd+F (find) or Ctrl+H / Cmd+Option+F (replace), from the
   * window-level `open-find` event. The matching and replacing live in
   * notebookSearch.ts; this is the bar, the navigation between hits, and the
   * two things a bar has to get right beyond that: never taking the keyboard
   * away from the query while stepping through hits, and making Replace all
   * undoable as one act.
   */
  import { onMount, tick, untrack } from 'svelte';
  import { get } from 'svelte/store';
  import {
    currentNotebook,
    markNotebookDirty,
    recomputeStaleCells,
    updateCellContent,
  } from '../stores/notebook';
  import { activeSessionId } from '../stores/sessions';
  import {
    buildMatcher,
    findMatches,
    replaceAll,
    replaceOne,
    undoReplaceAll,
    type Match,
  } from '../utils/notebookSearch';
  import { searchHighlight } from '../utils/cmSearchHighlight';
  import type { NotebookCell } from '../types/notebook';

  let open = $state(false);
  let showReplace = $state(false);
  let query = $state('');
  let replacement = $state('');
  let caseSensitive = $state(false);
  let regex = $state(false);
  let wholeWord = $state(false);
  let index = $state(0);
  let status: string | null = $state(null);

  let queryInput: HTMLInputElement | null = $state(null);
  let replaceInput: HTMLInputElement | null = $state(null);
  /** Where the keyboard was before the bar opened, to hand it back on close. */
  let returnFocus: HTMLElement | null = null;

  /** The last Replace all, so it can be undone as one act. */
  let lastReplace: { before: Map<string, string>; after: Map<string, string> } | null = $state(null);
  /**
   * Cells the search unfolded to show a hit, folded back when the bar closes.
   * Looking for something should not leave the notebook rearranged — nor
   * change what the file says about which cells are collapsed.
   */
  const unfoldedByFind = new Set<string>();

  /** After a replace, the next hit is the first one past the inserted text. */
  let resumeAfter: { cellId: string; pos: number } | null = null;

  const options = $derived({ query, caseSensitive, regex, wholeWord });
  const result = $derived(
    open && $currentNotebook ? findMatches($currentNotebook.cells, options) : { matches: [], error: null }
  );
  const matches = $derived(result.matches);
  const current = $derived<Match | null>(matches[index] ?? null);

  /** A cell's place in the notebook, to order hits across cells. */
  function order(cellId: string): number {
    return $currentNotebook?.cells.findIndex((c) => c.id === cellId) ?? -1;
  }

  // Keep the current hit sensible as the matches change under it: after a
  // replacement, move to the first hit past the inserted text (so a
  // replacement that still contains the query is not replaced forever);
  // otherwise just stay in range.
  $effect(() => {
    const list = matches;
    if (resumeAfter) {
      const { cellId, pos } = resumeAfter;
      resumeAfter = null;
      const at = order(cellId);
      const next = list.findIndex((m) => {
        const o = order(m.cellId);
        return o > at || (o === at && m.from >= pos);
      });
      index = next === -1 ? 0 : next;
      return;
    }
    if (index >= list.length) index = Math.max(0, list.length - 1);
  });

  // Typing a query, or flipping an option, brings the first hit on screen —
  // otherwise "1 of 4" can point at something nowhere in view. Only on those
  // changes: a hit shifting because the reader edits a cell must not yank the
  // page out from under them.
  $effect(() => {
    query;
    caseSensitive;
    regex;
    wholeWord;
    if (!untrack(() => open)) return;
    tick().then(() => untrack(() => reveal(current)));
  });

  // Paint the hits in every editor, or clear them when the bar closes.
  $effect(() => {
    const matcher = open ? buildMatcher(options) : { regex: null };
    searchHighlight.set({ regex: matcher.regex, current: open ? current : null });
  });

  // A different notebook, a different query: the last Replace all is no longer
  // the thing an Undo button next to this query would mean.
  $effect(() => {
    $activeSessionId;
    query;
    replacement;
    lastReplace = null;
  });

  function isLocked(cell: NotebookCell): boolean {
    return cell.readOnly === true || get(currentNotebook)?.readOnly === true;
  }

  async function show(withReplace: boolean) {
    if (!open) {
      const active = document.activeElement;
      returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
      // Selected text becomes the query, the way every editor does it.
      const selected = window.getSelection()?.toString() ?? '';
      if (selected && !selected.includes('\n') && selected.length <= 200) query = selected;
    }
    open = true;
    if (withReplace) showReplace = true;
    status = null;
    await tick();
    const target = withReplace ? replaceInput : queryInput;
    (withReplace && query ? target : queryInput)?.focus();
    queryInput?.select();
  }

  function hide() {
    open = false;
    status = null;
    searchHighlight.set({ regex: null, current: null });
    if (unfoldedByFind.size > 0) {
      const ids = new Set(unfoldedByFind);
      unfoldedByFind.clear();
      currentNotebook.update((nb) =>
        nb ? { ...nb, cells: nb.cells.map((c) => (ids.has(c.id) ? { ...c, collapsed: true } : c)) } : nb
      );
    }
    // Text cells the search switched to source go back to rendered prose.
    window.dispatchEvent(new CustomEvent('find-closed'));
    returnFocus?.focus();
    returnFocus = null;
  }

  /** Bring a hit on screen without taking the keyboard from the bar. */
  async function reveal(match: Match | null) {
    if (!match) return;
    const notebook = get(currentNotebook);
    const cell = notebook?.cells.find((c) => c.id === match.cellId);
    if (!cell) return;

    // A folded cell has no editor to show the hit in; unfold it, as an editor
    // unfolds a region when search lands inside it.
    if (cell.collapsed) {
      unfoldedByFind.add(cell.id);
      currentNotebook.update((nb) =>
        nb ? { ...nb, cells: nb.cells.map((c) => (c.id === cell.id ? { ...c, collapsed: false } : c)) } : nb
      );
    }
    // A rendered text cell shows prose, not its source; ask it to show source.
    if (cell.type === 'markdown') {
      window.dispatchEvent(new CustomEvent('reveal-cell-source', { detail: { cellId: cell.id } }));
    }

    await tick();
    requestAnimationFrame(() => {
      const mark = document.querySelector('.cm-notebook-match-current');
      const target = mark ?? document.querySelector(`[data-cell-id="${CSS.escape(cell.id)}"]`);
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  function step(delta: number) {
    if (matches.length === 0) return;
    index = (index + delta + matches.length) % matches.length;
    status = null;
    void reveal(matches[index]);
  }

  function replaceCurrent() {
    const match = current;
    const notebook = get(currentNotebook);
    const cell = match && notebook?.cells.find((c) => c.id === match.cellId);
    if (!match || !cell) return;
    if (isLocked(cell)) {
      status = 'That cell is locked; skipped.';
      step(1);
      return;
    }
    const next = replaceOne(cell.content, match.from, options, replacement);
    if (next === null) return;
    const inserted = next.length - (cell.content.length - (match.to - match.from));
    resumeAfter = { cellId: cell.id, pos: match.from + inserted };
    currentNotebook.update((nb) => (nb ? updateCellContent(nb, cell.id, next) : nb));
    recomputeStaleCells(get(currentNotebook));
    lastReplace = null;
    status = null;
    tick().then(() => reveal(matches[index] ?? null));
  }

  function replaceEverywhere() {
    const notebook = get(currentNotebook);
    if (!notebook) return;
    const done = replaceAll(notebook.cells, options, replacement, isLocked);
    if (done.replaced === 0) {
      status = done.skippedLocked > 0
        ? `Nothing replaced: all ${done.skippedLocked} matches are in locked cells.`
        : 'Nothing to replace.';
      return;
    }
    currentNotebook.update((nb) => (nb ? { ...nb, cells: done.cells, updatedAt: Date.now() } : nb));
    markNotebookDirty();
    recomputeStaleCells(get(currentNotebook));
    // Assigned after the query/replacement effect has run for this change, so
    // it is not cleared by it.
    const after = new Map(done.cells.filter((c) => done.before.has(c.id)).map((c) => [c.id, c.content]));
    const cellsChanged = done.before.size;
    tick().then(() => {
      lastReplace = { before: done.before, after };
      status =
        `Replaced ${done.replaced} in ${cellsChanged} cell${cellsChanged === 1 ? '' : 's'}.` +
        (done.skippedLocked > 0 ? ` ${done.skippedLocked} in locked cells left as they were.` : '');
    });
  }

  function undoReplace() {
    const notebook = get(currentNotebook);
    if (!notebook || !lastReplace) return;
    const undone = undoReplaceAll(notebook.cells, lastReplace.before, lastReplace.after);
    currentNotebook.update((nb) => (nb ? { ...nb, cells: undone.cells, updatedAt: Date.now() } : nb));
    markNotebookDirty();
    recomputeStaleCells(get(currentNotebook));
    lastReplace = null;
    // The Undo button just removed itself; without this the keyboard would
    // fall to the page, and Escape and Enter would stop reaching the bar.
    queryInput?.focus();
    status =
      `Restored ${undone.restored} cell${undone.restored === 1 ? '' : 's'}.` +
      (undone.changedSince > 0
        ? ` ${undone.changedSince} edited since kept their edits.`
        : '');
  }

  function onQueryKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
  }

  function onReplaceKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && event.altKey) {
      event.preventDefault();
      replaceEverywhere();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      replaceCurrent();
    }
  }

  function onBarKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      hide();
      return;
    }
    // Option toggles, as in VS Code. `code`, not `key`: on a Mac, Option
    // turns the letter into another character.
    if (event.altKey && !event.metaKey && !event.ctrlKey) {
      if (event.code === 'KeyC') { event.preventDefault(); caseSensitive = !caseSensitive; }
      else if (event.code === 'KeyR') { event.preventDefault(); regex = !regex; }
      else if (event.code === 'KeyW') { event.preventDefault(); wholeWord = !wholeWord; }
    }
  }

  onMount(() => {
    const onOpen = (event: Event) => void show(Boolean((event as CustomEvent).detail?.replace));
    // Escape closes the bar from anywhere, not only from inside it — the way an
    // editor's find widget closes from the editor too. Not while a dialog is
    // up, whose own Escape comes first.
    const onEscape = (event: KeyboardEvent) => {
      if (!open || event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      hide();
    };
    window.addEventListener('open-find', onOpen);
    window.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('open-find', onOpen);
      window.removeEventListener('keydown', onEscape);
      searchHighlight.set({ regex: null, current: null });
    };
  });
</script>

{#if open}
  <div class="find-anchor">
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="find-bar" role="search" aria-label="Find in notebook" onkeydown={onBarKeydown}>
      <div class="find-row">
        <button
          class="find-icon-btn"
          onclick={() => (showReplace = !showReplace)}
          aria-label={showReplace ? 'Hide replace' : 'Show replace'}
          aria-expanded={showReplace}
          title="Toggle replace"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
            <path d={showReplace ? 'M2.5 4.5l3.5 3.5 3.5-3.5' : 'M4.5 2.5l3.5 3.5-3.5 3.5'} />
          </svg>
        </button>
        <input
          bind:this={queryInput}
          bind:value={query}
          class="find-input"
          class:invalid={result.error}
          placeholder="Find in notebook"
          spellcheck="false"
          aria-label="Find"
          oninput={() => { index = 0; status = null; }}
          onkeydown={onQueryKeydown}
        />
        <button class="find-toggle" class:on={caseSensitive} onclick={() => (caseSensitive = !caseSensitive)} aria-pressed={caseSensitive} title="Match case (Alt+C)">Aa</button>
        <button class="find-toggle" class:on={wholeWord} onclick={() => (wholeWord = !wholeWord)} aria-pressed={wholeWord} title="Whole word (Alt+W)"><u>ab</u></button>
        <button class="find-toggle" class:on={regex} onclick={() => (regex = !regex)} aria-pressed={regex} title="Regular expression (Alt+R)">.*</button>
        <span class="find-count" aria-live="polite">
          {#if result.error}
            invalid
          {:else if !query}
            &nbsp;
          {:else if matches.length === 0}
            no results
          {:else}
            {index + 1} of {matches.length}
          {/if}
        </span>
        <button class="find-icon-btn" onclick={() => step(-1)} disabled={matches.length === 0} aria-label="Previous match" title="Previous (Shift+Enter)">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2.5 7.5l3.5-3.5 3.5 3.5"/></svg>
        </button>
        <button class="find-icon-btn" onclick={() => step(1)} disabled={matches.length === 0} aria-label="Next match" title="Next (Enter)">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2.5 4.5l3.5 3.5 3.5-3.5"/></svg>
        </button>
        <button class="find-icon-btn" onclick={hide} aria-label="Close find" title="Close (Escape)">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8"/></svg>
        </button>
      </div>

      {#if showReplace}
        <div class="find-row replace-row">
          <input
            bind:this={replaceInput}
            bind:value={replacement}
            class="find-input"
            placeholder={regex ? 'Replace ($1, $<name> allowed)' : 'Replace'}
            spellcheck="false"
            aria-label="Replace"
            onkeydown={onReplaceKeydown}
          />
          <button class="find-text-btn" onclick={replaceCurrent} disabled={!current} title="Replace (Enter)">Replace</button>
          <button class="find-text-btn" onclick={replaceEverywhere} disabled={matches.length === 0} title="Replace all (Ctrl+Alt+Enter)">All</button>
        </div>
      {/if}

      {#if result.error && query}
        <p class="find-status error">{result.error}</p>
      {:else if status}
        <p class="find-status">
          {status}
          {#if lastReplace}
            <button class="find-link" onclick={undoReplace}>Undo</button>
          {/if}
        </p>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Pinned to the top of the scrolling notebook, over the content rather than
     pushing it down, so opening the bar never moves what you are looking at. */
  .find-anchor {
    position: sticky;
    top: 0.5rem;
    z-index: 30;
    height: 0;
    display: flex;
    justify-content: flex-end;
  }

  .find-bar {
    width: min(460px, 100%);
    height: fit-content;
    padding: 0.35rem;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-input);
    box-shadow: var(--shadow-md);
  }

  .find-row {
    display: flex;
    align-items: center;
    gap: 0.2rem;
  }

  .replace-row {
    margin-top: 0.3rem;
    padding-left: 1.55rem;
  }

  .find-input {
    flex: 1;
    min-width: 0;
    padding: 0.3rem 0.45rem;
    font-family: var(--font-mono);
    font-size: 0.8rem;
    color: var(--heading);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-input);
  }

  .find-input:focus { outline: none; border-color: var(--accent); }
  .find-input.invalid { border-color: var(--danger-fg); }

  .find-toggle,
  .find-icon-btn,
  .find-text-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-input);
    color: var(--text-muted);
    cursor: pointer;
  }

  .find-toggle {
    min-width: 1.7rem;
    height: 1.6rem;
    font-family: var(--font-mono);
    font-size: 0.72rem;
  }

  .find-toggle.on {
    background: var(--accent-weak-bg);
    border-color: var(--accent);
    color: var(--heading);
  }

  .find-icon-btn {
    width: 1.5rem;
    height: 1.5rem;
  }

  .find-text-btn {
    height: 1.6rem;
    padding: 0 0.5rem;
    font-size: 0.75rem;
    border-color: var(--border-strong);
  }

  .find-toggle:hover,
  .find-icon-btn:hover:not(:disabled),
  .find-text-btn:hover:not(:disabled) {
    background: var(--surface-hover);
    color: var(--heading);
  }

  button:disabled { opacity: 0.4; cursor: default; }

  .find-count {
    flex-shrink: 0;
    min-width: 4.5rem;
    padding: 0 0.3rem;
    text-align: right;
    font-size: 0.72rem;
    color: var(--text-faint);
    white-space: nowrap;
  }

  .find-status {
    margin: 0.3rem 0.2rem 0.05rem 1.55rem;
    font-size: 0.74rem;
    color: var(--text-muted);
  }

  .find-status.error { color: var(--danger-fg); }

  .find-link {
    margin-left: 0.3rem;
    padding: 0;
    background: none;
    border: none;
    color: var(--accent);
    font-size: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
</style>
