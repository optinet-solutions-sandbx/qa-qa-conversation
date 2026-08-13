import {
  dbListAllAsanaTickets,
  dbBatchUpdateAsanaStatus,
  dbListOpenTicketsForAmRederive,
  dbBatchUpdateAccountManager,
} from '@/lib/db';
import {
  fetchOpenProjectTasks,
  fetchTasksCompletion,
  fetchTrioColumnTasks,
  rerouteAsanaTaskToAm,
  closeAsanaTaskAsNoActionNeeded,
  setAsanaTaskAmField,
  tallyTrioLoad,
  trioMemberFromAssigneeName,
} from '@/lib/asana';
import { fetchLiveContactGroups } from '@/lib/intercom';
import { amFromGroups } from '@/lib/utils';

// Shared body for both /api/cron/sync-asana-statuses and the admin manual
// trigger, so the two can't drift. Reconciles each ticketed conversation's
// asana_completed_at / asana_task_deleted_at against the live Asana board.
//
// Strategy (bounded, history-independent):
//   1. Pull the project's OPEN (incomplete) task gids — fetchOpenProjectTasks
//      uses completed_since=now, so this set stays small no matter how many
//      tasks were completed over the project's lifetime. This is what stops the
//      sweep from slowly outgrowing the cron timeout and silently dying.
//   2. A DB ticket whose gid is still open: ensure it isn't marked completed
//      (clears the flag if a task was reopened in Asana).
//   3. A DB ticket whose gid left the open set AND was still open in the DB is
//      a fresh close — we classify just those via per-task GETs (completed vs
//      deleted). Tickets already marked completed are left alone.
//
// Writes are idempotent and chunked, so a partial run self-heals next tick.

// Cap on how many fresh closes we classify per run. Steady state this is a
// handful; the only time it's large is the first run after deploy clearing a
// backlog, which still fits comfortably. Anything beyond the cap is deferred to
// the next tick (logged, not dropped).
const CLASSIFY_CAP = 500;

export interface AsanaSyncResult {
  total: number;      // ticketed conversations considered
  open: number;       // tasks open on the board right now
  reopened: number;   // were completed in DB, now open again on the board
  completed: number;  // newly marked completed
  deleted: number;    // gid no longer exists in Asana
  deferred: number;   // fresh closes beyond CLASSIFY_CAP, left for next tick
  failed: number;     // row updates that errored (retried next tick)
}

export async function reconcileAsanaStatuses(): Promise<AsanaSyncResult> {
  const tickets = await dbListAllAsanaTickets();
  if (tickets.length === 0) {
    return { total: 0, open: 0, reopened: 0, completed: 0, deleted: 0, deferred: 0, failed: 0 };
  }

  const openTasks = await fetchOpenProjectTasks();
  const openSet = new Set(openTasks.map((t) => t.gid));

  const updates: Array<{ id: string; completedAt?: string | null; deletedAt?: string | null }> = [];
  const freshCloses: Array<{ id: string; gid: string }> = [];
  let reopened = 0;

  for (const t of tickets) {
    if (openSet.has(t.asana_task_gid)) {
      // Open on the board. If we had it marked completed, it was reopened.
      if (t.completedAt != null) {
        updates.push({ id: t.id, completedAt: null });
        reopened += 1;
      }
      continue;
    }
    // Not in the open set. Only the ones still open in our DB are fresh closes
    // worth classifying; ones already completed stay as they are.
    if (t.completedAt == null) {
      freshCloses.push({ id: t.id, gid: t.asana_task_gid });
    }
  }

  const toClassify = freshCloses.slice(0, CLASSIFY_CAP);
  const deferred = freshCloses.length - toClassify.length;

  const now = new Date().toISOString();
  let completed = 0;
  let deleted = 0;
  if (toClassify.length > 0) {
    const statuses = await fetchTasksCompletion(toClassify.map((c) => c.gid));
    for (const c of toClassify) {
      const s = statuses.get(c.gid);
      if (!s) continue; // no verdict this run (e.g. transient) — retry next tick
      if (!s.exists) {
        updates.push({ id: c.id, deletedAt: now });
        deleted += 1;
      } else if (s.completed) {
        updates.push({ id: c.id, completedAt: s.completed_at ?? now });
        completed += 1;
      }
      // exists && !completed: open in Asana but not in our project's open
      // board (moved out, or a transient sweep miss). Leave it untouched rather
      // than risk permanently hiding a still-open ticket.
    }
  }

  const { failed } = await dbBatchUpdateAsanaStatus(updates);

  const result: AsanaSyncResult = {
    total: tickets.length,
    open: openSet.size,
    reopened,
    completed,
    deleted,
    deferred,
    failed,
  };

  console.log(
    `[asana-sync] total=${result.total} open=${result.open} reopened=${reopened} ` +
      `completed=${completed} deleted=${deleted} deferred=${deferred} failed=${failed}`,
  );
  return result;
}

