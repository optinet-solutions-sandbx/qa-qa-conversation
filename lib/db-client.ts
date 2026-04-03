/**
 * Client-side DB helpers.
 * All calls are proxied through /api/db so Supabase credentials
 * never leave the server. Fire-and-forget: errors are logged, never thrown.
 */
import type { Conversation, ConversationNote, PromptVersion } from './types';

async function call(action: string, payload: unknown): Promise<void> {
  try {
    await fetch('/api/db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, payload }),
    });
  } catch (e) {
    console.error('[db-client]', action, e);
  }
}

// ── Load ───────────────────────────────────────────────────────────────────

export async function loadFromSupabase(): Promise<{
  conversations: Conversation[];
  prompts: PromptVersion[];
} | null> {
  try {
    const res = await fetch('/api/db');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── Conversations ──────────────────────────────────────────────────────────

export const dbInsertConversation  = (c: Conversation)               => call('insertConversation', c);
export const dbUpdateConversation  = (c: Conversation)               => call('updateConversation', c);
export const dbDeleteConversation  = (id: string)                    => call('deleteConversation', { id });

// ── Notes ──────────────────────────────────────────────────────────────────

export const dbInsertNote = (convId: string, note: ConversationNote) => call('insertNote', { convId, note });
export const dbUpdateNote = (note: ConversationNote)                  => call('updateNote', note);
export const dbDeleteNote = (id: string)                              => call('deleteNote', { id });

// ── Prompts ────────────────────────────────────────────────────────────────

export const dbInsertPrompt   = (p: PromptVersion) => call('insertPrompt', p);
export const dbUpdatePrompt   = (p: PromptVersion) => call('updatePrompt', p);
export const dbDeletePrompt   = (id: string)        => call('deletePrompt', { id });
export const dbActivatePrompt = (id: string)        => call('activatePrompt', { id });
