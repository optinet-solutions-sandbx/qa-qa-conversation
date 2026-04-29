import { supabase } from './supabase';
import type { Conversation, ConversationNote, PromptVersion, AnalysisRun, SyncJob, BatchJob, BatchJobStatus, AiQuery, RawMessage } from './types';
import { cestDateToUnixRange } from './intercom';
import {
  parseAnalysisSummary,
  buildCategoryMatcher,
  buildIssueMatcher,
  applyConversationDbFilters,
  normalizeSeverity,
} from './analyticsFilters';
import { getVipLevelNum, parseVipLevelFilter } from './utils';

// ── Shared row mapper ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapConversationRow(c: Record<string, any>, notes: ConversationNote[] = []): Conversation {
  return {
    id: c.id,
    title: c.title,
    analyzed_at: c.analyzed_at ?? new Date().toISOString(),
    intercom_id: c.intercom_id ?? null,
    intercom_created_at: c.intercom_created_at ?? null,
    player_name: c.player_name ?? null,
    player_email: c.player_email ?? null,
    player_id: c.player_id ?? null,
    player_external_id: c.player_external_id ?? null,
    player_phone: c.player_phone ?? null,
    player_tags: c.player_tags ?? [],
    player_signed_up_at: c.player_signed_up_at ?? null,
    player_last_seen_at: c.player_last_seen_at ?? null,
    player_last_replied_at: c.player_last_replied_at ?? null,
    player_last_contacted_at: c.player_last_contacted_at ?? null,
    player_country: c.player_country ?? null,
    player_city: c.player_city ?? null,
    player_browser: c.player_browser ?? null,
    player_os: c.player_os ?? null,
    player_custom_attributes: c.player_custom_attributes ?? null,
    player_companies: c.player_companies ?? [],
    player_segments: c.player_segments ?? [],
    player_event_summaries: c.player_event_summaries ?? [],
    agent_name: c.agent_name ?? null,
    agent_email: c.agent_email ?? null,
    is_bot_handled: c.is_bot_handled ?? false,
    brand: c.brand ?? null,
    tags: c.tags ?? [],
    query_type: c.query_type ?? null,
    ai_subject: c.ai_subject ?? null,
    ai_issue_summary: c.ai_issue_summary ?? null,
    cx_score_rating: c.cx_score_rating ?? null,
    cx_score_explanation: c.cx_score_explanation ?? null,
    conversation_rating_score: c.conversation_rating_score ?? null,
    conversation_rating_remark: c.conversation_rating_remark ?? null,
    time_to_assignment: c.time_to_assignment ?? null,
    time_to_admin_reply: c.time_to_admin_reply ?? null,
    time_to_first_close: c.time_to_first_close ?? null,
    median_time_to_reply: c.median_time_to_reply ?? null,
    count_reopens: c.count_reopens ?? null,
    sentiment: c.sentiment ?? null,
    summary: c.summary ?? null,
    dissatisfaction_severity: c.dissatisfaction_severity ?? null,
    issue_category: c.issue_category ?? null,
    resolution_status: c.resolution_status ?? null,
    language: c.language ?? parseAnalysisSummary(c.summary).language ?? null,
    agent_performance_score: c.agent_performance_score ?? null,
    agent_performance_notes: c.agent_performance_notes ?? null,
    key_quotes: c.key_quotes ?? null,
    recommended_action: c.recommended_action ?? null,
    is_alert_worthy: c.is_alert_worthy ?? false,
    alert_reason: c.alert_reason ?? null,
    account_manager: c.account_manager ?? null,
    original_text: c.original_text ?? null,
    raw_messages: c.raw_messages ?? null,
    raw_messages_translated: c.raw_messages_translated ?? null,
    last_prompt_id: c.last_prompt_id ?? null,
    last_prompt_content: c.last_prompt_content ?? null,
    asana_task_gid: c.asana_task_gid ?? null,
    notes,
  };
}

// ── Conversations ──────────────────────────────────────────────────────────

function conversationRow(c: Conversation) {
  return {
    id: c.id,
    title: c.title,
    analyzed_at: c.analyzed_at,

    intercom_id: c.intercom_id,
    intercom_created_at: c.intercom_created_at,

    player_name: c.player_name,
    player_email: c.player_email,
    player_id: c.player_id,
    player_external_id: c.player_external_id,
    player_phone: c.player_phone,
    player_tags: c.player_tags,

    player_signed_up_at: c.player_signed_up_at,
    player_last_seen_at: c.player_last_seen_at,
    player_last_replied_at: c.player_last_replied_at,
    player_last_contacted_at: c.player_last_contacted_at,

    player_country: c.player_country,
    player_city: c.player_city,
    player_browser: c.player_browser,
    player_os: c.player_os,

    player_custom_attributes: c.player_custom_attributes,
    player_companies: c.player_companies,
    player_segments: c.player_segments,
    player_event_summaries: c.player_event_summaries,

    agent_name: c.agent_name,
    agent_email: c.agent_email,
    is_bot_handled: c.is_bot_handled,

    brand: c.brand,
    tags: c.tags,
    query_type: c.query_type,
    ai_subject: c.ai_subject,
    ai_issue_summary: c.ai_issue_summary,
    cx_score_rating: c.cx_score_rating != null ? Math.round(c.cx_score_rating) : null,
    cx_score_explanation: c.cx_score_explanation,
    conversation_rating_score: c.conversation_rating_score != null ? Math.round(c.conversation_rating_score) : null,
    conversation_rating_remark: c.conversation_rating_remark,

    time_to_assignment: c.time_to_assignment != null ? Math.round(c.time_to_assignment) : null,
    time_to_admin_reply: c.time_to_admin_reply != null ? Math.round(c.time_to_admin_reply) : null,
    time_to_first_close: c.time_to_first_close != null ? Math.round(c.time_to_first_close) : null,
    median_time_to_reply: c.median_time_to_reply != null ? Math.round(c.median_time_to_reply) : null,
    count_reopens: c.count_reopens != null ? Math.round(c.count_reopens) : null,

    sentiment: c.sentiment,
    summary: c.summary,
    dissatisfaction_severity: c.dissatisfaction_severity,
    issue_category: c.issue_category,
    resolution_status: c.resolution_status,
    language: c.language,
    agent_performance_score: c.agent_performance_score,
    agent_performance_notes: c.agent_performance_notes,
    key_quotes: c.key_quotes,
    recommended_action: c.recommended_action,
    is_alert_worthy: c.is_alert_worthy,
    alert_reason: c.alert_reason,
    account_manager: c.account_manager,

    original_text: c.original_text,
    raw_messages: c.raw_messages ?? null,
    raw_messages_translated: c.raw_messages_translated ?? null,
    last_prompt_id: c.last_prompt_id,
    last_prompt_content: c.last_prompt_content,
    asana_task_gid: c.asana_task_gid ?? null,
  };
}

