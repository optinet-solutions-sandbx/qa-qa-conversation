'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ConversationsOverlay from '@/components/dashboard/ConversationsOverlay';
import { AM_NAMES, VIP_LEVELS } from '@/lib/utils';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line,
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
  filterOptions: { brands: string[]; agents: string[]; languages: string[]; categories: string[]; issues: { category: string; items: string[] }[] };
}

// ── Cache helpers ──────────────────────────────────────────────────────────

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes — beyond this, refetch in background

// Hard floor for the dashboard — kept in sync with ANALYSIS_MIN_DATE_ISO in
// lib/analyticsFilters.ts. Pre-cutoff dates are silently bumped up to here so
// stale values can't render an empty dashboard.
const DASHBOARD_MIN_DATE = '2026-04-27';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function flooredDate(d: string): string {
  return d < DASHBOARD_MIN_DATE ? DASHBOARD_MIN_DATE : d;
}

// localStorage (not sessionStorage) so the cache survives full page reloads and
// new tabs — the dashboard then opens instantly with the last-known payload
// while a fresh fetch runs in the background.
function getCached(key: string): { data: DashboardData; isStale: boolean } | null {
  try {
    const raw = localStorage.getItem(`dashboard:${key}`);
    if (!raw) return null;
    const { data, fetchedAt } = JSON.parse(raw) as { data: DashboardData; fetchedAt: number };
    return { data, isStale: Date.now() - fetchedAt > CACHE_TTL };
  } catch {
    return null;
  }
}

function setCached(key: string, data: DashboardData) {
  try {
    localStorage.setItem(`dashboard:${key}`, JSON.stringify({ data, fetchedAt: Date.now() }));
  } catch {
    // ignore quota errors
  }
}

// ── Colour palette ─────────────────────────────────────────────────────────

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#f97316', '#84cc16'];

const RESOLUTION_COLORS: Record<string, string> = {
  Resolved:            '#22c55e',
  'Partially Resolved': '#f59e0b',
  Unresolved:          '#ef4444',
};

const SEVERITY_COLORS: Record<string, string> = {
  'Level 1': '#22c55e',
  'Level 2': '#f59e0b',
  'Level 3': '#ef4444',
  Unknown:   '#94a3b8',
  Low:       '#22c55e',
  Medium:    '#f59e0b',
  High:      '#f97316',
  Critical:  '#ef4444',
};

const OVERLAY_LABELS: Record<string, string> = {
  resolution_status:        'Resolution',
  dissatisfaction_severity: 'Severity',
  issue_category:           'Category',
  issue_item:               'Issue',
  language:                 'Language',
  brand:                    'Brand',
  agent_name:               'Agent',
  account_manager:          'Account Manager',
  vip_level:                'VIP Level',
  dateFrom:                 'Date',
  analyzed:                 'Analyzed',
  alert_worthy:             'Alert-worthy',
};

// ── Small helpers ──────────────────────────────────────────────────────────

function fmt(n: number) { return n.toLocaleString(); }

