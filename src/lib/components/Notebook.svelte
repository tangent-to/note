<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import Cell from './Cell.svelte';
  import { currentNotebook, selectedCellId, markNotebookDirty, getNextExecutionOrder, resetExecutionCounter } from '../stores/notebook';
  import {
    updateCellContent,
    addCellAfter,
    deleteCell,
    moveCellUp,
    moveCellDown,
    staleCells,
    recordCellRun,
    recomputeStaleCells,
    reactiveMode
  } from '../stores/notebook';
  import { JavaScriptExecutor } from '../utils/jsExecutor';
  import { getDownstreamCells } from '../utils/dependencyGraph';
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

  onMount(async () => {
    jsExecutor = new JavaScriptExecutor();
    await jsExecutor.setupCommonLibraries();
    window.addEventListener('run-all-cells', handleRunAllEvent);
    window.addEventListener('run-stale-cells', handleRunStaleEvent);
  });

  onDestroy(() => {
    window.removeEventListener('run-all-cells', handleRunAllEvent);
    window.removeEventListener('run-stale-cells', handleRunStaleEvent);
  });

  function handleContentChange({ cellId, content }: { cellId: string; content: string }) {
    currentNotebook.update(notebook => {
      if (!notebook) return notebook;
      return updateCellContent(notebook, cellId, content);
    });
    // Editing a cell may make it (and its dependents) stale.
    recomputeStaleCells(getNotebookSnapshot());
  }

  async function handleRunCell({ cellId }: { cellId: string }) {
    let notebook: Notebook | null = null;
    const unsubscribe = currentNotebook.subscribe(n => notebook = n);
    unsubscribe();

    if (!notebook) return;

    const cell = notebook.cells.find((c: NotebookCell) => c.id === cellId);
    if (!cell) return;

    if (cell.type === 'markdown') return;

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
      if (!jsExecutor) {
        jsExecutor = new JavaScriptExecutor();
        await jsExecutor.setupCommonLibraries();
      }

      const output = await jsExecutor.executeCode(cell.content);

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
          await new Promise(resolve => setTimeout(resolve, 30));
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
    for (const cell of notebook.cells) {
      if (cell.type === 'code' && stale.has(cell.id)) {
        await handleRunCell({ cellId: cell.id });
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    suppressCascade = false;
    isRunningAll = false;
  }

  async function handleRunAll() {
    let notebook: Notebook | null = null;
    const unsubscribe = currentNotebook.subscribe(n => notebook = n);
    unsubscribe();

    if (!notebook || isRunningAll) return;

    isRunningAll = true;
    suppressCascade = true;
    resetExecutionCounter();

    for (const cell of notebook.cells) {
      if (cell.type === 'code') {
        await handleRunCell({ cellId: cell.id });
        await new Promise(resolve => setTimeout(resolve, 100));
      } else if (cell.type === 'markdown') {
        const event = new CustomEvent('render-markdown', { detail: { cellId: cell.id } });
        window.dispatchEvent(event);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    suppressCascade = false;
    isRunningAll = false;
    recomputeStaleCells(getNotebookSnapshot());
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

  function handleAddCell({ afterCellId }: { afterCellId: string }) {
    currentNotebook.update(notebook => {
      if (!notebook) return notebook;
      const updatedNotebook = addCellAfter(notebook, afterCellId);
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

  function handleMoveUp({ cellId }: { cellId: string }) {
    currentNotebook.update(notebook => {
      if (!notebook) return notebook;
      return moveCellUp(notebook, cellId);
    });
  }

  function handleMoveDown({ cellId }: { cellId: string }) {
    currentNotebook.update(notebook => {
      if (!notebook) return notebook;
      return moveCellDown(notebook, cellId);
    });
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
          onmoveUp={handleMoveUp}
          onmoveDown={handleMoveDown}
          ontypeChange={handleCellTypeChange}
          ontoggleCollapse={handleToggleCollapse}
          ontoggleOutputCollapse={handleToggleOutputCollapse}
          ondragstart={handleDragStart}
          ondragover={handleDragOver}
          ondragend={handleDragEnd}
        />
      {/each}
    </div>

    <div class="notebook-footer">
      <button
        class="add-cell-btn"
        onclick={() => handleAddCell({ afterCellId: $currentNotebook!.cells[$currentNotebook!.cells.length - 1].id })}
        data-testid="add-cell-btn"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
        Add Cell
      </button>
    </div>
  {:else}
    <div class="empty-state">
      <h2>No notebook loaded</h2>
      <p>Create a new notebook or open an existing one to get started.</p>
    </div>
  {/if}
</div>

<style>
  .notebook-container {
    max-width: 900px;
    margin: 0 auto;
    padding: 1.5rem 1.5rem 2.5rem;
  }

  .notebook-header {
    margin-bottom: 1.75rem;
  }

  .notebook-title {
    font-size: 2.2rem;
    font-weight: 700;
    color: #1a1a1a;
    margin: 0 0 0.5rem 0;
    outline: none;
    line-height: 1.15;
    letter-spacing: -0.01em;
  }

  .notebook-title:focus {
    background-color: #fff5d6;
    padding: 0.125rem 0.35rem;
    border-radius: 4px;
  }

  .cells-container {
    margin-bottom: 1.5rem;
  }

  .notebook-footer {
    display: flex;
    justify-content: center;
    padding-top: 1.5rem;
  }

  .add-cell-btn {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 1rem;
    background-color: transparent;
    color: #5a5a5a;
    border: 1px solid #c8c8c8;
    border-radius: 5px;
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .add-cell-btn:hover {
    background-color: #f4f4f4;
    border-color: #9c9c9c;
    color: #1a1a1a;
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
    color: #1a1a1a;
    margin-bottom: 0.5rem;
  }

  .empty-state p {
    color: #6b6b6b;
    font-size: 0.9375rem;
  }
</style>