export async function dbInsertConversation(c: Conversation): Promise<void> {
  const { error } = await supabase.from('conversations').insert(conversationRow(c));
  if (error) {
    // Unique constraint violation on intercom_id — another row already exists, update it instead
    if (error.code === '23505' && c.intercom_id) {
      await dbUpdateConversationByIntercomId(c);
      return;
    }
    throw new Error(`[db] insert conversation: ${error.message} (code: ${error.code}, details: ${error.details})`);
  }
}

export async function dbUpdateConversation(c: Conversation): Promise<void> {
  const { id, ...row } = conversationRow(c);
  const { error } = await supabase.from('conversations').update(row).eq('id', id);
  if (error) throw new Error(`[db] update conversation: ${error.message}`);
}

export async function dbUpdateConversationByIntercomId(c: Conversation): Promise<void> {
  if (!c.intercom_id) throw new Error('[db] update by intercom_id: missing intercom_id');
  // Only update Intercom-sourced fields — never overwrite AI analysis results
  const { error } = await supabase.from('conversations').update({
    intercom_created_at: c.intercom_created_at,
    title: c.title,
    player_name: c.player_name,
    player_email: c.player_email,
    player_id: c.player_id,
    player_external_id: c.player_external_id,
    player_phone: c.player_phone,
    player_tags: c.player_tags,
    player_signed_up_at: c.player_signed_up_at,
    player_last_seen_at: c.player_last_seen_at,
    player_last_replied_at: c.player_last_replied_at,
    player_last_contacted_at: c.player_last_contacted_at,
    player_country: c.player_country,
    player_city: c.player_city,
    player_browser: c.player_browser,
    player_os: c.player_os,
    player_custom_attributes: c.player_custom_attributes,
    player_companies: c.player_companies,
    player_segments: c.player_segments,
    player_event_summaries: c.player_event_summaries,
    agent_name: c.agent_name,
    agent_email: c.agent_email,
    is_bot_handled: c.is_bot_handled,
    brand: c.brand,
    tags: c.tags,
    query_type: c.query_type,
    ai_subject: c.ai_subject,
    ai_issue_summary: c.ai_issue_summary,
    cx_score_rating: c.cx_score_rating != null ? Math.round(c.cx_score_rating) : null,
    cx_score_explanation: c.cx_score_explanation,
    conversation_rating_score: c.conversation_rating_score != null ? Math.round(c.conversation_rating_score) : null,
    conversation_rating_remark: c.conversation_rating_remark,
    time_to_assignment: c.time_to_assignment != null ? Math.round(c.time_to_assignment) : null,
    time_to_admin_reply: c.time_to_admin_reply != null ? Math.round(c.time_to_admin_reply) : null,
    time_to_first_close: c.time_to_first_close != null ? Math.round(c.time_to_first_close) : null,
    median_time_to_reply: c.median_time_to_reply != null ? Math.round(c.median_time_to_reply) : null,
    count_reopens: c.count_reopens != null ? Math.round(c.count_reopens) : null,
    account_manager: c.account_manager,
    original_text: c.original_text,
    raw_messages: c.raw_messages ?? null,
  }).eq('intercom_id', c.intercom_id);
  if (error) throw new Error(`[db] update conversation by intercom_id: ${error.message}`);
}

export async function dbUpdateTranslatedMessages(
  id: string,
  translated: RawMessage[],
): Promise<void> {
  const { error } = await supabase
    .from('conversations')
    .update({ raw_messages_translated: translated })
    .eq('id', id);
  if (error) throw new Error(`[db] update translated messages (${id}): ${error.message}`);
}

export async function dbDeleteConversation(id: string): Promise<void> {
  // Delete analysis runs first (no FK cascade configured)
  await supabase.from('analysis_runs').delete().eq('conversation_id', id);
  const { error } = await supabase.from('conversations').delete().eq('id', id);
  if (error) throw new Error(`[db] delete conversation: ${error.message}`);
}

// ── Notes ──────────────────────────────────────────────────────────────────

export async function dbInsertNote(convId: string, note: ConversationNote): Promise<void> {
  try {
    const { error } = await supabase.from('conversation_notes').insert({
      id: note.id,
      conversation_id: convId,
      author: note.author,
      text: note.text,
      is_system: note.system,
      created_at: note.ts,
    });
    if (error) console.error('[db] insert note:', error.message);
  } catch (e) {
    console.error('[db] insert note exception:', e);
  }
}

export async function dbUpdateNote(note: ConversationNote): Promise<void> {
  try {
    const { error } = await supabase
      .from('conversation_notes')
      .update({ text: note.text })
      .eq('id', note.id);
    if (error) console.error('[db] update note:', error.message);
  } catch (e) {
    console.error('[db] update note exception:', e);
  }
}

