'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, Legend,
} from 'recharts';

// ── Types ──────────────────────────────────────────────────────────────────

interface Overview {
  total: number;
  analyzed: number;
  unanalyzed: number;
  alertWorthy: number;
  analyzedPct: number;
}

interface LabelCount { label: string; count: number; }
interface ItemCount  { label: string; count: number; category: string; }
interface DateCount  { date: string; count: number; }

interface DashboardData {
  overview: Overview;
  resolutionBreakdown: LabelCount[];
  severityBreakdown: LabelCount[];
  topCategories: LabelCount[];
  topItems: ItemCount[];
  languageBreakdown: LabelCount[];
  brandBreakdown: LabelCount[];
  agentBreakdown: LabelCount[];
  conversationsByDate: DateCount[];
  filterOptions: { brands: string[]; agents: string[] };
}

// ── Colour palette ─────────────────────────────────────────────────────────

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#f97316', '#84cc16'];

const RESOLUTION_COLORS: Record<string, string> = {
  Resolved:            '#22c55e',
  'Partially Resolved': '#f59e0b',
  Unresolved:          '#ef4444',
};

const SEVERITY_COLORS: Record<string, string> = {
  Low:      '#22c55e',
  Medium:   '#f59e0b',
  High:     '#f97316',
  Critical: '#ef4444',
};

// ── Small helpers ──────────────────────────────────────────────────────────

function fmt(n: number) { return n.toLocaleString(); }

function shortDate(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ── Stat card ──────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color, onClick }: { label: string; value: string | number; sub?: string; color?: string; onClick?: () => void }) {
  return (
    <div
      className={`bg-white rounded-2xl border border-slate-200 p-5 transition-colors ${onClick ? 'cursor-pointer hover:border-blue-300 hover:bg-blue-50/30' : ''}`}
      onClick={onClick}
    >
      <p className="text-xs font-medium text-slate-400 uppercase tracking-widest">{label}</p>
      <p className={`text-3xl font-bold mt-1 ${color ?? 'text-slate-800'}`}>{typeof value === 'number' ? fmt(value) : value}</p>
      {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
    </div>
  );
}

// ── Section wrapper ────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <h3 className="text-sm font-semibold text-slate-700 mb-4">{title}</h3>
      {children}
    </div>
  );
}

// ── Custom tooltip ─────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number; name?: string; color?: string; fill?: string }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-lg px-3 py-2 text-xs">
      {label && <p className="font-medium text-slate-600 mb-1">{label}</p>}
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color ?? p.fill ?? '#3b82f6' }}>{p.name ? `${p.name}: ` : ''}{fmt(p.value)}</p>
      ))}
    </div>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────

