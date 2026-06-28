<script lang="ts">
  import { onMount } from 'svelte';
  import { aiService, CorsLikelyError, isWebDeployment, corsProxyConfigured, type ChatMessage } from '../utils/aiService';
  import { loadAISettings, saveAISettings, clearStoredKey } from '../utils/aiSettings';
  import { buildSystemPrompt } from '../utils/notebookContext';

  interface Props {
    onclose?: () => void;
    oninsertCode?: (detail: { code: string }) => void;
  }

  let { onclose, oninsertCode }: Props = $props();

  interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
  }

  let messages: Message[] = $state([]);
  let inputValue = $state('');
  let isLoading = $state(false);
  let messagesContainer: HTMLDivElement = $state(null as any);
  let isConfigured = $state(false);
  let showSettings = $state(false);

  // Ollama Cloud settings
  let apiKey = $state('');
  let baseUrl = $state('');
  let model = $state('');
  let rememberKey = $state(false);

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
  });

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

    messages = [...messages, userMessage];
    inputValue = '';
    isLoading = true;

    setTimeout(scrollToBottom, 0);

    try {
      // Send the recent conversation, with the current notebook injected as the
      // system prompt so the assistant can reason about the user's cells.
      const conversation: ChatMessage[] = messages
        .slice(-10)
        .map(m => ({ role: m.role, content: m.content }));

      const reply = await aiService.chat(conversation, buildSystemPrompt());

      const assistantMessage: Message = {
        id: `msg-${Date.now()}-${Math.random()}`,
        role: 'assistant',
        content: reply || '(no response)',
        timestamp: Date.now()
      };

      messages = [...messages, assistantMessage];
    } catch (error: any) {
      const hint = error instanceof CorsLikelyError ? error.message : `Error: ${error.message}`;
      const errorMessage: Message = {
        id: `msg-${Date.now()}-${Math.random()}`,
        role: 'assistant',
        content: hint,
        timestamp: Date.now()
      };
      messages = [...messages, errorMessage];
    } finally {
      isLoading = false;
      setTimeout(scrollToBottom, 0);
    }
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
    messages = [];
  }
</script>

<div class="chat-sidebar">
  <div class="chat-header">
    <h2>AI Assistant</h2>
    <div class="header-actions">
      <button class="icon-btn" onclick={() => showSettings = !showSettings} title="Settings">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"/>
          <path d="M12 1v6m0 6v6M5.6 5.6l4.2 4.2m4.2 4.2l4.2 4.2M1 12h6m6 0h6M5.6 18.4l4.2-4.2m4.2-4.2l4.2-4.2"/>
        </svg>
      </button>
      <button class="icon-btn" onclick={() => onclose?.()} title="Close">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
      </button>
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
          <span>Connected to Ollama Cloud ({model})</span>
        </div>
        <button class="btn-secondary" onclick={handleDisconnect}>Disconnect</button>
      {:else}
        <div class="form-group">
          <label for="ollama-key">API Key</label>
          <input
            id="ollama-key"
            type="password"
            bind:value={apiKey}
            placeholder="Your Ollama Cloud API key"
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
          <p class="help-text">Leave as default unless you route through a proxy.</p>
        </div>

        <div class="settings-actions">
          <button class="btn-primary" onclick={handleSettingsSave} disabled={!apiKey.trim()}>Connect</button>
          <button class="btn-secondary" onclick={() => showSettings = false}>Cancel</button>
        </div>
      {/if}
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
        {#if messages.length === 0}
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

        {#each messages as message (message.id)}
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

      <div class="chat-input-container">
        {#if messages.length > 0}
          <button class="clear-btn" onclick={clearChat} title="Clear chat">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
            </svg>
          </button>
        {/if}
        <textarea
          bind:value={inputValue}
          onkeydown={handleKeydown}
          placeholder="Ask anything... (Enter to send, Shift+Enter for new line)"
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
    max-height: 120px;
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
