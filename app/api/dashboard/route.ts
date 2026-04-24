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
// Query params: dateFrom, dateTo, brand, agent, category

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const dateFrom       = searchParams.get('dateFrom');
  const dateTo         = searchParams.get('dateTo');
  const brand          = searchParams.get('brand');
  const agent          = searchParams.get('agent');
  const accountManager = searchParams.get('accountManager');
  const categories     = searchParams.getAll('category');
  const issues         = searchParams.getAll('issue');
  const severity       = searchParams.get('severity');

  try {
    // Shared DB-level filter — the exact same helper is used by the drill-down
    // in lib/db.ts, which is what keeps the overview counts and the drill-down
    // list counts in lock-step.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applyFilters = (q: any) => applyConversationDbFilters(q, {
      dateFrom, dateTo, brand, agent, accountManager,
    });

    // ── Overview counts ──────────────────────────────────────────────────
    const [totalRes, analyzedRes, alertRes] = await Promise.all([
      applyFilters(supabase.from('conversations').select('*', { count: 'exact', head: true })),
      applyFilters(supabase.from('conversations').select('*', { count: 'exact', head: true }).not('summary', 'is', null)),
      applyFilters(supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('is_alert_worthy', true)),
    ]);

    const total      = totalRes.count    ?? 0;
    const analyzed   = analyzedRes.count ?? 0;
    const alertWorthy = alertRes.count   ?? 0;

    // ── Analyzed conversations (paginated to bypass 1000-row default limit) ──
    const PAGE_SIZE = 1000;
    const allAnalyzedRows: Array<Record<string, unknown>> = [];
    let from = 0;

    while (true) {
      // Same explicit order the drill-down uses — without ORDER BY, Postgres
      // offset pagination across separate HTTP requests can skip or duplicate
      // rows, which was a plausible source of past dashboard/drill-down count
      // drift.
      const { data: page } = await applyFilters(
        supabase
          .from('conversations')
          .select('id, summary, brand, agent_name, is_alert_worthy, intercom_created_at, language, resolution_status, dissatisfaction_severity')
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
      categories: string[];
      items: { category: string; item: string }[];
    };

    const parsed: Parsed[] = rows.map((r) => {
      const summary = parseAnalysisSummary(r.summary as string | null);
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

    const hasSeverityFilter = !!severity;
    if (hasSeverityFilter) {
      const target = normalizeSeverity(severity);
      const keep = filteredParsed.map((p) => normalizeSeverity(p.severity) === target);
      filteredRows   = filteredRows.filter((_, i) => keep[i]);
      filteredParsed = filteredParsed.filter((_, i) => keep[i]);
    }

    // ── Resolution breakdown ─────────────────────────────────────────────
    const resolutionBreakdown = countBy(filteredParsed, (p) => p.resolution_status);

    // ── Severity breakdown ───────────────────────────────────────────────
    // The current prompt asks the AI for a numeric severity (1/2/3).  We
    // normalise raw values to "Level 1/2/3" so variants like "1", "Level 1",
    // or numeric JSON values all bucket together, and render an explicit
    // "Unknown" bucket for everything else (legacy Low/Medium/High/Critical
    // from older prompts, nulls, or values the AI didn't emit).  The 1/2/3
    // buckets always appear on the chart even at zero count so the breakdown
    // stays readable while the backlog re-analyses.
    const SEVERITY_ORDER = ['Level 1', 'Level 2', 'Level 3', 'Unknown'];
    const severityCounts: Record<string, number> = { 'Level 1': 0, 'Level 2': 0, 'Level 3': 0, Unknown: 0 };
    for (const p of filteredParsed) {
      const label = normalizeSeverity(p.severity) ?? 'Unknown';
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
    const topCategories = Object.values(categoryMap)
      .filter(({ label }) => !EXCLUDED_CATEGORY_PREFIXES.has(numPrefix(label)))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map(({ label, count }) => ({ label, count }));

    // ── Top issue items ──────────────────────────────────────────────────
    const allItems = filteredParsed.flatMap((p) => p.items);
    const itemMap: Record<string, { count: number; label: string; category: string }> = {};
    for (const { item, category } of allItems) {
      const key = item.toLowerCase().trim();
      if (!itemMap[key]) itemMap[key] = { count: 0, label: item, category };
      itemMap[key].count++;
    }
    const topItems = Object.values(itemMap)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map(({ label, count, category }) => ({ label, count, category }));

    // ── Brand breakdown ──────────────────────────────────────────────────
    const brandBreakdown = countBy(
      filteredRows.filter((r) => (r.brand as string | null)?.toLowerCase() !== 'rooster partners'),
      (r) => (r.brand as string | null)
    ).slice(0, 15);

    // ── Agent breakdown ──────────────────────────────────────────────────
    const agentBreakdown = countBy(
      filteredRows,
      (r) => (r.agent_name as string | null)
    ).slice(0, 15);

    // ── Conversations by date ────────────────────────────────────────────────
    // When a category filter is active we can't use the DB RPC (it has no category
    // param), so we group the already-filtered in-memory rows by CEST date instead.
    let conversationsByDate: { date: string; count: number }[];
    if (hasCategoryFilter || hasIssueFilter || hasSeverityFilter) {
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
        p_brand:     brand ?? null,
        p_agent:     agent ?? null,
      }) as { data: Array<{ cest_date: string; conversation_count: number }> | null };
      conversationsByDate = (dateAgg ?? []).map((r) => ({
        date:  r.cest_date,
        count: r.conversation_count,
      }));
    }

    // Limit to last 30 days when no dateFrom filter, and fill gaps with 0 through today (UTC)
    {
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
    const { data: allBrands } = await supabase
      .from('conversations')
      .select('brand')
      .not('brand', 'is', null) as { data: Array<{ brand: string }> | null };

    const { data: allAgents } = await supabase
      .from('conversations')
      .select('agent_name')
      .not('agent_name', 'is', null) as { data: Array<{ agent_name: string }> | null };

    const uniqueBrands = [...new Set((allBrands ?? []).map((r) => r.brand))].filter((b) => b?.toLowerCase() !== 'rooster partners').sort();
    const uniqueAgents = [...new Set((allAgents ?? []).map((r) => r.agent_name))].sort();

    // When a category filter is active, the DB-level counts are global (the RPC
    // has no category param).  Use the in-memory filtered counts instead so the
    // stat cards reflect what the charts show.
    const hasInMemoryFilter = hasCategoryFilter || hasIssueFilter || hasSeverityFilter;
    const overviewAnalyzed  = hasInMemoryFilter ? filteredRows.length  : analyzed;
    const overviewAlertWorthy = hasInMemoryFilter
      ? filteredRows.filter((r) => r.is_alert_worthy).length
      : alertWorthy;
    // "Total" and "Unanalyzed" require fetching non-analyzed rows we don't have;
    // fall back to the analyzed count so the numbers are coherent.
    const overviewTotal     = hasInMemoryFilter ? filteredRows.length  : total;
    const overviewUnanalyzed = hasInMemoryFilter ? 0 : total - analyzed;

    return NextResponse.json({
      overview: {
        total:      overviewTotal,
        analyzed:   overviewAnalyzed,
        unanalyzed: overviewUnanalyzed,
        alertWorthy: overviewAlertWorthy,
        analyzedPct: overviewTotal > 0 ? Math.round((overviewAnalyzed / overviewTotal) * 100) : 0,
      },
      resolutionBreakdown,
      severityBreakdown,
      topCategories,
      topItems,
      languageBreakdown,
      brandBreakdown,
      agentBreakdown,
      conversationsByDate,
      filterOptions: {
        brands: uniqueBrands,
        agents: uniqueAgents,
        categories: allCategoryLabels,
        issues: groupedIssues,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
