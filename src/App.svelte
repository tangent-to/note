<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import Notebook from './lib/components/Notebook.svelte';
  import RightSidebar from './lib/components/RightSidebar.svelte';
  import ChatSidebar from './lib/components/ChatSidebar.svelte';
  import CommandPalette from './lib/components/CommandPalette.svelte';
  import ExportDialog from './lib/components/ExportDialog.svelte';
  import {
    currentNotebook,
    notebookFiles,
    createNewNotebook,
    markNotebookClean,
    notebookDirty,
    staleCells,
    reactiveMode,
    addCellAfter,
    createNewCell,
    selectedCellId,
    undoDeleteCell,
    resetExecutionCounter,
    resetStaleTracking
  } from './lib/stores/notebook';
  import { handleGlobalKeydown } from './lib/utils/keyboardShortcuts';
  import { saveNotebook, parseJSNotebook, importNotebookFromFile } from './lib/utils/fileOperations';
  import { loadFromLocalStorage, getLocalStorageMeta, saveToLocalStorage } from './lib/utils/webPersistence';

  let rightSidebarOpen = $state(false);
  let chatSidebarOpen = $state(false);
  let showExportDialog = $state(false);
  let showCommandPalette = $state(false);

  // Pending destructive navigation (New / Import) awaiting an unsaved-changes
  // decision. When set, the confirmation modal is shown.
  let pendingNav: { run: () => void; label: string } | null = $state(null);
  let savingPending = $state(false);

  // Run `action` immediately if there's nothing to lose, otherwise ask the user
  // whether to save first. `label` describes what's about to happen.
  function guardUnsaved(action: () => void, label: string) {
    if (get(notebookDirty)) {
      pendingNav = { run: action, label };
    } else {
      action();
    }
  }

  function cancelPending() {
    pendingNav = null;
  }

  function discardAndContinue() {
    const action = pendingNav?.run;
    pendingNav = null;
    action?.();
  }

  async function saveAndContinue() {
    if (!pendingNav) return;
    savingPending = true;
    try {
      await performSaveShortcut();
      const action = pendingNav.run;
      pendingNav = null;
      action();
    } catch (err) {
      console.error('Save before continuing failed', err);
    } finally {
      savingPending = false;
    }
  }

  export function runAllCells() {
    window.dispatchEvent(new CustomEvent('run-all-cells'));
  }

  onMount(() => {
    const meta = getLocalStorageMeta();
    const saved = loadFromLocalStorage();

    if (saved && meta) {
      currentNotebook.set(saved);
      markNotebookClean();
      console.info('Notebook restored from previous session');
    } else {
      loadSampleNotebook();
    }

    loadNotebookFiles();

    const unsubscribe = currentNotebook.subscribe(notebook => {
      if (notebook) {
        saveToLocalStorage(notebook);
      }
    });

    // Warn before closing/reloading the tab if there are unsaved changes.
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (get(notebookDirty)) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);

    return () => {
      unsubscribe();
      window.removeEventListener('beforeunload', beforeUnload);
    };
  });

  async function loadSampleNotebook() {
    try {
      const res = await fetch('/sample-notebooks/climate-ecology-data-template.js');
      if (res.ok) {
        const text = await res.text();
        const sample = parseJSNotebook(text, 'climate-ecology-data-template.js');
        currentNotebook.set(sample);
        markNotebookClean();
      } else {
        const newNotebook = createNewNotebook();
        currentNotebook.set(newNotebook);
        markNotebookClean();
      }
    } catch (e) {
      const newNotebook = createNewNotebook();
      currentNotebook.set(newNotebook);
      markNotebookClean();
    }
  }

  async function loadNotebookFiles() {
    notebookFiles.set([]);
  }

  function handleNewNotebook() {
    guardUnsaved(() => {
      const newNotebook = createNewNotebook();
      resetExecutionCounter();
      currentNotebook.set(newNotebook);
      markNotebookClean();
      console.info('New notebook created');
    }, 'create a new notebook');
  }

  function handleImportNotebook() {
    guardUnsaved(() => {
      importNotebookFromFile((notebook) => {
        resetExecutionCounter();
        resetStaleTracking();
        currentNotebook.set(notebook);
        markNotebookClean();
        console.info('Notebook imported successfully');
      });
    }, 'import another notebook');
  }

  function handleExportNotebook() {
    showExportDialog = true;
  }

  function toggleRightSidebar() {
    rightSidebarOpen = !rightSidebarOpen;
  }

  function onKeydown(event: KeyboardEvent) {
    handleGlobalKeydown(event, {
      showCommandPalette: () => { showCommandPalette = !showCommandPalette; },
      toggleChat: () => { chatSidebarOpen = !chatSidebarOpen; },
      save: () => performSaveShortcut(),
      newNotebook: () => handleNewNotebook(),
      importNotebook: () => handleImportNotebook(),
      undo: () => handleUndo(),
    });
  }

  async function performSaveShortcut() {
    const notebook = get(currentNotebook);
    if (!notebook) return;
    try {
      await saveNotebook(notebook);
      markNotebookClean();
      console.info('Notebook checkpoint exported as .js');
    } catch (err) {
      console.error('Save failed', err);
      alert('Failed to export notebook. See console for details.');
    }
  }

  function handleUndo() {
    currentNotebook.update(notebook => {
      if (!notebook) return notebook;
      return undoDeleteCell(notebook);
    });
  }

  function handleCommand({ id: commandId }: { id: string }) {
    switch (commandId) {
      case 'new-notebook':
        handleNewNotebook();
        break;
      case 'open-notebook':
        handleImportNotebook();
        break;
      case 'save-notebook':
        performSaveShortcut();
        break;
      case 'export-notebook':
        handleExportNotebook();
        break;
      case 'run-all':
        runAllCells();
        break;
      case 'toggle-reactive':
        reactiveMode.update(v => !v);
        break;
      case 'add-code-cell':
        addNewCell('code');
        break;
      case 'add-markdown-cell':
        addNewCell('markdown');
        break;
      case 'toggle-chat':
        chatSidebarOpen = !chatSidebarOpen;
        break;
      case 'clear-outputs':
        clearAllOutputs();
        break;
      case 'keyboard-shortcuts':
        alert('Keyboard Shortcuts:\n\n' +
          'Ctrl/Cmd+K - Command Palette\n' +
          'Ctrl/Cmd+/ - Toggle AI Chat\n' +
          'Ctrl/Cmd+S - Save Notebook\n' +
          'Ctrl/Cmd+N - New Notebook\n' +
          'Ctrl/Cmd+O - Open Notebook\n' +
          'Ctrl/Cmd+Enter - Run Cell\n' +
          'Shift+Enter - Run Cell and Select Next\n' +
          'Alt+Enter - Run Cell and Insert Below\n' +
          'Ctrl/Cmd+Z - Undo Cell Delete');
        break;
    }
  }

  function addNewCell(type: 'code' | 'markdown') {
    const notebook = get(currentNotebook);
    if (!notebook) return;

    const currentSelectedId = get(selectedCellId);
    const targetCell = currentSelectedId
      ? notebook.cells.find(c => c.id === currentSelectedId)
      : null;
    const targetCellId = targetCell
      ? targetCell.id
      : notebook.cells[notebook.cells.length - 1].id;

    currentNotebook.update(nb => {
      if (!nb) return nb;
      const updatedNotebook = addCellAfter(nb, targetCellId, type);

      const newCell = updatedNotebook.cells.find(cell =>
        !nb.cells.some(oldCell => oldCell.id === cell.id)
      );
      if (newCell) {
        selectedCellId.set(newCell.id);
      }

      return updatedNotebook;
    });
  }

  function clearAllOutputs() {
    resetExecutionCounter();
    currentNotebook.update(notebook => {
      if (!notebook) return notebook;
      return {
        ...notebook,
        cells: notebook.cells.map(cell => ({
          ...cell,
          output: undefined,
          executionOrder: undefined
        })),
        updatedAt: Date.now()
      };
    });
  }

  function handleInsertCode({ code }: { code: string }) {
    const notebook = get(currentNotebook);
    if (!notebook) return;

    const lastCell = notebook.cells[notebook.cells.length - 1];
    const updatedNotebook = addCellAfter(notebook, lastCell.id, 'code');

    updatedNotebook.cells[updatedNotebook.cells.length - 1].content = code;

    currentNotebook.set(updatedNotebook);
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="app-container">
  <!-- Observable-style header -->
  <header class="app-header">
    <div class="header-left">
      <button class="notebooks-btn" onclick={() => showCommandPalette = true} title="Command Palette (Ctrl+K)">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 8h10M8 3l5 5-5 5"/>
        </svg>
        <kbd class="kbd-hint">⌘K</kbd>
      </button>
      <button class="notebooks-btn" onclick={handleNewNotebook} title="New Notebook (Ctrl+N)">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M8 3v10M3 8h10"/>
        </svg>
        New
      </button>
      <button class="notebooks-btn" onclick={handleImportNotebook} title="Import Notebook (Ctrl+O)">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 10v2a2 2 0 01-2 2H4a2 2 0 01-2-2v-2M8 2v9M5 8l3 3 3-3"/>
        </svg>
        Import
      </button>
      <button class="notebooks-btn" onclick={handleExportNotebook} title="Export Notebook">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 10v2a2 2 0 01-2 2H4a2 2 0 01-2-2v-2M8 11V3M5 6l3-3 3 3"/>
        </svg>
        Export
      </button>
    </div>

    <div class="header-right">
      {#if $currentNotebook}
        <button
          class="reactive-toggle"
          class:active={$reactiveMode}
          onclick={() => reactiveMode.update(v => !v)}
          title="Reactive mode: when on, running a cell automatically re-runs the cells that depend on it"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/>
          </svg>
          Reactive {$reactiveMode ? 'on' : 'off'}
        </button>
        <span class="header-separator">•</span>
        {#if $notebookDirty}
          <span class="unsaved-dot" title="Unsaved changes — press Ctrl/Cmd+S to checkpoint"></span>
        {/if}
        {#if $staleCells.size > 0}
          <button
            class="run-stale-btn"
            onclick={() => window.dispatchEvent(new CustomEvent('run-stale-cells'))}
            title="Re-run cells whose dependencies changed"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <path d="M12 9v4M12 17h.01"/>
            </svg>
            Run {$staleCells.size} stale
          </button>
          <span class="header-separator">•</span>
        {/if}
        <span class="header-meta">Updated {new Date($currentNotebook.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
        <span class="header-separator">•</span>
        <span class="header-meta">{$currentNotebook.cells.length} cells</span>
        <span class="header-separator">•</span>
        <button
          class="run-all-header-btn"
          onclick={() => window.dispatchEvent(new CustomEvent('run-all-cells'))}
          title="Run All Cells"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
            <path d="M3 2l9 5-9 5V2z"/>
          </svg>
          Run All
        </button>
        <span class="header-separator">•</span>
      {/if}
      <button
        class="icon-btn"
        class:active={chatSidebarOpen}
        onclick={() => chatSidebarOpen = !chatSidebarOpen}
        title="AI Assistant (Ctrl+/)"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z"/>
        </svg>
      </button>
      <button class="icon-btn" onclick={toggleRightSidebar} title="Info">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="10" cy="10" r="8"/>
          <path d="M10 14v-4M10 6v.5"/>
        </svg>
      </button>
    </div>
  </header>

  <div class="content-wrapper">
    <main class="main-content">
      <Notebook />
    </main>

    {#if chatSidebarOpen}
      <aside class="chat-sidebar-container">
        <ChatSidebar
          onclose={() => chatSidebarOpen = false}
          oninsertCode={handleInsertCode}
        />
      </aside>
    {/if}

    {#if rightSidebarOpen}
      <aside class="right-sidebar-container">
        <RightSidebar onclose={() => rightSidebarOpen = false} />
      </aside>
    {/if}
  </div>

  <CommandPalette
    bind:visible={showCommandPalette}
    oncommand={handleCommand}
  />

  {#if showExportDialog}
    <ExportDialog onclose={() => showExportDialog = false} />
  {/if}

  {#if pendingNav}
    <div
      class="unsaved-overlay"
      role="presentation"
      onclick={(e) => { if (e.target === e.currentTarget) cancelPending(); }}
    >
      <div class="unsaved-modal" role="dialog" aria-modal="true" aria-labelledby="unsaved-title">
        <h3 id="unsaved-title">Unsaved changes</h3>
        <p>
          You have unsaved changes. Save them before you {pendingNav.label}?
          Discarding will permanently lose your current work.
        </p>
        <div class="unsaved-actions">
          <button class="btn-ghost" onclick={cancelPending} disabled={savingPending}>Cancel</button>
          <button class="btn-danger" onclick={discardAndContinue} disabled={savingPending}>Discard</button>
          <button class="btn-confirm" onclick={saveAndContinue} disabled={savingPending}>
            {savingPending ? 'Saving…' : 'Save & continue'}
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .app-container {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background-color: #ffffff;
  }

  .app-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 1.25rem;
    background-color: #ffffff;
    border-bottom: 1px solid #e8e8e8;
    height: 44px;
    position: relative;
    z-index: 50;
  }

  .header-left,
  .header-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .notebooks-btn {
    background: transparent;
    border: none;
    padding: 0.4rem 0.65rem;
    font-size: 0.8125rem;
    color: #6b6b6b;
    cursor: pointer;
    border-radius: 4px;
    transition: all 0.15s ease;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .notebooks-btn:hover {
    background-color: #f5f5f5;
    color: #1a1a1a;
  }

  .kbd-hint {
    padding: 0.125rem 0.375rem;
    background-color: #f3f4f6;
    border: 1px solid #d1d5db;
    border-radius: 3px;
    font-family: 'Fira Code', monospace;
    font-size: 0.625rem;
    color: #6b7280;
    margin-left: 0.25rem;
  }

  .icon-btn {
    background: transparent;
    border: none;
    padding: 0.35rem;
    color: #6b6b6b;
    cursor: pointer;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
  }

  .icon-btn:hover {
    background-color: #f5f5f5;
    color: #1a1a1a;
  }

  .icon-btn.active {
    background-color: #1a1a1a;
    color: #ffffff;
  }

  .icon-btn.active:hover {
    background-color: #000000;
  }

  .header-meta {
    font-size: 0.8125rem;
    color: #666666;
  }

  .header-separator {
    color: #d0d0d0;
    font-size: 0.8125rem;
  }

  .unsaved-dot {
    width: 8px;
    height: 8px;
    border-radius: 9999px;
    background: #ef4444;
    box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.2);
    margin-right: 0.45rem;
  }

  .run-all-header-btn {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.35rem 0.65rem;
    background-color: #1a1a1a;
    color: white;
    border: none;
    border-radius: 4px;
    font-size: 0.8rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .run-all-header-btn:hover {
    background-color: #000000;
  }

  .run-stale-btn {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.35rem 0.65rem;
    background-color: #fffbeb;
    color: #b45309;
    border: 1px solid #fcd34d;
    border-radius: 4px;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .run-stale-btn:hover {
    background-color: #fef3c7;
  }

  .reactive-toggle {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.35rem 0.6rem;
    background-color: transparent;
    color: #9ca3af;
    border: 1px solid #e0e0e0;
    border-radius: 4px;
    font-size: 0.8rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .reactive-toggle:hover { background-color: #f4f4f4; color: #6b6b6b; }

  .reactive-toggle.active {
    background-color: #eef2ff;
    color: #4f46e5;
    border-color: #c7d2fe;
  }

  .content-wrapper {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  .main-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .chat-sidebar-container {
    width: 380px;
    border-left: 1px solid #e8e8e8;
    background-color: #fafafa;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .right-sidebar-container {
    width: 280px;
    border-left: 1px solid #e8e8e8;
    background-color: #fafafa;
    overflow-y: auto;
  }

  @media (max-width: 768px) {
    .chat-sidebar-container,
    .right-sidebar-container {
      position: fixed;
      right: 0;
      top: 48px;
      bottom: 0;
      z-index: 30;
      box-shadow: -2px 0 8px rgba(0, 0, 0, 0.1);
    }
  }

  .unsaved-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .unsaved-modal {
    background: #ffffff;
    border-radius: 0.5rem;
    width: 90%;
    max-width: 420px;
    padding: 1.5rem;
    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.2);
  }

  .unsaved-modal h3 {
    margin: 0 0 0.5rem 0;
    font-size: 1.05rem;
    font-weight: 600;
    color: #1a1a1a;
  }

  .unsaved-modal p {
    margin: 0 0 1.25rem 0;
    font-size: 0.875rem;
    line-height: 1.5;
    color: #4a4a4a;
  }

  .unsaved-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .unsaved-actions button {
    padding: 0.5rem 0.9rem;
    border-radius: 0.375rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
    transition: all 0.15s;
  }

  .unsaved-actions button:disabled { opacity: 0.6; cursor: not-allowed; }

  .btn-ghost { background: transparent; color: #4a4a4a; border-color: #d1d5db; }
  .btn-ghost:hover:not(:disabled) { background: #f3f4f6; }

  .btn-danger { background: #fef2f2; color: #b91c1c; border-color: #fecaca; }
  .btn-danger:hover:not(:disabled) { background: #fee2e2; }

  .btn-confirm { background: #1a1a1a; color: #ffffff; }
  .btn-confirm:hover:not(:disabled) { background: #000000; }
</style>
