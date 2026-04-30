'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, Legend,
} from 'recharts';
import ConversationsOverlay from '@/components/dashboard/ConversationsOverlay';
import { AM_NAMES } from '@/lib/utils';

interface LabelCount { label: string; count: number; }
interface DateCount  { date: string; count: number; }

interface AsanaMetrics {
  configured: boolean;
  projectGid: string | null;
  totalTickets: number;
  openTickets: number;
  closedTickets: number;
  ticketsByAm: LabelCount[];
  ticketsBySeverity: LabelCount[];
  ticketsByCategory: LabelCount[];
  ticketsByDate: DateCount[];
  closuresByDate: DateCount[];
  lastSyncedAt: string | null;
  error?: string;
}

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#f97316', '#84cc16'];

interface Filters {
  dateFrom: string;  // YYYY-MM-DD or '' for unbounded
  dateTo:   string;  // YYYY-MM-DD or '' for unbounded
  am: string;        // 'all' or AM name
  severity: string;  // 'all' or 'Level 1' | 'Level 2' | 'Level 3' | 'Unknown'
}

const DEFAULT_FILTERS: Filters = { dateFrom: '', dateTo: '', am: 'all', severity: 'all' };
const SEVERITY_OPTIONS = ['Level 1', 'Level 2', 'Level 3', 'Unknown'];

function buildQuery(f: Filters): string {
  const params = new URLSearchParams();
  if (f.dateFrom) params.set('from', f.dateFrom);
  if (f.dateTo)   params.set('to',   f.dateTo);
  if (f.am !== 'all')       params.set('am', f.am);
  if (f.severity !== 'all') params.set('severity', f.severity);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return `${Math.floor(ms / 86_400_000)} d ago`;
}

// Ctrl/Cmd-click or middle-click → open in a new tab instead of overlay.
// Mirrors the helper used on the Dashboard so behaviour is consistent.
function isNewTabClick(e?: { ctrlKey?: boolean; metaKey?: boolean; button?: number }): boolean {
  if (!e) return false;
  return Boolean(e.ctrlKey) || Boolean(e.metaKey) || e.button === 1;
}

