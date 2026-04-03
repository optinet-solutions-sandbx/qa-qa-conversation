import { supabase } from './supabase';
import type { Conversation, ConversationNote, PromptVersion } from './types';

// ── Conversations ──────────────────────────────────────────────────────────

function conversationRow(c: Conversation) {
  return {
    id: c.id,
    title: c.title,
    analyzed_at: c.analyzed_at,

    intercom_id: c.intercom_id,
    intercom_created_at: c.intercom_created_at,

    player_name: c.player_name,
    player_email: c.player_email,
    player_id: c.player_id,
    player_external_id: c.player_external_id,
    player_phone: c.player_phone,
    player_tags: c.player_tags,

    player_signed_up_at: c.player_signed_up_at,
    player_last_seen_at: c.player_last_seen_at,
    player_last_replied_at: c.player_last_replied_at,
    player_last_contacted_at: c.player_last_contacted_at,

    player_country: c.player_country,
    player_city: c.player_city,
    player_browser: c.player_browser,
    player_os: c.player_os,

    player_custom_attributes: c.player_custom_attributes,
    player_companies: c.player_companies,
    player_segments: c.player_segments,
    player_event_summaries: c.player_event_summaries,

    agent_name: c.agent_name,
    agent_email: c.agent_email,
    is_bot_handled: c.is_bot_handled,

    brand: c.brand,
    tags: c.tags,
    query_type: c.query_type,
    ai_subject: c.ai_subject,
    ai_issue_summary: c.ai_issue_summary,
    cx_score_rating: c.cx_score_rating,
    cx_score_explanation: c.cx_score_explanation,
    conversation_rating_score: c.conversation_rating_score,
    conversation_rating_remark: c.conversation_rating_remark,

    time_to_assignment: c.time_to_assignment,
    time_to_admin_reply: c.time_to_admin_reply,
    time_to_first_close: c.time_to_first_close,
    median_time_to_reply: c.median_time_to_reply,
    count_reopens: c.count_reopens,

    sentiment: c.sentiment,
    summary: c.summary,
    dissatisfaction_severity: c.dissatisfaction_severity,
    issue_category: c.issue_category,
    resolution_status: c.resolution_status,
    language: c.language,
    agent_performance_score: c.agent_performance_score,
    agent_performance_notes: c.agent_performance_notes,
    key_quotes: c.key_quotes,
    recommended_action: c.recommended_action,
    is_alert_worthy: c.is_alert_worthy,
    alert_reason: c.alert_reason,

    original_text: c.original_text,
  };
}

export async function dbInsertConversation(c: Conversation): Promise<void> {
  try {
    const { error } = await supabase.from('conversations').insert(conversationRow(c));
    if (error) console.error('[db] insert conversation:', error.message);
  } catch (e) {
    console.error('[db] insert conversation exception:', e);
  }
}

export async function dbUpdateConversation(c: Conversation): Promise<void> {
  try {
    const { id, ...row } = conversationRow(c);
    const { error } = await supabase.from('conversations').update(row).eq('id', id);
    if (error) console.error('[db] update conversation:', error.message);
  } catch (e) {
    console.error('[db] update conversation exception:', e);
  }
}

export async function dbDeleteConversation(id: string): Promise<void> {
  try {
    const { error } = await supabase.from('conversations').delete().eq('id', id);
    if (error) console.error('[db] delete conversation:', error.message);
  } catch (e) {
    console.error('[db] delete conversation exception:', e);
  }
}

// ── Notes ──────────────────────────────────────────────────────────────────

export async function dbInsertNote(convId: string, note: ConversationNote): Promise<void> {
  try {
    const { error } = await supabase.from('conversation_notes').insert({
      id: note.id,
      conversation_id: convId,
      author: note.author,
      text: note.text,
      is_system: note.system,
      created_at: note.ts,
    });
    if (error) console.error('[db] insert note:', error.message);
  } catch (e) {
    console.error('[db] insert note exception:', e);
  }
}

export async function dbUpdateNote(note: ConversationNote): Promise<void> {
  try {
    const { error } = await supabase
      .from('conversation_notes')
      .update({ text: note.text })
      .eq('id', note.id);
    if (error) console.error('[db] update note:', error.message);
  } catch (e) {
    console.error('[db] update note exception:', e);
  }
}

export async function dbDeleteNote(id: string): Promise<void> {
  try {
    const { error } = await supabase.from('conversation_notes').delete().eq('id', id);
    if (error) console.error('[db] delete note:', error.message);
  } catch (e) {
    console.error('[db] delete note exception:', e);
  }
}

// ── Prompts ────────────────────────────────────────────────────────────────

export async function dbInsertPrompt(p: PromptVersion): Promise<void> {
  try {
    const { error } = await supabase.from('prompts').insert({
      id: p.id,
      title: p.title,
      content: p.content,
      is_active: p.is_active,
      created_at: p.created_at,
      updated_at: p.updated_at,
    });
    if (error) console.error('[db] insert prompt:', error.message);
  } catch (e) {
    console.error('[db] insert prompt exception:', e);
  }
}

