<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import Cell from './Cell.svelte';
  import { currentNotebook, selectedCellId, markNotebookDirty } from '../stores/notebook';
  import {
    updateCellContent,
    addCellAfter,
    addCellBefore,
    deleteCell,
    staleCells,
    duplicateDefinitions,
    recordCellRun,
    recomputeStaleCells,
    reactiveMode,
    kernelMode
  } from '../stores/notebook';
  import { executorFor } from '../utils/mainExecutor';
  import { kernelFor } from '../utils/kernelClient';
  import {
    activeSessionId,
    current as currentSession,
    nextExecutionOrderIn,
    recomputeStaleIn,
    recordCellRunIn,
    type NotebookSession,
  } from '../stores/sessions';
  import { getDownstreamCells, getDependentsOfName, executionOrder } from '../utils/dependencyGraph';
  import { isEmptyOutput } from '../utils/cellOutput';
  import type { Notebook, NotebookCell } from '../types/notebook';

  let isRunningAll = false;
  // While true, handleRunCell won't trigger a reactive cascade — used so that
  // run-all, run-stale, and the cascade itself don't recurse.
  let suppressCascade = false;

  // Drag-and-drop state
  let draggedCellId: string | null = null;
  let dragOverCellId: string | null = null;
  let dragOverPosition: 'above' | 'below' | null = null;

  const handleRunAllEvent = () => handleRunAll();
  const handleRunStaleEvent = () => handleRunStale();
  const handleInputChangeEvent = (e: Event) => {
    const name = (e as CustomEvent).detail?.name;
    if (name) runDependentsOfName(name);
  };

  onMount(() => {
    window.addEventListener('run-all-cells', handleRunAllEvent);
    window.addEventListener('run-stale-cells', handleRunStaleEvent);
    window.addEventListener('tangent-input-change', handleInputChangeEvent);
  });

  // Each notebook has its own kernel, so each needs its own preload of the
  // common libraries. Doing it when a notebook comes on screen rather than
  // when it is opened is what keeps a restored tab you never look at from
  // spawning a worker: the client only starts one on its first request.
  const warmed = new Set<string>();
  $: warmKernel($activeSessionId);

  function warmKernel(id: string | null): void {
    if (!id || warmed.has(id)) return;
    warmed.add(id);
    if (get(kernelMode) === 'worker') void kernelFor(id).setup();
    else void executorFor(id).setupCommonLibraries();
  }

  onDestroy(() => {
    window.removeEventListener('run-all-cells', handleRunAllEvent);
    window.removeEventListener('run-stale-cells', handleRunStaleEvent);
    window.removeEventListener('tangent-input-change', handleInputChangeEvent);
  });

  // A reactive input (e.g. a slider) changed: re-run the cells that read its
  // bound variable, in document order. Inputs drive their dependents regardless
  // of the reactive-mode toggle — that's the point of an interactive control.
  async function runDependentsOfName(name: string) {
    if (suppressCascade) return;
    const notebook = getNotebookSnapshot();
    if (!notebook) return;
    const dependents = getDependentsOfName(notebook.cells, name);
    if (dependents.size === 0) return;

    suppressCascade = true;
    try {
      for (const cellId of executionOrder(notebook.cells, dependents)) {
        await handleRunCell({ cellId });
        await yieldToUI();
      }
    } finally {
      suppressCascade = false;
    }
  }

  // Give the browser one frame to paint outputs/progress between cell runs.
  // (The old fixed sleeps — 20-100 ms per cell — added seconds to run-all.)
  const yieldToUI = () => new Promise<void>(resolve => setTimeout(resolve, 0));

  // Staleness needs a full dependency re-analysis of the notebook (regex over
  // every code cell), so don't do it on every keystroke — debounce until the
  // user pauses typing.
  let staleTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleStaleRecompute() {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      staleTimer = null;
      recomputeStaleCells(getNotebookSnapshot());
    }, 250);
  }

  /**
   * The pixel width THIS cell's output actually gets. For column cells that's
   * the cell body's inner width; for #wide/#full cells it's the breakout
   * layer's width — measured from the live layer element when the cell has
   * rendered output, else mirrored from the CSS formulas in Cell.svelte
   * (.output-layer.wide/.full). Null when nothing can be measured yet.
   */
  function measureOutputWidth(cell?: NotebookCell): number | null {
    const el = document.querySelector('.cell-main');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const column = el.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0');
    const base = Number.isFinite(column) && column > 100 ? Math.floor(column) : null;
    if (!cell?.outputWidth || !base) return base;

    const live = document.querySelector(`[data-cell-id="${cell.id}"] .output-layer`);
    if (live instanceof HTMLElement && live.clientWidth > 100) return live.clientWidth;

    const main = document.querySelector('.main-content');
    if (!(main instanceof HTMLElement)) return base;
    const cw = main.clientWidth;
    const w = cell.outputWidth === 'wide'
      ? Math.min(1200, 0.96 * cw - 72)
      : 0.98 * cw - 72;
    return Math.max(base, Math.floor(w));
  }

  function handleContentChange({ cellId, content }: { cellId: string; content: string }) {
    currentNotebook.update(notebook => {
      if (!notebook) return notebook;
      return updateCellContent(notebook, cellId, content);
    });
    // Editing a cell may make it (and its dependents) stale.
    scheduleStaleRecompute();
  }

  /**
   * Run one cell.
   *
   * `session` pins the run to the notebook it started in. Without it, switching
   * tabs mid-run would file the outputs — and the execution counter, and the
   * staleness — under whichever notebook the reader had moved to, because the
   * stores this component reads always mean "the active notebook". A long run
   * is precisely when someone goes to look at something else.
   */
  async function handleRunCell(
    { cellId }: { cellId: string },
    session: NotebookSession | null = currentSession()
  ) {
    if (!session) return;
    const notebook = get(session.notebook);
    if (!notebook) return;

    const cell = notebook.cells.find((c: NotebookCell) => c.id === cellId);
    if (!cell) return;

    if (cell.type === 'markdown') return;

    // Skipped cells are excluded from every execution path (direct run,
    // run-all, stale runs, reactive cascades, input-driven reruns).
    if (cell.skipped) return;

    const execOrder = nextExecutionOrderIn(session);
    const kernel = kernelFor(session.id);
    const executor = executorFor(session.id);

    session.notebook.update(nb => {
      if (!nb) return nb;
      return {
        ...nb,
        cells: nb.cells.map((c: NotebookCell) =>
          c.id === cellId
            ? { ...c, isRunning: true, output: undefined, executionOrder: execOrder }
            : c
        )
      };
    });

    try {
      // Seed the `width` builtin (like Observable's) so cells can size output
      // to the real cell width, e.g. Plot.plot({ width }). Re-measured on
      // every run; a user variable named `width` is never overwritten.
      const outputWidth = measureOutputWidth(cell);

      let output;
      if (get(kernelMode) === 'worker') {
        if (outputWidth) await kernel.setVariable('width', outputWidth, { builtin: true });
        output = await kernel.execute(cell.content);
      } else {
        // Claim window.__tangent_scope for this notebook: the reader may have
        // switched tabs since the run started, pointing it at another one.
        executor.activate();
        await executor.setupCommonLibraries();
        if (outputWidth) executor.setBuiltin('width', outputWidth);
        output = await executor.executeCode(cell.content);
      }

      // A cell that displays nothing (a declaration, a loop, an assignment)
      // stores no output, so it keeps no output frame and exports none either.
      const storedOutput = isEmptyOutput(output) ? undefined : output;

      session.notebook.update(nb => {
        if (!nb) return nb;
        return {
          ...nb,
          cells: nb.cells.map((c: NotebookCell) =>
            c.id === cellId
              ? { ...c, isRunning: false, output: storedOutput }
              : c
          )
        };
      });

      recordCellRunIn(session, cellId, cell.content);
      recomputeStaleIn(session);
    } catch (error: any) {
      session.notebook.update(nb => {
        if (!nb) return nb;
        return {
          ...nb,
          cells: nb.cells.map((c: NotebookCell) =>
            c.id === cellId
              ? {
                  ...c,
                  isRunning: false,
                  output: {
                    type: 'error',
                    content: `Error: ${error.message}`,
                    timestamp: Date.now()
                  }
                }
              : c
          )
        };
      });

      recordCellRunIn(session, cellId, cell.content);
      recomputeStaleIn(session);
    }

    // Reactive mode: re-run everything that depends on this cell.
    if ($reactiveMode && !suppressCascade) {
      await cascadeFrom(cellId, session);
    }
  }

  // Run the transitive downstream dependents of `originId` in document order.
  async function cascadeFrom(originId: string, session: NotebookSession) {
    const notebook = get(session.notebook);
    if (!notebook) return;
    const downstream = getDownstreamCells(notebook.cells, originId);
    if (downstream.size === 0) return;

    suppressCascade = true;
    try {
      // Dependency order, so a dependent that feeds another dependent runs first.
      for (const cellId of executionOrder(notebook.cells, downstream)) {
        await handleRunCell({ cellId }, session);
        await yieldToUI();
      }
    } finally {
      suppressCascade = false;
    }
  }

  async function handleRunStale() {
    const session = currentSession();
    if (!session || isRunningAll) return;
    const notebook = get(session.notebook);
    if (!notebook) return;

    const stale = get(session.stale);
    if (stale.size === 0) return;

    isRunningAll = true;
    suppressCascade = true;
    // Dependency order, resolved across the whole notebook so a stale cell that
    // feeds another stale cell runs first even if it sits below it.
    const order = executionOrder(notebook.cells, stale);
    const total = order.length;
    let done = 0;
    session.runProgress.set({ done, total });
    for (const cellId of order) {
      await handleRunCell({ cellId }, session);
      await yieldToUI();
      session.runProgress.set({ done: ++done, total });
    }
    suppressCascade = false;
    isRunningAll = false;
    setTimeout(() => session.runProgress.set(null), 500);
  }

  async function handleRunAll() {
    const session = currentSession();
    if (!session || isRunningAll) return;
    const notebook = get(session.notebook);
    if (!notebook) return;

    isRunningAll = true;
    suppressCascade = true;
    session.execCounter = 0;

    // Code cells run in dependency order — a cell that reads `x` runs after the
    // cell defining `x`, even when it appears above it — with document order as
    // the tie-break, so an already-ordered notebook behaves exactly as before.
    // Markdown has no dependencies, so it just re-renders up front.
    const order = executionOrder(notebook.cells);
    // Skipped cells are absent from `order`, so count what will actually run —
    // otherwise the progress bar stops short of full.
    const markdownCount = notebook.cells.filter(c => c.type === 'markdown').length;
    const total = markdownCount + order.length;
    let done = 0;
    session.runProgress.set({ done, total });
    for (const cell of notebook.cells) {
      if (cell.type !== 'markdown') continue;
      window.dispatchEvent(new CustomEvent('render-markdown', { detail: { cellId: cell.id } }));
      session.runProgress.set({ done: ++done, total });
    }
    for (const cellId of order) {
      await handleRunCell({ cellId }, session);
      await yieldToUI();
      session.runProgress.set({ done: ++done, total });
    }

    suppressCascade = false;
    isRunningAll = false;
    recomputeStaleIn(session);
    // Let the filled bar linger a moment, then fade out.
    setTimeout(() => session.runProgress.set(null), 500);
  }

  async function handleRunAndAdvance({ cellId }: { cellId: string }) {
    await handleRunCell({ cellId });

    let notebook: Notebook | null = null;
    const unsub = currentNotebook.subscribe(n => notebook = n);
    unsub();
    if (!notebook) return;
    const idx = notebook.cells.findIndex((c: NotebookCell) => c.id === cellId);
    if (idx >= 0 && idx < notebook.cells.length - 1) {
      const next = notebook.cells[idx + 1];
      selectedCellId.set(next.id);
    }
  }

  function handleSelectCell({ cellId }: { cellId: string }) {
    selectedCellId.set(cellId);
  }

  // The empty state shows when no notebook is open — which means there is no
  // session to write into either, so this asks the app to open one rather than
  // setting a store that would drop the write on the floor.
  function startNewNotebook() {
    window.dispatchEvent(new CustomEvent('request-new-notebook'));
  }

  const UNTITLED = 'Untitled Notebook';

  function getNotebookSnapshot(): Notebook | null {
    let snapshot: Notebook | null = null;
    const unsubscribe = currentNotebook.subscribe(n => snapshot = n);
    unsubscribe();
    return snapshot;
  }

  function updateNotebookTitle(newTitle: string) {
    const title = newTitle.trim() || UNTITLED;
    currentNotebook.update((notebook) => {
      if (!notebook) return notebook;
      if (notebook.name === title) return notebook;
      markNotebookDirty();
      return {
        ...notebook,
        name: title,
        updatedAt: Date.now()
      };
    });
  }

  let titleEl: HTMLElement | null = null;

  /**
   * Fill the title heading by hand.
   *
   * It is contenteditable, so the browser — and the blur handler below, which
   * normalises whitespace — replace its child nodes freely. A `{name}` in the
   * template would hand Svelte a text node that the first rename detaches;
   * every later update then wrote into that orphan, and the heading froze on
   * whichever title was typed. Opening another notebook left the previous
   * one's name above it, over the right cells.
   *
   * `titleEl` is an argument rather than a closed-over variable so that binding
   * the element re-runs this, not only a change of name.
   */
  $: setTitleText(titleEl, $currentNotebook?.name ?? '');

  function setTitleText(el: HTMLElement | null, name: string): void {
    // Never fight the caret: until blur commits the new name, the store still
    // holds the old one, and rewriting here would undo what is being typed.
    if (!el || el === document.activeElement) return;
    if (el.textContent !== name) el.textContent = name;
  }

  function handleTitleBlur(event: FocusEvent) {
    const target = event.currentTarget as HTMLElement | null;
    if (!target) return;
    const raw = target.innerText.replace(/\s+/g, ' ');
    const sanitized = raw.trim() || UNTITLED;
    target.textContent = sanitized;
    updateNotebookTitle(sanitized);
  }

  function handleTitleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      const target = event.currentTarget as HTMLElement | null;
      target?.blur();
    }
  }

  function handleAddCell({ afterCellId, type = 'code' }: { afterCellId: string; type?: 'code' | 'markdown' }) {
    currentNotebook.update(notebook => {
      if (!notebook) return notebook;
      const updatedNotebook = addCellAfter(notebook, afterCellId, type);
      const newCell = updatedNotebook.cells.find((cell: NotebookCell) =>
        !notebook.cells.some((oldCell: NotebookCell) => oldCell.id === cell.id)
      );
      if (newCell) {
        selectedCellId.set(newCell.id);
      }
      return updatedNotebook;
    });
  }

  function handleAddCellBefore({ beforeCellId, type = 'code' }: { beforeCellId: string; type?: 'code' | 'markdown' }) {
    currentNotebook.update(notebook => {
      if (!notebook) return notebook;
      const updatedNotebook = addCellBefore(notebook, beforeCellId, type);
      const newCell = updatedNotebook.cells.find((cell: NotebookCell) =>
        !notebook.cells.some((oldCell: NotebookCell) => oldCell.id === cell.id)
      );
      if (newCell) {
        selectedCellId.set(newCell.id);
      }
      return updatedNotebook;
    });
  }

  function handleDeleteCell({ cellId }: { cellId: string }) {
    currentNotebook.update(notebook => {
      if (!notebook) return notebook;
      return deleteCell(notebook, cellId);
    });

    selectedCellId.update(selected => selected === cellId ? null : selected);
  }

  function handleCellTypeChange({ cellId, type }: { cellId: string; type: 'code' | 'markdown' }) {
    markNotebookDirty();
    currentNotebook.update(notebook => {
      if (!notebook) return notebook;
      return {
        ...notebook,
        cells: notebook.cells.map((cell: NotebookCell) =>
          cell.id === cellId
            ? { ...cell, type, output: undefined }
            : cell
        ),
        updatedAt: Date.now()
      };
    });
  }

  function handleToggleCollapse({ cellId }: { cellId: string }) {
    currentNotebook.update(notebook => {
      if (!notebook) return notebook;
      return {
        ...notebook,
        cells: notebook.cells.map((cell: NotebookCell) =>
          cell.id === cellId
            ? { ...cell, collapsed: !cell.collapsed }
            : cell
        )
      };
    });
  }

  function handleToggleSkip({ cellId }: { cellId: string }) {
    currentNotebook.update(notebook => {
      if (!notebook) return notebook;
      return {
        ...notebook,
        cells: notebook.cells.map((cell: NotebookCell) =>
          cell.id === cellId
            ? { ...cell, skipped: !cell.skipped }
            : cell
        )
      };
    });
    // Skipping removes a cell from the stale set; re-enabling may restore it.
    recomputeStaleCells(getNotebookSnapshot());
  }

  function handleSetOutputWidth({ cellId, outputWidth }: { cellId: string; outputWidth?: 'wide' | 'full' }) {
    currentNotebook.update(notebook => {
      if (!notebook) return notebook;
      return {
        ...notebook,
        cells: notebook.cells.map((cell: NotebookCell) =>
          cell.id === cellId
            ? { ...cell, outputWidth }
            : cell
        )
      };
    });
  }

  function handleToggleReadOnly({ cellId }: { cellId: string }) {
    currentNotebook.update(notebook => {
      if (!notebook) return notebook;
      return {
        ...notebook,
        cells: notebook.cells.map((cell: NotebookCell) =>
          cell.id === cellId
            ? { ...cell, readOnly: !cell.readOnly }
            : cell
        )
      };
    });
  }

  function handleToggleOutputCollapse({ cellId }: { cellId: string }) {
    currentNotebook.update(notebook => {
      if (!notebook) return notebook;
      return {
        ...notebook,
        cells: notebook.cells.map((cell: NotebookCell) =>
          cell.id === cellId
            ? { ...cell, outputCollapsed: !cell.outputCollapsed }
            : cell
        )
      };
    });
  }

  async function runCellById(cellId: string): Promise<void> {
    const notebook = getNotebookSnapshot();
    if (!notebook) return;
    const cell = notebook.cells.find((c: NotebookCell) => c.id === cellId);
    if (!cell) return;

    if (cell.type === 'markdown') {
      const evt = new CustomEvent('render-markdown', { detail: { cellId } });
      window.dispatchEvent(evt);
    } else {
      await handleRunCell({ cellId });
    }
  }

  // Drag-and-drop handlers
  function handleDragStart({ cellId }: { cellId: string }) {
    draggedCellId = cellId;
  }

  function handleDragOver({ cellId, position }: { cellId: string; position: 'above' | 'below' }) {
    dragOverCellId = cellId;
    dragOverPosition = position;
  }

  function handleDragEnd() {
    if (draggedCellId && dragOverCellId && draggedCellId !== dragOverCellId) {
      currentNotebook.update(notebook => {
        if (!notebook) return notebook;
        const cells = [...notebook.cells];
        const fromIdx = cells.findIndex((c: NotebookCell) => c.id === draggedCellId);
        const toIdx = cells.findIndex((c: NotebookCell) => c.id === dragOverCellId);
        if (fromIdx === -1 || toIdx === -1) return notebook;

        const [moved] = cells.splice(fromIdx, 1);
        const insertIdx = dragOverPosition === 'above' ? toIdx : toIdx + 1;
        const adjustedIdx = fromIdx < toIdx ? insertIdx - 1 : insertIdx;
        cells.splice(Math.max(0, adjustedIdx), 0, moved);
        markNotebookDirty();

        return { ...notebook, cells, updatedAt: Date.now() };
      });
    }
    draggedCellId = null;
    dragOverCellId = null;
    dragOverPosition = null;
  }

  // Keyboard shortcuts
  async function handleKeydown(event: KeyboardEvent) {
    const activeCellId = $selectedCellId;
    if (!activeCellId) return;

    // Ctrl/Cmd+A selects the current cell's content, not the whole page. Text
    // editors (CodeMirror, markdown textarea) already handle their own select-all,
    // so only scope the selection when we're in command mode (no editor focused).
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a'
        && !event.shiftKey && !event.altKey) {
      const target = event.target as HTMLElement | null;
      if (target?.closest('textarea, input, [contenteditable="true"], .cm-editor')) {
        return;
      }
      const content = document.querySelector(`[data-testid="cell-${activeCellId}"] .cell-content`);
      if (content) {
        event.preventDefault();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(content);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      await runCellById(activeCellId);
      return;
    }

    if (event.altKey && event.key === 'Enter') {
      event.preventDefault();
      await runCellById(activeCellId);
      handleAddCell({ afterCellId: activeCellId });
      return;
    }

    if (event.shiftKey && event.key === 'Enter') {
      event.preventDefault();
      await runCellById(activeCellId);

      const notebookAfter = getNotebookSnapshot();
      if (!notebookAfter) return;

      const idx = notebookAfter.cells.findIndex((c: NotebookCell) => c.id === activeCellId);
      if (idx === -1) return;

      if (idx < notebookAfter.cells.length - 1) {
        const next = notebookAfter.cells[idx + 1];
        selectedCellId.set(next.id);
      } else {
        handleAddCell({ afterCellId: activeCellId });
      }
      return;
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="notebook-container">
  {#if $currentNotebook}
    <div class="notebook-header">
      <!-- No `{name}` in here on purpose: see the effect that fills it. -->
      <h1
        bind:this={titleEl}
        class="notebook-title"
        contenteditable="true"
        spellcheck="false"
        aria-label="Notebook title"
        data-testid="notebook-title"
        onkeydown={handleTitleKeydown}
        onblur={handleTitleBlur}
      ></h1>
    </div>

    <div class="cells-container">
      {#each $currentNotebook.cells as cell (cell.id)}
        <Cell
          {cell}
          isSelected={$selectedCellId === cell.id}
          isStale={$staleCells.has(cell.id)}
          duplicateNames={$duplicateDefinitions.get(cell.id) ?? []}
          isDraggedOver={dragOverCellId === cell.id}
          dragPosition={dragOverCellId === cell.id ? dragOverPosition : null}
          oncontentChange={handleContentChange}
          onrun={handleRunCell}
          onrunAndAdvance={handleRunAndAdvance}
          onselect={handleSelectCell}
          onaddCell={handleAddCell}
          onaddCellBefore={handleAddCellBefore}
          ondeleteCell={handleDeleteCell}
          ontypeChange={handleCellTypeChange}
          ontoggleCollapse={handleToggleCollapse}
          ontoggleOutputCollapse={handleToggleOutputCollapse}
          ontoggleSkip={handleToggleSkip}
          ontoggleReadOnly={handleToggleReadOnly}
          onsetOutputWidth={handleSetOutputWidth}
          ondragstart={handleDragStart}
          ondragover={handleDragOver}
          ondragend={handleDragEnd}
        />
      {/each}
    </div>

    <div class="notebook-footer">
      <button
        class="add-cell-btn"
        onclick={() => handleAddCell({ afterCellId: $currentNotebook!.cells[$currentNotebook!.cells.length - 1].id, type: 'code' })}
        data-testid="add-cell-btn"
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 2v12M2 8h12"/></svg>
        Code
      </button>
      <button
        class="add-cell-btn"
        onclick={() => handleAddCell({ afterCellId: $currentNotebook!.cells[$currentNotebook!.cells.length - 1].id, type: 'markdown' })}
        data-testid="add-text-cell-btn"
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 2v12M2 8h12"/></svg>
        Text
      </button>
    </div>
  {:else}
    <div class="empty-state">
      <h2>Start a notebook</h2>
      <p>A blank notebook gives you one code cell to run. Import a <code>.js</code> file to pick up where you left off.</p>
      <div class="empty-actions">
        <button class="empty-primary" onclick={startNewNotebook}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M8 3v10M3 8h10" stroke-linecap="round"/>
          </svg>
          New notebook
        </button>
        <button class="empty-secondary" onclick={() => window.dispatchEvent(new CustomEvent('request-import-notebook'))}>
          Import a file
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .notebook-container {
    /* The reading spine: sized for prose (~70ch) now that cells carry no
       card padding; wide outputs break out of it via .output-layer. */
    max-width: 820px;
    margin: 0 auto;
    padding: 1.5rem 1.5rem 2.5rem;
  }

  @media (max-width: 640px) {
    .notebook-container { padding: 1rem 0.75rem 2rem; }
    .notebook-title { font-size: 1.6rem; }
    .notebook-header { margin-bottom: 1.25rem; }
  }

  .notebook-header {
    margin-bottom: 1.75rem;
  }

  .notebook-title {
    font-family: var(--font-serif);
    font-size: 2.2rem;
    font-weight: 700;
    color: var(--heading);
    margin: 0 0 0.5rem 0;
    outline: none;
    line-height: 1.15;
    letter-spacing: -0.01em;
    text-wrap: balance;
  }

  .notebook-title:focus {
    background-color: var(--accent-weak-bg);
    padding: 0.125rem 0.35rem;
    border-radius: var(--radius-input);
  }

  .cells-container {
    margin-bottom: 1.5rem;
  }

  .notebook-footer {
    display: flex;
    justify-content: center;
    gap: 0.6rem;
    padding-top: 1.5rem;
  }

  .add-cell-btn {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 1rem;
    background-color: transparent;
    color: var(--text-muted);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill);
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .add-cell-btn:hover {
    background-color: var(--surface-hover);
    border-color: var(--accent);
    color: var(--heading);
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 400px;
    text-align: center;
  }

  .empty-state h2 {
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--heading);
    margin-bottom: 0.5rem;
  }

  .empty-state p {
    color: var(--text-muted);
    font-size: 0.9375rem;
    max-width: 38ch;
    text-wrap: pretty;
  }

  .empty-state code {
    font-family: var(--font-mono);
    font-size: 0.85em;
    background: var(--surface-2);
    padding: 0.05rem 0.3rem;
    border-radius: var(--radius-input);
  }

  .empty-actions {
    display: flex;
    gap: 0.6rem;
    margin-top: 1.25rem;
  }

  .empty-primary,
  .empty-secondary {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 1rem;
    border-radius: var(--radius-pill);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .empty-primary {
    background: var(--accent-solid);
    color: var(--accent-on-solid);
    border: 1px solid var(--accent-solid);
  }

  .empty-primary:hover {
    background: var(--accent-solid-hover);
    border-color: var(--accent-solid-hover);
  }

  .empty-secondary {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border-strong);
  }

  .empty-secondary:hover {
    background: var(--surface-hover);
    border-color: var(--accent);
    color: var(--heading);
  }
</style>
