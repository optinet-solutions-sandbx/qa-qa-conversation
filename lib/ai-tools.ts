/**
 * Ask AI — RAG tools.
 *
 * Defines the fixed set of bounded queries the AI can call.
 * No free-form SQL. Every tool:
 *   - requires a date range (intercom_created_at is indexed)
 *   - caps row returns at 20
 *   - targets indexed/low-cardinality columns only
 *
 * Implementations rely on the three Postgres RPC functions:
 *   conv_group_count, agent_leaderboard, stats_summary
 */

import { supabase } from './supabase';

// ── Types ────────────────────────────────────────────────────────────────

export interface ToolCallResult {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  error?: string;
}

// ── Date helpers ─────────────────────────────────────────────────────────

/** Validates YYYY-MM-DD, returns [startISO, endISO] covering the full day range in UTC */
function parseDateRange(start: string, end: string): [string, string] {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(start) || !re.test(end)) {
    throw new Error('Dates must be YYYY-MM-DD');
  }
  return [
    new Date(`${start}T00:00:00Z`).toISOString(),
    new Date(`${end}T23:59:59Z`).toISOString(),
  ];
}

function clampLimit(n: unknown, max = 20, fallback = 10): number {
  const x = typeof n === 'number' ? n : parseInt(String(n ?? fallback), 10);
  if (!Number.isFinite(x) || x <= 0) return fallback;
  return Math.min(x, max);
}

// ── Tool implementations ─────────────────────────────────────────────────

async function getStatsSummary({ start_date, end_date }: { start_date: string; end_date: string }) {
  const [startISO, endISO] = parseDateRange(start_date, end_date);
  const { data, error } = await supabase.rpc('stats_summary', { p_start: startISO, p_end: endISO });
  if (error) throw new Error(error.message);
  return data?.[0] ?? { total_conversations: 0, analyzed_count: 0, alert_count: 0, avg_rating: null };
}

