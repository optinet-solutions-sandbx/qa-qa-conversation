import type { ConversationFetchResult, PlayerCompany, PlayerEventSummary, RawMessage } from './types';
import { AM_GROUP_MAP, normalizeGroupName } from './utils';

// ── Types ──────────────────────────────────────────────────────────────────

export interface IntercomAuthor {
  type?: string;
  id?: string;
  name?: string;
  email?: string;
}

interface IntercomPart {
  part_type: string;
  body: string;
  author: IntercomAuthor;
}

export interface IntercomConversation {
  id: string;
  created_at: number;
  title?: string | null;
  state?: string;
  source?: { author?: IntercomAuthor; body?: string };
  tags?: { tags?: Array<{ name: string }> };
  statistics?: {
    time_to_assignment?: number | null;
    time_to_admin_reply?: number | null;
    time_to_first_close?: number | null;
    median_time_to_reply?: number | null;
    count_reopens?: number | null;
  };
  conversation_rating?: { rating?: number | null; remark?: string | null };
  teammates?: { teammates?: Array<{ type?: string }> };
  custom_attributes?: Record<string, unknown>;
  conversation_parts?: { conversation_parts?: IntercomPart[] };
  admin_assignee_id?: number | null;
}

interface IntercomContact {
  id: string;
  external_id?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  signed_up_at?: number | null;
  last_seen_at?: number | null;
  last_replied_at?: number | null;
  last_contacted_at?: number | null;
  browser?: string | null;
  os?: string | null;
  location?: { country?: string | null; city?: string | null };
  custom_attributes?: Record<string, unknown>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch with automatic 429 back-off retry.
 * On rate limit: waits until the reset time reported by Intercom, then retries.
 */
async function fetchWithRateLimit(
  url: string,
  options: RequestInit = {},
  maxRetries = 4,
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;
    if (attempt === maxRetries) return res; // let caller handle final 429

    const reset = res.headers.get('X-RateLimit-Reset');
    const waitMs = reset
      ? Math.max(1000, parseInt(reset, 10) * 1000 - Date.now() + 500)
      : (attempt + 1) * 3000;

    console.warn(`[intercom] Rate limited (${url}). Waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}/${maxRetries}…`);
    await sleep(waitMs);
  }
  return fetch(url, options);
}

export function stripHtml(html: string): string {
  return (html || '').replace(/<[^>]*>?/gm, '').trim();
}

export function tsToIso(ts: number | null | undefined): string | null {
  return ts ? new Date(ts * 1000).toISOString() : null;
}

export function intercomHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'Intercom-Version': '2.9',
  };
}

export function rateLimitRemaining(res: Response): number {
  return parseInt(res.headers.get('X-RateLimit-Remaining') ?? '999', 10);
}

export function rateLimitResetMsg(res: Response): string {
  const reset = res.headers.get('X-RateLimit-Reset');
  if (!reset) return 'Please wait a minute and try again.';
  const secs = Math.max(0, parseInt(reset, 10) - Math.floor(Date.now() / 1000));
  return `Rate limit resets in ${secs}s. Please try again then.`;
}

export async function safeJson<T>(res: Response): Promise<T | null> {
  if (res.status === 429) {
    console.warn('[intercom] rate limited on sub-request:', res.url);
    return null;
  }
  if (!res.ok) return null;
  try { return await res.json() as T; } catch { return null; }
}

// ── Date → UTC Unix range ──────────────────────────────────────────────────

/** Convert a YYYY-MM-DD string to a [startUnix, endUnix] range in UTC. */
export function cestDateToUnixRange(date: string): [number, number] {
  const [year, month, day] = date.split('-').map(Number);
  const start = Math.floor(Date.UTC(year, month - 1, day, 0, 0, 0) / 1000);
  const end   = Math.floor(Date.UTC(year, month - 1, day, 23, 59, 59) / 1000);
  return [start, end];
}

// ── Search conversations by date ───────────────────────────────────────────

export interface IntercomSearchItem {
  intercom_id: string;
  created_at: number;
  title: string | null;
  player_name: string | null;
  player_email: string | null;
  player_id: string | null;
  brand: string | null;
  query_type: string | null;
  state: string;
}

