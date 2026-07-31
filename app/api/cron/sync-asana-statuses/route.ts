import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isAsanaConfigured } from '@/lib/asana';
import { reconcileAsanaStatuses, reconcileAccountManagers } from '@/lib/asana-sync';

// Vercel cron tick — refreshes asana_completed_at for every ticketed
// conversation by pulling task status from Asana in one project-level sweep.
// Schedule lives in vercel.json. Manual equivalent (with browser-friendly
// ?secret= auth) is /api/admin/sync-asana-statuses.
//
// Two passes, in this order:
//   1. reconcileAccountManagers — re-reads live Intercom groups for open
//      tickets and follows the player when ops move them between portfolios
//      (re-routes to the new AM, or closes if they became SoftSwiss).
//   2. reconcileAsanaStatuses — reconciles completion state against the board.
// AM first on purpose: any ticket pass 1 closes gets its asana_completed_at
// stamped by pass 2 in the same tick instead of waiting 15 more minutes.

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization') ?? '';
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }
  if (!isAsanaConfigured()) {
    return NextResponse.json({ skipped: 'asana not configured' });
  }

  // Never let an AM-pass failure stop the status reconcile — that one keeps the
  // dashboard's open/closed counts honest and must run every tick.
  let accountManagers;
  try {
    accountManagers = await reconcileAccountManagers();
  } catch (e) {
    console.error('[asana-sync] AM re-derive threw:', (e as Error).message);
    accountManagers = { error: (e as Error).message };
  }

  const statuses = await reconcileAsanaStatuses();
  return NextResponse.json({ accountManagers, statuses });
}
