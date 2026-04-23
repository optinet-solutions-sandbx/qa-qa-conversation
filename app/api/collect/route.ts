import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { fetchIntercomData } from '@/lib/intercom';
import { loadConversationsByDate, dbInsertConversation, dbUpdateConversation, getExistingIntercomIds } from '@/lib/db';
import { generateId } from '@/lib/utils';
import type { Conversation } from '@/lib/types';

// ── GET: load conversations from DB by date ────────────────────────────────

export async function GET(req: NextRequest) {
  const date    = req.nextUrl.searchParams.get('date');
  const page    = parseInt(req.nextUrl.searchParams.get('page')    ?? '0',  10);
  const perPage = parseInt(req.nextUrl.searchParams.get('perPage') ?? '25', 10);
  const search  = req.nextUrl.searchParams.get('search') ?? '';

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date param required (YYYY-MM-DD)' }, { status: 400 });
  }

  try {
    const { conversations, total } = await loadConversationsByDate(date, page, perPage, search);
    return NextResponse.json({ conversations, total, page, perPage });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

// ── POST: full-fetch + save a batch of conversations from Intercom ─────────

export async function POST(req: NextRequest) {
  const apiKey = process.env.INTERCOM_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'INTERCOM_API_KEY not configured' }, { status: 500 });

  let body: { intercomIds: string[] };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const { intercomIds } = body;
  if (!Array.isArray(intercomIds) || intercomIds.length === 0) {
    return NextResponse.json({ error: 'intercomIds array required' }, { status: 400 });
  }

  const existingIds = await getExistingIntercomIds(intercomIds);
  const results: { id: string; status: 'saved' | 'updated' | 'error'; error?: string }[] = [];

  for (const intercomId of intercomIds) {
    try {
      const data = await fetchIntercomData(intercomId, apiKey);
      const isExisting = existingIds.has(intercomId);

      const conv: Conversation = {
        id: generateId(),
        title: data.transcript?.split('\n')[0]?.replace(/^(Agent|Bot|Player|User):\s*/i, '').slice(0, 80) || `Conversation ${intercomId}`,
        analyzed_at: new Date().toISOString(),

        intercom_id: data.intercom_id,
        intercom_created_at: data.intercom_created_at,

        player_name: data.player_name,
        player_email: data.player_email,
        player_id: data.player_id,
        player_external_id: data.player_external_id,
        player_phone: data.player_phone,
        player_tags: data.player_tags ?? [],
        player_signed_up_at: data.player_signed_up_at,
        player_last_seen_at: data.player_last_seen_at,
        player_last_replied_at: data.player_last_replied_at,
        player_last_contacted_at: data.player_last_contacted_at,
        player_country: data.player_country,
        player_city: data.player_city,
        player_browser: data.player_browser,
        player_os: data.player_os,
        player_custom_attributes: data.player_custom_attributes,
        player_companies: data.player_companies ?? [],
        player_segments: data.player_segments ?? [],
        player_event_summaries: data.player_event_summaries ?? [],

        agent_name: data.agent_name,
        agent_email: data.agent_email,
        is_bot_handled: data.is_bot_handled ?? false,

        brand: data.brand,
        tags: data.tags ?? [],
        query_type: data.query_type,
        ai_subject: data.ai_subject,
        ai_issue_summary: data.ai_issue_summary,
        cx_score_rating: data.cx_score_rating,
        cx_score_explanation: data.cx_score_explanation,
        conversation_rating_score: data.conversation_rating_score,
        conversation_rating_remark: data.conversation_rating_remark,

        time_to_assignment: data.time_to_assignment,
        time_to_admin_reply: data.time_to_admin_reply,
        time_to_first_close: data.time_to_first_close,
        median_time_to_reply: data.median_time_to_reply,
        count_reopens: data.count_reopens,

        original_text: data.transcript,
        raw_messages: data.raw_messages,
        notes: [],

        sentiment: null,
        summary: null,
        dissatisfaction_severity: null,
        issue_category: null,
        resolution_status: null,
        language: null,
        agent_performance_score: null,
        agent_performance_notes: null,
        key_quotes: null,
        recommended_action: null,
        is_alert_worthy: false,
        alert_reason: null,
        account_manager: data.account_manager,
        last_prompt_id: null,
        last_prompt_content: null,
      };

      if (isExisting) {
        await dbUpdateConversation(conv);
        results.push({ id: intercomId, status: 'updated' });
      } else {
        await dbInsertConversation(conv);
        results.push({ id: intercomId, status: 'saved' });
      }
    } catch (e) {
      results.push({ id: intercomId, status: 'error', error: (e as Error).message });
    }
  }

  return NextResponse.json({ results });
}
