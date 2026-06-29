<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { currentNotebook } from '../stores/notebook';
  import { datasets, refreshDatasets, addFiles, deleteDataset, formatBytes } from '../utils/dataStore';
  import { toast } from '../utils/toast';

  interface Props {
    onclose?: () => void;
  }

  let { onclose }: Props = $props();

  let activeTab: 'info' | 'variables' | 'data' = $state('info');
  let variables: Record<string, any> = $state({});
  let refreshTimer: number | null = null;

  // Data panel: drag-and-drop file cache.
  let dragActive = $state(false);
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
    await deleteDataset(name);
    toast(`Removed ${name}`, 'info');
  }

  function copyUsage(name: string) {
    const snippet = `const rows = await data(${JSON.stringify(name)})`;
    navigator.clipboard?.writeText(snippet);
    toast('Copied snippet to clipboard', 'info');
  }

  function refreshVariables() {
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
    refreshDatasets();
    refreshTimer = window.setInterval(refreshVariables, 2000);
  });

  onDestroy(() => {
    if (refreshTimer) clearInterval(refreshTimer);
  });

  let varEntries = $derived(Object.entries(variables));
</script>

<div class="right-sidebar">
  <div class="sidebar-header">
    <div class="tab-bar">
      <button class="tab-btn" class:active={activeTab === 'info'} onclick={() => activeTab = 'info'}>Info</button>
      <button class="tab-btn" class:active={activeTab === 'variables'} onclick={() => { activeTab = 'variables'; refreshVariables(); }}>Variables</button>
      <button class="tab-btn" class:active={activeTab === 'data'} onclick={() => { activeTab = 'data'; refreshDatasets(); }}>Data</button>
    </div>
    <button class="close-btn" onclick={() => onclose?.()} aria-label="Close sidebar" title="Close">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="4" y1="4" x2="12" y2="12"/>
        <line x1="12" y1="4" x2="4" y2="12"/>
      </svg>
    </button>
  </div>

  {#if activeTab === 'info'}
    {#if $currentNotebook}
      <div class="sidebar-content">
        <div class="info-section">
          <div class="info-label">Cells</div>
          <div class="info-value">{$currentNotebook.cells.length}</div>
        </div>

        <div class="info-section">
          <div class="info-label">Created</div>
          <div class="info-value">{new Date($currentNotebook.createdAt).toLocaleDateString()}</div>
        </div>

        <div class="info-section">
          <div class="info-label">Last Modified</div>
          <div class="info-value">{new Date($currentNotebook.updatedAt).toLocaleString()}</div>
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
            <span class="shortcut-key">Ctrl+Z</span>
            <span class="shortcut-desc">Undo cell delete</span>
          </div>
        </div>
      </div>
    {/if}
  {:else if activeTab === 'data'}
    <div class="sidebar-content">
      <!-- Files are read in the browser and cached in IndexedDB. Nothing is
           uploaded or served publicly. -->
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
      <input
        bind:this={fileInput}
        type="file"
        multiple
        accept=".csv,.tsv,.json,.ndjson,.txt"
        class="hidden-input"
        onchange={(e) => { ingest((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = ''; }}
      />

      {#if $datasets.length === 0}
        <div class="empty-vars">No data yet. Drop a file, then read it in a cell with <code>await data("name")</code>.</div>
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
          {#each varEntries as [name, value]}
            <div class="var-item">
              <div class="var-name">{name}</div>
              <div class="var-meta">
                <span class="var-type">{getVarType(value)}</span>
                <span class="var-value" title={formatVarValue(value)}>{formatVarValue(value)}</span>
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

  .sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border);
  }

  .tab-bar { display: flex; gap: 0; }

  .tab-btn {
    background: transparent;
    border: none;
    padding: 0.4rem 0.65rem;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: var(--radius-pill);
    transition: all 0.15s ease;
  }

  .tab-btn:hover { color: var(--heading); background-color: var(--surface-hover); }
  .tab-btn.active { color: var(--heading); background-color: var(--surface-2); }

  .close-btn {
    background: transparent;
    border: none;
    padding: 0.25rem;
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-pill);
    transition: all 0.15s ease;
  }

  .close-btn:hover { background-color: var(--surface-hover); color: var(--heading); }

  .sidebar-content { padding: 1rem; overflow-y: auto; flex: 1; }

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

  .empty-vars { font-size: 0.8rem; color: var(--text-faint); padding: 1rem 0; text-align: center; }
  .empty-vars code {
    font-family: var(--font-mono);
    font-size: 0.92em;
    color: var(--accent);
  }

  /* Data panel */
  .dropzone {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    padding: 1.5rem 1rem;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-card);
    color: var(--text-faint);
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

  .dataset-meta { font-size: 0.68rem; color: var(--text-faint); margin-top: 0.1rem; }

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
