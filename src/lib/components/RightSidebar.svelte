<script lang="ts">
  import type { PanelTab } from '../types/panel';
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { currentNotebook, kernelMode, notebookWidth } from '../stores/notebook';
  import { kernelVariables } from '../utils/kernelClient';
  import { datasets, refreshDatasets, addFiles, deleteDataset, formatBytes } from '../utils/dataStore';
  import { SvelteSet } from 'svelte/reactivity';
  import { syncData, syncFiles, syncRoot, syncStatus } from '../utils/serverSync';
  import {
    libraryEntries,
    libraryPersistent,
    originLabel,
    refreshLibrary,
    type LibraryEntry,
  } from '../utils/notebookLibrary';
  import { formatDate, formatDateTime } from '../utils/format';
  import { toast } from '../utils/toast';
  import { currentLock, freezeEnvironment, lockFolder, unfreezeEnvironment } from '../stores/environment';
  import {
    deleteVirtualFile,
    folderForNotebook,
    listVirtualFiles,
    opfsAvailable,
    readVirtualFile,
    type VirtualFile,
  } from '../utils/opfs';
  import { downloadBytes } from '../utils/fileOperations';
  import { shortName } from '../utils/environment';
  import {
    cacheStats,
    clearRemoteCache,
    offlineReady,
    online,
    refreshCacheStats,
  } from '../utils/offlineCache';
  import {
    backupState,
    checkStoragePersisted,
    lastBackupAt,
    requestStoragePersistence,
    snoozeBackupReminder,
    storagePersisted,
  } from '../stores/backup';
  import Console from './Console.svelte';
  import ChatSidebar from './ChatSidebar.svelte';

  interface Props {
    activeTab?: PanelTab;
    oninsertCode?: (detail: { code: string }) => void;
    /** Chat applying (or reverting) a proposed rewrite of one cell. */
    oneditCell?: (detail: { cellId: string; content: string }) => void;
    onopenNotebook?: (detail: { id: string }) => void;
    onopenDiskFile?: (detail: { path: string }) => void;
    ondeleteNotebook?: (detail: { entry: LibraryEntry }) => void;
    onclearBrowserData?: () => void;
    /** Download a backup of everything this browser holds. */
    onbackup?: (detail: { includeLibraries: boolean }) => void;
    /** Pick a backup archive and restore it. */
    onrestore?: () => void;
  }

  let {
    activeTab = $bindable('info'),
    oninsertCode,
    oneditCell,
    onopenNotebook,
    onopenDiskFile,
    ondeleteNotebook,
    onclearBrowserData,
    onbackup,
    onrestore,
  }: Props = $props();

  /** Whether a backup carries the libraries too — heavier, but it runs offline. */
  let backupLibraries = $state(false);

  /** "today", "yesterday", "3 days ago": how old the last backup is, in words. */
  function backupAge(at: number | null): string {
    if (at === null) return 'never';
    const days = Math.floor((Date.now() - at) / (24 * 60 * 60 * 1000));
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    return `${days} days ago`;
  }

  let variables: Record<string, any> = $state({});
  let refreshTimer: number | null = null;

  // Storage panel: the notebook library and the drag-and-drop dataset cache.
  //
  // The panel is deliberately housekeeping, not navigation — opening a notebook
  // day to day is Ctrl+K. That is what lets notebooks and datasets share one
  // panel: here they are both just bytes kept on this machine, listed with a
  // size and a way to delete them.
  let dragActive = $state(false);
  /** Dropping onto the folder's list: the file lands in the folder itself. */
  let dropInFolder = $state(false);

  /**
   * Write dropped files into the served folder.
   *
   * With a folder open, dropping a file means "put it there" — which is what
   * the companion's file endpoint does, and what makes it readable by
   * `FileAttachment` a second later, the watcher having seen it arrive. A name
   * already in the folder is asked about rather than replaced.
   */
  async function dropIntoFolder(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (files.length === 0) return;
    const taken = new Set($syncData.map((f) => f.path));
    let written = 0;
    for (const file of files) {
      if (taken.has(file.name) && !confirm(`${file.name} is already in this folder. Replace it?`)) {
        continue;
      }
      try {
        const response = await fetch(`/__files/${encodeURIComponent(file.name)}`, {
          method: 'PUT',
          body: await file.arrayBuffer(),
          headers: { 'content-type': file.type || 'application/octet-stream' },
        });
        if (!response.ok) {
          const detail = await response.json().catch(() => null);
          toast(detail?.error ?? `Could not write ${file.name} (${response.status}).`, 'error');
          continue;
        }
        written += 1;
      } catch {
        toast('note serve is not reachable.', 'error');
        return;
      }
    }
    if (written > 0) {
      toast(`Wrote ${written} file${written === 1 ? '' : 's'} to the folder.`, 'info');
    }
  }
  let fileInput: HTMLInputElement = $state(null as any);

  async function ingest(files: FileList | File[] | null | undefined) {
    const list = files ? Array.from(files) : [];
    if (list.length === 0) return;
    const added = await addFiles(list);
    if (added.length) {
      toast(`Loaded ${added.length} file${added.length > 1 ? 's' : ''}`, 'info');
    } else {
      toast('Could not read the dropped file(s)', 'error');
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragActive = false;
    ingest(event.dataTransfer?.files);
  }

  function onDragOver(event: DragEvent) {
    event.preventDefault();
    dragActive = true;
  }

  function onDragLeave() {
    dragActive = false;
  }

  async function removeDataset(name: string) {
    // Dropped in here, and nowhere else: the same question a browser-only
    // notebook gets.
    if (!confirm(`Delete the dataset “${name}”? It is only in this browser, and this cannot be undone.`)) return;
    await deleteDataset(name);
    toast(`Removed ${name}`, 'info');
  }

  /**
   * The files of the notebook on screen, when they live in this browser rather
   * than on disk. With the companion they are in the folder, where the reader's
   * own file manager shows them; here, this panel is the only place they exist.
   */
  let virtualFiles: VirtualFile[] = $state([]);
  const virtualFolder = $derived(
    $currentNotebook && $lockFolder === null && opfsAvailable()
      ? folderForNotebook($currentNotebook.id)
      : null
  );

  async function refreshVirtualFiles() {
    virtualFiles = virtualFolder ? await listVirtualFiles(virtualFolder) : [];
  }

  function refreshStorage() {
    refreshDatasets();
    refreshLibrary();
    void checkStoragePersisted();
    void refreshCacheStats();
    void refreshVirtualFiles();
  }

  // A long library turns the panel into a wall. Ctrl+K is the finder for
  // opening; this one is for reaching a row you mean to inspect or delete, so
  // it only appears once scrolling has actually become the problem.
  const FILTER_FROM = 8;
  let notebookFilter = $state('');

  const notebooksSize = $derived($libraryEntries.reduce((n, e) => n + e.size, 0));
  const datasetsSize = $derived($datasets.reduce((n, d) => n + d.size, 0));

  /**
   * One row per notebook, wherever it can be reached from.
   *
   * There used to be two lists — the companion's files and the browser's
   * library — and a notebook opened from disk was in both, under two headings
   * and two names. But a notebook is one thing; where it lives is something it
   * *has*. So the library and the served files are merged on the notebook's
   * own id, and the row says where it lives rather than which list it fell in.
   *
   * Files the companion serves that have never been opened here have no
   * library entry yet, and appear as rows with nothing but a path.
   */
  interface NotebookRow {
    id: string;
    name: string;
    /** Its file, when a companion is serving one. */
    path: string | null;
    entry: LibraryEntry | null;
  }

  const rows = $derived.by((): NotebookRow[] => {
    const pathById = new Map<string, string>();
    const orphans: NotebookRow[] = [];
    for (const file of $syncFiles) {
      if (file.id) pathById.set(file.id, file.path);
      else orphans.push({ id: `path:${file.path}`, name: file.name, path: file.path, entry: null });
    }

    const seen = new Set<string>();
    const known: NotebookRow[] = $libraryEntries.map((entry) => {
      seen.add(entry.id);
      const origin = entry.origin;
      return {
        id: entry.id,
        name: entry.name,
        path: pathById.get(entry.id) ?? (origin.kind === 'disk' ? origin.path : null),
        entry,
      };
    });

    // Served files this browser has never opened: still notebooks, still
    // listed, just with nothing of their own stored yet.
    for (const file of $syncFiles) {
      if (file.id && !seen.has(file.id)) {
        known.push({ id: file.id, name: file.name, path: file.path, entry: null });
      }
    }

    return [...known, ...orphans].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
    );
  });

  const shownRows = $derived.by(() => {
    const q = notebookFilter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) => r.name.toLowerCase().includes(q) || (r.path ?? '').toLowerCase().includes(q)
    );
  });

  /**
   * Which of those rows are in the folder on screen.
   *
   * A path is not enough: a notebook opened from another folder keeps the path
   * it had, and would claim to be here. Only what the companion is serving
   * right now counts, which is also what makes the leftovers of a previous
   * folder visible for what they are.
   */
  const servedPaths = $derived(new Set($syncFiles.map((f) => f.path)));
  /**
   * The folder's files, as a folder rather than a heap.
   *
   * A flat list of everything a directory holds is not a listing of it: put a
   * hundred audio files in `renders/` and the notebooks you came for are gone
   * from the screen. What is at the top level is shown; a sub-directory is one
   * line saying how much it holds, and opens when asked.
   */
  const dataTree = $derived.by(() => {
    const here: typeof $syncData = [];
    const folders = new Map<string, { files: typeof $syncData; size: number }>();
    for (const file of $syncData) {
      const slash = file.path.lastIndexOf('/');
      if (slash === -1) {
        here.push(file);
        continue;
      }
      const dir = file.path.slice(0, slash);
      const bucket = folders.get(dir) ?? { files: [], size: 0 };
      bucket.files.push(file);
      bucket.size += file.size;
      folders.set(dir, bucket);
    }
    return {
      here,
      folders: [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    };
  });

  /** Sub-directories the reader has opened. Closed is the default: the point
   *  of the listing is what is here, not everything underneath. */
  let openFolders = $state(new SvelteSet<string>());

  /** The folder, named the way a person would name it: its last two segments. */
  const shortRoot = $derived.by(() => {
    const root = $syncRoot;
    if (!root) return 'the folder';
    const parts = root.split('/').filter(Boolean);
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : root;
  });
  const inFolder = $derived(shownRows.filter((r) => r.path && servedPaths.has(r.path)));
  const inBrowser = $derived(shownRows.filter((r) => !(r.path && servedPaths.has(r.path))));
  const folderSize = $derived(
    inFolder.reduce((n, r) => n + (r.entry?.size ?? 0), 0) +
      $syncData.reduce((n, f) => n + f.size, 0)
  );
  const browserSize = $derived(inBrowser.reduce((n, r) => n + (r.entry?.size ?? 0), 0) + datasetsSize);

  const openId = $derived($currentNotebook?.id ?? null);

  /**
   * Ask before destroying something, and only then.
   *
   * The rule used to be about what kind of thing it was — notebooks asked,
   * data did not — which had it backwards: forgetting this browser's copy of a
   * notebook that is a file in the folder destroys nothing, while a dataset
   * dropped in here has no other copy at all. So what decides is whether
   * anything survives the click.
   */
  function confirmDelete(entry: LibraryEntry) {
    // Offered only for notebooks with no file in the folder, so there is always
    // something to lose, and always a question to ask.
    if (!confirm(`Delete “${entry.name}”? It is only in this browser, and this cannot be undone.`)) return;
    ondeleteNotebook?.({ entry });
  }

  /**
   * How a cell reads this file. The extension decides the method, because
   * `FileAttachment` does: a reader copying this line should get the data and
   * not a string of it.
   */
  function attachmentSnippet(path: string): string {
    const lower = path.toLowerCase();
    const method = lower.endsWith('.csv')
      ? 'csv({ typed: true })'
      : lower.endsWith('.tsv')
        ? 'tsv({ typed: true })'
        : lower.endsWith('.json') || lower.endsWith('.ndjson')
          ? 'json()'
          : /\.(png|jpe?g|gif|webp|svg)$/.test(lower)
            ? 'image()'
            : /\.(wav|mp3|ogg|flac|mid|midi|zip|parquet|arrow)$/.test(lower)
              ? 'arrayBuffer()'
              : 'text()';
    return `await FileAttachment(${JSON.stringify(path)}).${method}`;
  }

  function copyUsage(name: string) {
    const snippet = `const rows = await data(${JSON.stringify(name)})`;
    navigator.clipboard?.writeText(snippet);
    toast('Copied snippet to clipboard', 'info');
  }

  // Worker kernel pushes variable summaries after each run (kernelVariables
  // store); polling the window scope only applies to main-thread mode.
  function refreshVariables() {
    if (get(kernelMode) === 'worker') return;
    const scope = (window as any).__tangent_scope;
    if (!scope || typeof scope !== 'object') {
      variables = {};
      return;
    }
    const vars: Record<string, any> = {};
    for (const [key, value] of Object.entries(scope)) {
      if (key.startsWith('__tangent_')) continue;
      vars[key] = value;
    }
    variables = vars;
  }

  function formatVarValue(value: any): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'function') return `fn()`;
    if (typeof value === 'string') return value.length > 50 ? `"${value.substring(0, 50)}..."` : `"${value}"`;
    if (Array.isArray(value)) return `Array(${value.length})`;
    if (value instanceof HTMLElement) return `<${value.tagName.toLowerCase()}>`;
    if (typeof value === 'object') {
      const keys = Object.keys(value);
      if (keys.length > 5) return `{${keys.slice(0, 3).join(', ')}, ... +${keys.length - 3}}`;
      try {
        const str = JSON.stringify(value);
        return str.length > 60 ? str.substring(0, 60) + '...' : str;
      } catch {
        return `Object`;
      }
    }
    return String(value);
  }

  function getVarType(value: any): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (value instanceof HTMLElement) return 'element';
    return typeof value;
  }

  onMount(() => {
    refreshVariables();
    refreshStorage();
    refreshTimer = window.setInterval(refreshVariables, 2000);
  });

  // Refresh when the tab changes (e.g. opened to Storage via its shortcut).
  $effect(() => {
    if (activeTab === 'storage') refreshStorage();
    else if (activeTab === 'variables') refreshVariables();
  });

  onDestroy(() => {
    if (refreshTimer) clearInterval(refreshTimer);
  });

  // Unified {name, type, repr} rows from either kernel mode.
  let varEntries = $derived(
    $kernelMode === 'worker'
      ? $kernelVariables
      : Object.entries(variables).map(([name, value]) => ({
          name,
          type: getVarType(value),
          repr: formatVarValue(value),
        }))
  );
