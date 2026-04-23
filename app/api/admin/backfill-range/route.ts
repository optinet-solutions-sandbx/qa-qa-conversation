import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { searchConversationsByDate, fetchIntercomData } from '@/lib/intercom';
import { getExistingIntercomIds, dbInsertConversation } from '@/lib/db';
import { generateId } from '@/lib/utils';
import type { Conversation } from '@/lib/types';

export const maxDuration = 300;

function sleep(ms: number) {
  return new Promise<void>((res) => setTimeout(res, ms));
}

function datesInRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const cur = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  while (cur <= last) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

async function backfillDate(date: string, apiKey: string): Promise<{ saved: number; skipped: number; errors: number }> {
  let saved = 0, skipped = 0, errors = 0;

  const searchResults = await searchConversationsByDate(date, apiKey);
  const allIds = searchResults.map((r) => r.intercom_id);
  if (allIds.length === 0) return { saved, skipped, errors };

  const existingIds = await getExistingIntercomIds(allIds);
  const newIds = allIds.filter((id) => !existingIds.has(id));
  skipped = existingIds.size;

  const BATCH_SIZE = 3;
  for (let i = 0; i < newIds.length; i += BATCH_SIZE) {
    const batch = newIds.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (intercomId) => {
      try {
        const data = await fetchIntercomData(intercomId, apiKey);
        const conv: Conversation = {
          id: generateId(),
          title: data.transcript?.split('\n')[0]?.replace(/^(Agent|User):\s*/i, '').slice(0, 80) || `Conversation ${intercomId}`,
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
          sentiment: null, summary: null, dissatisfaction_severity: null,
          issue_category: null, resolution_status: null, language: null,
          agent_performance_score: null, agent_performance_notes: null,
          key_quotes: null, recommended_action: null,
          is_alert_worthy: false, alert_reason: null,
          account_manager: data.account_manager,
          last_prompt_id: null, last_prompt_content: null,
        };
        await dbInsertConversation(conv);
        saved++;
      } catch (e) {
        const msg = (e as Error).message;
        errors++;
        if (msg.toLowerCase().includes('rate limit')) {
          console.warn(`[backfill] Rate limited on ${intercomId}. Waiting 65s…`);
          await sleep(65_000);
        }
      }
    }));
    if (i + BATCH_SIZE < newIds.length) await sleep(200);
  }

  return { saved, skipped, errors };
}

async function runBackfill(dates: string[], apiKey: string) {
  console.log(`[backfill] Starting backfill for ${dates.length} dates: ${dates[0]} → ${dates[dates.length - 1]}`);
  for (const date of dates) {
    try {
      const result = await backfillDate(date, apiKey);
      console.log(`[backfill] ${date}: saved=${result.saved} skipped=${result.skipped} errors=${result.errors}`);
    } catch (e) {
      console.error(`[backfill] ${date} failed:`, (e as Error).message);
    }
    // Brief pause between dates to avoid hammering Intercom
    await sleep(1_000);
  }
  console.log('[backfill] Done.');
}

// GET /api/admin/backfill-range?startDate=2026-03-15&endDate=2026-04-13
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization') ?? '';
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const apiKey = process.env.INTERCOM_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'INTERCOM_API_KEY not configured' }, { status: 500 });

  const startDate = req.nextUrl.searchParams.get('startDate');
  const endDate   = req.nextUrl.searchParams.get('endDate');

  if (!startDate || !endDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return NextResponse.json({ error: 'startDate and endDate required (YYYY-MM-DD)' }, { status: 400 });
  }
  if (startDate > endDate) {
    return NextResponse.json({ error: 'startDate must be <= endDate' }, { status: 400 });
  }

  const dates = datesInRange(startDate, endDate);
  waitUntil(runBackfill(dates, apiKey));

  return NextResponse.json({
    message: `Backfill started in background for ${dates.length} dates`,
    startDate,
    endDate,
    dates,
  });
}
