import { writable } from 'svelte/store';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'tangent-theme';

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

/** The theme that's already applied to <html> (set by the inline boot script in
 *  index.html before first paint), falling back to stored / system preference. */
function initialTheme(): Theme {
  if (typeof document !== 'undefined') {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'light' || attr === 'dark') return attr;
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // localStorage unavailable (private mode); fall through to system.
  }
  return systemPrefersDark() ? 'dark' : 'light';
}

export const theme = writable<Theme>(initialTheme());

if (typeof document !== 'undefined') {
  theme.subscribe((t) => {
    document.documentElement.setAttribute('data-theme', t);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      // Persisting is best-effort.
    }
  });
}

export function toggleTheme(): void {
  theme.update((t) => (t === 'dark' ? 'light' : 'dark'));
}
