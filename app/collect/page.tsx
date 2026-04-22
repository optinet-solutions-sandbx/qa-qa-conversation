'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/lib/store';
import { useToast } from '@/components/layout/ToastProvider';
import { useConfirm } from '@/components/layout/ConfirmProvider';
import { dbDeleteConversation } from '@/lib/db-client';
import type { Conversation, SyncJob } from '@/lib/types';

// ── Icons ─────────────────────────────────────────────────────────────────

function IconSync() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
    </svg>
  );
}
function IconTrash() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
    </svg>
  );
}
function IconEye() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}
function IconChevronLeft() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
    </svg>
  );
}
function IconChevronRight() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
    </svg>
  );
}
function IconSearch() {
  return (
    <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
    </svg>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function fmtCest(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris',
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function AnalyzedBadge({ conv }: { conv: Conversation }) {
  if (conv.summary || conv.sentiment || conv.resolution_status) {
    return <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">Analyzed</span>;
  }
  return <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-400">Not analyzed</span>;
}

// ── Sync status bar ───────────────────────────────────────────────────────

function SyncStatusBar({
  job,
  onCancel,
  onResume,
  onDismiss,
}: {
  job: SyncJob | null;
  onCancel: () => void;
  onResume: () => void;
  onDismiss: () => void;
}) {
  if (!job) return null;

  const pct = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;

  const configs: Record<string, { bg: string; dot: string; text: string }> = {
    running:   { bg: 'bg-blue-50 border-blue-200',     dot: 'bg-blue-500 animate-pulse',   text: 'text-blue-700' },
    done:      { bg: 'bg-emerald-50 border-emerald-200', dot: 'bg-emerald-500',             text: 'text-emerald-700' },
    cancelled: { bg: 'bg-amber-50 border-amber-200',   dot: 'bg-amber-500',                text: 'text-amber-700' },
    error:     { bg: 'bg-red-50 border-red-200',       dot: 'bg-red-500',                  text: 'text-red-700' },
  };
  const cfg = configs[job.status] ?? configs.error;

  const label: Record<string, string> = {
    running:   `Syncing from Intercom… ${job.total > 0 ? `${job.done}/${job.total}` : 'searching…'}`,
    done:      `Sync complete — ${job.done} conversations saved${job.error_count > 0 ? ` (${job.error_count} errors)` : ''}`,
    cancelled: `Cancelled — ${job.done} of ${job.total} saved. Resume to continue.`,
    error:     `Sync error: ${job.error_message ?? 'Unknown error'}`,
  };

  return (
    <div className={`flex items-center gap-3 px-4 py-2.5 border rounded-xl text-xs ${cfg.bg}`}>
      <span className={`w-2 h-2 rounded-full shrink-0 ${cfg.dot}`} />
      <span className={`flex-1 min-w-0 truncate font-medium ${cfg.text}`}>{label[job.status]}</span>

      {job.status === 'running' && job.total > 0 && (
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-24 h-1.5 bg-blue-200 rounded-full overflow-hidden">
            <div className="h-full bg-blue-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
          <span className="tabular-nums text-blue-600 font-semibold">{pct}%</span>
        </div>
      )}

      {job.status === 'running' && (
        <button onClick={onCancel} className="shrink-0 text-xs text-red-500 hover:text-red-700 font-medium px-2 py-0.5 rounded hover:bg-red-100 transition-colors">
          Cancel
        </button>
      )}
      {(job.status === 'cancelled' || job.status === 'error') && (
        <button onClick={onResume} className="shrink-0 text-xs text-blue-600 hover:text-blue-800 font-medium px-2 py-0.5 rounded hover:bg-blue-100 transition-colors">
          Resume
        </button>
      )}
      {job.status !== 'running' && (
        <button onClick={onDismiss} className="shrink-0 text-slate-400 hover:text-slate-600 px-1 text-sm leading-none" title="Dismiss">✕</button>
      )}
    </div>
  );
}

const PER_PAGE = 25;
const BATCH_SIZE = 3;

// ── Page ──────────────────────────────────────────────────────────────────

export default function CollectPage() {
  const router = useRouter();
  const { deleteConversation } = useStore();
  const { toast } = useToast();
  const confirm = useConfirm();

  const [date, setDate] = useState(yesterday());
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  const [rows, setRows] = useState<Conversation[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [tableError, setTableError] = useState<string | null>(null);

  const [syncJob, setSyncJob] = useState<SyncJob | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const cancelledRef = useRef(false);
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  // Prevents the background poll from overwriting local 'running' state with
  // a stale 'done' from the DB while startSync / resumeSync is actively driving batches.
  const syncActiveRef = useRef(false);

  // ── Load table from DB ──────────────────────────────────────────────────

  const loadTable = useCallback(async (p: number, d: string, s: string) => {
    setLoading(true);
    setTableError(null);
    try {
      const params = new URLSearchParams({ date: d, page: String(p), perPage: String(PER_PAGE) });
      if (s) params.set('search', s);
      const res = await fetch(`/api/collect?${params}`);
      if (!res.ok) { const j = await res.json(); throw new Error(j.error ?? 'Failed'); }
      const data = await res.json();
      setRows(data.conversations as Conversation[]);
      setTotal(data.total);
      setPage(p);
    } catch (e) {
      setTableError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Poll job status ─────────────────────────────────────────────────────

  const pollJob = useCallback(async (d: string) => {
    try {
      const res = await fetch(`/api/collect/sync?date=${d}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.status === 'idle') return;
      setSyncJob((current) => {
        // Don't let a stale DB 'done' overwrite an active client-driven sync
        if (syncActiveRef.current && data.status !== 'running') return current;
        return data as SyncJob;
      });
    } catch { /* ignore */ }
  }, []);

  const startPolling = useCallback((d: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => pollJob(d), 3000);
  }, [pollJob]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  // On mount + date change: check for existing job
  useEffect(() => {
    setDismissed(false);
    cancelledRef.current = false;
    void pollJob(date);
  }, [date, pollJob]);

  // Manage polling based on job status
  useEffect(() => {
    if (syncJob?.status === 'running') {
      startPolling(date);
    } else {
      stopPolling();
      if (syncJob?.status === 'done') {
        loadTable(0, date, search);
      }
    }
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncJob?.status]);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => { loadTable(0, date, search); }, [date, search, loadTable]);

  // ── Reconcile + complete ────────────────────────────────────────────────
  // After all batches finish, re-queries Intercom server-side to get the
  // canonical ID list, deletes any stale DB rows, then marks the job done.
  const reconcileAndComplete = useCallback(async (d: string) => {
    const res = await fetch('/api/collect/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reconcile', date: d }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast((j as { error?: string }).error ?? 'Reconcile failed', 'error');
    }
    await fetch('/api/collect/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'complete', date: d }),
    });
    setSyncJob((j) => j ? { ...j, status: 'done' } : j);
    loadTable(0, d, search);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadTable, toast]);

  // ── Batch loop (client-driven, survives navigation via resume) ──────────

  const runBatchLoop = useCallback(async (pendingIds: string[], d: string) => {
    cancelledRef.current = false;

    for (let i = 0; i < pendingIds.length; i += BATCH_SIZE) {
      if (cancelledRef.current) break;

      const batch = pendingIds.slice(i, i + BATCH_SIZE);
      try {
        const res = await fetch('/api/collect/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'batch', date: d, ids: batch }),
        });
        if (!res.ok) {
          const j = await res.json();
          throw new Error(j.error ?? 'Batch failed');
        }
      } catch (e) {
        // Network error — mark as error in DB, stop loop
        await fetch('/api/collect/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'error', date: d, message: (e as Error).message }),
        });
        setSyncJob((j) => j ? { ...j, status: 'error', error_message: (e as Error).message } : j);
        return;
      }

      // Small pause between batches for rate limit safety
      if (i + BATCH_SIZE < pendingIds.length) await sleep(300);
    }

    // Reconcile + complete is handled by the caller after the loop returns.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadTable]);

  // ── Start sync ──────────────────────────────────────────────────────────

  const startSync = async () => {
    setDismissed(false);
    syncActiveRef.current = true;
    setSyncJob({ id: date, status: 'running', total: 0, done: 0, error_count: 0, started_at: new Date().toISOString(), finished_at: null, error_message: null });

    try {
      const res = await fetch('/api/collect/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', date }),
      });
      const data = await res.json();
      if (!res.ok) { toast(data.error ?? 'Failed to start', 'error'); setSyncJob(null); return; }

      const { ids, total: t } = data as { ids: string[]; existingIds: string[]; total: number };

      setSyncJob((j) => j ? { ...j, total: t } : j);
      startPolling(date);
      await runBatchLoop(ids, date);
      if (!cancelledRef.current) await reconcileAndComplete(date);
    } catch (e) {
      toast((e as Error).message, 'error');
      setSyncJob(null);
    } finally {
      syncActiveRef.current = false;
    }
  };

  // ── Resume sync (after cancel/error) ───────────────────────────────────

  const resumeSync = async () => {
    if (!syncJob) return;
    setDismissed(false);
    cancelledRef.current = false;
    syncActiveRef.current = true;

    try {
      // Re-search Intercom for the date, then find which IDs are NOT yet in DB
      const res = await fetch('/api/collect/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', date }),
      });
      const data = await res.json();
      if (!res.ok) { toast(data.error ?? 'Failed to resume', 'error'); return; }

      const { ids, existingIds: existing, total: t } = data as { ids: string[]; existingIds: string[]; total: number };
      const existingSet = new Set<string>(existing);
      const pendingIds = ids.filter((id) => !existingSet.has(id));

      setSyncJob((j) => j ? { ...j, status: 'running', total: t, done: t - pendingIds.length } : j);
      startPolling(date);
      await runBatchLoop(pendingIds, date);
      if (!cancelledRef.current) await reconcileAndComplete(date);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      syncActiveRef.current = false;
    }
  };

  // ── Cancel sync ─────────────────────────────────────────────────────────

  const cancelSync = async () => {
    cancelledRef.current = true;
    await fetch('/api/collect/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', date }),
    });
    setSyncJob((j) => j ? { ...j, status: 'cancelled' } : j);
  };

  // ── Delete ──────────────────────────────────────────────────────────────

  const [selected, setSelected] = useState<Set<string>>(new Set());

  const deleteOne = async (conv: Conversation, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!await confirm('Delete this conversation?', { danger: true, confirmLabel: 'Delete' })) return;
    deleteConversation(conv.id);
    await dbDeleteConversation(conv.id);
    setRows((prev) => prev.filter((r) => r.id !== conv.id));
    setTotal((t) => t - 1);
    setSelected((prev) => { const n = new Set(prev); n.delete(conv.id); return n; });
    toast('Conversation deleted', 'success');
  };

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    if (!await confirm(`Delete ${selected.size} conversation(s)?`, { danger: true, confirmLabel: 'Delete' })) return;
    const ids = [...selected];
    ids.forEach((id) => { deleteConversation(id); dbDeleteConversation(id); });
    setRows((prev) => prev.filter((r) => !ids.includes(r.id)));
    setTotal((t) => t - ids.length);
    setSelected(new Set());
    toast(`${ids.length} conversation(s) deleted`, 'success');
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };
  const toggleAll = () => {
    setSelected(rows.length > 0 && selected.size === rows.length ? new Set() : new Set(rows.map((r) => r.id)));
  };

  // ── Pagination helpers ──────────────────────────────────────────────────

  const totalPages = Math.ceil(total / PER_PAGE);
  const isRunning = syncJob?.status === 'running';

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">

      {/* ── Header ── */}
      <div className="bg-white border-b border-slate-200 flex-shrink-0 px-6 py-4 space-y-3">
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-semibold text-slate-900">Collect Conversations</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Syncs full conversation details and player data from Intercom. You can navigate away — sync state is saved in the database.
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="date"
              value={date}
              max={yesterday()}
              onChange={(e) => { setDate(e.target.value); setSelected(new Set()); }}
              className="border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={startSync}
              disabled={isRunning}
              className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
            >
              {isRunning
                ? <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                : <IconSync />}
              {isRunning ? 'Syncing…' : 'Sync from Intercom'}
            </button>
          </div>
        </div>

        {syncJob && !dismissed && (
          <SyncStatusBar
            job={syncJob}
            onCancel={cancelSync}
            onResume={resumeSync}
            onDismiss={() => setDismissed(true)}
          />
        )}
      </div>

      {/* ── Toolbar ── */}
      <div className="bg-white border-b border-slate-100 px-6 py-2.5 flex items-center gap-3 flex-shrink-0">
        <div className="relative flex-1 max-w-xs">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"><IconSearch /></span>
          <input
            type="text"
            placeholder="Search player, brand, query type…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-full pl-7 pr-3 py-1.5 border border-slate-200 rounded-lg text-xs text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <span className="text-xs text-slate-400 ml-auto">
          {loading ? 'Loading…' : <><span className="font-semibold text-slate-700">{total}</span> conversations</>}
        </span>
        {selected.size > 0 && (
          <button
            onClick={deleteSelected}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-white bg-red-500 hover:bg-red-600 px-3 py-1.5 rounded-lg transition-colors"
          >
            <IconTrash />
            Delete {selected.size}
          </button>
        )}
      </div>

      {/* ── Table ── */}
      <div className="flex-1 overflow-y-auto">
        {tableError && (
          <div className="m-6 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">{tableError}</div>
        )}

        {!loading && rows.length === 0 && !tableError && (
          <div className="flex flex-col items-center justify-center py-32 text-center px-4">
            <p className="text-sm font-medium text-slate-500">No conversations in database for {date}</p>
            <p className="text-xs text-slate-400 mt-1">Use &ldquo;Sync from Intercom&rdquo; to import conversations with full transcripts and player details.</p>
          </div>
        )}

        {(loading || rows.length > 0) && (
          <div className="bg-white">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50 sticky top-0 z-10">
                    <th className="px-4 py-3 w-8">
                      <input type="checkbox" checked={rows.length > 0 && selected.size === rows.length} onChange={toggleAll} className="rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                    </th>
                    <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400 whitespace-nowrap">Time (CEST)</th>
                    <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Subject</th>
                    <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Player</th>
                    <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Brand</th>
                    <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Query Type</th>
                    <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Analyzed</th>
                    <th className="px-4 py-3 w-20" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {loading
                    ? Array.from({ length: 8 }).map((_, i) => (
                        <tr key={i} className="animate-pulse">
                          {Array.from({ length: 8 }).map((__, j) => (
                            <td key={j} className="px-4 py-3"><div className="h-3 bg-slate-100 rounded w-full max-w-[120px]" /></td>
                          ))}
                        </tr>
                      ))
                    : rows.map((row) => (
                        <tr key={row.id} className={`hover:bg-slate-50 transition-colors ${selected.has(row.id) ? 'bg-blue-50/40' : ''}`}>
                          <td className="px-4 py-3">
                            <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggleSelect(row.id)} className="rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{fmtCest(row.intercom_created_at)}</td>
                          <td className="px-4 py-3 max-w-[220px]">
                            <p className="text-xs font-medium text-slate-800 truncate">{row.title}</p>
                            {row.intercom_id && <p className="text-[10px] text-slate-400">#{row.intercom_id}</p>}
                          </td>
                          <td className="px-4 py-3 max-w-[160px]">
                            {row.player_name || row.player_email ? (
                              <button onClick={() => row.player_id && router.push(`/players/${row.player_id}`)} className="text-left group" title="View player (coming soon)">
                                <p className="text-xs font-medium text-slate-700 truncate group-hover:text-blue-600 transition-colors">{row.player_name ?? '—'}</p>
                                {row.player_email && <p className="text-[10px] text-slate-400 truncate">{row.player_email}</p>}
                              </button>
                            ) : <span className="text-slate-300 text-xs">—</span>}
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-600 whitespace-nowrap">{row.brand ?? <span className="text-slate-300">—</span>}</td>
                          <td className="px-4 py-3 text-xs text-slate-600 max-w-[120px] truncate">{row.query_type ?? <span className="text-slate-300">—</span>}</td>
                          <td className="px-4 py-3"><AnalyzedBadge conv={row} /></td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1 justify-end">
                              <button onClick={() => router.push(`/conversations/${row.id}`)} className="p-1.5 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors" title="View conversation">
                                <IconEye />
                              </button>
                              <button onClick={(e) => deleteOne(row, e)} className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors" title="Delete">
                                <IconTrash />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Pagination ── */}
        {!loading && totalPages > 1 && (
          <div className="flex items-center justify-between px-6 py-3 bg-white border-t border-slate-100">
            <p className="text-xs text-slate-400">Page {page + 1} of {totalPages} — {total} total</p>
            <div className="flex items-center gap-1">
              <button onClick={() => loadTable(page - 1, date, search)} disabled={page === 0} className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed">
                <IconChevronLeft />
              </button>
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                const start = Math.max(0, Math.min(page - 3, totalPages - 7));
                const pageNum = start + i;
                return (
                  <button
                    key={`page-${pageNum}`}
                    onClick={() => loadTable(pageNum, date, search)}
                    className={`w-8 h-8 rounded-lg text-xs font-medium transition-colors ${
                      pageNum === page ? 'bg-slate-800 text-white' : 'border border-slate-200 text-slate-500 hover:bg-slate-50'
                    }`}
                  >
                    {pageNum + 1}
                  </button>
                );
              })}
              <button
                onClick={() => loadTable(page + 1, date, search)}
                disabled={page >= totalPages - 1}
                className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <IconChevronRight />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
