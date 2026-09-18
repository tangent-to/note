<script lang="ts">
  /**
   * Everything that runs this notebook, in one control.
   *
   * The header's right side had grown five pills of equal weight — Reactive,
   * a cell count, a file badge, Restart, Run All — with nothing to tell the eye
   * which of them was the action. Only one is frequent, so only one is a button:
   * Run All, in the accent colour. The rest live behind its chevron, where a
   * menu is what people already expect after the File menu on the left. All of
   * them are in the command palette too, so nothing is only here.
   *
   * While a run is going the primary half becomes Stop, in the same place: it is
   * the same question — what is the kernel doing — and an answer that moves is
   * an answer you have to look for.
   *
   * Restart asks no confirmation here. The header button did, because a single
   * stray click threw away every variable; opening a menu and choosing an item
   * is already the deliberate act that confirmation was standing in for.
   */
  import { tick } from 'svelte';

  interface Props {
    busy?: boolean;
    reactive?: boolean;
    /** Cells whose dependencies changed since they last ran. */
    stale?: number;
    onrunall?: () => void;
    onrunstale?: () => void;
    onstop?: () => void;
    onrestart?: () => void;
    onrestartrunall?: () => void;
    ontogglereactive?: () => void;
  }

  let {
    busy = false,
    reactive = false,
    stale = 0,
    onrunall,
    onrunstale,
    onstop,
    onrestart,
    onrestartrunall,
    ontogglereactive,
  }: Props = $props();

  let open = $state(false);
  let root: HTMLDivElement | null = $state(null);
  let trigger: HTMLButtonElement | null = $state(null);

  const mod =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

  function items(): HTMLButtonElement[] {
    return root
      ? Array.from(
          root.querySelectorAll<HTMLButtonElement>(
            '[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)'
          )
        )
      : [];
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

<div class="run-menu" bind:this={root}>
  {#if busy}
    <!-- No fade-in: the kill switch must never look half-disabled. -->
    <button class="run-primary stop" onclick={() => onstop?.()} title="Stop the running computation (restarts the kernel; notebook variables are cleared)">
      <svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
        <rect x="2.5" y="2.5" width="9" height="9" rx="1.5"/>
      </svg>
      <span class="btn-label">Stop</span>
    </button>
  {:else}
    <button class="run-primary" onclick={() => onrunall?.()} title="Run all cells ({mod}⇧↵)">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
        <path d="M3 2l9 5-9 5V2z"/>
      </svg>
      <span class="btn-label">Run All</span>
      {#if reactive}
        <svg class="reactive-mark" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-label="Reactive mode is on">
          <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/>
        </svg>
      {/if}
    </button>
  {/if}

  <button
    bind:this={trigger}
    class="run-more"
    class:active={open}
    class:stale={stale > 0}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label="Run and kernel options"
    title={stale > 0 ? `${stale} cell${stale === 1 ? '' : 's'} to re-run` : 'Run and kernel options'}
    onclick={() => (open ? hide() : show())}
    onkeydown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); show(); } }}
  >
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <path d="M2 3.5l3 3 3-3"/>
    </svg>
  </button>

  {#if open}
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div class="run-popup" role="menu" aria-label="Run" tabindex="-1" onkeydown={onMenuKeydown}>
      <button role="menuitem" class="run-item" onclick={() => run(onrunall)}>
        <span>Run all cells</span><kbd>{mod}⇧↵</kbd>
      </button>
      <button role="menuitem" class="run-item" disabled={stale === 0} onclick={() => run(onrunstale)}>
        <!-- "Run 0 stale cells" is not a sentence; with none, the item just names what it would do. -->
        <span>Run {stale > 0 ? `${stale} ` : ''}stale cell{stale === 1 ? '' : 's'}</span>
      </button>
      <div class="run-sep" role="separator"></div>
      <button role="menuitemcheckbox" class="run-item check" aria-checked={reactive} onclick={() => run(ontogglereactive)}>
        <span class="tick" aria-hidden="true">{reactive ? '✓' : ''}</span>
        <span>Reactive mode</span>
      </button>
      <div class="run-sep" role="separator"></div>
      <button role="menuitem" class="run-item" onclick={() => run(onrestart)}>
        <span>Restart kernel</span>
      </button>
      <button role="menuitem" class="run-item" onclick={() => run(onrestartrunall)}>
        <span>Restart and run all</span>
      </button>
    </div>
  {/if}
</div>

<style>
  .run-menu {
    position: relative;
    display: flex;
    align-items: stretch;
  }

  /* One control in two halves: the action, and what else it can do. */
  .run-primary {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.35rem 0.6rem 0.35rem 0.7rem;
    background-color: var(--accent-solid);
    color: var(--accent-on-solid);
    border: none;
    border-radius: var(--radius-pill) 0 0 var(--radius-pill);
    font-size: 0.8rem;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .run-primary:hover { background-color: var(--accent-solid-hover); }

  .run-primary.stop {
    background-color: var(--danger-bg);
    color: var(--danger-fg);
    box-shadow: inset 0 0 0 1px var(--danger-border);
    font-weight: 600;
  }

  .run-primary.stop:hover { filter: brightness(0.95); }

  /* Reactive is a mode, and a mode you cannot see is a mode you forget. It
     rides on the button it changes the behaviour of. */
  .reactive-mark { opacity: 0.85; margin-left: 0.1rem; }

  .run-more {
    display: flex;
    align-items: center;
    padding: 0.35rem 0.5rem;
    margin-left: 1px;
    background-color: var(--accent-solid);
    color: var(--accent-on-solid);
    border: none;
    border-radius: 0 var(--radius-pill) var(--radius-pill) 0;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .run-more:hover,
  .run-more.active { background-color: var(--accent-solid-hover); }

  /* Cells are waiting to be re-run: the chevron is where the action for that
     lives, so it is the thing that marks it. */
  .run-more.stale::after {
    content: '';
    position: absolute;
    top: 3px;
    right: 3px;
    width: 6px;
    height: 6px;
    border-radius: var(--radius-pill);
    background: var(--warn-fg);
    box-shadow: 0 0 0 1.5px var(--accent-solid);
  }

  .run-popup {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 60;
    min-width: 220px;
    display: flex;
    flex-direction: column;
    padding: 0.25rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-input);
    box-shadow: var(--shadow-md);
  }

  .run-item {
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

  .run-item:hover:not(:disabled),
  .run-item:focus-visible {
    background-color: var(--surface-hover);
    color: var(--heading);
    outline: none;
  }

  .run-item:disabled { opacity: 0.45; cursor: default; }

  .run-item.check {
    justify-content: flex-start;
    gap: 0.4rem;
  }

  .tick {
    display: inline-block;
    width: 0.8rem;
    color: var(--accent-weak-fg);
  }

  .run-item kbd {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 0.68rem;
    color: var(--text-faint);
  }

  .run-sep {
    height: 1px;
    background: var(--border);
    margin: 0.25rem 0.3rem;
  }

  @media (max-width: 960px) {
    .btn-label { display: none; }
    .run-primary { gap: 0; padding-right: 0.5rem; }
  }
</style>