</script>

{#snippet dataRow(file: { path: string; size: number }, label: string)}
  <div class="dataset-item">
    <div class="dataset-main">
      <div class="dataset-name" title={file.path}>{label}</div>
      <div class="dataset-meta">{formatBytes(file.size)}</div>
    </div>
    <div class="dataset-actions">
      <button
        class="ds-btn"
        title={attachmentSnippet(file.path)}
        aria-label={`Copy how to read ${file.path}`}
        onclick={() => {
          navigator.clipboard?.writeText(attachmentSnippet(file.path));
          toast(`Copied: ${attachmentSnippet(file.path)}`, 'info');
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2"/>
          <path d="M5 15V5a2 2 0 0 1 2-2h10"/>
        </svg>
      </button>
    </div>
  </div>
{/snippet}

{#snippet notebookRow(row: NotebookRow)}
            <div class="dataset-item" class:current={row.id === openId}>
              <button
                class="notebook-main"
                onclick={() => row.path
                  ? onopenDiskFile?.({ path: row.path })
                  : onopenNotebook?.({ id: row.id })}
                title={row.path ? `Open ${row.path}` : `Open “${row.name}”`}
              >
                <div class="dataset-name">{row.name}</div>
                <div class="dataset-meta">
                  {#if row.path}{row.path}{:else}in this browser{/if}{#if row.entry} · {row.entry.cellCount} cell{row.entry.cellCount === 1 ? '' : 's'} · {formatBytes(row.entry.size)}{:else} · not opened yet{/if}{#if row.id === openId} · open{/if}
                </div>
              </button>
              <div class="dataset-actions">
                <!-- Only for what lives here. A file in the folder is not this
                     panel's to delete, and a bin beside it said otherwise: it
                     offered to forget this browser's copy of it, an internal
                     detail wearing the icon for "destroy what you see".
                     Reopening the file makes that copy again anyway. -->
                {#if row.entry && !(row.path && servedPaths.has(row.path))}
                  <button
                    class="ds-btn ds-danger"
                    title="Delete. This notebook is only in this browser."
                    onclick={() => confirmDelete(row.entry!)}
                    aria-label="Delete notebook"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                    </svg>
                  </button>
                {/if}
              </div>
            </div>
{/snippet}

<div class="right-sidebar">
  {#if activeTab === 'info'}
    {#if $currentNotebook}
      <div class="sidebar-content">
        <div class="info-section">
          <div class="info-label">Cells</div>
          <div class="info-value">{$currentNotebook.cells.length}</div>
        </div>

        <div class="info-section">
          <div class="info-label">Created</div>
          <div class="info-value">{formatDate($currentNotebook.createdAt)}</div>
        </div>

        <div class="info-section">
          <div class="info-label">Last Modified</div>
          <div class="info-value">{formatDateTime($currentNotebook.updatedAt)}</div>
        </div>

        <div class="divider"></div>

        <!-- App settings. The kernel choice is deliberately NOT in the header:
             the default (worker) is right for almost everyone. -->
        <div class="settings-section">
          <h4 class="section-title">Settings</h4>
          <div class="setting-label">Cells run on</div>
          <label class="setting-option">
            <input
              type="radio"
              name="kernel-mode"
              value="worker"
              checked={$kernelMode === 'worker'}
              onchange={() => kernelMode.set('worker')}
            />
            <span title="Plots and tables render normally, the page stays responsive during long computations, and a run can be stopped."><strong>Background worker</strong> (default)</span>
          </label>
          <label class="setting-option">
            <input
              type="radio"
              name="kernel-mode"
              value="main"
              checked={$kernelMode === 'main'}
              onchange={() => kernelMode.set('main')}
            />
            <span title="Hover tooltips, zoomable charts, animated players. Long runs freeze the page."><strong>Main thread</strong>, for outputs that run their own scripts</span>
          </label>
          <p class="setting-hint">Variables don't carry across; re-run after switching.</p>

          <div class="setting-label">Notebook width</div>
          <div class="width-choice" role="radiogroup" aria-label="Notebook width">
            <button
              class="width-btn"
              class:active={$notebookWidth === 'normal'}
              role="radio"
              aria-checked={$notebookWidth === 'normal'}
              onclick={() => notebookWidth.set('normal')}
            >Normal</button>
            <button
              class="width-btn"
              class:active={$notebookWidth === 'wide'}
              role="radio"
              aria-checked={$notebookWidth === 'wide'}
              onclick={() => notebookWidth.set('wide')}
            >Wide</button>
            <button
              class="width-btn"
              class:active={$notebookWidth === 'full'}
              role="radio"
              aria-checked={$notebookWidth === 'full'}
              onclick={() => notebookWidth.set('full')}
            >Full</button>
          </div>
          <p class="setting-hint" title="Normal is a reading measure; the wider settings give code room so a single line stops wrapping.">Normal reads best; wider gives code room.</p>
        </div>

        <div class="divider"></div>

        <div class="shortcuts-section">
          <h4 class="section-title">Keyboard Shortcuts</h4>
          <div class="shortcut-item">
            <span class="shortcut-key">Shift+Enter</span>
            <span class="shortcut-desc">Run & advance</span>
          </div>
          <div class="shortcut-item">
            <span class="shortcut-key">Ctrl+Enter</span>
            <span class="shortcut-desc">Run cell</span>
          </div>
          <div class="shortcut-item">
            <span class="shortcut-key">Alt+Enter</span>
            <span class="shortcut-desc">Run & insert</span>
          </div>
          <div class="shortcut-item">
            <span class="shortcut-key">Ctrl+S</span>
            <span class="shortcut-desc">Save notebook</span>
          </div>
          <div class="shortcut-item">
            <span class="shortcut-key">Ctrl+K</span>
            <span class="shortcut-desc">Command palette</span>
          </div>
          <div class="shortcut-item">
            <span class="shortcut-key">Ctrl+/</span>
            <span class="shortcut-desc">AI chat</span>
          </div>
          <div class="shortcut-item">
            <span class="shortcut-key">Ctrl+Shift+D</span>
            <span class="shortcut-desc">Storage panel</span>
          </div>
          <div class="shortcut-item">
            <span class="shortcut-key">Ctrl+Z</span>
            <span class="shortcut-desc">Undo cell delete</span>
          </div>
        </div>
      </div>
    {/if}
  {:else if activeTab === 'storage'}
    <div class="storage-tab">
      <div class="storage-total">
        <span title={$syncRoot ?? undefined}>
          {#if $syncStatus === 'connected'}{shortRoot}{:else}Kept in this browser{/if}
        </span>
        <span class="storage-total-size">{formatBytes(notebooksSize + datasetsSize)}</span>
      </div>

      <div class="storage-scroll">
      {#if !$libraryPersistent}
        <div class="storage-warning" title="A private window, or another tab holding an older version of the database.">
          This browser refused persistent storage: notebooks last until you close the tab.
          Export what you want to keep.
        </div>
      {/if}

      <!-- One list when there is one place. A notebook is one thing and where
           it lives is something it has, so the row says it — but with a folder
           open there are two places, and a heading each is what tells the
           notebooks of this folder from what a previous one left behind. -->
      {#if rows.length >= FILTER_FROM}
        <input
          class="storage-filter"
          type="search"
          placeholder="Filter notebooks…"
          aria-label="Filter notebooks"
          bind:value={notebookFilter}
        />
      {/if}

      {#if rows.length === 0 && $syncStatus !== 'connected'}
        <div class="storage-section"><div class="empty-vars">No notebooks stored yet.</div></div>
      {:else if shownRows.length === 0 && notebookFilter.trim()}
        <div class="storage-section"><div class="empty-vars">No notebook matches “{notebookFilter}”.</div></div>
      {:else if $syncStatus === 'connected'}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="storage-section"
          class:drop-target={dropInFolder}
          ondragover={(e) => { e.preventDefault(); dropInFolder = true; }}
          ondragleave={() => (dropInFolder = false)}
          ondrop={(e) => { e.preventDefault(); dropInFolder = false; void dropIntoFolder(e.dataTransfer?.files ?? null); }}
        >
          <div class="storage-section-head">
            <h4 class="section-title">In this folder ({inFolder.length + $syncData.length})</h4>
            <span class="storage-section-size">{formatBytes(folderSize)}</span>
          </div>
          {#if inFolder.length + $syncData.length === 0}
            <div class="empty-vars">Nothing here yet. Drop a file, or put one in the folder.</div>
          {:else}
            <div class="dataset-list">
              {#each inFolder as row (row.id)}
                {@render notebookRow(row)}
              {/each}
              {#each dataTree.here as file (file.path)}
                {@render dataRow(file, file.path)}
              {/each}
              {#each dataTree.folders as [dir, held] (dir)}
                <div class="folder-group">
                  <button
                    class="folder-row"
                    aria-expanded={openFolders.has(dir)}
                    onclick={() => openFolders.has(dir) ? openFolders.delete(dir) : openFolders.add(dir)}
                  >
                    <svg class="folder-chevron" class:open={openFolders.has(dir)} width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                      <path d="M3.5 2l3 3-3 3"/>
                    </svg>
                    <span class="folder-name">{dir}/</span>
                    <span class="folder-count">
                      {held.files.length} file{held.files.length === 1 ? '' : 's'} · {formatBytes(held.size)}
                    </span>
                  </button>
                  {#if openFolders.has(dir)}
                    {#each held.files as file (file.path)}
                      {@render dataRow(file, file.path.slice(dir.length + 1))}
                    {/each}
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>

        {#if inBrowser.length > 0}
          <div class="storage-section">
            <div class="storage-section-head">
              <h4 class="section-title">In this browser ({inBrowser.length})</h4>
              <span class="storage-section-size">{formatBytes(browserSize)}</span>
            </div>
            <p class="storage-note">
              Held here, with no file in this folder: opened from a link, made here, or left by
              a folder opened before.
            </p>
            <div class="dataset-list">
              {#each inBrowser as row (row.id)}
                {@render notebookRow(row)}
              {/each}
            </div>
          </div>
        {/if}
      {:else}
        <div class="storage-section">
          <div class="storage-section-head">
            <h4 class="section-title">Notebooks ({rows.length})</h4>
            <span class="storage-section-size">{formatBytes(notebooksSize)}</span>
          </div>
          <div class="dataset-list">
            {#each shownRows as row (row.id)}
              {@render notebookRow(row)}
            {/each}
          </div>
        </div>
      {/if}

      {#if virtualFolder && virtualFiles.length > 0}
        <!-- Files this notebook's cells wrote with save(), kept in the browser
             because nothing is serving the notebook from a folder. -->
        <div class="storage-section">
          <div class="storage-section-head">
            <h4 class="section-title">This notebook's files ({virtualFiles.length})</h4>
            <span class="storage-section-size">{formatBytes(virtualFiles.reduce((n, f) => n + f.size, 0))}</span>
          </div>
          <div class="dataset-list">
            {#each virtualFiles as file (file.name)}
              <div class="dataset-item">
                <div class="notebook-main">
                  <div class="dataset-name">{file.name}</div>
                  <div class="dataset-meta">in this browser · {formatBytes(file.size)}</div>
                </div>
                <div class="dataset-actions">
                  <button
                    class="ds-btn"
                    title="Download this file"
                    aria-label="Download {file.name}"
                    onclick={async () => {
                      const handle = virtualFolder && (await readVirtualFile(virtualFolder, file.name));
                      if (!handle) return;
                      downloadBytes(new Uint8Array(await handle.arrayBuffer()), file.name.split('/').pop() ?? file.name, handle.type || 'application/octet-stream');
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                    </svg>
                  </button>
                  <button
                    class="ds-btn ds-danger"
                    title="Delete this file"
                    aria-label="Delete {file.name}"
                    onclick={async () => {
                      if (!virtualFolder) return;
                      // Written by a cell into this browser, with no folder to
                      // hold a copy: gone means gone.
                      if (!confirm(`Delete “${file.name}”? It is only in this browser, and this cannot be undone.`)) return;
                      await deleteVirtualFile(virtualFolder, file.name);
                      await refreshVirtualFiles();
                      toast(`Deleted ${file.name}`, 'info');
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                    </svg>
                  </button>
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Datasets: files read in the browser and kept in IndexedDB. With a
           folder open the folder is the better place for data, so the drop
           target gives way to a line — but the way in stays, because a notebook
           meant to run away from this folder needs its data carried in the
           browser. -->
      <div class="storage-section">
        <div class="storage-section-head">
          <h4 class="section-title">Datasets ({$datasets.length})</h4>
          <span class="storage-section-size">{formatBytes(datasetsSize)}</span>
        </div>

        <!-- With a folder there is a better place for a file than this
             browser: the folder. The drop target is for the case where there
             is none, and saying so beats leaving it there to be wondered at. -->
        <input
          bind:this={fileInput}
          type="file"
          multiple
          accept=".csv,.tsv,.json,.ndjson,.txt"
          class="hidden-input"
          onchange={(e) => { ingest((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = ''; }}
        />
        {#if $syncStatus === 'connected'}
          <p class="storage-note" title="A file in the folder is read with FileAttachment. One kept here travels with the notebook, wherever it runs.">
            Drop a file above to put it in the folder. Kept here instead,
            <code>data("name")</code> finds it anywhere.
            <button class="backup-link" onclick={() => fileInput?.click()}>Add a file…</button>
          </p>
        {:else}
        <div
          class="dropzone"
          class:active={dragActive}
          role="button"
          tabindex="0"
          ondragover={onDragOver}
          ondragleave={onDragLeave}
          ondrop={onDrop}
          onclick={() => fileInput?.click()}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput?.click(); } }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
          </svg>
          <p class="dropzone-text">Drop CSV, TSV or JSON here</p>
          <p class="dropzone-hint">or click to browse. Stays in your browser.</p>
        </div>
        {/if}
        {#if $datasets.length === 0 && $syncStatus !== 'connected'}
          <div class="empty-vars">No data yet. Drop a file, then read it in a cell with <code>await data("name")</code>.</div>
        {:else if $datasets.length === 0}
          <!-- The line above already says where data goes and how to add some. -->
        {:else}
          <div class="dataset-list">
            {#each $datasets as ds (ds.name)}
              <div class="dataset-item">
                <div class="dataset-main">
                  <div class="dataset-name" title={ds.name}>{ds.name}</div>
                  <div class="dataset-meta">{formatBytes(ds.size)}</div>
                </div>
                <div class="dataset-actions">
                  <button class="ds-btn" title="Copy usage snippet" onclick={() => copyUsage(ds.name)} aria-label="Copy snippet">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                  </button>
                  <button class="ds-btn ds-danger" title="Remove" onclick={() => removeDataset(ds.name)} aria-label="Remove dataset">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                    </svg>
                  </button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>


      <!-- Housekeeping: what to do about all of the above, below it. -->
      <!-- Backup. Without the companion, this browser's storage is the only
           copy of these notebooks, and the browser may clear it; the archive is
           the copy elsewhere. A status that is always here, and a nudge only
           when there is something to lose. -->
      <div class="backup-box" class:due={$backupState.due}>
        <div class="backup-head">
          <span class="backup-title">{$backupState.due ? 'Back up your work' : 'Backup'}</span>
          <span class="backup-age">last: {backupAge($lastBackupAt)}</span>
        </div>
        <!-- Short on purpose: the reader is deciding whether to press a button,
             not reading about storage. What the archive is for lives in the
             tooltips and in the README. -->
        <p class="backup-note" title={$syncStatus === 'connected'
          ? 'The notebooks here are files in the folder as well, so git already keeps those. This is for what exists nowhere else.'
          : 'This browser is the only place these live.'}>
          {#if $syncStatus === 'connected'}
            A <code>.zip</code> of what only this browser holds: its library, datasets, saved files.
          {:else}
            A <code>.zip</code> of everything here: notebooks, datasets, saved files.
          {/if}
        </p>
        {#if $backupState.pending > 0}
          <p class="backup-note">{$backupState.pending} changed since the last one.</p>
        {/if}
        {#if $storagePersisted === false}
          <p class="backup-note">
            The browser may clear this storage when space runs low.
            <button class="backup-link" onclick={async () => {
              const granted = await requestStoragePersistence();
              toast(granted ? 'The browser will keep this storage.' : 'The browser declined; a backup is the safe copy.', 'info');
            }}>Ask it not to</button>
          </p>
        {/if}
        <label class="backup-choice" title="Everything cells loaded from the network, so the archive runs with no network elsewhere.">
          <input type="checkbox" bind:checked={backupLibraries} />
          Include the libraries (much larger)
        </label>
        <div class="backup-actions">
          <button class="backup-btn primary" onclick={() => onbackup?.({ includeLibraries: backupLibraries })}>Back up…</button>
          <button class="backup-btn" onclick={() => onrestore?.()}>Restore…</button>
          {#if $backupState.due}
            <button class="backup-link" onclick={() => snoozeBackupReminder(3)}>Remind me later</button>
          {/if}
        </div>
      </div>

      {#if $offlineReady}
        <!-- Libraries and soundfonts a cell loaded from the network, kept so the
             notebook still runs without one. -->
        <div class="backup-box">
          <div class="backup-head">
            <span class="backup-title">Offline</span>
            <span class="backup-age">{$online ? 'online' : 'no network'}</span>
          </div>
          <p class="backup-note" title="Kept as cells load them, so the app opens and its notebooks run with no network, as far as they have already loaded.">
            {#if $cacheStats}
              {$cacheStats.app} app {$cacheStats.app === 1 ? 'file' : 'files'},
              {$cacheStats.remote} {$cacheStats.remote === 1 ? 'library' : 'libraries'} kept.
            {:else}
              Libraries are kept as cells load them.
            {/if}
          </p>
          {#if $lockFolder !== null}
            <p class="backup-note" title={$currentLock?.frozen
              ? 'Anything not in the lock is refused until you unfreeze.'
              : 'Freezing pins each library to the exact bytes it loaded. Only what has loaded can be pinned, so run the notebooks first.'}>
              {#if $currentLock?.frozen}
                <strong>Frozen</strong> to {Object.keys($currentLock.modules).length}
                {Object.keys($currentLock.modules).length === 1 ? 'file' : 'files'}
                ({$lockFolder ? `${$lockFolder}/` : ''}tangent.lock).
              {:else}
                Not frozen: follows what its imports resolve to today. Run All, then freeze.
              {/if}
            </p>
          {/if}
          <div class="backup-actions">
            {#if $lockFolder !== null}
              {#if $currentLock?.frozen}
                <button
                  class="backup-btn"
                  onclick={async () => {
                    try {
                      await unfreezeEnvironment();
                      toast('Unfrozen. This folder follows the network again.', 'info');
                    } catch (error: any) {
                      toast(error?.message ?? 'Could not unfreeze.', 'error');
                    }
                  }}
                >Unfreeze</button>
              {:else}
                <button
                  class="backup-btn primary"
                  onclick={async () => {
                    try {
                      const { count } = await freezeEnvironment();
                      toast(`Frozen: ${count} ${count === 1 ? 'file' : 'files'} pinned in tangent.lock.`, 'info');
                    } catch (error: any) {
                      toast(error?.message ?? 'Could not freeze.', 'error');
                    }
                  }}
                >Freeze…</button>
              {/if}
            {/if}
            <button
              class="backup-btn"
              onclick={async () => {
                const cleared = await clearRemoteCache();
                toast(cleared ? 'Cleared what was cached from the network.' : 'Nothing to clear.', 'info');
              }}
            >Clear downloads</button>
          </div>
          {#if $currentLock?.frozen}
            <p class="backup-note lock-list">
              {Object.keys($currentLock.modules).slice(0, 4).map(shortName).join(', ')}{Object.keys($currentLock.modules).length > 4 ? '…' : ''}
            </p>
          {/if}
        </div>
      {/if}

      <div class="storage-section">
        <h4 class="section-title">Other browser data</h4>
        <p class="storage-note">Chat history, AI key and preferences, in localStorage.</p>
        <button class="storage-clear" onclick={() => onclearBrowserData?.()}>Clear…</button>
      </div>
      </div>
    </div>

  {:else if activeTab === 'console'}
    <div class="console-tab">
      <Console />
    </div>
  {:else if activeTab === 'chat'}
    <div class="console-tab">
      <ChatSidebar embedded {oninsertCode} {oneditCell} />
    </div>
  {:else}
    <div class="sidebar-content">
      <div class="variables-header">
        <h4 class="section-title">Scope Variables</h4>
        <button class="refresh-btn" onclick={refreshVariables} title="Refresh">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M1 7a6 6 0 0111.2-3M13 7a6 6 0 01-11.2 3"/>
            <path d="M1 2v3h3M13 12v-3h-3"/>
          </svg>
        </button>
      </div>
      {#if varEntries.length === 0}
        <div class="empty-vars">No variables defined yet. Run a cell to see variables here.</div>
      {:else}
        <div class="variables-list">
          {#each varEntries as v (v.name)}
            <div class="var-item">
              <div class="var-name">{v.name}</div>
              <div class="var-meta">
                <span class="var-type">{v.type}</span>
                <span class="var-value" title={v.repr}>{v.repr}</span>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .right-sidebar { height: 100%; display: flex; flex-direction: column; }

  .sidebar-content { padding: 1rem; overflow-y: auto; flex: 1; }

  /* Console owns its own scrolling and pinned prompt, so it fills the panel
     without the sidebar-content padding. */
  .console-tab { flex: 1; min-height: 0; display: flex; }

  .info-section { margin-bottom: 0.75rem; }

  .info-label {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-bottom: 0.25rem;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .info-value { font-size: 0.875rem; color: var(--heading); font-weight: 500; }

  .divider { height: 1px; background-color: var(--border); margin: 1.1rem 0; }

  .shortcuts-section { margin-top: 0.5rem; }

  .settings-section { margin-top: 0.5rem; }

  .setting-label {
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--text-muted);
    margin-bottom: 0.4rem;
  }

  .setting-option {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.3rem 0;
    font-size: 0.78rem;
    line-height: 1.45;
    color: var(--text-muted);
    cursor: pointer;
  }

  .setting-option input { margin-top: 0.15rem; flex-shrink: 0; }
  .setting-option strong { color: var(--text); font-weight: 600; }

  .width-choice {
    display: flex;
    gap: 0.3rem;
    margin-bottom: 0.4rem;
  }

  .width-btn {
    flex: 1;
    padding: 0.3rem 0.4rem;
    background: transparent;
    color: var(--text-muted);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-input);
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .width-btn:hover { background: var(--surface-hover); color: var(--text); }

  .width-btn.active {
    background: var(--accent-weak-bg);
    border-color: var(--accent);
    color: var(--heading);
  }

  .setting-hint {
    font-size: 0.72rem;
    color: var(--text-muted);
    margin: 0.4rem 0 0;
    font-style: italic;
  }

  .section-title { font-size: 0.85rem; font-weight: 600; color: var(--heading); margin: 0 0 0.75rem 0; }

  .shortcut-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .shortcut-key {
    font-size: 0.72rem;
    color: var(--text-muted);
    background-color: var(--surface-2);
    padding: 0.2rem 0.45rem;
    border-radius: var(--radius-input);
    border: 1px solid var(--border);
    font-family: var(--font-mono);
  }

  .shortcut-desc { font-size: 0.8125rem; color: var(--text); }

  .variables-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.75rem;
  }

  .refresh-btn {
    background: transparent;
    border: none;
    padding: 0.25rem;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: var(--radius-pill);
    display: flex;
    align-items: center;
    transition: all 0.15s ease;
  }

  .refresh-btn:hover { background-color: var(--surface-hover); color: var(--heading); }

  .empty-vars { font-size: 0.8rem; color: var(--text-muted); padding: 1rem 0; text-align: center; }
  .empty-vars code {
    font-family: var(--font-mono);
    font-size: 0.92em;
    color: var(--accent);
  }

  /* Storage panel: two lists that happen to share a home, so they are visibly
     two sections rather than one merged pile. */
  /* The tab scrolls its own body rather than riding .sidebar-content, so the
     running total stays put while a long library scrolls under it. Same shape
     as .console-tab, for the same reason. */
  .storage-tab {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .storage-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 0 1rem 1rem;
  }

  .storage-total {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    flex: 0 0 auto;
    font-size: 0.8rem;
    color: var(--text-muted);
    padding: 1rem 1rem 0.6rem;
    border-bottom: 1px solid var(--border);
  }

  .storage-total-size { font-family: var(--font-mono); color: var(--text); }

  .backup-box {
    margin-top: 0.75rem;
    padding: 0.55rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-input);
    background: var(--surface);
  }

  /* Due: the warning colours, the same ones the restart button uses when it
     is waiting for a decision. */
  .backup-box.due {
    background: var(--warn-bg);
    border-color: var(--warn-border);
  }

  .backup-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .backup-title {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--heading);
  }

  .backup-box.due .backup-title { color: var(--warn-fg); }

  .backup-age {
    font-size: 0.72rem;
    color: var(--text-faint);
  }

  .lock-list {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    color: var(--text-faint);
    overflow-wrap: anywhere;
  }

  .backup-note {
    margin: 0.35rem 0 0;
    font-size: 0.74rem;
    line-height: 1.4;
    color: var(--text-muted);
  }

  .backup-choice {
    display: flex;
    align-items: flex-start;
    gap: 0.35rem;
    margin-top: 0.45rem;
    font-size: 0.72rem;
    line-height: 1.35;
    color: var(--text-muted);
    cursor: pointer;
  }

  .backup-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-top: 0.5rem;
  }

  .backup-btn {
    padding: 0.28rem 0.65rem;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text);
    background: transparent;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill);
    cursor: pointer;
  }

  .backup-btn:hover { background: var(--surface-hover); color: var(--heading); }

  .backup-btn.primary {
    background: var(--accent-solid);
    border-color: var(--accent-solid);
    color: var(--accent-on-solid);
  }

  .backup-link {
    padding: 0;
    font-size: 0.74rem;
    color: var(--accent);
    background: none;
    border: none;
    text-decoration: underline;
    cursor: pointer;
  }

  .storage-warning {
    margin-top: 0.75rem;
    padding: 0.5rem 0.6rem;
    font-size: 0.75rem;
    line-height: 1.4;
    color: var(--warn-fg);
    background-color: var(--warn-bg);
    border: 1px solid var(--warn-border);
    border-radius: var(--radius-input);
  }

  .storage-section { margin-top: 1.25rem; }

  /* Sticky so you can always tell which list you are scrolling through once
     either one is longer than the panel. The background has to be opaque and
     bleed into the scroller's padding, or rows show through beside it. */
  .storage-section-head {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin: 0 -1rem;
    padding: 0.4rem 1rem;
    background-color: var(--surface);
  }

  /* The head already carries the section's bottom spacing. */
  .storage-section-head .section-title { margin-bottom: 0; }

  .storage-section-size {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--text-faint);
  }

  /* A notebook row is a target, not a label: the whole row opens it. */
  .notebook-main {
    flex: 1 1 auto;
    min-width: 0;
    display: block;
    text-align: left;
    padding: 0;
    background: none;
    border: none;
    cursor: pointer;
    font: inherit;
    color: inherit;
  }

  .dataset-item.current { border-color: var(--accent); }

  .storage-filter {
    width: 100%;
    margin-top: 0.5rem;
    padding: 0.35rem 0.5rem;
    font-size: 0.78rem;
    font-family: inherit;
    color: var(--text);
    background-color: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-input);
  }

  .storage-filter:focus {
    outline: none;
    border-color: var(--accent);
  }

  .storage-note {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin: 0 0 0.5rem 0;
    line-height: 1.4;
  }

  .storage-clear {
    font-size: 0.75rem;
    padding: 0.3rem 0.6rem;
    background-color: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius-input);
    cursor: pointer;
  }

  .storage-clear:hover {
    background-color: var(--surface-hover);
    border-color: var(--border-strong);
  }

  .dropzone {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    padding: 1.5rem 1rem;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-card);
    color: var(--text-muted);
    cursor: pointer;
    text-align: center;
    transition: border-color 0.15s ease, color 0.15s ease, background-color 0.15s ease;
  }

  .dropzone:hover { color: var(--text-muted); border-color: var(--accent); }

  .dropzone.active {
    border-color: var(--accent);
    color: var(--accent);
    background-color: var(--surface-hover);
  }

  .dropzone-text { font-size: 0.82rem; font-weight: 500; color: var(--text); margin: 0.25rem 0 0; }
  .dropzone-hint { font-size: 0.72rem; margin: 0; }

  .hidden-input { display: none; }

  /* A sub-directory: one line that says how much it holds, and opens. */
  .folder-group { display: contents; }

  /* A file on its way in. */
  .drop-target {
    outline: 2px dashed var(--accent-weak-border);
    outline-offset: 3px;
    border-radius: var(--radius-input);
  }

  .folder-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
    padding: 0.4rem 0.55rem;
    background: transparent;
    border: 1px dashed var(--border);
    border-radius: var(--radius-input);
    font-family: var(--font-sans);
    font-size: 0.78rem;
    color: var(--text-muted);
    cursor: pointer;
    text-align: left;
  }

  .folder-row:hover { background-color: var(--surface-hover); color: var(--heading); }

  .folder-chevron { flex-shrink: 0; transition: transform 0.15s ease; }
  .folder-chevron.open { transform: rotate(90deg); }

  .folder-name {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .folder-count { margin-left: auto; flex-shrink: 0; color: var(--text-faint); font-size: 0.7rem; }

  .dataset-list { display: flex; flex-direction: column; gap: 0.4rem; margin-top: 1rem; }

  .dataset-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.5rem;
    background-color: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-input);
  }

  .dataset-main { min-width: 0; }

  .dataset-name {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dataset-meta {
    font-size: 0.68rem;
    color: var(--text-faint);
    margin-top: 0.1rem;
    /* Four facts on one line in a panel draggable down to 240px: let it wrap
       rather than push the delete button off the row. */
    overflow-wrap: anywhere;
  }

  .dataset-actions { display: flex; gap: 0.15rem; flex-shrink: 0; }

  .ds-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.3rem;
    background: transparent;
    border: none;
    color: var(--text-faint);
    cursor: pointer;
    border-radius: var(--radius-input);
    transition: background-color 0.12s ease, color 0.12s ease;
  }

  .ds-btn:hover { background-color: var(--surface-hover); color: var(--heading); }
  .ds-danger:hover { color: var(--danger-fg); background-color: var(--danger-bg); }

  .variables-list { display: flex; flex-direction: column; gap: 0.5rem; }

  .var-item {
    padding: 0.5rem;
    background-color: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-input);
  }

  .var-name {
    font-family: var(--font-mono);
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--accent);
    margin-bottom: 0.2rem;
  }

  .var-meta { display: flex; gap: 0.5rem; align-items: baseline; }

  .var-type {
    font-size: 0.65rem;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    flex-shrink: 0;
  }

  .var-value {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
