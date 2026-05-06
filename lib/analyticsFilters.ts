// Shared filter + summary-parsing helpers used by the dashboard route and the
// conversations drill-down in lib/db.ts.  Keeping both code paths on the same
// normalisation / matching functions is what guarantees the dashboard's counts
// match the drill-down lists one-to-one.  Do not inline these rules elsewhere.

import { getAmGroupsForFilter } from './utils';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabaseQuery = any;

// ── Summary JSON ──────────────────────────────────────────────────────────

function stripFences(text: string): string {
  return text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
}

export interface AnalysisResult {
  category?: string | null;
  item?: string | null;
  dissatisfaction_severity?: string | number | null;
}

export interface AnalysisSummary {
  results: AnalysisResult[];
  resolution_status: string | null;
  dissatisfaction_severity: string | null;
  language: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: Record<string, any> | null;
}

// Coerces the AI's severity value to a plain string regardless of whether it
// arrived as a JSON string or a JSON number (the current prompt asks for
// 1/2/3 and the AI often returns that as a number).
function coerceSeverity(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return null;
}

// Picks the worst (max) 1/2/3 severity found across the results[] entries.
// The current prompt nests `dissatisfaction_severity` inside each result item
// rather than at the top level, so without this fallback every analysed chat
// looks like Unknown even when the AI did return a severity.
function maxResultSeverity(results: AnalysisResult[]): string | null {
  let max = 0;
  for (const r of results) {
    const s = coerceSeverity(r?.dissatisfaction_severity);
    if (!s) continue;
    const m = s.match(/[123]/);
    if (!m) continue;
    const n = parseInt(m[0], 10);
    if (n > max) max = n;
  }
  return max > 0 ? String(max) : null;
}

export function parseAnalysisSummary(raw: string | null): AnalysisSummary {
  const empty: AnalysisSummary = { results: [], resolution_status: null, dissatisfaction_severity: null, language: null, raw: null };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(stripFences(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = parsed as Record<string, any>;
    const results: AnalysisResult[] = Array.isArray(obj.results) ? obj.results : [];
    // Read severity from the top-level field first (older prompts), then fall
    // back to the worst severity reported inside any results[] entry (current
    // prompt nests it there).  This keeps the dashboard compatible with both
    // prompt shapes without another re-analysis pass.
    const severity = coerceSeverity(obj.dissatisfaction_severity) ?? maxResultSeverity(results);
    return {
      results,
      resolution_status:        typeof obj.resolution_status === 'string' ? obj.resolution_status : null,
      dissatisfaction_severity: severity,
      language:                 typeof obj.language === 'string' ? obj.language : null,
      raw: obj,
    };
  } catch {
    return empty;
  }
}

// Normalises the severity value to one of "Level 1" / "Level 2" / "Level 3"
// so the dashboard and drill-down can compare across AI output variants
// ("1", "1 — Minor", "Level 1", "Severity: 1", etc).  Returns null for
// values that do not carry a 1/2/3 level, so callers can bucket them as
// Unknown (covers legacy Low/Medium/High/Critical values from older prompts).
export function normalizeSeverity(raw: string | number | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/[123]/);
  if (!m) return null;
  return `Level ${m[0]}`;
}

// ── Category / issue normalisation ─────────────────────────────────────────

// Collapses AI-produced variants of the same category label so they compare
// as equal.  Examples that all map to the same normalised form:
//   "1. Account Closure Requests"
//   "  1.  Account Closure Requests  "
//   "Category 1: Account Closure Requests"
//   "category 1  account closure requests"
export function normalizeCategoryLabel(raw: string | null | undefined): string {
  if (raw == null) return '';
  return String(raw)
    .replace(/^category\s+(\d+)[:\s]+/i, '$1. ')
    .trim()
    .toLowerCase();
}

// Collapses issue-item variants, including trailing-'s' plural/singular pairs:
//   "1. Account Closure Requests"   → "account closure request"
//   "Account Closure Request"       → "account closure request"
//   "  Account Closure Requests  "  → "account closure request"
export function normalizeIssueLabel(raw: string | null | undefined): string {
  if (raw == null) return '';
  return String(raw)
    .replace(/^\d+\.\s*/, '')
    .trim()
    .toLowerCase()
    .replace(/s$/, '');
}

