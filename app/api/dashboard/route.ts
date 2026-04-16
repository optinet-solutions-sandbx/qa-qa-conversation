import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase';
import { cestDateToUnixRange } from '@/lib/intercom';

// ── Helpers ────────────────────────────────────────────────────────────────

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

function countBy<T>(items: T[], key: (item: T) => string | null): { label: string; count: number }[] {
  const map: Record<string, number> = {};
  for (const item of items) {
    const k = key(item) ?? 'Unknown';
    map[k] = (map[k] ?? 0) + 1;
  }
  return Object.entries(map)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

// ── GET /api/dashboard ─────────────────────────────────────────────────────
// Query params: dateFrom, dateTo, brand, agent

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const dateFrom = searchParams.get('dateFrom');
  const dateTo   = searchParams.get('dateTo');
  const brand    = searchParams.get('brand');
  const agent    = searchParams.get('agent');

  try {
    // ── Build base query filters (dates interpreted in CEST / UTC+2) ────────
    const cestFromISO = dateFrom ? new Date(cestDateToUnixRange(dateFrom)[0] * 1000).toISOString() : null;
    const cestToISO   = dateTo   ? new Date(cestDateToUnixRange(dateTo)[1]   * 1000).toISOString() : null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applyFilters = (q: any) => {
      if (cestFromISO) q = q.gte('intercom_created_at', cestFromISO);
      if (cestToISO)   q = q.lte('intercom_created_at', cestToISO);
      if (brand)       q = q.eq('brand', brand);
      if (agent)       q = q.eq('agent_name', agent);
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

    // ── Analyzed conversations (lightweight — only needed fields) ────────
    const { data: analyzedRows } = await applyFilters(
      supabase
        .from('conversations')
        .select('summary, brand, agent_name, is_alert_worthy, intercom_created_at, language, resolution_status, dissatisfaction_severity')
        .not('summary', 'is', null)
    ) as { data: Array<Record<string, unknown>> | null };

    const rows = analyzedRows ?? [];

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
        categories: results.map((x) => x.category ?? 'Unknown'),
        items: results.map((x) => ({ category: x.category ?? 'Unknown', item: x.item ?? 'Unknown' })),
      };
    });

    // ── Resolution breakdown ─────────────────────────────────────────────
    const resolutionBreakdown = countBy(parsed, (p) => p.resolution_status);

    // ── Severity breakdown ───────────────────────────────────────────────
    const severityBreakdown = countBy(parsed, (p) => p.severity);

    // ── Language breakdown ───────────────────────────────────────────────
    const languageBreakdown = countBy(parsed, (p) =>
      p.language ? p.language.toUpperCase() : null
    ).slice(0, 10);

    // ── Top issue categories ─────────────────────────────────────────────
    const allCategories = parsed.flatMap((p) => p.categories);
    const categoryMap: Record<string, number> = {};
    for (const c of allCategories) { categoryMap[c] = (categoryMap[c] ?? 0) + 1; }
    const topCategories = Object.entries(categoryMap)
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // ── Top issue items ──────────────────────────────────────────────────
    const allItems = parsed.flatMap((p) => p.items);
    const itemMap: Record<string, { count: number; category: string }> = {};
    for (const { item, category } of allItems) {
      if (!itemMap[item]) itemMap[item] = { count: 0, category };
      itemMap[item].count++;
    }
    const topItems = Object.entries(itemMap)
      .map(([label, { count, category }]) => ({ label, count, category }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // ── Brand breakdown ──────────────────────────────────────────────────
    const brandBreakdown = countBy(
      rows,
      (r) => (r.brand as string | null)
    ).slice(0, 15);

    // ── Agent breakdown ──────────────────────────────────────────────────
    const agentBreakdown = countBy(
      rows,
      (r) => (r.agent_name as string | null)
    ).slice(0, 15);

    // ── Conversations by date (grouped in DB via RPC — no row-limit issue) ──
    const { data: dateAgg } = await supabase.rpc('get_conversations_by_cest_date', {
      p_date_from: cestFromISO ?? null,
      p_date_to:   cestToISO   ?? null,
      p_brand:     brand       ?? null,
      p_agent:     agent       ?? null,
    }) as { data: Array<{ cest_date: string; conversation_count: number }> | null };

    const conversationsByDate = (dateAgg ?? []).map((r) => ({
      date:  r.cest_date,
      count: r.conversation_count,
    }));

    // ── Filter options (for dropdowns) ───────────────────────────────────
    const { data: allBrands } = await supabase
      .from('conversations')
      .select('brand')
      .not('brand', 'is', null) as { data: Array<{ brand: string }> | null };

    const { data: allAgents } = await supabase
      .from('conversations')
      .select('agent_name')
      .not('agent_name', 'is', null) as { data: Array<{ agent_name: string }> | null };

    const uniqueBrands = [...new Set((allBrands ?? []).map((r) => r.brand))].sort();
    const uniqueAgents = [...new Set((allAgents ?? []).map((r) => r.agent_name))].sort();

    return NextResponse.json({
      overview: {
        total,
        analyzed,
        unanalyzed: total - analyzed,
        alertWorthy,
        analyzedPct: total > 0 ? Math.round((analyzed / total) * 100) : 0,
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
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
