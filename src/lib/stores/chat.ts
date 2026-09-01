import { writable } from 'svelte/store';

// Chat history lives in a module store (not in the ChatSidebar component) so it
// survives the sidebar being closed and reopened, and is persisted to
// localStorage so it also survives a page reload.

/**
 * A cell rewrite the assistant offered, kept next to the reply that produced it.
 *
 * It stays inert until the reader applies it, and it keeps `before` so the same
 * button can put the cell back. Living in the persisted history means a proposal
 * survives closing the panel — the thing you were half-way through deciding
 * about is still there when you come back.
 */
export interface ProposedEdit {
  cellId: string;
  /** The cell's number when it was proposed, for the label. Cells renumber. */
  cellNumber: number;
  before: string;
  after: string;
  applied: boolean;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  /** Present when this reply was a cell rewrite rather than prose. */
  edit?: ProposedEdit;
}

const STORAGE_KEY = 'tangent-chat-history';
// Cap what we persist so a long-running session can't blow the localStorage
// quota. Older messages drop off the persisted tail.
const MAX_PERSISTED = 100;

function load(): Message[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as Message[];
    }
  } catch (error) {
    console.warn('Failed to load chat history:', error);
  }
  return [];
}

export const chatMessages = writable<Message[]>(load());

chatMessages.subscribe((messages) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-MAX_PERSISTED)));
  } catch (error) {
    console.warn('Failed to persist chat history:', error);
  }
});

export function clearChatHistory(): void {
  chatMessages.set([]);
}