export async function dbDeleteNote(id: string): Promise<void> {
  try {
    const { error } = await supabase.from('conversation_notes').delete().eq('id', id);
    if (error) console.error('[db] delete note:', error.message);
  } catch (e) {
    console.error('[db] delete note exception:', e);
  }
}

// ── Prompts ────────────────────────────────────────────────────────────────

export async function dbInsertPrompt(p: PromptVersion): Promise<void> {
  try {
    const { error } = await supabase.from('prompts').insert({
      id: p.id,
      title: p.title,
      content: p.content,
      is_active: p.is_active,
      created_at: p.created_at,
      updated_at: p.updated_at,
    });
    if (error) console.error('[db] insert prompt:', error.message);
  } catch (e) {
    console.error('[db] insert prompt exception:', e);
  }
}

export async function dbUpdatePrompt(p: PromptVersion): Promise<void> {
  try {
    const { error } = await supabase.from('prompts').update({
      title: p.title,
      content: p.content,
      is_active: p.is_active,
      updated_at: new Date().toISOString(),
    }).eq('id', p.id);
    if (error) console.error('[db] update prompt:', error.message);
  } catch (e) {
    console.error('[db] update prompt exception:', e);
  }
}

export async function dbDeletePrompt(id: string): Promise<void> {
  try {
    const { error } = await supabase.from('prompts').delete().eq('id', id);
    if (error) console.error('[db] delete prompt:', error.message);
  } catch (e) {
    console.error('[db] delete prompt exception:', e);
  }
}

export async function dbActivatePrompt(id: string): Promise<void> {
  try {
    // Deactivate all, then activate target
    await supabase.from('prompts').update({ is_active: false, updated_at: new Date().toISOString() }).neq('id', '');
    const { error } = await supabase.from('prompts').update({ is_active: true, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) console.error('[db] activate prompt:', error.message);
  } catch (e) {
    console.error('[db] activate prompt exception:', e);
  }
}

// ── Analysis Runs ──────────────────────────────────────────────────────────

export async function dbInsertAnalysisRun(run: AnalysisRun): Promise<void> {
  const { error } = await supabase.from('analysis_runs').insert(run);
  if (error) throw new Error(`[db] insert analysis run: ${error.message} (code: ${error.code})`);
}

export async function dbDeleteAnalysisRun(id: string): Promise<void> {
  const { error } = await supabase.from('analysis_runs').delete().eq('id', id);
  if (error) throw new Error(`[db] delete analysis run: ${error.message}`);
}

export async function getConversationMetadataBatch(
  ids: string[],
): Promise<Map<string, { title: string | null; player_name: string | null }>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase
    .from('conversations')
    .select('id, title, player_name')
    .in('id', ids);
  if (error) return new Map();
  return new Map(
    (data ?? []).map((r) => [r.id, { title: r.title ?? null, player_name: r.player_name ?? null }]),
  );
}

export async function getExistingIntercomIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { data, error } = await supabase
    .from('conversations')
    .select('intercom_id')
    .in('intercom_id', ids);
  if (error) throw new Error(`[db] getExistingIntercomIds: ${error.message}`);
  return new Set((data ?? []).map((r) => r.intercom_id).filter(Boolean));
}

export async function loadAnalysisRuns(page = 0, perPage = 25): Promise<{ runs: AnalysisRun[]; total: number }> {
  const from = page * perPage;
  const to = from + perPage - 1;
  const { data, error, count } = await supabase
    .from('analysis_runs')
    .select('*', { count: 'exact' })
    .order('analyzed_at', { ascending: false })
    .range(from, to);
  if (error) throw new Error(`[db] load analysis runs: ${error.message}`);
  return { runs: (data ?? []) as AnalysisRun[], total: count ?? 0 };
}

export async function loadConversationsByDate(
  date: string,
  page = 0,
  perPage = 25,
  search = '',
): Promise<{ conversations: Conversation[]; total: number }> {
  const [startUnix, endUnix] = cestDateToUnixRange(date);
  const startISO = new Date(startUnix * 1000).toISOString();
  const endISO   = new Date(endUnix   * 1000).toISOString();

  let query = supabase
    .from('conversations')
    .select('*', { count: 'exact' })
    .gte('intercom_created_at', startISO)
    .lte('intercom_created_at', endISO)
    .order('intercom_created_at', { ascending: false })
    .range(page * perPage, page * perPage + perPage - 1);

  if (search.trim()) {
    query = query.or(
      `player_name.ilike.%${search}%,brand.ilike.%${search}%,query_type.ilike.%${search}%,title.ilike.%${search}%,player_email.ilike.%${search}%`
    );
  }

  const { data, error, count } = await query;
  if (error) throw new Error(`[db] loadConversationsByDate: ${error.message}`);
  return {
    conversations: (data ?? []).map((c) => mapConversationRow(c)),
    total: count ?? 0,
  };
}

export async function getConversationById(id: string): Promise<Conversation | null> {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('id', id)
    .single();
  if (error || !data) return null;
  return mapConversationRow(data);
}

export interface ConversationFilters {
  resolution_status?: string;
  dissatisfaction_severity?: string;
  issue_category?: string;
  issue_item?: string;
  language?: string;
  brand?: string;
  agent_name?: string;
  account_manager?: string;
  vip_level?: string;
  dateFrom?: string;
  dateTo?: string;
  analyzed?: boolean;
  alert_worthy?: boolean;
}

// vip_level isn't stored as a column — it's derived from player_tags /
// player_segments / player_companies, so it has to be filtered in-memory the
// same way the JSON-summary filters are. Routing it through the JSON-filter
// path is what keeps that filtering off the simple loadConversations path.
export function needsJsonFilter(filters: ConversationFilters): boolean {
  return !!(filters.resolution_status || filters.dissatisfaction_severity ||
            filters.issue_category    || filters.issue_item || filters.language ||
            filters.vip_level);
}

