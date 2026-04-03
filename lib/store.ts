'use client';

import { create } from 'zustand';
import type { Conversation, ConversationNote, PromptVersion } from './types';
import { loadFromSupabase } from './db-client';

const CONV_KEY = 'qa-conv-v1';
const USER_KEY = 'qa_user';

interface AppState {
  conversations: Conversation[];
  prompts: PromptVersion[];
  currentUser: string;
  isLoaded: boolean;

  setCurrentUser: (name: string) => void;

  // Conversations
  addConversation: (c: Conversation) => void;
  updateConversation: (c: Conversation) => void;
  deleteConversation: (id: string) => void;

  // Notes
  addNote: (convId: string, note: ConversationNote) => void;
  updateNote: (convId: string, note: ConversationNote) => void;
  deleteNote: (convId: string, noteId: string) => void;

  // Prompts
  addPrompt: (p: PromptVersion) => void;
  updatePrompt: (p: PromptVersion) => void;
  deletePrompt: (id: string) => void;
  activatePrompt: (id: string) => void;

  loadState: () => Promise<void>;
  saveToLocalStorage: () => void;
}

export const useStore = create<AppState>((set, get) => ({
  conversations: [],
  prompts: [],
  currentUser: '',
  isLoaded: false,

  setCurrentUser: (name) => {
    set({ currentUser: name });
    if (typeof window !== 'undefined') {
      localStorage.setItem(USER_KEY, name);
    }
  },

  addConversation: (c) => {
    set((s) => ({ conversations: [c, ...s.conversations] }));
    get().saveToLocalStorage();
  },

  updateConversation: (c) => {
    set((s) => ({
      conversations: s.conversations.map((x) => (x.id === c.id ? c : x)),
    }));
    get().saveToLocalStorage();
  },

  deleteConversation: (id) => {
    set((s) => ({ conversations: s.conversations.filter((x) => x.id !== id) }));
    get().saveToLocalStorage();
  },

  addNote: (convId, note) => {
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === convId ? { ...c, notes: [...c.notes, note] } : c
      ),
    }));
    get().saveToLocalStorage();
  },

  updateNote: (convId, note) => {
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === convId
          ? { ...c, notes: c.notes.map((n) => (n.id === note.id ? note : n)) }
          : c
      ),
    }));
    get().saveToLocalStorage();
  },

  deleteNote: (convId, noteId) => {
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === convId ? { ...c, notes: c.notes.filter((n) => n.id !== noteId) } : c
      ),
    }));
    get().saveToLocalStorage();
  },

  addPrompt: (p) => {
    set((s) => ({ prompts: [p, ...s.prompts] }));
  },

  updatePrompt: (p) => {
    set((s) => ({
      prompts: s.prompts.map((x) => (x.id === p.id ? p : x)),
    }));
  },

  deletePrompt: (id) => {
    set((s) => ({ prompts: s.prompts.filter((x) => x.id !== id) }));
  },

  activatePrompt: (id) => {
    set((s) => ({
      prompts: s.prompts.map((p) => ({ ...p, is_active: p.id === id })),
    }));
  },

  saveToLocalStorage: () => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(CONV_KEY, JSON.stringify(get().conversations));
  },

  loadState: async () => {
    if (typeof window === 'undefined') return;

    const user = localStorage.getItem(USER_KEY) || '';

    // Try Supabase first
    const remote = await loadFromSupabase();
    if (remote) {
      let conversations = remote.conversations;
      if (conversations.length === 0) {
        try {
          const lc = localStorage.getItem(CONV_KEY);
          if (lc) conversations = JSON.parse(lc);
        } catch { /* ignore */ }
      }
      set({ conversations, prompts: remote.prompts ?? [], currentUser: user, isLoaded: true });
      return;
    }

    // Fallback: localStorage
    try {
      const lc = localStorage.getItem(CONV_KEY);
      set({
        conversations: lc ? JSON.parse(lc) : [],
        prompts: [],
        currentUser: user,
        isLoaded: true,
      });
    } catch {
      set({ conversations: [], prompts: [], currentUser: user, isLoaded: true });
    }
  },
}));