export default function ReportPage() {
  const [data, setData] = useState<AsanaMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);

  // Drill-down overlay state — same pattern as the Dashboard so Ctrl/middle-
  // click can open the same view in a new tab via URL params.
  const [overlayFilters, setOverlayFilters] = useState<Record<string, string> | null>(null);
  const [overlayTitle, setOverlayTitle]     = useState('');

  async function load(f: Filters) {
    setLoading(true);
    try {
      const res = await fetch(`/api/dashboard/asana${buildQuery(f)}`);
      const json = await res.json();
      setData(json as AsanaMetrics);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(filters); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filters]);

  // Build the conversation-list filter set for a click. Always includes
  // asana_ticketed=true so the drill-down matches the report row set, plus
  // the current Report Page filters (date range, AM, severity), then merges
  // dimension-specific extras (which win on conflict).
  const navToConversations = useCallback((extra: Record<string, string>, e?: React.MouseEvent | MouseEvent) => {
    const out: Record<string, string> = { asana_ticketed: 'true' };
    if (filters.dateFrom) out.dateFrom = filters.dateFrom;
    if (filters.dateTo)   out.dateTo   = filters.dateTo;
    if (filters.am !== 'all')       out.account_manager          = filters.am;
    if (filters.severity !== 'all') out.dissatisfaction_severity = filters.severity;
    Object.entries(extra).forEach(([k, v]) => { if (v) out[k] = v; });

    // Build a human-readable title from the dimension-specific extras
    const dimEntries = Object.entries(extra).filter(([, v]) => v);
    let title = 'Escalations';
    if (out.asana_status === 'closed') title = 'Closures by AMs';
    else if (out.asana_status === 'open') title = 'Open escalations';
    if (dimEntries.length > 0) {
      const [key, val] = dimEntries[0];
      if (key === 'account_manager') title = `Escalations: ${val}`;
      else if (key === 'dissatisfaction_severity') title = `Severity ${val}`;
      else if (key === 'issue_category') title = `Category: ${val}`;
      else if (key === 'dateFrom' && out.dateFrom === out.dateTo) {
        const base = out.asana_status === 'closed' ? 'Closures' : 'Escalations';
        title = `${base} on ${out.dateFrom}`;
      }
    }

    if (isNewTabClick(e)) {
      const params = new URLSearchParams();
      params.set('ov_filters', JSON.stringify(out));
      params.set('ov_title', title);
      window.open(`${window.location.pathname}?${params.toString()}`, '_blank', 'noopener,noreferrer');
      return;
    }

    setOverlayTitle(title);
    setOverlayFilters(out);
  }, [filters]);

  // Restore the overlay from URL params when a tab was opened via Ctrl/middle-click.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    const f = sp.get('ov_filters');
    const t = sp.get('ov_title');
    if (f && t) {
      try {
        setOverlayFilters(JSON.parse(f));
        setOverlayTitle(t);
      } catch { /* ignore malformed params */ }
    }
  }, []);

  async function handleSync() {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const res = await fetch('/api/dashboard/asana/sync');
      const json = await res.json();
      if (!res.ok) {
        setSyncMessage(`Error: ${json.error ?? 'unknown'}`);
      } else {
        setSyncMessage(`Synced ${json.synced}/${json.total} tickets`);
        await load(filters);
      }
    } catch (e) {
      setSyncMessage(`Error: ${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  }

  // Merge the two date series for the multi-line trajectory chart. We union
  // the dates so a day with closures-but-no-new-escalations (or vice versa)
  // still gets a point.
  const trajectory = useMemo(() => {
    if (!data) return [];
    const byDate = new Map<string, { date: string; escalations: number; closures: number }>();
    for (const d of data.ticketsByDate) {
      byDate.set(d.date, { date: d.date, escalations: d.count, closures: 0 });
    }
    for (const d of data.closuresByDate) {
      const existing = byDate.get(d.date);
      if (existing) existing.closures = d.count;
      else byDate.set(d.date, { date: d.date, escalations: 0, closures: d.count });
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [data]);

  const filtersActive = filters.dateFrom !== '' || filters.dateTo !== '' || filters.am !== 'all' || filters.severity !== 'all';

  if (!data && loading) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <div className="text-slate-400 text-sm">Loading…</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <div className="text-slate-400 text-sm">No data.</div>
      </div>
    );
  }
  if (!data.configured) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <h1 className="text-2xl font-semibold tracking-tight mb-1">Report Page</h1>
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 mt-6">
          Asana isn&apos;t configured yet. Set <code>ASANA_ACCESS_TOKEN</code>{' '}
          and <code>ASANA_PROJECT_GID</code> in env to start pushing tickets.
        </div>
      </div>
    );
  }

  const closureRate = data.totalTickets
    ? `${Math.round((data.closedTickets / data.totalTickets) * 100)}%`
    : '—';

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight mb-1">Report Page</h1>
          <p className="text-sm text-slate-500">
            Summary of Severity-3 escalations pushed to Asana. Click any metric
            to drill in; Ctrl/⌘+click or middle-click to open in a new tab.
          </p>
        </div>
        <div className="text-right shrink-0">
          <button
            onClick={handleSync}
            disabled={syncing}
            className="text-sm px-3 py-1.5 rounded-md border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-50"
          >
            {syncing ? 'Syncing…' : 'Refresh status from Asana'}
          </button>
          <div className="text-xs text-slate-400 mt-1">
            {syncMessage ?? `Last synced ${formatRelative(data.lastSyncedAt)}`}
          </div>
        </div>
      </div>

      {/* Filter bar */}
      <div className="rounded-lg border border-slate-200 bg-white p-4 flex flex-wrap items-end gap-x-6 gap-y-3">
        <FilterGroup label="Date from">
          <input
            type="date"
            value={filters.dateFrom}
            onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))}
            className="text-sm border border-slate-200 rounded-md px-2 py-1 bg-white"
          />
        </FilterGroup>

        <FilterGroup label="Date to">
          <input
            type="date"
            value={filters.dateTo}
            onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))}
            className="text-sm border border-slate-200 rounded-md px-2 py-1 bg-white"
          />
        </FilterGroup>

        <FilterGroup label="Account Manager">
          <select
            value={filters.am}
            onChange={(e) => setFilters((f) => ({ ...f, am: e.target.value }))}
            className="text-sm border border-slate-200 rounded-md px-2 py-1 bg-white"
          >
            <option value="all">All</option>
            {AM_NAMES.map((n) => <option key={n} value={n}>{n}</option>)}
            <option value="Unassigned">Unassigned</option>
          </select>
        </FilterGroup>

        <FilterGroup label="Severity">
          <select
            value={filters.severity}
            onChange={(e) => setFilters((f) => ({ ...f, severity: e.target.value }))}
            className="text-sm border border-slate-200 rounded-md px-2 py-1 bg-white"
          >
            <option value="all">All</option>
            {SEVERITY_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </FilterGroup>

        {filtersActive && (
          <button
            onClick={() => setFilters(DEFAULT_FILTERS)}
            className="ml-auto text-xs text-slate-500 hover:text-slate-700 underline"
          >
            Clear filters
          </button>
        )}
        {loading && <span className="text-xs text-slate-400">Updating…</span>}
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard
          label="Total escalations"
          value={data.totalTickets}
          onClick={(e) => navToConversations({}, e)}
        />
        <KpiCard
          label="Handled by AMs"
          value={data.closedTickets}
          accent="text-green-600"
          onClick={(e) => navToConversations({ asana_status: 'closed' }, e)}
        />
        <KpiCard
          label="Open"
          value={data.openTickets}
          accent="text-amber-600"
          onClick={(e) => navToConversations({ asana_status: 'open' }, e)}
        />
        <KpiCard
          label="Closure rate"
          value={closureRate}
          onClick={(e) => navToConversations({}, e)}
        />
      </div>

      {/* Trajectory: escalations + closures per day */}
      <Section title="Trajectory over time">
        {trajectory.length === 0 ? (
          <EmptyMsg />
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <LineChart
              data={trajectory}
              style={{ cursor: 'pointer' }}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onClick={(d: any, e: any) => { if (d?.activeLabel) navToConversations({ dateFrom: d.activeLabel, dateTo: d.activeLabel }, e); }}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onMouseDown={(d: any, e: any) => { if (e?.button === 1 && d?.activeLabel) { e.preventDefault?.(); navToConversations({ dateFrom: d.activeLabel, dateTo: d.activeLabel }, e); } }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="#94a3b8" />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="#94a3b8" />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line
                type="monotone"
                dataKey="escalations"
                name="Escalations created"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 6, cursor: 'pointer' }}
              />
              <Line
                type="monotone"
                dataKey="closures"
                name="Closures by AMs"
                stroke="#22c55e"
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 6, cursor: 'pointer' }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </Section>

      {/* Two-column: per AM bar chart, severity pie */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Escalations per Account Manager">
          {data.ticketsByAm.length === 0 ? (
            <EmptyMsg />
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(220, data.ticketsByAm.length * 32)}>
              <BarChart
                data={data.ticketsByAm}
                layout="vertical"
                margin={{ left: 24 }}
                style={{ cursor: 'pointer' }}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onClick={(d: any, e: any) => { if (d?.activeLabel) navToConversations({ account_manager: d.activeLabel }, e); }}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onMouseDown={(d: any, e: any) => { if (e?.button === 1 && d?.activeLabel) { e.preventDefault?.(); navToConversations({ account_manager: d.activeLabel }, e); } }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} stroke="#94a3b8" />
                <YAxis type="category" dataKey="label" width={100} tick={{ fontSize: 11 }} stroke="#94a3b8" />
                <Tooltip />
                <Bar dataKey="count" fill="#3b82f6" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Section>

        <Section title="Severity breakdown">
          {data.ticketsBySeverity.length === 0 ? (
            <EmptyMsg />
          ) : (
            <>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart style={{ cursor: 'pointer' }}>
                  <Pie
                    data={data.ticketsBySeverity}
                    dataKey="count"
                    nameKey="label"
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    onClick={(d: any, _i: number, e: any) => { if (d?.label) navToConversations({ dissatisfaction_severity: d.label }, e); }}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    onMouseDown={(d: any, _i: number, e: any) => { if (e?.button === 1 && d?.label) { e.preventDefault?.(); navToConversations({ dissatisfaction_severity: d.label }, e); } }}
                  >
                    {data.ticketsBySeverity.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
              <div className="space-y-1 mt-2">
                {data.ticketsBySeverity.map((s, i) => (
                  <div
                    key={s.label}
                    className="flex items-center justify-between text-xs px-1 py-0.5 rounded cursor-pointer hover:bg-slate-50 transition-colors"
                    onClick={(e) => navToConversations({ dissatisfaction_severity: s.label }, e)}
                    onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); navToConversations({ dissatisfaction_severity: s.label }, e); } }}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
                      <span className="text-slate-700">{s.label}</span>
                    </div>
                    <span className="text-slate-500 font-medium">{s.count}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Section>
      </div>

      {/* Top categories */}
      <Section title="Top issue categories">
        {data.ticketsByCategory.length === 0 ? (
          <EmptyMsg />
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(220, data.ticketsByCategory.length * 32)}>
            <BarChart
              data={data.ticketsByCategory}
              layout="vertical"
              margin={{ left: 24 }}
              style={{ cursor: 'pointer' }}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onClick={(d: any, e: any) => { if (d?.activeLabel) navToConversations({ issue_category: d.activeLabel }, e); }}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onMouseDown={(d: any, e: any) => { if (e?.button === 1 && d?.activeLabel) { e.preventDefault?.(); navToConversations({ issue_category: d.activeLabel }, e); } }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} stroke="#94a3b8" />
              <YAxis type="category" dataKey="label" width={220} tick={{ fontSize: 11 }} stroke="#94a3b8" />
              <Tooltip />
              <Bar dataKey="count" fill="#a855f7" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </Section>

      {data.projectGid && (
        <a
          href={`https://app.asana.com/0/${data.projectGid}/board`}
          target="_blank"
          rel="noreferrer"
          className="inline-block text-sm text-blue-600 hover:underline"
        >
          Open project board in Asana →
        </a>
      )}

      {overlayFilters && (
        <ConversationsOverlay
          filters={overlayFilters}
          title={overlayTitle}
          onClose={() => {
            setOverlayFilters(null);
            if (typeof window !== 'undefined') {
              const sp = new URLSearchParams(window.location.search);
              if (sp.has('ov_filters') || sp.has('ov_title')) {
                sp.delete('ov_filters');
                sp.delete('ov_title');
                const qs = sp.toString();
                window.history.replaceState({}, '', qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
              }
            }
          }}
        />
      )}
    </div>
  );
}

function KpiCard({ label, value, accent, onClick }: {
  label: string;
  value: number | string;
  accent?: string;
  onClick?: (e: React.MouseEvent) => void;
}) {
  const interactive = Boolean(onClick);
  return (
    <div
      className={[
        'rounded-lg border border-slate-200 bg-white p-4 transition-colors',
        interactive ? 'cursor-pointer hover:border-blue-300 hover:bg-blue-50/30' : '',
      ].join(' ')}
      onClick={onClick}
      onMouseDown={onClick ? (e) => { if (e.button === 1) { e.preventDefault(); onClick(e); } } : undefined}
    >
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={['text-3xl font-semibold mt-1', accent ?? ''].join(' ')}>{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="text-sm font-medium text-slate-700 mb-3">{title}</div>
      {children}
    </div>
  );
}

function EmptyMsg() {
  return <div className="text-sm text-slate-400 py-8 text-center">No tickets in this slice.</div>;
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs uppercase tracking-wide text-slate-500">{label}</span>
      <div className="flex items-center gap-1.5">{children}</div>
    </div>
  );
}

