'use client';

import { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line,
} from 'recharts';

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
  lastSyncedAt: string | null;
  error?: string;
}

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#f97316', '#84cc16'];

function formatRelative(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return `${Math.floor(ms / 86_400_000)} d ago`;
}

export default function AsanaDashboardPage() {
  const [data, setData] = useState<AsanaMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/api/dashboard/asana');
      const json = await res.json();
      setData(json as AsanaMetrics);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

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
        await load();
      }
    } catch (e) {
      setSyncMessage(`Error: ${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  }

  if (loading) {
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
        <h1 className="text-2xl font-semibold tracking-tight mb-1">Asana Tickets</h1>
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 mt-6">
          Asana isn&apos;t configured yet. Set <code>ASANA_ACCESS_TOKEN</code>{' '}
          and <code>ASANA_PROJECT_GID</code> in env to start pushing tickets.
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight mb-1">Asana Tickets</h1>
          <p className="text-sm text-slate-500">
            Severity-3 conversations are pushed to Asana as action items routed
            by agent (column) and tagged by account manager (custom field).
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

      {/* Top row: KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="Total tickets" value={data.totalTickets} />
        <KpiCard label="Open" value={data.openTickets} accent="text-amber-600" />
        <KpiCard label="Closed" value={data.closedTickets} accent="text-green-600" />
        <KpiCard
          label="Closure rate"
          value={data.totalTickets ? `${Math.round((data.closedTickets / data.totalTickets) * 100)}%` : '—'}
        />
      </div>

      {/* Tickets over time */}
      <Section title="Tickets created over time">
        {data.ticketsByDate.length === 0 ? (
          <EmptyMsg />
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={data.ticketsByDate}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="#94a3b8" />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="#94a3b8" />
              <Tooltip />
              <Line type="monotone" dataKey="count" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </Section>

      {/* Two-column: per AM bar chart, severity pie */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Tickets per Account Manager">
          {data.ticketsByAm.length === 0 ? (
            <EmptyMsg />
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(220, data.ticketsByAm.length * 32)}>
              <BarChart data={data.ticketsByAm} layout="vertical" margin={{ left: 24 }}>
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
                <PieChart>
                  <Pie
                    data={data.ticketsBySeverity}
                    dataKey="count"
                    nameKey="label"
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
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
                  <div key={s.label} className="flex items-center justify-between text-xs px-1">
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
            <BarChart data={data.ticketsByCategory} layout="vertical" margin={{ left: 24 }}>
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
    </div>
  );
}

function KpiCard({ label, value, accent }: { label: string; value: number | string; accent?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
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
  return <div className="text-sm text-slate-400 py-8 text-center">No tickets yet.</div>;
}
