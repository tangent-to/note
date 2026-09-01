<script lang="ts">
  /**
   * The open notebooks, as tabs.
   *
   * It lives in the header row, between the two button groups. That row is
   * fixed at one line at every width, so the strip is the only thing there
   * allowed to shrink: it absorbs the free space, scrolls inside itself when
   * the tabs outgrow it, and disappears entirely on narrow screens where a
   * forty-pixel sliver would help nobody (Ctrl+K still switches notebooks).
   *
   * Hidden too while a single notebook is open: a strip with one tab in it is
   * chrome that explains nothing, and the app has to stay as quiet as it was
   * for the reader who only ever wants one notebook.
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
  .tab-strip {
    display: flex;
    align-items: center;
    /* Absorbs the header's free space, and is the only header child that may
       shrink — min-width:0 is what lets it, rather than pushing the buttons
       out of the row. */
    flex: 1 1 auto;
    min-width: 0;
    gap: 0.15rem;
    padding: 0 0.5rem;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .tab-strip::-webkit-scrollbar { display: none; }

  /* Below this the header has no room to spare, and a strip squeezed to a few
     pixels is worse than none: Ctrl+K switches notebooks instead. */
  @media (max-width: 640px) {
    .tab-strip { display: none; }
  }

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
