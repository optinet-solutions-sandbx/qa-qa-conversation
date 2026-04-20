import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { searchConversationsByDate, cestDateToUnixRange } from '@/lib/intercom';
import { supabase } from '@/lib/supabase';

const CHUNK_SIZE = 500;

interface DbRow {
  id: string;
  intercom_id: string | null;
  summary: string | null;
  original_text: string | null;
  analyzed_at: string | null;
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
    if (error) throw new Error(`[db] query conversations: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < CHUNK_SIZE) break;
    from += CHUNK_SIZE;
  }
  return rows;
}

// Among duplicates for the same intercom_id, pick the row most worth keeping:
// analyzed > has transcript > latest analyzed_at
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
  let nonChatCount = 0;
  let duplicateCount = 0;
  let toKeepCount = 0;

  for (const [intercomId, rows] of byIntercomId) {
    if (!validIntercomIds.has(intercomId)) {
      // Non-chat: delete all (including any duplicates of this non-chat ID)
      nonChatCount += rows.length;
      toDelete.push(...rows.map((r) => r.id));
    } else {
      // Valid chat: keep the best row, delete the rest
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
    if (error) throw new Error(`[db] bulk delete: ${error.message}`);
  }
}

// GET ?date=YYYY-MM-DD  →  dry-run preview
export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date param required (YYYY-MM-DD)' }, { status: 400 });
  }
  const apiKey = process.env.INTERCOM_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'INTERCOM_API_KEY not configured' }, { status: 500 });

  try {
    const [intercomItems, dbRows] = await Promise.all([
      searchConversationsByDate(date, apiKey),
      getDbRowsForDate(date),
    ]);

    const validIds = new Set(intercomItems.map((i) => i.intercom_id));
    const { toDelete, toKeepCount, nonChatCount, duplicateCount } = computeCleanup(validIds, dbRows);

    return NextResponse.json({
      date,
      intercom_chat_count: intercomItems.length,
      db_total_count: dbRows.length,
      to_delete_total: toDelete.length,
      breakdown: {
        non_chat_to_delete: nonChatCount,
        duplicates_to_delete: duplicateCount,
      },
      db_after_count: toKeepCount,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

// POST { date }  →  execute cleanup
export async function POST(req: NextRequest) {
  const apiKey = process.env.INTERCOM_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'INTERCOM_API_KEY not configured' }, { status: 500 });

  let body: { date: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const { date } = body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date field required (YYYY-MM-DD)' }, { status: 400 });
  }

  try {
    const [intercomItems, dbRows] = await Promise.all([
      searchConversationsByDate(date, apiKey),
      getDbRowsForDate(date),
    ]);

    const validIds = new Set(intercomItems.map((i) => i.intercom_id));
    const { toDelete, toKeepCount, nonChatCount, duplicateCount } = computeCleanup(validIds, dbRows);

    if (toDelete.length === 0) {
      return NextResponse.json({ date, deleted_count: 0, message: 'Already clean.' });
    }

    await bulkDelete(toDelete);

    return NextResponse.json({
      date,
      intercom_chat_count: intercomItems.length,
      db_before_count: dbRows.length,
      deleted_count: toDelete.length,
      breakdown: {
        non_chat_deleted: nonChatCount,
        duplicates_deleted: duplicateCount,
      },
      db_after_count: toKeepCount,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
