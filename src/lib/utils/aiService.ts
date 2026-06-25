// Ollama Cloud client.
//
// This app talks to a single provider: Ollama Cloud (https://ollama.com).
// Authentication is a Bearer API key, and chat/generation use the native
// `/api/chat` endpoint so we can pass a system prompt (used to inject the
// current notebook as context).
//
// CORS note: the deployed static web build calls ollama.com directly from the
// browser. During local development we route through a Vite dev proxy (see
// vite.config.ts) to avoid cross-origin issues. See README for the options.

export interface OllamaConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AICompletionRequest {
  code: string;
  cursor: number;
  language: string;
  context?: string;
}

export interface AICompletionResponse {
  completions: string[];
  suggestions: string[];
}

export interface AIGenerationRequest {
  prompt: string;
  language: string;
  context?: string;
  /** Optional system prompt (e.g. the current notebook as context). */
  system?: string;
}

export interface AIGenerationResponse {
  code: string;
  explanation?: string;
}

export const DEFAULT_MODEL = 'qwen3-coder:480b-cloud';

// In dev, hit the Vite proxy (`/ollama` -> https://ollama.com) so the browser
// never makes a cross-origin request. In production, call ollama.com directly.
export function defaultBaseUrl(): string {
  // import.meta.env.DEV is true under `vite dev`.
  const isDev = typeof import.meta !== 'undefined' && (import.meta as any).env?.DEV;
  return isDev ? '/ollama/api' : 'https://ollama.com/api';
}

// True when running as the deployed static web build (i.e. not the Vite dev
// server, which proxies requests to ollama.com for us). In a deployed build,
// calls go straight from the browser and may be blocked by CORS.
export function isWebDeployment(): boolean {
  if (typeof window === 'undefined') return false;
  const isDev = typeof import.meta !== 'undefined' && (import.meta as any).env?.DEV;
  return !isDev;
}

/** Raised when a request most likely failed because of a CORS/network block. */
export class CorsLikelyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorsLikelyError';
  }
}

function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:[a-zA-Z]+)?\n([\s\S]*?)\n```/);
  return (fenced ? fenced[1] : text).trim();
}

export class AIService {
  private config: OllamaConfig = {
    apiKey: '',
    baseUrl: defaultBaseUrl(),
    model: DEFAULT_MODEL,
  };

  configure(config: Partial<OllamaConfig>): void {
    this.config = { ...this.config, ...config };
    if (!this.config.baseUrl) this.config.baseUrl = defaultBaseUrl();
    if (!this.config.model) this.config.model = DEFAULT_MODEL;
  }

  getConfig(): OllamaConfig {
    return { ...this.config };
  }

  isConfigured(): boolean {
    return Boolean(this.config.apiKey && this.config.baseUrl && this.config.model);
  }

  private endpoint(path: string): string {
    return this.config.baseUrl.replace(/\/+$/, '') + path;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  /**
   * Core chat call. `system` is sent as the first message so models receive
   * the notebook context as a proper system prompt.
   */
  async chat(messages: ChatMessage[], system?: string): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error('Ollama Cloud is not configured. Add your API key in settings.');
    }

    const fullMessages: ChatMessage[] = system
      ? [{ role: 'system', content: system }, ...messages]
      : messages;

    let response: Response;
    try {
      response = await fetch(this.endpoint('/chat'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: this.config.model,
          messages: fullMessages,
          stream: false,
        }),
      });
    } catch (error: any) {
      // A thrown fetch (TypeError "Failed to fetch") almost always means the
      // request was blocked before a response came back — usually CORS.
      throw new CorsLikelyError(
        'Could not reach Ollama Cloud. This is usually a CORS restriction in the ' +
          'browser. Enable a CORS-unblocking browser extension for this site, or run ' +
          'the app locally (the dev server proxies requests for you). ' +
          `(${error?.message ?? 'network error'})`
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `Ollama Cloud rejected the request (${response.status}). Check that your ` +
            `API key is valid. ${detail}`.trim()
        );
      }
      throw new Error(`Ollama API error: ${response.status} ${response.statusText} ${detail}`.trim());
    }

    const data = await response.json();
    return data?.message?.content ?? '';
  }

  async getCodeCompletion(request: AICompletionRequest): Promise<AICompletionResponse> {
    if (!this.isConfigured()) {
      return { completions: [], suggestions: [] };
    }

    try {
      const system =
        `You are a ${request.language} code completion engine. ` +
        `Continue the code from where it ends. Respond with ONLY the raw code to ` +
        `insert at the cursor — no explanations, no markdown fences.` +
        (request.context ? `\n\nNotebook context:\n${request.context}` : '');

      const text = await this.chat([{ role: 'user', content: request.code }], system);
      const cleaned = stripCodeFences(text);
      return { completions: cleaned ? [cleaned] : [], suggestions: [] };
    } catch (error) {
      console.error('Ollama completion error:', error);
      return { completions: [], suggestions: [] };
    }
  }

  async generateCode(request: AIGenerationRequest): Promise<AIGenerationResponse> {
    const system =
      request.system ??
      `You are a helpful coding assistant embedded in a JavaScript notebook. ` +
        `Write clean, runnable ${request.language} suitable for a notebook cell. ` +
        `Prefer returning a single fenced code block, optionally followed by a short explanation.`;

    const userContent = request.context
      ? `${request.context}\n\n${request.prompt}`
      : request.prompt;

    const content = await this.chat([{ role: 'user', content: userContent }], system);

    const codeMatch = content.match(/```(?:javascript|js)?\n([\s\S]*?)\n```/);
    if (codeMatch) {
      const explanation = content
        .replace(/```(?:javascript|js)?\n[\s\S]*?\n```/, '')
        .trim();
      return { code: codeMatch[1].trim(), explanation: explanation || undefined };
    }

    return { code: content.trim() };
  }
}

// Singleton instance
export const aiService = new AIService();