// Extracts the leading numeric prefix from a category label (e.g. "1. Foo" → 1).
// Returns null when there is no "N." prefix.
export function categoryNumPrefix(label: string | null | undefined): number | null {
  if (label == null) return null;
  const m = String(label).match(/^\s*(\d+)\./);
  return m ? parseInt(m[1], 10) : null;
}

// ── Matchers ──────────────────────────────────────────────────────────────

// Returns a predicate that tests whether a given category string matches any
// of the user-selected category filters.  Match is either exact (normalised)
// or by numeric prefix — so selecting the canonical "1. Account Closure &
// Self-Exclusion Requests" also captures the AI variant "1. Self-Exclusion
// Requests" which shares the "1." prefix.
export function buildCategoryMatcher(selected: string[]): (c: string | null | undefined) => boolean {
  if (selected.length === 0) return () => true;
  const keys = new Set(selected.map((c) => normalizeCategoryLabel(c)));
  const prefixes = new Set(
    selected.map((c) => categoryNumPrefix(normalizeCategoryLabel(c))).filter((p): p is number => p !== null),
  );
  return (c) => {
    const norm = normalizeCategoryLabel(c);
    if (!norm) return keys.has('');  // only matches if user literally selected '' (they can't)
    if (keys.has(norm)) return true;
    const pfx = categoryNumPrefix(norm);
    return pfx !== null && prefixes.has(pfx);
  };
}

// Returns a predicate that tests whether an issue-item string matches any of
// the selected issue filters, using the singular/plural-tolerant normaliser.
export function buildIssueMatcher(selected: string[]): (item: string | null | undefined) => boolean {
  if (selected.length === 0) return () => true;
  const keys = new Set(selected.map((i) => normalizeIssueLabel(i)).filter((k) => k !== ''));
  return (item) => {
    const norm = normalizeIssueLabel(item);
    if (!norm) return false;
    return keys.has(norm);
  };
}

// True if at least one of the row's results passes both category and issue
// filters (matches don't have to be from the same result entry).
export function rowPassesCategoryIssueFilter(
  results: AnalysisResult[],
  categoryMatcher: (c: string | null | undefined) => boolean,
  issueMatcher: (item: string | null | undefined) => boolean,
  hasCategoryFilter: boolean,
  hasIssueFilter: boolean,
): boolean {
  if (hasCategoryFilter && !results.some((x) => categoryMatcher(x.category))) return false;
  if (hasIssueFilter    && !results.some((x) => issueMatcher(x.item)))        return false;
  return true;
}

// ── DB-level filters ──────────────────────────────────────────────────────

// brand / agent / accountManager accept either a single value or an array.
// Single values keep the original `.eq()` / `.is(null)` semantics so the
// drill-down's per-row filters keep behaving identically. Arrays are folded
// into a single OR clause so the dashboard's multi-select combines values
// inclusively at the DB level.
export interface DbFilterInputs {
  dateFrom?: string | null;
  dateTo?:   string | null;
  brand?:    string | string[] | null;
  agent?:    string | string[] | null;
  accountManager?: string | string[] | null;
  country?:  string | string[] | null;
  // Asana ticketing filters (used by Report Page drill-downs).
  // asana_ticketed=true narrows to rows that currently have a live Asana task.
  // asana_status further narrows that set to open vs closed; setting it
  // implies asana_ticketed=true even when caller didn't pass it.
  asanaTicketed?: boolean;
  asanaStatus?:  'open' | 'closed';
}

function toArray(v: string | string[] | null | undefined): string[] {
  if (v == null) return [];
  return Array.isArray(v) ? v.filter((s) => s !== '') : (v ? [v] : []);
}

// PostgREST .or() syntax requires values that contain commas, parentheses or
// special chars to be wrapped in double quotes; quote everything for safety.
function pgrstQuote(v: string): string {
  return `"${v.replace(/"/g, '\\"')}"`;
}

// Hard floor: the dashboard ignores everything before this date. The collected
// March/April-26 data stays in the DB but is filtered out everywhere this
// helper is used. Update this if the cutoff ever changes.
export const ANALYSIS_MIN_DATE_ISO = '2026-04-27T00:00:00.000Z';

