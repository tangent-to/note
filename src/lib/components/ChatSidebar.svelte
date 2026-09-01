<script lang="ts">
  import { onMount } from 'svelte';
  import { aiService, CorsLikelyError, isWebDeployment, corsProxyConfigured, isLocalBase, type ChatMessage } from '../utils/aiService';
  import { loadAISettings, saveAISettings, clearStoredKey } from '../utils/aiSettings';
  import { buildSystemPrompt } from '../utils/notebookContext';
  import { buildCellEditPrompt, extractCodeFromMessage, targetCell } from '../utils/cellEdit';
  import { diffLines, diffStat } from '../utils/lineDiff';
  import { currentNotebook, selectedCellId } from '../stores/notebook';
  import { chatMessages, clearChatHistory, type Message, type ProposedEdit } from '../stores/chat';
  import { loadAIContext, saveAIContext, resetAIContext, DEFAULT_AI_CONTEXT } from '../utils/aiContext';

  interface Props {
    onclose?: () => void;
    oninsertCode?: (detail: { code: string }) => void;
    /** Write a cell's content, for applying and reverting a proposed edit. */
    oneditCell?: (detail: { cellId: string; content: string }) => void;
    /** Rendered inside the right panel's tab shell, which supplies the tab bar
     *  and the close button, so this drops its own heavy header chrome. */
    embedded?: boolean;
  }

  let { onclose, oninsertCode, oneditCell, embedded = false }: Props = $props();

  // Chat history is held in a persisted module store (src/lib/stores/chat),
  // accessed below as $chatMessages, so it survives closing/reopening the
  // sidebar and a page reload.
  let inputValue = $state('');
  let inputEl: HTMLTextAreaElement | null = $state(null);
  let isLoading = $state(false);
  /** How tall the composer grows before it scrolls instead (~8 lines). Mirrored
   *  by .chat-input's max-height, which guards the moments before this runs. */
  const MAX_INPUT_HEIGHT = 200;
  let messagesContainer: HTMLDivElement = $state(null as any);
  let isConfigured = $state(false);
  let showSettings = $state(false);

  // Ollama Cloud settings
  let apiKey = $state('');
  let baseUrl = $state('');
  let model = $state('');
  let rememberKey = $state(false);

  // Edit mode: the next message is a request to rewrite the selected cell,
  // answered with a proposal rather than prose. The target is always the cell
  // the reader has selected in the notebook — asking them to pick one twice, in
  // two places, would be one place too many.
  let editMode = $state(false);
  const editTarget = $derived(targetCell($currentNotebook, $selectedCellId));
  // Nothing selected, nothing to rewrite: the switch has no meaning then, and
  // leaving it on would silently send an ordinary question.
  const canEdit = $derived(Boolean(editTarget));

  // User-editable reference text appended to the assistant's system prompt.
  let aiContext = $state('');
  let contextSaved = $state(false);

  // Only a concern on a deployed web build with no CORS proxy configured:
  // direct browser calls to ollama.com would be blocked by CORS.
  const showCorsNotice = isWebDeployment() && !corsProxyConfigured();

  onMount(() => {
    const config = loadAISettings();
    apiKey = config.apiKey;
    baseUrl = config.baseUrl;
    model = config.model;
    rememberKey = config.rememberKey;
    isConfigured = aiService.isConfigured();
    aiContext = loadAIContext();
  });

  // The composer follows its text instead of staying one line tall and
  // scrolling inside itself, which hid all but the last line of anything longer
  // than a sentence. Height is measured from scrollHeight after collapsing the
  // box, because scrollHeight never shrinks on its own — without the reset,
  // deleting text would leave the box at its high-water mark.
  $effect(() => {
    const el = inputEl;
    // Read the value so this re-runs on every keystroke, and on the reset that
    // follows a send.
    inputValue;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > MAX_INPUT_HEIGHT ? 'auto' : 'hidden';
  });

  function handleContextSave() {
    saveAIContext(aiContext);
    contextSaved = true;
    setTimeout(() => (contextSaved = false), 1500);
  }

  function handleContextReset() {
    resetAIContext();
    aiContext = DEFAULT_AI_CONTEXT;
    saveAIContext(aiContext);
  }

  function handleSettingsSave() {
    const config = saveAISettings({
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim(),
      model: model.trim(),
    }, rememberKey);
    apiKey = config.apiKey;
    baseUrl = config.baseUrl;
    model = config.model;
    rememberKey = config.rememberKey;
    isConfigured = aiService.isConfigured();
    if (isConfigured) showSettings = false;
  }

  function handleDisconnect() {
    apiKey = '';
    rememberKey = false;
    aiService.configure({ apiKey: '' });
    clearStoredKey();
    isConfigured = false;
  }

  async function sendMessage() {
    if (!inputValue.trim() || isLoading) return;

    const userMessage: Message = {
      id: `msg-${Date.now()}-${Math.random()}`,
      role: 'user',
      content: inputValue.trim(),
      timestamp: Date.now()
    };

    $chatMessages = [...$chatMessages, userMessage];
    inputValue = '';
    isLoading = true;

    setTimeout(scrollToBottom, 0);

    // Pin the target now. The reply takes seconds to arrive and the reader may
    // well click another cell meanwhile; an edit that landed on whichever cell
    // happened to be selected on arrival would be the worst kind of bug here.
    const target = editMode ? editTarget : null;
    const notebook = $currentNotebook;

    try {
      // Send the recent conversation, with the current notebook injected as the
      // system prompt so the assistant can reason about the user's cells.
      const conversation: ChatMessage[] = $chatMessages
        .slice(-10)
        .map(m => ({ role: m.role, content: m.content }));

      const system = target && notebook
        ? buildCellEditPrompt(notebook, target)
        : buildSystemPrompt();
      const reply = await aiService.chat(conversation, system);

      const assistantMessage: Message = {
        id: `msg-${Date.now()}-${Math.random()}`,
        role: 'assistant',
        content: reply || '(no response)',
        timestamp: Date.now()
      };

      if (target && reply) {
        const after = extractCodeFromMessage(reply);
        // A reply identical to the cell is not a proposal; showing an empty
        // diff with an Apply button under it would be theatre.
        if (after && after !== target.cell.content) {
          assistantMessage.edit = {
            cellId: target.cell.id,
            cellNumber: target.number,
            before: target.cell.content,
            after,
            applied: false,
          };
        }
      }

      $chatMessages = [...$chatMessages, assistantMessage];
    } catch (error: any) {
      const hint = error instanceof CorsLikelyError ? error.message : `Error: ${error.message}`;
      const errorMessage: Message = {
        id: `msg-${Date.now()}-${Math.random()}`,
        role: 'assistant',
        content: hint,
        timestamp: Date.now()
      };
      $chatMessages = [...$chatMessages, errorMessage];
    } finally {
      isLoading = false;
      setTimeout(scrollToBottom, 0);
    }
  }

  /** The cell as it stands now, or null if it has since been deleted. */
  function liveContent(edit: ProposedEdit): string | null {
    const cell = $currentNotebook?.cells.find(c => c.id === edit.cellId);
    return cell ? cell.content : null;
  }

  /**
   * Has the cell moved on since this proposal was made?
   *
   * Worth saying out loud rather than silently overwriting: a proposal survives
   * a page reload, so the cell underneath it may have been edited by hand in
   * between. Applying anyway is a fair choice; putting back a "before" that is
   * no longer what is there is not, so that direction is refused.
   */
  function isStaleEdit(edit: ProposedEdit): boolean {
    const live = liveContent(edit);
    if (live === null) return true;
    return live !== (edit.applied ? edit.after : edit.before);
  }

  function toggleEdit(message: Message) {
    const edit = message.edit;
    if (!edit) return;
    if (edit.applied && isStaleEdit(edit)) return;
    oneditCell?.({ cellId: edit.cellId, content: edit.applied ? edit.before : edit.after });
    $chatMessages = $chatMessages.map(m =>
      m.id === message.id ? { ...m, edit: { ...edit, applied: !edit.applied } } : m
    );
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  }

  function scrollToBottom() {
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  }

  function clearChat() {
    clearChatHistory();
  }
