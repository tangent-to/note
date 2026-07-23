<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import CodeEditor from './CodeEditor.svelte';
  import CellOutput from './CellOutput.svelte';
  import {
    consoleEntries,
    consoleInputHistory,
    evalInConsole,
    pushConsoleEntry,
    clearConsole,
    navigateHistory,
  } from '../stores/console';

  let input = $state('');
  let running = $state(false);
  // Position in the recalled history, or null while editing a fresh line.
  let histIndex: number | null = null;
  let editor = $state<CodeEditor>();
  let logEl = $state<HTMLDivElement>();

  async function submit() {
    const code = input.trim();
    if (!code || running) return;
    input = '';
    histIndex = null;
    running = true;
    try {
      const output = await evalInConsole(code);
      pushConsoleEntry(code, output);
    } catch (err: any) {
      pushConsoleEntry(code, {
        type: 'error',
        content: err?.message ?? String(err),
        timestamp: Date.now(),
      });
    } finally {
      running = false;
      queueMicrotask(() => editor?.focus());
    }
  }

  // Returns true when it consumed the arrow key (i.e. it recalled an entry).
  function history(direction: 'prev' | 'next'): boolean {
    const res = navigateHistory(get(consoleInputHistory), histIndex, direction);
    if (res.value === null) return false;
    histIndex = res.index;
    input = res.value;
    return true;
  }

  function onClear() {
    clearConsole();
    histIndex = null;
    editor?.focus();
  }

  // Keep the newest entry in view.
  $effect(() => {
    void $consoleEntries.length;
    if (logEl) queueMicrotask(() => { if (logEl) logEl.scrollTop = logEl.scrollHeight; });
  });

  onMount(() => { editor?.focus(); });
</script>

<div class="console">
  <div class="console-head">
    <h4 class="console-title">Console</h4>
    <div class="console-actions">
      {#if running}<span class="console-busy">running</span>{/if}
      <button class="console-clear" onclick={onClear} title="Clear console" aria-label="Clear console">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="9"/>
          <line x1="6" y1="18" x2="18" y2="6"/>
        </svg>
      </button>
    </div>
  </div>

  <div class="console-log" bind:this={logEl}>
    {#if $consoleEntries.length === 0}
      <div class="console-empty">
        Evaluates in the notebook scope: <code>nb</code> lists the variables,
        <code>nb.x</code> reads one, <code>await data("file.csv")</code> loads data.
        Enter runs, Shift+Enter adds a line, Arrow Up recalls history.
      </div>
    {:else}
      {#each $consoleEntries as entry (entry.id)}
        <div class="console-entry">
          <div class="console-in">
            <span class="console-prompt">&gt;</span><code>{entry.input}</code>
          </div>
          <div class="console-out"><CellOutput output={entry.output} /></div>
        </div>
      {/each}
    {/if}
  </div>

  <div class="console-prompt-row">
    <span class="console-prompt console-prompt-live">&gt;</span>
    <div class="console-editor">
      <CodeEditor
        bind:this={editor}
        language="javascript"
        value={input}
        submitOnEnter
        onchange={(e) => (input = e.value)}
        onsubmit={submit}
        onhistory={history}
      />
    </div>
  </div>
</div>

<style>
  .console {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  /* Mirrors the Variables tab header (.variables-header + .section-title). */
  .console-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1rem 0.5rem;
    flex-shrink: 0;
  }

  .console-title {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--heading);
    margin: 0;
  }

  .console-actions { display: flex; align-items: center; gap: 0.4rem; }

  .console-busy {
    font-size: 0.72rem;
    color: var(--text-muted);
    font-style: italic;
  }

  /* Same recipe as the Variables refresh button. */
  .console-clear {
    background: transparent;
    border: none;
    padding: 0.25rem;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: var(--radius-pill);
    display: flex;
    align-items: center;
    transition: all 0.15s ease;
  }

  .console-clear:hover { background-color: var(--surface-hover); color: var(--heading); }

  .console-log {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0.25rem 1rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .console-empty {
    font-size: 0.8rem;
    color: var(--text-muted);
    line-height: 1.6;
    padding: 0.25rem 0;
  }

  .console-empty code {
    font-family: var(--font-mono);
    font-size: 0.92em;
    color: var(--accent);
  }

  .console-entry {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .console-in {
    display: flex;
    gap: 0.45rem;
    align-items: baseline;
    min-width: 0;
  }

  /* 12px mono, same as the cell editor, so echoed input reads as code. The
     echo is a record of what was typed, so it sits back; the value it produced
     is what you actually read, and keeps full contrast. */
  .console-in code {
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.55;
    color: var(--text-muted);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .console-prompt {
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.55;
    font-weight: 600;
    user-select: none;
    flex-shrink: 0;
    /* Past prompts stay quiet. Teal is reserved for the live one below, so the
       accent marks the one place you can type. */
    color: var(--text-faint);
  }

  .console-prompt-live { color: var(--accent); }

  .console-out {
    padding-left: 1rem;
    min-width: 0;
    /* Wide values (inspector rows, tables, plots) scroll rather than clip. */
    overflow-x: auto;
  }

  /* Outputs reuse CellOutput, which brings its own framing; keep it compact. */
  .console-out :global(.output-container) { margin: 0; }

  .console-prompt-row {
    display: flex;
    gap: 0.45rem;
    align-items: flex-start;
    padding: 0.5rem 1rem 0.65rem;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  .console-prompt-row .console-prompt-live { padding-top: 4px; }

  .console-editor { flex: 1; min-width: 0; }
</style>
