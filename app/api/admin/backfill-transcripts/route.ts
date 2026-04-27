import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { formatTranscriptFromRawMessages, truncateTranscript, fetchIntercomData } from '@/lib/intercom';
import { supabase } from '@/lib/supabase';
import type { RawMessage } from '@/lib/types';

export const maxDuration = 300;

// Regenerates `original_text` from `raw_messages` for every conversation, using
// the current canonical labeling (Agent / Bot / Player). Fixes historical rows
// whose transcript was built by an older code path that mislabeled bot messages
// as Player — those rows are silently feeding wrong speaker tags into OpenAI.
//
// Strategy: we trust `raw_messages` because it has been refreshed independently
// (see refresh-messages route + auto-backfill on transcript open), so it holds
// the correct per-message author_type. For rows that have no raw_messages, we
// re-fetch from Intercom (rate-limited).
//
// Body / query:
//   { clearSummaries?: boolean   — if true, set summary=NULL on rows we change so
//                                  /api/batch-analysis re-picks them up.
//     refetchEmpty?: boolean     — if true, re-fetch from Intercom for rows
//                                  with no raw_messages. Default false.
//     dryRun?: boolean           — count what *would* change, write nothing.
//     batchSize?: number         — rows per page (default 500).
//   }

type RowSlice = {
  id: string;
  intercom_id: string | null;
  original_text: string | null;
  raw_messages: RawMessage[] | null;
  summary: string | null;
};

type Stats = {
  scanned: number;
  changed: number;
  cleared: number;
  skipped_no_raw_messages: number;
  refetched: number;
  refetch_errors: number;
  hit_max_rows: boolean;
  hit_time_budget: boolean;
};

type Options = {
  clearSummaries: boolean;
  refetchEmpty: boolean;
  dryRun: boolean;
  batchSize: number;
  onlyEmpty: boolean;
  maxRows: number | null;
  timeBudgetMs: number;
};

async function backfillAll(options: Options, apiKey: string | undefined): Promise<Stats> {
  const stats: Stats = {
    scanned: 0,
    changed: 0,
    cleared: 0,
    skipped_no_raw_messages: 0,
    refetched: 0,
    refetch_errors: 0,
    hit_max_rows: false,
    hit_time_budget: false,
  };

  const startedAt = Date.now();
  let from = 0;
  outer: while (true) {
    let query = supabase
      .from('conversations')
      .select('id, intercom_id, original_text, raw_messages, summary')
      .order('intercom_created_at', { ascending: true })
      .range(from, from + options.batchSize - 1);
    if (options.onlyEmpty) query = query.is('raw_messages', null);

    const { data, error } = await query;
    if (error) throw new Error(`[backfill-transcripts] fetch: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data as RowSlice[]) {
      if (options.maxRows !== null && stats.scanned >= options.maxRows) {
        stats.hit_max_rows = true;
        break outer;
      }
      if (Date.now() - startedAt > options.timeBudgetMs) {
        stats.hit_time_budget = true;
        break outer;
      }
      stats.scanned++;

      let raw = row.raw_messages;
      if ((!raw || raw.length === 0) && options.refetchEmpty && row.intercom_id && apiKey) {
        try {
          const fresh = await fetchIntercomData(row.intercom_id, apiKey);
          raw = fresh.raw_messages;
          stats.refetched++;
        } catch (e) {
          stats.refetch_errors++;
          const msg = (e as Error).message;
          console.warn(`[backfill-transcripts] refetch ${row.intercom_id}: ${msg}`);
          if (msg.toLowerCase().includes('rate limit')) {
            await new Promise((r) => setTimeout(r, 65_000));
          }
          continue;
        }
      }

      if (!raw || raw.length === 0) {
        stats.skipped_no_raw_messages++;
        continue;
      }

      const rebuilt = truncateTranscript(formatTranscriptFromRawMessages(raw));
      if (rebuilt === row.original_text) continue;

      stats.changed++;
      if (options.dryRun) continue;

      const updates: Record<string, unknown> = { original_text: rebuilt };
      // Persist the refetched messages too so raw_messages and original_text
      // stay coherent, matching what refresh-messages does.
      if (row.raw_messages !== raw) updates.raw_messages = raw;
      if (options.clearSummaries && row.summary) {
        updates.summary = null;
        updates.last_prompt_id = null;
        updates.last_prompt_content = null;
        updates.analyzed_at = null;
        stats.cleared++;
      }

      const { error: updErr } = await supabase
        .from('conversations')
        .update(updates)
        .eq('id', row.id);
      if (updErr) console.error(`[backfill-transcripts] update ${row.id}: ${updErr.message}`);
    }

    if (data.length < options.batchSize) break;
    // When onlyEmpty=true we filter at query time, so processed rows drop out
    // of the result set on the next page. Keep `from` at 0 so we don't skip
    // unprocessed rows.
    if (!options.onlyEmpty) from += options.batchSize;
  }

  return stats;
}

function authHeaderOk(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

// POST /api/admin/backfill-transcripts
//   body: {
//     clearSummaries?, refetchEmpty?, dryRun?, batchSize?, background?,
//     onlyEmpty?,        // filter to rows where raw_messages IS NULL — pair with refetchEmpty for the slow Intercom-bound pass
//     maxRows?,          // cap rows scanned per call (chunked refetch). null = unlimited
//     timeBudgetSec?,    // bail out before this many seconds elapse (default 240, must stay under maxDuration=300)
//   }
// background=true returns immediately and runs in waitUntil. For chunked
// refetches call repeatedly with onlyEmpty=true,refetchEmpty=true,maxRows=N.
export async function POST(req: NextRequest) {
  if (!authHeaderOk(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: {
    clearSummaries?: boolean;
    refetchEmpty?: boolean;
    dryRun?: boolean;
    batchSize?: number;
    background?: boolean;
    onlyEmpty?: boolean;
    maxRows?: number | null;
    timeBudgetSec?: number;
  };
  try { body = await req.json(); }
  catch { body = {}; }

  const opts: Options = {
    clearSummaries: body.clearSummaries ?? false,
    refetchEmpty: body.refetchEmpty ?? false,
    dryRun: body.dryRun ?? false,
    batchSize: Math.max(50, Math.min(2000, body.batchSize ?? 500)),
    onlyEmpty: body.onlyEmpty ?? false,
    maxRows: body.maxRows ?? null,
    timeBudgetMs: Math.max(10, Math.min(290, body.timeBudgetSec ?? 240)) * 1000,
  };
  const apiKey = process.env.INTERCOM_API_KEY;
  if (opts.refetchEmpty && !apiKey) {
    return NextResponse.json({ error: 'INTERCOM_API_KEY not configured (required when refetchEmpty=true)' }, { status: 500 });
  }

  if (body.background) {
    waitUntil(
      backfillAll(opts, apiKey)
        .then((s) => console.log('[backfill-transcripts] done:', s))
        .catch((e) => console.error('[backfill-transcripts] failed:', e)),
    );
    return NextResponse.json({ message: 'Backfill started in background', options: opts });
  }

  try {
    const stats = await backfillAll(opts, apiKey);
    return NextResponse.json({ ...stats, options: opts });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
