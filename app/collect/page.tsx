'use client';

import { useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { IntercomSearchItem } from '@/lib/intercom';

// ── Types ─────────────────────────────────────────────────────────────────

type ItemStatus = 'idle' | 'saving' | 'saved' | 'updated' | 'error';

interface Row extends IntercomSearchItem {
  is_existing: boolean;
  _status: ItemStatus;
  _error?: string;
}

// ── Icons ─────────────────────────────────────────────────────────────────

function IconDownload() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
    </svg>
  );
}
function IconSearch() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
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

// ── Helpers ───────────────────────────────────────────────────────────────

function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function fmtCest(unixSec: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', // CEST
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(unixSec * 1000));
}

// ── Status badge ──────────────────────────────────────────────────────────

function StatusBadge({ row }: { row: Row }) {
  if (row._status === 'saving') return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-blue-600">
      <span className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
      Saving…
    </span>
  );
  if (row._status === 'saved') return <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">Saved</span>;
  if (row._status === 'updated') return <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">Updated</span>;
  if (row._status === 'error') return <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-red-50 text-red-600" title={row._error}>Error</span>;
  if (row.is_existing) return <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">Collected</span>;
  return <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">New</span>;
}

const PER_PAGE = 25;

// ── Page ──────────────────────────────────────────────────────────────────