export async function dbUpdatePrompt(p: PromptVersion): Promise<void> {
  try {
    const { error } = await supabase.from('prompts').update({
      title: p.title,
      content: p.content,
      is_active: p.is_active,
      updated_at: new Date().toISOString(),
    }).eq('id', p.id);
    if (error) console.error('[db] update prompt:', error.message);
  } catch (e) {
    console.error('[db] update prompt exception:', e);
  }
}

export async function dbDeletePrompt(id: string): Promise<void> {
  try {
    const { error } = await supabase.from('prompts').delete().eq('id', id);
    if (error) console.error('[db] delete prompt:', error.message);
  } catch (e) {
    console.error('[db] delete prompt exception:', e);
  }
}

export async function dbActivatePrompt(id: string): Promise<void> {
  try {
    // Deactivate all, then activate target
    await supabase.from('prompts').update({ is_active: false, updated_at: new Date().toISOString() }).neq('id', '');
    const { error } = await supabase.from('prompts').update({ is_active: true, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) console.error('[db] activate prompt:', error.message);
  } catch (e) {
    console.error('[db] activate prompt exception:', e);
  }
}

// ── Load all state ─────────────────────────────────────────────────────────

export async function loadFromSupabase(): Promise<{ conversations: Conversation[]; prompts: PromptVersion[] } | null> {
  try {
    const [cRes, cnRes, pRes] = await Promise.all([
      supabase.from('conversations').select('*').order('analyzed_at', { ascending: false }),
      supabase.from('conversation_notes').select('*').order('created_at'),
      supabase.from('prompts').select('*').order('created_at', { ascending: false }),
    ]);

    if (cRes.error) throw cRes.error;

    const conversations: Conversation[] = (cRes.data ?? []).map((c) => ({
      id: c.id,
      title: c.title,
      analyzed_at: c.analyzed_at ?? new Date().toISOString(),

      intercom_id: c.intercom_id ?? null,
      intercom_created_at: c.intercom_created_at ?? null,

      player_name: c.player_name ?? null,
      player_email: c.player_email ?? null,
      player_id: c.player_id ?? null,
      player_external_id: c.player_external_id ?? null,
      player_phone: c.player_phone ?? null,
      player_tags: c.player_tags ?? [],

      player_signed_up_at: c.player_signed_up_at ?? null,
      player_last_seen_at: c.player_last_seen_at ?? null,
      player_last_replied_at: c.player_last_replied_at ?? null,
      player_last_contacted_at: c.player_last_contacted_at ?? null,

      player_country: c.player_country ?? null,
      player_city: c.player_city ?? null,
      player_browser: c.player_browser ?? null,
      player_os: c.player_os ?? null,

      player_custom_attributes: c.player_custom_attributes ?? null,
      player_companies: c.player_companies ?? [],
      player_segments: c.player_segments ?? [],
      player_event_summaries: c.player_event_summaries ?? [],

      agent_name: c.agent_name ?? null,
      agent_email: c.agent_email ?? null,
      is_bot_handled: c.is_bot_handled ?? false,

      brand: c.brand ?? null,
      tags: c.tags ?? [],
      query_type: c.query_type ?? null,
      ai_subject: c.ai_subject ?? null,
      ai_issue_summary: c.ai_issue_summary ?? null,
      cx_score_rating: c.cx_score_rating ?? null,
      cx_score_explanation: c.cx_score_explanation ?? null,
      conversation_rating_score: c.conversation_rating_score ?? null,
      conversation_rating_remark: c.conversation_rating_remark ?? null,

      time_to_assignment: c.time_to_assignment ?? null,
      time_to_admin_reply: c.time_to_admin_reply ?? null,
      time_to_first_close: c.time_to_first_close ?? null,
      median_time_to_reply: c.median_time_to_reply ?? null,
      count_reopens: c.count_reopens ?? null,

      sentiment: c.sentiment ?? null,
      summary: c.summary ?? null,
      dissatisfaction_severity: c.dissatisfaction_severity ?? null,
      issue_category: c.issue_category ?? null,
      resolution_status: c.resolution_status ?? null,
      language: c.language ?? null,
      agent_performance_score: c.agent_performance_score ?? null,
      agent_performance_notes: c.agent_performance_notes ?? null,
      key_quotes: c.key_quotes ?? null,
      recommended_action: c.recommended_action ?? null,
      is_alert_worthy: c.is_alert_worthy ?? false,
      alert_reason: c.alert_reason ?? null,

      original_text: c.original_text ?? null,
      notes: !cnRes.error
        ? (cnRes.data ?? [])
            .filter((n) => n.conversation_id === c.id)
            .map((n) => ({
              id: n.id,
              author: n.author,
              text: n.text,
              ts: n.created_at,
              system: n.is_system,
            }))
        : [],
    }));

    const prompts: PromptVersion[] = (pRes.data ?? []).map((p) => ({
      id: p.id,
      title: p.title ?? 'Untitled',
      content: p.content ?? '',
      is_active: p.is_active ?? false,
      created_at: p.created_at,
      updated_at: p.updated_at ?? p.created_at,
    }));

    return { conversations, prompts };
  } catch (e) {
    console.error('[db] loadFromSupabase failed:', e);
    return null;
  }
}
