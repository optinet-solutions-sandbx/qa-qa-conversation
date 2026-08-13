import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isAsanaConfigured } from '@/lib/asana';
import { reconcileAsanaStatuses, reconcileAccountManagers, reconcileTrioOwners } from '@/lib/asana-sync';

// Manual trigger for the Asana status sync — same reconcileAsanaStatuses() the
// */15 cron runs, so they can't drift. Reconciles asana_completed_at /
// asana_task_deleted_at against the live board (the reporting page reads those
// columns to show open vs closed counts without hitting Asana on every load).
// Handy for clearing a backlog on demand instead of waiting for the next tick.
//
// Auth (optional but recommended): set CRON_SECRET and pass either
//   - Authorization: Bearer <secret>      (curl / cron)
//   - ?secret=<secret>                    (browser-friendly)
//
// Idempotent and chunked, so re-running is cheap and a partial run self-heals.

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization') ?? '';
    const querySecret = new URL(req.url).searchParams.get('secret') ?? '';
    if (auth !== `Bearer ${secret}` && querySecret !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }
  if (!isAsanaConfigured()) {
    return NextResponse.json(
      { error: 'Asana not configured — set ASANA_ACCESS_TOKEN and ASANA_PROJECT_GID' },
      { status: 400 },
    );
  }

  // Query flags:
  //   ?amOnly=1   run only the ownership passes (skip the status reconcile)
  //   ?dryRun=1   report what the ownership passes WOULD change without writing
  //               to Asana or Supabase — use this before a first run on a busy
  //               board.
  const params = new URL(req.url).searchParams;
  const dryRun = params.get('dryRun') === '1' || params.get('dryRun') === 'true';
  const amOnly = params.get('amOnly') === '1' || params.get('amOnly') === 'true';

  try {
    const accountManagers = await reconcileAccountManagers({ dryRun });
    const trioOwners = await reconcileTrioOwners({ dryRun });
    if (amOnly || dryRun) return NextResponse.json({ dryRun, accountManagers, trioOwners });
    const statuses = await reconcileAsanaStatuses();
    return NextResponse.json({ accountManagers, trioOwners, statuses });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
