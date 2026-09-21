<script lang="ts">
  /**
   * The File menu: every action on the document itself, in one known place.
   *
   * These used to be separate header buttons — New, Import, Export — while Save,
   * the one action that matters most, had no button at all and existed only as
   * Ctrl+S. With Save As there are six document actions, and six buttons would
   * take the width the notebook tabs share this row with. A menu is also where
   * people look for them, and listing each shortcut beside its action is how the
   * shortcuts get learned.
   *
   * Save names what it will do — write the linked file, or download — because
   * the same keystroke does either, depending on where the notebook lives.
   */
  import { tick } from 'svelte';

  interface Props {
    /** e.g. "Save to siuraa.js" or "Download .js". */
    saveLabel: string;
    canClose?: boolean;
    onnew?: () => void;
    onopen?: () => void;
    onsave?: () => void;
    onsaveas?: () => void;
    onexport?: () => void;
    onclose?: () => void;
  }

  let {
    saveLabel,
    canClose = true,
    onnew,
    onopen,
    onsave,
    onsaveas,
    onexport,
    onclose,
  }: Props = $props();

  let open = $state(false);
  let root: HTMLDivElement | null = $state(null);
  let trigger: HTMLButtonElement | null = $state(null);

  const mod =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd+' : 'Ctrl+';

  function items(): HTMLButtonElement[] {
    return root ? Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')) : [];
  }

  async function show() {
    open = true;
    await tick();
    items()[0]?.focus();
  }

  function hide(returnFocus = true) {
    open = false;
    if (returnFocus) trigger?.focus();
  }

  function run(action?: () => void) {
    hide(false);
    action?.();
  }

  // Outside click closes; Escape closes and hands focus back to the button.
  $effect(() => {
    if (!open) return;
    const onPointer = (event: Event) => {
      if (root && !root.contains(event.target as Node)) hide(false);
    };
    window.addEventListener('pointerdown', onPointer, true);
    return () => window.removeEventListener('pointerdown', onPointer, true);
  });

  function onMenuKeydown(event: KeyboardEvent) {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      hide();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      list[(index + 1) % list.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      list[(index - 1 + list.length) % list.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      list[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      list[list.length - 1]?.focus();
    } else if (event.key === 'Tab') {
      hide(false);
    }
  }
</script>

<div class="file-menu" bind:this={root}>
  <button
    bind:this={trigger}
    class="file-trigger"
    class:active={open}
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={() => (open ? hide() : show())}
    onkeydown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); show(); } }}
    title="File"
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>
      <path d="M14 3v5h5"/>
    </svg>
    <span class="btn-label">File</span>
    <svg class="chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
      <path d="M2 3.5l3 3 3-3"/>
    </svg>
  </button>

  {#if open}
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div class="file-popup" role="menu" aria-label="File" tabindex="-1" onkeydown={onMenuKeydown}>
      <button role="menuitem" class="file-item" onclick={() => run(onnew)}>
        <span>New notebook</span><kbd>{mod}N</kbd>
      </button>
      <button role="menuitem" class="file-item" onclick={() => run(onopen)}>
        <span>Open file…</span><kbd>{mod}O</kbd>
      </button>
      <div class="file-sep" role="separator"></div>
      <button role="menuitem" class="file-item" onclick={() => run(onsave)}>
        <span>{saveLabel}</span><kbd>{mod}S</kbd>
      </button>
      <button role="menuitem" class="file-item" onclick={() => run(onsaveas)}>
        <span>Save as…</span><kbd>{mod}Shift+S</kbd>
      </button>
      <button role="menuitem" class="file-item" onclick={() => run(onexport)}>
        <span>Export…</span>
      </button>
      <div class="file-sep" role="separator"></div>
      <button role="menuitem" class="file-item" disabled={!canClose} onclick={() => run(onclose)}>
        <span>Close tab</span>
      </button>
    </div>
  {/if}
</div>

<style>
  .file-menu {
    position: relative;
  }

  .file-trigger {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.4rem 0.6rem;
    background: transparent;
    border: none;
    border-radius: var(--radius-pill);
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .file-trigger:hover,
  .file-trigger.active {
    background-color: var(--surface-hover);
    color: var(--heading);
  }

  .chevron { opacity: 0.7; }

  .file-popup {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 60;
    min-width: 230px;
    display: flex;
    flex-direction: column;
    padding: 0.25rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-input);
    box-shadow: var(--shadow-md);
  }

  .file-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
    width: 100%;
    padding: 0.42rem 0.6rem;
    background: transparent;
    border: none;
    border-radius: var(--radius-input);
    font-size: 0.8rem;
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }

  .file-item:hover:not(:disabled),
  .file-item:focus-visible {
    background-color: var(--surface-hover);
    color: var(--heading);
    outline: none;
  }

  .file-item:disabled {
    opacity: 0.45;
    cursor: default;
  }

  /* The label can be a file name; it gets the room, the shortcut keeps its. */
  .file-item span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-item kbd {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 0.68rem;
    color: var(--text-faint);
  }

  .file-sep {
    height: 1px;
    background: var(--border);
    margin: 0.25rem 0.3rem;
  }

  @media (max-width: 640px) {
    .btn-label { display: none; }
    .chevron { display: none; }
  }
</style>
