'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ConversationsOverlay from '@/components/dashboard/ConversationsOverlay';
import IssueHeatmap from '@/components/dashboard/IssueHeatmap';
import { AM_NAMES, SEGMENTS, VIP_LEVELS } from '@/lib/utils';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, Legend, AreaChart, Area, Sector,
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

interface EscalationStats {
  totalEscalations: number;
  resolved: number;
  pendingUnder24h: number;
  pendingOver24h: number;
  closureRate: number;
}

interface IssueSpike { issue: string; today: number; yesterday: number; }

interface DissatisfactionTrend {
  issues: string[];
  data: Array<{ date: string } & Record<string, number | string>>;
}

interface WeeklyIssueHeatmap {
  days: { date: string; label: string }[];
  issues: { issue: string; counts: number[] }[];
}

interface DailyHourlyIssueHeatmap {
  dates: string[];
  cells: { date: string; hour: number; count: number }[];
}

interface DashboardData {
  overview: Overview;
  escalationStats: EscalationStats;
  issueSpikes: IssueSpike[];
  dissatisfactionTrend: DissatisfactionTrend;
  weeklyIssueHeatmap: WeeklyIssueHeatmap;
  dailyHourlyIssueHeatmap: DailyHourlyIssueHeatmap;
  resolutionBreakdown: LabelCount[];
  severityBreakdown: LabelCount[];
  topCategories: LabelCount[];
  topItems: ItemCount[];
  languageBreakdown: LabelCount[];
  brandBreakdown: LabelCount[];
  agentBreakdown: LabelCount[];
  conversationsByDate: DateCount[];
  filterOptions: { brands: string[]; agents: string[]; languages: string[]; countries: string[]; categories: string[]; issues: { category: string; items: string[] }[] };
}

// Half-payloads returned by the split /api/dashboard endpoint. ScopedData covers
// every widget that depends on the date filter; GlobalData covers the
// last-30-days widgets, the operational pending-escalation counters, and the
// brand/agent/country dropdown options — all of which are invariant under date
// changes, so they live behind a separate cache key that survives date nudges.
interface ScopedDashboardData {
  overview: Overview;
  escalationStats: { totalEscalations: number; resolved: number; closureRate: number };
  resolutionBreakdown: LabelCount[];
  severityBreakdown: LabelCount[];
  topCategories: LabelCount[];
  topItems: ItemCount[];
  languageBreakdown: LabelCount[];
  brandBreakdown: LabelCount[];
  agentBreakdown: LabelCount[];
  conversationsByDate: DateCount[];
  filterOptions: { languages: string[]; categories: string[]; issues: { category: string; items: string[] }[] };
}

interface GlobalDashboardData {
  pendingEscalations: { pendingUnder24h: number; pendingOver24h: number };
  issueSpikes: IssueSpike[];
  dissatisfactionTrend: DissatisfactionTrend;
  weeklyIssueHeatmap: WeeklyIssueHeatmap;
  dailyHourlyIssueHeatmap: DailyHourlyIssueHeatmap;
  filterOptions: { brands: string[]; agents: string[]; countries: string[] };
}

