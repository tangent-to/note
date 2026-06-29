import { writable } from 'svelte/store';

// Chat history lives in a module store (not in the ChatSidebar component) so it
// survives the sidebar being closed and reopened, and is persisted to
// localStorage so it also survives a page reload.

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
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