async function groupCount(
  column: string,
  { start_date, end_date, limit }: { start_date: string; end_date: string; limit?: number },
) {
  const [startISO, endISO] = parseDateRange(start_date, end_date);
  const { data, error } = await supabase.rpc('conv_group_count', {
    p_column: column,
    p_start: startISO,
    p_end: endISO,
    p_limit: clampLimit(limit),
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function agentLeaderboard({
  start_date, end_date, metric = 'rating', limit,
}: { start_date: string; end_date: string; metric?: 'rating' | 'performance'; limit?: number }) {
  const [startISO, endISO] = parseDateRange(start_date, end_date);
  const { data, error } = await supabase.rpc('agent_leaderboard', {
    p_start: startISO,
    p_end: endISO,
    p_metric: metric === 'performance' ? 'performance' : 'rating',
    p_limit: clampLimit(limit, 20, 10),
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function alertWorthyConversations({
  start_date, end_date, limit,
}: { start_date: string; end_date: string; limit?: number }) {
  const [startISO, endISO] = parseDateRange(start_date, end_date);
  const { data, error } = await supabase
    .from('conversations')
    .select('id, intercom_id, title, player_name, intercom_created_at, alert_reason, issue_category, dissatisfaction_severity')
    .eq('is_alert_worthy', true)
    .gte('intercom_created_at', startISO)
    .lte('intercom_created_at', endISO)
    .order('intercom_created_at', { ascending: false })
    .limit(clampLimit(limit));
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function recentUnresolved({
  start_date, end_date, limit,
}: { start_date: string; end_date: string; limit?: number }) {
  const [startISO, endISO] = parseDateRange(start_date, end_date);
  const { data, error } = await supabase
    .from('conversations')
    .select('id, intercom_id, title, player_name, intercom_created_at, issue_category, summary')
    .eq('resolution_status', 'Unresolved')
    .gte('intercom_created_at', startISO)
    .lte('intercom_created_at', endISO)
    .order('intercom_created_at', { ascending: false })
    .limit(clampLimit(limit));
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function sampleAiSummaries({
  start_date, end_date, limit,
}: { start_date: string; end_date: string; limit?: number }) {
  const [startISO, endISO] = parseDateRange(start_date, end_date);
  const { data, error } = await supabase
    .from('conversations')
    .select('title, player_name, summary, issue_category, resolution_status, dissatisfaction_severity, intercom_created_at')
    .not('summary', 'is', null)
    .gte('intercom_created_at', startISO)
    .lte('intercom_created_at', endISO)
    .order('intercom_created_at', { ascending: false })
    .limit(clampLimit(limit, 10, 5));
  if (error) throw new Error(error.message);
  return data ?? [];
}

// ── Tool registry ────────────────────────────────────────────────────────

type ToolFn = (args: Record<string, unknown>) => Promise<unknown>;

export const tools: Record<string, ToolFn> = {
  get_stats_summary:            (a) => getStatsSummary(a as { start_date: string; end_date: string }),
  top_issue_categories:         (a) => groupCount('issue_category', a as { start_date: string; end_date: string; limit?: number }),
  top_query_types:              (a) => groupCount('query_type', a as { start_date: string; end_date: string; limit?: number }),
  resolution_breakdown:         (a) => groupCount('resolution_status', a as { start_date: string; end_date: string; limit?: number }),
  sentiment_breakdown:          (a) => groupCount('sentiment', a as { start_date: string; end_date: string; limit?: number }),
  severity_breakdown:           (a) => groupCount('dissatisfaction_severity', a as { start_date: string; end_date: string; limit?: number }),
  brand_breakdown:              (a) => groupCount('brand', a as { start_date: string; end_date: string; limit?: number }),
  language_breakdown:           (a) => groupCount('language', a as { start_date: string; end_date: string; limit?: number }),
  agent_performance_leaderboard:(a) => agentLeaderboard(a as { start_date: string; end_date: string; metric?: 'rating' | 'performance'; limit?: number }),
  alert_worthy_conversations:   (a) => alertWorthyConversations(a as { start_date: string; end_date: string; limit?: number }),
  recent_unresolved:            (a) => recentUnresolved(a as { start_date: string; end_date: string; limit?: number }),
  sample_ai_summaries:          (a) => sampleAiSummaries(a as { start_date: string; end_date: string; limit?: number }),
};

// ── OpenAI tool schemas (function-calling format) ────────────────────────

const dateRange = {
  start_date: { type: 'string', description: 'Start date in YYYY-MM-DD format (inclusive)' },
  end_date:   { type: 'string', description: 'End date in YYYY-MM-DD format (inclusive)' },
};
const dateRangeReq = ['start_date', 'end_date'];

const limitProp = { type: 'integer', description: 'Max rows to return (1-20). Default 10.', minimum: 1, maximum: 20 };

export const toolSchemas = [
  {
    type: 'function',
    function: {
      name: 'get_stats_summary',
      description: 'Overall totals for a date range: total conversations, how many were analyzed, alert count, and average CSAT rating.',
      parameters: { type: 'object', properties: { ...dateRange }, required: dateRangeReq, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'top_issue_categories',
      description: 'Most frequent issue categories (from analyzed conversations) in a date range. Use for "what are the top issues/concerns/problems".',
      parameters: { type: 'object', properties: { ...dateRange, limit: limitProp }, required: dateRangeReq, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'top_query_types',
      description: 'Most frequent query types (billing, technical, etc.) in a date range.',
      parameters: { type: 'object', properties: { ...dateRange, limit: limitProp }, required: dateRangeReq, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resolution_breakdown',
      description: 'Counts by resolution status (Resolved, Partially Resolved, Unresolved) in a date range.',
      parameters: { type: 'object', properties: { ...dateRange }, required: dateRangeReq, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sentiment_breakdown',
      description: 'Counts by customer sentiment (positive/negative/neutral) in a date range.',
      parameters: { type: 'object', properties: { ...dateRange }, required: dateRangeReq, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'severity_breakdown',
      description: 'Counts by dissatisfaction severity (Low/Medium/High/Critical) in a date range.',
      parameters: { type: 'object', properties: { ...dateRange }, required: dateRangeReq, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'brand_breakdown',
      description: 'Conversation counts per brand in a date range.',
      parameters: { type: 'object', properties: { ...dateRange }, required: dateRangeReq, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'language_breakdown',
      description: 'Conversation counts per detected language in a date range.',
      parameters: { type: 'object', properties: { ...dateRange }, required: dateRangeReq, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agent_performance_leaderboard',
      description: 'Top agents ranked by average customer rating (metric=rating) or AI-judged performance score (metric=performance). Only includes agents with at least 3 conversations in the date range. Use for "best agent", "worst agent", "top performing agents".',
      parameters: {
        type: 'object',
        properties: {
          ...dateRange,
          metric: { type: 'string', enum: ['rating', 'performance'], description: "'rating' uses customer CSAT score, 'performance' uses AI-judged agent performance score. Default 'rating'." },
          limit: limitProp,
        },
        required: dateRangeReq,
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'alert_worthy_conversations',
      description: 'Recent alert-worthy conversations (flagged by AI as needing attention) in a date range.',
      parameters: { type: 'object', properties: { ...dateRange, limit: limitProp }, required: dateRangeReq, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recent_unresolved',
      description: 'Recent conversations with Unresolved resolution status in a date range.',
      parameters: { type: 'object', properties: { ...dateRange, limit: limitProp }, required: dateRangeReq, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sample_ai_summaries',
      description: 'Returns recent AI-generated conversation summaries (up to 10). Use when the user asks open-ended "what are customers saying / complaining about" questions and you need qualitative context beyond counts.',
      parameters: { type: 'object', properties: { ...dateRange, limit: { ...limitProp, maximum: 10 } }, required: dateRangeReq, additionalProperties: false },
    },
  },
] as const;

// ── Executor ─────────────────────────────────────────────────────────────

export async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  const fn = tools[name];
  if (!fn) return { tool: name, args, result: null, error: `Unknown tool: ${name}` };
  try {
    const result = await fn(args);
    return { tool: name, args, result };
  } catch (e) {
    return { tool: name, args, result: null, error: (e as Error).message };
  }
}