</script>

<div class="chat-sidebar" class:embedded>
  <div class="chat-header">
    <h2>AI Assistant</h2>
    <div class="header-actions">
      <button class="icon-btn" onclick={() => showSettings = !showSettings} title="Settings">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"/>
          <path d="M12 1v6m0 6v6M5.6 5.6l4.2 4.2m4.2 4.2l4.2 4.2M1 12h6m6 0h6M5.6 18.4l4.2-4.2m4.2-4.2l4.2-4.2"/>
        </svg>
      </button>
      {#if !embedded}
        <button class="icon-btn" onclick={() => onclose?.()} title="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      {/if}
    </div>
  </div>

  {#if showSettings}
    <div class="settings-panel">
      <h3>Ollama Cloud Settings</h3>

      <div class="info-box">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <path d="M12 16v-4M12 8h.01"/>
        </svg>
        <p>
          Powered by <strong>Ollama Cloud</strong>. Get an API key at
          <a href="https://ollama.com/settings/keys" target="_blank">ollama.com</a>.
        </p>
      </div>

      {#if showCorsNotice}
        <div class="warn-box">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <path d="M12 9v4M12 17h.01"/>
          </svg>
          <p>
            This deployment has no Ollama proxy configured, so the browser will
            block calls to Ollama Cloud (CORS). Run the app locally (the dev server
            proxies requests), or deploy the bundled Cloudflare proxy and set
            <code>VITE_OLLAMA_PROXY_URL</code> (see <code>workers/ollama-proxy</code>).
          </p>
        </div>
      {/if}

      {#if isConfigured}
        <div class="status-connected">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <path d="M9 12l2 2 4-4"/>
          </svg>
          <span>Connected to {isLocalBase(baseUrl) ? 'local Ollama' : 'Ollama Cloud'} ({model})</span>
        </div>
        <button class="btn-secondary" onclick={handleDisconnect}>Disconnect</button>
      {:else}
        <div class="form-group">
          <label for="ollama-key">API Key{isLocalBase(baseUrl) ? ' (not needed)' : ''}</label>
          <input
            id="ollama-key"
            type="password"
            bind:value={apiKey}
            placeholder={isLocalBase(baseUrl) ? 'Local Ollama needs no key' : 'Your Ollama Cloud API key'}
            class="input"
          />
          <label class="remember-row">
            <input type="checkbox" bind:checked={rememberKey} />
            Remember key on this device
          </label>
          {#if rememberKey}
            <p class="key-warning">
              ⚠ Stored unencrypted in this browser (localStorage). Avoid on shared
              or public devices. Unchecked, the key is kept only until you close the tab.
            </p>
          {/if}
        </div>

        <div class="form-group">
          <label for="ollama-model">Model</label>
          <input
            id="ollama-model"
            type="text"
            bind:value={model}
            placeholder="qwen3-coder:480b-cloud"
            class="input"
          />
          <p class="help-text">e.g. <code>qwen3-coder:480b-cloud</code>, <code>gpt-oss:120b-cloud</code></p>
        </div>

        <div class="form-group">
          <label for="ollama-url">Base URL</label>
          <input
            id="ollama-url"
            type="text"
            bind:value={baseUrl}
            placeholder="https://ollama.com/api"
            class="input"
          />
          <p class="help-text">
            Leave as default unless you route through a proxy. For an Ollama on
            this machine, use <code>http://localhost:11434</code> — no API key is
            needed, and Ollama already allows requests from localhost origins.
          </p>
        </div>

        <div class="settings-actions">
          <button
            class="btn-primary"
            onclick={handleSettingsSave}
            disabled={!apiKey.trim() && !isLocalBase(baseUrl)}
          >Connect</button>
          <button class="btn-secondary" onclick={() => showSettings = false}>Cancel</button>
        </div>
      {/if}

      <div class="form-group context-group">
        <label for="ai-context">Assistant context</label>
        <p class="help-text">
          Appended to the system prompt on every chat. Defaults to a Tangent,
          Observable Plot and Arquero cheatsheet. Edit to fit your work.
        </p>
        <textarea
          id="ai-context"
          bind:value={aiContext}
          rows="8"
          class="input context-textarea"
          placeholder="Reference notes for the assistant..."
        ></textarea>
        <div class="settings-actions">
          <button class="btn-primary" onclick={handleContextSave}>{contextSaved ? 'Saved' : 'Save context'}</button>
          <button class="btn-secondary" onclick={handleContextReset}>Reset to default</button>
        </div>
      </div>
    </div>
  {/if}

  {#if !isConfigured && !showSettings}
    <div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
      </svg>
      <h3>Connect Ollama Cloud</h3>
      <p>Add your API key to start chatting about your notebook</p>
      <button class="btn-primary" onclick={() => showSettings = true}>Configure</button>
    </div>
  {:else if isConfigured}
    <div class="chat-content">
      <div class="messages-container" bind:this={messagesContainer}>
        {#if $chatMessages.length === 0}
          <div class="empty-chat">
            <p>Start a conversation with the AI assistant</p>
            <div class="suggestions">
              <button class="suggestion" onclick={() => inputValue = 'Create a bar chart with D3.js'}>
                Create a bar chart
              </button>
              <button class="suggestion" onclick={() => inputValue = 'Load and analyze CSV data with Arquero'}>
                Analyze CSV data
              </button>
              <button class="suggestion" onclick={() => inputValue = 'Explain what my notebook does'}>
                Explain my notebook
              </button>
            </div>
          </div>
        {/if}

        {#each $chatMessages as message (message.id)}
          <div class="message message-{message.role}">
            <div class="message-avatar">
              {#if message.role === 'user'}
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="8" r="4"/>
                  <path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/>
                </svg>
              {:else}
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
              {/if}
            </div>
            <div class="message-content">
              {#if message.edit}
                {@const edit = message.edit}
                {@const lines = diffLines(edit.before, edit.after)}
                {@const stat = diffStat(lines)}
                {@const gone = liveContent(edit) === null}
                {@const stale = isStaleEdit(edit)}
                <div class="proposal" class:applied={edit.applied}>
                  <div class="proposal-head">
                    <span class="proposal-title">Cell {edit.cellNumber}</span>
                    <span class="proposal-stat">+{stat.added} −{stat.removed}</span>
                  </div>
                  <!-- The diff, not the new version: a model asked to fix one
                       line will also reword a comment, and side by side nobody
                       sees it. -->
                  <div class="diff">
                    {#each lines as line}
                      <div class="diff-line diff-{line.op}"><span class="diff-sign"
                        >{line.op === 'add' ? '+' : line.op === 'remove' ? '−' : ' '}</span
                      >{line.text || ' '}</div>
                    {/each}
                  </div>
                  {#if gone}
                    <p class="proposal-note">That cell has been deleted.</p>
                  {:else if stale}
                    <p class="proposal-note">
                      {edit.applied
                        ? 'The cell has been edited since. Reverting would discard that work.'
                        : 'The cell has been edited since this was proposed.'}
                    </p>
                  {/if}
                  <div class="proposal-actions">
                    <button
                      class="apply-btn"
                      onclick={() => toggleEdit(message)}
                      disabled={gone || (edit.applied && stale)}
                    >{edit.applied ? 'Revert' : 'Apply to cell ' + edit.cellNumber}</button>
                  </div>
                </div>
              {:else}
                <div class="message-text">{message.content}</div>
                {#if message.role === 'assistant' && message.content && !message.content.startsWith('Error:') && !message.content.startsWith('Could not reach')}
                  <button
                    class="insert-btn"
                    onclick={() => oninsertCode?.({ code: message.content })}
                    title="Insert into notebook"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M12 5v14M5 12l7 7 7-7"/>
                    </svg>
                    Insert into notebook
                  </button>
                {/if}
              {/if}
            </div>
          </div>
        {/each}

        {#if isLoading}
          <div class="message message-assistant">
            <div class="message-avatar">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
            </div>
            <div class="message-content">
              <div class="typing-indicator">
                <span></span><span></span><span></span>
              </div>
            </div>
          </div>
        {/if}
      </div>

      <div class="target-bar">
        <button
          class="target-toggle"
          class:active={editMode && canEdit}
          disabled={!canEdit}
          onclick={() => (editMode = !editMode)}
          title={canEdit
            ? 'Answer with a rewrite of the selected cell instead of prose'
            : 'Select a cell in the notebook first'}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>
          </svg>
          {editTarget ? `Edit cell ${editTarget.number}` : 'Edit cell'}
        </button>
        {#if editMode && canEdit}
          <span class="target-hint">The reply becomes a proposed change you can apply.</span>
        {/if}
      </div>

      <div class="chat-input-container">
        {#if $chatMessages.length > 0}
          <button class="clear-btn" onclick={clearChat} title="Clear chat">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
            </svg>
          </button>
        {/if}
        <textarea
          bind:this={inputEl}
          bind:value={inputValue}
          onkeydown={handleKeydown}
          placeholder={editMode && editTarget
            ? `What should cell ${editTarget.number} do differently?`
            : 'Ask anything... (Enter to send, Shift+Enter for new line)'}
          class="chat-input"
          rows="1"
          disabled={isLoading}
        ></textarea>
        <button
          class="send-btn"
          onclick={sendMessage}
          disabled={!inputValue.trim() || isLoading}
          title="Send message"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
          </svg>
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .chat-sidebar {
    display: flex;
    flex-direction: column;
    height: 100%;
    background-color: var(--bg);
  }

  .chat-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem;
    border-bottom: 1px solid var(--border);
    background-color: var(--surface);
  }

  .chat-header h2 {
    font-size: 1rem;
    font-weight: 600;
    color: var(--heading);
    margin: 0;
  }

  /* Inside the panel's tab shell the tab bar is the frame, so the chat header
     drops to a section label matching the Console and Variables tabs. */
  .chat-sidebar.embedded .chat-header {
    padding: 1rem 1rem 0.5rem;
    border-bottom: none;
    background-color: transparent;
  }

  .chat-sidebar.embedded .chat-header h2 { font-size: 0.85rem; }

  .header-actions {
    display: flex;
    gap: 0.5rem;
  }

  .icon-btn {
    background: transparent;
    border: none;
    padding: 0.35rem;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: var(--radius-pill);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
  }

  .icon-btn:hover {
    background-color: var(--surface-hover);
    color: var(--heading);
  }

  .settings-panel {
    padding: 1rem;
    background-color: var(--surface);
    border-bottom: 1px solid var(--border);
  }

  .settings-panel h3 {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--heading);
    margin: 0 0 1rem 0;
  }

  .info-box {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.75rem;
    background-color: var(--accent-weak-bg);
    border: 1px solid var(--accent-weak-border);
    border-radius: var(--radius-input);
    color: var(--accent-weak-fg);
    font-size: 0.8125rem;
    margin-bottom: 1rem;
    line-height: 1.5;
  }

  .info-box svg { flex-shrink: 0; margin-top: 0.125rem; }
  .info-box p { margin: 0; }
  .info-box a { color: var(--accent); font-weight: 600; }

  .warn-box {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.75rem;
    background-color: var(--warn-bg);
    border: 1px solid var(--warn-border);
    border-radius: var(--radius-input);
    color: var(--warn-fg);
    font-size: 0.8125rem;
    margin-bottom: 1rem;
    line-height: 1.5;
  }

  .warn-box svg { flex-shrink: 0; margin-top: 0.125rem; }
  .warn-box p { margin: 0; }
  .warn-box code {
    background-color: var(--surface-2);
    padding: 0.0625rem 0.25rem;
    border-radius: var(--radius-input);
    font-family: var(--font-mono);
    font-size: 0.7rem;
  }

  .status-connected {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem;
    background-color: var(--accent-weak-bg);
    border: 1px solid var(--accent-weak-border);
    border-radius: var(--radius-input);
    color: var(--accent-weak-fg);
    font-size: 0.875rem;
    margin-bottom: 0.75rem;
  }

  .form-group { margin-bottom: 1rem; }

  .form-group label {
    display: block;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--heading);
    margin-bottom: 0.5rem;
  }

  .input {
    width: 100%;
    padding: 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-input);
    font-size: 0.875rem;
    transition: border-color 0.15s;
  }

  input.input { font-family: var(--font-mono); }

  /* The editable assistant-context field sits in its own section, divided from
     the connection settings above it. */
  .context-group {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
  }

  .context-textarea {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    line-height: 1.5;
    min-height: 9rem;
    resize: vertical;
  }

  .input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent);
  }

  .remember-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.5rem;
    font-size: 0.8125rem;
    font-weight: 400;
    color: var(--text);
    cursor: pointer;
  }
  .remember-row input { cursor: pointer; }

  .key-warning {
    margin: 0.4rem 0 0;
    padding: 0.4rem 0.5rem;
    background-color: var(--warn-bg);
    border: 1px solid var(--warn-border);
    border-radius: var(--radius-input);
    font-size: 0.75rem;
    line-height: 1.4;
    color: var(--warn-fg);
  }

  .help-text { font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem; }
  .help-text code {
    background-color: var(--surface-2);
    padding: 0.0625rem 0.25rem;
    border-radius: var(--radius-input);
    font-family: var(--font-mono);
    font-size: 0.7rem;
  }

  .settings-actions { display: flex; gap: 0.5rem; }

  .btn-primary, .btn-secondary {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: var(--radius-pill);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-primary { background-color: var(--accent-solid); color: var(--accent-on-solid); }
  .btn-primary:hover:not(:disabled) { background-color: var(--accent-solid-hover); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-secondary { background-color: var(--surface-2); color: var(--heading); }
  .btn-secondary:hover { background-color: var(--surface-hover); }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 3rem 1.5rem;
    text-align: center;
    color: var(--text-muted);
  }

  .empty-state svg { margin-bottom: 1rem; color: var(--text-faint); }
  .empty-state h3 { font-size: 1rem; font-weight: 600; color: var(--heading); margin: 0 0 0.5rem 0; }
  .empty-state p { font-size: 0.875rem; margin: 0 0 1.5rem 0; }

  .chat-content { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
  .messages-container { flex: 1; overflow-y: auto; padding: 1rem; }

  .empty-chat { text-align: center; padding: 2rem 1rem; color: var(--text-muted); }
  .empty-chat p { margin-bottom: 1.5rem; font-size: 0.875rem; }

  .suggestions { display: flex; flex-direction: column; gap: 0.5rem; }

  .suggestion {
    padding: 0.75rem;
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    font-size: 0.875rem;
    color: var(--heading);
    cursor: pointer;
    text-align: left;
    transition: all 0.15s;
  }

  .suggestion:hover { background-color: var(--surface-hover); border-color: var(--border-strong); }

  .message { display: flex; gap: 0.75rem; margin-bottom: 1.5rem; }

  .message-avatar {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-pill);
    background-color: var(--surface-2);
    color: var(--text-muted);
  }

  .message-user .message-avatar { background-color: var(--accent-weak-bg); color: var(--accent-weak-fg); }
  .message-content { flex: 1; min-width: 0; }

  .message-text {
    background-color: var(--surface-2);
    padding: 0.75rem;
    border-radius: var(--radius-card);
    font-size: 0.875rem;
    line-height: 1.5;
    color: var(--text);
    word-wrap: break-word;
    white-space: pre-wrap;
    font-family: var(--font-mono);
    border: 1px solid var(--border);
  }

  .message-user .message-text { background-color: var(--accent-solid); color: var(--accent-on-solid); }

  .insert-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.5rem;
    padding: 0.375rem 0.75rem;
    background-color: var(--accent-solid);
    color: var(--accent-on-solid);
    border: none;
    border-radius: var(--radius-pill);
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .insert-btn:hover { background-color: var(--accent-solid-hover); }

  .typing-indicator { display: flex; gap: 0.25rem; padding: 0.75rem; }

  .typing-indicator span {
    width: 8px;
    height: 8px;
    border-radius: var(--radius-pill);
    background-color: var(--text-faint);
    animation: typing 1.4s infinite;
  }

  .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
  .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }

  @keyframes typing {
    0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
    30% { opacity: 1; transform: translateY(-8px); }
  }

  /* Proposed cell rewrite: a diff plus one button, sitting where the reply's
     text would be. Deliberately quiet — this is a suggestion until accepted. */
  .proposal {
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-input);
    overflow: hidden;
    background-color: var(--surface);
  }

  .proposal.applied { border-color: var(--accent); }

  .proposal-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid var(--border);
  }

  .proposal-title {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--heading);
  }

  .proposal-stat {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--text-faint);
  }

  .diff {
    font-family: var(--font-mono);
    font-size: 0.72rem;
    line-height: 1.5;
    max-height: 320px;
    overflow: auto;
    padding: 0.3rem 0;
  }

  .diff-line {
    display: flex;
    gap: 0.4rem;
    padding: 0 0.6rem;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .diff-sign {
    flex-shrink: 0;
    color: var(--text-faint);
    user-select: none;
  }

  /* Colour carries the sign, but the sign is there too: a diff read with no
     colour vision still has to be readable. */
  .diff-add { background-color: color-mix(in srgb, var(--accent) 14%, transparent); }
  .diff-remove {
    background-color: color-mix(in srgb, var(--danger-fg) 12%, transparent);
    color: var(--text-muted);
  }

  .proposal-note {
    margin: 0;
    padding: 0.4rem 0.6rem;
    font-size: 0.72rem;
    color: var(--text-muted);
    border-top: 1px solid var(--border);
  }

  .proposal-actions {
    display: flex;
    gap: 0.4rem;
    padding: 0.45rem 0.6rem;
    border-top: 1px solid var(--border);
  }

  .apply-btn {
    padding: 0.3rem 0.7rem;
    background-color: var(--accent-solid);
    color: var(--accent-on-solid);
    border: none;
    border-radius: var(--radius-pill);
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
  }

  .apply-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .target-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem 0;
    background-color: var(--surface);
  }

  .target-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    flex-shrink: 0;
    padding: 0.25rem 0.6rem;
    background: transparent;
    color: var(--text-muted);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill);
    font-size: 0.72rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .target-toggle:hover:not(:disabled) { background-color: var(--surface-hover); color: var(--text); }
  .target-toggle:disabled { opacity: 0.5; cursor: not-allowed; }

  .target-toggle.active {
    background-color: var(--accent-weak-bg);
    border-color: var(--accent);
    color: var(--heading);
  }

  .target-hint {
    font-size: 0.7rem;
    color: var(--text-faint);
    min-width: 0;
  }

  .chat-input-container {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
    padding: 1rem;
    background-color: var(--surface);
    border-top: 1px solid var(--border);
  }

  .clear-btn {
    flex-shrink: 0;
    padding: 0.5rem;
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: var(--radius-pill);
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .clear-btn:hover { background-color: var(--surface-hover); color: var(--heading); }

  .chat-input {
    flex: 1;
    padding: 0.625rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-input);
    font-size: 0.875rem;
    line-height: 1.5;
    resize: none;
    /* Mirrors MAX_INPUT_HEIGHT: the script sizes the box to its content and
       clamps here; this line only covers the first paint. */
    max-height: 200px;
    font-family: inherit;
    transition: border-color 0.15s;
  }

  .chat-input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent);
  }

  .chat-input:disabled { opacity: 0.6; cursor: not-allowed; }

  .send-btn {
    flex-shrink: 0;
    padding: 0.625rem;
    background-color: var(--accent-solid);
    color: var(--accent-on-solid);
    border: none;
    border-radius: var(--radius-pill);
    cursor: pointer;
    transition: background-color 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .send-btn:hover:not(:disabled) { background-color: var(--accent-solid-hover); }
  .send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
