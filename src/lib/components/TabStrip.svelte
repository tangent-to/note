<script lang="ts">
  /**
   * The open notebooks, as tabs.
   *
   * One row, below the header and above the notebook. Hidden entirely when a
   * single notebook is open: a strip with one tab in it is chrome that explains
   * nothing, and the app has to stay as quiet as it was for the reader who only
   * ever wants one notebook.
   */
  import { sessions } from '../stores/sessions';
  import NotebookTab from './NotebookTab.svelte';

  interface Props {
    onclose?: (detail: { id: string }) => void;
    onnew?: () => void;
  }

  let { onclose, onnew }: Props = $props();

  function onWheel(event: WheelEvent) {
    // A trackpad's vertical scroll should move a horizontal strip; without this
    // the row is unreachable on a laptop once the tabs overflow.
    if (event.deltaX !== 0) return;
    const strip = event.currentTarget as HTMLElement;
    if (strip.scrollWidth <= strip.clientWidth) return;
    event.preventDefault();
    strip.scrollLeft += event.deltaY;
  }
</script>

{#if $sessions.length > 1}
  <div class="tab-strip" role="tablist" aria-label="Open notebooks" onwheel={onWheel}>
    {#each $sessions as session (session.id)}
      <NotebookTab {session} {onclose} />
    {/each}

    <button class="tab-new" title="New notebook" aria-label="New notebook" onclick={() => onnew?.()}>
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6">
        <path d="M7 2v10M2 7h10"/>
      </svg>
    </button>
  </div>
{/if}

<style>
  /* Pinned: .main-content is the scroll container, so without this the strip
     would scroll away with the notebook it labels. */
  .tab-strip {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    align-items: stretch;
    gap: 0.15rem;
    padding: 0 0.75rem;
    border-bottom: 1px solid var(--border);
    background-color: var(--surface);
    overflow-x: auto;
    scrollbar-width: none;
  }

  .tab-strip::-webkit-scrollbar { display: none; }

  .tab-new {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    align-self: center;
    padding: 0.25rem;
    margin-left: 0.25rem;
    background: none;
    border: none;
    border-radius: var(--radius-input);
    color: var(--text-faint);
    cursor: pointer;
    opacity: 0.45;
  }

  .tab-new:hover {
    opacity: 1;
    background-color: var(--surface-hover);
    color: var(--text);
  }
</style>
