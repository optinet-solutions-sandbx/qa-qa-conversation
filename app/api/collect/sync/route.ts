import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { searchConversationsByDate, fetchIntercomData } from '@/lib/intercom';
import {
  getExistingIntercomIds,
  dbInsertConversation,
  dbUpdateConversationByIntercomId,
  dbGetSyncJob,
  dbUpsertSyncJob,
  dbUpdateSyncJob,
  dbReconcileConversations,
} from '@/lib/db';
import { generateId } from '@/lib/utils';
import type { Conversation, ConversationFetchResult, SyncJob } from '@/lib/types';

// ── GET: read job status from Supabase ────────────────────────────────────

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get('date');
  if (!date) return NextResponse.json({ error: 'date required' }, { status: 400 });
  const job = await dbGetSyncJob(date);
  if (!job) return NextResponse.json({ status: 'idle' });
  return NextResponse.json(job);
}

// ── POST: client-driven actions ───────────────────────────────────────────
//
//  { action: 'start',    date }
//    → Search Intercom for the date, create/reset job in DB,
//      return ALL ids so client can drive batches.
//      Also returns which IDs are already saved (client skips them for resume).
//
//  { action: 'batch',    date, ids: string[] }
//    → Fetch full details for each ID from Intercom, save to DB,
//      increment done count. Returns per-id results.
//
//  { action: 'complete', date }
//    → Mark job as done.
//
//  { action: 'cancel',   date }
//    → Mark job as cancelled.
//
//  { action: 'error',    date, message: string }
//    → Mark job as errored.

export async function POST(req: NextRequest) {
  const apiKey = process.env.INTERCOM_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'INTERCOM_API_KEY not configured' }, { status: 500 });

  let body: {
    action: 'start' | 'batch' | 'reconcile' | 'complete' | 'cancel' | 'error';
    date: string;
    ids?: string[];
    message?: string;
  };

  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const { action, date } = body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date required (YYYY-MM-DD)' }, { status: 400 });
  }

  // ── start ──────────────────────────────────────────────────────────────
  if (action === 'start') {
    try {
      const all = await searchConversationsByDate(date, apiKey);
      // Only collect finished chats — skip open/snoozed until they're closed.
      const closed = all.filter((c) => c.state === 'closed');
      const ids = closed.map((c) => c.intercom_id);
      const existingIds = await getExistingIntercomIds(ids);

      const job: SyncJob = {
        id: date,
        status: 'running',
        total: ids.length,
        done: 0,
        error_count: 0,
        started_at: new Date().toISOString(),
        finished_at: null,
        error_message: null,
      };
      await dbUpsertSyncJob(job);

      return NextResponse.json({
        ids,
        existingIds: [...existingIds],
        total: ids.length,
      });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  // ── batch ──────────────────────────────────────────────────────────────
  if (action === 'batch') {
    const ids = body.ids ?? [];
    if (ids.length === 0) return NextResponse.json({ results: [] });

    const existingIds = await getExistingIntercomIds(ids);
    const results: { id: string; status: 'saved' | 'updated' | 'skipped' | 'error'; error?: string }[] = [];
    let errorCount = 0;

    for (const intercomId of ids) {
      try {
        const data = await fetchIntercomData(intercomId, apiKey);
        const conv = buildConversation(data);
        if (existingIds.has(intercomId)) {
          await dbUpdateConversationByIntercomId(conv);
          results.push({ id: intercomId, status: 'updated' });
        } else {
          await dbInsertConversation(conv);
          existingIds.add(intercomId); // guard against duplicate IDs within the same batch
          results.push({ id: intercomId, status: 'saved' });
        }
      } catch (e) {
        errorCount++;
        results.push({ id: intercomId, status: 'error', error: (e as Error).message });
        console.error(`[sync] ${intercomId}:`, (e as Error).message);
      }
    }

    // Update done count in Supabase
    try {
      const job = await dbGetSyncJob(date);
      if (job) {
        await dbUpdateSyncJob(date, {
          done: job.done + ids.length,
          error_count: job.error_count + errorCount,
        });
      }
    } catch { /* non-fatal */ }

    return NextResponse.json({ results });
  }

  // ── reconcile ──────────────────────────────────────────────────────────
  // Called after all batches finish. Re-queries Intercom for the canonical
  // ID list and deletes any DB row that is no longer in it (stale, non-chat,
  // or duplicate). Fetching from Intercom server-side is authoritative and
  // avoids passing a large ID list over the wire from the client.
  if (action === 'reconcile') {
    try {
      const searchResults = await searchConversationsByDate(date, apiKey);
      const validIds = new Set(searchResults.map((r) => r.intercom_id));
      const deleted = await dbReconcileConversations(date, validIds);
      console.log(`[sync] reconcile ${date}: ${searchResults.length} valid, ${deleted} deleted`);
      return NextResponse.json({ ok: true, deleted, valid: searchResults.length });
    } catch (e) {
      console.error(`[sync] reconcile ${date} failed:`, (e as Error).message);
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  // ── complete ───────────────────────────────────────────────────────────
  if (action === 'complete') {
    try {
      await dbUpdateSyncJob(date, { status: 'done', finished_at: new Date().toISOString() });
      return NextResponse.json({ ok: true });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  // ── cancel ─────────────────────────────────────────────────────────────
  if (action === 'cancel') {
    try {
      await dbUpdateSyncJob(date, { status: 'cancelled', finished_at: new Date().toISOString() });
      return NextResponse.json({ ok: true });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  // ── error ──────────────────────────────────────────────────────────────
  if (action === 'error') {
    try {
      await dbUpdateSyncJob(date, {
        status: 'error',
        error_message: body.message ?? 'Unknown error',
        finished_at: new Date().toISOString(),
      });
      return NextResponse.json({ ok: true });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

// ── Build Conversation from fetched data ──────────────────────────────────

function buildConversation(data: ConversationFetchResult): Conversation {
  return {
    id: generateId(),
    title: data.transcript?.split('\n')[0]?.replace(/^(Agent|User|Bot|Player):\s*/i, '').slice(0, 80) || `Conversation ${data.intercom_id}`,
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
    raw_messages_translated: null,
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
}
