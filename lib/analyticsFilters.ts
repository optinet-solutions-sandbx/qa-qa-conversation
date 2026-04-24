// Shared filter + summary-parsing helpers used by the dashboard route and the
// conversations drill-down in lib/db.ts.  Keeping both code paths on the same
// normalisation / matching functions is what guarantees the dashboard's counts
// match the drill-down lists one-to-one.  Do not inline these rules elsewhere.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabaseQuery = any;

// ── Summary JSON ──────────────────────────────────────────────────────────

function stripFences(text: string): string {
  return text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
}

export interface AnalysisResult {
  category?: string | null;
  item?: string | null;
}

export interface AnalysisSummary {
  results: AnalysisResult[];
  resolution_status: string | null;
  dissatisfaction_severity: string | null;
  language: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: Record<string, any> | null;
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
    return {
      results,
      resolution_status:        typeof obj.resolution_status        === 'string' ? obj.resolution_status        : null,
      dissatisfaction_severity: typeof obj.dissatisfaction_severity === 'string' ? obj.dissatisfaction_severity : null,
      language:                 typeof obj.language                 === 'string' ? obj.language                 : null,
      raw: obj,
    };
  } catch {
    return empty;
  }
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

export interface DbFilterInputs {
  dateFrom?: string | null;
  dateTo?:   string | null;
  brand?:    string | null;
  agent?:    string | null;
  accountManager?: string | null;
}

// Applies the date/brand/agent/AM filters to a Supabase query builder in the
// exact same way on every code path that hits the conversations table.  This
// is what keeps the dashboard overview counts and the drill-down list counts
// in lock-step.
export function applyConversationDbFilters(q: AnySupabaseQuery, f: DbFilterInputs): AnySupabaseQuery {
  if (f.dateFrom) q = q.gte('intercom_created_at', new Date(f.dateFrom).toISOString());
  if (f.dateTo) {
    const end = new Date(f.dateTo);
    end.setUTCDate(end.getUTCDate() + 1);
    q = q.lt('intercom_created_at', end.toISOString());
  }
  if (f.brand) {
    if (f.brand.toLowerCase() === 'unknown') q = q.is('brand', null);
    else                                     q = q.eq('brand', f.brand);
  }
  if (f.agent) {
    if (f.agent.toLowerCase() === 'unknown') q = q.is('agent_name', null);
    else                                     q = q.eq('agent_name', f.agent);
  }
  if (f.accountManager) {
    const am = f.accountManager;
    const lower = am.toLowerCase();
    const amTags = lower === 'softswiss'
      ? ['group: softswiss🎲', 'group: softswiss dach', 'group: softswiss english', 'group: softswiss']
      : [`group: vip_${lower}🎲`, `group: non-vip_${lower}🎲`];
    const quotedTags = amTags.map((t) => `"${t}"`).join(',');
    q = q.or(`account_manager.eq.${am},player_tags.ov.{${quotedTags}}`);
  }
  return q;
}
