<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    visible?: boolean;
    oncommand?: (detail: { id: string }) => void;
  }

  let { visible = $bindable(false), oncommand }: Props = $props();

  interface Command {
    id: string;
    name: string;
    description: string;
    shortcut?: string;
    icon?: string;
    action: () => void;
  }

  let searchQuery = $state('');
  let selectedIndex = $state(0);
  let inputElement: HTMLInputElement = $state(null as any);

  const commands: Command[] = [
    {
      id: 'new-notebook',
      name: 'New Notebook',
      description: 'Create a new empty notebook',
      shortcut: 'Ctrl+N',
      icon: 'file-plus',
      action: () => oncommand?.({ id: 'new-notebook' })
    },
    {
      id: 'open-notebook',
      name: 'Open Notebook',
      description: 'Open an existing notebook file',
      shortcut: 'Ctrl+O',
      icon: 'folder-open',
      action: () => oncommand?.({ id: 'open-notebook' })
    },
    {
      id: 'save-notebook',
      name: 'Save Notebook',
      description: 'Save the current notebook',
      shortcut: 'Ctrl+S',
      icon: 'save',
      action: () => oncommand?.({ id: 'save-notebook' })
    },
    {
      id: 'export-notebook',
      name: 'Export Notebook',
      description: 'Export notebook to various formats',
      icon: 'download',
      action: () => oncommand?.({ id: 'export-notebook' })
    },
    {
      id: 'run-all',
      name: 'Run All Cells',
      description: 'Execute all code cells in sequence',
      shortcut: 'Ctrl+Shift+Enter',
      icon: 'play-circle',
      action: () => oncommand?.({ id: 'run-all' })
    },
    {
      id: 'toggle-reactive',
      name: 'Toggle Reactive Mode',
      description: 'Auto re-run cells that depend on a cell when it runs',
      icon: 'zap',
      action: () => oncommand?.({ id: 'toggle-reactive' })
    },
    {
      id: 'toggle-output-position',
      name: 'Toggle Output Position',
      description: 'Show cell outputs above or below the code',
      icon: 'arrows-up-down',
      action: () => oncommand?.({ id: 'toggle-output-position' })
    },
    {
      id: 'add-code-cell',
      name: 'Add Code Cell',
      description: 'Insert a new code cell',
      shortcut: 'B',
      icon: 'code',
      action: () => oncommand?.({ id: 'add-code-cell' })
    },
    {
      id: 'add-markdown-cell',
      name: 'Add Markdown Cell',
      description: 'Insert a new markdown cell',
      shortcut: 'M',
      icon: 'type',
      action: () => oncommand?.({ id: 'add-markdown-cell' })
    },
    {
      id: 'toggle-chat',
      name: 'Toggle AI Chat',
      description: 'Open or close the AI assistant',
      shortcut: 'Ctrl+/',
      icon: 'message-square',
      action: () => oncommand?.({ id: 'toggle-chat' })
    },
    {
      id: 'open-data',
      name: 'Open Data Panel',
      description: 'Drag-and-drop CSV, TSV or JSON to use in cells',
      shortcut: 'Ctrl+Shift+D',
      icon: 'database',
      action: () => oncommand?.({ id: 'open-data' })
    },
    {
      id: 'clear-outputs',
      name: 'Clear All Outputs',
      description: 'Remove all cell outputs',
      icon: 'x-circle',
      action: () => oncommand?.({ id: 'clear-outputs' })
    },
    {
      id: 'keyboard-shortcuts',
      name: 'Keyboard Shortcuts',
      description: 'Show all keyboard shortcuts',
      shortcut: '?',
      icon: 'help-circle',
      action: () => oncommand?.({ id: 'keyboard-shortcuts' })
    }
  ];

  let filteredCommands = $derived(
    commands.filter(cmd =>
      cmd.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      cmd.description.toLowerCase().includes(searchQuery.toLowerCase())
    )
  );

  // Focus input when palette opens
  $effect(() => {
    if (visible && inputElement) {
      inputElement.focus();
      selectedIndex = 0;
    }
  });

  function handleKeydown(event: KeyboardEvent) {
    if (!visible) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        selectedIndex = Math.min(selectedIndex + 1, filteredCommands.length - 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        selectedIndex = Math.max(selectedIndex - 1, 0);
        break;
      case 'Enter':
        event.preventDefault();
        if (filteredCommands[selectedIndex]) {
          executeCommand(filteredCommands[selectedIndex]);
        }
        break;
      case 'Escape':
        event.preventDefault();
        close();
        break;
    }
  }

  function executeCommand(command: Command) {
    command.action();
    close();
  }

  function close() {
    visible = false;
    searchQuery = '';
    selectedIndex = 0;
  }

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      close();
    }
  }

  const iconPaths: Record<string, string> = {
    'file-plus': 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zM14 2v6h6M12 18v-6M9 15h6',
    'folder-open': 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z',
    'save': 'M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2zM17 21v-8H7v8M7 3v5h8',
    'download': 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
    'play-circle': 'M12 2a10 10 0 100 20 10 10 0 000-20zM10 8l6 4-6 4V8z',
    'code': 'M16 18l6-6-6-6M8 6l-6 6 6 6',
    'type': 'M4 7V4h16v3M9 20h6M12 4v16',
    'message-square': 'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z',
    'x-circle': 'M12 2a10 10 0 100 20 10 10 0 000-20zM15 9l-6 6M9 9l6 6',
    'help-circle': 'M12 2a10 10 0 100 20 10 10 0 000-20zM9.09 9a3 3 0 015.83 1c0 2-3 3-3 3M12 17h.01',
    'zap': 'M13 2L3 14h7l-1 8 10-12h-7l1-8z',
    'arrows-up-down': 'M7 4v16M7 4L4 7M7 4l3 3M17 20V4M17 20l-3-3M17 20l3-3',
    'database': 'M21 5c0 1.66-4.03 3-9 3S3 6.66 3 5s4.03-3 9-3 9 1.34 9 3zM3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3'
  };
