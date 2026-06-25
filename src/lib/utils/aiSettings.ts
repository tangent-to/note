import { aiService, defaultBaseUrl, DEFAULT_MODEL, type OllamaConfig } from './aiService';

// Persist the Ollama Cloud configuration in localStorage and keep the shared
// aiService instance in sync.

const STORAGE_KEY = 'ollama-cloud-settings';

export function loadAISettings(): OllamaConfig {
  const config: OllamaConfig = {
    apiKey: '',
    baseUrl: defaultBaseUrl(),
    model: DEFAULT_MODEL,
  };

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (typeof parsed.apiKey === 'string') config.apiKey = parsed.apiKey;
      if (typeof parsed.baseUrl === 'string' && parsed.baseUrl) config.baseUrl = parsed.baseUrl;
      if (typeof parsed.model === 'string' && parsed.model) config.model = parsed.model;
    }
  } catch (error) {
    console.warn('Failed to load AI settings:', error);
  }

  aiService.configure(config);
  return config;
}

export function saveAISettings(config: Partial<OllamaConfig>): OllamaConfig {
  aiService.configure(config);
  const merged = aiService.getConfig();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch (error) {
    console.warn('Failed to save AI settings:', error);
  }
  return merged;
}
