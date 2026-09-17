/**
 * The companion's front door.
 *
 * Every page open in the reader's browser can send requests to localhost, and a
 * WebSocket ignores the same-origin policy. Before this guard, any site visited
 * while `note serve` ran could read and overwrite every notebook under the
 * served directory — verified by a handshake from `https://evil.example` that
 * the companion accepted. These cases are that attack and its variants.
 */
import { describe, it, expect } from 'vitest';
import { allowedOrigins, checkRequest } from '../../../../cli/requestGuard';

const PORT = 4321;
const headers = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()] ?? null;

describe('checkRequest', () => {
  it('lets the app itself in', () => {
    for (const host of ['localhost', '127.0.0.1']) {
      expect(checkRequest(headers({
        host: `${host}:${PORT}`,
        origin: `http://${host}:${PORT}`,
        'sec-fetch-site': 'same-origin',
      }), PORT).ok).toBe(true);
    }
  });

  it('refuses a WebSocket handshake from another site', () => {
    // The verified attack: a page on another origin opening /__sync.
    const result = checkRequest(headers({ host: `localhost:${PORT}`, origin: 'https://evil.example' }), PORT);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/evil\.example/);
  });

  it('refuses DNS rebinding, where the Host is the attacker’s name', () => {
    // The page is "same-origin" with itself on evil.example, now resolving to
    // 127.0.0.1; only the Host header gives it away.
    expect(checkRequest(headers({
      host: `evil.example:${PORT}`,
      origin: `http://evil.example:${PORT}`,
      'sec-fetch-site': 'same-origin',
    }), PORT).ok).toBe(false);
  });

  it('refuses the app on another port, which is another origin', () => {
    expect(checkRequest(headers({ host: `localhost:${PORT}`, origin: 'http://localhost:5173' }), PORT).ok).toBe(false);
  });

  it('refuses a cross-site request that carries no Origin', () => {
    // An <img> or a plain GET from another site: no Origin, but Sec-Fetch-Site says so.
    expect(checkRequest(headers({ host: `localhost:${PORT}`, 'sec-fetch-site': 'cross-site' }), PORT).ok).toBe(false);
    expect(checkRequest(headers({ host: `localhost:${PORT}`, 'sec-fetch-site': 'same-site' }), PORT).ok).toBe(false);
  });

  it('lets the reader open a file URL by typing it', () => {
    expect(checkRequest(headers({ host: `localhost:${PORT}`, 'sec-fetch-site': 'none' }), PORT).ok).toBe(true);
  });

  it('lets a local program through, which could read the files directly anyway', () => {
    expect(checkRequest(headers({ host: `localhost:${PORT}` }), PORT).ok).toBe(true);
    expect(checkRequest(headers({}), PORT).ok).toBe(true);
  });

  it('compares case-insensitively, as hosts and origins are', () => {
    expect(checkRequest(headers({ host: `LOCALHOST:${PORT}`, origin: `http://LocalHost:${PORT}` }), PORT).ok).toBe(true);
  });
});

describe('allowedOrigins', () => {
  it('is exactly this machine on this port', () => {
    expect([...allowedOrigins(PORT)].sort()).toEqual([
      'http://127.0.0.1:4321',
      'http://[::1]:4321',
      'http://localhost:4321',
    ]);
  });
});