</script>

<svelte:window onkeydown={handleKeydown} />

{#if visible}
  <div
    class="palette-backdrop"
    role="presentation"
    onclick={handleBackdropClick}
    onkeydown={(e) => { if (e.key === 'Escape') close(); }}
  >
    <div
      class="palette-container"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      tabindex="-1"
    >
      <div class="search-container">
        <svg class="search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/>
          <path d="m21 21-4.35-4.35"/>
        </svg>
        <input
          bind:this={inputElement}
          bind:value={searchQuery}
          type="text"
          placeholder="Type a command or search..."
          class="search-input"
        />
      </div>

      <div class="commands-container">
        {#if filteredCommands.length > 0}
          {#each filteredCommands as command, index (command.id)}
            <button
              class="command-item"
              class:selected={index === selectedIndex}
              onclick={() => executeCommand(command)}
              onmouseenter={() => selectedIndex = index}
            >
              <div class="command-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  {#if command.icon && iconPaths[command.icon]}
                    <path d={iconPaths[command.icon]}/>
                  {/if}
                </svg>
              </div>
              <div class="command-details">
                <div class="command-name">{command.name}</div>
                <div class="command-description">{command.description}</div>
              </div>
              {#if command.shortcut}
                <div class="command-shortcut">{command.shortcut}</div>
              {/if}
            </button>
          {/each}
        {:else}
          <div class="no-results">
            <p>No commands found</p>
          </div>
        {/if}
      </div>

      <div class="palette-footer">
        <span class="footer-hint">
          <kbd>↑↓</kbd> Navigate
          <kbd>↵</kbd> Execute
          <kbd>Esc</kbd> Close
        </span>
      </div>
    </div>
  </div>
{/if}

<style>
  .palette-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: var(--overlay);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 15vh;
    z-index: 1000;
    animation: fadeIn 0.15s ease;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .palette-container {
    width: 90%;
    max-width: 640px;
    background-color: var(--surface);
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
    animation: slideDown 0.2s ease;
  }

  @keyframes slideDown {
    from { opacity: 0; transform: translateY(-20px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .search-container {
    display: flex;
    align-items: center;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid var(--border);
    gap: 0.75rem;
  }

  .search-icon { color: var(--text-faint); flex-shrink: 0; }

  .search-input {
    flex: 1;
    border: none;
    outline: none;
    font-size: 1rem;
    color: var(--heading);
    background: transparent;
  }

  .search-input::placeholder { color: var(--text-faint); }

  .commands-container { max-height: 400px; overflow-y: auto; }

  .command-item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1.25rem;
    border: none;
    background: transparent;
    text-align: left;
    cursor: pointer;
    transition: background-color 0.1s;
  }

  .command-item:hover { background-color: var(--surface-hover); }
  .command-item.selected { background-color: var(--accent-weak-bg); }

  .command-icon {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-input);
    background-color: var(--surface-2);
    color: var(--text-muted);
  }

  .command-item.selected .command-icon { background-color: var(--accent-solid); color: var(--accent-on-solid); }

  .command-details { flex: 1; min-width: 0; }

  .command-name { font-size: 0.875rem; font-weight: 500; color: var(--heading); margin-bottom: 0.125rem; }
  .command-description { font-size: 0.75rem; color: var(--text-muted); }

  .command-shortcut {
    flex-shrink: 0;
    padding: 0.25rem 0.5rem;
    background-color: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-input);
    font-size: 0.75rem;
    font-family: var(--font-mono);
    color: var(--text-muted);
  }

  .no-results { padding: 3rem 1.5rem; text-align: center; color: var(--text-muted); }
  .no-results p { font-size: 0.875rem; margin: 0; }

  .palette-footer {
    padding: 0.75rem 1.25rem;
    border-top: 1px solid var(--border);
    background-color: var(--surface-2);
  }

  .footer-hint {
    display: flex;
    align-items: center;
    gap: 1rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  kbd {
    padding: 0.125rem 0.375rem;
    background-color: var(--surface-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-input);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--heading);
    margin-left: 0.25rem;
    margin-right: 0.25rem;
  }
</style>
