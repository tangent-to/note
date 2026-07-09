<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import Cell from './Cell.svelte';
  import { currentNotebook, selectedCellId, markNotebookDirty, getNextExecutionOrder, resetExecutionCounter, createNewNotebook, markNotebookClean, runProgress } from '../stores/notebook';
  import {
    updateCellContent,
    addCellAfter,
    deleteCell,
    staleCells,
    recordCellRun,
    recomputeStaleCells,
    reactiveMode,
    kernelMode
  } from '../stores/notebook';
  import { JavaScriptExecutor } from '../utils/jsExecutor';
  import { kernel } from '../utils/kernelClient';
  import { getDownstreamCells, getDependentsOfName } from '../utils/dependencyGraph';
  import type { Notebook, NotebookCell } from '../types/notebook';

  let jsExecutor: JavaScriptExecutor;
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

  onMount(async () => {
    window.addEventListener('run-all-cells', handleRunAllEvent);
    window.addEventListener('run-stale-cells', handleRunStaleEvent);
    window.addEventListener('tangent-input-change', handleInputChangeEvent);
    if (get(kernelMode) === 'worker') {
      // Worker kernel: preload common libraries in the background.
      void kernel.setup();
    } else {
      jsExecutor = new JavaScriptExecutor();
      await jsExecutor.setupCommonLibraries();
    }
  });

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
      for (const cell of notebook.cells) {
        if (cell.type === 'code' && dependents.has(cell.id)) {
          await handleRunCell({ cellId: cell.id });
          await yieldToUI();
        }
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

  function handleContentChange({ cellId, content }: { cellId: string; content: string }) {
    currentNotebook.update(notebook => {
      if (!notebook) return notebook;
      return updateCellContent(notebook, cellId, content);
    });
    // Editing a cell may make it (and its dependents) stale.
    scheduleStaleRecompute();
  }

  async function handleRunCell({ cellId }: { cellId: string }) {
    let notebook: Notebook | null = null;
    const unsubscribe = currentNotebook.subscribe(n => notebook = n);
    unsubscribe();

    if (!notebook) return;

    const cell = notebook.cells.find((c: NotebookCell) => c.id === cellId);
    if (!cell) return;

    if (cell.type === 'markdown') return;

    // Skipped cells are excluded from every execution path (direct run,
    // run-all, stale runs, reactive cascades, input-driven reruns).
    if (cell.skipped) return;

    const execOrder = getNextExecutionOrder();

    currentNotebook.update(nb => {
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
      let output;
      if (get(kernelMode) === 'worker') {
        output = await kernel.execute(cell.content);
      } else {
        if (!jsExecutor) {
          jsExecutor = new JavaScriptExecutor();
          await jsExecutor.setupCommonLibraries();
        }
        output = await jsExecutor.executeCode(cell.content);
      }

      currentNotebook.update(nb => {
        if (!nb) return nb;
        return {
          ...nb,
          cells: nb.cells.map((c: NotebookCell) =>
            c.id === cellId
              ? { ...c, isRunning: false, output }
              : c
          )
        };
      });

      recordCellRun(cellId, cell.content);
      recomputeStaleCells(getNotebookSnapshot());
    } catch (error: any) {
      currentNotebook.update(nb => {
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

      recordCellRun(cellId, cell.content);
      recomputeStaleCells(getNotebookSnapshot());
    }

    // Reactive mode: re-run everything that depends on this cell.
    if ($reactiveMode && !suppressCascade) {
      await cascadeFrom(cellId);
    }
  }

  // Run the transitive downstream dependents of `originId` in document order.
  async function cascadeFrom(originId: string) {
    const notebook = getNotebookSnapshot();
    if (!notebook) return;
    const downstream = getDownstreamCells(notebook.cells, originId);
    if (downstream.size === 0) return;

    suppressCascade = true;
    try {
      for (const cell of notebook.cells) {
        if (cell.type === 'code' && downstream.has(cell.id)) {
          await handleRunCell({ cellId: cell.id });
          await yieldToUI();
        }
      }
    } finally {
      suppressCascade = false;
    }
  }

  async function handleRunStale() {
    const notebook = getNotebookSnapshot();
    if (!notebook || isRunningAll) return;

    const stale = get(staleCells);
    if (stale.size === 0) return;

    isRunningAll = true;
    suppressCascade = true;
    // Run stale code cells top-to-bottom (an approximation of dependency order).
    const total = notebook.cells.filter(c => c.type === 'code' && stale.has(c.id)).length;
    let done = 0;
    runProgress.set({ done, total });
    for (const cell of notebook.cells) {
      if (cell.type === 'code' && stale.has(cell.id)) {
        await handleRunCell({ cellId: cell.id });
        await yieldToUI();
        runProgress.set({ done: ++done, total });
      }
    }
    suppressCascade = false;
    isRunningAll = false;
    setTimeout(() => runProgress.set(null), 500);
  }

  async function handleRunAll() {
    let notebook: Notebook | null = null;
    const unsubscribe = currentNotebook.subscribe(n => notebook = n);
    unsubscribe();

    if (!notebook || isRunningAll) return;

    isRunningAll = true;
    suppressCascade = true;
    resetExecutionCounter();

    const total = notebook.cells.length;
    let done = 0;
    runProgress.set({ done, total });
    for (const cell of notebook.cells) {
      if (cell.type === 'code') {
        await handleRunCell({ cellId: cell.id });
        await yieldToUI();
      } else if (cell.type === 'markdown') {
        const event = new CustomEvent('render-markdown', { detail: { cellId: cell.id } });
        window.dispatchEvent(event);
      }
      runProgress.set({ done: ++done, total });
    }

    suppressCascade = false;
    isRunningAll = false;
    recomputeStaleCells(getNotebookSnapshot());
    // Let the filled bar linger a moment, then fade out.
    setTimeout(() => runProgress.set(null), 500);
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

  function startNewNotebook() {
    resetExecutionCounter();
    const nb = createNewNotebook();
    currentNotebook.set(nb);
    markNotebookClean();
    selectedCellId.set(nb.cells[0]?.id ?? null);
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
      <h1
        class="notebook-title"
        contenteditable="true"
        spellcheck="false"
        aria-label="Notebook title"
        data-testid="notebook-title"
        onkeydown={handleTitleKeydown}
        onblur={handleTitleBlur}
      >
        {$currentNotebook.name}
      </h1>
    </div>

    <div class="cells-container">
      {#each $currentNotebook.cells as cell (cell.id)}
        <Cell
          {cell}
          isSelected={$selectedCellId === cell.id}
          isStale={$staleCells.has(cell.id)}
          isDraggedOver={dragOverCellId === cell.id}
          dragPosition={dragOverCellId === cell.id ? dragOverPosition : null}
          oncontentChange={handleContentChange}
          onrun={handleRunCell}
          onrunAndAdvance={handleRunAndAdvance}
          onselect={handleSelectCell}
          onaddCell={handleAddCell}
          ondeleteCell={handleDeleteCell}
          ontypeChange={handleCellTypeChange}
          ontoggleCollapse={handleToggleCollapse}
          ontoggleOutputCollapse={handleToggleOutputCollapse}
          ontoggleSkip={handleToggleSkip}
          ontoggleReadOnly={handleToggleReadOnly}
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
    max-width: 900px;
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
