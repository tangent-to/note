<script lang="ts">
  /**
   * The strip of icons down the right edge: the panel, announcing itself.
   *
   * The tools used to be named only *inside* the panel, on a row of text tabs —
   * so with the panel closed there was nothing to say they existed, and someone
   * who had just opened a folder had to guess that its contents were behind a
   * button called Storage. A rail is always there, at the edge, the way
   * Observable puts its tools on the right and Marimo on the left: you see that
   * there is something to open before you know what it is.
   *
   * It replaces the row of tabs rather than adding to it, so the panel gains
   * the height that row was taking and nothing is named twice.
   *
   * The rule between the third and fourth icon is the same boundary the tabs
   * carried: above it, tools that follow the notebook on screen — Info,
   * Variables and Console read that notebook's own kernel; below it, tools that
   * belong to the whole app — one chat, and one place where files live.
   */
  import type { PanelTab } from '../types/panel';

  interface Props {
    activeTab: PanelTab;
    open: boolean;
    /** A backup is due: the files icon says so. */
    backupDue?: boolean;
    onselect?: (tab: PanelTab) => void;
  }

  let { activeTab, open, backupDue = false, onselect }: Props = $props();

  const mod =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
</script>

<nav class="panel-rail" aria-label="Panel">
  <button
    class="rail-btn"
    class:active={open && activeTab === 'info'}
    onclick={() => onselect?.('info')}
    title="Info — about this notebook, and where its cells run"
    aria-label="Info"
    aria-pressed={open && activeTab === 'info'}
  >
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true">
      <circle cx="12" cy="12" r="9"/>
      <path d="M12 11v5" stroke-linecap="round"/>
      <circle cx="12" cy="7.6" r="0.9" fill="currentColor" stroke="none"/>
    </svg>
  </button>

  <button
    class="rail-btn"
    class:active={open && activeTab === 'variables'}
    onclick={() => onselect?.('variables')}
    title="Variables — what this notebook's kernel is holding"
    aria-label="Variables"
    aria-pressed={open && activeTab === 'variables'}
  >
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M8.5 4C6.5 4 6.5 8.5 4 12c2.5 3.5 2.5 8 4.5 8"/>
      <path d="M15.5 4c2 0 2 4.5 4.5 8-2.5 3.5-2.5 8-4.5 8"/>
    </svg>
  </button>

  <button
    class="rail-btn"
    class:active={open && activeTab === 'console'}
    onclick={() => onselect?.('console')}
    title={`Console — its output, and a prompt into the same kernel (${mod}\`)`}
    aria-label="Console"
    aria-pressed={open && activeTab === 'console'}
  >
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M5 7l4.5 4.5L5 16"/>
      <path d="M12.5 16.5H19"/>
    </svg>
  </button>

  <span class="rail-rule" aria-hidden="true"></span>

  <button
    class="rail-btn"
    class:active={open && activeTab === 'chat'}
    onclick={() => onselect?.('chat')}
    title="Chat — one conversation for the whole app ({mod}/)"
    aria-label="Chat"
    aria-pressed={open && activeTab === 'chat'}
  >
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M20 14.5a2.5 2.5 0 0 1-2.5 2.5H9l-4 3.5V6.5A2.5 2.5 0 0 1 7.5 4h10A2.5 2.5 0 0 1 20 6.5z"/>
    </svg>
  </button>

  <button
    class="rail-btn"
    class:active={open && activeTab === 'storage'}
    onclick={() => onselect?.('storage')}
    title="Files — the notebooks and data this folder holds, backups and offline ({mod}⇧D)"
    aria-label="Files"
    aria-pressed={open && activeTab === 'storage'}
  >
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4L11 8.5h8.5A1.5 1.5 0 0 1 21 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>
    </svg>
    {#if backupDue}<span class="rail-dot" title="A backup is due" aria-label="(backup due)"></span>{/if}
  </button>
</nav>

<style>
  .panel-rail {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.15rem;
    width: 44px;
    padding: 0.4rem 0;
    background-color: var(--surface);
    border-left: 1px solid var(--border);
    /* Above the panel when it floats over the notebook on a narrow screen. */
    z-index: 31;
  }

  .rail-btn {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-input);
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .rail-btn:hover { background-color: var(--surface-hover); color: var(--heading); }
  .rail-btn:focus-visible { outline: 1px solid var(--accent-weak-border); outline-offset: -1px; }

  /* Open, on this tool. Quiet accent: solid is reserved for Run All. */
  .rail-btn.active {
    background-color: var(--accent-weak-bg);
    color: var(--accent-weak-fg);
  }

  .rail-rule {
    width: 18px;
    height: 1px;
    margin: 0.3rem 0;
    background: var(--border-strong);
  }

  .rail-dot {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 6px;
    height: 6px;
    border-radius: var(--radius-pill);
    background: var(--warn-fg);
    box-shadow: 0 0 0 1.5px var(--surface);
  }

  @media (max-width: 640px) {
    .panel-rail { width: 38px; }
    .rail-btn { width: 30px; height: 30px; }
  }
</style>