// ── AM re-derive sweep ──────────────────────────────────────────────────────
// player_tags is snapshotted when a chat is collected, so a ticket keeps the AM
// that was correct at that moment. Ops re-tag players between portfolios in
// Intercom all the time, and nothing corrected that afterwards: /api/backfill-am
// only fills rows where account_manager IS NULL. Measured 2026-07-31, 11 of 88
// open tickets had drifted — one player (Lucky Vibe / Kuwait) moved
// non-vip_koko -> non-vip_esam -> softswiss inside ten hours.
//
// Val asked on 2026-07-31 for tickets to follow the player, so this re-reads
// live Intercom groups for every OPEN ticket each tick and reconciles ownership.
// Two outcomes:
//   • drifted to a real AM  -> move column, re-stamp AM field + assignee, and
//     update the stored account_manager so the dashboard agrees with the board.
//   • drifted to SoftSwiss  -> close as "No Action Needed". SoftSwiss players
//     never escalate and there is deliberately no SoftSwiss column, so the
//     ticket should not exist. The stored account_manager is deliberately left
//     alone here: rewriting it would retroactively move the ticket out of the
//     previous AM's historical numbers, and the row is about to be marked
//     completed anyway.
//
// Closed tickets are never touched — dbListOpenTicketsForAmRederive filters to
// asana_completed_at IS NULL, so history stays immutable.

// Bounded so the sweep can't outgrow the cron's maxDuration. Each ticket costs
// three Intercom sub-resource GETs, run at RE_DERIVE_CONCURRENCY at a time.
// Steady state the open board is well under this; anything past the cap is
// logged and picked up next tick rather than silently skipped.
const RE_DERIVE_CAP = 400;
const RE_DERIVE_CONCURRENCY = 5;

export interface AmRederiveResult {
  considered: number;   // open tickets examined
  skippedNoPlayer: number; // no Intercom contact id on the row
  noLiveData: number;   // Intercom lookup failed or contact has no tags
  unchanged: number;    // live AM matches what we stored
  rerouted: number;     // moved to a different AM
  closed: number;       // closed because the player is now SoftSwiss
  failed: number;       // Asana write failed; retried next tick
  deferred: number;     // beyond RE_DERIVE_CAP, left for next tick
  dbFailed: number;     // account_manager write failed; retried next tick
  changes: Array<{ player: string | null; from: string | null; to: string; owner: string | null; action: 'reroute' | 'close' }>;
}

// Small bounded-concurrency map — avoids firing 400 concurrent Intercom reads
// (which would trip rate limiting) while still finishing well inside the tick.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function reconcileAccountManagers(
  opts: { dryRun?: boolean } = {},
): Promise<AmRederiveResult> {
  const dryRun = opts.dryRun === true;
  const empty: AmRederiveResult = {
    considered: 0, skippedNoPlayer: 0, noLiveData: 0, unchanged: 0, rerouted: 0,
    closed: 0, failed: 0, deferred: 0, dbFailed: 0, changes: [],
  };
  if (!process.env.INTERCOM_API_KEY) {
    console.warn('[am-rederive] INTERCOM_API_KEY unset; skipping');
    return empty;
  }

  const all = await dbListOpenTicketsForAmRederive();
  const tickets = all.slice(0, RE_DERIVE_CAP);
  const deferred = all.length - tickets.length;
  if (deferred > 0) {
    console.warn(`[am-rederive] ${all.length} open tickets exceeds cap ${RE_DERIVE_CAP}; deferring ${deferred} to next tick`);
  }
  if (tickets.length === 0) return { ...empty, deferred };

  let skippedNoPlayer = 0;
  const resolved = await mapLimit(tickets, RE_DERIVE_CONCURRENCY, async (t) => {
    if (!t.player_id) { skippedNoPlayer += 1; return null; }
    const liveGroups = await fetchLiveContactGroups(t.player_id);
    if (!liveGroups) return { t, live: null as string | null, noData: true };
    // Same four inputs as collection time; conv tags come from the stored row.
    const live = amFromGroups([...liveGroups, ...t.tags]);
    return { t, live, noData: false };
  });

  let noLiveData = 0, unchanged = 0, rerouted = 0, closed = 0, failed = 0;
  const changes: AmRederiveResult['changes'] = [];
  const dbUpdates: Array<{ id: string; accountManager: string }> = [];

  for (const r of resolved) {
    if (!r) continue;
    if (r.noData) { noLiveData += 1; continue; }
    const stored = (r.t.account_manager ?? '').trim() || null;
    // A null live result means no group resolved at all — no basis to change
    // anything, so leave the ticket with whoever has it.
    if (!r.live || r.live === stored) { unchanged += 1; continue; }

    const action = r.live === 'SoftSwiss' ? 'close' : 'reroute';
    if (dryRun) {
      changes.push({ player: r.t.player_name, from: stored, to: r.live, owner: null, action });
      if (action === 'close') closed += 1; else rerouted += 1;
      continue;
    }

    if (action === 'close') {
      const ok = await closeAsanaTaskAsNoActionNeeded(r.t.asana_task_gid);
      if (!ok) { failed += 1; continue; }
      closed += 1;
      changes.push({ player: r.t.player_name, from: stored, to: r.live, owner: null, action });
    } else {
      const res = await rerouteAsanaTaskToAm(r.t.asana_task_gid, r.live, r.t.id);
      if (!res.ok) { failed += 1; continue; }
      rerouted += 1;
      dbUpdates.push({ id: r.t.id, accountManager: r.live });
      changes.push({ player: r.t.player_name, from: stored, to: r.live, owner: res.owner, action });
    }
  }

  const { failed: dbFailed } = dryRun ? { failed: 0 } : await dbBatchUpdateAccountManager(dbUpdates);

  const result: AmRederiveResult = {
    considered: tickets.length, skippedNoPlayer, noLiveData, unchanged,
    rerouted, closed, failed, deferred, dbFailed, changes,
  };
  console.log(
    `[am-rederive]${dryRun ? ' DRY-RUN' : ''} considered=${result.considered} unchanged=${unchanged} ` +
      `rerouted=${rerouted} closed=${closed} noLiveData=${noLiveData} noPlayer=${skippedNoPlayer} ` +
      `failed=${failed} dbFailed=${dbFailed} deferred=${deferred}`,
  );
  for (const c of changes) {
    console.log(`[am-rederive]   ${c.action} ${c.player ?? '?'}: ${c.from ?? '(none)'} -> ${c.to}${c.owner && c.owner !== c.to ? ` (owner ${c.owner})` : ''}`);
  }
  return result;
}

