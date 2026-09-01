<script lang="ts">
  /**
   * Live table for a `table` output: sortable by column, rows rendered lazily as
   * you scroll, height bounded by construction.
   *
   * Built here on the main thread from the data the kernel sent, not in the
   * kernel: a table built as DOM in the worker would arrive with its sorting and
   * scrolling stripped by serialization.
   */
  import * as Inputs from '@observablehq/inputs';
  import '@observablehq/inputs/dist/index.css';
  import { reviveRows, type TableSpec } from '../utils/tableData';

  let { spec }: { spec: TableSpec } = $props();

  const shown = $derived(spec.rows.length);
  const truncated = $derived(spec.totalRows > shown);

  function mount(node: HTMLElement, initial: TableSpec) {
    const render = (current: TableSpec) => {
      node.innerHTML = '';
      node.appendChild(
        Inputs.table(reviveRows(current), {
          columns: current.columns,
          rows: 12,          // bounds the height; more load as you scroll
          select: false,     // display, not a selection input
          layout: 'auto',
        })
      );
    };
    render(initial);
    return {
      update(next: TableSpec) { render(next); },
      destroy() { node.innerHTML = ''; },
    };
  }
</script>

<div class="table-output">
  <div class="table-host" use:mount={spec}></div>
  <div class="table-summary">
    {#if truncated}
      {shown.toLocaleString()} of {spec.totalRows.toLocaleString()} rows
    {:else}
      {spec.totalRows.toLocaleString()}
      {spec.totalRows === 1 ? 'row' : 'rows'}
    {/if}
    · {spec.columns.length}
    {spec.columns.length === 1 ? 'column' : 'columns'}
  </div>
</div>

<style>
  .table-output {
    min-width: 0;
  }

  /* Observable Inputs hard-codes a light palette: a white sticky header and #eee
     rules, which turn into a white band in dark mode. Re-point those at the
     theme tokens. Targeted by element rather than by their hashed class name, so
     a version bump cannot silently drop the overrides. */
  .table-host {
    /* Their stylesheet asks for --sans-serif; ours is called --font-sans. */
    --sans-serif: var(--font-sans);
  }

  .table-host :global(form) {
    margin: 0;
    color: var(--text);
  }

  .table-host :global(thead th) {
    background-color: var(--surface);
    color: var(--heading);
    border-bottom-color: var(--border-strong);
  }

  .table-host :global(tr:not(:last-child) td),
  .table-host :global(tr:not(:last-child) th) {
    border-bottom-color: var(--border);
  }

  /* With select: false the leading cell is empty, but their CSS still reserves
     19px for the checkbox. */
  .table-host :global(tr > :first-of-type) {
    width: 0;
    padding-left: 0;
    padding-right: 0;
  }

  .table-summary {
    padding-top: 0.25rem;
    font-size: 0.72rem;
    color: var(--text-faint);
  }
</style>
