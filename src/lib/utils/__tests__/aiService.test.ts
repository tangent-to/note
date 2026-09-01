/**
 * URL joining for the Ollama client.
 *
 * Both values that feed the base URL are pasted by hand — the proxy build
 * variable and the Base URL field — and both read naturally with `/api` already
 * on the end. Appending one unconditionally produced `…/api/api/chat`, which
 * Ollama answers with `path "/api/api/chat" not found`: a 404 that looks like a
 * broken client rather than a URL that was concatenated twice.
 */
import { describe, it, expect } from 'vitest';
import { isLocalBase, withApiPath } from '../aiService';

describe('withApiPath', () => {
  it('adds the segment when the base has none', () => {
    expect(withApiPath('https://ollama.com')).toBe('https://ollama.com/api');
    expect(withApiPath('https://note.workers.dev')).toBe('https://note.workers.dev/api');
    expect(withApiPath('/ollama')).toBe('/ollama/api');
  });

  it('leaves a base that already has it alone', () => {
    expect(withApiPath('https://ollama.com/api')).toBe('https://ollama.com/api');
    expect(withApiPath('http://localhost:11434/api')).toBe('http://localhost:11434/api');
  });

  it('collapses a segment that got added twice', () => {
    // The reported failure, and the value a proxy variable written with /api
    // still leaves in a reader's saved settings.
    expect(withApiPath('https://note.workers.dev/api/api')).toBe('https://note.workers.dev/api');
    expect(withApiPath('/ollama/api/api/api')).toBe('/ollama/api');
  });

  it('ignores trailing slashes', () => {
    expect(withApiPath('https://ollama.com/')).toBe('https://ollama.com/api');
    expect(withApiPath('https://ollama.com/api//')).toBe('https://ollama.com/api');
  });

  it('does not mistake a path segment merely containing "api"', () => {
    expect(withApiPath('https://host/rapid')).toBe('https://host/rapid/api');
    expect(withApiPath('https://host/api/v2')).toBe('https://host/api/v2/api');
  });
});

describe('isLocalBase', () => {
  it('recognises an Ollama on this machine, which needs no key', () => {
    expect(isLocalBase('http://localhost:11434')).toBe(true);
    expect(isLocalBase('http://127.0.0.1:11434/api')).toBe(true);
  });

  it('does not exempt Ollama Cloud', () => {
    expect(isLocalBase('https://ollama.com/api')).toBe(false);
    expect(isLocalBase('https://note.workers.dev/api')).toBe(false);
  });

  it('does not exempt the dev proxy', () => {
    // `/ollama/api` is served from localhost but forwards to ollama.com, which
    // does want a key. Treating it as local would let a keyless request through
    // and report it as a configuration success.
    expect(isLocalBase('/ollama/api')).toBe(false);
    expect(isLocalBase('')).toBe(false);
  });

  it('is not fooled by a hostname that merely starts with localhost', () => {
    expect(isLocalBase('http://localhost.example.com/api')).toBe(false);
  });
});
