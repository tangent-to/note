/**
 * The save message to the `note serve` companion: the path names the file,
 * the content is what gets written. The caller once passed them the other way
 * round, and the companion refused the "path" (the whole notebook) as being
 * outside its directory, so the wire shape is pinned here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const sent: string[] = [];

class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) {
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) { sent.push(data); }
  close() {}
}

describe('saveThroughSync', () => {
  beforeEach(() => {
    sent.length = 0;
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:4321' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('sends the path as the key and the content as the payload', async () => {
    const sync = await import('../serverSync');
    sync.connectSync({ onLoad() {}, onConflict() {}, onSaved() {} });
    await Promise.resolve(); // the fake socket opens
    const ok = sync.saveThroughSync('guava/analysis.js', '// ---\n// title: x\n// ---\n', false);
    expect(ok).toBe(true);
    const msg = JSON.parse(sent.at(-1)!);
    expect(msg.type).toBe('save');
    expect(msg.path).toBe('guava/analysis.js');
    expect(msg.content).toBe('// ---\n// title: x\n// ---\n');
    expect(msg.force).toBe(false);
  });

  it('refuses a notebook where a path belongs', async () => {
    const sync = await import('../serverSync');
    sync.connectSync({ onLoad() {}, onConflict() {}, onSaved() {} });
    await Promise.resolve();
    expect(() => sync.saveThroughSync('// ---\n// title: x\n', 'guava/analysis.js'))
      .toThrow(/expected a path first/);
  });
});
