import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { searchConversationsByDate, rateLimitResetMsg } from '@/lib/intercom';
import { getExistingIntercomIds } from '@/lib/db';

// ── GET: search Intercom for a date and return IDs with existence flags ────

export async function GET(req: NextRequest) {
  const apiKey = process.env.INTERCOM_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'INTERCOM_API_KEY not configured' }, { status: 500 });

  const date = req.nextUrl.searchParams.get('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date param required (YYYY-MM-DD)' }, { status: 400 });
  }

  try {
    const all = await searchConversationsByDate(date, apiKey);
    // Only collect finished chats — skip open/snoozed until they're closed.
    const closed = all.filter((c) => c.state === 'closed');
    const existingIds = await getExistingIntercomIds(closed.map((c) => c.intercom_id));

    const ids = closed.map((c) => c.intercom_id);
    const newIds = ids.filter((id) => !existingIds.has(id));

    return NextResponse.json({ ids, newIds, total: ids.length, newCount: newIds.length });
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg.includes('rate limit') ? 429 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
