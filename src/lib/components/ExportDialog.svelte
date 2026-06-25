<script lang="ts">
  import { currentNotebook } from '../stores/notebook';
  import { ExportService } from '../utils/exportService';
  import type { Notebook } from '../types/notebook';

  interface Props {
    onclose?: () => void;
  }

  let { onclose }: Props = $props();

  const exportService = new ExportService();

  type ExportFormat = 'js' | 'html-static' | 'html-runnable';

  const EXPORT_CHOICES: Array<{
    value: ExportFormat;
    title: string;
    description: string;
    button: string;
  }> = [
    {
      value: 'js',
      title: 'Export JS: checkpoint & reuse',
      description:
        "Save Tangent's .js format with cell delimiters so you can version control or re-import later.",
      button: 'Download .js file'
    },
    {
      value: 'html-static',
      title: 'Static export: read-only snapshot',
      description:
        'Generate a styled, read-only HTML page that mirrors your notebook for sharing or archiving.',
      button: 'Download static HTML'
    },
    {
      value: 'html-runnable',
      title: 'Runnable export: executable/print-ready',
      description:
        'Bundle notebook code and outputs into a single HTML file that can replay cells (via CDN modules).',
      button: 'Download runnable HTML'
    }
  ];

  let exportFormat: ExportFormat = $state('js');
  let activeChoice = $derived(EXPORT_CHOICES.find((option) => option.value === exportFormat) ?? EXPORT_CHOICES[0]);

  function slugify(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .trim() || 'notebook';
  }

  function downloadText(text: string, filename: string, mime: string) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function handleExport() {
    const notebook = $currentNotebook as Notebook | null;
    if (!notebook) return;

    const baseName = slugify(notebook.name || 'notebook');

    try {
      if (exportFormat === 'js') {
        const content = await exportService.exportNotebook(notebook, {
          includeCode: true,
          includeOutputs: true,
          includeTimestamps: false,
          theme: 'light',
          format: 'js'
        });
        downloadText(content as string, `${baseName}.js`, 'text/javascript');
      } else if (exportFormat === 'html-static') {
        const content = await exportService.exportNotebook(notebook, {
          includeCode: true,
          includeOutputs: true,
          includeTimestamps: false,
          theme: 'light',
          format: 'html'
        });
        downloadText(content as string, `${baseName}-static.html`, 'text/html');
      } else if (exportFormat === 'html-runnable') {
        const content = await exportService.exportNotebook(notebook, {
          includeCode: true,
          includeOutputs: true,
          includeTimestamps: false,
          theme: 'light',
          format: 'html-inline'
        });
        downloadText(content as string, `${baseName}-runnable.html`, 'text/html');
      }
    } catch (error) {
      console.error('Export failed:', error);
      alert('Export failed. Please check the console for details.');
      return;
    }

    onclose?.();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      onclose?.();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="export-modal">
  <div class="export-content">
    <div class="export-header">
      <h3>Export Notebook</h3>
      <button class="close-btn" onclick={() => onclose?.()} aria-label="Close export dialog">×</button>
    </div>

    <div class="export-body">
      {#if $currentNotebook}
        <div class="notebook-info">
          <h4>{$currentNotebook.name}</h4>
          <p>
            {$currentNotebook.cells.length} cells •
            Modified {new Date($currentNotebook.updatedAt).toLocaleDateString()}
          </p>
        </div>

        <div class="export-options">
          <div class="option-group">
            <h5>Choose an export type</h5>
            <div class="radio-group">
              {#each EXPORT_CHOICES as option}
                <label>
                  <input type="radio" bind:group={exportFormat} value={option.value} />
                  <span class="radio-label">
                    <strong>{option.title}</strong>
                    <small>{option.description}</small>
                  </span>
                </label>
              {/each}
            </div>
          </div>
        </div>
      {/if}
    </div>

    <div class="export-footer">
      <button class="cancel-btn" onclick={() => onclose?.()}>Cancel</button>
      <button class="export-btn" onclick={handleExport}>{activeChoice.button}</button>
    </div>
  </div>
</div>

<style>
  .export-modal {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .export-content {
    background: white;
    border-radius: 0.5rem;
    width: 90%;
    max-width: 540px;
    box-shadow: 0 20px 35px -15px rgba(0, 0, 0, 0.25);
    overflow: hidden;
  }

  .export-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1.25rem 1.5rem;
    border-bottom: 1px solid #e5e7eb;
  }

  .export-header h3 { margin: 0; font-size: 1.15rem; font-weight: 600; }

  .close-btn {
    background: none;
    border: none;
    font-size: 1.5rem;
    cursor: pointer;
    color: #6b7280;
    padding: 0;
    width: 2rem;
    height: 2rem;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .close-btn:hover { color: #374151; }

  .export-body { padding: 1.5rem; }

  .notebook-info {
    margin-bottom: 1.75rem;
    padding: 0.85rem 1rem;
    background: #f9fafb;
    border-radius: 0.4rem;
  }

  .notebook-info h4 { margin: 0 0 0.25rem 0; font-size: 1rem; font-weight: 600; }
  .notebook-info p { margin: 0; font-size: 0.85rem; color: #6b7280; }

  .option-group h5 { margin: 0 0 0.75rem 0; font-size: 0.85rem; font-weight: 600; color: #374151; }

  .radio-group { display: flex; flex-direction: column; gap: 0.5rem; }

  .radio-group label {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    cursor: pointer;
    padding: 0.55rem 0.6rem;
    border-radius: 0.4rem;
    transition: background-color 0.2s ease;
  }

  .radio-group label:hover { background: #f4f5f7; }

  .radio-label { display: flex; flex-direction: column; gap: 0.15rem; }
  .radio-label strong { font-weight: 600; color: #1f2933; }
  .radio-label small { font-size: 0.78rem; color: #64748b; }

  input[type="radio"] { margin: 0; margin-top: 0.2rem; }

  .export-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    padding: 1.25rem 1.5rem;
    border-top: 1px solid #e5e7eb;
  }

  .cancel-btn, .export-btn {
    padding: 0.55rem 1.1rem;
    border-radius: 0.4rem;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
    border: 1px solid transparent;
  }

  .cancel-btn { background: white; color: #374151; border-color: #d1d5db; }
  .cancel-btn:hover { background: #f3f4f6; }
  .export-btn { background: #1a1a1a; color: #ffffff; border-color: #1a1a1a; }
  .export-btn:hover { background: #111827; }
</style>
