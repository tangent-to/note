<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { marked } from 'marked';
  import katex from 'katex';
  import MonacoEditor from './MonacoEditor.svelte';
  import CellOutput from './CellOutput.svelte';
  import { theme, monacoTheme } from '../utils/theme';
  import { outputPosition } from '../stores/notebook';
  import type { NotebookCell } from '../types/notebook';

  interface Props {
    cell: NotebookCell;
    isSelected?: boolean;
    isStale?: boolean;
    isDraggedOver?: boolean;
    dragPosition?: 'above' | 'below' | null;
    oncontentChange?: (detail: { cellId: string; content: string }) => void;
    onrun?: (detail: { cellId: string }) => void;
    onrunAndAdvance?: (detail: { cellId: string }) => void;
    onselect?: (detail: { cellId: string }) => void;
    onaddCell?: (detail: { afterCellId: string; type?: 'code' | 'markdown' }) => void;
    ondeleteCell?: (detail: { cellId: string }) => void;
    ontypeChange?: (detail: { cellId: string; type: 'code' | 'markdown' }) => void;
    ontoggleCollapse?: (detail: { cellId: string }) => void;
    ontoggleOutputCollapse?: (detail: { cellId: string }) => void;
    ontoggleSkip?: (detail: { cellId: string }) => void;
    ontoggleReadOnly?: (detail: { cellId: string }) => void;
    ondragstart?: (detail: { cellId: string }) => void;
    ondragover?: (detail: { cellId: string; position: 'above' | 'below' }) => void;
    ondragend?: () => void;
  }

  let {
    cell,
    isSelected = false,
    isStale = false,
    isDraggedOver = false,
    dragPosition = null,
    oncontentChange,
    onrun,
    onrunAndAdvance,
    onselect,
    onaddCell,
    ondeleteCell,
    ontypeChange,
    ontoggleCollapse,
    ontoggleOutputCollapse,
    ontoggleSkip,
    ontoggleReadOnly,
    ondragstart,
    ondragover,
    ondragend,
  }: Props = $props();

  let editorRef: MonacoEditor = $state(null as any);
  let isDragging = $state(false);
  // Markdown renders by default; empty cells open in edit mode so you can type.
  // Capture only the initial content (untracked) — toggling is user-driven after.
  let isEditingMarkdown = $state(untrack(() => !cell.content || !cell.content.trim()));
  let renderedMarkdown = $state('');
  let markdownTextarea: HTMLTextAreaElement = $state(null as any);
  let markdownPreview: any = $state(null);

  let execLabel = $derived(cell.executionOrder ? `[${cell.executionOrder}]` : '[ ]');

  // Single overflow menu replaces the old row of toolbar icons (move/add/
  // collapse/delete). Keeps the resting cell quiet, Observable-style.
  let menuOpen = $state(false);
  let menuEl: HTMLDivElement = $state(null as any);

  function toggleMenu(e: MouseEvent) {
    e.stopPropagation();
    menuOpen = !menuOpen;
  }

  // Close the menu on outside click or Escape while it's open.
  $effect(() => {
    if (!menuOpen) return;
    const onPointer = (ev: Event) => {
      if (menuEl && !menuEl.contains(ev.target as Node)) menuOpen = false;
    };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') menuOpen = false; };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  });

  function runMenu(fn: () => void) {
    return (e: MouseEvent) => { e.stopPropagation(); fn(); menuOpen = false; };
  }

  function handleRun() {
    if (cell.type === 'markdown') {
      isEditingMarkdown = false;
    }
    onrun?.({ cellId: cell.id });
  }

  function handleRunAndAdvance() {
    if (cell.type === 'markdown') {
      isEditingMarkdown = false;
    }
    onrunAndAdvance?.({ cellId: cell.id });
  }

  function handleEditMarkdown() {
    if (cell.readOnly) {
      onselect?.({ cellId: cell.id });
      return;
    }
    isEditingMarkdown = true;
    onselect?.({ cellId: cell.id });
    // Move the caret into the textarea we just revealed. The selection effect
    // only re-runs on isSelected changes, not on this toggle, so focus here.
    tick().then(() => markdownTextarea?.focus());
  }

  function handleCellClick() {
    onselect?.({ cellId: cell.id });
  }

  function handleCellMouseDown(event: MouseEvent) {
    const target = event.target as HTMLElement;
    // Leave focus alone when the user is interacting with output widgets
    // (sliders, inputs, buttons, links) or the music player. Stealing focus to
    // the Monaco editor mid-press breaks native interactions like dragging a
    // range slider, so we don't even select the cell in that case.
    if (
      target &&
      target.closest(
        '.output-container, .tangent-input, .jmon-music-player-container, input, select, textarea, button, a, [contenteditable]'
      )
    ) {
      return;
    }
    onselect?.({ cellId: cell.id });
    if (cell.type === 'code' && editorRef) {
      requestAnimationFrame(() => {
        try {
          editorRef.focus();
        } catch {
          // ignore focus failures
        }
      });
    }
  }

  function handleEditorFocus() {
    onselect?.({ cellId: cell.id });
  }

  function autoResizeTextarea(textarea: HTMLTextAreaElement) {
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.max(56, textarea.scrollHeight) + 'px';
    }
  }

  // Auto-resize textarea when it becomes available or cell type changes
  $effect(() => {
    if (markdownTextarea && cell.type === 'markdown') {
      autoResizeTextarea(markdownTextarea);
    }
  });

  // Focus active content when cell becomes selected
  $effect(() => {
    if (isSelected) {
      tick().then(() => {
        if (!isSelected) return;
        // Don't yank focus away from an output widget the user is using
        // (e.g. mid-drag on a slider that just selected the cell).
        const active = typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null;
        if (active && active.closest('.output-container, .tangent-input')) return;
        if (cell.type === 'code' && editorRef) {
          editorRef.focus();
        } else if (cell.type === 'markdown') {
          if (isEditingMarkdown && markdownTextarea) {
            markdownTextarea.focus();
          } else if (markdownPreview) {
            markdownPreview.focus();
          }
        }
      });
    }
  });

  // Render markdown
  $effect(() => {
    if (cell.type === 'markdown' && cell.content) {
      try {
        let md = cell.content || '';

        md = md.replace(/\$\$([\s\S]*?)\$\$/g, (m, expr) => {
          try {
            return katex.renderToString(expr, { throwOnError: false, displayMode: true });
          } catch (e: any) {
            return `<pre style="color: var(--danger-fg);">${e.message}</pre>`;
          }
        });

        // Inline math: single $...$ on one line (run after $$ so it isn't caught here).
        md = md.replace(/\$([^$\n]+?)\$/g, (m, expr) => {
          try {
            return katex.renderToString(expr, { throwOnError: false, displayMode: false });
          } catch {
            return m;
          }
        });

        renderedMarkdown = (marked(md) as string) || '';
      } catch (e: any) {
        renderedMarkdown = `<pre style="color: var(--danger-fg);">Markdown render error: ${e && e.message ? e.message : String(e)}</pre>`;
      }
    } else if (cell.type === 'markdown') {
      renderedMarkdown = '';
    }
  });

  // Listen for render-markdown event
  if (typeof window !== 'undefined') {
    window.addEventListener('render-markdown', (e: any) => {
      if (e.detail.cellId === cell.id && cell.type === 'markdown') {
        isEditingMarkdown = false;
      }
    });
  }

  // Drag-and-drop handlers
  function onDragStart(event: DragEvent) {
    if (!event.dataTransfer) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', cell.id);
    isDragging = true;
    ondragstart?.({ cellId: cell.id });
  }

  function onDragOver(event: DragEvent) {
    event.preventDefault();
    if (!event.dataTransfer) return;
    event.dataTransfer.dropEffect = 'move';

    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const position = event.clientY < midY ? 'above' : 'below';
    ondragover?.({ cellId: cell.id, position });
  }

  function onDragEnd() {
    isDragging = false;
    ondragend?.();
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    ondragend?.();
  }
</script>

<div
  class="cell-wrapper {isSelected ? 'selected' : ''} {isDragging ? 'dragging' : ''}"
  class:stale={isStale}
  class:skipped={cell.skipped}
  class:drag-above={isDraggedOver && dragPosition === 'above'}
  class:drag-below={isDraggedOver && dragPosition === 'below'}
  data-testid="cell-{cell.id}"
  role="group"
  aria-label="Notebook cell"
  ondragover={onDragOver}
  ondrop={onDrop}
>
  <div
    class="cell-container"
    onmousedown={handleCellMouseDown}
    onclick={handleCellClick}
    role="button"
    tabindex="0"
    onkeydown={(e) => e.key === 'Enter' && handleCellClick()}
  >
    <!-- Left gutter: run + execution count (Jupyter/Marimo idiom). The drag
         handle reveals on hover. No reserved top toolbar row, so content fills
         the cell from the top. -->
    <div class="cell-gutter">
      <button
        onclick={(e) => { e.stopPropagation(); handleRun(); }}
        class="run-btn"
        disabled={cell.isRunning || cell.skipped}
        title={cell.skipped ? 'Cell is skipped — enable it from the cell menu to run' : 'Run cell (Shift+Enter)'}
        data-testid="run-cell-btn"
      >
        {#if cell.isRunning}
          <span class="loading-spinner"></span>
        {:else}
          <svg width="13" height="13" viewBox="0 0 14 14" fill="currentColor"><path d="M3 2l9 5-9 5V2z"/></svg>
        {/if}
      </button>

      {#if cell.type === 'code'}
        <span
          class="exec-order"
          class:stale={isStale}
          title={isStale ? 'Stale: a dependency changed since this ran. Run to refresh.' : 'Execution order'}
        >{execLabel}</span>
      {/if}

      {#if cell.skipped}
        <span class="skip-badge" title="This cell is skipped: it never runs">skip</span>
      {/if}
      {#if cell.readOnly}
        <span class="lock-badge" title="This cell is read-only">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <rect x="4" y="11" width="16" height="10" rx="2"/>
            <path d="M8 11V7a4 4 0 018 0v4"/>
          </svg>
        </span>
      {/if}

      <span
        class="drag-handle"
        draggable="true"
        role="button"
        tabindex="-1"
        aria-label="Drag to reorder cell"
        ondragstart={onDragStart}
        ondragend={onDragEnd}
        title="Drag to reorder"
      >
        <svg width="12" height="12" viewBox="0 0 12 14" fill="currentColor">
          <circle cx="3" cy="3" r="1.5"/><circle cx="9" cy="3" r="1.5"/>
          <circle cx="3" cy="7" r="1.5"/><circle cx="9" cy="7" r="1.5"/>
          <circle cx="3" cy="11" r="1.5"/><circle cx="9" cy="11" r="1.5"/>
        </svg>
      </span>
    </div>

    <!-- Main column: content + output. Output renders below the content by
         default, or above it when the global output-position option is set
         (Observable-style). -->
    {#snippet outputBlock()}
      {#if cell.output && !cell.outputCollapsed}
        <CellOutput output={cell.output} />
      {:else if cell.output && cell.outputCollapsed}
        <div class="collapsed-output-indicator">
          <span>Output hidden ({cell.output.type})</span>
        </div>
      {/if}
    {/snippet}

    <div class="cell-main" class:output-first={$outputPosition === 'above'}>
      {#if $outputPosition === 'above'}
        {@render outputBlock()}
      {/if}
      {#if !cell.collapsed}
        {#if cell.type === 'code'}
          <div class="cell-content">
            <MonacoEditor
              bind:this={editorRef}
              value={cell.content}
              language="javascript"
              theme={monacoTheme($theme)}
              height="auto"
              readOnly={cell.readOnly ?? false}
              onchange={(detail) => oncontentChange?.({ cellId: cell.id, content: detail.value })}
              onrun={handleRun}
              onrunAndAdvance={handleRunAndAdvance}
              oneditorFocus={handleEditorFocus}
              onfocus={handleEditorFocus}
            />
          </div>
        {:else}
          <div class="cell-content markdown-wrapper">
            {#if isEditingMarkdown}
              <textarea
                bind:this={markdownTextarea}
                value={cell.content}
                oninput={(e) => {
                  const target = e.target as HTMLTextAreaElement;
                  autoResizeTextarea(target);
                  oncontentChange?.({ cellId: cell.id, content: target.value });
                }}
                onfocus={handleEditorFocus}
                class="markdown-editor"
                placeholder="Write Markdown..."
                data-testid="markdown-editor"
              ></textarea>
            {:else}
              <div
                class="markdown-preview rendered"
                bind:this={markdownPreview}
                onclick={(e) => { e.stopPropagation(); handleEditMarkdown(); }}
                onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Enter') handleEditMarkdown(); }}
                tabindex="0"
                role="button"
                data-testid="markdown-preview"
              >
                {@html renderedMarkdown}
              </div>
            {/if}
          </div>
        {/if}
      {:else}
        <div class="collapsed-indicator">
          <span class="collapsed-text">
            {cell.type === 'code' ? cell.content.split('\n')[0]?.substring(0, 80) || 'Empty cell' : 'Markdown cell'}
            {#if cell.content.split('\n').length > 1}...{/if}
          </span>
        </div>
      {/if}

      {#if $outputPosition === 'below'}
        {@render outputBlock()}
      {/if}
    </div>

    <!-- Overflow menu, tucked into the top-right corner, revealed on hover. -->
    <div class="cell-menu" bind:this={menuEl}>
      <button
        onclick={toggleMenu}
        class="menu-trigger"
        class:open={menuOpen}
        title="Cell actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-testid="cell-menu-btn"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
          <circle cx="7" cy="2.5" r="1.3"/><circle cx="7" cy="7" r="1.3"/><circle cx="7" cy="11.5" r="1.3"/>
        </svg>
      </button>

      {#if menuOpen}
        <div class="cell-menu-popup" role="menu">
          <button role="menuitem" class="menu-item" data-testid="add-cell-below-btn" onclick={runMenu(() => onaddCell?.({ afterCellId: cell.id, type: 'code' }))}>Add code cell below</button>
          <button role="menuitem" class="menu-item" onclick={runMenu(() => onaddCell?.({ afterCellId: cell.id, type: 'markdown' }))}>Add text cell below</button>
          <div class="menu-sep"></div>
          <button role="menuitem" class="menu-item" onclick={runMenu(() => ontoggleCollapse?.({ cellId: cell.id }))}>{cell.collapsed ? 'Expand cell' : 'Collapse cell'}</button>
          {#if cell.output}
            <button role="menuitem" class="menu-item" onclick={runMenu(() => ontoggleOutputCollapse?.({ cellId: cell.id }))}>{cell.outputCollapsed ? 'Show output' : 'Hide output'}</button>
          {/if}
          {#if cell.type === 'code'}
            <button role="menuitem" class="menu-item" data-testid="skip-cell-btn" onclick={runMenu(() => ontoggleSkip?.({ cellId: cell.id }))}>{cell.skipped ? 'Enable cell' : 'Skip cell (never runs)'}</button>
          {/if}
          <button role="menuitem" class="menu-item" onclick={runMenu(() => ontoggleReadOnly?.({ cellId: cell.id }))}>{cell.readOnly ? 'Unlock cell' : 'Lock cell (read-only)'}</button>
          <div class="menu-sep"></div>
          <button
            role="menuitem"
            class="menu-item menu-subtle"
            data-testid="cell-type-toggle"
            onclick={runMenu(() => ontypeChange?.({ cellId: cell.id, type: cell.type === 'code' ? 'markdown' : 'code' }))}
          >
            Convert to {cell.type === 'code' ? 'Markdown' : 'Code'}
          </button>
          <button role="menuitem" class="menu-item menu-danger" data-testid="delete-cell-btn" onclick={runMenu(() => ondeleteCell?.({ cellId: cell.id }))}>Delete cell</button>
        </div>
      {/if}
    </div>
  </div>

  <!-- Add a cell in the gap, revealed on hover. Inserts exactly where it sits. -->
  <div class="cell-insert">
    <button
      class="cell-insert-btn"
      onclick={(e) => { e.stopPropagation(); onaddCell?.({ afterCellId: cell.id, type: 'code' }); }}
      title="Add cell"
      tabindex="-1"
    >
      <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M7 3v8M3 7h8" stroke-linecap="round"/></svg>
    </button>
  </div>
</div>

<style>
  .cell-wrapper {
    position: relative;
    margin-bottom: 1.1rem;
    padding-left: 0.375rem;
    transition: all 0.2s ease;
  }

  /* Insert a code or text cell in the gap between cells, revealed on hover. */
  .cell-insert {
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1.05rem;
    height: 1.1rem;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    opacity: 0;
    transition: opacity 0.12s ease;
    z-index: 6;
  }

  .cell-insert::before {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: 1px;
    background: var(--border);
  }

  .cell-wrapper:hover .cell-insert,
  .cell-insert:focus-within {
    opacity: 1;
  }

  /* Bare plus glyph sitting over the hairline. No pill/circle, no accent fill. */
  .cell-insert-btn {
    position: relative;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 0.45rem;
    background: var(--bg);
    border: none;
    color: var(--text-faint);
    cursor: pointer;
    transition: color 0.12s ease;
  }

  .cell-insert-btn:hover {
    color: var(--text);
  }

  @media (max-width: 640px) {
    .cell-insert { display: none; }
  }

  .cell-wrapper.dragging {
    opacity: 0.5;
  }

  .cell-wrapper.drag-above {
    border-top: 2px solid var(--accent);
    padding-top: 0;
  }

  .cell-wrapper.drag-below {
    border-bottom: 2px solid var(--accent);
    padding-bottom: 0;
  }

  /* A persistent hairline gives every cell a solid edge; selection is shown by
     an accent border (no separate indicator line that collides with the gutter). */
  .cell-container {
    display: flex;
    align-items: stretch;
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    transition: border-color 0.15s ease;
    position: relative;
  }

  .cell-wrapper:hover .cell-container { border-color: var(--border-strong); }
  .cell-wrapper.selected .cell-container { border-color: var(--accent); }
  .cell-wrapper.stale .cell-container { border-color: var(--warn-border); }

  /* Left gutter: a fixed column for run + execution count + drag, so content
     fills the cell from the top with no reserved toolbar row. */
  .cell-gutter {
    flex: 0 0 auto;
    width: 1.9rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.15rem;
    padding: 0.45rem 0 0.5rem;
  }

  .cell-main {
    flex: 1 1 auto;
    min-width: 0;
    padding: 0.45rem 0.7rem 0.5rem 0.15rem;
  }

  .run-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.45rem;
    height: 1.45rem;
    background-color: transparent;
    color: var(--text-faint);
    border: none;
    border-radius: var(--radius-pill);
    cursor: pointer;
    transition: background-color 0.15s ease, color 0.15s ease;
  }

  .run-btn:hover:not(:disabled) {
    background-color: var(--surface-hover);
    color: var(--accent);
  }

  .run-btn:active:not(:disabled) { transform: translateY(0.5px); }
  .run-btn:disabled { cursor: not-allowed; opacity: 0.6; }

  .exec-order {
    font-family: var(--font-mono);
    font-size: 0.62rem;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
    text-align: center;
    line-height: 1;
  }

  .exec-order.stale { color: var(--warn-fg); }

  /* Skipped cells: greyed out and visually inert, but still editable. Keep
     the menu/gutter fully interactive so the cell can be re-enabled. */
  .cell-wrapper.skipped .cell-main {
    opacity: 0.45;
    filter: grayscale(0.9);
  }

  .cell-wrapper.skipped .run-btn {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .skip-badge {
    font-family: var(--font-mono);
    font-size: 0.55rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-faint);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill);
    padding: 0.1rem 0.3rem;
    line-height: 1;
  }

  .lock-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-faint);
  }

  .drag-handle {
    display: flex;
    align-items: center;
    justify-content: center;
    /* Sit at the bottom of the gutter (bottom-left of the cell), away from the
       run button and the top-right overflow menu. */
    margin-top: auto;
    cursor: grab;
    color: var(--text-faint);
    padding: 0.15rem;
    border-radius: var(--radius-input);
    opacity: 0;
    transition: opacity 0.15s ease, color 0.15s ease;
  }

  .cell-wrapper:hover .drag-handle,
  .cell-wrapper:focus-within .drag-handle,
  .cell-wrapper.selected .drag-handle { opacity: 1; }

  .drag-handle:hover { color: var(--text-muted); }
  .drag-handle:active { cursor: grabbing; }

  @media (max-width: 640px) {
    .drag-handle { display: none; }
  }

  /* Overflow menu tucked into the top-right corner, revealed on hover. */
  .cell-menu {
    position: absolute;
    top: 0.3rem;
    right: 0.3rem;
    z-index: 7;
  }

  .menu-trigger {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.45rem;
    height: 1.45rem;
    background-color: transparent;
    color: var(--text-faint);
    border: none;
    border-radius: var(--radius-pill);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s ease, background-color 0.15s ease, color 0.15s ease;
  }

  .cell-wrapper:hover .menu-trigger,
  .cell-wrapper:focus-within .menu-trigger,
  .cell-wrapper.selected .menu-trigger,
  .menu-trigger.open { opacity: 1; }

  .menu-trigger:hover,
  .menu-trigger.open {
    background-color: var(--surface-hover);
    color: var(--heading);
  }

  .cell-menu-popup {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 40;
    min-width: 170px;
    display: flex;
    flex-direction: column;
    padding: 0.25rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-input);
    box-shadow: var(--shadow-md);
  }

  .menu-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 0.4rem 0.6rem;
    background: transparent;
    border: none;
    border-radius: var(--radius-input);
    font-size: 0.8rem;
    color: var(--text);
    cursor: pointer;
    transition: background-color 0.12s ease, color 0.12s ease;
  }

  .menu-item:hover {
    background-color: var(--surface-hover);
    color: var(--heading);
  }

  .menu-subtle { color: var(--text-muted); font-size: 0.78rem; }

  .menu-danger { color: var(--danger-fg); }
  .menu-danger:hover { background-color: var(--danger-bg); color: var(--danger-fg); }

  .menu-sep {
    height: 1px;
    background: var(--border);
    margin: 0.25rem 0.3rem;
  }

  /* Padding now lives on .cell-main; content sits flush inside it. */
  .cell-content {
    padding: 0;
    min-height: 0;
  }

  .collapsed-indicator {
    padding: 0.1rem 0;
    cursor: pointer;
  }

  .collapsed-text {
    font-family: var(--font-mono);
    font-size: 0.8rem;
    color: var(--text-muted);
    font-style: italic;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: block;
  }

  .collapsed-output-indicator {
    padding: 0.3rem 0.65rem;
    font-size: 0.75rem;
    color: var(--text-faint);
    cursor: pointer;
    border-top: 1px solid var(--border);
  }

  /* When outputs sit above the content, flip the separating gap/border. */
  .output-first :global(.output-container) {
    margin-top: 0;
    margin-bottom: 0.2rem;
  }

  .output-first .collapsed-output-indicator {
    border-top: none;
    border-bottom: 1px solid var(--border);
  }

  .collapsed-output-indicator:hover {
    color: var(--text-muted);
    background-color: var(--surface-hover);
  }

  .markdown-editor {
    width: 100%;
    min-height: 48px;
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-input);
    resize: vertical;
    overflow: auto;
    font-family: var(--font-mono);
    font-size: 0.9rem;
    line-height: 1.5;
    color: var(--text);
    background-color: var(--surface-2);
    transition: all 0.15s ease;
    height: auto;
  }

  .markdown-editor:focus {
    outline: none;
    border-color: var(--accent);
    background-color: var(--surface);
  }

  .markdown-wrapper {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.6rem;
  }

  .markdown-preview {
    font-family: var(--font-serif);
    border: 1px solid var(--border);
    border-radius: var(--radius-input);
    padding: 0.6rem 0.7rem;
    background: var(--surface);
    color: var(--text);
    min-height: 0;
    max-height: 600px;
    overflow: auto;
  }

  .markdown-preview.rendered {
    cursor: text;
    border: none;
    padding: 0.15rem 0;
    min-height: auto;
    max-height: none;
    background: transparent;
  }

  /* Drop the leading top margin the browser/prose adds to the first block
     (e.g. a paragraph's default 1em), so the first line aligns with the run
     button in the gutter, matching code cells. */
  .markdown-preview.rendered > :global(:first-child) {
    margin-top: 0;
  }

  .markdown-preview :global(h1) {
    font-size: 2rem;
    font-weight: 700;
    margin-top: 1.5rem;
    margin-bottom: 0.75rem;
    color: var(--heading);
  }

  .markdown-preview :global(h2) {
    font-size: 1.5rem;
    font-weight: 600;
    margin-top: 1.25rem;
    margin-bottom: 0.5rem;
    color: var(--heading);
  }

  .markdown-preview :global(h3) {
    font-size: 1.25rem;
    font-weight: 600;
    margin-top: 1rem;
    margin-bottom: 0.5rem;
    color: var(--heading);
  }

  .markdown-preview :global(p) {
    margin-bottom: 1rem;
    line-height: 1.7;
    color: var(--text);
  }

  .markdown-preview :global(ul),
  .markdown-preview :global(ol) {
    margin-left: 1.5rem;
    margin-bottom: 1rem;
  }

  .markdown-preview :global(li) {
    margin-bottom: 0.5rem;
    line-height: 1.6;
  }

  .markdown-preview :global(code) {
    background: var(--surface-2);
    padding: 0.2rem 0.4rem;
    border-radius: var(--radius-input);
    font-family: var(--font-mono);
    font-size: 0.875rem;
    color: var(--accent);
  }

  .markdown-preview :global(pre) {
    background: var(--surface-2);
    padding: 1rem;
    border-radius: var(--radius-input);
    overflow-x: auto;
    margin-bottom: 1rem;
  }

  .markdown-preview :global(pre code) {
    background: transparent;
    padding: 0;
    color: var(--text);
  }

  .loading-spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
    border-top-color: currentColor;
    border-radius: var(--radius-pill);
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