function shortDate(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// Ctrl/Cmd-click or middle-click → open in new tab instead of overlay
function isNewTabClick(e?: { ctrlKey?: boolean; metaKey?: boolean; button?: number }): boolean {
  if (!e) return false;
  return Boolean(e.ctrlKey) || Boolean(e.metaKey) || e.button === 1;
}

// ── Stat card ──────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color, onClick }: { label: string; value: string | number; sub?: string; color?: string; onClick?: (e: React.MouseEvent) => void }) {
  return (
    <div
      className={`bg-white rounded-2xl border border-slate-200 p-5 transition-colors ${onClick ? 'cursor-pointer hover:border-blue-300 hover:bg-blue-50/30' : ''}`}
      onClick={onClick}
      onMouseDown={onClick ? (e) => { if (e.button === 1) { e.preventDefault(); onClick(e); } } : undefined}
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

// ── Generic multi-select ───────────────────────────────────────────────────

type IssueGroup = { category: string; items: string[] };

function MultiSelectFilter({ options, groups, selected, onChange, placeholder, emptyText, disabled }: {
  options?: string[];
  groups?: IssueGroup[];
  selected: string[];
  onChange: (val: string[]) => void;
  placeholder: string;
  emptyText: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const toggle = (val: string) =>
    onChange(selected.includes(val) ? selected.filter((v) => v !== val) : [...selected, val]);

  const remove = (val: string) => onChange(selected.filter((v) => v !== val));

  const isEmpty = groups ? groups.length === 0 : (options ?? []).length === 0;

  return (
    <div className="flex flex-col gap-2">
      <div ref={ref} className="relative">
        <button
          type="button"
          disabled={disabled}
          onClick={() => !disabled && setOpen((o) => !o)}
          className={`border rounded-lg px-3 py-1.5 text-sm flex items-center gap-2 min-w-[180px] justify-between transition-colors
            ${disabled
              ? 'border-slate-100 bg-slate-50 text-slate-300 cursor-not-allowed'
              : 'border-slate-200 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500'}`}
        >
          <span className="truncate">{selected.length === 0 ? placeholder : `${selected.length} selected`}</span>
          <svg className={`w-3.5 h-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {open && (
          <div className="absolute z-20 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg py-1 min-w-[280px] max-h-72 overflow-y-auto">
            {isEmpty && <p className="px-3 py-2 text-xs text-slate-400">{emptyText}</p>}

            {/* Flat list (e.g. categories) */}
            {!groups && (options ?? []).map((val) => (
              <label key={val} className="flex items-center gap-2.5 px-3 py-2 hover:bg-slate-50 cursor-pointer text-sm text-slate-700">
                <input type="checkbox" checked={selected.includes(val)} onChange={() => toggle(val)}
                  className="w-3.5 h-3.5 rounded border-slate-300 accent-blue-600" />
                {val}
              </label>
            ))}

            {/* Grouped list (e.g. issues) */}
            {groups && groups.map(({ category, items }) => (
              <div key={category}>
                <p className="px-3 pt-2.5 pb-1 text-xs font-semibold text-slate-400 uppercase tracking-wide select-none">
                  {category}
                </p>
                {items.map((val) => (
                  <label key={val} className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-slate-50 cursor-pointer text-sm text-slate-700">
                    <input type="checkbox" checked={selected.includes(val)} onChange={() => toggle(val)}
                      className="w-3.5 h-3.5 rounded border-slate-300 accent-blue-600" />
                    {val}
                  </label>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((val) => (
            <span key={val} className="inline-flex items-center gap-1 bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-2.5 py-0.5 text-xs font-medium">
              {val}
              <button type="button" onClick={() => remove(val)}
                className="ml-0.5 hover:text-blue-900 focus:outline-none" aria-label={`Remove ${val}`}>
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [data, setData]       = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  // Overlay state
  const [overlayFilters, setOverlayFilters] = useState<Record<string, string | string[]> | null>(null);
  const [overlayTitle, setOverlayTitle]     = useState('');

  // Filters — date range always defaults to today on open. We deliberately don't
  // persist date selections to localStorage: with near-real-time data, the user
  // expects a fresh "today" view every time they open the dashboard.
  const [dateFrom, setDateFrom] = useState(() => flooredDate(todayISO()));
  const [dateTo, setDateTo]     = useState(() => flooredDate(todayISO()));
  const [brands, setBrands]                     = useState<string[]>([]);
  const [agents, setAgents]                     = useState<string[]>([]);
  const [accountManagers, setAccountManagers]   = useState<string[]>([]);
  const [vipLevels, setVipLevels]               = useState<string[]>([]);
  const [languages, setLanguages]               = useState<string[]>([]);
  const [categories, setCategories]             = useState<string[]>([]);
  const [issues, setIssues]                     = useState<string[]>([]);
  const [severities, setSeverities]             = useState<string[]>([]);

  const navToConversations = useCallback((extra: Record<string, string>, e?: React.MouseEvent | MouseEvent) => {
    const filters: Record<string, string | string[]> = {};
    if (dateFrom)        filters.dateFrom        = dateFrom;
    if (dateTo)          filters.dateTo          = dateTo;
    // Forward each multi-select as an array (or a plain string when exactly
    // one value is selected). The overlay sends arrays through as repeated
    // query params; /api/conversations reads them via getAll().
    const passMulti = (key: string, vals: string[]) => { if (vals.length > 0) filters[key] = vals.length === 1 ? vals[0] : vals; };
    passMulti('brand',           brands);
    passMulti('agent_name',      agents);
    passMulti('account_manager', accountManagers);
    passMulti('vip_level',       vipLevels);
    passMulti('language',        languages);
    passMulti('issue_category',  categories);
    passMulti('issue_item',      issues);
    passMulti('dissatisfaction_severity', severities.map((s) => `Level ${s}`));
    Object.entries(extra).forEach(([k, v]) => { if (v) filters[k] = v; });

    // Build a human-readable title from the extra filters
    const extraEntries = Object.entries(extra).filter(([, v]) => v);
    let title = 'Conversations';
    if (extraEntries.length > 0) {
      const [key, val] = extraEntries[0];
      const label = OVERLAY_LABELS[key] ?? key;
      if (val === 'true' && key === 'alert_worthy') title = 'Alert-worthy Conversations';
      else if (val === 'true' && key === 'analyzed') title = 'Analyzed Conversations';
      else if (val === 'false' && key === 'analyzed') title = 'Unanalyzed Conversations';
      else title = `${label}: ${val}`;
    }

    if (isNewTabClick(e)) {
      const params = new URLSearchParams();
      params.set('ov_filters', JSON.stringify(filters));
      params.set('ov_title', title);
      window.open(`${window.location.pathname}?${params.toString()}`, '_blank', 'noopener,noreferrer');
      return;
    }

    setOverlayTitle(title);
    setOverlayFilters(filters);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, brands, agents, accountManagers, vipLevels, languages, categories, issues, severities]);

  // Restore overlay state from URL (used when a new tab is opened via Ctrl/middle-click)
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

  const forceRef = useRef(false);

  const fetchData = useCallback(async () => {
    const params = new URLSearchParams();
    if (dateFrom)       params.set('dateFrom',       dateFrom);
    if (dateTo)         params.set('dateTo',         dateTo);
    brands.forEach((b)          => params.append('brand',          b));
    agents.forEach((a)          => params.append('agent',          a));
    accountManagers.forEach((m) => params.append('accountManager', m));
    vipLevels.forEach((v)       => params.append('vipLevel',       v));
    languages.forEach((l)       => params.append('language',       l));
    categories.forEach((c)      => params.append('category',       c));
    issues.forEach((i)          => params.append('issue',          i));
    severities.forEach((s)      => params.append('severity',       s));

    const cacheKey = params.toString();
    const force = forceRef.current;
    forceRef.current = false;

    // Stale-while-revalidate: render cached payload instantly so the dashboard
    // opens without a heavy loading state. If the cache is fresh (< CACHE_TTL),
    // we skip the network entirely; if stale, we silently refetch in the
    // background and swap in the new data when it arrives.
    const cached = force ? null : getCached(cacheKey);
    if (cached) {
      setData(cached.data);
      setError(null);
      setLoading(false);
      if (!cached.isStale) return;
    } else {
      setLoading(true);
      setError(null);
    }

    try {
      const res = await fetch(`/api/dashboard?${params}`);
      if (!res.ok) throw new Error('Failed to load dashboard');
      const json = await res.json();
      setCached(cacheKey, json);
      setData(json);
      setError(null);
    } catch (e) {
      // If we already have stale cached data on screen, keep it visible rather
      // than blanking the dashboard with an error.
      if (!cached) setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, brands, agents, accountManagers, vipLevels, languages, categories, issues, severities]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const brandOptions    = data?.filterOptions.brands     ?? [];
  const agentOptions    = data?.filterOptions.agents     ?? [];
  const languageOptions = data?.filterOptions.languages  ?? [];
  const categoryOptions = data?.filterOptions.categories ?? [];
  const issueGroups     = data?.filterOptions.issues     ?? [];

  // When a category is selected, filter issue groups to only that category and
  // auto-clear any selected issues that no longer belong.
  const filteredIssueGroups = categories.length > 0
    ? issueGroups.filter((g) => categories.includes(g.category))
    : issueGroups;

  const handleCategoryChange = useCallback((newCats: string[]) => {
    setCategories(newCats);
    if (newCats.length > 0) {
      const available = new Set(
        issueGroups.filter((g) => newCats.includes(g.category)).flatMap((g) => g.items)
      );
      setIssues((prev) => prev.filter((i) => available.has(i)));
    }
  }, [issueGroups]);

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
          onClick={() => { forceRef.current = true; fetchData(); }}
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
          <MultiSelectFilter
            options={brandOptions}
            selected={brands}
            onChange={setBrands}
            placeholder="All brands"
            emptyText="No brands yet"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Agent</label>
          <MultiSelectFilter
            options={agentOptions}
            selected={agents}
            onChange={setAgents}
            placeholder="All agents"
            emptyText="No agents yet"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Account Manager</label>
          <MultiSelectFilter
            options={[...AM_NAMES]}
            selected={accountManagers}
            onChange={setAccountManagers}
            placeholder="All AMs"
            emptyText="No AMs"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">VIP Level</label>
          <MultiSelectFilter
            options={[...VIP_LEVELS]}
            selected={vipLevels}
            onChange={setVipLevels}
            placeholder="All VIP levels"
            emptyText="No VIP levels"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Language</label>
          <MultiSelectFilter
            options={languageOptions}
            selected={languages}
            onChange={setLanguages}
            placeholder="All languages"
            emptyText="No languages yet"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Severity</label>
          <MultiSelectFilter
            options={['1', '2', '3']}
            selected={severities}
            onChange={setSeverities}
            placeholder="All severities"
            emptyText="No severities"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Category</label>
          <MultiSelectFilter
            options={categoryOptions}
            selected={categories}
            onChange={handleCategoryChange}
            placeholder="All categories"
            emptyText="No categories yet"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Issue</label>
          <MultiSelectFilter
            {...(categories.length === 0
              ? { groups: issueGroups }                                    // no category: grouped, with headers
              : categories.length === 1
                ? { options: filteredIssueGroups.flatMap((g) => g.items) } // 1 category: flat, no headers
                : { groups: filteredIssueGroups })}                        // 2+ categories: grouped, headers visible
            selected={issues}
            onChange={setIssues}
            placeholder={categories.length === 0 ? 'Select a category first' : 'All issues'}
            emptyText="No issues yet"
            disabled={categories.length === 0}
          />
        </div>
        {(dateFrom || dateTo || brands.length > 0 || agents.length > 0 || accountManagers.length > 0 || vipLevels.length > 0 || languages.length > 0 || severities.length > 0 || categories.length > 0 || issues.length > 0) && (
          <button
            onClick={() => { setDateFrom(''); setDateTo(''); setBrands([]); setAgents([]); setAccountManagers([]); setVipLevels([]); setLanguages([]); setSeverities([]); setCategories([]); setIssues([]); }}
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
              onClick={(e) => navToConversations({}, e)}
            />
            <StatCard
              label="Analyzed"
              value={data.overview.analyzed}
              sub={`${data.overview.analyzedPct}% of total`}
              color="text-blue-600"
              onClick={(e) => navToConversations({ analyzed: 'true' }, e)}
            />
            <StatCard
              label="Unanalyzed"
              value={data.overview.unanalyzed}
              color="text-amber-500"
              onClick={(e) => navToConversations({ analyzed: 'false' }, e)}
            />
            <StatCard
              label="Alert-worthy"
              value={data.overview.alertWorthy}
              sub="Needs immediate action"
              color="text-red-500"
              onClick={(e) => navToConversations({ alert_worthy: 'true' }, e)}
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
                      margin={{ top: 4, right: 8, left: -20, bottom: 40 }}
                      style={{ cursor: 'pointer' }}
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      onClick={(d: any, e: any) => { if (d?.activeLabel) navToConversations({ dateFrom: d.activeLabel, dateTo: d.activeLabel }, e); }}
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      onMouseDown={(d: any, e: any) => { if (e?.button === 1 && d?.activeLabel) { e.preventDefault?.(); navToConversations({ dateFrom: d.activeLabel, dateTo: d.activeLabel }, e); } }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 10, fill: '#94a3b8' }} interval={0} angle={-45} textAnchor="end" />
                      <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} />
                      <Tooltip content={<ChartTooltip />} />
                      <Line
                        type="monotone"
                        dataKey="count"
                        stroke="#3b82f6"
                        strokeWidth={2}
                        dot={false}
                        name="Conversations"
                        activeDot={{ r: 6, cursor: 'pointer' }}
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
                    <PieChart style={{ cursor: 'pointer' }}>
                      <Pie
                        data={data.resolutionBreakdown}
                        dataKey="count"
                        nameKey="label"
                        cx="50%"
                        cy="50%"
                        innerRadius={45}
                        outerRadius={70}
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        onClick={(d: any, _i: number, e: any) => { if (d?.label) navToConversations({ resolution_status: d.label }, e); }}
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        onMouseDown={(d: any, _i: number, e: any) => { if (e?.button === 1 && d?.label) { e.preventDefault?.(); navToConversations({ resolution_status: d.label }, e); } }}
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
                        onClick={(e) => navToConversations({ resolution_status: r.label }, e)}
                        onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); navToConversations({ resolution_status: r.label }, e); } }}
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
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      onClick={(data: any, e: any) => { if (data?.activeLabel) navToConversations({ issue_category: data.activeLabel }, e); }}
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      onMouseDown={(data: any, e: any) => { if (e?.button === 1 && data?.activeLabel) { e.preventDefault?.(); navToConversations({ issue_category: data.activeLabel }, e); } }}
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
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      onClick={(data: any, e: any) => { if (data?.activeLabel) navToConversations({ dissatisfaction_severity: data.activeLabel }, e); }}
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      onMouseDown={(data: any, e: any) => { if (e?.button === 1 && data?.activeLabel) { e.preventDefault?.(); navToConversations({ dissatisfaction_severity: data.activeLabel }, e); } }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} />
                      <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} />
                      <Tooltip content={<ChartTooltip />} />
                      <Bar
                        dataKey="count"
                        radius={[4, 4, 0, 0]}
                        name="Count"
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
                        onClick={(e) => navToConversations({ dissatisfaction_severity: s.label }, e)}
                        onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); navToConversations({ dissatisfaction_severity: s.label }, e); } }}
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
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    onClick={(data: any, e: any) => { if (data?.activeLabel) navToConversations({ language: data.activeLabel }, e); }}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    onMouseDown={(data: any, e: any) => { if (e?.button === 1 && data?.activeLabel) { e.preventDefault?.(); navToConversations({ language: data.activeLabel }, e); } }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} />
                    <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} />
                    <Tooltip content={<ChartTooltip />} />
                    <Bar
                      dataKey="count"
                      radius={[4, 4, 0, 0]}
                      name="Conversations"
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
                            onClick={(e) => navToConversations({ issue_category: item.category }, e)}
                            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); navToConversations({ issue_category: item.category }, e); } }}
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
                        onClick={(e) => navToConversations({ brand: b.label }, e)}
                        onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); navToConversations({ brand: b.label }, e); } }}
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
                <div className="overflow-auto max-h-[520px]">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-white">
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
                          onClick={(e) => navToConversations({ agent_name: a.label }, e)}
                          onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); navToConversations({ agent_name: a.label }, e); } }}
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
