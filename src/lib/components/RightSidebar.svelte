<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { currentNotebook } from '../stores/notebook';

  interface Props {
    onclose?: () => void;
  }

  let { onclose }: Props = $props();

  let activeTab: 'info' | 'variables' = $state('info');
  let variables: Record<string, any> = $state({});
  let refreshTimer: number | null = null;

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
    border-bottom: 1px solid #e8e8e8;
  }

  .tab-bar { display: flex; gap: 0; }

  .tab-btn {
    background: transparent;
    border: none;
    padding: 0.4rem 0.65rem;
    font-size: 0.8rem;
    font-weight: 500;
    color: #6b6b6b;
    cursor: pointer;
    border-radius: 4px;
    transition: all 0.15s ease;
  }

  .tab-btn:hover { color: #1a1a1a; background-color: #f5f5f5; }
  .tab-btn.active { color: #1a1a1a; background-color: #e8e8e8; }

  .close-btn {
    background: transparent;
    border: none;
    padding: 0.25rem;
    color: #6b6b6b;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    transition: all 0.15s ease;
  }

  .close-btn:hover { background-color: #f0f0f0; color: #1a1a1a; }

  .sidebar-content { padding: 1rem; overflow-y: auto; flex: 1; }

  .info-section { margin-bottom: 0.75rem; }

  .info-label {
    font-size: 0.75rem;
    color: #6b6b6b;
    margin-bottom: 0.25rem;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .info-value { font-size: 0.875rem; color: #1a1a1a; font-weight: 500; }

  .divider { height: 1px; background-color: #e8e8e8; margin: 1.1rem 0; }

  .shortcuts-section { margin-top: 0.5rem; }

  .section-title { font-size: 0.85rem; font-weight: 600; color: #1a1a1a; margin: 0 0 0.75rem 0; }

  .shortcut-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .shortcut-key {
    font-size: 0.72rem;
    color: #6b6b6b;
    background-color: #f7f7f7;
    padding: 0.2rem 0.45rem;
    border-radius: 4px;
    border: 1px solid #e0e0e0;
    font-family: monospace;
  }

  .shortcut-desc { font-size: 0.8125rem; color: #4a4a4a; }

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
    color: #6b6b6b;
    cursor: pointer;
    border-radius: 4px;
    display: flex;
    align-items: center;
    transition: all 0.15s ease;
  }

  .refresh-btn:hover { background-color: #f0f0f0; color: #1a1a1a; }

  .empty-vars { font-size: 0.8rem; color: #9ca3af; padding: 1rem 0; text-align: center; }

  .variables-list { display: flex; flex-direction: column; gap: 0.5rem; }

  .var-item {
    padding: 0.5rem;
    background-color: #f9f9f9;
    border: 1px solid #e8e8e8;
    border-radius: 5px;
  }

  .var-name {
    font-family: 'Fira Code', monospace;
    font-size: 0.8rem;
    font-weight: 600;
    color: #2563eb;
    margin-bottom: 0.2rem;
  }

  .var-meta { display: flex; gap: 0.5rem; align-items: baseline; }

  .var-type {
    font-size: 0.65rem;
    color: #9ca3af;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    flex-shrink: 0;
  }

  .var-value {
    font-family: 'Fira Code', monospace;
    font-size: 0.75rem;
    color: #4a4a4a;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
