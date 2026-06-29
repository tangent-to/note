<script lang="ts">
  import type { CellOutput } from '../types/notebook';
  import { Inspector } from '@observablehq/inspector';
  import '../styles/observable-inspector.css';

  let { output }: { output: CellOutput } = $props();

  let renderError: string | null = $state(null);
  let copyLabel = $state('Copy');

  function formatTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString();
  }

  function isValidJSON(str: string): boolean {
    try {
      JSON.parse(str);
      return true;
    } catch {
      return false;
    }
  }

  function getOutputText(): string {
    if (output.type === 'dom') {
      const el = output.content as Element;
      return el?.textContent || el?.outerHTML || '';
    }
    return String(output.content ?? '');
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(getOutputText());
      copyLabel = 'Copied!';
      setTimeout(() => { copyLabel = 'Copy'; }, 1500);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = getOutputText();
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      copyLabel = 'Copied!';
      setTimeout(() => { copyLabel = 'Copy'; }, 1500);
    }
  }

  function insertLiveElement(node: HTMLElement, element: Element | null) {
    if (element) {
      try {
        let childCount = 0;
        const MAX_CHILDREN = 5000;
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            childCount += mutation.addedNodes.length;
            if (childCount > MAX_CHILDREN) {
              observer.disconnect();
              node.innerHTML = '';
              const warning = document.createElement('pre');
              warning.style.color = 'var(--danger-fg)';
              warning.textContent = `Output exceeded ${MAX_CHILDREN} DOM nodes and was truncated to prevent browser freeze.`;
              node.appendChild(warning);
              return;
            }
          }
        });
        observer.observe(node, { childList: true, subtree: true });

        node.appendChild(element);

        return {
          destroy() {
            observer.disconnect();
            try {
              if (element && node.contains(element)) {
                node.removeChild(element);
              }
            } catch {
              node.innerHTML = '';
            }
          }
        };
      } catch (err: any) {
        renderError = `Failed to render DOM output: ${err?.message || String(err)}`;
        return { destroy() {} };
      }
    }
    return {
      destroy() {
        if (element && node.contains(element)) {
          node.removeChild(element);
        }
      }
    };
  }

  // Render a value with Observable's inspector: expandable, syntax-colored,
  // and robust for large arrays/objects. Cell output arrives as a JSON string,
  // so we parse it back to a value; a non-JSON string falls through to a <pre>.
  function renderInspector(node: HTMLElement, value: string | object | null | undefined) {
    const render = (next: typeof value) => {
      node.innerHTML = '';
      if (next === undefined || next === null) return;

      let parsed: any = next;
      if (typeof next === 'string') {
        try {
          parsed = JSON.parse(next);
        } catch {
          const pre = document.createElement('pre');
          pre.className = 'json-output';
          pre.textContent = next;
          node.appendChild(pre);
          return;
        }
      }

      try {
        new Inspector(node).fulfilled(parsed);
      } catch {
        const pre = document.createElement('pre');
        pre.className = 'json-output';
        pre.textContent = typeof next === 'string' ? next : JSON.stringify(next, null, 2);
        node.appendChild(pre);
      }
    };

    render(value);

    return {
      update(next: typeof value) { render(next); },
      destroy() { node.innerHTML = ''; }
    };
  }
</script>