function mergeDashboard(s: ScopedDashboardData, g: GlobalDashboardData): DashboardData {
  return {
    overview: s.overview,
    escalationStats: {
      totalEscalations: s.escalationStats.totalEscalations,
      resolved:         s.escalationStats.resolved,
      closureRate:      s.escalationStats.closureRate,
      pendingUnder24h:  g.pendingEscalations.pendingUnder24h,
      pendingOver24h:   g.pendingEscalations.pendingOver24h,
    },
    issueSpikes:             g.issueSpikes,
    dissatisfactionTrend:    g.dissatisfactionTrend,
    weeklyIssueHeatmap:      g.weeklyIssueHeatmap,
    dailyHourlyIssueHeatmap: g.dailyHourlyIssueHeatmap,
    resolutionBreakdown:     s.resolutionBreakdown,
    severityBreakdown:       s.severityBreakdown,
    topCategories:           s.topCategories,
    topItems:                s.topItems,
    languageBreakdown:       s.languageBreakdown,
    brandBreakdown:          s.brandBreakdown,
    agentBreakdown:          s.agentBreakdown,
    conversationsByDate:     s.conversationsByDate,
    filterOptions: {
      brands:     g.filterOptions.brands,
      agents:     g.filterOptions.agents,
      countries:  g.filterOptions.countries,
      languages:  s.filterOptions.languages,
      categories: s.filterOptions.categories,
      issues:     s.filterOptions.issues,
    },
  };
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
// while a fresh fetch runs in the background. Two namespaces — "scoped" and
// "global" — let the date-independent half stay cached across date-only filter
// changes so re-renders feel instant.
function getCachedScoped(key: string): { data: ScopedDashboardData; isStale: boolean } | null {
  try {
    const raw = localStorage.getItem(`dashboard:scoped:${key}`);
    if (!raw) return null;
    const { data, fetchedAt } = JSON.parse(raw) as { data: ScopedDashboardData; fetchedAt: number };
    // Skip empty cached payloads — these almost always come from the first
    // visit early in the day before ingest has caught up, and serving them
    // makes the dashboard look broken (all zeros) until the bg refetch lands.
    if (!data?.overview?.total) return null;
    return { data, isStale: Date.now() - fetchedAt > CACHE_TTL };
  } catch {
    return null;
  }
}

function setCachedScoped(key: string, data: ScopedDashboardData) {
  try {
    localStorage.setItem(`dashboard:scoped:${key}`, JSON.stringify({ data, fetchedAt: Date.now() }));
  } catch { /* ignore quota errors */ }
}

function getCachedGlobal(key: string): { data: GlobalDashboardData; isStale: boolean } | null {
  try {
    const raw = localStorage.getItem(`dashboard:global:${key}`);
    if (!raw) return null;
    const { data, fetchedAt } = JSON.parse(raw) as { data: GlobalDashboardData; fetchedAt: number };
    return { data, isStale: Date.now() - fetchedAt > CACHE_TTL };
  } catch {
    return null;
  }
}

function setCachedGlobal(key: string, data: GlobalDashboardData) {
  try {
    localStorage.setItem(`dashboard:global:${key}`, JSON.stringify({ data, fetchedAt: Date.now() }));
  } catch { /* ignore quota errors */ }
}

// ── Colour palette ─────────────────────────────────────────────────────────
// Saturated/neon palette designed for the dark theme mockup. Hex values are
// chosen so each colour also reads well against a white surface (light mode).

const COLORS = ['#22d3ee', '#a78bfa', '#f472b6', '#fb923c', '#facc15', '#34d399', '#60a5fa', '#f87171'];

const RESOLUTION_COLORS: Record<string, string> = {
  Resolved:            '#22d3ee', // cyan
  'Partially Resolved': '#fb923c', // orange
  Unresolved:          '#f472b6', // pink
  Unknown:             '#facc15', // yellow
};

const SEVERITY_COLORS: Record<string, string> = {
  'Level 0': '#34d399', // emerald — no/negligible dissatisfaction
  'Level 1': '#22d3ee', // cyan
  'Level 2': '#fb923c', // orange
  'Level 3': '#f472b6', // pink
  Unknown:   '#94a3b8',
  Low:       '#22d3ee',
  Medium:    '#fb923c',
  High:      '#f97316',
  Critical:  '#f472b6',
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
  segment:                  'Segment',
  vip_level:                'VIP Level',
  player_country:           'Country',
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

// Mirrors the server logic in app/api/dashboard/route.ts: the spike chart
// compares the two most recent COMPLETED UTC days. `day` is the more recent
// completed day (= "Yesterday" in user-facing copy), `prev` is the one before.
function lastTwoCompletedUtcDayLabels() {
  const startOfTodayUtc = new Date();
  startOfTodayUtc.setUTCHours(0, 0, 0, 0);
  const day  = new Date(startOfTodayUtc); day.setUTCDate(day.getUTCDate()  - 1);
  const prev = new Date(startOfTodayUtc); prev.setUTCDate(prev.getUTCDate() - 2);
  const f = (d: Date) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return { day: f(day), prev: f(prev) };
}

// Ctrl/Cmd-click or middle-click → open in new tab instead of overlay
function isNewTabClick(e?: { ctrlKey?: boolean; metaKey?: boolean; button?: number }): boolean {
  if (!e) return false;
  return Boolean(e.ctrlKey) || Boolean(e.metaKey) || e.button === 1;
}

// Word-wrap a long label into N lines so it can render under a narrow bar
// without rotation. Greedy fit by character count — good enough for our
// issue/category labels which are short phrases.
function wrapLabel(text: string, maxCharsPerLine = 18): string[] {
  if (!text || text.length <= maxCharsPerLine) return [text];
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const tentative = current.length === 0 ? word : `${current} ${word}`;
    if (tentative.length <= maxCharsPerLine) {
      current = tentative;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Custom recharts X-axis tick: renders each line as a <tspan> centered under
// the bar. Used by the Spikes chart so 4-word labels stop overflowing the
// chart's left edge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function WrappedXAxisTick({ x, y, payload }: any) {
  const lines = wrapLabel(String(payload.value ?? ''), 18);
  return (
    <g transform={`translate(${x},${y + 4})`}>
      <text textAnchor="middle" fill="var(--chart-axis-label)" fontSize={10}>
        {lines.map((line, i) => (
          <tspan key={i} x={0} dy={i === 0 ? 12 : 12}>{line}</tspan>
        ))}
      </text>
    </g>
  );
}

// ── Stat card ──────────────────────────────────────────────────────────────

type StatAccent = 'cyan' | 'teal' | 'amber' | 'rose' | 'violet';

// Per-accent colour tokens. Hex literals are intentional — Tailwind purges
// dynamic class names, so we pass colours through inline style/SVG props
// instead of constructing classes like `border-${accent}-500`.
const ACCENT_TOKENS: Record<StatAccent, { border: string; iconBg: string; iconStroke: string; valueText: string }> = {
  cyan:   { border: 'border-cyan-400/40   ring-cyan-400/10',   iconBg: 'bg-cyan-400/15',   iconStroke: '#22d3ee', valueText: 'text-cyan-300' },
  teal:   { border: 'border-emerald-400/40 ring-emerald-400/10', iconBg: 'bg-emerald-400/15', iconStroke: '#34d399', valueText: 'text-emerald-300' },
  amber:  { border: 'border-amber-400/40  ring-amber-400/10',  iconBg: 'bg-amber-400/15',  iconStroke: '#fbbf24', valueText: 'text-amber-300' },
  rose:   { border: 'border-rose-400/40   ring-rose-400/10',   iconBg: 'bg-rose-400/15',   iconStroke: '#fb7185', valueText: 'text-rose-300' },
  violet: { border: 'border-violet-400/40 ring-violet-400/10', iconBg: 'bg-violet-400/15', iconStroke: '#a78bfa', valueText: 'text-violet-300' },
};

function StatIcon({ kind, color }: { kind: 'doc' | 'check' | 'clock' | 'alarm'; color: string }) {
  const common = { fill: 'none', stroke: color, strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, viewBox: '0 0 24 24', className: 'w-5 h-5' };
  switch (kind) {
    case 'doc':   return <svg {...common}><path d="M14 3v4a1 1 0 0 0 1 1h4M5 21h14a2 2 0 0 0 2-2V7l-4-4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2Z" /><path d="M8 12h8M8 16h6" /></svg>;
    case 'check': return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M8.5 12.5l2.5 2.5 4.5-5" /></svg>;
    case 'clock': return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></svg>;
    case 'alarm': return <svg {...common}><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 1.5M5 4l3 2.5M19 4l-3 2.5" /></svg>;
  }
}

// Mini progress donut for the Closure Rate card. Pure SVG so it inherits the
// stat-card colour scheme and doesn't pull recharts in just for this.
function MiniDonut({ pct, color }: { pct: number; color: string }) {
  const r = 22, c = 2 * Math.PI * r;
  const safe = Math.max(0, Math.min(100, pct));
  return (
    <svg viewBox="0 0 56 56" className="w-12 h-12">
      <circle cx="28" cy="28" r={r} fill="none" stroke="currentColor" strokeWidth="6" className="text-slate-200 dark:text-slate-700" />
      <circle
        cx="28" cy="28" r={r} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c - (c * safe / 100)}
        transform="rotate(-90 28 28)"
      />
    </svg>
  );
}

interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  accent: StatAccent;
  icon?: 'doc' | 'check' | 'clock' | 'alarm';
  /** When provided, replaces the icon block with a progress donut. */
  donutPct?: number;
  onClick?: (e: React.MouseEvent) => void;
}

function StatCard({ label, value, sub, accent, icon, donutPct, onClick }: StatCardProps) {
  const tok = ACCENT_TOKENS[accent];
  return (
    <div
      className={`bg-white rounded-2xl border ${tok.border} ring-1 ${tok.border.split(' ')[1]} p-4 transition-colors ${onClick ? 'cursor-pointer hover:bg-slate-50/40' : ''}`}
      onClick={onClick}
      onMouseDown={onClick ? (e) => { if (e.button === 1) { e.preventDefault(); onClick(e); } } : undefined}
    >
      <div className="flex items-center gap-3">
        {donutPct != null ? (
          <MiniDonut pct={donutPct} color={tok.iconStroke} />
        ) : icon ? (
          <div className={`w-10 h-10 rounded-lg ${tok.iconBg} flex items-center justify-center shrink-0`}>
            <StatIcon kind={icon} color={tok.iconStroke} />
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium text-slate-500 truncate">{label}</p>
          <p className={`text-2xl font-bold mt-0.5 ${tok.valueText}`}>{typeof value === 'number' ? fmt(value) : value}</p>
          {sub && <p className="text-[10px] text-slate-400 mt-0.5">{sub}</p>}
        </div>
      </div>
    </div>
  );
}

// ── Section wrapper ────────────────────────────────────────────────────────

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
        {subtitle && <p className="text-[11px] text-slate-400 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

// ── Custom tooltip ─────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number; name?: string; color?: string; fill?: string }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-lg px-3 py-2 text-xs backdrop-blur-sm">
      {label && <p className="font-medium text-slate-600 mb-1">{label}</p>}
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color ?? p.fill ?? '#22d3ee' }}>{p.name ? `${p.name}: ` : ''}{fmt(p.value)}</p>
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
  const [error, setError] = useState<string | null>(null);

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
  const [segments, setSegments]                 = useState<string[]>([]);
  const [vipLevels, setVipLevels]               = useState<string[]>([]);
  const [languages, setLanguages]               = useState<string[]>([]);
  const [countries, setCountries]               = useState<string[]>([]);
  const [categories, setCategories]             = useState<string[]>([]);
  const [issues, setIssues]                     = useState<string[]>([]);
  const [severities, setSeverities]             = useState<string[]>([]);
  const [resolutions, setResolutions]           = useState<string[]>([]);

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
    passMulti('segment',         segments);
    passMulti('vip_level',       vipLevels);
    passMulti('language',        languages);
    passMulti('player_country',  countries);
    passMulti('issue_category',  categories);
    passMulti('issue_item',      issues);
    passMulti('dissatisfaction_severity', severities.map((s) => `Level ${s}`));
    passMulti('resolution_status', resolutions);
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
      else if (val === 'true' && key === 'asana_ticketed') title = 'Escalations';
      else if (val === 'open' && key === 'asana_status')   title = 'Open Escalations';
      else if (val === 'closed' && key === 'asana_status') title = 'Resolved Escalations';
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
  }, [dateFrom, dateTo, brands, agents, accountManagers, segments, vipLevels, languages, countries, categories, issues, severities, resolutions]);

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

  const [scopedData, setScopedData] = useState<ScopedDashboardData | null>(null);
  const [globalData, setGlobalData] = useState<GlobalDashboardData | null>(null);
  const [scopedRefreshing, setScopedRefreshing] = useState(false);
  const [globalRefreshing, setGlobalRefreshing] = useState(false);

  const data: DashboardData | null = scopedData && globalData ? mergeDashboard(scopedData, globalData) : null;
  const refreshing = scopedRefreshing || globalRefreshing;

  // Cache key of whatever scoped data is currently rendered. Used to decide
  // whether a stale cache hit on a *different* filter combo should overwrite
  // the screen — it shouldn't, because the numbers can be wildly out of date
  // and flash misleading values before the fresh fetch lands.
  const displayedScopedKeyRef = useRef<string | null>(null);
  const displayedGlobalKeyRef = useRef<string | null>(null);

  // ── Scoped fetch (date-dependent) ────────────────────────────────────────
  // Refires on every filter change — including date — and only this side
  // refetches when the user nudges the date filter. Cache key includes every
  // filter so each unique combination has its own SWR entry.
  const fetchScoped = useCallback(async (signal?: AbortSignal, force = false) => {
    const params = new URLSearchParams();
    params.set('part', 'scoped');
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo)   params.set('dateTo',   dateTo);
    brands.forEach((b)          => params.append('brand',          b));
    agents.forEach((a)          => params.append('agent',          a));
    accountManagers.forEach((m) => params.append('accountManager', m));
    segments.forEach((s)        => params.append('segment',        s));
    vipLevels.forEach((v)       => params.append('vipLevel',       v));
    languages.forEach((l)       => params.append('language',       l));
    countries.forEach((c)       => params.append('country',        c));
    categories.forEach((c)      => params.append('category',       c));
    issues.forEach((i)          => params.append('issue',          i));
    severities.forEach((s)      => params.append('severity',       s));
    resolutions.forEach((r)     => params.append('resolution',     r));

    const cacheKey = params.toString();
    const cached = force ? null : getCachedScoped(cacheKey);
    // Only paint stale cache when it matches the view we're already showing
    // (true SWR refresh) or on initial mount. For filter changes, a stale
    // cross-key hit would flash old numbers before the fresh fetch lands, so
    // we keep the current data on screen.
    const canPaintStale = displayedScopedKeyRef.current === null
      || displayedScopedKeyRef.current === cacheKey;
    if (cached && (!cached.isStale || canPaintStale)) {
      setScopedData(cached.data);
      setError(null);
      displayedScopedKeyRef.current = cacheKey;
      if (!cached.isStale) return;
      setScopedRefreshing(true);
    } else if (displayedScopedKeyRef.current !== null) {
      setScopedRefreshing(true);
      setError(null);
    } else {
      setError(null);
    }

    try {
      const res = await fetch(`/api/dashboard?${params}`, { signal });
      if (!res.ok) throw new Error('Failed to load dashboard');
      const json = await res.json() as ScopedDashboardData;
      if (signal?.aborted) return;
      setCachedScoped(cacheKey, json);
      setScopedData(json);
      setError(null);
      displayedScopedKeyRef.current = cacheKey;
    } catch (e) {
      if (signal?.aborted || (e as Error).name === 'AbortError') return;
      if (!cached) setError((e as Error).message);
    } finally {
      if (!signal?.aborted) setScopedRefreshing(false);
    }
  }, [dateFrom, dateTo, brands, agents, accountManagers, segments, vipLevels, languages, countries, categories, issues, severities, resolutions]);

  // ── Global fetch (date-independent) ──────────────────────────────────────
  // Cache key intentionally excludes dateFrom/dateTo and resolution — none of
  // the global widgets depend on those, so date-only nudges hit the cache and
  // skip the network entirely.
  const fetchGlobal = useCallback(async (signal?: AbortSignal, force = false) => {
    const params = new URLSearchParams();
    params.set('part', 'global');
    brands.forEach((b)          => params.append('brand',          b));
    agents.forEach((a)          => params.append('agent',          a));
    accountManagers.forEach((m) => params.append('accountManager', m));
    segments.forEach((s)        => params.append('segment',        s));
    vipLevels.forEach((v)       => params.append('vipLevel',       v));
    languages.forEach((l)       => params.append('language',       l));
    countries.forEach((c)       => params.append('country',        c));
    categories.forEach((c)      => params.append('category',       c));
    issues.forEach((i)          => params.append('issue',          i));
    severities.forEach((s)      => params.append('severity',       s));

    const cacheKey = params.toString();
    const cached = force ? null : getCachedGlobal(cacheKey);
    const canPaintStale = displayedGlobalKeyRef.current === null
      || displayedGlobalKeyRef.current === cacheKey;
    if (cached && (!cached.isStale || canPaintStale)) {
      setGlobalData(cached.data);
      displayedGlobalKeyRef.current = cacheKey;
      if (!cached.isStale) return;
      setGlobalRefreshing(true);
    } else if (displayedGlobalKeyRef.current !== null) {
      setGlobalRefreshing(true);
    }

    try {
      const res = await fetch(`/api/dashboard?${params}`, { signal });
      if (!res.ok) throw new Error('Failed to load dashboard');
      const json = await res.json() as GlobalDashboardData;
      if (signal?.aborted) return;
      setCachedGlobal(cacheKey, json);
      setGlobalData(json);
      displayedGlobalKeyRef.current = cacheKey;
    } catch (e) {
      if (signal?.aborted || (e as Error).name === 'AbortError') return;
      if (!cached) setError((e as Error).message);
    } finally {
      if (!signal?.aborted) setGlobalRefreshing(false);
    }
  }, [brands, agents, accountManagers, segments, vipLevels, languages, countries, categories, issues, severities]);

  // Two effects with distinct dependency lists — that's the whole point of the
  // split. Changing only the date filter recreates fetchScoped (causing a
  // refetch) but leaves fetchGlobal untouched, so the global half stays put.
  useEffect(() => {
    const controller = new AbortController();
    fetchScoped(controller.signal);
    return () => controller.abort();
  }, [fetchScoped]);

  useEffect(() => {
    const controller = new AbortController();
    fetchGlobal(controller.signal);
    return () => controller.abort();
  }, [fetchGlobal]);

  // Manual refresh: bypass both caches and refetch immediately. The Refresh
  // button is the only entry point — automatic re-runs from filter changes go
  // through the SWR cache as usual.
  const refreshAll = useCallback(() => {
    fetchScoped(undefined, true);
    fetchGlobal(undefined, true);
  }, [fetchScoped, fetchGlobal]);

  // Loading is the initial cold-start skeleton — true only when neither half
  // has produced data yet. Once data is on screen, filter changes show the
  // top-right "Refreshing…" indicator instead of blanking the dashboard.
  const loading = !scopedData || !globalData;

  const brandOptions    = data?.filterOptions.brands     ?? [];
  const agentOptions    = data?.filterOptions.agents     ?? [];
  const languageOptions = data?.filterOptions.languages  ?? [];
  const countryOptions  = data?.filterOptions.countries  ?? [];
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
        <div className="flex items-center gap-3">
          {refreshing && (
            <div className="flex items-center gap-1.5 text-xs text-slate-400">
              <div className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              Refreshing…
            </div>
          )}
          <button
            onClick={refreshAll}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-500 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
            </svg>
            Refresh
          </button>
        </div>
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
          <label className="block text-xs font-medium text-slate-500 mb-1">Segment</label>
          <MultiSelectFilter
            options={[...SEGMENTS]}
            selected={segments}
            onChange={setSegments}
            placeholder="All segments"
            emptyText="No segments"
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
          <label className="block text-xs font-medium text-slate-500 mb-1">Country</label>
          <MultiSelectFilter
            options={countryOptions}
            selected={countries}
            onChange={setCountries}
            placeholder="All countries"
            emptyText="No countries yet"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Severity</label>
          <MultiSelectFilter
            options={['0', '1', '2', '3']}
            selected={severities}
            onChange={setSeverities}
            placeholder="All severities"
            emptyText="No severities"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Resolution</label>
          <MultiSelectFilter
            options={['Resolved', 'Partially Resolved', 'Unresolved']}
            selected={resolutions}
            onChange={setResolutions}
            placeholder="All resolutions"
            emptyText="No resolutions"
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
        {(dateFrom || dateTo || brands.length > 0 || agents.length > 0 || accountManagers.length > 0 || segments.length > 0 || vipLevels.length > 0 || languages.length > 0 || countries.length > 0 || severities.length > 0 || resolutions.length > 0 || categories.length > 0 || issues.length > 0) && (
          <button
            onClick={() => { setDateFrom(''); setDateTo(''); setBrands([]); setAgents([]); setAccountManagers([]); setSegments([]); setVipLevels([]); setLanguages([]); setCountries([]); setSeverities([]); setResolutions([]); setCategories([]); setIssues([]); }}
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
          {/* Stat cards — Conversation volume */}
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <StatCard
              label="Total Conversations"
              value={data.overview.total}
              accent="cyan"
              icon="doc"
              onClick={(e) => navToConversations({}, e)}
            />
            <StatCard
              label="Analyzed"
              value={data.overview.analyzed}
              sub={`${data.overview.analyzedPct}% of total`}
              accent="teal"
              icon="check"
              onClick={(e) => navToConversations({ analyzed: 'true' }, e)}
            />
            <StatCard
              label="Unanalyzed"
              value={data.overview.unanalyzed}
              accent="amber"
              icon="clock"
              onClick={(e) => navToConversations({ analyzed: 'false' }, e)}
            />
          </div>

          {/* Stat cards — Asana escalation metrics */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            <StatCard
              label="Total Escalations"
              value={data.escalationStats.totalEscalations}
              accent="cyan"
              icon="doc"
              onClick={(e) => navToConversations({ asana_ticketed: 'true' }, e)}
            />
            <StatCard
              label="Resolved"
              value={data.escalationStats.resolved}
              accent="teal"
              icon="check"
              onClick={(e) => navToConversations({ asana_status: 'closed' }, e)}
            />
            <StatCard
              label="Pending Action <24h"
              value={data.escalationStats.pendingUnder24h}
              accent="amber"
              icon="clock"
              onClick={(e) => navToConversations({ asana_status: 'open' }, e)}
            />
            <StatCard
              label="Pending Action >24h"
              value={data.escalationStats.pendingOver24h}
              accent="rose"
              icon="alarm"
              onClick={(e) => navToConversations({ asana_status: 'open' }, e)}
            />
            <StatCard
              label="Closure Rate"
              value={`${data.escalationStats.closureRate}%`}
              accent="violet"
              donutPct={data.escalationStats.closureRate}
              onClick={(e) => navToConversations({ asana_ticketed: 'true' }, e)}
            />
          </div>

          {/* Row: Top 5 Issues + Top 5 Issue Spikes ──────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Top 5 Issues — uses topItems sliced to 5; respects global filters
                so "today" by default and shifts when the user changes the date. */}
            <Section title="Top 5 Issues" subtitle="Re-ordered by count">
              {data.topItems.length === 0 ? (
                <Empty message="No analyzed data yet" />
              ) : (
                <ResponsiveContainer width="100%" height={Math.max(220, Math.min(5, data.topItems.length) * 40)}>
                  <BarChart
                    data={data.topItems.slice(0, 5)}
                    layout="vertical"
                    margin={{ top: 0, right: 48, left: 8, bottom: 0 }}
                    style={{ cursor: 'pointer' }}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    onClick={(d: any, e: any) => { if (d?.activeLabel) navToConversations({ issue_item: d.activeLabel }, e); }}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    onMouseDown={(d: any, e: any) => { if (e?.button === 1 && d?.activeLabel) { e.preventDefault?.(); navToConversations({ issue_item: d.activeLabel }, e); } }}
                  >
                    <defs>
                      {/* One horizontal neon gradient per bar — dark→bright left-to-right
                          so each row reads as its own glowing accent against the dark surface. */}
                      <linearGradient id="top5Bar0" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor="#0e7490" /><stop offset="100%" stopColor="#22d3ee" />
                      </linearGradient>
                      <linearGradient id="top5Bar1" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor="#1e40af" /><stop offset="100%" stopColor="#60a5fa" />
                      </linearGradient>
                      <linearGradient id="top5Bar2" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor="#c2410c" /><stop offset="100%" stopColor="#fb923c" />
                      </linearGradient>
                      <linearGradient id="top5Bar3" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor="#be123c" /><stop offset="100%" stopColor="#f472b6" />
                      </linearGradient>
                      <linearGradient id="top5Bar4" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor="#86198f" /><stop offset="100%" stopColor="#e879f9" />
                      </linearGradient>
                      {/* Soft glow halo applied to the hovered bar via activeBar. */}
                      <filter id="barGlowTop5" x="-50%" y="-50%" width="200%" height="200%">
                        <feGaussianBlur stdDeviation="4" result="blur" />
                        <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                      </filter>
                    </defs>
                    <XAxis type="number" tick={{ fontSize: 11, fill: '#94a3b8' }} />
                    <YAxis type="category" dataKey="label" width={160} tick={{ fontSize: 11, fill: 'var(--chart-axis-label)' }} />
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: 'transparent' }} />
                    <Bar dataKey="count" radius={[0, 6, 6, 0]} name="Conversations" label={{ position: 'right', fill: '#94a3b8', fontSize: 11 }} activeBar={{ filter: 'url(#barGlowTop5)' }}>
                      {data.topItems.slice(0, 5).map((_, i) => (
                        <Cell key={i} fill={`url(#top5Bar${i})`} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Section>

            {/* Top 5 Issue Spikes — fixed last-2-completed-days comparison.
                Per spec: never affected by global filters. */}
            <Section title="Top 5 Issue Spikes - Yesterday vs Day Before">
              {data.issueSpikes.length === 0 ? (
                <Empty message="Not enough data for the last 2 completed days" />
              ) : (() => {
                const spikeDates = lastTwoCompletedUtcDayLabels();
                return (
                <ResponsiveContainer width="100%" height={290}>
                  <BarChart data={data.issueSpikes} margin={{ top: 8, right: 12, left: -10, bottom: 24 }}>
                    <defs>
                      {/* Vertical neon gradients — Today is the bright/saturated bar,
                          Yesterday is a dimmer, more transparent version of the same
                          hue so the comparison reads as "now vs. fading reference". */}
                      <linearGradient id="spikeToday" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%"   stopColor="#22d3ee" stopOpacity={1}   />
                        <stop offset="100%" stopColor="#0e7490" stopOpacity={0.85} />
                      </linearGradient>
                      <linearGradient id="spikeYesterday" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%"   stopColor="#67e8f9" stopOpacity={0.65} />
                        <stop offset="100%" stopColor="#155e75" stopOpacity={0.35} />
                      </linearGradient>
                      <filter id="barGlowSpike" x="-50%" y="-50%" width="200%" height="200%">
                        <feGaussianBlur stdDeviation="4" result="blur" />
                        <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                      </filter>
                    </defs>
                    <XAxis
                      dataKey="issue"
                      interval={0}
                      tick={<WrappedXAxisTick />}
                      height={70}
                    />
                    <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} allowDecimals={false} />
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: 'transparent' }} />
                    <Legend
                      wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                      verticalAlign="bottom"
                      content={() => (
                        <div style={{ display: 'flex', justifyContent: 'center', gap: 16, fontSize: 11, paddingTop: 8 }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ width: 8, height: 8, borderRadius: 999, background: '#22d3ee', display: 'inline-block' }} />
                            {`Yesterday (${spikeDates.day})`}
                          </span>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#94a3b8' }}>
                            <span style={{ width: 8, height: 8, borderRadius: 999, background: '#67e8f9', opacity: 0.65, display: 'inline-block' }} />
                            {`Day Before (${spikeDates.prev})`}
                          </span>
                        </div>
                      )}
                    />
                    <Bar dataKey="today"     name={`Yesterday (${spikeDates.day})`}    fill="url(#spikeToday)"     radius={[6, 6, 0, 0]} activeBar={{ filter: 'url(#barGlowSpike)' }} />
                    <Bar dataKey="yesterday" name={`Day Before (${spikeDates.prev})`} fill="url(#spikeYesterday)" radius={[6, 6, 0, 0]} activeBar={{ filter: 'url(#barGlowSpike)' }} />
                  </BarChart>
                </ResponsiveContainer>
                );
              })()}
            </Section>
          </div>

          {/* Row: Dissatisfaction Trend + Weekly Issue Heat Map ─────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Dissatisfaction Trend — top 3 issues over last 30 days, dissatisfied
                conversations only. */}
            <Section title="Dissatisfaction Trend">
              {data.dissatisfactionTrend.issues.length === 0 ? (
                <Empty message="No dissatisfaction data in the last 30 days" />
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <AreaChart data={data.dissatisfactionTrend.data} margin={{ top: 8, right: 16, left: -10, bottom: 0 }}>
                    <defs>
                      {data.dissatisfactionTrend.issues.map((issue, i) => {
                        const c = COLORS[i % COLORS.length];
                        return (
                          <linearGradient key={issue} id={`trendGrad-${i}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%"   stopColor={c} stopOpacity={0.45} />
                            <stop offset="100%" stopColor={c} stopOpacity={0} />
                          </linearGradient>
                        );
                      })}
                      <filter id="trendDotGlow" x="-100%" y="-100%" width="300%" height="300%">
                        <feGaussianBlur stdDeviation="2" result="blur" />
                        <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                      </filter>
                    </defs>
                    <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 9, fill: '#94a3b8' }} interval={0} angle={-45} textAnchor="end" height={50} />
                    <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} allowDecimals={false} />
                    <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#22d3ee', strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.55 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" iconSize={8} />
                    {data.dissatisfactionTrend.issues.map((issue, i) => {
                      const c = COLORS[i % COLORS.length];
                      const lastIdx = data.dissatisfactionTrend.data.length - 1;
                      return (
                        <Area
                          key={issue}
                          type="monotone"
                          dataKey={issue}
                          stroke={c}
                          strokeWidth={2}
                          fill={`url(#trendGrad-${i})`}
                          name={issue}
                          activeDot={{ r: 5, fill: c, stroke: '#0b0f17', strokeWidth: 1.5, filter: 'url(#trendDotGlow)' }}
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          dot={(props: any) => {
                            const { cx, cy, index } = props;
                            if (index !== lastIdx || cx == null || cy == null) {
                              // Recharts requires an SVG element; render an invisible placeholder.
                              return <circle key={`d-${i}-${index}`} cx={0} cy={0} r={0} fill="none" />;
                            }
                            return (
                              <g key={`d-${i}-${index}`} filter="url(#trendDotGlow)">
                                <circle className="trend-pulse-ring" cx={cx} cy={cy} r={4} fill={c} />
                                <circle cx={cx} cy={cy} r={3} fill={c} stroke="#0b0f17" strokeWidth={1.5} />
                              </g>
                            );
                          }}
                        />
                      );
                    })}
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </Section>

            {/* Weekly Issue Heat Map — last 7 days, top 5 issues × day-of-week.
                Per spec: today on far right, dynamically shifts each new day. */}
            <Section title="Weekly Issue Heat Map">
              {data.weeklyIssueHeatmap.issues.length === 0 ? (
                <Empty message="No issue data in the last 7 days" />
              ) : (
                <IssueHeatmap
                  rows={data.weeklyIssueHeatmap.issues.map((r) => ({ key: r.issue, label: r.issue }))}
                  cols={data.weeklyIssueHeatmap.days.map((d) => ({ key: d.date, label: d.label }))}
                  getValue={(rowKey, colKey) => {
                    const row = data.weeklyIssueHeatmap.issues.find((x) => x.issue === rowKey);
                    if (!row) return 0;
                    const colIdx = data.weeklyIssueHeatmap.days.findIndex((d) => d.date === colKey);
                    return colIdx >= 0 ? row.counts[colIdx] : 0;
                  }}
                  palette="cyan"
                  cellHeight="32px"
                  rowLabelWidth="190px"
                  showCounts
                  highlightLastCol
                  showLegend
                  onCellClick={(rowKey, colKey, _v, e) => navToConversations({ issue_item: rowKey, dateFrom: colKey, dateTo: colKey }, e)}
                />
              )}
            </Section>
          </div>

          {/* Daily & Hourly Issue Heat Map — full width ─────────────────── */}
          <Section title="Daily & Hourly Issue Heat Map">
            {data.dailyHourlyIssueHeatmap.dates.length === 0 ? (
              <Empty message="No data available" />
            ) : (
              <IssueHeatmap
                rows={data.dailyHourlyIssueHeatmap.dates.map((d) => {
                  const dt = new Date(d + 'T00:00:00Z');
                  const label = `${String(dt.getUTCDate()).padStart(2, '0')}-${dt.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}`;
                  return { key: d, label };
                })}
                cols={Array.from({ length: 24 }, (_, h) => ({
                  key: String(h),
                  label: String(h).padStart(2, '0'),
                }))}
                getValue={(rowKey, colKey) => {
                  const cell = data.dailyHourlyIssueHeatmap.cells.find((c) => c.date === rowKey && c.hour === parseInt(colKey, 10));
                  return cell?.count ?? 0;
                }}
                showCounts
                palette="magenta"
                cellHeight="22px"
                rowLabelWidth="80px"
              />
            )}
          </Section>

          {/* Row: Conversations Over Time + Resolution Status ────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Section title="Conversations Over Time">
              {data.conversationsByDate.length === 0 ? (
                <Empty message="No date data available" />
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart
                    data={data.conversationsByDate}
                    margin={{ top: 4, right: 8, left: -20, bottom: 40 }}
                    style={{ cursor: 'pointer' }}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    onClick={(d: any, e: any) => { if (d?.activeLabel) navToConversations({ dateFrom: d.activeLabel, dateTo: d.activeLabel }, e); }}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    onMouseDown={(d: any, e: any) => { if (e?.button === 1 && d?.activeLabel) { e.preventDefault?.(); navToConversations({ dateFrom: d.activeLabel, dateTo: d.activeLabel }, e); } }}
                  >
                    <defs>
                      <linearGradient id="convoLine" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%"   stopColor="#22d3ee" />
                        <stop offset="100%" stopColor="#f472b6" />
                      </linearGradient>
                      <filter id="convoDotGlow" x="-100%" y="-100%" width="300%" height="300%">
                        <feGaussianBlur stdDeviation="2" result="blur" />
                        <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                      </filter>
                    </defs>
                    <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 10, fill: '#94a3b8' }} interval={0} angle={-45} textAnchor="end" />
                    <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} />
                    <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#22d3ee', strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.55 }} />
                    <Line
                      type="monotone"
                      dataKey="count"
                      stroke="url(#convoLine)"
                      strokeWidth={3}
                      name="Conversations"
                      activeDot={{ r: 6, cursor: 'pointer', fill: '#22d3ee', filter: 'url(#convoDotGlow)' }}
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      dot={(props: any) => {
                        const { cx, cy, index } = props;
                        const lastIdx = data.conversationsByDate.length - 1;
                        if (index !== lastIdx || cx == null || cy == null) {
                          return <circle key={`cd-${index}`} cx={0} cy={0} r={0} fill="none" />;
                        }
                        return (
                          <g key={`cd-${index}`} filter="url(#convoDotGlow)">
                            <circle className="trend-pulse-ring" cx={cx} cy={cy} r={4} fill="#f472b6" />
                            <circle cx={cx} cy={cy} r={3} fill="#f472b6" stroke="#0b0f17" strokeWidth={1.5} />
                          </g>
                        );
                      }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </Section>

            <Section title="Resolution Status">
              {data.resolutionBreakdown.length === 0 ? (
                <Empty message="No analyzed data yet" />
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={180}>
                    <PieChart style={{ cursor: 'pointer' }}>
                      <defs>
                        <filter id="pieGlow" x="-50%" y="-50%" width="200%" height="200%">
                          <feGaussianBlur stdDeviation="4" result="blur" />
                          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                        </filter>
                      </defs>
                      <Pie
                        data={data.resolutionBreakdown}
                        dataKey="count"
                        nameKey="label"
                        cx="50%"
                        cy="50%"
                        innerRadius={50}
                        outerRadius={80}
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        activeShape={(props: any) => (
                          <Sector {...props} outerRadius={props.outerRadius + 4} style={{ filter: 'url(#pieGlow)' }} />
                        )}
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        onClick={(d: any, _i: number, e: any) => { if (d?.label) navToConversations({ resolution_status: d.label }, e); }}
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        onMouseDown={(d: any, _i: number, e: any) => { if (e?.button === 1 && d?.label) { e.preventDefault?.(); navToConversations({ resolution_status: d.label }, e); } }}
                      >
                        {data.resolutionBreakdown.map((entry, i) => (
                          <Cell key={i} fill={RESOLUTION_COLORS[entry.label] ?? COLORS[i % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip content={<ChartTooltip />} cursor={{ fill: 'transparent' }} />
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

          {/* Dissatisfaction Severity — full width ───────────────────────── */}
          <Section title="Dissatisfaction Severity">
            {data.severityBreakdown.length === 0 ? (
              <Empty message="No analyzed data yet" />
            ) : (
              <>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart
                    data={data.severityBreakdown}
                    margin={{ top: 4, right: 8, left: -20, bottom: 0 }}
                    style={{ cursor: 'pointer' }}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    onClick={(data: any, e: any) => { if (data?.activeLabel) navToConversations({ dissatisfaction_severity: data.activeLabel }, e); }}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    onMouseDown={(data: any, e: any) => { if (e?.button === 1 && data?.activeLabel) { e.preventDefault?.(); navToConversations({ dissatisfaction_severity: data.activeLabel }, e); } }}
                  >
                    <defs>
                      {/* One vertical gradient per severity bucket — fades from the
                          base accent at top to a darkened version at bottom, giving
                          each bar a glowing/neon look against the dark surface. */}
                      {data.severityBreakdown.map((entry, i) => {
                        const base = SEVERITY_COLORS[entry.label] ?? COLORS[i % COLORS.length];
                        return (
                          <linearGradient key={entry.label} id={`sevBar-${i}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%"   stopColor={base} stopOpacity={1}    />
                            <stop offset="100%" stopColor={base} stopOpacity={0.35} />
                          </linearGradient>
                        );
                      })}
                      <filter id="barGlowSev" x="-50%" y="-50%" width="200%" height="200%">
                        <feGaussianBlur stdDeviation="4" result="blur" />
                        <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                      </filter>
                    </defs>
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} />
                    <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} />
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: 'transparent' }} />
                    <Bar
                      dataKey="count"
                      radius={[6, 6, 0, 0]}
                      name="Count"
                      activeBar={{ filter: 'url(#barGlowSev)' }}
                    >
                      {data.severityBreakdown.map((_, i) => (
                        <Cell key={i} fill={`url(#sevBar-${i})`} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <div className="flex flex-wrap gap-x-10 gap-y-2 mt-3">
                  {data.severityBreakdown.map((s, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 text-sm cursor-pointer hover:bg-slate-50 rounded px-1.5 -mx-1.5 py-0.5 transition-colors"
                      onClick={(e) => navToConversations({ dissatisfaction_severity: s.label }, e)}
                      onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); navToConversations({ dissatisfaction_severity: s.label }, e); } }}
                    >
                      <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: SEVERITY_COLORS[s.label] ?? COLORS[i % COLORS.length] }} />
                      <span className="text-slate-600">{s.label}</span>
                      <span className="font-semibold text-slate-800">{fmt(s.count)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Section>

          {/* Lower section — existing analytics, reordered per spec.
              Order: Language, Brand, Agent (3-col row), then Category Breakdown
              (full), then Issues Breakdown (full, last). */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
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
                    <defs>
                      {data.languageBreakdown.map((_, i) => {
                        const base = COLORS[i % COLORS.length];
                        return (
                          <linearGradient key={i} id={`langBar-${i}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%"   stopColor={base} stopOpacity={1}    />
                            <stop offset="100%" stopColor={base} stopOpacity={0.35} />
                          </linearGradient>
                        );
                      })}
                      <filter id="barGlowLang" x="-50%" y="-50%" width="200%" height="200%">
                        <feGaussianBlur stdDeviation="4" result="blur" />
                        <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                      </filter>
                    </defs>
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} />
                    <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} />
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: 'transparent' }} />
                    <Bar
                      dataKey="count"
                      radius={[6, 6, 0, 0]}
                      name="Conversations"
                      activeBar={{ filter: 'url(#barGlowLang)' }}
                    >
                      {data.languageBreakdown.map((_, i) => (
                        <Cell key={i} fill={`url(#langBar-${i})`} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Section>

            <Section title="Brand Breakdown">
              {data.brandBreakdown.length === 0 ? (
                <Empty message="No brand data available" />
              ) : (
                <div className="space-y-2.5 max-h-[300px] overflow-y-auto pr-2">
                  {data.brandBreakdown.map((b, i) => {
                    const pct = data.overview.analyzed > 0 ? Math.round((b.count / data.overview.analyzed) * 100) : 0;
                    const isTop3 = i < 3;
                    return (
                      <div
                        key={i}
                        className="cursor-pointer group border-l-2 border-transparent hover:border-cyan-400 transition-colors pl-2 -ml-2"
                        onClick={(e) => navToConversations({ brand: b.label }, e)}
                        onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); navToConversations({ brand: b.label }, e); } }}
                      >
                        <div className="flex items-center justify-between text-xs mb-1 gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className={`font-mono text-[10px] tabular-nums shrink-0 ${isTop3 ? 'text-cyan-400 font-semibold' : 'text-slate-400'}`}
                              style={isTop3 ? { textShadow: '0 0 8px rgba(34, 211, 238, 0.55)' } : undefined}
                            >
                              {String(i + 1).padStart(2, '0')}
                            </span>
                            <span className="text-slate-600 font-medium truncate group-hover:text-cyan-400 transition-colors">{b.label}</span>
                          </div>
                          <span className="text-slate-400 shrink-0 tabular-nums">{fmt(b.count)} <span className="text-slate-300">({pct}%)</span></span>
                        </div>
                        <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-300"
                            style={{
                              width: `${pct}%`,
                              background: 'linear-gradient(to right, #22d3ee, #f472b6)',
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Section>

            <Section title="Agent Breakdown">
              {data.agentBreakdown.length === 0 ? (
                <Empty message="No agent data available" />
              ) : (
                <div className="overflow-y-auto max-h-[300px] pr-2 scrollbar-slim">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-white">
                      <tr className="border-b border-slate-100">
                        <th className="text-left py-2 pl-2 pr-2 text-xs font-semibold text-slate-400 uppercase tracking-wide w-10">#</th>
                        <th className="text-left py-2 pr-4 text-xs font-semibold text-slate-400 uppercase tracking-wide">Agent</th>
                        <th className="text-right py-2 pr-2 text-xs font-semibold text-slate-400 uppercase tracking-wide">Conversations</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.agentBreakdown.map((a, i) => {
                        const maxCount = data.agentBreakdown[0]?.count ?? 1;
                        const pct = (a.count / maxCount) * 100;
                        const isTop3 = i < 3;
                        return (
                          <tr
                            key={i}
                            className="group hover:bg-slate-50 transition-colors cursor-pointer"
                            onClick={(e) => navToConversations({ agent_name: a.label }, e)}
                            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); navToConversations({ agent_name: a.label }, e); } }}
                          >
                            <td className="py-2.5 pl-2 pr-2 border-l-2 border-transparent group-hover:border-cyan-400 transition-colors">
                              <span
                                className={`font-mono text-[10px] tabular-nums ${isTop3 ? 'text-cyan-400 font-semibold' : 'text-slate-400'}`}
                                style={isTop3 ? { textShadow: '0 0 8px rgba(34, 211, 238, 0.55)' } : undefined}
                              >
                                {String(i + 1).padStart(2, '0')}
                              </span>
                            </td>
                            <td className="py-2.5 pr-4 text-slate-700 text-xs font-medium">{a.label}</td>
                            <td className="py-2.5 pr-2 text-right">
                              <div className="flex items-center gap-2 justify-end">
                                <div className="h-1 w-[80px] bg-slate-200 rounded-full overflow-hidden">
                                  <div
                                    className="h-full rounded-full transition-all duration-300"
                                    style={{
                                      width: `${pct}%`,
                                      background: 'linear-gradient(to right, #22d3ee, #f472b6)',
                                    }}
                                  />
                                </div>
                                <span className="text-xs font-semibold text-slate-600 tabular-nums min-w-[3ch] text-right">{fmt(a.count)}</span>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
          </div>

          {/* Category Breakdown — renamed from "Top Issue Categories";
              now shows all categories (no top-10 cap per spec). */}
          <Section title="Category Breakdown">
            {data.topCategories.length === 0 ? (
              <Empty message="No analyzed data yet" />
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(220, data.topCategories.length * 36)}>
                <BarChart
                  data={data.topCategories}
                  layout="vertical"
                  margin={{ top: 0, right: 32, left: 8, bottom: 0 }}
                  style={{ cursor: 'pointer' }}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  onClick={(d: any, e: any) => { if (d?.activeLabel) navToConversations({ issue_category: d.activeLabel }, e); }}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  onMouseDown={(d: any, e: any) => { if (e?.button === 1 && d?.activeLabel) { e.preventDefault?.(); navToConversations({ issue_category: d.activeLabel }, e); } }}
                >
                  <defs>
                    {/* Cyan→violet sweep across the full list — gives the long
                        category column a futuristic gradient instead of a wall
                        of identical pure-blue bars. */}
                    {data.topCategories.map((_, i) => {
                      const t = data.topCategories.length > 1 ? i / (data.topCategories.length - 1) : 0;
                      // Lerp between cyan (#22d3ee) and violet (#a78bfa)
                      const r = Math.round(34  + (167 - 34)  * t);
                      const g = Math.round(211 + (139 - 211) * t);
                      const b = Math.round(238 + (250 - 238) * t);
                      const base = `rgb(${r},${g},${b})`;
                      return (
                        <linearGradient key={i} id={`catBar-${i}`} x1="0" y1="0" x2="1" y2="0">
                          <stop offset="0%"   stopColor={base} stopOpacity={0.35} />
                          <stop offset="100%" stopColor={base} stopOpacity={1}    />
                        </linearGradient>
                      );
                    })}
                    <filter id="barGlowCat" x="-50%" y="-50%" width="200%" height="200%">
                      <feGaussianBlur stdDeviation="4" result="blur" />
                      <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                    </filter>
                  </defs>
                  <XAxis type="number" tick={{ fontSize: 11, fill: '#94a3b8' }} />
                  <YAxis type="category" dataKey="label" width={240} tick={{ fontSize: 11, fill: 'var(--chart-axis-label)' }} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: 'transparent' }} />
                  <Bar
                    dataKey="count"
                    radius={[0, 6, 6, 0]}
                    name="Conversations"
                    activeBar={{ filter: 'url(#barGlowCat)' }}
                  >
                    {data.topCategories.map((_, i) => (
                      <Cell key={i} fill={`url(#catBar-${i})`} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </Section>

          {/* Issues Breakdown — renamed from "Top Issue Items"; full list,
              positioned last per spec since it's the longest. */}
          <Section title="Issues Breakdown">
            {data.topItems.length === 0 ? (
              <Empty message="No analyzed data yet" />
            ) : (
              <div className="overflow-x-auto max-h-[600px] overflow-y-auto scrollbar-slim">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white">
                    <tr className="border-b border-slate-200">
                      <th className="text-left py-3 pl-3 pr-3 text-xs font-semibold text-slate-600 uppercase tracking-wide w-12">#</th>
                      <th className="text-left py-3 pr-4 text-xs font-semibold text-slate-600 uppercase tracking-wide">Issue</th>
                      <th className="text-left py-3 pr-4 text-xs font-semibold text-slate-600 uppercase tracking-wide">Category</th>
                      <th className="text-right py-3 pr-3 text-xs font-semibold text-slate-600 uppercase tracking-wide">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topItems.map((item, i) => {
                      const maxCount = data.topItems[0]?.count ?? 1;
                      const pct = (item.count / maxCount) * 100;
                      const isTop3 = i < 3;
                      return (
                        <tr
                          key={i}
                          className="group hover:bg-slate-50 transition-colors cursor-pointer"
                          onClick={(e) => navToConversations({ issue_item: item.label }, e)}
                          onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); navToConversations({ issue_item: item.label }, e); } }}
                        >
                          <td className="py-3 pl-3 pr-3 border-l-2 border-transparent group-hover:border-cyan-400 transition-colors">
                            <span
                              className={`font-mono text-xs tabular-nums ${isTop3 ? 'text-cyan-400 font-semibold' : 'text-slate-400'}`}
                              style={isTop3 ? { textShadow: '0 0 8px rgba(34, 211, 238, 0.55)' } : undefined}
                            >
                              {String(i + 1).padStart(2, '0')}
                            </span>
                          </td>
                          <td className="py-3 pr-4 text-slate-800 text-sm font-medium">{item.label}</td>
                          <td className="py-3 pr-4 text-slate-500 text-sm">{item.category}</td>
                          <td className="py-3 pr-3 text-right">
                            <div className="flex items-center gap-3 justify-end">
                              <div className="h-1 w-[120px] bg-slate-200 rounded-full overflow-hidden">
                                <div
                                  className="h-full rounded-full transition-all duration-300"
                                  style={{
                                    width: `${pct}%`,
                                    background: 'linear-gradient(to right, #22d3ee, #f472b6)',
                                  }}
                                />
                              </div>
                              <span className="text-sm font-semibold text-blue-600 tabular-nums min-w-[3ch] text-right">{fmt(item.count)}</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
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