export async function loadConversations(
  page = 0,
  perPage = 24,
  filters: ConversationFilters = {},
): Promise<{ conversations: Conversation[]; total: number }> {
  const from = page * perPage;
  const to = from + perPage - 1;
  let query = supabase
    .from('conversations')
    .select('*', { count: 'exact' })
    .order('intercom_created_at', { ascending: false })
    .range(from, to);

  query = applyConversationDbFilters(query, {
    dateFrom:       filters.dateFrom,
    dateTo:         filters.dateTo,
    brand:          filters.brand,
    agent:          filters.agent_name,
    accountManager: filters.account_manager,
  });
  if (filters.analyzed === true)     query = query.not('summary', 'is', null);
  if (filters.analyzed === false)    query = query.is('summary', null);
  if (filters.alert_worthy === true) query = query.eq('is_alert_worthy', true);

  const { data, error, count } = await query;
  if (error) throw new Error(`[db] loadConversations: ${error.message}`);
  return {
    conversations: (data ?? []).map((c) => mapConversationRow(c)),
    total: count ?? 0,
  };
}

// Builds a Supabase query with only the DB-level filters (brand, agent, dates, alert_worthy).
// Returns a fresh builder each call — safe to chain .range() onto.  Uses the same
// shared helper as the dashboard route so both paths see the same base row set.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildJsonFilterBaseQuery(fields: string, filters: ConversationFilters): any {
  let q = supabase
    .from('conversations')
    .select(fields)
    .not('summary', 'is', null)
    // Secondary id sort makes pagination deterministic — without a tiebreaker,
    // rows with identical intercom_created_at can be split across pages in
    // unstable order, silently dropping or duplicating rows.
    .order('intercom_created_at', { ascending: false })
    .order('id', { ascending: false });

  q = applyConversationDbFilters(q, {
    dateFrom:       filters.dateFrom,
    dateTo:         filters.dateTo,
    brand:          filters.brand,
    agent:          filters.agent_name,
    accountManager: filters.account_manager,
  });
  if (filters.alert_worthy === true) q = q.eq('is_alert_worthy', true);
  return q;
}

// Used when filters include fields stored only inside the summary JSON
// (resolution_status, dissatisfaction_severity, language, issue_category).
// Step 1: fetch id + summary for all matching rows, filter in JS (mirrors dashboard).
// Step 2: fetch full rows only for the current page of matched IDs.
export async function loadConversationsWithJsonFilter(
  page = 0,
  perPage = 24,
  filters: ConversationFilters = {},
): Promise<{ conversations: Conversation[]; total: number }> {
  const DB_PAGE = 1000;

  // ── Step 1: fetch only id + summary (lightweight) ──────────────────────
  // When a vip_level filter is active we also pull the group/attribute fields
  // needed by getVipLevelNum so we can match in-memory below.
  type Slim = {
    id: string;
    summary: string | null;
    player_tags?: string[] | null;
    player_segments?: string[] | null;
    player_companies?: { name: string }[] | null;
    tags?: string[] | null;
    player_custom_attributes?: Record<string, unknown> | null;
  };
  const slimFields = filters.vip_level
    ? 'id, summary, player_tags, player_segments, player_companies, tags, player_custom_attributes'
    : 'id, summary';
  const slimById = new Map<string, Slim>();
  let offset = 0;
  while (true) {
    const { data, error } = await buildJsonFilterBaseQuery(slimFields, filters)
      .range(offset, offset + DB_PAGE - 1);
    if (error) throw new Error(`[db] loadConversationsWithJsonFilter (slim): ${error.message}`);
    if (!data || data.length === 0) break;
    // Defensive dedup by id — mirrors the dashboard route so both paths cannot
    // diverge on pagination quirks that occasionally hand back the same row
    // across adjacent pages.
    for (const r of data as Slim[]) slimById.set(r.id, r);
    if (data.length < DB_PAGE) break;
    offset += DB_PAGE;
  }
  const allSlim: Slim[] = [...slimById.values()];

  // ── Step 2: apply JSON filters in memory ────────────────────────────────
  // Parse each summary once so every sub-filter reuses the same parsed shape.
  // Using parseAnalysisSummary here — the same parser the dashboard route uses —
  // is what guarantees the drill-down and the dashboard see identical data.
  const parsedRows = allSlim.map((r) => ({ row: r, summary: parseAnalysisSummary(r.summary) }));
  let filtered = parsedRows;

  if (filters.resolution_status) {
    const v = filters.resolution_status.toLowerCase();
    filtered = filtered.filter(({ summary }) => {
      const val = summary.resolution_status?.trim();
      return v === 'unknown' ? !val : val?.toLowerCase() === v;
    });
  }

  if (filters.dissatisfaction_severity) {
    // Match against the normalised severity so a "Level 1" filter from the
    // dashboard matches rows whose raw stored value is "1", "Level 1", or
    // any other variant the AI has produced.  "Unknown" captures anything
    // that does not normalise to a 1/2/3 level, including legacy
    // Low/Medium/High/Critical values and rows with no severity at all.
    const filterNorm = normalizeSeverity(filters.dissatisfaction_severity);
    const filterIsUnknown = filters.dissatisfaction_severity.toLowerCase() === 'unknown' || !filterNorm;
    filtered = filtered.filter(({ summary }) => {
      const rowNorm = normalizeSeverity(summary.dissatisfaction_severity);
      return filterIsUnknown ? !rowNorm : rowNorm === filterNorm;
    });
  }

  if (filters.language) {
    const v = filters.language.toLowerCase();
    filtered = filtered.filter(({ summary }) => {
      const lang = summary.language?.trim();
      return v === 'unknown' ? !lang : lang?.toLowerCase() === v;
    });
  }

  if (filters.issue_category) {
    // Same matcher the dashboard uses for its filteredRows count.
    const matcher = buildCategoryMatcher([filters.issue_category]);
    filtered = filtered.filter(({ summary }) => summary.results.some((x) => matcher(x.category)));
  }

  if (filters.issue_item) {
    const matcher = buildIssueMatcher([filters.issue_item]);
    filtered = filtered.filter(({ summary }) => summary.results.some((x) => matcher(x.item)));
  }

  if (filters.vip_level) {
    // The user's "highest level wins" rule lives inside getVipLevelNum, so
    // equality against the parsed filter value is the right semantics here:
    // a player tagged both L4 and L6 only matches when filtering for L6.
    const target = parseVipLevelFilter(filters.vip_level);
    if (target != null) {
      filtered = filtered.filter(({ row }) => getVipLevelNum({
        player_tags:              row.player_tags ?? [],
        player_segments:          row.player_segments ?? [],
        player_companies:         row.player_companies ?? [],
        tags:                     row.tags ?? [],
        player_custom_attributes: row.player_custom_attributes ?? null,
      }) === target);
    } else {
      filtered = [];
    }
  }

  const total = filtered.length;
  const pageIds = filtered
    .slice(page * perPage, (page + 1) * perPage)
    .map(({ row }) => row.id);

  if (pageIds.length === 0) return { conversations: [], total };

  // ── Step 3: fetch full rows only for the current page ───────────────────
  const { data: fullRows, error: fullError } = await supabase
    .from('conversations')
    .select('*')
    .in('id', pageIds)
    .order('intercom_created_at', { ascending: false });

  if (fullError) throw new Error(`[db] loadConversationsWithJsonFilter (full): ${fullError.message}`);
  return {
    conversations: (fullRows ?? []).map((c) => mapConversationRow(c)),
    total,
  };
}

