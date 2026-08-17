<script lang="ts">
  /**
   * One look for every advisory attached to a cell — a duplicate definition, an
   * output whose behaviour could not be sent — so they read as the same kind of
   * message wherever they appear. Notices precede what they annotate: above the
   * code when they are about the source, above the output when they are about
   * the result.
   *
   * Not for errors: an error IS the output, and has its own red treatment.
   */
  import type { Snippet } from 'svelte';

  interface Props {
    children: Snippet;
    /** Longer explanation, shown on hover. */
    title?: string;
    testid?: string;
    /** Optional single action, rendered at the end of the row. */
    actionLabel?: string;
    onaction?: () => void;
  }

  let { children, title, testid, actionLabel, onaction }: Props = $props();
</script>

<div class="cell-notice" data-testid={testid} {title} class:has-hint={!!title}>
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3L2 20h20L12 3z"/>
    <path d="M12 9v5M12 17v.5"/>
  </svg>
  <span class="cell-notice-text">{@render children()}</span>
  {#if actionLabel}
    <button class="cell-notice-action" onclick={onaction}>{actionLabel}</button>
  {/if}
</div>

<style>
  .cell-notice {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    margin: 0.1rem 0 0.4rem;
    padding: 0.3rem 0.55rem;
    font-size: 0.75rem;
    line-height: 1.4;
    color: var(--warn-fg);
    background-color: var(--warn-bg);
    border: 1px solid var(--warn-border);
    border-radius: var(--radius-input);
  }

  .cell-notice.has-hint {
    cursor: help;
  }

  .cell-notice svg {
    flex: 0 0 auto;
    margin-top: 0.15rem;
  }

  .cell-notice-text {
    flex: 1 1 auto;
  }

  /* Names and other code fragments inside the message. */
  .cell-notice-text :global(code) {
    font-family: var(--font-mono);
    font-weight: 600;
  }

  .cell-notice-action {
    flex: 0 0 auto;
    padding: 0.15rem 0.45rem;
    font: inherit;
    font-weight: 600;
    color: var(--warn-fg);
    background: transparent;
    border: 1px solid var(--warn-border);
    border-radius: var(--radius-input);
    cursor: pointer;
    white-space: nowrap;
  }

  .cell-notice-action:hover {
    background-color: var(--warn-border);
  }
</style>
