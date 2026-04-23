import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase';
import { cestDateToUnixRange } from '@/lib/intercom';


function stripFences(text: string): string {
  return text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
}

function parseSummaryJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(stripFences(raw));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* not JSON */ }
  return null;
}

// Normalise "Category 1: Foo" → "1. Foo" so variant AI formats collapse to one entry
function normalizeCategory(label: string): string {
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

  try {
    // ── Build base query filters (dates interpreted in CEST / UTC+2) ────────
    const cestFromISO = dateFrom ? new Date(cestDateToUnixRange(dateFrom)[0] * 1000).toISOString() : null;
    const cestToISO   = dateTo   ? new Date(cestDateToUnixRange(dateTo)[1]   * 1000).toISOString() : null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applyFilters = (q: any) => {
      if (cestFromISO)    q = q.gte('intercom_created_at', cestFromISO);
      if (cestToISO)      q = q.lte('intercom_created_at', cestToISO);
      if (brand)          q = q.eq('brand', brand);
      if (agent)          q = q.eq('agent_name', agent);
      if (accountManager) {
        const lower = accountManager.toLowerCase();
        const amTags = lower === 'softswiss'
          ? ['group: softswiss🎲', 'group: softswiss dach', 'group: softswiss english', 'group: softswiss']
          : [`group: vip_${lower}🎲`, `group: non-vip_${lower}🎲`];
        const quotedTags = amTags.map((t: string) => `"${t}"`).join(',');
        q = q.or(`account_manager.eq.${accountManager},player_tags.ov.{${quotedTags}}`);
      }
      return q;
    };

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
      const { data: page } = await applyFilters(
        supabase
          .from('conversations')
          .select('summary, brand, agent_name, is_alert_worthy, intercom_created_at, language, resolution_status, dissatisfaction_severity')
          .not('summary', 'is', null)
          .range(from, from + PAGE_SIZE - 1)
      ) as { data: Array<Record<string, unknown>> | null };

      if (!page || page.length === 0) break;
      allAnalyzedRows.push(...page);
      if (page.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }

    const rows = allAnalyzedRows;

    // ── Parse summary JSON for fields not stored individually ────────────
    type Parsed = {
      resolution_status: string | null;
      language: string | null;
      severity: string | null;
      categories: string[];
      items: { category: string; item: string }[];
    };

    const parsed: Parsed[] = rows.map((r) => {
      const json = parseSummaryJson(r.summary as string | null);
      const results: { category?: string; item?: string }[] = Array.isArray(json?.results) ? json.results as { category?: string; item?: string }[] : [];
      return {
        resolution_status:
          (r.resolution_status as string | null) ??
          (json?.resolution_status as string | null) ?? null,
        language:
          (r.language as string | null) ??
          (json?.language as string | null) ?? null,
        severity:
          (r.dissatisfaction_severity as string | null) ??
          (json?.dissatisfaction_severity as string | null) ?? null,
        categories: results.map((x) => normalizeCategory(x.category ?? 'Unknown')),
        items: results.map((x) => ({ category: normalizeCategory(x.category ?? 'Unknown'), item: x.item ?? 'Unknown' })),
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
    // order is preserved for sorting within each group.
    const stripItemNum = (s: string) => s.replace(/^\d+\.\s*/, '').trim();
    const itemNumOrder = (s: string) => { const m = s.match(/^(\d+)\./); return m ? parseInt(m[1], 10) : 999; };

    const minIssueCount = Math.max(2, Math.ceil(rows.length * 0.001));
    const allIssueFreq: Record<string, { label: string; catPrefix: number; order: number; count: number }> = {};
    for (const { item, category } of parsed.flatMap((p) => p.items)) {
      if (item === 'Unknown') continue;
      const clean = stripItemNum(item);
      if (!clean) continue;
      const key = clean.toLowerCase();
      const ord = itemNumOrder(item);
      if (!allIssueFreq[key]) {
        allIssueFreq[key] = { label: clean, catPrefix: numPrefix(category), order: ord, count: 0 };
      } else if (ord < allIssueFreq[key].order) {
        allIssueFreq[key].order = ord; // keep lowest numeric position seen
      }
      allIssueFreq[key].count++;
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

    // ── Filter by category (in-memory, since categories live in summary JSON) ──
    // Match by exact key OR by numeric prefix so that selecting a canonical like
    // "1. Account Closure & Self-Exclusion Requests" also catches DB variants
    // like "1. Account Closure Requests" that share prefix 1.
    const categoryKeys = categories.map((c) => c.toLowerCase().trim());
    const categoryPrefixes = new Set(categoryKeys.map((k) => numPrefix(k)).filter((p) => p !== 999));
    const matchesCategory = (c: string) => {
      const ck = c.toLowerCase().trim();
      return categoryKeys.includes(ck) || categoryPrefixes.has(numPrefix(ck));
    };

    // ── Filter by issue item (strip "N. " prefix before comparing) ────────────
    const issueKeys = issues.map((i) => stripItemNum(i).toLowerCase());
    const matchesIssue = (item: string) => issueKeys.includes(stripItemNum(item).toLowerCase());

    let filteredRows   = categoryKeys.length > 0 ? rows.filter((_, i) => parsed[i].categories.some((c) => matchesCategory(c))) : rows;
    let filteredParsed = categoryKeys.length > 0 ? parsed.filter((p)  => p.categories.some((c) => matchesCategory(c))) : parsed;

    if (issueKeys.length > 0) {
      const keep = filteredParsed.map((p) => p.items.some((x) => matchesIssue(x.item)));
      filteredRows   = filteredRows.filter((_, i) => keep[i]);
      filteredParsed = filteredParsed.filter((_, i) => keep[i]);
    }

    // ── Resolution breakdown ─────────────────────────────────────────────
    const resolutionBreakdown = countBy(filteredParsed, (p) => p.resolution_status);

    // ── Severity breakdown ───────────────────────────────────────────────
    const severityBreakdown = countBy(filteredParsed, (p) => p.severity);

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
    if (categoryKeys.length > 0 || issueKeys.length > 0) {
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
      const { data: dateAgg } = await supabase.rpc('get_conversations_by_cest_date', {
        p_date_from: cestFromISO ?? null,
        p_date_to:   cestToISO   ?? null,
        p_brand:     brand       ?? null,
        p_agent:     agent       ?? null,
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
    const hasInMemoryFilter = categoryKeys.length > 0 || issueKeys.length > 0;
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