export async function searchConversationsByDate(
  date: string,
  apiKey: string,
): Promise<IntercomSearchItem[]> {
  const [start, end] = cestDateToUnixRange(date);
  const headers = intercomHeaders(apiKey);
  const results: IntercomSearchItem[] = [];
  let cursor: string | null = null;

  do {
    const body: Record<string, unknown> = {
      query: {
        operator: 'AND',
        value: [
          { field: 'created_at', operator: '>=', value: start },
          { field: 'created_at', operator: '<=', value: end },
          { field: 'source.type', operator: '=', value: 'conversation' },
        ],
      },
      pagination: { per_page: 150, ...(cursor ? { starting_after: cursor } : {}) },
    };

    const res = await fetchWithRateLimit('https://api.intercom.io/conversations/search', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.status === 429) throw new Error(`Intercom rate limit reached. ${rateLimitResetMsg(res)}`);
    if (!res.ok) throw new Error(`Intercom search failed with status ${res.status}`);

    const data = await res.json() as {
      conversations: IntercomConversation[];
      pages?: { next?: { starting_after?: string } };
    };

    for (const c of data.conversations ?? []) {
      const attrs = c.custom_attributes ?? {};
      results.push({
        intercom_id: c.id,
        created_at: c.created_at,
        title: c.title ?? (stripHtml(c.source?.body ?? '') || null),
        player_name: c.source?.author?.name ?? null,
        player_email: c.source?.author?.email ?? null,
        player_id: c.source?.author?.id ?? null,
        brand: (attrs['Brand'] as string) ?? null,
        query_type: (attrs['Query Type'] as string) ?? null,
        state: c.state ?? 'unknown',
      });
    }

    cursor = data.pages?.next?.starting_after ?? null;
  } while (cursor);

  return results;
}

// ── Full conversation fetch ────────────────────────────────────────────────

