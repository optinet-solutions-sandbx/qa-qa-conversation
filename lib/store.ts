'use client';

import { create } from 'zustand';
import type { Conversation, ConversationNote, PromptVersion } from './types';
import { loadFromSupabase } from './db-client';

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
}

export const useStore = create<AppState>((set) => ({
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
  },

  updateConversation: (c) => {
    set((s) => ({
      conversations: s.conversations.map((x) => (x.id === c.id ? c : x)),
    }));
  },

  deleteConversation: (id) => {
    set((s) => ({ conversations: s.conversations.filter((x) => x.id !== id) }));
  },

  addNote: (convId, note) => {
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === convId ? { ...c, notes: [...c.notes, note] } : c
      ),
    }));
  },

  updateNote: (convId, note) => {
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === convId
          ? { ...c, notes: c.notes.map((n) => (n.id === note.id ? note : n)) }
          : c
      ),
    }));
  },

  deleteNote: (convId, noteId) => {
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === convId ? { ...c, notes: c.notes.filter((n) => n.id !== noteId) } : c
      ),
    }));
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

  loadState: async () => {
    if (typeof window === 'undefined') return;

    const user = localStorage.getItem(USER_KEY) || '';

    const remote = await loadFromSupabase();
    if (remote) {
      // Only load prompts — conversations are fetched per-page by ConversationList
      set({ prompts: remote.prompts ?? [], currentUser: user, isLoaded: true });
      return;
    }

    // Supabase unavailable — start empty
    set({ conversations: [], prompts: [], currentUser: user, isLoaded: true });
  },
}));
