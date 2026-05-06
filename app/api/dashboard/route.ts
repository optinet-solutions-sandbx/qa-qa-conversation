import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase';
import {
  parseAnalysisSummary,
  buildCategoryMatcher,
  buildIssueMatcher,
  applyConversationDbFilters,
  normalizeSeverity,
} from '@/lib/analyticsFilters';
import { getSegment, getVipLevelNum, parseSegmentFilter, parseVipLevelFilter } from '@/lib/utils';

// Display helper: strip "Category N: " prefix, preserving original casing so the
// label still reads nicely in the UI (normalizeCategoryLabel lowercases for
// matching, which we don't want on display).
function displayCategory(label: string): string {
  return label.replace(/^category\s+(\d+)[:\s]+/i, '$1. ').trim();
}

function countBy<T>(items: T[], key: (item: T) => string | null): { label: string; count: number }[] {
  const map: Record<string, { count: number; label: string }> = {};
  for (const item of items) {
    const raw = key(item) ?? 'Unknown';
    const k = raw.toLowerCase().trim();
    if (!map[k]) map[k] = { count: 0, label: raw };
    map[k].count++;
  }
  return Object.values(map)
    .sort((a, b) => b.count - a.count);
}

// ── GET /api/dashboard ─────────────────────────────────────────────────────
// Query params: dateFrom, dateTo, brand, agent, category, ..., part
// `part` controls which slice of the response is built:
//   - 'scoped' → date-dependent stuff (overview, breakdowns, conversationsByDate, …)
//   - 'global' → date-independent stuff (30-day trend/heatmaps, spikes, pending
//                escalations, brand/agent/country dropdowns)
//   - omitted  → both, merged into the legacy single-payload shape
// The dashboard splits its fetch into two requests with different cache keys so
// changing only the date filter is a global-cache hit and only refetches scoped.

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const part           = searchParams.get('part'); // 'scoped' | 'global' | null
  const wantScoped     = part !== 'global';
  const wantGlobal     = part !== 'scoped';
  const dateFrom       = searchParams.get('dateFrom');
  const dateTo         = searchParams.get('dateTo');
  // All filters are multi-value — single-value clients (e.g. drill-down overlay)
  // can still send the same param once and it'll resolve to a single-element array.
  const brands         = searchParams.getAll('brand');
  const agents         = searchParams.getAll('agent');
  const accountManagers = searchParams.getAll('accountManager');
  const categories     = searchParams.getAll('category');
  const issues         = searchParams.getAll('issue');
  const severities     = searchParams.getAll('severity');
  const resolutions    = searchParams.getAll('resolution');
  const languages      = searchParams.getAll('language');
  const segments       = searchParams.getAll('segment');
  const vipLevels      = searchParams.getAll('vipLevel');
  const countries      = searchParams.getAll('country');

  try {
    // Shared DB-level filter — the exact same helper is used by the drill-down
    // in lib/db.ts, which is what keeps the overview counts and the drill-down
    // list counts in lock-step.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applyFilters = (q: any) => applyConversationDbFilters(q, {
      dateFrom, dateTo,
      brand:          brands,
      agent:          agents,
      accountManager: accountManagers,
      country:        countries,
    });

    const PAGE_SIZE = 1000;

    // ── Wider 30-day window (kicked off in parallel with the main fetch) ──
    // The 30-day load powers the trend + heatmap widgets and is independent of
    // the user's date filter. We compute its bounds here and start the
    // pagination loop immediately so it runs alongside the count queries and
    // the main row fetch instead of waiting for them to finish.
    const widerEndUTC = new Date();
    widerEndUTC.setUTCHours(0, 0, 0, 0);
    widerEndUTC.setUTCDate(widerEndUTC.getUTCDate() + 1); // exclusive: start of tomorrow UTC
    const widerStartUTC = new Date(widerEndUTC);
    widerStartUTC.setUTCDate(widerStartUTC.getUTCDate() - 31); // 30 inclusive days

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applyWiderDbFilters = (q: any) => applyConversationDbFilters(q, {
      dateFrom: widerStartUTC.toISOString(),
      brand:          brands,
      agent:          agents,
      accountManager: accountManagers,
      country:        countries,
    });

    // Only fire the heavy 30-day pagination when the global slice is requested.
    // For scoped-only requests this is wasted work — the trend/heatmap widgets
    // already have their data cached client-side from a prior global fetch.
    const widerRowsPromise: Promise<Array<Record<string, unknown>>> | null = wantGlobal
      ? (async () => {
          const out: Array<Record<string, unknown>> = [];
          let idx = 0;
          while (true) {
            const { data: page } = await applyWiderDbFilters(
              supabase
                .from('conversations')
                .select('id, summary, language, intercom_created_at, dissatisfaction_severity, player_tags, player_segments, player_companies, tags, player_custom_attributes')
                .not('summary', 'is', null)
                .lt('intercom_created_at', widerEndUTC.toISOString())
                .order('intercom_created_at', { ascending: false })
                .order('id', { ascending: false })
                .range(idx, idx + PAGE_SIZE - 1)
            ) as { data: Array<Record<string, unknown>> | null };
            if (!page || page.length === 0) break;
            out.push(...page);
            if (page.length < PAGE_SIZE) break;
            idx += PAGE_SIZE;
          }
          return out;
        })()
      : null;

    // ── Overview counts ──────────────────────────────────────────────────
    let total = 0, analyzed = 0, alertWorthy = 0;
    if (wantScoped) {
      const [totalRes, analyzedRes, alertRes] = await Promise.all([
        applyFilters(supabase.from('conversations').select('*', { count: 'exact', head: true })),
        applyFilters(supabase.from('conversations').select('*', { count: 'exact', head: true }).not('summary', 'is', null)),
        applyFilters(supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('is_alert_worthy', true)),
      ]);
      total       = totalRes.count    ?? 0;
      analyzed    = analyzedRes.count ?? 0;
      alertWorthy = alertRes.count    ?? 0;
    }

    // ── Analyzed conversations (paginated to bypass 1000-row default limit) ──
    const allAnalyzedRows: Array<Record<string, unknown>> = [];
    if (wantScoped) {
      let from = 0;
      while (true) {
        // Same explicit order the drill-down uses — without ORDER BY, Postgres
        // offset pagination across separate HTTP requests can skip or duplicate
        // rows, which was a plausible source of past dashboard/drill-down count
        // drift.
        const { data: page } = await applyFilters(
          supabase
            .from('conversations')
            .select('id, summary, brand, agent_name, is_alert_worthy, intercom_created_at, language, resolution_status, dissatisfaction_severity, player_tags, player_segments, player_companies, tags, player_custom_attributes, analyzed_at, asana_task_gid, asana_completed_at, asana_task_deleted_at')
            .not('summary', 'is', null)
            .order('intercom_created_at', { ascending: false })
            .order('id', { ascending: false })
            .range(from, from + PAGE_SIZE - 1)
        ) as { data: Array<Record<string, unknown>> | null };

        if (!page || page.length === 0) break;
        allAnalyzedRows.push(...page);
        if (page.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }
    }

    // Defensive dedup: even with a stable ORDER BY, any future change that
    // alters the query between pages (or a Supabase quirk) could hand back the
    // same row twice. Keying by id guarantees each conversation is counted
    // exactly once.
    const seenIds = new Set<string>();
    const rows = allAnalyzedRows.filter((r) => {
      const id = r.id as string | undefined;
      if (!id || seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });

    // ── Parse summary JSON for fields not stored individually ────────────
    type Parsed = {
      resolution_status: string | null;
      language: string | null;
      severity: string | null;
      vip_level: number | null;
      segment: 'VIP' | 'NON-VIP' | 'SoftSwiss' | null;
      categories: string[];
      items: { category: string; item: string }[];
    };

    const parsed: Parsed[] = rows.map((r) => {
      const summary = parseAnalysisSummary(r.summary as string | null);
      const playerAttrs = {
        player_tags:              (r.player_tags as string[] | null) ?? [],
        player_segments:          (r.player_segments as string[] | null) ?? [],
        player_companies:         (r.player_companies as { name: string }[] | null) ?? [],
        tags:                     (r.tags as string[] | null) ?? [],
        player_custom_attributes: (r.player_custom_attributes as Record<string, unknown> | null) ?? null,
      };
      return {
        resolution_status:
          (r.resolution_status as string | null) ??
          summary.resolution_status ?? null,
        language:
          (r.language as string | null) ??
          summary.language ?? null,
        severity:
          (r.dissatisfaction_severity as string | null) ??
          summary.dissatisfaction_severity ?? null,
        vip_level: getVipLevelNum(playerAttrs),
        segment:   getSegment(playerAttrs),
        categories: summary.results.map((x) => displayCategory(x.category ?? 'Unknown')),
        items: summary.results.map((x) => ({ category: displayCategory(x.category ?? 'Unknown'), item: x.item ?? 'Unknown' })),
      };
    });

    // ── Collect category options for the dropdown (before filtering) ─────────
    // Sort by frequency and apply a minimum count so mislabeled items (which the
    // AI occasionally writes into results[].category) are excluded. Real categories
    // appear hundreds–thousands of times; one-off mislabels appear a handful.
    const allCategoryFreq: Record<string, { count: number; label: string }> = {};
    for (const c of parsed.flatMap((p) => p.categories)) {
      if (c === 'Unknown') continue;
      const key = c.toLowerCase().trim();
      if (!allCategoryFreq[key]) allCategoryFreq[key] = { count: 0, label: c };
      allCategoryFreq[key].count++;
    }
    const numPrefix = (s: string) => { const m = s.match(/^(\d+)\./); return m ? parseInt(m[1], 10) : 999; };
    const minCategoryCount = Math.max(3, Math.ceil(rows.length * 0.003));
    const EXCLUDED_CATEGORY_PREFIXES = new Set([5]);
    const canonicalCategories = [
      '1. Account Closure & Self-Exclusion Requests',
      '2. Payments (Deposits, Limits, Refunds)',
      '3. Withdrawal Disputes',
      '4. Player Experience & Expectations (Retention)',
    ];
    // Build a map of numeric prefix → canonical key so variants like
    // "1. Account Closure Requests" get folded into the canonical entry.
    const canonicalKeyByPrefix: Record<number, string> = {};
    for (const label of canonicalCategories) {
      const p = numPrefix(label);
      if (p !== 999) canonicalKeyByPrefix[p] = label.toLowerCase().trim();
    }
    // Fold any data-driven variant that shares a prefix with a canonical into it
    for (const key of Object.keys(allCategoryFreq)) {
      const p = numPrefix(key);
      const canonKey = canonicalKeyByPrefix[p];
      if (canonKey && key !== canonKey) {
        if (!allCategoryFreq[canonKey]) allCategoryFreq[canonKey] = { count: 0, label: canonicalCategories[p - 1] };
        allCategoryFreq[canonKey].count += allCategoryFreq[key].count;
        delete allCategoryFreq[key];
      }
    }
    // Ensure all canonical categories always appear in the dropdown regardless of count
    for (const label of canonicalCategories) {
      const key = label.toLowerCase().trim();
      if (!allCategoryFreq[key]) {
        allCategoryFreq[key] = { count: minCategoryCount, label };
      } else {
        allCategoryFreq[key].label = label;
        allCategoryFreq[key].count = Math.max(allCategoryFreq[key].count, minCategoryCount);
      }
    }
    const allCategoryLabels = Object.values(allCategoryFreq)
      .filter(({ count, label }) => count >= minCategoryCount && !EXCLUDED_CATEGORY_PREFIXES.has(numPrefix(label)))
      .sort((a, b) => numPrefix(a.label) - numPrefix(b.label))
      .map(({ label }) => label);

    // ── Collect issue options grouped by canonical category ───────────────────
    // Strip leading "N. " from item labels so "1. Account Closure Requests" and
    // "Account Closure Requests" deduplicate to the same entry.  The numeric
    // order is preserved for sorting within each group.  A trailing 's' is also
    // stripped for the dedup key so singular/plural variants
    // ("Account Closure Request" vs "Account Closure Requests") collapse into
    // one entry; the most frequent variant wins as the display label.
    const stripItemNum = (s: string) => s.replace(/^\d+\.\s*/, '').trim();
    const itemNumOrder = (s: string) => { const m = s.match(/^(\d+)\./); return m ? parseInt(m[1], 10) : 999; };
    const normalizeIssueKey = (s: string) => s.toLowerCase().replace(/s$/, '');

    const minIssueCount = Math.max(2, Math.ceil(rows.length * 0.001));
    const allIssueFreq: Record<string, { label: string; catPrefix: number; order: number; count: number; labelCounts: Record<string, number> }> = {};
    for (const { item, category } of parsed.flatMap((p) => p.items)) {
      if (item === 'Unknown') continue;
      const clean = stripItemNum(item);
      if (!clean) continue;
      const key = normalizeIssueKey(clean);
      const ord = itemNumOrder(item);
      if (!allIssueFreq[key]) {
        allIssueFreq[key] = { label: clean, catPrefix: numPrefix(category), order: ord, count: 0, labelCounts: {} };
      } else if (ord < allIssueFreq[key].order) {
        allIssueFreq[key].order = ord; // keep lowest numeric position seen
      }
      allIssueFreq[key].count++;
      allIssueFreq[key].labelCounts[clean] = (allIssueFreq[key].labelCounts[clean] ?? 0) + 1;
      const [topLabel] = Object.entries(allIssueFreq[key].labelCounts).sort((a, b) => b[1] - a[1])[0];
      allIssueFreq[key].label = topLabel;
    }
    const qualifiedIssues = Object.values(allIssueFreq).filter(({ count }) => count >= minIssueCount);
    const groupedIssues = canonicalCategories
      .map((category) => {
        const pfx = numPrefix(category);
        const items = qualifiedIssues
          .filter((x) => x.catPrefix === pfx)
          .sort((a, b) => a.order !== b.order ? a.order - b.order : a.label.localeCompare(b.label))
          .map((x) => x.label);
        return { category, items };
      })
      .filter(({ items }) => items.length > 0);

    // ── Filter rows by category / issue (shared logic with drill-down) ────────
    // buildCategoryMatcher matches by exact key OR by numeric prefix — selecting
    // the canonical "1. Account Closure & Self-Exclusion Requests" also catches
    // AI variants like "1. Self-Exclusion Requests" that share the "1." prefix.
    // buildIssueMatcher normalises singular/plural, so both "Account Closure
    // Request" and "Account Closure Requests" collapse to the same key.
    const matchesCategory = buildCategoryMatcher(categories);
    const matchesIssue    = buildIssueMatcher(issues);
    const hasCategoryFilter = categories.length > 0;
    const hasIssueFilter    = issues.length > 0;

    let filteredRows   = hasCategoryFilter ? rows.filter((_, i) => parsed[i].categories.some((c) => matchesCategory(c))) : rows;
    let filteredParsed = hasCategoryFilter ? parsed.filter((p)  => p.categories.some((c) => matchesCategory(c))) : parsed;

    if (hasIssueFilter) {
      const keep = filteredParsed.map((p) => p.items.some((x) => matchesIssue(x.item)));
      filteredRows   = filteredRows.filter((_, i) => keep[i]);
      filteredParsed = filteredParsed.filter((_, i) => keep[i]);
    }

    const hasSeverityFilter = severities.length > 0;
    if (hasSeverityFilter) {
      const targets = new Set(severities.map((s) => normalizeSeverity(s)).filter((s): s is string => !!s));
      const keep = filteredParsed.map((p) => {
        const norm = normalizeSeverity(p.severity);
        return norm != null && targets.has(norm);
      });
      filteredRows   = filteredRows.filter((_, i) => keep[i]);
      filteredParsed = filteredParsed.filter((_, i) => keep[i]);
    }

    const hasResolutionFilter = resolutions.length > 0;
    if (hasResolutionFilter) {
      const targets = new Set(resolutions.map((r) => r.toLowerCase()));
      // Unknown/null is folded into Unresolved in the UI, so the Unresolved
      // filter must match both literal "unresolved" and missing/unknown values.
      const wantUnresolved = targets.has('unresolved');
      const keep = filteredParsed.map((p) => {
        const val = p.resolution_status?.trim().toLowerCase();
        if (!val || val === 'unknown') return wantUnresolved;
        return targets.has(val);
      });
      filteredRows   = filteredRows.filter((_, i) => keep[i]);
      filteredParsed = filteredParsed.filter((_, i) => keep[i]);
    }

    const hasLanguageFilter = languages.length > 0;
    if (hasLanguageFilter) {
      const targets = new Set(languages.map((l) => l.toLowerCase()));
      const wantUnknown = targets.has('unknown');
      const keep = filteredParsed.map((p) => {
        const lang = p.language?.trim().toLowerCase();
        if (!lang) return wantUnknown;
        return targets.has(lang);
      });
      filteredRows   = filteredRows.filter((_, i) => keep[i]);
      filteredParsed = filteredParsed.filter((_, i) => keep[i]);
    }

    // Segment: VIP / NON-VIP / SoftSwiss is derived from player groups +
    // attributes by getSegment, so it can only be applied in-memory after the
    // parse step.
    const hasSegmentFilter = segments.length > 0;
    if (hasSegmentFilter) {
      const targets = new Set(
        segments.map((s) => parseSegmentFilter(s)).filter((s): s is 'VIP' | 'NON-VIP' | 'SoftSwiss' => s != null),
      );
      const keep = filteredParsed.map((p) => p.segment != null && targets.has(p.segment));
      filteredRows   = filteredRows.filter((_, i) => keep[i]);
      filteredParsed = filteredParsed.filter((_, i) => keep[i]);
    }

    // VIP level: equality match against the precomputed (highest-wins) level so
    // a player tagged both L4 and L6 only appears under the L6 filter.
    const hasVipLevelFilter = vipLevels.length > 0;
    if (hasVipLevelFilter) {
      const targets = new Set(
        vipLevels.map((v) => parseVipLevelFilter(v)).filter((n): n is number => n != null),
      );
      const keep = filteredParsed.map((p) => p.vip_level != null && targets.has(p.vip_level));
      filteredRows   = filteredRows.filter((_, i) => keep[i]);
      filteredParsed = filteredParsed.filter((_, i) => keep[i]);
    }

    // ── Resolution breakdown ─────────────────────────────────────────────
    // Fold null/"Unknown" into "Unresolved" — the Unknown bucket was tiny
    // (single digits) and noisy, so we keep the chart clean by merging.
    const resolutionBreakdown = countBy(filteredParsed, (p) => {
      const v = p.resolution_status?.trim();
      if (!v || v.toLowerCase() === 'unknown') return 'Unresolved';
      return v;
    });

    // ── Severity breakdown ───────────────────────────────────────────────
    // The current prompt asks the AI for a numeric severity (0/1/2/3) only
    // when dissatisfaction is detected.  Conversations where the AI found no
    // dissatisfaction (empty results[] → severity null, rendered as "—") are
    // excluded from the chart entirely — counting them as "Unknown" inflated
    // the bucket with chats that have no dissatisfaction to measure.
    const SEVERITY_ORDER = ['Level 0', 'Level 1', 'Level 2', 'Level 3'];
    const severityCounts: Record<string, number> = { 'Level 0': 0, 'Level 1': 0, 'Level 2': 0, 'Level 3': 0 };
    for (const p of filteredParsed) {
      const label = normalizeSeverity(p.severity);
      if (!label) continue;
      severityCounts[label] = (severityCounts[label] ?? 0) + 1;
    }
    const severityBreakdown = SEVERITY_ORDER.map((label) => ({ label, count: severityCounts[label] ?? 0 }));

    // ── Language breakdown ───────────────────────────────────────────────
    const languageBreakdown = countBy(filteredParsed, (p) =>
      p.language ? p.language.toUpperCase() : null
    ).slice(0, 10);

    // ── Top issue categories ─────────────────────────────────────────────
    const allCategories = filteredParsed.flatMap((p) => p.categories);
    const categoryMap: Record<string, { count: number; label: string }> = {};
    for (const c of allCategories) {
      const key = c.toLowerCase().trim();
      if (!categoryMap[key]) categoryMap[key] = { count: 0, label: c };
      categoryMap[key].count++;
    }
    // Renamed UI-side to "Category Breakdown" — the spec asks for all
    // categories (no top-10 cap) since this widget lives in the lower
    // analytics section as a full breakdown.
    const topCategories = Object.values(categoryMap)
      .filter(({ label }) => !EXCLUDED_CATEGORY_PREFIXES.has(numPrefix(label)))
      .sort((a, b) => b.count - a.count)
      .map(({ label, count }) => ({ label, count }));

    // ── Top issue items ──────────────────────────────────────────────────
    // Strip leading "N. " and normalize singular/plural so duplicates like
    // "1. Account Closure Requests" / "Account Closure Requests" /
    // "Account Closure Request" collapse into a single row. Display the
    // most frequent de-numbered variant.
    const allItems = filteredParsed.flatMap((p) => p.items);
    const itemAgg: Record<string, { count: number; category: string; labelCounts: Record<string, number> }> = {};
    for (const { item, category } of allItems) {
      const clean = stripItemNum(item);
      if (!clean) continue;
      const key = normalizeIssueKey(clean);
      if (!itemAgg[key]) itemAgg[key] = { count: 0, category, labelCounts: {} };
      itemAgg[key].count++;
      itemAgg[key].labelCounts[clean] = (itemAgg[key].labelCounts[clean] ?? 0) + 1;
    }
    // Renamed UI-side to "Issues Breakdown" — the spec asks for the full
    // ordered list of issues (no top-10 cap). This is the last widget in the
    // lower analytics section, sized to handle long lists with internal scroll.
    const topItems = Object.values(itemAgg)
      .sort((a, b) => b.count - a.count)
      .map(({ count, category, labelCounts }) => {
        const [label] = Object.entries(labelCounts).sort((a, b) => b[1] - a[1])[0];
        return { label, count, category };
      });

    // ── Brand breakdown ──────────────────────────────────────────────────
    const brandBreakdown = countBy(
      filteredRows.filter((r) => (r.brand as string | null)?.toLowerCase() !== 'rooster partners'),
      (r) => (r.brand as string | null)
    ).slice(0, 15);

    // ── Agent breakdown ──────────────────────────────────────────────────
    const agentBreakdown = countBy(
      filteredRows,
      (r) => (r.agent_name as string | null)
    );

    // ── Escalation stats (Asana) ─────────────────────────────────────────
    // A "live" escalation is a conversation with an Asana task that hasn't been
    // deleted in Asana — same row set used by dbGetAsanaReportingMetrics so the
    // dashboard cards line up with the Report Page totals.
    // - Total/Resolved respect the global filters (date/brand/agent/AM) → scoped slice.
    // - Pending <24h / >24h are operational counters that ignore ALL filters → global slice.
    const escalatedRows = wantScoped
      ? filteredRows.filter((r) => r.asana_task_gid != null && r.asana_task_deleted_at == null)
      : [];
    const totalEscalations = escalatedRows.length;
    const resolvedEscalations = escalatedRows.filter((r) => r.asana_completed_at != null).length;
    const closureRate = totalEscalations > 0
      ? Math.round((resolvedEscalations / totalEscalations) * 100)
      : 0;

    // Unfiltered open-pending query — small payload, just enough to bucket by age.
    // Lives on the global slice since it ignores every dashboard filter and only
    // changes as Asana tasks are opened/closed.
    let pendingUnder24h = 0;
    let pendingOver24h = 0;
    if (wantGlobal) {
      const NOW_MS = Date.now();
      const DAY_MS = 24 * 60 * 60 * 1000;
      let pIdx = 0;
      while (true) {
        const { data: page } = await supabase
          .from('conversations')
          .select('analyzed_at')
          .not('asana_task_gid', 'is', null)
          .is('asana_task_deleted_at', null)
          .is('asana_completed_at', null)
          .order('analyzed_at', { ascending: false })
          .range(pIdx, pIdx + PAGE_SIZE - 1) as { data: Array<{ analyzed_at: string | null }> | null };
        if (!page || page.length === 0) break;
        for (const r of page) {
          const ageMs = r.analyzed_at ? NOW_MS - new Date(r.analyzed_at).getTime() : Infinity;
          if (ageMs < DAY_MS) pendingUnder24h += 1;
          else                pendingOver24h  += 1;
        }
        if (page.length < PAGE_SIZE) break;
        pIdx += PAGE_SIZE;
      }
    }

    // ── Top 5 Issue Spikes — fixed window, ignores all filters ───────────
    // Compares the two most recent COMPLETED UTC days (so today's partial day
    // is excluded). The bars in the UI are labelled "Today" (= the more recent
    // completed day) and "Yesterday" (= the day before). Per the spec this
    // widget is permanently fixed and never honours dateFrom/dateTo or any of
    // the brand/agent/segment/severity/category/issue filters — it's an
    // operational early-warning view of the last 24h vs the previous 24h.
    type IssueSpikeOut = { issue: string; today: number; yesterday: number };
    let issueSpikes: IssueSpikeOut[] = [];
    if (wantGlobal) {
      const utcStartOfToday = new Date();
      utcStartOfToday.setUTCHours(0, 0, 0, 0);
      const dayNStartUTC = new Date(utcStartOfToday); dayNStartUTC.setUTCDate(dayNStartUTC.getUTCDate() - 1);
      const dayNm1StartUTC = new Date(utcStartOfToday); dayNm1StartUTC.setUTCDate(dayNm1StartUTC.getUTCDate() - 2);
      const dayNStrISO = dayNStartUTC.toISOString().slice(0, 10);

      const spikeRows: Array<{ summary: string | null; intercom_created_at: string }> = [];
      let spikeFrom = 0;
      while (true) {
        const { data: page } = await supabase
          .from('conversations')
          .select('summary, intercom_created_at')
          .not('summary', 'is', null)
          .gte('intercom_created_at', dayNm1StartUTC.toISOString())
          .lt ('intercom_created_at', utcStartOfToday.toISOString())
          .order('intercom_created_at', { ascending: false })
          .range(spikeFrom, spikeFrom + PAGE_SIZE - 1) as {
            data: Array<{ summary: string | null; intercom_created_at: string }> | null;
          };
        if (!page || page.length === 0) break;
        spikeRows.push(...page);
        if (page.length < PAGE_SIZE) break;
        spikeFrom += PAGE_SIZE;
      }

      type SpikeAgg = { label: string; today: number; yesterday: number; labelCounts: Record<string, number> };
      const spikeAgg: Record<string, SpikeAgg> = {};
      for (const r of spikeRows) {
        const isDayN = r.intercom_created_at.slice(0, 10) === dayNStrISO;
        const summary = parseAnalysisSummary(r.summary);
        // Dedup per row: a single conversation flagging the same issue twice
        // shouldn't double-count — matches how topItems is computed.
        const seenKeys = new Set<string>();
        for (const it of summary.results) {
          const clean = stripItemNum(it.item ?? '');
          if (!clean) continue;
          const key = normalizeIssueKey(clean);
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          if (!spikeAgg[key]) spikeAgg[key] = { label: clean, today: 0, yesterday: 0, labelCounts: {} };
          if (isDayN) spikeAgg[key].today += 1;
          else        spikeAgg[key].yesterday += 1;
          spikeAgg[key].labelCounts[clean] = (spikeAgg[key].labelCounts[clean] ?? 0) + 1;
        }
      }
      issueSpikes = Object.values(spikeAgg)
        // Surface the issues with the biggest movement first — abs(delta) catches
        // both spikes (today >> yesterday) and drops (yesterday >> today). Ties
        // are broken by today's count so a busy issue beats a quiet one.
        .sort((a, b) => {
          const aDelta = Math.abs(a.today - a.yesterday);
          const bDelta = Math.abs(b.today - b.yesterday);
          if (aDelta !== bDelta) return bDelta - aDelta;
          return b.today - a.today;
        })
        .slice(0, 5)
        .map(({ today, yesterday, labelCounts }) => {
          const [bestLabel] = Object.entries(labelCounts).sort((a, b) => b[1] - a[1])[0];
          return { issue: bestLabel, today, yesterday };
        });
    }

    // ── Wider 30-day load: powers Weekly + Daily/Hourly Heat Maps and Trend ──
    // These widgets have time semantics independent of the global dateFrom/dateTo
    // (Weekly is fixed last 7 days, others default to 30 days), so they need
    // their own load. The actual fetch was kicked off at the top of the handler
    // so it overlaps with the main fetch + processing — here we just await the
    // resulting rows and dedupe by id (defensive, mirrors the main pipeline).
    type DissatisfactionTrendOut = {
      issues: string[];
      data: Array<Record<string, string | number>>;
    };
    type WeeklyIssueHeatmapOut = {
      days: { date: string; label: string }[];
      issues: { issue: string; counts: number[] }[];
    };
    type DailyHourlyIssueHeatmapOut = {
      dates: string[];
      cells: { date: string; hour: number; count: number }[];
    };
    let dissatisfactionTrend: DissatisfactionTrendOut = { issues: [], data: [] };
    let weeklyIssueHeatmap: WeeklyIssueHeatmapOut = { days: [], issues: [] };
    let dailyHourlyIssueHeatmap: DailyHourlyIssueHeatmapOut = { dates: [], cells: [] };

    if (wantGlobal && widerRowsPromise) {
      const widerDbRows = await widerRowsPromise;
      const seenWiderIds = new Set<string>();
      const widerRows = widerDbRows.filter((r) => {
        const id = r.id as string | undefined;
        if (!id || seenWiderIds.has(id)) return false;
        seenWiderIds.add(id);
        return true;
      });

      type WiderParsed = {
        iso: string;
        severity: string | null;
        language: string | null;
        vip_level: number | null;
        segment: 'VIP' | 'NON-VIP' | 'SoftSwiss' | null;
        categories: string[];
        items: { category: string; item: string }[];
      };
      const widerParsed: WiderParsed[] = widerRows.map((r) => {
      const summary = parseAnalysisSummary(r.summary as string | null);
      const playerAttrs = {
        player_tags:              (r.player_tags as string[] | null) ?? [],
        player_segments:          (r.player_segments as string[] | null) ?? [],
        player_companies:         (r.player_companies as { name: string }[] | null) ?? [],
        tags:                     (r.tags as string[] | null) ?? [],
        player_custom_attributes: (r.player_custom_attributes as Record<string, unknown> | null) ?? null,
      };
      return {
        iso: (r.intercom_created_at as string | null) ?? '',
        severity: (r.dissatisfaction_severity as string | null) ?? summary.dissatisfaction_severity ?? null,
        language: (r.language as string | null) ?? summary.language ?? null,
        vip_level: getVipLevelNum(playerAttrs),
        segment:   getSegment(playerAttrs),
        categories: summary.results.map((x) => displayCategory(x.category ?? 'Unknown')),
        items: summary.results.map((x) => ({ category: displayCategory(x.category ?? 'Unknown'), item: x.item ?? 'Unknown' })),
      };
    });

    // Apply the same in-memory filters the main pipeline does. Category/issue
    // are included because the spec says "all graphs must reflect only that
    // selection" when those filters are active.
    let widerFiltered = widerParsed;
    if (hasCategoryFilter) widerFiltered = widerFiltered.filter((p) => p.categories.some((c) => matchesCategory(c)));
    if (hasIssueFilter)    widerFiltered = widerFiltered.filter((p) => p.items.some((x) => matchesIssue(x.item)));
    if (hasSeverityFilter) {
      const targets = new Set(severities.map((s) => normalizeSeverity(s)).filter((s): s is string => !!s));
      widerFiltered = widerFiltered.filter((p) => {
        const norm = normalizeSeverity(p.severity);
        return norm != null && targets.has(norm);
      });
    }
    if (hasLanguageFilter) {
      const targets = new Set(languages.map((l) => l.toLowerCase()));
      const wantUnknown = targets.has('unknown');
      widerFiltered = widerFiltered.filter((p) => {
        const lang = p.language?.trim().toLowerCase();
        if (!lang) return wantUnknown;
        return targets.has(lang);
      });
    }
    if (hasSegmentFilter) {
      const targets = new Set(segments.map((s) => parseSegmentFilter(s)).filter((s): s is 'VIP' | 'NON-VIP' | 'SoftSwiss' => s != null));
      widerFiltered = widerFiltered.filter((p) => p.segment != null && targets.has(p.segment));
    }
    if (hasVipLevelFilter) {
      const targets = new Set(vipLevels.map((v) => parseVipLevelFilter(v)).filter((n): n is number => n != null));
      widerFiltered = widerFiltered.filter((p) => p.vip_level != null && targets.has(p.vip_level));
    }

    // ── Date axes for the wider widgets ──────────────────────────────────
    const days30: string[] = (() => {
      const out: string[] = [];
      const start = new Date(); start.setUTCHours(0, 0, 0, 0); start.setUTCDate(start.getUTCDate() - 29);
      const end   = new Date(); end.setUTCHours(0, 0, 0, 0);
      for (const cur = new Date(start); cur <= end; cur.setUTCDate(cur.getUTCDate() + 1)) {
        out.push(cur.toISOString().slice(0, 10));
      }
      return out;
    })();
    const days7 = days30.slice(-7);

    // ── Dissatisfaction Trend (top issues that cause dissatisfaction, 30d) ──
    // Only conversations with a non-null severity contribute (those flagged by
    // the AI as showing user dissatisfaction). We pick the top 3 issues from
    // the dissatisfied subset and emit per-day counts for each — matches the
    // 3-line line chart shown in the spec mockup.
    const dissatisfiedRows = widerFiltered.filter((p) => normalizeSeverity(p.severity) != null);
    const dissatisfactionIssueAgg: Record<string, { label: string; total: number; perDate: Record<string, number>; labelCounts: Record<string, number> }> = {};
    for (const p of dissatisfiedRows) {
      const dateStr = p.iso.slice(0, 10);
      if (!dateStr) continue;
      const seen = new Set<string>();
      for (const it of p.items) {
        if (it.item === 'Unknown') continue;
        const clean = stripItemNum(it.item);
        if (!clean) continue;
        const key = normalizeIssueKey(clean);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!dissatisfactionIssueAgg[key]) dissatisfactionIssueAgg[key] = { label: clean, total: 0, perDate: {}, labelCounts: {} };
        dissatisfactionIssueAgg[key].total += 1;
        dissatisfactionIssueAgg[key].perDate[dateStr] = (dissatisfactionIssueAgg[key].perDate[dateStr] ?? 0) + 1;
        dissatisfactionIssueAgg[key].labelCounts[clean] = (dissatisfactionIssueAgg[key].labelCounts[clean] ?? 0) + 1;
      }
    }
    const trendTopN = hasIssueFilter ? Object.keys(dissatisfactionIssueAgg).length : 3;
    const trendTopIssues = Object.values(dissatisfactionIssueAgg)
      .sort((a, b) => b.total - a.total)
      .slice(0, trendTopN)
      .map(({ labelCounts, perDate }) => {
        const [bestLabel] = Object.entries(labelCounts).sort((a, b) => b[1] - a[1])[0];
        return { issue: bestLabel, perDate };
      });
    const trendDataAllDays = days30.map((date) => {
      const row: Record<string, string | number> = { date };
      for (const t of trendTopIssues) row[t.issue] = t.perDate[date] ?? 0;
      return row;
    });
    // Trim leading dates where every series is zero. The 30-day window often
    // straddles the analysis cutoff (ANALYSIS_MIN_DATE_ISO), so the early
    // days have no data and rendering them creates a long flat segment.
    const firstNonZero = trendDataAllDays.findIndex((row) =>
      trendTopIssues.some((t) => (row[t.issue] as number) > 0),
    );
    dissatisfactionTrend = {
      issues: trendTopIssues.map((t) => t.issue),
      data: firstNonZero <= 0 ? trendDataAllDays : trendDataAllDays.slice(firstNonZero),
    };

    // ── Weekly Issue Heat Map (top 5 issues × last 7 days) ──────────────
    const weeklyAgg: Record<string, { label: string; total: number; perDate: Record<string, number>; labelCounts: Record<string, number> }> = {};
    const last7 = new Set(days7);
    for (const p of widerFiltered) {
      const dateStr = p.iso.slice(0, 10);
      if (!dateStr || !last7.has(dateStr)) continue;
      const seen = new Set<string>();
      for (const it of p.items) {
        if (it.item === 'Unknown') continue;
        const clean = stripItemNum(it.item);
        if (!clean) continue;
        const key = normalizeIssueKey(clean);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!weeklyAgg[key]) weeklyAgg[key] = { label: clean, total: 0, perDate: {}, labelCounts: {} };
        weeklyAgg[key].total += 1;
        weeklyAgg[key].perDate[dateStr] = (weeklyAgg[key].perDate[dateStr] ?? 0) + 1;
        weeklyAgg[key].labelCounts[clean] = (weeklyAgg[key].labelCounts[clean] ?? 0) + 1;
      }
    }
    const weeklyTopN = hasIssueFilter ? Object.keys(weeklyAgg).length : 5;
    const weeklyTop = Object.values(weeklyAgg)
      .sort((a, b) => b.total - a.total)
      .slice(0, weeklyTopN)
      .map(({ labelCounts, perDate }) => {
        const [bestLabel] = Object.entries(labelCounts).sort((a, b) => b[1] - a[1])[0];
        return {
          issue: bestLabel,
          counts: days7.map((d) => perDate[d] ?? 0),
        };
      });
    const dayOfWeekLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    weeklyIssueHeatmap = {
      days: days7.map((d) => ({
        date: d,
        label: dayOfWeekLabels[new Date(d + 'T00:00:00Z').getUTCDay()],
      })),
      issues: weeklyTop,
    };

    // ── Daily & Hourly Issue Heat Map (last 30 days × 24 hours) ────────
    // Top 5 issues over the 30-day window (or selected issues if filter active),
    // counts per (date, hour) summed across those issues at the conversation
    // level — a chat that flags multiple top-5 issues counts once per cell.
    const issueTotalAgg: Record<string, { total: number }> = {};
    for (const p of widerFiltered) {
      const seen = new Set<string>();
      for (const it of p.items) {
        if (it.item === 'Unknown') continue;
        const clean = stripItemNum(it.item);
        if (!clean) continue;
        const key = normalizeIssueKey(clean);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!issueTotalAgg[key]) issueTotalAgg[key] = { total: 0 };
        issueTotalAgg[key].total += 1;
      }
    }
    const dailyHourlyTopKeys = new Set(
      Object.entries(issueTotalAgg)
        .sort(([, a], [, b]) => b.total - a.total)
        .slice(0, hasIssueFilter ? Object.keys(issueTotalAgg).length : 5)
        .map(([k]) => k)
    );
    const dailyHourlyCells: Record<string, number> = {};
    for (const p of widerFiltered) {
      if (!p.iso) continue;
      const dateStr = p.iso.slice(0, 10);
      const hour = new Date(p.iso).getUTCHours();
      const flagsTop = p.items.some((it) => {
        if (it.item === 'Unknown') return false;
        const key = normalizeIssueKey(stripItemNum(it.item));
        return dailyHourlyTopKeys.has(key);
      });
      if (!flagsTop) continue;
      const cellKey = `${dateStr}|${hour}`;
      dailyHourlyCells[cellKey] = (dailyHourlyCells[cellKey] ?? 0) + 1;
    }
    const allDailyHourlyCells = Object.entries(dailyHourlyCells).map(([k, count]) => {
      const [date, hourStr] = k.split('|');
      return { date, hour: parseInt(hourStr, 10), count };
    });
    // Trim leading dates that have no cells at all — same reason as the
    // trend chart: the 30-day window straddles the analysis cutoff and
    // empty rows above the data make the grid look broken.
    const datesWithData = new Set(allDailyHourlyCells.map((c) => c.date));
    const firstDailyIdx = days30.findIndex((d) => datesWithData.has(d));
    dailyHourlyIssueHeatmap = {
      dates: firstDailyIdx <= 0 ? days30 : days30.slice(firstDailyIdx),
      cells: allDailyHourlyCells,
    };
    } // end if (wantGlobal && widerRowsPromise)

    // ── Conversations by date (scoped) ───────────────────────────────────────
    // When a category filter is active we can't use the DB RPC (it has no category
    // param), so we group the already-filtered in-memory rows by CEST date instead.
    // The RPC fast-path only takes a single brand/agent — when the user picks
    // multiple values for either, fall back to the in-memory aggregation so the
    // counts match the rest of the dashboard.
    // The conversations-by-date RPC accepts only single brand/agent and has no
    // country param, so any of these conditions force the in-memory fallback.
    const dbFiltersAreMulti = brands.length > 1 || agents.length > 1 || accountManagers.length > 1 || countries.length > 0;
    let conversationsByDate: { date: string; count: number }[] = [];
    if (wantScoped) {
      if (hasCategoryFilter || hasIssueFilter || hasSeverityFilter || hasLanguageFilter || hasSegmentFilter || hasVipLevelFilter || dbFiltersAreMulti) {
        const dateCounts: Record<string, number> = {};
        for (const r of filteredRows) {
          const iso = r.intercom_created_at as string | null;
          if (!iso) continue;
          const utcDate = new Date(iso).toISOString().slice(0, 10);
          dateCounts[utcDate] = (dateCounts[utcDate] ?? 0) + 1;
        }
        conversationsByDate = Object.entries(dateCounts)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, count]) => ({ date, count }));
      } else {
        // Bare ISO-day bounds for the RPC — it accepts nullable ISO timestamps and
        // interprets them as inclusive UTC day starts/ends, matching the semantics
        // applyConversationDbFilters uses for the gte/lt pair.
        const rpcFromISO = dateFrom ? new Date(dateFrom).toISOString() : null;
        const rpcToISO   = dateTo   ? (() => {
          const end = new Date(dateTo);
          end.setUTCDate(end.getUTCDate() + 1);
          end.setUTCMilliseconds(-1);
          return end.toISOString();
        })() : null;
        const { data: dateAgg } = await supabase.rpc('get_conversations_by_cest_date', {
          p_date_from: rpcFromISO,
          p_date_to:   rpcToISO,
          p_brand:     brands[0] ?? null,
          p_agent:     agents[0] ?? null,
        }) as { data: Array<{ cest_date: string; conversation_count: number }> | null };
        conversationsByDate = (dateAgg ?? []).map((r) => ({
          date:  r.cest_date,
          count: r.conversation_count,
        }));
      }

      // Limit to last 30 days when no dateFrom filter, and fill gaps with 0 through today (UTC)
      const todayUTC  = new Date().toISOString().slice(0, 10);
      const endDate   = dateTo && dateTo < todayUTC ? dateTo : todayUTC;
      const startDate = dateFrom
        ? (conversationsByDate[0]?.date ?? endDate)
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const countByDate = Object.fromEntries(conversationsByDate.map((d) => [d.date, d.count]));
      const filled: { date: string; count: number }[] = [];
      const start = new Date(startDate + 'T00:00:00Z');
      const end   = new Date(endDate   + 'T00:00:00Z');
      for (const cur = new Date(start); cur <= end; cur.setUTCDate(cur.getUTCDate() + 1)) {
        const key = cur.toISOString().slice(0, 10);
        filled.push({ date: key, count: countByDate[key] ?? 0 });
      }
      conversationsByDate = filled;
    }

    // ── Filter options (for dropdowns) ───────────────────────────────────
    // Brand/agent/country options are global — they index every conversation
    // in the DB and never change with the date filter, so they live on the
    // global slice and stay cached across date-only filter changes.
    let uniqueBrands: string[] = [];
    let uniqueAgents: string[] = [];
    let uniqueCountries: string[] = [];
    if (wantGlobal) {
      const [brandsRes, agentsRes, countriesRes] = await Promise.all([
        supabase.from('conversations').select('brand').not('brand', 'is', null),
        supabase.from('conversations').select('agent_name').not('agent_name', 'is', null),
        supabase.from('conversations').select('player_country').not('player_country', 'is', null),
      ]);
      const allBrands    = brandsRes.data    as Array<{ brand: string }> | null;
      const allAgents    = agentsRes.data    as Array<{ agent_name: string }> | null;
      const allCountries = countriesRes.data as Array<{ player_country: string }> | null;

      uniqueBrands = [...new Set((allBrands ?? []).map((r) => r.brand))].filter((b) => b?.toLowerCase() !== 'rooster partners').sort();
      uniqueAgents = [...new Set((allAgents ?? []).map((r) => r.agent_name))].sort();
      // Country values come straight from Intercom contact.location.country and
      // can have inconsistent casing ("Germany" vs "germany"); fold by lowercase
      // and pick the most common variant as the display label.
      const countryLabelByKey: Record<string, { label: string; count: number }> = {};
      for (const r of allCountries ?? []) {
        const raw = r.player_country?.trim();
        if (!raw) continue;
        const key = raw.toLowerCase();
        if (!countryLabelByKey[key]) countryLabelByKey[key] = { label: raw, count: 0 };
        countryLabelByKey[key].count += 1;
      }
      uniqueCountries = Object.values(countryLabelByKey)
        .map(({ label }) => label)
        .sort((a, b) => a.localeCompare(b));
    }

    // Language options are derived from the DB-filtered analyzed rows (same
    // scope the category/issue options use), so the dropdown reflects languages
    // that actually exist within the current brand/agent/date selection.
    let uniqueLanguages: string[] = [];
    if (wantScoped) {
      const languageFreq: Record<string, number> = {};
      for (const p of parsed) {
        const lang = p.language?.trim();
        if (!lang) continue;
        const key = lang.toUpperCase();
        languageFreq[key] = (languageFreq[key] ?? 0) + 1;
      }
      uniqueLanguages = Object.entries(languageFreq)
        .sort((a, b) => b[1] - a[1])
        .map(([label]) => label);
    }

    // ── Build response ───────────────────────────────────────────────────
    // Each slice writes its own keys; when both are requested (no `part` query
    // arg) the result is the legacy single-payload shape with `escalationStats`
    // including pending counters and `filterOptions` carrying every dropdown.
    const responseBody: Record<string, unknown> = {};
    const filterOptions: Record<string, unknown> = {};

    if (wantScoped) {
      // When a category filter is active, the DB-level counts are global (the RPC
      // has no category param).  Use the in-memory filtered counts instead so the
      // stat cards reflect what the charts show.
      const hasInMemoryFilter = hasCategoryFilter || hasIssueFilter || hasSeverityFilter || hasLanguageFilter || hasSegmentFilter || hasVipLevelFilter || dbFiltersAreMulti;
      const overviewAnalyzed  = hasInMemoryFilter ? filteredRows.length : analyzed;
      const overviewAlertWorthy = hasInMemoryFilter
        ? filteredRows.filter((r) => r.is_alert_worthy).length
        : alertWorthy;
      // "Total" and "Unanalyzed" require fetching non-analyzed rows we don't have;
      // fall back to the analyzed count so the numbers are coherent.
      const overviewTotal     = hasInMemoryFilter ? filteredRows.length : total;
      const overviewUnanalyzed = hasInMemoryFilter ? 0 : total - analyzed;

      responseBody.overview = {
        total:      overviewTotal,
        analyzed:   overviewAnalyzed,
        unanalyzed: overviewUnanalyzed,
        alertWorthy: overviewAlertWorthy,
        analyzedPct: overviewTotal > 0 ? Math.round((overviewAnalyzed / overviewTotal) * 100) : 0,
      };
      responseBody.escalationStats = {
        totalEscalations,
        resolved: resolvedEscalations,
        closureRate,
      };
      responseBody.resolutionBreakdown = resolutionBreakdown;
      responseBody.severityBreakdown   = severityBreakdown;
      responseBody.topCategories       = topCategories;
      responseBody.topItems            = topItems;
      responseBody.languageBreakdown   = languageBreakdown;
      responseBody.brandBreakdown      = brandBreakdown;
      responseBody.agentBreakdown      = agentBreakdown;
      responseBody.conversationsByDate = conversationsByDate;

      filterOptions.languages  = uniqueLanguages;
      filterOptions.categories = allCategoryLabels;
      filterOptions.issues     = groupedIssues;
    }

    if (wantGlobal) {
      responseBody.pendingEscalations    = { pendingUnder24h, pendingOver24h };
      responseBody.issueSpikes           = issueSpikes;
      responseBody.dissatisfactionTrend  = dissatisfactionTrend;
      responseBody.weeklyIssueHeatmap    = weeklyIssueHeatmap;
      responseBody.dailyHourlyIssueHeatmap = dailyHourlyIssueHeatmap;

      filterOptions.brands    = uniqueBrands;
      filterOptions.agents    = uniqueAgents;
      filterOptions.countries = uniqueCountries;
    }

    responseBody.filterOptions = filterOptions;

    // Legacy single-payload shape: when no `part` was requested, fold pending
    // counters into escalationStats so older clients keep working unchanged.
    if (!part && wantScoped && wantGlobal) {
      responseBody.escalationStats = {
        ...(responseBody.escalationStats as Record<string, unknown>),
        pendingUnder24h,
        pendingOver24h,
      };
      delete responseBody.pendingEscalations;
    }

    return NextResponse.json(responseBody);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
