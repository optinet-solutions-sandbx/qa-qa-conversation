import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { buildPendingSnapshot, sendTelegramMessage } from '@/lib/telegram-snapshot';
import { supabase } from '@/lib/supabase';

// Manual trigger for the Telegram pending-cases snapshot. Same logic as the
// cron at /api/cron/telegram-pending-snapshot but accepts ?secret= for
// browser-friendly auth, ?dry=1 to preview the message without posting, and
// ?debug=1 to also return the oldest five open escalation rows so the age
// calculation can be sanity-checked against the source data.

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization') ?? '';
    const querySecret = new URL(req.url).searchParams.get('secret') ?? '';
    if (auth !== `Bearer ${secret}` && querySecret !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const url = new URL(req.url);
  const dry = url.searchParams.get('dry') === '1';
  const debug = url.searchParams.get('debug') === '1';

  try {
    const { total, byAm, message } = await buildPendingSnapshot();
    if (!dry) await sendTelegramMessage(message);

    let oldestFive: unknown = undefined;
    if (debug) {
      const { data } = await supabase
        .from('conversations')
        .select('id, intercom_created_at, analyzed_at, account_manager, asana_task_gid')
        .not('asana_task_gid', 'is', null)
        .is('asana_task_deleted_at', null)
        .is('asana_completed_at', null)
        .order('intercom_created_at', { ascending: true, nullsFirst: false })
        .limit(5);
      oldestFive = data;
    }

    return NextResponse.json({
      ok: true,
      sent: !dry,
      total,
      byAm: Object.fromEntries(byAm),
      message,
      ...(debug ? { oldestFive } : {}),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
