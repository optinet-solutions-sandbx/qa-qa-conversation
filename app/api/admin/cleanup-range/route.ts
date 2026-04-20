import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { searchConversationsByDate, cestDateToUnixRange } from '@/lib/intercom';
import { supabase } from '@/lib/supabase';

export const maxDuration = 300;

const CHUNK_SIZE = 500;

interface DbRow {
  id: string;
  intercom_id: string | null;
  summary: string | null;
  original_text: string | null;
  analyzed_at: string | null;
}

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

async function getDbRowsForDate(date: string): Promise<DbRow[]> {
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
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < CHUNK_SIZE) break;
    from += CHUNK_SIZE;
  }
  return rows;
}

function pickBestRow(rows: DbRow[]): string {
  const sorted = [...rows].sort((a, b) => {
    const aScore = (a.summary ? 2 : 0) + (a.original_text ? 1 : 0);
    const bScore = (b.summary ? 2 : 0) + (b.original_text ? 1 : 0);
    if (aScore !== bScore) return bScore - aScore;
    const aTime = a.analyzed_at ? new Date(a.analyzed_at).getTime() : 0;
    const bTime = b.analyzed_at ? new Date(b.analyzed_at).getTime() : 0;
    return bTime - aTime;
  });
  return sorted[0].id;
}

function computeCleanup(validIntercomIds: Set<string>, dbRows: DbRow[]) {
  const byIntercomId = new Map<string, DbRow[]>();
  for (const row of dbRows) {
    if (!row.intercom_id) continue;
    if (!byIntercomId.has(row.intercom_id)) byIntercomId.set(row.intercom_id, []);
    byIntercomId.get(row.intercom_id)!.push(row);
  }
  const toDelete: string[] = [];
  let nonChatCount = 0, duplicateCount = 0, toKeepCount = 0;
  for (const [intercomId, rows] of byIntercomId) {
    if (!validIntercomIds.has(intercomId)) {
      nonChatCount += rows.length;
      toDelete.push(...rows.map((r) => r.id));
    } else {
      const bestId = pickBestRow(rows);
      toKeepCount++;
      const dupes = rows.filter((r) => r.id !== bestId);
      duplicateCount += dupes.length;
      toDelete.push(...dupes.map((r) => r.id));
    }
  }
  return { toDelete, toKeepCount, nonChatCount, duplicateCount };
}

async function bulkDelete(ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    await supabase.from('analysis_runs').delete().in('conversation_id', chunk);
    const { error } = await supabase.from('conversations').delete().in('id', chunk);
    if (error) throw new Error(`bulk delete: ${error.message}`);
  }
}

async function runCleanup(dates: string[], apiKey: string, dryRun: boolean) {
  console.log(`[cleanup-range] Starting ${dryRun ? 'dry-run' : 'cleanup'} for ${dates.length} dates`);
  for (const date of dates) {
    try {
      const [intercomItems, dbRows] = await Promise.all([
        searchConversationsByDate(date, apiKey),
        getDbRowsForDate(date),
      ]);
      const validIds = new Set(intercomItems.map((i) => i.intercom_id));
      const { toDelete, toKeepCount, nonChatCount, duplicateCount } = computeCleanup(validIds, dbRows);

      if (!dryRun && toDelete.length > 0) await bulkDelete(toDelete);

      console.log(
        `[cleanup-range] ${date}: db=${dbRows.length} intercom=${intercomItems.length}` +
        ` non_chat=${nonChatCount} dupes=${duplicateCount} deleted=${dryRun ? 0 : toDelete.length} after=${toKeepCount}`
      );
    } catch (e) {
      console.error(`[cleanup-range] ${date} failed:`, (e as Error).message);
    }
    await sleep(500);
  }
  console.log(`[cleanup-range] Done.`);
}

// GET  ?startDate=&endDate=          → dry-run across range
// POST { startDate, endDate }        → execute cleanup across range
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const apiKey = process.env.INTERCOM_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'INTERCOM_API_KEY not configured' }, { status: 500 });

  const startDate = req.nextUrl.searchParams.get('startDate');
  const endDate   = req.nextUrl.searchParams.get('endDate');
  if (!startDate || !endDate) return NextResponse.json({ error: 'startDate and endDate required' }, { status: 400 });

  const dates = datesInRange(startDate, endDate);
  waitUntil(runCleanup(dates, apiKey, true));
  return NextResponse.json({ message: `Dry-run started for ${dates.length} dates`, startDate, endDate });
}

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const apiKey = process.env.INTERCOM_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'INTERCOM_API_KEY not configured' }, { status: 500 });

  let body: { startDate: string; endDate: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const { startDate, endDate } = body;
  if (!startDate || !endDate) return NextResponse.json({ error: 'startDate and endDate required' }, { status: 400 });

  const dates = datesInRange(startDate, endDate);
  waitUntil(runCleanup(dates, apiKey, false));
  return NextResponse.json({ message: `Cleanup started for ${dates.length} dates`, startDate, endDate });
}
