import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { searchConversationsByDate, fetchIntercomData } from '@/lib/intercom';
import { getExistingIntercomIds, dbInsertConversation } from '@/lib/db';
import { generateId } from '@/lib/utils';
import type { Conversation } from '@/lib/types';

// Allow up to 5 minutes on Vercel Pro (enough for ~200 conversations with rate-limit delays)
export const maxDuration = 300;

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>((res) => setTimeout(res, ms));
}

/** Returns yesterday's date in YYYY-MM-DD (UTC). */
function yesterdayUtc(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ── GET /api/cron/collect-daily ────────────────────────────────────────────
//
// Called by Vercel Cron (vercel.json) once per day.
// Can also be triggered manually with ?date=YYYY-MM-DD for backfills.
//
// Security: Vercel automatically sends Authorization: Bearer <CRON_SECRET>.
// Set CRON_SECRET in your Vercel environment variables.

export async function GET(req: NextRequest) {
  // ── Auth ─────────────────────────────────────────────────────────────────
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization') ?? '';
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const apiKey = process.env.INTERCOM_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'INTERCOM_API_KEY not configured' }, { status: 500 });
  }

  // ── Date ─────────────────────────────────────────────────────────────────
  const dateParam = req.nextUrl.searchParams.get('date');
  const date = dateParam ?? yesterdayUtc();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'Invalid date format. Use YYYY-MM-DD.' }, { status: 400 });
  }

  const startedAt = Date.now();
  let saved = 0;
  let skipped = 0;
  let errors = 0;
  const errorSamples: string[] = [];

  try {
    // ── Step 1: search Intercom for all conversation IDs on this date ───────
    const searchResults = await searchConversationsByDate(date, apiKey);
    const allIds = searchResults.map((r) => r.intercom_id);

    if (allIds.length === 0) {
      return NextResponse.json({
        date,
        message: 'No conversations found for this date.',
        saved: 0,
        skipped: 0,
        errors: 0,
        total_found: 0,
        duration_seconds: 0,
      });
    }

    // ── Step 2: skip IDs already in the database (idempotent) ───────────────
    const existingIds = await getExistingIntercomIds(allIds);
    const newIds = allIds.filter((id) => !existingIds.has(id));
    skipped = existingIds.size;

    // ── Step 3: fetch + save each new conversation ───────────────────────────
    for (let i = 0; i < newIds.length; i++) {
      const intercomId = newIds[i];

      try {
        const data = await fetchIntercomData(intercomId, apiKey);

        const conv: Conversation = {
          id: generateId(),
          title:
            data.transcript?.split('\n')[0]?.replace(/^(Agent|User):\s*/i, '').slice(0, 80) ||
            `Conversation ${intercomId}`,
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
          last_prompt_id: null,
          last_prompt_content: null,
        };

        await dbInsertConversation(conv);
        saved++;
      } catch (e) {
        const msg = (e as Error).message;
        errors++;
        if (errorSamples.length < 5) errorSamples.push(`${intercomId}: ${msg}`);

        // If Intercom rate-limited us, back off for 65 seconds then continue
        if (msg.toLowerCase().includes('rate limit')) {
          console.warn(`[cron] Rate limited at conversation ${i + 1}/${newIds.length}. Waiting 65s…`);
          await sleep(65_000);
        }
      }

      // Small pause between each request to stay well under Intercom's limits
      if (i < newIds.length - 1) {
        await sleep(250);
      }
    }
  } catch (e) {
    const msg = (e as Error).message;
    return NextResponse.json(
      {
        date,
        error: msg,
        saved,
        skipped,
        errors,
        duration_seconds: Math.round((Date.now() - startedAt) / 1000),
      },
      { status: 500 },
    );
  }

  const duration = Math.round((Date.now() - startedAt) / 1000);

  console.log(
    `[cron] collect-daily ${date}: saved=${saved} skipped=${skipped} errors=${errors} (${duration}s)`,
  );

  return NextResponse.json({
    date,
    saved,
    skipped,
    errors,
    total_found: saved + skipped + errors,
    duration_seconds: duration,
    ...(errorSamples.length > 0 && { error_samples: errorSamples }),
  });
}
