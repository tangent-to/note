/// <reference types="svelte" />
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional CORS proxy for Ollama Cloud (e.g. a Cloudflare Worker URL). */
  readonly VITE_OLLAMA_PROXY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