export async function loadAnalysisRun(id: string): Promise<AnalysisRun | null> {
  const { data, error } = await supabase
    .from('analysis_runs')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return null;
  return data as AnalysisRun;
}

// ── Batch jobs ─────────────────────────────────────────────────────────────
//
// Required Supabase table (run once in the dashboard):
//
// CREATE TABLE batch_jobs (
//   id                    TEXT PRIMARY KEY,
//   openai_batch_id       TEXT,
//   openai_file_id        TEXT,
//   output_file_id        TEXT,
//   status                TEXT NOT NULL DEFAULT 'pending',
//   prompt_id             TEXT,
//   prompt_content        TEXT,
//   chunk_index           INT  DEFAULT 0,
//   total_chunks          INT  DEFAULT 1,
//   total_conversations   INT  DEFAULT 0,
//   completed_conversations INT DEFAULT 0,
//   failed_conversations  INT  DEFAULT 0,
//   imported_count        INT  DEFAULT 0,
//   error_message         TEXT,
//   created_at            TIMESTAMPTZ DEFAULT NOW(),
//   submitted_at          TIMESTAMPTZ,
//   completed_at          TIMESTAMPTZ
// );

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapBatchJobRow(r: Record<string, any>): BatchJob {
  return {
    id: r.id,
    openai_batch_id: r.openai_batch_id ?? null,
    openai_file_id: r.openai_file_id ?? null,
    output_file_id: r.output_file_id ?? null,
    status: (r.status ?? 'pending') as BatchJobStatus,
    prompt_id: r.prompt_id ?? null,
    prompt_content: r.prompt_content ?? null,
    chunk_index: r.chunk_index ?? 0,
    total_chunks: r.total_chunks ?? 1,
    total_conversations: r.total_conversations ?? 0,
    completed_conversations: r.completed_conversations ?? 0,
    failed_conversations: r.failed_conversations ?? 0,
    imported_count: r.imported_count ?? 0,
    error_message: r.error_message ?? null,
    created_at: r.created_at,
    submitted_at: r.submitted_at ?? null,
    completed_at: r.completed_at ?? null,
  };
}

export async function dbInsertBatchJob(job: BatchJob): Promise<void> {
  const { error } = await supabase.from('batch_jobs').insert({
    id: job.id,
    openai_batch_id: job.openai_batch_id,
    openai_file_id: job.openai_file_id,
    output_file_id: job.output_file_id,
    status: job.status,
    prompt_id: job.prompt_id,
    prompt_content: job.prompt_content,
    chunk_index: job.chunk_index,
    total_chunks: job.total_chunks,
    total_conversations: job.total_conversations,
    completed_conversations: job.completed_conversations,
    failed_conversations: job.failed_conversations,
    imported_count: job.imported_count,
    error_message: job.error_message,
    submitted_at: job.submitted_at,
    completed_at: job.completed_at,
  });
  if (error) throw new Error(`[db] insert batch job: ${error.message}`);
}

export async function dbUpdateBatchJob(id: string, fields: Partial<BatchJob>): Promise<void> {
  const { error } = await supabase.from('batch_jobs').update(fields).eq('id', id);
  if (error) throw new Error(`[db] update batch job: ${error.message}`);
}

export async function dbGetBatchJobs(): Promise<BatchJob[]> {
  const { data, error } = await supabase
    .from('batch_jobs')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`[db] get batch jobs: ${error.message}`);
  return (data ?? []).map(mapBatchJobRow);
}

export async function dbGetBatchJobById(id: string): Promise<BatchJob | null> {
  const { data, error } = await supabase
    .from('batch_jobs')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return null;
  return mapBatchJobRow(data);
}

// Minimal row shape used to build Batch API JSONL without loading full conversations
export interface MinimalConversation {
  id: string;
  intercom_id: string | null;
  player_name: string | null;
  player_email: string | null;
  agent_name: string | null;
  brand: string | null;
  original_text: string | null;
}