export default function CollectPage() {
  const router = useRouter();
  const [date, setDate] = useState(yesterday());
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasFetched, setHasFetched] = useState(false);
  const [collectingAll, setCollectingAll] = useState(false);
  const [collectProgress, setCollectProgress] = useState<{ done: number; total: number } | null>(null);
  const collectAbortRef = useRef<AbortController | null>(null);

  // ── Fetch list from Intercom ────────────────────────────────────────────

  const fetchPage = useCallback(async (p: number, selectedDate: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/collect?date=${selectedDate}&page=${p}&perPage=${PER_PAGE}`);
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? 'Failed to fetch'); }
      const data = await res.json();
      setRows((data.conversations as (IntercomSearchItem & { is_existing: boolean })[]).map((c) => ({ ...c, _status: 'idle' })));
      setTotal(data.total);
      setPage(p);
      setHasFetched(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleFetch = () => fetchPage(0, date);

  // ── Save a single row ───────────────────────────────────────────────────

  const saveRow = async (intercomId: string) => {
    setRows((prev) => prev.map((r) => r.intercom_id === intercomId ? { ...r, _status: 'saving' } : r));
    try {
      const res = await fetch('/api/collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intercomIds: [intercomId] }),
      });
      const data = await res.json();
      const result = data.results?.[0];
      setRows((prev) => prev.map((r) => r.intercom_id === intercomId
        ? { ...r, _status: result?.status ?? 'error', _error: result?.error, is_existing: true }
        : r
      ));
    } catch (e) {
      setRows((prev) => prev.map((r) => r.intercom_id === intercomId ? { ...r, _status: 'error', _error: (e as Error).message } : r));
    }
  };

  // ── Cancel collect ──────────────────────────────────────────────────────

  const cancelCollect = () => {
    collectAbortRef.current?.abort();
  };

  // ── Collect all new ─────────────────────────────────────────────────────

  const collectAllNew = async () => {
    const controller = new AbortController();
    collectAbortRef.current = controller;
    const { signal } = controller;

    setCollectingAll(true);
    setCollectProgress(null);

    try {
      // Gather all new IDs across all pages
      let allNew: string[] = [];
      const pageCount = Math.ceil(total / PER_PAGE);
      for (let p = 0; p < pageCount; p++) {
        if (signal.aborted) break;
        const res = await fetch(`/api/collect?date=${date}&page=${p}&perPage=${PER_PAGE}`, { signal });
        const data = await res.json();
        const newIds = (data.conversations as (IntercomSearchItem & { is_existing: boolean })[])
          .filter((c) => !c.is_existing)
          .map((c) => c.intercom_id);
        allNew = [...allNew, ...newIds];
      }

      if (signal.aborted || allNew.length === 0) return;

      setCollectProgress({ done: 0, total: allNew.length });

      // Mark visible new rows as saving
      setRows((prev) => prev.map((r) => allNew.includes(r.intercom_id) ? { ...r, _status: 'saving' } : r));

      // Send in batches of 5
      const BATCH = 5;
      let done = 0;
      for (let i = 0; i < allNew.length; i += BATCH) {
        if (signal.aborted) {
          // Reset rows still in 'saving' back to 'idle'
          setRows((prev) => prev.map((r) => r._status === 'saving' ? { ...r, _status: 'idle' } : r));
          break;
        }
        const batch = allNew.slice(i, i + BATCH);
        const res = await fetch('/api/collect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ intercomIds: batch }),
          signal,
        });
        const data = await res.json();
        for (const result of data.results ?? []) {
          setRows((prev) => prev.map((r) => r.intercom_id === result.id
            ? { ...r, _status: result.status, _error: result.error, is_existing: true }
            : r
          ));
        }
        done += batch.length;
        setCollectProgress({ done, total: allNew.length });
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setError((e as Error).message);
      }
      // On abort, reset any rows stuck in saving
      setRows((prev) => prev.map((r) => r._status === 'saving' ? { ...r, _status: 'idle' } : r));
    } finally {
      setCollectingAll(false);
      setCollectProgress(null);
      collectAbortRef.current = null;
    }
  };

  // ── Derived stats ───────────────────────────────────────────────────────

  const newCount = rows.filter((r) => !r.is_existing && r._status === 'idle').length;
  const savedCount = rows.filter((r) => r._status === 'saved' || r._status === 'updated').length;
  const totalPages = Math.ceil(total / PER_PAGE);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">

      {/* Header */}
      <div className="bg-white border-b border-slate-200 flex-shrink-0">
        <div className="flex items-center gap-3 px-6 py-4 flex-wrap">
          <div>
            <h1 className="text-sm font-semibold text-slate-900">Collect Conversations</h1>
            <p className="text-xs text-slate-400 mt-0.5">Fetch from Intercom by date and save to database</p>
          </div>
          <div className="flex items-center gap-2 ml-auto flex-wrap">
            <input
              type="date"
              value={date}
              max={yesterday()}
              onChange={(e) => setDate(e.target.value)}
              className="border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={handleFetch}
              disabled={loading}
              className="inline-flex items-center gap-1.5 bg-slate-800 hover:bg-slate-900 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
            >
              {loading ? <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <IconSearch />}
              {loading ? 'Fetching…' : 'Fetch'}
            </button>
            {hasFetched && !collectingAll && newCount > 0 && (
              <button
                onClick={collectAllNew}
                className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
              >
                <IconDownload />
                Collect All New ({newCount})
              </button>
            )}
            {collectingAll && (
              <div className="inline-flex items-center gap-2">
                {collectProgress && (
                  <div className="flex items-center gap-1.5">
                    <div className="w-24 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 rounded-full transition-all duration-300"
                        style={{ width: `${Math.round((collectProgress.done / collectProgress.total) * 100)}%` }}
                      />
                    </div>
                    <span className="text-xs text-slate-500 tabular-nums">{collectProgress.done}/{collectProgress.total}</span>
                  </div>
                )}
                <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                  <span className="w-3.5 h-3.5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                  Collecting…
                </span>
                <button
                  onClick={cancelCollect}
                  className="text-xs font-medium text-red-500 hover:text-red-700 px-2 py-1 rounded-lg hover:bg-red-50 transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Stats bar */}
        {hasFetched && !loading && (
          <div className="flex items-center gap-6 px-6 pb-3 text-xs text-slate-500">
            <span><span className="font-semibold text-slate-800">{total}</span> conversations on {date} (CEST)</span>
            <span><span className="font-semibold text-emerald-600">{rows.filter((r) => r.is_existing).length + savedCount}</span> already in database</span>
            {newCount > 0 && <span><span className="font-semibold text-amber-600">{newCount}</span> new</span>}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3 mb-4">{error}</div>
        )}

        {!hasFetched && !loading && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-12 h-12 bg-slate-100 rounded-2xl flex items-center justify-center mb-4">
              <IconDownload />
            </div>
            <p className="text-sm font-medium text-slate-600">Select a date and click Fetch</p>
            <p className="text-xs text-slate-400 mt-1">Conversations will be fetched from Intercom in CEST timezone</p>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center py-24">
            <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {hasFetched && !loading && rows.length === 0 && (
          <div className="text-center py-24 text-slate-400 text-sm">No conversations found for {date}.</div>
        )}

        {hasFetched && !loading && rows.length > 0 && (
          <>
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50">
                      <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400 whitespace-nowrap">Time (CEST)</th>
                      <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Subject</th>
                      <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Player</th>
                      <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Brand</th>
                      <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Query Type</th>
                      <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">State</th>
                      <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Status</th>
                      <th className="px-4 py-3 w-20" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {rows.map((row) => (
                      <tr key={row.intercom_id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                          {fmtCest(row.created_at)}
                        </td>
                        <td className="px-4 py-3 max-w-[220px]">
                          <p className="text-xs font-medium text-slate-800 truncate">
                            {row.title || <span className="text-slate-400 italic">No subject</span>}
                          </p>
                          <p className="text-[10px] text-slate-400">#{row.intercom_id}</p>
                        </td>
                        <td className="px-4 py-3 max-w-[160px]">
                          {row.player_name || row.player_email ? (
                            <button
                              onClick={() => row.player_id && router.push(`/players/${row.player_id}`)}
                              className="text-left group"
                              title="View player conversations (coming soon)"
                            >
                              <p className="text-xs font-medium text-slate-700 truncate group-hover:text-blue-600 transition-colors">
                                {row.player_name ?? '—'}
                              </p>
                              {row.player_email && (
                                <p className="text-[10px] text-slate-400 truncate">{row.player_email}</p>
                              )}
                            </button>
                          ) : (
                            <span className="text-slate-300 text-xs">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-600 whitespace-nowrap">
                          {row.brand ?? <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-600 max-w-[120px] truncate">
                          {row.query_type ?? <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                            row.state === 'open' ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-500'
                          }`}>
                            {row.state}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge row={row} />
                        </td>
                        <td className="px-4 py-3 text-right">
                          {(row._status === 'idle' || row._status === 'error') && (
                            <button
                              onClick={() => saveRow(row.intercom_id)}
                              disabled={false}
                              className={`text-[11px] font-medium px-2.5 py-1 rounded-lg transition-colors ${
                                row.is_existing
                                  ? 'text-slate-500 hover:bg-slate-100 border border-slate-200'
                                  : 'text-white bg-blue-600 hover:bg-blue-700'
                              }`}
                            >
                              {row.is_existing ? 'Re-collect' : 'Collect'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4">
                <p className="text-xs text-slate-400">Page {page + 1} of {totalPages} — {total} total</p>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => fetchPage(page - 1, date)}
                    disabled={page === 0}
                    className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <IconChevronLeft />
                  </button>
                  {Array.from({ length: totalPages }, (_, i) => (
                    <button
                      key={i}
                      onClick={() => fetchPage(i, date)}
                      className={`w-8 h-8 rounded-lg text-xs font-medium transition-colors ${
                        i === page ? 'bg-slate-800 text-white' : 'border border-slate-200 text-slate-500 hover:bg-slate-50'
                      }`}
                    >
                      {i + 1}
                    </button>
                  ))}
                  <button
                    onClick={() => fetchPage(page + 1, date)}
                    disabled={page >= totalPages - 1}
                    className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <IconChevronRight />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
