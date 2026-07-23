export interface ShortcutHandler {
  showCommandPalette: () => void;
  toggleChat: () => void;
  toggleData: () => void;
  toggleConsole?: () => void;
  save: () => void;
  newNotebook: () => void;
  importNotebook: () => void;
  undo: () => void;
}

export function handleGlobalKeydown(event: KeyboardEvent, handlers: ShortcutHandler): boolean {
  // Command Palette: Ctrl/Cmd + K
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    handlers.showCommandPalette();
    return true;
  }

  // Toggle Chat: Ctrl/Cmd + / — but NOT while a code editor has focus:
  // CodeMirror binds Mod-/ to toggle-comment, and firing both actions on one
  // keystroke commented the current line AND opened the chat.
  if ((event.metaKey || event.ctrlKey) && event.key === '/') {
    if (typeof document !== 'undefined' && document.activeElement?.closest('.cm-editor')) {
      return false;
    }
    event.preventDefault();
    handlers.toggleChat();
    return true;
  }

  // Toggle Data panel: Ctrl/Cmd + Shift + D
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'd') {
    event.preventDefault();
    handlers.toggleData();
    return true;
  }

  // Toggle Console: Ctrl/Cmd + ` (backtick), the terminal-panel convention.
  // Plain backtick typing is unaffected (this needs the modifier).
  if ((event.metaKey || event.ctrlKey) && event.key === '`') {
    event.preventDefault();
    handlers.toggleConsole?.();
    return true;
  }

  // Save: Ctrl/Cmd + S
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    handlers.save();
    return true;
  }

  // New Notebook: Ctrl/Cmd + N
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    handlers.newNotebook();
    return true;
  }

  // Open Notebook: Ctrl/Cmd + O
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    handlers.importNotebook();
    return true;
  }

  // Undo: Ctrl/Cmd + Z (handled by undo system when no editor focused)
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
    const active = document.activeElement;
    const isInEditor = active?.closest('.cm-editor') || active?.tagName === 'TEXTAREA' || active?.tagName === 'INPUT';
    if (!isInEditor) {
      event.preventDefault();
      handlers.undo();
      return true;
    }
  }

  return false;
}