export async function dbGetActivePrompt(): Promise<PromptVersion | null> {
  const { data, error } = await supabase
    .from('prompts')
    .select('*')
    .eq('is_active', true)
    .limit(1)
    .single();
  if (error || !data) return null;
  return {
    id: data.id,
    title: data.title ?? 'Untitled',
    content: data.content ?? '',
    is_active: data.is_active ?? true,
    created_at: data.created_at,
    updated_at: data.updated_at ?? data.created_at,
  };
}

export async function getUnanalyzedConversationsByDate(date: string): Promise<MinimalConversation[]> {
  const [startUnix, endUnix] = cestDateToUnixRange(date);
  const startISO = new Date(startUnix * 1000).toISOString();
  const endISO   = new Date(endUnix   * 1000).toISOString();
  const { data, error } = await supabase
    .from('conversations')
    .select('id, intercom_id, player_name, player_email, agent_name, brand, original_text')
    .is('summary', null)
    .not('original_text', 'is', null)
    .gte('intercom_created_at', startISO)
    .lte('intercom_created_at', endISO);
  if (error) throw new Error(`[db] getUnanalyzedConversationsByDate: ${error.message}`);
  return (data ?? []) as MinimalConversation[];
}

// Returns a count only — no data transfer, used to pre-check before heavy work.
// Optional fromDate/toDate (ISO strings) scope the count to a window of
// intercom_created_at — used when a partial re-analysis is targeted at a date
// range instead of the full backlog.
export async function countUnanalyzedConversations(
  filter?: { fromDate?: string; toDate?: string },
): Promise<number> {
  let query = supabase
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .is('summary', null)
    .not('original_text', 'is', null);
  if (filter?.fromDate) query = query.gte('intercom_created_at', filter.fromDate);
  if (filter?.toDate)   query = query.lte('intercom_created_at', filter.toDate);
  const { count, error } = await query;
  if (error) throw new Error(`[db] count unanalyzed conversations: ${error.message}`);
  return count ?? 0;
}

