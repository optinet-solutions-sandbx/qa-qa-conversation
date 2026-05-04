import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  dbGetActivePrompt,
  dbGetAnalyzedConversationsInDateRangeBeforeCutoff,
  dbCountAnalyzedConversationsInDateRangeBeforeCutoff,
} from '@/lib/db';
import { analyzeBatchSequential } from '@/lib/analyze-sync';

// Re-runs a batch of already-analyzed conversations whose intercom_created_at
// falls in a date window, under the currently active prompt. Designed for use
// after a prompt edit, so today's (or any window's) verdicts get refreshed
// without waiting for new conversations to come in. Caller loops until
// `remaining` reaches 0.
//
// POST /api/admin/reanalyze-by-date?fromDate=<ISO>&toDate=<ISO>&cutoff=<ISO>&limit=<N>
//   - Authenticates with CRON_SECRET
//   - Loads up to `limit` conversations with summary not null, intercom_created_at
//     within [fromDate, toDate], analyzed_at < cutoff
//   - Runs them sequentially via analyzeBatchSequential (15s spacing,
//     gpt-4o, 429 retry-with-backoff)
//   - Returns analyzed/failed counts plus `remaining`
//
// Sized to fit the 300s Vercel timeout: limit=10 → ~150s, limit=16 → ~240s.
export const maxDuration = 300;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 16;

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization') ?? '';
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 });

  const fromDate = req.nextUrl.searchParams.get('fromDate')?.trim();
  if (!fromDate || Number.isNaN(Date.parse(fromDate))) {
    return NextResponse.json({ error: 'fromDate query param is required (ISO timestamp)' }, { status: 400 });
  }

  const toDate = req.nextUrl.searchParams.get('toDate')?.trim();
  if (!toDate || Number.isNaN(Date.parse(toDate))) {
    return NextResponse.json({ error: 'toDate query param is required (ISO timestamp)' }, { status: 400 });
  }

  const cutoff = req.nextUrl.searchParams.get('cutoff')?.trim();
  if (!cutoff || Number.isNaN(Date.parse(cutoff))) {
    return NextResponse.json({ error: 'cutoff query param is required (ISO timestamp)' }, { status: 400 });
  }

  const limitParam = parseInt(req.nextUrl.searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10);
  const limit = Math.min(Math.max(1, isNaN(limitParam) ? DEFAULT_LIMIT : limitParam), MAX_LIMIT);

  const prompt = await dbGetActivePrompt();
  if (!prompt) {
    return NextResponse.json({ error: 'No active prompt found' }, { status: 500 });
  }

  let conversations;
  try {
    conversations = await dbGetAnalyzedConversationsInDateRangeBeforeCutoff(fromDate, toDate, cutoff, limit);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  if (conversations.length === 0) {
    return NextResponse.json({
      fromDate,
      toDate,
      cutoff,
      remaining: 0,
      processed: 0,
      analyzed: 0,
      failed: 0,
      results: [],
      done: true,
    });
  }

  const results = await analyzeBatchSequential(conversations, prompt, apiKey);

  const analyzed = results.filter((r) => r.status === 'analyzed').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  // After this batch, count what's still pending. Just-reprocessed rows now
  // have analyzed_at >= cutoff so they fall out of the predicate.
  const remaining = await dbCountAnalyzedConversationsInDateRangeBeforeCutoff(fromDate, toDate, cutoff);

  return NextResponse.json({
    fromDate,
    toDate,
    cutoff,
    remaining,
    processed: conversations.length,
    analyzed,
    failed,
    results,
    done: remaining === 0,
  });
}
