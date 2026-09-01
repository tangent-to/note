<script lang="ts">
  /**
   * One tab.
   *
   * A component per tab rather than a loop in TabStrip, because each tab reads
   * *its own* session's stores: `$` auto-subscription needs a variable holding
   * a store, which a `{#each}` body cannot give it. That is also what lets a
   * background notebook show what it is doing — the dot and the spinner come
   * from that notebook's stores, not from the active one's.
   */
  import { activeSessionId, setActive, type NotebookSession } from '../stores/sessions';
  import { kernelFor } from '../utils/kernelClient';

  interface Props {
    session: NotebookSession;
    onclose?: (detail: { id: string }) => void;
  }

  let { session, onclose }: Props = $props();

  // Read once, deliberately: TabStrip keys its {#each} by session.id, so a
  // given tab component is bound to one session for its whole life — if the
  // session changes, this component is destroyed and rebuilt. Capturing the
  // stores here is what makes `$notebook` / `$dirty` / `$busy` legal at all.
  // svelte-ignore state_referenced_locally
  const notebook = session.notebook;
  // svelte-ignore state_referenced_locally
  const dirty = session.dirty;
  // svelte-ignore state_referenced_locally
  const busy = kernelFor(session.id).busy;

  const isActive = $derived($activeSessionId === session.id);
</script>

<div class="tab" class:active={isActive}>
  <button
    class="tab-open"
    role="tab"
    aria-selected={isActive}
    title={$notebook.name}
    onclick={() => setActive(session.id)}
  >
    {#if $busy}
      <span class="tab-spinner" aria-label="Running"></span>
    {:else if $dirty}
      <span class="tab-dot" aria-label="Not written to its file"></span>
    {/if}
    <span class="tab-name">{$notebook.name}</span>
  </button>
  <button
    class="tab-close"
    title="Close (the notebook stays in the library)"
    aria-label={`Close ${$notebook.name}`}
    onclick={() => onclose?.({ id: session.id })}
  >
    <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6">
      <path d="M3 3l8 8M11 3l-8 8"/>
    </svg>
  </button>
</div>

<style>
  .tab {
    display: flex;
    align-items: center;
    flex: 0 1 auto;
    min-width: 0;
    max-width: 15rem;
    border-bottom: 2px solid transparent;
  }

  .tab.active { border-bottom-color: var(--accent); }

  .tab-open {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
    padding: 0.4rem 0.15rem 0.4rem 0.55rem;
    background: none;
    border: none;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  .tab.active .tab-open { color: var(--heading); }

  .tab-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Differs from its file on disk. Not "unsaved": the library already has it. */
  .tab-dot {
    flex: 0 0 auto;
    width: 5px;
    height: 5px;
    border-radius: var(--radius-pill);
    background-color: var(--text-faint);
  }

  .tab-spinner {
    flex: 0 0 auto;
    width: 9px;
    height: 9px;
    border: 1.5px solid var(--border-strong);
    border-top-color: var(--accent);
    border-radius: var(--radius-pill);
    animation: tab-spin 0.7s linear infinite;
  }

  @keyframes tab-spin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .tab-spinner { animation-duration: 2.4s; }
  }

  .tab-close {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    padding: 0.25rem;
    margin: 0 0.2rem;
    background: none;
    border: none;
    border-radius: var(--radius-input);
    color: var(--text-faint);
    cursor: pointer;
    /* Reserved rather than revealed on hover: a close button that appears under
       the pointer is a close button clicked by accident. */
    opacity: 0.45;
  }

  .tab-close:hover {
    opacity: 1;
    background-color: var(--surface-hover);
    color: var(--text);
  }
</style>