function Empty({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center h-40 text-sm text-slate-400">{message}</div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData]       = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  // Filters
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo]     = useState('');
  const [brand, setBrand]       = useState('');
  const [agent, setAgent]       = useState('');

  // Track hovered bar/slice so click handlers can read it reliably
  const hoveredCategory  = useRef<string | null>(null);
  const hoveredSeverity  = useRef<string | null>(null);
  const hoveredLanguage  = useRef<string | null>(null);
  const hoveredResolution = useRef<string | null>(null);

  const navToConversations = useCallback((extra: Record<string, string>) => {
    const p = new URLSearchParams();
    if (dateFrom) p.set('dateFrom', dateFrom);
    if (dateTo)   p.set('dateTo',   dateTo);
    if (brand)    p.set('brand',    brand);
    if (agent)    p.set('agent_name', agent);
    Object.entries(extra).forEach(([k, v]) => { if (v) p.set(k, v); });
    router.push(`/?${p}`);
  }, [router, dateFrom, dateTo, brand, agent]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo)   params.set('dateTo',   dateTo);
      if (brand)    params.set('brand',    brand);
      if (agent)    params.set('agent',    agent);

      const res = await fetch(`/api/dashboard?${params}`);
      if (!res.ok) throw new Error('Failed to load dashboard');
      setData(await res.json());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, brand, agent]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const brandOptions  = data?.filterOptions.brands  ?? [];
  const agentOptions  = data?.filterOptions.agents  ?? [];

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6 p-6 overflow-y-auto">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-800">Analytics Dashboard</h1>
          <p className="text-sm text-slate-400 mt-0.5">QA insights from collected conversations</p>
        </div>
        <button
          onClick={fetchData}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-500 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
          </svg>
          Refresh
        </button>
      </div>

      {/* Filter bar */}
      <div className="bg-white rounded-2xl border border-slate-200 px-5 py-4 flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Date from</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Date to</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Brand</label>
          <select
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All brands</option>
            {brandOptions.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Agent</label>
          <select
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All agents</option>
            {agentOptions.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        {(dateFrom || dateTo || brand || agent) && (
          <button
            onClick={() => { setDateFrom(''); setDateTo(''); setBrand(''); setAgent(''); }}
            className="text-xs text-slate-400 hover:text-slate-600 underline pb-1.5"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Loading / error */}
      {loading && (
        <div className="flex items-center justify-center py-24 text-slate-400 text-sm gap-2">
          <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          Loading analytics…
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600">{error}</div>
      )}

      {!loading && !error && data && (
        <>
          {/* Stat cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Total Conversations"
              value={data.overview.total}
              onClick={() => navToConversations({})}
            />
            <StatCard
              label="Analyzed"
              value={data.overview.analyzed}
              sub={`${data.overview.analyzedPct}% of total`}
              color="text-blue-600"
              onClick={() => navToConversations({ analyzed: 'true' })}
            />
            <StatCard
              label="Unanalyzed"
              value={data.overview.unanalyzed}
              color="text-amber-500"
              onClick={() => navToConversations({ analyzed: 'false' })}
            />
            <StatCard
              label="Alert-worthy"
              value={data.overview.alertWorthy}
              sub="Needs immediate action"
              color="text-red-500"
              onClick={() => navToConversations({ alert_worthy: 'true' })}
            />
          </div>

          {/* Row 1: Time series + Resolution */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

            {/* Conversations over time — spans 2 cols */}
            <div className="lg:col-span-2">
              <Section title="Conversations Over Time">
                {data.conversationsByDate.length === 0 ? (
                  <Empty message="No date data available" />
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart
                      data={data.conversationsByDate}
                      margin={{ top: 4, right: 8, left: -20, bottom: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: '#94a3b8' }} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} />
                      <Tooltip content={<ChartTooltip />} />
                      <Line
                        type="monotone"
                        dataKey="count"
                        stroke="#3b82f6"
                        strokeWidth={2}
                        dot={false}
                        name="Conversations"
                        activeDot={{
                          r: 6,
                          cursor: 'pointer',
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          onClick: (_: any, payload: any) => {
                            const date = payload?.payload?.date;
                            if (date) navToConversations({ dateFrom: date, dateTo: date });
                          },
                        }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </Section>
            </div>

            {/* Resolution status donut */}
            <Section title="Resolution Status">
              {data.resolutionBreakdown.length === 0 ? (
                <Empty message="No analyzed data yet" />
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={160}>
                    <PieChart
                      style={{ cursor: 'pointer' }}
                      onClick={() => {
                        if (hoveredResolution.current) navToConversations({ resolution_status: hoveredResolution.current });
                      }}
                    >
                      <Pie
                        data={data.resolutionBreakdown}
                        dataKey="count"
                        nameKey="label"
                        cx="50%"
                        cy="50%"
                        innerRadius={45}
                        outerRadius={70}
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        onMouseEnter={(d: any) => { hoveredResolution.current = d?.label ?? null; }}
                        onMouseLeave={() => { hoveredResolution.current = null; }}
                      >
                        {data.resolutionBreakdown.map((entry, i) => (
                          <Cell key={i} fill={RESOLUTION_COLORS[entry.label] ?? COLORS[i % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip content={<ChartTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="space-y-1.5 mt-2">
                    {data.resolutionBreakdown.map((r, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between text-xs cursor-pointer hover:bg-slate-50 rounded px-1 -mx-1 transition-colors"
                        onClick={() => navToConversations({ resolution_status: r.label })}
                      >
                        <div className="flex items-center gap-1.5">
                          <div className="w-2.5 h-2.5 rounded-full" style={{ background: RESOLUTION_COLORS[r.label] ?? COLORS[i % COLORS.length] }} />
                          <span className="text-slate-600">{r.label}</span>
                        </div>
                        <span className="font-semibold text-slate-700">{fmt(r.count)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Section>
          </div>

          {/* Row 2: Top categories + Severity */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

            {/* Top issue categories — spans 2 cols */}
            <div className="lg:col-span-2">
              <Section title="Top Issue Categories">
                {data.topCategories.length === 0 ? (
                  <Empty message="No analyzed data yet" />
                ) : (
                  <ResponsiveContainer width="100%" height={Math.max(220, data.topCategories.length * 36)}>
                    <BarChart
                      data={data.topCategories}
                      layout="vertical"
                      margin={{ top: 0, right: 16, left: 8, bottom: 0 }}
                      style={{ cursor: 'pointer' }}
                      onClick={() => {
                        if (hoveredCategory.current) navToConversations({ issue_category: hoveredCategory.current });
                      }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 11, fill: '#94a3b8' }} />
                      <YAxis type="category" dataKey="label" width={180} tick={{ fontSize: 11, fill: '#475569' }} />
                      <Tooltip content={<ChartTooltip />} />
                      <Bar
                        dataKey="count"
                        fill="#3b82f6"
                        radius={[0, 4, 4, 0]}
                        name="Conversations"
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        onMouseEnter={(d: any) => { hoveredCategory.current = d?.label ?? null; }}
                        onMouseLeave={() => { hoveredCategory.current = null; }}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </Section>
            </div>

            {/* Dissatisfaction severity */}
            <Section title="Dissatisfaction Severity">
              {data.severityBreakdown.length === 0 ? (
                <Empty message="No analyzed data yet" />
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={160}>
                    <BarChart
                      data={data.severityBreakdown}
                      margin={{ top: 4, right: 8, left: -20, bottom: 0 }}
                      style={{ cursor: 'pointer' }}
                      onClick={() => {
                        if (hoveredSeverity.current) navToConversations({ dissatisfaction_severity: hoveredSeverity.current });
                      }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} />
                      <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} />
                      <Tooltip content={<ChartTooltip />} />
                      <Bar
                        dataKey="count"
                        radius={[4, 4, 0, 0]}
                        name="Count"
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        onMouseEnter={(d: any) => { hoveredSeverity.current = d?.label ?? null; }}
                        onMouseLeave={() => { hoveredSeverity.current = null; }}
                      >
                        {data.severityBreakdown.map((entry, i) => (
                          <Cell key={i} fill={SEVERITY_COLORS[entry.label] ?? COLORS[i % COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                  <div className="space-y-1.5 mt-2">
                    {data.severityBreakdown.map((s, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between text-xs cursor-pointer hover:bg-slate-50 rounded px-1 -mx-1 transition-colors"
                        onClick={() => navToConversations({ dissatisfaction_severity: s.label })}
                      >
                        <div className="flex items-center gap-1.5">
                          <div className="w-2.5 h-2.5 rounded-full" style={{ background: SEVERITY_COLORS[s.label] ?? COLORS[i % COLORS.length] }} />
                          <span className="text-slate-600">{s.label}</span>
                        </div>
                        <span className="font-semibold text-slate-700">{fmt(s.count)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Section>
          </div>

          {/* Row 3: Language + Top items */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

            {/* Language distribution */}
            <Section title="Language Distribution">
              {data.languageBreakdown.length === 0 ? (
                <Empty message="No analyzed data yet" />
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart
                    data={data.languageBreakdown}
                    margin={{ top: 4, right: 8, left: -20, bottom: 0 }}
                    style={{ cursor: 'pointer' }}
                    onClick={() => {
                      if (hoveredLanguage.current) navToConversations({ language: hoveredLanguage.current });
                    }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} />
                    <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} />
                    <Tooltip content={<ChartTooltip />} />
                    <Bar
                      dataKey="count"
                      radius={[4, 4, 0, 0]}
                      name="Conversations"
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      onMouseEnter={(d: any) => { hoveredLanguage.current = d?.label ?? null; }}
                      onMouseLeave={() => { hoveredLanguage.current = null; }}
                    >
                      {data.languageBreakdown.map((_, i) => (
                        <Cell key={i} fill={COLORS[i % COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Section>

            {/* Top issue items — spans 2 cols */}
            <div className="lg:col-span-2">
              <Section title="Top Issue Items">
                {data.topItems.length === 0 ? (
                  <Empty message="No analyzed data yet" />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-100">
                          <th className="text-left py-2 pr-4 text-xs font-semibold text-slate-400 uppercase tracking-wide">Issue</th>
                          <th className="text-left py-2 pr-4 text-xs font-semibold text-slate-400 uppercase tracking-wide">Category</th>
                          <th className="text-right py-2 text-xs font-semibold text-slate-400 uppercase tracking-wide">Count</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {data.topItems.map((item, i) => (
                          <tr
                            key={i}
                            className="hover:bg-slate-50 transition-colors cursor-pointer"
                            onClick={() => navToConversations({ issue_category: item.category })}
                          >
                            <td className="py-2.5 pr-4 text-slate-700 text-xs">{item.label}</td>
                            <td className="py-2.5 pr-4 text-slate-400 text-xs">{item.category}</td>
                            <td className="py-2.5 text-right">
                              <span className="text-xs font-semibold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">{fmt(item.count)}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>
            </div>
          </div>

          {/* Row 4: Brand + Agent breakdown tables */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

            {/* Brand breakdown */}
            <Section title="Brand Breakdown">
              {data.brandBreakdown.length === 0 ? (
                <Empty message="No brand data available" />
              ) : (
                <div className="space-y-2">
                  {data.brandBreakdown.map((b, i) => {
                    const pct = data.overview.analyzed > 0 ? Math.round((b.count / data.overview.analyzed) * 100) : 0;
                    return (
                      <div
                        key={i}
                        className="cursor-pointer group"
                        onClick={() => navToConversations({ brand: b.label })}
                      >
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className="text-slate-600 font-medium truncate max-w-[60%] group-hover:text-blue-600 transition-colors">{b.label}</span>
                          <span className="text-slate-400">{fmt(b.count)} <span className="text-slate-300">({pct}%)</span></span>
                        </div>
                        <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                          <div className="h-full bg-blue-500 rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Section>

            {/* Agent breakdown */}
            <Section title="Agent Breakdown">
              {data.agentBreakdown.length === 0 ? (
                <Empty message="No agent data available" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th className="text-left py-2 pr-4 text-xs font-semibold text-slate-400 uppercase tracking-wide">Agent</th>
                        <th className="text-right py-2 text-xs font-semibold text-slate-400 uppercase tracking-wide">Conversations</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {data.agentBreakdown.map((a, i) => (
                        <tr
                          key={i}
                          className="hover:bg-slate-50 transition-colors cursor-pointer"
                          onClick={() => navToConversations({ agent_name: a.label })}
                        >
                          <td className="py-2.5 pr-4 text-slate-700 text-xs font-medium">{a.label}</td>
                          <td className="py-2.5 text-right">
                            <span className="text-xs font-semibold text-slate-600">{fmt(a.count)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
          </div>
        </>
      )}
    </div>
  );
}