export async function fetchIntercomData(
  intercomId: string,
  apiKey: string,
): Promise<ConversationFetchResult> {
  const headers = intercomHeaders(apiKey);

  const convRes = await fetchWithRateLimit(`https://api.intercom.io/conversations/${intercomId}`, { headers });
  if (convRes.status === 429) throw new Error(`Intercom rate limit reached. ${rateLimitResetMsg(convRes)}`);
  if (!convRes.ok) {
    const body = await convRes.text();
    console.error('Intercom conversation error:', body);
    throw new Error(`Intercom API responded with ${convRes.status}`);
  }
  const remaining = rateLimitRemaining(convRes);
  const conv = await convRes.json() as IntercomConversation;

  const parts = conv.conversation_parts?.conversation_parts ?? [];
  const attrs = conv.custom_attributes ?? {};
  const player: IntercomAuthor = conv.source?.author ?? {};
  const firstAdminPart = parts.find((p) => p.author.type === 'admin');
  const isBotHandled = conv.teammates?.teammates?.some((t) => t.type === 'bot' || t.type === 'operator') ?? false;

  const commentParts = parts.filter((p) => p.part_type === 'comment' && p.body);
  const rawMessages: RawMessage[] = commentParts.map((p) => ({
    author_type: p.author.type ?? 'user',
    body: stripHtml(p.body),
  }));
  const transcript = commentParts
    .map((p) => {
      let label: string;
      if (p.author.type === 'admin') label = 'Agent';
      else if (p.author.type === 'bot' || p.author.type === 'operator') label = 'Bot';
      else label = 'Player';
      return `${label}: ${stripHtml(p.body)}`;
    })
    .join('\n\n');
  if (!transcript.trim()) throw new Error('No readable transcript in this conversation.');
  const MAX_CHARS = 60000;
  const truncated = transcript.length > MAX_CHARS
    ? transcript.substring(0, MAX_CHARS) + '\n\n[Transcript truncated]'
    : transcript;

  let contact: IntercomContact | null = null;
  let playerTags: string[] = [];
  let playerCompanies: PlayerCompany[] = [];
  let playerSegments: string[] = [];
  let playerEventSummaries: PlayerEventSummary[] = [];

  if (player.id && remaining >= 5) {
    const [contactRes, tagsRes, companiesRes, segmentsRes, eventsRes] = await Promise.allSettled([
      fetchWithRateLimit(`https://api.intercom.io/contacts/${player.id}`, { headers }),
      fetchWithRateLimit(`https://api.intercom.io/contacts/${player.id}/tags`, { headers }),
      fetchWithRateLimit(`https://api.intercom.io/contacts/${player.id}/companies`, { headers }),
      fetchWithRateLimit(`https://api.intercom.io/contacts/${player.id}/segments`, { headers }),
      fetchWithRateLimit(`https://api.intercom.io/events?type=user&intercom_user_id=${player.id}&summary=true`, { headers }),
    ]);

    if (contactRes.status === 'fulfilled') contact = await safeJson<IntercomContact>(contactRes.value);
    if (tagsRes.status === 'fulfilled') {
      const data = await safeJson<{ data?: Array<{ name?: string }> }>(tagsRes.value);
      playerTags = (data?.data ?? []).map((t) => t.name ?? '').filter(Boolean);
    }
    if (companiesRes.status === 'fulfilled') {
      const data = await safeJson<{ data?: Array<{ id: string; name?: string; session_count?: number | null; monthly_spend?: number | null }> }>(companiesRes.value);
      playerCompanies = (data?.data ?? []).map((c) => ({ id: c.id, name: c.name ?? '', session_count: c.session_count ?? null, monthly_spend: c.monthly_spend ?? null }));
    }
    if (segmentsRes.status === 'fulfilled') {
      const data = await safeJson<{ data?: Array<{ name?: string }> }>(segmentsRes.value);
      playerSegments = (data?.data ?? []).map((s) => s.name ?? '').filter(Boolean);
    }
    if (eventsRes.status === 'fulfilled') {
      const data = await safeJson<{ data?: Array<{ name?: string; first?: string; last?: string; count?: number }> }>(eventsRes.value);
      playerEventSummaries = (data?.data ?? []).map((e) => ({ name: e.name ?? '', first: e.first ?? '', last: e.last ?? '', count: e.count ?? 0 })).filter((e) => e.name);
    }
  }

  return {
    intercom_id: conv.id,
    intercom_created_at: tsToIso(conv.created_at),
    player_name: contact?.name ?? player.name ?? null,
    player_email: contact?.email ?? player.email ?? null,
    player_id: player.id ?? null,
    player_external_id: contact?.external_id ?? null,
    player_phone: contact?.phone ?? null,
    player_tags: playerTags,
    player_signed_up_at: tsToIso(contact?.signed_up_at),
    player_last_seen_at: tsToIso(contact?.last_seen_at),
    player_last_replied_at: tsToIso(contact?.last_replied_at),
    player_last_contacted_at: tsToIso(contact?.last_contacted_at),
    player_country: contact?.location?.country ?? null,
    player_city: contact?.location?.city ?? null,
    player_browser: contact?.browser ?? null,
    player_os: contact?.os ?? null,
    player_custom_attributes: contact?.custom_attributes ?? null,
    player_companies: playerCompanies,
    player_segments: playerSegments,
    player_event_summaries: playerEventSummaries,
    agent_name: firstAdminPart?.author?.name ?? null,
    agent_email: firstAdminPart?.author?.email ?? null,
    is_bot_handled: isBotHandled,
    brand: (attrs['Brand'] as string) ?? null,
    query_type: (attrs['Query Type'] as string) ?? null,
    ai_subject: (attrs['AI Chat subject'] as string) ?? null,
    ai_issue_summary: (attrs['AI Issue summary'] as string) ?? null,
    cx_score_rating: (attrs['CX Score rating'] as number) ?? null,
    cx_score_explanation: (attrs['CX Score explanation'] as string) ?? null,
    tags: (conv.tags?.tags ?? []).map((t) => t.name),
    conversation_rating_score: conv.conversation_rating?.rating ?? null,
    conversation_rating_remark: conv.conversation_rating?.remark ?? null,
    time_to_assignment: conv.statistics?.time_to_assignment ?? null,
    time_to_admin_reply: conv.statistics?.time_to_admin_reply ?? null,
    time_to_first_close: conv.statistics?.time_to_first_close ?? null,
    median_time_to_reply: conv.statistics?.median_time_to_reply ?? null,
    count_reopens: conv.statistics?.count_reopens ?? null,
    transcript: truncated,
    raw_messages: rawMessages,
    account_manager: (() => {
      const customAttrs = contact?.custom_attributes ?? {};
      for (const key of ['Account Manager', 'account_manager', 'AccountManager', 'AM', 'Account Mgr']) {
        const v = customAttrs[key];
        if (v != null && v !== '') return String(v);
      }
      const convTags = (conv.tags?.tags ?? []).map((t) => t.name);
      const allGroups = [...playerTags, ...playerSegments, ...convTags, ...playerCompanies.map((c) => c.name)];
      const normalizedGroups = allGroups.map(normalizeGroupName);
      for (const [am, groups] of Object.entries(AM_GROUP_MAP)) {
        if (am === 'SoftSwiss') {
          if (normalizedGroups.some((n) => n === 'softswiss' || n.startsWith('softswiss '))) return am;
        } else if (groups.some((g) => normalizedGroups.includes(g))) {
          return am;
        }
      }
      return null;
    })(),
  };
}
