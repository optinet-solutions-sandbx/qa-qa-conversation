import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { searchConversationsByDate, fetchIntercomData, cestDateToUnixRange } from '@/lib/intercom';
import { getExistingIntercomIds, dbInsertConversation } from '@/lib/db';
import { supabase } from '@/lib/supabase';

const CHUNK_SIZE = 500;

interface DbRow {
  id: string;
  intercom_id: string | null;
  summary: string | null;
  original_text: string | null;
  analyzed_at: string | null;
}

async function runCleanup(date: string, validIntercomIds: Set<string>) {
  const [startUnix, endUnix] = cestDateToUnixRange(date);
  const startISO = new Date(startUnix * 1000).toISOString();
  const endISO   = new Date(endUnix   * 1000).toISOString();

  const rows: DbRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('conversations')
      .select('id, intercom_id, summary, original_text, analyzed_at')
      .gte('intercom_created_at', startISO)
      .lte('intercom_created_at', endISO)
      .range(from, from + CHUNK_SIZE - 1);
    if (error) { console.error('[cron] cleanup query:', error.message); return; }
    rows.push(...(data ?? []));
    if ((data ?? []).length < CHUNK_SIZE) break;
    from += CHUNK_SIZE;
  }

  const byId = new Map<string, DbRow[]>();
  for (const row of rows) {
    if (!row.intercom_id) continue;
    if (!byId.has(row.intercom_id)) byId.set(row.intercom_id, []);
    byId.get(row.intercom_id)!.push(row);
  }

  const toDelete: string[] = [];
  for (const [intercomId, dupes] of byId) {
    if (!validIntercomIds.has(intercomId)) {
      toDelete.push(...dupes.map((r) => r.id));
    } else if (dupes.length > 1) {
      const best = [...dupes].sort((a, b) => {
        const aScore = (a.summary ? 2 : 0) + (a.original_text ? 1 : 0);
        const bScore = (b.summary ? 2 : 0) + (b.original_text ? 1 : 0);
        if (aScore !== bScore) return bScore - aScore;
        return new Date(b.analyzed_at ?? 0).getTime() - new Date(a.analyzed_at ?? 0).getTime();
      })[0];
      toDelete.push(...dupes.filter((r) => r.id !== best.id).map((r) => r.id));
    }
  }

  if (toDelete.length === 0) return;
  for (let i = 0; i < toDelete.length; i += CHUNK_SIZE) {
    const chunk = toDelete.slice(i, i + CHUNK_SIZE);
    await supabase.from('analysis_runs').delete().in('conversation_id', chunk);
    await supabase.from('conversations').delete().in('id', chunk);
  }
  console.log(`[cron] cleanup ${date}: removed ${toDelete.length} non-chat/duplicate rows`);
}
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

// ── Background worker ──────────────────────────────────────────────────────

async function runCollection(date: string, apiKey: string) {
  let saved = 0;
  let skipped = 0;
  let errors = 0;
  const errorSamples: string[] = [];
  const startedAt = Date.now();
  let validIds = new Set<string>();

  try {
    // Step 1: search Intercom for all conversation IDs on this date
    const searchResults = await searchConversationsByDate(date, apiKey);
    const allIds = searchResults.map((r) => r.intercom_id);
    validIds = new Set<string>(allIds);

    if (allIds.length === 0) {
      console.log(`[cron] collect-daily ${date}: no conversations found`);
      return;
    }

    // Step 2: skip IDs already in the database (idempotent)
    const existingIds = await getExistingIntercomIds(allIds);
    const newIds = allIds.filter((id) => !existingIds.has(id));
    skipped = existingIds.size;

    // Step 3: fetch + save each new conversation
    // Process 3 conversations concurrently to stay within cron timeouts while
    // keeping well under Intercom's rate limits (~200ms between batches).
    const BATCH_SIZE = 3;
    for (let i = 0; i < newIds.length; i += BATCH_SIZE) {
      const batch = newIds.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (intercomId) => {
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
            console.warn(`[cron] Rate limited fetching ${intercomId}. Waiting 65s…`);
            await sleep(65_000);
          }
        }
      }));

      // Pause between batches to respect Intercom's rate limits
      if (i + BATCH_SIZE < newIds.length) {
        await sleep(200);
      }
    }
  } catch (e) {
    console.error(`[cron] collect-daily ${date} fatal error:`, (e as Error).message);
    return;
  }

  // Step 4: cleanup non-chat and duplicate rows using the same valid IDs from Intercom
  await runCleanup(date, validIds);

  const duration = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    `[cron] collect-daily ${date}: saved=${saved} skipped=${skipped} errors=${errors} (${duration}s)`,
    errorSamples.length > 0 ? { error_samples: errorSamples } : '',
  );
}

// ── GET /api/cron/collect-daily ────────────────────────────────────────────
//
// Called by cron-job.org (or Vercel Cron via vercel.json) once per day.
// Can also be triggered manually with ?date=YYYY-MM-DD for backfills.
//
// Uses waitUntil so the response returns immediately (avoiding cron-job.org's
// 30s connection timeout) while Vercel continues processing up to maxDuration.
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

  // Kick off the heavy work in the background so cron-job.org gets a fast 200
  // response instead of timing out waiting for all conversations to be fetched.
  waitUntil(runCollection(date, apiKey));

  return NextResponse.json({ date, message: 'Collection started in background' });
}