<div class="output-container" data-testid="cell-output">
  {#if renderError}
    <div class="output-content error">
      <div class="error-output">
        <div class="error-header">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="8" cy="8" r="7" fill="var(--danger-bg)"/>
            <path d="M8 4v5M8 11v1" stroke="var(--danger-fg)" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <span class="error-label">Render Error</span>
          <button class="copy-btn" onclick={handleCopy}>{copyLabel}</button>
        </div>
        <pre class="error-message"><code>{renderError}</code></pre>
      </div>
    </div>
  {:else}
    <div class="output-content {output.type}">
      {#if output.type === 'dom'}
        <div class="dom-output" use:insertLiveElement={output.content as Element}></div>
      {:else if output.type === 'html'}
        <div class="html-output">
          {@html output.content}
        </div>
      {:else if output.type === 'json' || isValidJSON(String(output.content))}
        <div class="inspect-output" use:renderInspector={output.content}></div>
      {:else if output.type === 'error'}
        <div class="error-output">
          <div class="error-header">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <circle cx="8" cy="8" r="7" fill="var(--danger-bg)"/>
              <path d="M8 4v5M8 11v1" stroke="var(--danger-fg)" stroke-width="2" stroke-linecap="round"/>
            </svg>
            <span class="error-label">Error</span>
            <button class="copy-btn" onclick={handleCopy}>{copyLabel}</button>
          </div>
          <pre class="error-message"><code>{String(output.content)}</code></pre>
        </div>
      {:else}
        <pre class="text-output"><code>{String(output.content)}</code></pre>
      {/if}
    </div>
  {/if}

  <div class="output-footer">
    <button class="copy-btn" onclick={handleCopy} title="Copy output">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="5" y="5" width="9" height="9" rx="1.5"/>
        <path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5"/>
      </svg>
      {copyLabel}
    </button>
    <span class="output-timestamp">{formatTimestamp(output.timestamp)}</span>
  </div>
</div>

<style>
  .output-container {
    margin-top: 0.2rem;
    padding-top: 0.15rem;
    position: relative;
  }

  .output-container:hover .output-footer {
    opacity: 1;
  }

  .output-content {
    margin-bottom: 0;
  }

  .dom-output,
  .html-output {
    max-width: 100%;
    overflow-x: auto;
  }

  .dom-output :global(svg),
  .html-output :global(svg) {
    max-width: 100%;
    height: auto;
  }

  .output-content :global(.tangent-table-output) {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--font-mono);
    font-size: 0.75rem;
    line-height: 1.45;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius-input);
    overflow: hidden;
  }

  .output-content :global(.tangent-table-output thead) {
    background-color: var(--surface-2);
  }

  .output-content :global(.tangent-table-output th),
  .output-content :global(.tangent-table-output td) {
    border: 1px solid var(--border);
    padding: 0.35rem 0.6rem;
    text-align: right;
    white-space: nowrap;
  }

  .output-content :global(.tangent-table-output th) {
    font-weight: 600;
    color: var(--heading);
    letter-spacing: 0.01em;
  }

  .output-content :global(.tangent-table-output tbody tr:nth-child(even)) {
    background-color: var(--surface-2);
  }

  .json-output,
  .text-output {
    font-size: 0.825rem;
    font-family: var(--font-mono);
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    padding: 0.4rem 0.85rem;
    background-color: transparent;
    border-radius: 0;
    border: none;
    line-height: 1.5;
  }

  .json-output {
    color: var(--accent);
  }

  /* The Observable inspector renders its own markup and colors (see
     styles/observable-inspector.css). We only pad and scroll-cap the container. */
  .inspect-output {
    padding: 0.4rem 0.85rem;
    overflow: auto;
    max-height: 420px;
  }

  .text-output {
    color: var(--heading);
  }

  .error-output {
    background-color: var(--danger-bg);
    border: 1px solid var(--danger-border);
    border-radius: var(--radius-input);
    padding: 0.75rem 1rem;
  }

  .error-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .error-label {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--danger-fg);
  }

  .error-message {
    font-size: 0.875rem;
    font-family: var(--font-mono);
    color: var(--danger-fg);
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.5;
  }

  .output-footer {
    position: absolute;
    bottom: 0;
    right: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.5rem 0.1rem;
    opacity: 0;
    transition: opacity 0.15s ease;
    pointer-events: none;
    z-index: 1;
    background: linear-gradient(to right, transparent, var(--surface) 20%);
  }

  .output-container:hover .output-footer {
    pointer-events: auto;
  }

  .output-timestamp {
    font-size: 0.7rem;
    color: var(--text-faint);
  }

  .copy-btn {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.1rem 0.35rem;
    background: transparent;
    border: none;
    border-radius: var(--radius-pill);
    font-size: 0.68rem;
    color: var(--text-faint);
    cursor: pointer;
    transition: color 0.15s ease;
    font-family: inherit;
  }

  .copy-btn:hover {
    color: var(--text-muted);
  }

  .error-header .copy-btn {
    margin-left: auto;
  }

  .output-content code {
    font-family: var(--font-mono);
    font-size: 0.875rem;
  }

  .html-output :global(.plot) {
    max-width: 100%;
    overflow-x: auto;
  }

  .html-output :global(.plot svg) {
    max-width: 100%;
    height: auto;
  }
</style>