// Applies the date/brand/agent/AM filters to a Supabase query builder in the
// exact same way on every code path that hits the conversations table.  This
// is what keeps the dashboard overview counts and the drill-down list counts
// in lock-step.
export function applyConversationDbFilters(q: AnySupabaseQuery, f: DbFilterInputs): AnySupabaseQuery {
  // Floor dateFrom to ANALYSIS_MIN_DATE_ISO so callers can't dip below the
  // cutoff (whether by passing an older date, an empty string, or null).
  const requestedFromISO = f.dateFrom ? new Date(f.dateFrom).toISOString() : null;
  const effectiveFromISO = requestedFromISO && requestedFromISO > ANALYSIS_MIN_DATE_ISO
    ? requestedFromISO
    : ANALYSIS_MIN_DATE_ISO;
  q = q.gte('intercom_created_at', effectiveFromISO);
  if (f.dateTo) {
    const end = new Date(f.dateTo);
    end.setUTCDate(end.getUTCDate() + 1);
    q = q.lt('intercom_created_at', end.toISOString());
  }
  // Use Supabase's native .in() helper for the all-named case — passing the
  // values as a JS array lets the client serialise them safely (handles names
  // with spaces, commas, special chars). The .or() + in.() string form was
  // dropping rows in practice because the embedded quotes didn't round-trip
  // through URL encoding into PostgREST. Only fall back to .or() when the
  // selection mixes "Unknown" (i.e. NULL) in with named values.
  const applyMultiCol = (col: string, vals: string[]) => {
    if (vals.length === 0) return;
    const hasUnknown = vals.some((v) => v.toLowerCase() === 'unknown');
    const named      = vals.filter((v) => v.toLowerCase() !== 'unknown');
    if (named.length === 0) {
      q = q.is(col, null);
      return;
    }
    if (!hasUnknown) {
      if (named.length === 1) {
        q = q.eq(col, named[0]);
      } else {
        q = q.in(col, named);
      }
      return;
    }
    // Mixed: named values OR NULL.
    q = q.or(`${col}.in.(${named.map(pgrstQuote).join(',')}),${col}.is.null`);
  };

  applyMultiCol('brand',         toArray(f.brand));
  applyMultiCol('agent_name',    toArray(f.agent));
  applyMultiCol('player_country', toArray(f.country));

  const ams = toArray(f.accountManager);
  if (ams.length > 0) {
    // Map each AM display name → owned groups via GROUP_TO_AM so VIP/NON-VIP
    // halves that resolve to different AMs (e.g. vip_koko=Koko,
    // non-vip_koko=Geri/Nik) don't bleed into each other's results. Multiple
    // AMs are unioned together — a row matching any selected AM passes.
    const allTags = new Set<string>();
    for (const am of ams) {
      const tags = am.toLowerCase() === 'softswiss'
        ? ['group: softswiss🎲', 'group: softswiss dach', 'group: softswiss english', 'group: softswiss']
        : getAmGroupsForFilter(am).map((g) => `group: ${g}🎲`);
      tags.forEach((t) => allTags.add(t));
    }
    // The AM block has to stay on .or() since it combines two columns
    // (account_manager OR player_tags-overlap) into one disjunction. Quote
    // each AM name individually to handle "Geri/Nik" and any name with a
    // slash, comma or space.
    const quotedTags  = [...allTags].map((t) => `"${t}"`).join(',');
    const amInList    = `account_manager.in.(${ams.map(pgrstQuote).join(',')})`;
    const tagOverlap  = quotedTags ? `player_tags.ov.{${quotedTags}}` : '';
    const clauses     = [amInList, tagOverlap].filter(Boolean);
    q = q.or(clauses.join(','));
  }
  // Mirror the row set that dbGetAsanaReportingMetrics uses: a "live" ticket
  // is one whose gid is set and whose task hasn't been deleted in Asana.
  if (f.asanaTicketed || f.asanaStatus) {
    q = q.not('asana_task_gid', 'is', null).is('asana_task_deleted_at', null);
  }
  if (f.asanaStatus === 'open')   q = q.is('asana_completed_at', null);
  if (f.asanaStatus === 'closed') q = q.not('asana_completed_at', 'is', null);
  return q;
}
