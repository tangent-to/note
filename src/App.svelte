<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { fade } from 'svelte/transition';
  import Notebook from './lib/components/Notebook.svelte';
  import RightSidebar from './lib/components/RightSidebar.svelte';
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
    runProgress,
    addCellAfter,
    createNewCell,
    selectedCellId,
    undoDeleteCell,
    resetExecutionCounter,
    resetStaleTracking,
    outputPosition,
    kernelMode
  } from './lib/stores/notebook';
  import { kernel, kernelBusy } from './lib/utils/kernelClient';
  import { theme, toggleTheme } from './lib/utils/theme';
  import { handleGlobalKeydown } from './lib/utils/keyboardShortcuts';
  import { saveNotebook, exportNotebookSource, parseJSNotebook, importNotebookFromFile } from './lib/utils/fileOperations';
  import { loadFromLocalStorage, getLocalStorageMeta, saveToLocalStorage } from './lib/utils/webPersistence';
  import { parseImportRequest, decodeRedirect, fetchNotebookFromUrl, notebooksEquivalent, type ImportRequest } from './lib/utils/urlImport';
  import { connectSync, isSyncConnected, saveThroughSync, syncFile, syncStatus } from './lib/utils/serverSync';
  import type { Notebook as NotebookDoc } from './lib/types/notebook';

  type PanelTab = 'info' | 'variables' | 'console' | 'chat' | 'data';
  let rightSidebarOpen = $state(false);
  let rightSidebarTab = $state<PanelTab>('info');

  /**
   * Open the panel on `tab`, or close it if it is already showing that tab.
   * Every panel entry point (header buttons, shortcuts, command palette) goes
   * through here, so there is one panel with one open/close behaviour.
   */
  function togglePanelTab(tab: PanelTab) {
    if (rightSidebarOpen && rightSidebarTab === tab) {
      rightSidebarOpen = false;
      return;
    }
    rightSidebarTab = tab;
    rightSidebarOpen = true;
    // Chat is prose and needs more room than the tool tabs. Widen once if the
    // panel is too narrow to read in, never shrink what the user chose.
    if (tab === 'chat' && rightSidebarWidth < CHAT_MIN_WIDTH) {
      rightSidebarWidth = CHAT_MIN_WIDTH;
      localStorage.setItem(PANEL_WIDTH_KEY, String(rightSidebarWidth));
    }
  }

  // Right panel width: user-resizable by dragging its left edge, persisted.
  const PANEL_WIDTH_KEY = 'tangent-panel-width';
  const PANEL_MIN = 240;
  const PANEL_MAX = 720;
  const CHAT_MIN_WIDTH = 380;
  const clampPanel = (w: number) => Math.min(PANEL_MAX, Math.max(PANEL_MIN, w));
  let rightSidebarWidth = $state(clampPanel(Number(localStorage.getItem(PANEL_WIDTH_KEY)) || 300));

  function startPanelResize(event: PointerEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = rightSidebarWidth;
    const onMove = (e: PointerEvent) => {
      // Dragging left widens the panel (it is docked to the right edge).
      rightSidebarWidth = clampPanel(startWidth + (startX - e.clientX));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      localStorage.setItem(PANEL_WIDTH_KEY, String(rightSidebarWidth));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }
  let showExportDialog = $state(false);
  let showCommandPalette = $state(false);
  let showShortcuts = $state(false);

  // Transient status message (e.g. a failed save), shown as a dismissible toast
  // instead of a blocking window.alert.
  let toast: { message: string; tone: 'error' | 'info' } | null = $state(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function showToast(message: string, tone: 'error' | 'info' = 'info') {
    toast = { message, tone };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast = null; }, 5000);
  }

  const SHORTCUTS: { keys: string; action: string }[] = [
    { keys: '⌘/Ctrl + K', action: 'Command palette' },
    { keys: '⌘/Ctrl + /', action: 'Toggle AI chat' },
    { keys: '⌘/Ctrl + S', action: 'Save notebook' },
    { keys: '⌘/Ctrl + N', action: 'New notebook' },
    { keys: '⌘/Ctrl + O', action: 'Open notebook' },
    { keys: '⌘/Ctrl + Enter', action: 'Run cell' },
    { keys: 'Shift + Enter', action: 'Run cell, select next' },
    { keys: 'Alt + Enter', action: 'Run cell, insert below' },
    { keys: '⌘/Ctrl + `', action: 'Toggle console' },
    { keys: '⌘/Ctrl + Shift + D', action: 'Toggle data panel' },
    { keys: '⌘/Ctrl + Z', action: 'Undo cell delete' },
  ];

  // Pending destructive navigation (New / Import / open-from-link) awaiting a
  // save decision. When set, the confirmation modal is shown. `message`
  // overrides the default unsaved-changes wording; `onCancel` runs when the
  // user backs out.
  let pendingNav: { run: () => void; label: string; message?: string; onCancel?: () => void } | null = $state(null);
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
    const onCancel = pendingNav?.onCancel;
    pendingNav = null;
    onCancel?.();
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
    // Deep links (/gh/… on GitHub Pages) arrive via the 404.html shim as
    // /?p=<original path>; restore the real URL before routing.
    const redirect = decodeRedirect(window.location.search);
    if (redirect) {
      history.replaceState(null, '', redirect.pathname + redirect.search);
    }
    const target = redirect ?? { pathname: window.location.pathname, search: window.location.search };
    const importRequest = parseImportRequest(target.pathname, target.search);

    // A `note serve` companion owns a file on disk and wins over the cache: it
    // is the git-tracked source of truth. When none answers, nothing changes.
    connectSync({
      onLoad: (content, reason) => applySyncedContent(content, reason),
      onConflict: (diskContent) => handleSyncConflict(diskContent),
      onSaved: () => {
        markNotebookClean();
        showToast('Saved to disk', 'info');
      },
    }).then((connected) => {
      if (connected) return;
      if (importRequest) loadNotebookFromUrl(importRequest);
      else restoreOrLoadSample();
    });

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

    const onImportRequest = () => handleImportNotebook();
    window.addEventListener('request-import-notebook', onImportRequest);

    // Any component can surface a toast instead of a blocking alert().
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? {};
      if (detail.message) showToast(detail.message, detail.tone === 'error' ? 'error' : 'info');
    };
    window.addEventListener('tangent-toast', onToast);

    return () => {
      unsubscribe();
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('request-import-notebook', onImportRequest);
      window.removeEventListener('tangent-toast', onToast);
      clearTimeout(toastTimer);
    };
  });

  function restoreOrLoadSample() {
    const meta = getLocalStorageMeta();
    const saved = loadFromLocalStorage();

    if (saved && meta) {
      currentNotebook.set(saved);
      markNotebookClean();
      console.info('Notebook restored from previous session');
    } else {
      loadSampleNotebook();
    }
  }

  async function loadNotebookFromUrl(request: ImportRequest) {
    // Show the locally saved notebook while the link is fetched — it's also
    // what's at stake if the import replaces it.
    const cached = getLocalStorageMeta() ? loadFromLocalStorage() : null;
    if (cached) {
      currentNotebook.set(cached);
      markNotebookClean();
    }

    try {
      const notebook = await fetchNotebookFromUrl(request);
      const hostname = new URL(request.fetchUrl).hostname;

      if (cached && !notebooksEquivalent(cached, notebook)) {
        // Opening the link would replace local work: ask first.
        pendingNav = {
          run: () => applyImportedNotebook(notebook, hostname),
          label: `open “${notebook.name}”`,
          message: `This link opens “${notebook.name}”, which will replace your current notebook “${cached.name}”. Save the current one first?`,
          // Keep the local notebook; drop the import URL so a refresh
          // doesn't re-ask.
          onCancel: () => history.replaceState(null, '', '/'),
        };
      } else {
        applyImportedNotebook(notebook, hostname);
      }
    } catch (err: any) {
      console.error('URL import failed:', err);
      showToast(
        cached
          ? `Couldn’t open the notebook from the link: ${err.message}. Showing your last local notebook instead.`
          : `Couldn’t open the notebook from the link: ${err.message}.`,
        'error'
      );
      if (!cached) loadSampleNotebook();
    }
  }

  function applyImportedNotebook(notebook: NotebookDoc, hostname: string) {
    resetExecutionCounter();
    resetStaleTracking();
    currentNotebook.set(notebook);
    markNotebookClean();
    // Drop the import URL so a refresh reopens the autosaved copy instead
    // of re-fetching and overwriting any edits made since.
    history.replaceState(null, '', '/');
    showToast(`Loaded “${notebook.name}” from ${hostname}`, 'info');
  }

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

  function onKeydown(event: KeyboardEvent) {
    handleGlobalKeydown(event, {
      showCommandPalette: () => { showCommandPalette = !showCommandPalette; },
      toggleChat: () => togglePanelTab('chat'),
      toggleData: () => togglePanelTab('data'),
      toggleConsole: () => togglePanelTab('console'),
      save: () => performSaveShortcut(),
      newNotebook: () => handleNewNotebook(),
      importNotebook: () => handleImportNotebook(),
      undo: () => handleUndo(),
    });
  }

  /** Load content pushed by the companion (initial file, or an external edit). */
  function applySyncedContent(content: string, reason: 'hello' | 'disk-change') {
    // An external edit must not silently discard work in progress in the tab.
    if (reason === 'disk-change' && get(notebookDirty)) {
      showToast('The file changed on disk. Save or reload to take the new version.', 'error');
      return;
    }
    const name = get(syncFile)?.split('/').pop() ?? 'notebook.js';
    const notebook = parseJSNotebook(content, name);
    currentNotebook.set(notebook);
    resetStaleTracking();
    resetExecutionCounter();
    markNotebookClean();
    if (reason === 'disk-change') showToast('Reloaded from disk', 'info');
  }

  function handleSyncConflict(_diskContent: string) {
    showToast('The file changed on disk since you opened it. Save again to overwrite.', 'error');
    syncConflict = true;
  }

  let syncConflict = $state(false);

  async function performSaveShortcut() {
    const notebook = get(currentNotebook);
    if (!notebook) return;
    try {
      // With a companion, save writes the file in place so git sees the diff.
      // A second save after a conflict warning overwrites deliberately.
      if (isSyncConnected()) {
        const source = await exportNotebookSource(notebook);
        if (saveThroughSync(source, syncConflict)) {
          syncConflict = false;
          return;
        }
      }
      await saveNotebook(notebook);
      markNotebookClean();
      console.info('Notebook checkpoint exported as .js');
    } catch (err) {
      console.error('Save failed', err);
      showToast('Couldn’t export the notebook. See the console for details.', 'error');
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
      case 'toggle-output-position': {
        const next = get(outputPosition) === 'above' ? 'below' : 'above';
        outputPosition.set(next);
        showToast(`Cell outputs now appear ${next} the code`, 'info');
        break;
      }
      case 'toggle-kernel-mode': {
        const next = get(kernelMode) === 'worker' ? 'main' : 'worker';
        kernelMode.set(next);
        showToast(next === 'worker'
          ? 'Kernel: background worker. The page stays responsive and runs can be stopped.'
          : 'Kernel: main thread. Outputs can run their own scripts, but long runs freeze the page.', 'info');
        break;
      }
      case 'add-code-cell':
        addNewCell('code');
        break;
      case 'add-markdown-cell':
        addNewCell('markdown');
        break;
      case 'toggle-chat':
        togglePanelTab('chat');
        break;
      case 'open-data':
        togglePanelTab('data');
        break;
      case 'open-console':
        togglePanelTab('console');
        break;
      case 'clear-outputs':
        clearAllOutputs();
        break;
      case 'keyboard-shortcuts':
        showShortcuts = true;
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

  // Pull runnable code out of an AI chat reply. If the reply contains fenced
  // ```code blocks```, use their contents (joined); otherwise treat the whole
  // message as code. This keeps prose/explanations out of the inserted cell.
  function extractCodeFromMessage(message: string): string {
    const fence = /```[^\n]*\n([\s\S]*?)```/g;
    const blocks: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = fence.exec(message)) !== null) {
      blocks.push(match[1].replace(/\s+$/, ''));
    }
    return blocks.length > 0 ? blocks.join('\n\n') : message.trim();
  }

  function handleInsertCode({ code }: { code: string }) {
    const notebook = get(currentNotebook);
    if (!notebook) return;

    const cellCode = extractCodeFromMessage(code);

    // Insert after the selected cell so the new cell lands where you're
    // working; fall back to the end of the notebook if nothing is selected.
    const selectedId = get(selectedCellId);
    const anchor =
      notebook.cells.find(c => c.id === selectedId) ??
      notebook.cells[notebook.cells.length - 1];

    const updatedNotebook = addCellAfter(notebook, anchor.id, 'code');
    const anchorIdx = updatedNotebook.cells.findIndex(c => c.id === anchor.id);
    const newCell = updatedNotebook.cells[anchorIdx + 1];
    newCell.content = cellCode;

    currentNotebook.set(updatedNotebook);
    selectedCellId.set(newCell.id);
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="app-container">
  <!-- Observable-style header -->
  <header class="app-header">
    {#if $runProgress}
      <div
        class="run-progress"
        class:complete={$runProgress.done >= $runProgress.total}
        style="transform: scaleX({$runProgress.total ? $runProgress.done / $runProgress.total : 0})"
        role="progressbar"
        aria-valuenow={$runProgress.done}
        aria-valuemax={$runProgress.total}
        aria-label="Running cells"
        transition:fade={{ duration: 250 }}
      ></div>
    {/if}
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
        <span class="btn-label">New</span>
      </button>
      <button class="notebooks-btn" onclick={handleImportNotebook} title="Import Notebook (Ctrl+O)">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 10v2a2 2 0 01-2 2H4a2 2 0 01-2-2v-2M8 2v9M5 8l3 3 3-3"/>
        </svg>
        <span class="btn-label">Import</span>
      </button>
      <button class="notebooks-btn" onclick={handleExportNotebook} title="Export Notebook">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 10v2a2 2 0 01-2 2H4a2 2 0 01-2-2v-2M8 11V3M5 6l3-3 3 3"/>
        </svg>
        <span class="btn-label">Export</span>
      </button>
    </div>

    <div class="header-right">
      {#if $currentNotebook}
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
            <span class="btn-label">Run {$staleCells.size} stale</span>
          </button>
        {/if}
        <button
          class="reactive-toggle"
          class:active={$reactiveMode}
          onclick={() => reactiveMode.update(v => !v)}
          title="Reactive mode: when on, running a cell automatically re-runs the cells that depend on it"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/>
          </svg>
          <span class="btn-label">Reactive {$reactiveMode ? 'on' : 'off'}</span>
        </button>
        {#if $kernelBusy}
          <!-- No fade-in: the kill switch must never look half-disabled. -->
          <button
            class="stop-kernel-btn"
            onclick={() => { kernel.interrupt(); resetStaleTracking(); showToast('Kernel stopped and restarted. Notebook variables were cleared.', 'info'); }}
            title="Stop the running computation (restarts the kernel; notebook variables are cleared)"
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor">
              <rect x="2.5" y="2.5" width="9" height="9" rx="1.5"/>
            </svg>
            <span class="btn-label">Stop</span>
          </button>
        {/if}
        <span class="header-meta">
          {#if $notebookDirty}
            <span class="unsaved-dot" title="Unsaved changes. Press Ctrl/Cmd+S to checkpoint"></span>
          {/if}
          {$currentNotebook.cells.length} {$currentNotebook.cells.length === 1 ? 'cell' : 'cells'}
        </span>
        {#if $syncStatus === 'connected'}
          <!-- Saving writes this file in place, so the state on disk (and in
               git) is what you see. Worth showing: it changes what Ctrl+S does. -->
          <span class="sync-badge" title={`Linked to ${$syncFile}. Ctrl/Cmd+S writes this file.`}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5"/>
              <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>
            </svg>
            {$syncFile?.split('/').pop()}
          </span>
        {/if}
        <button
          class="run-all-header-btn"
          onclick={() => window.dispatchEvent(new CustomEvent('run-all-cells'))}
          title="Run All Cells"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
            <path d="M3 2l9 5-9 5V2z"/>
          </svg>
          <span class="btn-label">Run All</span>
        </button>
        <span class="header-divider" aria-hidden="true"></span>
      {/if}
      <button
        class="icon-btn"
        onclick={toggleTheme}
        title={$theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        aria-label={$theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {#if $theme === 'dark'}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="4"/>
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke-linecap="round"/>
          </svg>
        {:else}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
          </svg>
        {/if}
      </button>
      <button
        class="icon-btn"
        class:active={rightSidebarOpen}
        onclick={() => rightSidebarOpen = !rightSidebarOpen}
        title="Side panel"
        aria-label="Toggle side panel"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2"/>
          <line x1="14.5" y1="4" x2="14.5" y2="20"/>
        </svg>
      </button>
    </div>
  </header>

  <div class="content-wrapper">
    <main class="main-content">
      <Notebook />
    </main>

    {#if rightSidebarOpen}
      <aside class="right-sidebar-container" style="width: {rightSidebarWidth}px">
        <div
          class="panel-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
          onpointerdown={startPanelResize}
        ></div>
        <RightSidebar
          bind:activeTab={rightSidebarTab}
          onclose={() => rightSidebarOpen = false}
          oninsertCode={handleInsertCode}
        />
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
        <h3 id="unsaved-title">{pendingNav.message ? 'Replace your notebook?' : 'Unsaved changes'}</h3>
        <p>
          {#if pendingNav.message}
            {pendingNav.message}
            Discarding will permanently lose your current work.
          {:else}
            You have unsaved changes. Save them before you {pendingNav.label}?
            Discarding will permanently lose your current work.
          {/if}
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

  {#if showShortcuts}
    <div
      class="unsaved-overlay"
      role="presentation"
      onclick={(e) => { if (e.target === e.currentTarget) showShortcuts = false; }}
    >
      <div class="shortcuts-modal" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
        <div class="shortcuts-head">
          <h3 id="shortcuts-title">Keyboard shortcuts</h3>
          <button class="shortcuts-close" onclick={() => showShortcuts = false} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M3 3l8 8M11 3l-8 8"/>
            </svg>
          </button>
        </div>
        <ul class="shortcuts-list">
          {#each SHORTCUTS as s}
            <li>
              <span class="shortcuts-action">{s.action}</span>
              <kbd class="shortcuts-keys">{s.keys}</kbd>
            </li>
          {/each}
        </ul>
      </div>
    </div>
  {/if}

  {#if toast}
    <div class="toast {toast.tone}" role="status" aria-live="polite">
      <span>{toast.message}</span>
      <button class="toast-close" onclick={() => toast = null} aria-label="Dismiss">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M3 3l8 8M11 3l-8 8"/>
        </svg>
      </button>
    </div>
  {/if}
</div>

<style>
  .app-container {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background-color: var(--bg);
  }

  .app-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 1.25rem;
    background-color: var(--surface);
    border-bottom: 1px solid var(--border);
    height: 44px;
    position: relative;
    z-index: 50;
  }

  /* Thin batch-run progress bar, sitting on the header's bottom edge. It fills
     left-to-right as cells finish; a gentle pulse marks that a cell is still
     running, and it fades out when the run completes. */
  .run-progress {
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 2px;
    transform-origin: left center;
    background: var(--accent-solid);
    transition: transform 0.3s ease;
    z-index: 51;
    pointer-events: none;
  }
  .run-progress:not(.complete) {
    animation: run-progress-pulse 1.1s ease-in-out infinite;
  }
  @keyframes run-progress-pulse {
    0%, 100% { opacity: 0.72; }
    50% { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .run-progress { transition: none; animation: none; }
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
    color: var(--text-muted);
    cursor: pointer;
    border-radius: var(--radius-pill);
    transition: all 0.15s ease;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .notebooks-btn:hover {
    background-color: var(--surface-hover);
    color: var(--heading);
  }

  .kbd-hint {
    padding: 0.125rem 0.375rem;
    background-color: var(--surface-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-input);
    font-family: var(--font-mono);
    font-size: 0.625rem;
    color: var(--text-muted);
    margin-left: 0.25rem;
  }

  .icon-btn {
    background: transparent;
    border: none;
    padding: 0.35rem;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: var(--radius-pill);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
  }

  .icon-btn:hover {
    background-color: var(--surface-hover);
    color: var(--heading);
  }

  .icon-btn.active {
    background-color: var(--accent-weak-bg);
    color: var(--accent-weak-fg);
  }

  .icon-btn.active:hover {
    background-color: var(--accent-weak-bg);
    color: var(--accent);
  }

  .header-meta {
    display: inline-flex;
    align-items: center;
    font-size: 0.8125rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .header-divider {
    width: 1px;
    height: 18px;
    background: var(--border);
    margin: 0 0.15rem;
  }

  .unsaved-dot {
    width: 8px;
    height: 8px;
    border-radius: var(--radius-pill);
    background: var(--danger-solid);
    box-shadow: 0 0 0 2px var(--danger-bg);
    margin-right: 0.45rem;
  }

  .run-all-header-btn {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.35rem 0.7rem;
    background-color: var(--accent-solid);
    color: var(--accent-on-solid);
    border: none;
    border-radius: var(--radius-pill);
    font-size: 0.8rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .run-all-header-btn:hover {
    background-color: var(--accent-solid-hover);
  }

  .run-stale-btn {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.35rem 0.7rem;
    background-color: var(--warn-bg);
    color: var(--warn-fg);
    border: 1px solid var(--warn-border);
    border-radius: var(--radius-pill);
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .run-stale-btn:hover {
    filter: brightness(0.97);
  }

  .reactive-toggle {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.35rem 0.7rem;
    background-color: transparent;
    color: var(--text-muted);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill);
    font-size: 0.8rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .reactive-toggle:hover { background-color: var(--surface-hover); color: var(--heading); }

  /* Active state toggles are QUIET (weak accent fill): solid teal is reserved
     for the page's one primary action, Run All. */
  .reactive-toggle.active {
    background-color: var(--accent-weak-bg);
    color: var(--accent-weak-fg);
    border-color: var(--accent-weak-border);
  }

  .stop-kernel-btn {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.35rem 0.7rem;
    background-color: var(--danger-bg);
    color: var(--danger-fg);
    border: 1px solid var(--danger-border);
    border-radius: var(--radius-pill);
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition: filter 0.15s ease;
  }

  .stop-kernel-btn:hover { filter: brightness(0.95); }

  /* Mobile: collapse the header to icons so it fits narrow screens. */
  @media (max-width: 640px) {
    .app-header { padding: 0.4rem 0.5rem; }
    .header-left,
    .header-right { gap: 0.1rem; }
    .btn-label,
    .header-meta,
    .kbd-hint { display: none; }
    .notebooks-btn,
    .run-all-header-btn,
    .run-stale-btn,
    .reactive-toggle { padding: 0.4rem 0.45rem; gap: 0; }
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

  .right-sidebar-container {
    position: relative;
    border-left: 1px solid var(--border);
    background-color: var(--bg);
    overflow-y: auto;
    flex-shrink: 0;
  }

  /* Invisible grab strip over the left border; teal on hover/drag. */
  .sync-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--accent);
    border: 1px solid var(--border);
    border-radius: var(--radius-input);
    padding: 0.15rem 0.4rem;
    white-space: nowrap;
  }

  .panel-resize-handle {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 5px;
    cursor: col-resize;
    z-index: 10;
  }

  .panel-resize-handle:hover,
  .panel-resize-handle:active {
    background: var(--accent);
    opacity: 0.35;
  }

  @media (max-width: 768px) {
    .right-sidebar-container {
      position: fixed;
      right: 0;
      top: 48px;
      bottom: 0;
      z-index: 30;
      box-shadow: var(--shadow-md);
      /* Never wider than the viewport, whatever width was dragged on desktop. */
      max-width: 100vw;
    }
  }

  .unsaved-overlay {
    position: fixed;
    inset: 0;
    background: var(--overlay);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .unsaved-modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    width: 90%;
    max-width: 420px;
    padding: 1.5rem;
    box-shadow: var(--shadow-lg);
  }

  .unsaved-modal h3 {
    margin: 0 0 0.5rem 0;
    font-size: 1.05rem;
    font-weight: 600;
    color: var(--heading);
  }

  .unsaved-modal p {
    margin: 0 0 1.25rem 0;
    font-size: 0.875rem;
    line-height: 1.5;
    color: var(--text);
  }

  .unsaved-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .unsaved-actions button {
    padding: 0.5rem 0.9rem;
    border-radius: var(--radius-pill);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
    transition: all 0.15s;
  }

  .unsaved-actions button:disabled { opacity: 0.6; cursor: not-allowed; }

  .btn-ghost { background: transparent; color: var(--text); border-color: var(--border-strong); }
  .btn-ghost:hover:not(:disabled) { background: var(--surface-hover); }

  .btn-danger { background: var(--danger-bg); color: var(--danger-fg); border-color: var(--danger-border); }
  .btn-danger:hover:not(:disabled) { filter: brightness(0.97); }

  .btn-confirm { background: var(--accent-solid); color: var(--accent-on-solid); }
  .btn-confirm:hover:not(:disabled) { background: var(--accent-solid-hover); }

  .shortcuts-modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    width: 90%;
    max-width: 440px;
    padding: 1.25rem 1.5rem 1.5rem;
    box-shadow: var(--shadow-lg);
  }

  .shortcuts-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.75rem;
  }

  .shortcuts-head h3 {
    margin: 0;
    font-size: 1.05rem;
    font-weight: 600;
    color: var(--heading);
  }

  .shortcuts-close {
    display: flex;
    padding: 0.3rem;
    background: transparent;
    border: none;
    border-radius: var(--radius-pill);
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .shortcuts-close:hover { background: var(--surface-hover); color: var(--heading); }

  .shortcuts-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .shortcuts-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 0;
    border-top: 1px solid var(--border);
  }

  .shortcuts-action {
    font-size: 0.875rem;
    color: var(--text);
  }

  .shortcuts-keys {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--text);
    background: var(--surface-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-input);
    padding: 0.15rem 0.45rem;
    white-space: nowrap;
  }

  .toast {
    position: fixed;
    bottom: 1.25rem;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 0.75rem;
    max-width: min(90vw, 420px);
    padding: 0.65rem 0.75rem 0.65rem 1rem;
    border-radius: var(--radius-input);
    font-size: 0.85rem;
    box-shadow: var(--shadow-md);
    z-index: 1100;
  }

  .toast.error {
    background: var(--danger-bg);
    color: var(--danger-fg);
    border: 1px solid var(--danger-border);
  }

  .toast.info {
    background: var(--heading);
    color: var(--bg);
    border: 1px solid var(--heading);
  }

  .toast-close {
    display: flex;
    padding: 0.2rem;
    background: transparent;
    border: none;
    border-radius: var(--radius-pill);
    color: currentColor;
    opacity: 0.7;
    cursor: pointer;
  }

  .toast-close:hover { opacity: 1; }
</style>
