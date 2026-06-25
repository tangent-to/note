import { aiService, defaultBaseUrl, DEFAULT_MODEL, type OllamaConfig } from './aiService';

// Persistence for the Ollama Cloud configuration.
//
// Security: the API key is kept in sessionStorage by default, so it is cleared
// when the browser tab closes. Non-sensitive settings (base URL, model) live in
// localStorage. Only if the user opts into "remember key" is the key also
// written to localStorage so it survives across sessions.

const SETTINGS_KEY = 'ollama-cloud-settings'; // non-sensitive: baseUrl, model, rememberKey
const KEY_KEY = 'ollama-cloud-key';           // the API key (session, or local if remembered)

export interface LoadedSettings extends OllamaConfig {
  rememberKey: boolean;
}

export function loadAISettings(): LoadedSettings {
  const config: OllamaConfig = {
    apiKey: '',
    baseUrl: defaultBaseUrl(),
    model: DEFAULT_MODEL,
  };
  let rememberKey = false;

  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (typeof parsed.baseUrl === 'string' && parsed.baseUrl) config.baseUrl = parsed.baseUrl;
      if (typeof parsed.model === 'string' && parsed.model) config.model = parsed.model;
      rememberKey = Boolean(parsed.rememberKey);
    }
  } catch (error) {
    console.warn('Failed to load AI settings:', error);
  }

  // Prefer the session key (this tab); fall back to a remembered key.
  try {
    const sessionKey = sessionStorage.getItem(KEY_KEY);
    const rememberedKey = rememberKey ? localStorage.getItem(KEY_KEY) : null;
    config.apiKey = sessionKey || rememberedKey || '';
  } catch (error) {
    console.warn('Failed to load API key:', error);
  }

  aiService.configure(config);
  return { ...config, rememberKey };
}

export function saveAISettings(config: Partial<OllamaConfig>, rememberKey = false): LoadedSettings {
  aiService.configure(config);
  const merged = aiService.getConfig();

  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ baseUrl: merged.baseUrl, model: merged.model, rememberKey })
    );
  } catch (error) {
    console.warn('Failed to save AI settings:', error);
  }

  // The key always lives in sessionStorage (cleared when the tab closes), and
  // additionally in localStorage only when the user chose to remember it.
  try {
    if (merged.apiKey) sessionStorage.setItem(KEY_KEY, merged.apiKey);
    else sessionStorage.removeItem(KEY_KEY);

    if (rememberKey && merged.apiKey) localStorage.setItem(KEY_KEY, merged.apiKey);
    else localStorage.removeItem(KEY_KEY);
  } catch (error) {
    console.warn('Failed to save API key:', error);
  }

  return { ...merged, rememberKey };
}

// Remove the API key from both stores (used by "Disconnect").
export function clearStoredKey(): void {
  try {
    sessionStorage.removeItem(KEY_KEY);
    localStorage.removeItem(KEY_KEY);
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      parsed.rememberKey = false;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(parsed));
    }
  } catch (error) {
    console.warn('Failed to clear API key:', error);
  }
}