// ── Trio owner sweep ────────────────────────────────────────────────────────
// The Geri/Martin/Allan column is shared by three people who hand tickets to
// each other by hand on the board (measured 2026-08-13: 4 of the 16 open cards
// had been passed on the previous day). Nothing reconciled that — the Account
// Manager field kept naming whoever the ticket was created for — so the board
// misreported the owner, which is a large part of why the column looked like it
// was all going to one person.
//
// This pass copies the assignee into the AM field. The assignee is never
// rewritten: a person moved that deliberately and their choice wins. It also
// keeps the least-loaded pick honest, since pickTrioOwner counts open tickets by
// assignee — after this runs, the field and the count agree.
//
// Tasks with no assignee, or an assignee outside the trio, are left untouched:
// there is nothing to copy, and guessing would undo a deliberate hand-off.
export interface TrioOwnerSyncResult {
  considered: number;  // open tasks in the trio column
  restamped: number;   // AM field brought in line with the assignee
  aligned: number;     // field already matched
  skipped: number;     // unassigned, or assignee outside the trio
  failed: number;      // Asana write failed; retried next tick
  // Open tickets each of the three is holding right now — the same count
  // pickTrioOwner balances on, so this is the number to quote when someone asks
  // whether the column is spread evenly.
  load: Record<string, number>;
  changes: Array<{ task: string; from: string | null; to: string }>;
}

export async function reconcileTrioOwners(
  opts: { dryRun?: boolean } = {},
): Promise<TrioOwnerSyncResult> {
  const dryRun = opts.dryRun === true;
  const result: TrioOwnerSyncResult = {
    considered: 0, restamped: 0, aligned: 0, skipped: 0, failed: 0, load: {}, changes: [],
  };

  const tasks = await fetchTrioColumnTasks();
  if (!tasks) {
    console.warn('[trio-sync] could not read the trio column; leaving ownership alone this tick');
    return result;
  }
  result.considered = tasks.length;
  result.load = Object.fromEntries(tallyTrioLoad(tasks));

  for (const t of tasks) {
    const owner = trioMemberFromAssigneeName(t.assignee);
    if (!owner) { result.skipped += 1; continue; }
    if (t.amOption === owner) { result.aligned += 1; continue; }

    if (!dryRun) {
      const ok = await setAsanaTaskAmField(t.gid, owner);
      if (!ok) { result.failed += 1; continue; }
    }
    result.restamped += 1;
    result.changes.push({ task: t.gid, from: t.amOption, to: owner });
  }

  console.log(
    `[trio-sync]${dryRun ? ' DRY-RUN' : ''} considered=${result.considered} ` +
      `restamped=${result.restamped} aligned=${result.aligned} skipped=${result.skipped} failed=${result.failed} ` +
      `load=${Object.entries(result.load).map(([o, n]) => `${o}:${n}`).join(' ')}`,
  );
  for (const c of result.changes) {
    console.log(`[trio-sync]   task ${c.task}: AM ${c.from ?? '(unset)'} -> ${c.to}`);
  }
  return result;
}
