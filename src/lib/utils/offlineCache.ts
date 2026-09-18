/**
 * Registering the offline cache, and asking it what it holds.
 *
 * The cache itself is public/sw.js — a service worker, because it is the only
 * thing that sees every request the page and its kernel workers make, including
 * the URLs a library builds while it runs. This module is the app's side: it
 * registers the worker, and relays the two questions the Storage panel asks.
 *
 * Registered only in a built app served over localhost or https, which is what
 * a service worker requires. The Vite dev server is left alone: a worker
 * caching modules there would serve yesterday's build while you edit.
 */
import { writable } from 'svelte/store';

export interface CacheStats {
  /** Files of the app itself, which is what lets it open with no network. */
  app: number;
  /** Everything fetched from elsewhere: libraries, soundfonts, data. */
  remote: number;
}

export const offlineReady = writable(false);
export const cacheStats = writable<CacheStats | null>(null);
/** False while the browser says there is no network. */
export const online = writable(true);

function ask<T>(type: string, timeout = 3000): Promise<T | null> {
  const worker = navigator.serviceWorker?.controller;
  if (!worker) return Promise.resolve(null);
  return new Promise((resolve) => {
    const done = (value: T | null) => {
      navigator.serviceWorker.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(value);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === `${type}:result`) done(event.data as T);
    };
    const timer = setTimeout(() => done(null), timeout);
    navigator.serviceWorker.addEventListener('message', onMessage);
    worker.postMessage({ type });
  });
}

export async function refreshCacheStats(): Promise<void> {
  const stats = await ask<CacheStats & { type: string }>('cache-stats');
  cacheStats.set(stats ? { app: stats.app ?? 0, remote: stats.remote ?? 0 } : null);
}

/** Drop what came from elsewhere. The app's own files stay, so it still opens. */
export async function clearRemoteCache(): Promise<boolean> {
  const result = await ask<{ cleared: boolean }>('cache-clear');
  await refreshCacheStats();
  return Boolean(result?.cleared);
}

export function startOfflineCache(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  online.set(navigator.onLine);
  window.addEventListener('online', () => online.set(true));
  window.addEventListener('offline', () => online.set(false));

  // Not in dev: the worker would answer with the previous build while Vite is
  // rebuilding the current one.
  if ((import.meta as any).env?.DEV) return;

  navigator.serviceWorker
    .register('/sw.js')
    .then(async () => {
      await navigator.serviceWorker.ready;
      offlineReady.set(true);
      await refreshCacheStats();
    })
    .catch((error) => {
      // No offline cache, but everything else still works.
      console.warn('The offline cache could not start:', error);
    });
}
