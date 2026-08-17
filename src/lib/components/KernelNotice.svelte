<script lang="ts">
  /**
   * Shown when the worker kernel had to serialize a live DOM output, dropping
   * the listeners or scripts it depended on (see cellOutput.ts). Renders nothing
   * otherwise.
   *
   * Its own component so the wording and the action live in one place: it is
   * used both at the top of a cell and in the console.
   */
  import CellNotice from './CellNotice.svelte';
  import { kernelMode } from '../stores/notebook';
  import type { CellOutput } from '../types/notebook';

  let { output }: { output: CellOutput | null | undefined } = $props();

  // Derived from the store, so the note reads correctly however the reader
  // switched kernels (this button, or the Info panel).
  const onMainThread = $derived($kernelMode === 'main');
</script>

{#if output?.needsMainThread}
  <CellNotice
    testid="needs-main-thread"
    actionLabel={onMainThread ? undefined : 'Use main thread'}
    onaction={() => kernelMode.set('main')}
  >
    {#if onMainThread}
      Now on the main-thread kernel. Variables don't carry across kernels, so use
      Run All to rebuild them and get a live output.
    {:else}
      This output's buttons and tooltips need code that runs after rendering.
      The background worker can only send static HTML.
    {/if}
  </CellNotice>
{/if}
