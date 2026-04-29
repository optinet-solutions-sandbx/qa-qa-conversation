import { NextResponse } from 'next/server';
import {
  dbListAllAsanaTickets,
  dbBatchUpdateAsanaStatus,
} from '@/lib/db';
import { fetchProjectTaskStatuses, isAsanaConfigured } from '@/lib/asana';

// Browser-callable mirror of /api/admin/sync-asana-statuses for the
// "Refresh status from Asana" button on /dashboard/asana. Has no
// CRON_SECRET gate because the dashboard runs without auth (matches the
// existing /api/dashboard/* pattern); the sync itself is read-from-Asana
// + idempotent write to one column, so blast radius is bounded.
//
// Cron and admin curl paths still go through their secret-protected routes.

export const maxDuration = 60;

export async function GET() {
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
    return NextResponse.json({ synced: 0, total: 0, missing: 0, asana_tasks_seen: 0 });
  }

  let statuses: Map<string, { completed: boolean; completed_at: string | null }>;
  try {
    statuses = await fetchProjectTaskStatuses();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }

  const now = new Date().toISOString();
  const updates: Array<{ id: string; completedAt?: string | null; deletedAt?: string | null }> = [];
  let missing = 0;
  for (const t of tickets) {
    const s = statuses.get(t.asana_task_gid);
    if (!s) {
      // Asana no longer returns this gid — mark deleted so the dashboard
      // count drops to match the live board. asana_task_gid stays set so
      // re-analysis won't recreate it.
      missing += 1;
      updates.push({ id: t.id, deletedAt: now });
      continue;
    }
    updates.push({
      id: t.id,
      completedAt: s.completed ? s.completed_at ?? now : null,
    });
  }

  try {
    await dbBatchUpdateAsanaStatus(updates);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  return NextResponse.json({
    synced: updates.length,
    total: tickets.length,
    missing,
    asana_tasks_seen: statuses.size,
  });
}
