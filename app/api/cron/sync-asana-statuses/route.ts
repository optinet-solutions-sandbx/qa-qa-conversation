import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  dbListAllAsanaTickets,
  dbBatchUpdateAsanaStatus,
} from '@/lib/db';
import { fetchProjectTaskStatuses, isAsanaConfigured } from '@/lib/asana';

// Vercel cron tick — refreshes asana_completed_at for every ticketed
// conversation by pulling task status from Asana in one project-level sweep.
// Schedule lives in vercel.json. Manual equivalent (with browser-friendly
// ?secret= auth) is /api/admin/sync-asana-statuses.

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

  const tickets = await dbListAllAsanaTickets();
  if (tickets.length === 0) {
    return NextResponse.json({ synced: 0, total: 0 });
  }

  const statuses = await fetchProjectTaskStatuses();

  const now = new Date().toISOString();
  const updates: Array<{ id: string; completedAt?: string | null; deletedAt?: string | null }> = [];
  let missing = 0;
  for (const t of tickets) {
    const s = statuses.get(t.asana_task_gid);
    if (!s) {
      // Asana no longer returns this gid — flag it so the dashboard count
      // drops; gid stays so re-analysis can't recreate the deleted ticket.
      missing += 1;
      updates.push({ id: t.id, deletedAt: now });
      continue;
    }
    updates.push({
      id: t.id,
      completedAt: s.completed ? s.completed_at ?? now : null,
    });
  }

  await dbBatchUpdateAsanaStatus(updates);

  return NextResponse.json({
    synced: updates.length,
    total: tickets.length,
    missing,
    asana_tasks_seen: statuses.size,
  });
}
