<script lang="ts">
  /**
   * What is true right now, on one line at the bottom.
   *
   * These facts used to sit among the header's buttons — the cell count, the
   * linked file, the reactive mode — where they looked like things to click and
   * competed with the one thing that is. State reads better where editors have
   * always put it: a quiet strip under the work, which costs a row of pixels and
   * gives the header back to actions.
   *
   * Two of the segments are also switches, as in any editor's status bar: the
   * mode you can see is the mode you can change, and the kernel says where cells
   * run — which is the first thing to check when audio plays nowhere.
   */
  import type { NotebookOrigin } from '../utils/notebookLibrary';

  interface Props {
    origin: NotebookOrigin;
    /** A `note serve` companion is connected, so "no file" means something. */
    connected: boolean;
    cells: number | null;
    dirty?: boolean;
    busy?: boolean;
    reactive?: boolean;
    stale?: number;
    kernel: 'worker' | 'main';
    onrunstale?: () => void;
    ontogglereactive?: () => void;
    onkernel?: () => void;
  }

  let {
    origin,
    connected,
    cells,
    dirty = false,
    busy = false,
    reactive = false,
    stale = 0,
    kernel,
    onrunstale,
    ontogglereactive,
    onkernel,
  }: Props = $props();

  // What Ctrl+S will do, said as a place rather than a verb.
  const where = $derived.by(() => {
    if (origin.kind === 'disk') {
      return { label: origin.path.split('/').pop() ?? origin.path, title: `${origin.path}. Ctrl/Cmd+S writes this file.`, linked: true };
    }
    if (origin.kind === 'url') {
      return { label: 'from a link', title: `${origin.href}. Ctrl/Cmd+S exports a download.`, linked: false };
    }
    if (connected) {
      return { label: 'not on disk', title: 'This notebook has no file in the served folder. Ctrl/Cmd+S exports a download; Save as… gives it a file.', linked: false };
    }
    return { label: 'in this browser', title: 'Kept in this browser’s library. Ctrl/Cmd+S exports a download.', linked: false };
  });
</script>

<footer class="status-bar">
  <div class="status-side">
    <span class="segment" class:linked={where.linked} title={where.title}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
        <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5"/>
        <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>
        {#if !where.linked}<path d="M3 3l18 18"/>{/if}
      </svg>
      {where.label}
    </span>
    {#if dirty}
      <span class="segment unsaved" title="Unsaved changes. Ctrl/Cmd+S to write them.">
        <span class="dot" aria-hidden="true"></span>unsaved
      </span>
    {/if}
    {#if cells !== null}
      <span class="segment">{cells} {cells === 1 ? 'cell' : 'cells'}</span>
    {/if}
  </div>

  <div class="status-side">
    {#if stale > 0}
      <button class="segment action warn" onclick={() => onrunstale?.()} title="Re-run the cells whose dependencies changed">
        {stale} stale
      </button>
    {/if}
    {#if busy}
      <span class="segment running"><span class="pulse" aria-hidden="true"></span>running</span>
    {/if}
    <button class="segment action" class:on={reactive} onclick={() => ontogglereactive?.()} title="Reactive mode: when on, running a cell re-runs the cells that depend on it">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/>
      </svg>
      reactive {reactive ? 'on' : 'off'}
    </button>
    <button class="segment action" onclick={() => onkernel?.()} title="Where cells run. Change it in the Info panel.">
      {kernel === 'worker' ? 'worker' : 'main thread'}
    </button>
  </div>
</footer>

<style>
  .status-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    height: 24px;
    flex: 0 0 auto;
    padding: 0 0.9rem;
    background-color: var(--surface);
    border-top: 1px solid var(--border);
    font-size: 0.7rem;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
    user-select: none;
  }

  .status-side {
    display: flex;
    align-items: center;
    gap: 0.15rem;
    min-width: 0;
  }

  .segment {
    display: inline-flex;
    align-items: center;
    gap: 0.28rem;
    max-width: 22rem;
    padding: 0.1rem 0.4rem;
    border: none;
    border-radius: var(--radius-input);
    background: transparent;
    color: inherit;
    font: inherit;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .segment.linked { color: var(--text-muted); }

  .action { cursor: pointer; }
  .action:hover { background-color: var(--surface-hover); color: var(--heading); }
  .action:focus-visible { outline: 1px solid var(--accent-weak-border); outline-offset: -1px; }

  .action.on { color: var(--accent-weak-fg); }

  .warn { color: var(--warn-fg); font-weight: 600; }

  .unsaved { color: var(--text-muted); }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: var(--radius-pill);
    background: var(--danger-solid);
  }

  .running { color: var(--accent-weak-fg); }

  .pulse {
    width: 6px;
    height: 6px;
    border-radius: var(--radius-pill);
    background: currentColor;
    animation: status-pulse 1.2s ease-in-out infinite;
  }

  @keyframes status-pulse {
    0%, 100% { opacity: 0.35; }
    50% { opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .pulse { animation: none; opacity: 0.8; }
  }

  /* Phones: the left side is the one that can be long, so it yields first. */
  @media (max-width: 640px) {
    .status-bar { padding: 0 0.4rem; gap: 0.4rem; }
    .segment { max-width: 10rem; }
  }
</style>