// Fetches one page of unanalyzed conversations — used by the batch POST handler
// so it can process 10k rows at a time instead of loading the full dataset at once.
// Optional fromDate/toDate scope to a window of intercom_created_at.
export async function getUnanalyzedConversationsPage(
  from: number,
  limit: number,
  filter?: { fromDate?: string; toDate?: string },
): Promise<MinimalConversation[]> {
  // Oldest first by Intercom creation time so a backlog clears in date order
  // (April 27 fully analyzed before 28, before 29). `id` is a random cuid and
  // does not correlate with chronology. The `id` tiebreaker keeps pagination
  // stable when many rows share the same intercom_created_at.
  let query = supabase
    .from('conversations')
    .select('id, intercom_id, player_name, player_email, agent_name, brand, original_text')
    .is('summary', null)
    .not('original_text', 'is', null)
    .order('intercom_created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(from, from + limit - 1);
  if (filter?.fromDate) query = query.gte('intercom_created_at', filter.fromDate);
  if (filter?.toDate)   query = query.lte('intercom_created_at', filter.toDate);
  const { data, error } = await query;
  if (error) throw new Error(`[db] get unanalyzed conversations page: ${error.message}`);
  return (data ?? []) as MinimalConversation[];
}

// Writes only the AI analysis fields — does NOT overwrite Intercom metadata
export async function dbUpdateAnalysisFields(
  id: string,
  fields: {
    summary: string;
    last_prompt_id: string | null;
    last_prompt_content: string | null;
    analyzed_at: string;
  }
): Promise<void> {
  const { error } = await supabase
    .from('conversations')
    .update(fields)
    .eq('id', id);
  if (error) throw new Error(`[db] update analysis fields (${id}): ${error.message}`);
}

// Batch version: runs all conversation updates concurrently to avoid
// thousands of sequential round trips during import.
export async function dbBatchUpdateAnalysisFields(
  rows: Array<{
    id: string;
    summary: string;
    last_prompt_id: string | null;
    last_prompt_content: string | null;
    analyzed_at: string;
  }>
): Promise<void> {
  await Promise.all(
    rows.map(({ id, ...fields }) =>
      supabase.from('conversations').update(fields).eq('id', id).then(({ error }) => {
        if (error) throw new Error(`[db] update analysis fields (${id}): ${error.message}`);
      })
    )
  );
}

// Batch insert for analysis_runs — single DB round trip instead of one per row.
export async function dbBatchInsertAnalysisRuns(runs: import('@/lib/types').AnalysisRun[]): Promise<void> {
  if (runs.length === 0) return;
  const { error } = await supabase.from('analysis_runs').insert(runs);
  if (error) throw new Error(`[db] batch insert analysis runs: ${error.message} (code: ${error.code})`);
}

// ── Asana ticket linkage ───────────────────────────────────────────────────
// Severity-3 analysis results push a task into Asana via lib/asana.ts; the
// returned gid is stored here so re-analysis of the same conversation does
// not duplicate the ticket.

export interface AsanaConversationContext {
  id: string;
  intercom_id: string | null;
  player_name: string | null;
  player_email: string | null;
  agent_name: string | null;
  agent_email: string | null;
  brand: string | null;
  account_manager: string | null;
  asana_task_gid: string | null;
}

export async function dbGetAsanaConversationContext(
  id: string,
): Promise<AsanaConversationContext | null> {
  const { data, error } = await supabase
    .from('conversations')
    .select('id, intercom_id, player_name, player_email, agent_name, agent_email, brand, account_manager, asana_task_gid')
    .eq('id', id)
    .single();
  if (error || !data) return null;
  return data as AsanaConversationContext;
}

export async function dbUpdateAsanaTaskGid(id: string, gid: string): Promise<void> {
  const { error } = await supabase
    .from('conversations')
    .update({ asana_task_gid: gid })
    .eq('id', id);
  if (error) throw new Error(`[db] update asana_task_gid (${id}): ${error.message}`);
}

export async function dbCountAsanaTickets(): Promise<number> {
  // Excludes rows the sync has marked as deleted in Asana so the count
  // matches the live board, not the historical record.
  const { count, error } = await supabase
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .not('asana_task_gid', 'is', null)
    .is('asana_task_deleted_at', null);
  if (error) throw new Error(`[db] count asana tickets: ${error.message}`);
  return count ?? 0;
}

// Returns every live ticket gid we know about, paired with its conversation
// id. Used by the sync-asana-statuses endpoints to map Asana's view of
// completion back onto our rows. Tickets already flagged deleted are
// skipped — once gone in Asana, we stop polling for them every cron tick.
export async function dbListAllAsanaTickets(): Promise<
  Array<{ id: string; asana_task_gid: string }>
> {
  const PAGE = 1000;
  const out: Array<{ id: string; asana_task_gid: string }> = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('conversations')
      .select('id, asana_task_gid')
      .not('asana_task_gid', 'is', null)
      .is('asana_task_deleted_at', null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`[db] list asana tickets: ${error.message}`);
    const rows = (data ?? []) as Array<{ id: string; asana_task_gid: string | null }>;
    for (const r of rows) {
      if (r.asana_task_gid) out.push({ id: r.id, asana_task_gid: r.asana_task_gid });
    }
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

// Pulls every ticketed row in one paginated sweep and pivots in JS — same
// pattern the dashboard uses for severity/category since those values live
// inside the summary JSON. Returns the slim shape the reporting page needs;
// the caller decides which slices to render.
export interface AsanaReportingMetrics {
  totalTickets: number;
  openTickets: number;
  closedTickets: number;
  ticketsByAm: Array<{ label: string; count: number }>;
  ticketsBySeverity: Array<{ label: string; count: number }>;
  ticketsByCategory: Array<{ label: string; count: number }>;
  ticketsByDate: Array<{ date: string; count: number }>;       // YYYY-MM-DD, sorted asc
  lastSyncedAt: string | null;                                  // most recent asana_completed_at write
}

export async function dbGetAsanaReportingMetrics(): Promise<AsanaReportingMetrics> {
  const PAGE = 1000;
  type Row = {
    id: string;
    account_manager: string | null;
    summary: string | null;
    analyzed_at: string | null;
    asana_completed_at: string | null;
  };
  const rows: Row[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('conversations')
      .select('id, account_manager, summary, analyzed_at, asana_completed_at')
      .not('asana_task_gid', 'is', null)
      .is('asana_task_deleted_at', null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`[db] asana reporting: ${error.message}`);
    const page = (data ?? []) as Row[];
    rows.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
  }

  let openTickets = 0;
  let closedTickets = 0;
  const amCounts = new Map<string, number>();
  const sevCounts = new Map<string, number>();
  const catCounts = new Map<string, number>();
  const dateCounts = new Map<string, number>();
  let lastSyncedAt: string | null = null;

  for (const r of rows) {
    if (r.asana_completed_at) {
      closedTickets += 1;
      if (!lastSyncedAt || r.asana_completed_at > lastSyncedAt) lastSyncedAt = r.asana_completed_at;
    } else {
      openTickets += 1;
    }

    const am = (r.account_manager ?? '').trim() || 'Unassigned';
    amCounts.set(am, (amCounts.get(am) ?? 0) + 1);

    const parsed = parseAnalysisSummary(r.summary);
    const sev = normalizeSeverity(parsed.dissatisfaction_severity) ?? 'Unknown';
    sevCounts.set(sev, (sevCounts.get(sev) ?? 0) + 1);

    // A single conversation can flag multiple categories — count each once
    // per ticket so the bar chart shows ticket-coverage rather than weighted
    // sums (matches how the main dashboard counts top categories).
    const seen = new Set<string>();
    for (const item of parsed.results ?? []) {
      const c = String(item.category ?? '').trim();
      if (!c || seen.has(c)) continue;
      seen.add(c);
      catCounts.set(c, (catCounts.get(c) ?? 0) + 1);
    }

    if (r.analyzed_at) {
      const date = r.analyzed_at.slice(0, 10);                  // YYYY-MM-DD in UTC
      dateCounts.set(date, (dateCounts.get(date) ?? 0) + 1);
    }
  }

  const sortDesc = (a: { count: number }, b: { count: number }) => b.count - a.count;
  return {
    totalTickets: rows.length,
    openTickets,
    closedTickets,
    ticketsByAm: [...amCounts].map(([label, count]) => ({ label, count })).sort(sortDesc),
    ticketsBySeverity: [...sevCounts].map(([label, count]) => ({ label, count })).sort(sortDesc),
    ticketsByCategory: [...catCounts].map(([label, count]) => ({ label, count })).sort(sortDesc).slice(0, 10),
    ticketsByDate: [...dateCounts]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    lastSyncedAt,
  };
}

// Concurrent UPDATEs keyed by id. An update with `completedAt` defined writes
// asana_completed_at (open vs closed); one with `deletedAt` defined writes
// asana_task_deleted_at (gone-in-Asana). Both fields are independent so the
// caller picks per row. Undefined fields are not touched, so re-running with
// only one field set is non-destructive.
export async function dbBatchUpdateAsanaStatus(
  updates: Array<{
    id: string;
    completedAt?: string | null;
    deletedAt?: string | null;
  }>,
): Promise<void> {
  if (updates.length === 0) return;
  await Promise.all(
    updates.map(({ id, completedAt, deletedAt }) => {
      const fields: Record<string, string | null> = {};
      if (completedAt !== undefined) fields.asana_completed_at = completedAt;
      if (deletedAt !== undefined)   fields.asana_task_deleted_at = deletedAt;
      if (Object.keys(fields).length === 0) return Promise.resolve();
      return supabase
        .from('conversations')
        .update(fields)
        .eq('id', id)
        .then(({ error }) => {
          if (error) throw new Error(`[db] update asana status (${id}): ${error.message}`);
        });
    }),
  );
}

// ── Load all state ─────────────────────────────────────────────────────────

export async function loadFromSupabase(): Promise<{ conversations: Conversation[]; prompts: PromptVersion[] } | null> {
  try {
    const { data, error } = await supabase
      .from('prompts')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const prompts: PromptVersion[] = (data ?? []).map((p) => ({
      id: p.id,
      title: p.title ?? 'Untitled',
      content: p.content ?? '',
      is_active: p.is_active ?? false,
      created_at: p.created_at,
      updated_at: p.updated_at ?? p.created_at,
    }));

    // Conversations are NOT loaded here — ConversationList fetches its own
    // page via /api/conversations. Loading all 20k+ rows into the store would
    // crash the browser. conversations stays [] in the Zustand store.
    return { conversations: [], prompts };
  } catch (e) {
    console.error('[db] loadFromSupabase failed:', e);
    return null;
  }
}

// ── Sync Jobs ──────────────────────────────────────────────────────────────

export async function dbGetSyncJob(date: string): Promise<SyncJob | null> {
  const { data, error } = await supabase.from('sync_jobs').select('*').eq('id', date).single();
  if (error || !data) return null;
  return data as SyncJob;
}

export async function dbUpsertSyncJob(job: SyncJob): Promise<void> {
  const { error } = await supabase.from('sync_jobs').upsert(job, { onConflict: 'id' });
  if (error) throw new Error(`[db] upsert sync job: ${error.message}`);
}

export async function dbUpdateSyncJob(date: string, patch: Partial<SyncJob>): Promise<void> {
  const { error } = await supabase.from('sync_jobs').update(patch).eq('id', date);
  if (error) throw new Error(`[db] update sync job: ${error.message}`);
}

// Reconciles DB conversations for a date against the canonical Intercom set.
// Deletes rows whose intercom_id is not in validIntercomIds (stale/non-chat),
// and deduplicates rows sharing the same intercom_id (keeps the richest one).
// Returns the number of rows deleted.
export async function dbReconcileConversations(
  date: string,
  validIntercomIds: Set<string>,
): Promise<number> {
  const [startUnix, endUnix] = cestDateToUnixRange(date);
  const startISO = new Date(startUnix * 1000).toISOString();
  const endISO   = new Date(endUnix   * 1000).toISOString();

  const CHUNK = 500;
  type SlimRow = { id: string; intercom_id: string | null; summary: string | null; original_text: string | null; analyzed_at: string | null };
  const rows: SlimRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('conversations')
      .select('id, intercom_id, summary, original_text, analyzed_at')
      .gte('intercom_created_at', startISO)
      .lte('intercom_created_at', endISO)
      .range(from, from + CHUNK - 1);
    if (error) throw new Error(`[db] reconcile fetch: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < CHUNK) break;
    from += CHUNK;
  }

  const byId = new Map<string, SlimRow[]>();
  for (const row of rows) {
    if (!row.intercom_id) continue;
    if (!byId.has(row.intercom_id)) byId.set(row.intercom_id, []);
    byId.get(row.intercom_id)!.push(row);
  }

  const toDelete: string[] = [];
  for (const [intercomId, group] of byId) {
    if (!validIntercomIds.has(intercomId)) {
      toDelete.push(...group.map((r) => r.id));
    } else if (group.length > 1) {
      const best = [...group].sort((a, b) => {
        const score = (r: SlimRow) => (r.summary ? 2 : 0) + (r.original_text ? 1 : 0);
        if (score(b) !== score(a)) return score(b) - score(a);
        return new Date(b.analyzed_at ?? 0).getTime() - new Date(a.analyzed_at ?? 0).getTime();
      })[0];
      toDelete.push(...group.filter((r) => r.id !== best.id).map((r) => r.id));
    }
  }

  if (toDelete.length === 0) return 0;

  for (let i = 0; i < toDelete.length; i += CHUNK) {
    const chunk = toDelete.slice(i, i + CHUNK);
    await supabase.from('analysis_runs').delete().in('conversation_id', chunk);
    const { error } = await supabase.from('conversations').delete().in('id', chunk);
    if (error) throw new Error(`[db] reconcile delete: ${error.message}`);
  }

  return toDelete.length;
}

// ── Ask AI queries ─────────────────────────────────────────────────────────

export async function dbInsertAiQuery(q: Omit<AiQuery, 'id' | 'created_at'>): Promise<AiQuery> {
  const { data, error } = await supabase
    .from('ai_queries')
    .insert({
      question: q.question,
      answer: q.answer,
      tools_used: q.tools_used,
      is_irrelevant: q.is_irrelevant,
    })
    .select()
    .single();
  if (error) throw new Error(`[db] insert ai_query: ${error.message}`);
  return data as AiQuery;
}

export async function dbGetAiQueries(page = 0, perPage = 25): Promise<{ queries: AiQuery[]; total: number }> {
  const from = page * perPage;
  const to = from + perPage - 1;
  const { data, error, count } = await supabase
    .from('ai_queries')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);
  if (error) throw new Error(`[db] get ai_queries: ${error.message}`);
  return { queries: (data ?? []) as AiQuery[], total: count ?? 0 };
}

export async function dbDeleteAiQuery(id: string): Promise<void> {
  const { error } = await supabase.from('ai_queries').delete().eq('id', id);
  if (error) throw new Error(`[db] delete ai_query: ${error.message}`);
}
