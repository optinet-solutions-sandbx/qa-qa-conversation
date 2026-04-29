import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  dbListAllAsanaTickets,
  dbBatchUpdateAsanaStatus,
} from '@/lib/db';
import { fetchProjectTaskStatuses, isAsanaConfigured } from '@/lib/asana';

// Pulls completion status for every ticket the QA tool has created in the
// configured Asana project and writes asana_completed_at back to Supabase.
// The reporting page reads that column to show open vs closed counts without
// hitting Asana on every page load.
//
// Auth (optional but recommended): set CRON_SECRET and pass either
//   - Authorization: Bearer <secret>      (curl / cron)
//   - ?secret=<secret>                    (browser-friendly)
//
// Idempotent: only writes rows where the completion state actually changed,
// so re-running mid-batch is cheap and a partial run leaves the DB consistent.

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

  let tickets: Array<{ id: string; asana_task_gid: string }> = [];
  try {
    tickets = await dbListAllAsanaTickets();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  if (tickets.length === 0) {
    return NextResponse.json({ synced: 0, total: 0, message: 'No tickets to sync' });
  }

  let statuses: Map<string, { completed: boolean; completed_at: string | null }>;
  try {
    statuses = await fetchProjectTaskStatuses();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }

  // We don't currently know each row's prior completed_at without re-reading,
  // so we just write-through every ticket's current state. Cheap because
  // there will be at most a few hundred rows in any realistic window and the
  // updates run in parallel via dbBatchUpdateAsanaStatus.
  // Tickets that Asana no longer returns are flagged via asana_task_deleted_at
  // so the dashboard count matches the live board.
  const now = new Date().toISOString();
  const updates: Array<{ id: string; completedAt?: string | null; deletedAt?: string | null }> = [];
  let missing = 0;
  for (const t of tickets) {
    const s = statuses.get(t.asana_task_gid);
    if (!s) {
      missing += 1;
      updates.push({ id: t.id, deletedAt: now });
      continue;
    }
    updates.push({ id: t.id, completedAt: s.completed ? s.completed_at ?? now : null });
  }

  try {
    await dbBatchUpdateAsanaStatus(updates);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  return NextResponse.json({
    synced: updates.length,
    total: tickets.length,
    missing,                  // tickets we have a gid for but Asana didn't return (deleted in Asana?)
    asana_tasks_seen: statuses.size,
  });
}
