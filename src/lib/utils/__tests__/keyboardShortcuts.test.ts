import { describe, it, expect, vi } from 'vitest';
import { handleGlobalKeydown } from '../keyboardShortcuts';

function makeEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: '',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent;
}

function makeHandlers() {
  return {
    showCommandPalette: vi.fn(),
    toggleChat: vi.fn(),
    toggleData: vi.fn(),
    save: vi.fn(),
    saveAs: vi.fn(),
    newNotebook: vi.fn(),
    importNotebook: vi.fn(),
    undo: vi.fn(),
  };
}

describe('handleGlobalKeydown', () => {
  it('opens Save As on Ctrl+Shift+S, and does not also save', () => {
    // Plain Save matches the same key; checked second, it would swallow this.
    const handlers = makeHandlers();
    expect(handleGlobalKeydown(makeEvent({ ctrlKey: true, shiftKey: true, key: 'S' }), handlers)).toBe(true);
    expect(handlers.saveAs).toHaveBeenCalledOnce();
    expect(handlers.save).not.toHaveBeenCalled();
  });

  it('triggers command palette on Ctrl+K', () => {
    const handlers = makeHandlers();
    const event = makeEvent({ ctrlKey: true, key: 'k' });
    const handled = handleGlobalKeydown(event, handlers);
    expect(handled).toBe(true);
    expect(handlers.showCommandPalette).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('triggers save on Ctrl+S', () => {
    const handlers = makeHandlers();
    const event = makeEvent({ ctrlKey: true, key: 's' });
    const handled = handleGlobalKeydown(event, handlers);
    expect(handled).toBe(true);
    expect(handlers.save).toHaveBeenCalledOnce();
  });

  it('triggers toggle chat on Ctrl+/', () => {
    const handlers = makeHandlers();
    const event = makeEvent({ ctrlKey: true, key: '/' });
    const handled = handleGlobalKeydown(event, handlers);
    expect(handled).toBe(true);
    expect(handlers.toggleChat).toHaveBeenCalledOnce();
  });

  it('triggers toggle data panel on Ctrl+Shift+D', () => {
    const handlers = makeHandlers();
    const event = makeEvent({ ctrlKey: true, shiftKey: true, key: 'D' });
    const handled = handleGlobalKeydown(event, handlers);
    expect(handled).toBe(true);
    expect(handlers.toggleData).toHaveBeenCalledOnce();
  });

  it('triggers new notebook on Ctrl+N', () => {
    const handlers = makeHandlers();
    const event = makeEvent({ ctrlKey: true, key: 'n' });
    const handled = handleGlobalKeydown(event, handlers);
    expect(handled).toBe(true);
    expect(handlers.newNotebook).toHaveBeenCalledOnce();
  });

  it('triggers import on Ctrl+O', () => {
    const handlers = makeHandlers();
    const event = makeEvent({ ctrlKey: true, key: 'o' });
    const handled = handleGlobalKeydown(event, handlers);
    expect(handled).toBe(true);
    expect(handlers.importNotebook).toHaveBeenCalledOnce();
  });

  it('returns false for unhandled keys', () => {
    const handlers = makeHandlers();
    const event = makeEvent({ key: 'a' });
    const handled = handleGlobalKeydown(event, handlers);
    expect(handled).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('works with metaKey (Cmd on Mac)', () => {
    const handlers = makeHandlers();
    const event = makeEvent({ metaKey: true, key: 's' });
    const handled = handleGlobalKeydown(event, handlers);
    expect(handled).toBe(true);
    expect(handlers.save).toHaveBeenCalledOnce();
  });
});
