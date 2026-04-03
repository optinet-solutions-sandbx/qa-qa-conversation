import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { ConversationFetchResult, PlayerCompany, PlayerEventSummary } from '@/lib/types';

// ── Types ──────────────────────────────────────────────────────────────────

interface IntercomAuthor {
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

interface IntercomConversation {
  id: string;
  created_at: number;
  source?: { author?: IntercomAuthor };
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

function stripHtml(html: string): string {
  return (html || '').replace(/<[^>]*>?/gm, '').trim();
}

function tsToIso(ts: number | null | undefined): string | null {
  return ts ? new Date(ts * 1000).toISOString() : null;
}

function intercomHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'Intercom-Version': '2.9',
  };
}

function rateLimitRemaining(res: Response): number {
  return parseInt(res.headers.get('X-RateLimit-Remaining') ?? '999', 10);
}

function rateLimitResetMsg(res: Response): string {
  const reset = res.headers.get('X-RateLimit-Reset');
  if (!reset) return 'Please wait a minute and try again.';
  const secs = Math.max(0, parseInt(reset, 10) - Math.floor(Date.now() / 1000));
  return `Rate limit resets in ${secs}s. Please try again then.`;
}

async function safeJson<T>(res: Response): Promise<T | null> {
  if (res.status === 429) {
    console.warn('[intercom] rate limited on sub-request:', res.url);
    return null;
  }
  if (!res.ok) return null;
  try { return await res.json() as T; } catch { return null; }
}

// ── Fetch all Intercom data ────────────────────────────────────────────────

async function fetchIntercomData(
  intercomId: string,
  apiKey: string
): Promise<ConversationFetchResult> {
  const headers = intercomHeaders(apiKey);

  // 1. Fetch conversation
  const convRes = await fetch(`https://api.intercom.io/conversations/${intercomId}`, { headers });
  if (convRes.status === 429) {
    throw new Error(`Intercom rate limit reached. ${rateLimitResetMsg(convRes)}`);
  }
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
  const isBotHandled = conv.teammates?.teammates?.some((t) => t.type === 'bot') ?? false;

  // Build transcript
  const transcript = parts
    .filter((p) => p.part_type === 'comment' && p.body)
    .map((p) => `${p.author.type === 'admin' ? 'Agent' : 'User'}: ${stripHtml(p.body)}`)
    .join('\n\n');
  if (!transcript.trim()) throw new Error('No readable transcript in this conversation.');
  const MAX_CHARS = 60000;
  const truncated = transcript.length > MAX_CHARS
    ? transcript.substring(0, MAX_CHARS) + '\n\n[Transcript truncated]'
    : transcript;

  // 2. Fetch all player data in parallel (non-fatal if any fail)
  let contact: IntercomContact | null = null;
  let playerTags: string[] = [];
  let playerCompanies: PlayerCompany[] = [];
  let playerSegments: string[] = [];
  let playerEventSummaries: PlayerEventSummary[] = [];

  // Need 5 more requests for player data — skip if budget is too low
  if (player.id && remaining >= 5) {
    const [contactRes, tagsRes, companiesRes, segmentsRes, eventsRes] = await Promise.allSettled([
      fetch(`https://api.intercom.io/contacts/${player.id}`, { headers }),
      fetch(`https://api.intercom.io/contacts/${player.id}/tags`, { headers }),
      fetch(`https://api.intercom.io/contacts/${player.id}/companies`, { headers }),
      fetch(`https://api.intercom.io/contacts/${player.id}/segments`, { headers }),
      fetch(`https://api.intercom.io/events?type=user&intercom_user_id=${player.id}&summary=true`, { headers }),
    ]);

    if (contactRes.status === 'fulfilled') {
      contact = await safeJson<IntercomContact>(contactRes.value);
    }
    if (tagsRes.status === 'fulfilled') {
      const data = await safeJson<{ data?: Array<{ name?: string }> }>(tagsRes.value);
      playerTags = (data?.data ?? []).map((t) => t.name ?? '').filter(Boolean);
    }
    if (companiesRes.status === 'fulfilled') {
      const data = await safeJson<{ data?: Array<{ id: string; name?: string; session_count?: number | null; monthly_spend?: number | null }> }>(companiesRes.value);
      playerCompanies = (data?.data ?? []).map((c) => ({
        id: c.id,
        name: c.name ?? '',
        session_count: c.session_count ?? null,
        monthly_spend: c.monthly_spend ?? null,
      }));
    }
    if (segmentsRes.status === 'fulfilled') {
      const data = await safeJson<{ data?: Array<{ name?: string }> }>(segmentsRes.value);
      playerSegments = (data?.data ?? []).map((s) => s.name ?? '').filter(Boolean);
    }
    if (eventsRes.status === 'fulfilled') {
      const data = await safeJson<{ data?: Array<{ name?: string; first?: string; last?: string; count?: number }> }>(eventsRes.value);
      playerEventSummaries = (data?.data ?? []).map((e) => ({
        name: e.name ?? '',
        first: e.first ?? '',
        last: e.last ?? '',
        count: e.count ?? 0,
      })).filter((e) => e.name);
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
  };
}

async function callOpenAI(
  systemPrompt: string,
  userMessage: string,
  openAIKey: string
): Promise<Record<string, unknown>> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAIKey}` },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'OpenAI API error');
  const content = data.choices[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned an empty response.');
  const match = (content as string).match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not find a valid JSON object in the AI response.');
  return JSON.parse(match[0]) as Record<string, unknown>;
}

// ── GET: fetch conversation data (no AI) ──────────────────────────────────

export async function GET(req: NextRequest) {
  const apiKey = process.env.INTERCOM_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'Server misconfiguration: INTERCOM_API_KEY not found.' }, { status: 500 });
  }
  const id = req.nextUrl.searchParams.get('id');
  if (!id?.trim()) {
    return NextResponse.json({ error: 'id query param is required.' }, { status: 400 });
  }
  try {
    const data = await fetchIntercomData(id.trim(), apiKey);
    return NextResponse.json(data);
  } catch (error) {
    console.error('Fetch Error:', error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

// ── POST: fetch + AI analysis ─────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const openAIKey = process.env.OPENAI_API_KEY;
  const apiKey = process.env.INTERCOM_API_KEY;
  if (!openAIKey) return NextResponse.json({ error: 'OPENAI_API_KEY not found' }, { status: 500 });
  if (!apiKey) return NextResponse.json({ error: 'INTERCOM_API_KEY not found' }, { status: 500 });

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const { customSystemPrompt, intercomId } = body as { customSystemPrompt?: string; intercomId?: string };
  if (!customSystemPrompt?.trim()) return NextResponse.json({ error: 'No prompt configured.' }, { status: 400 });
  if (!intercomId?.trim()) return NextResponse.json({ error: 'intercomId is required.' }, { status: 400 });

  try {
    const intercomData = await fetchIntercomData(intercomId.trim(), apiKey);
    const userMessage = [
      `Conversation ID: ${intercomData.intercom_id}`,
      `Player: ${intercomData.player_name ?? 'Unknown'} (${intercomData.player_email ?? 'no email'})`,
      `Agent: ${intercomData.agent_name ?? 'Unknown'}`,
      `Brand: ${intercomData.brand ?? 'Unknown'}`,
      '',
      'Transcript:',
      intercomData.transcript,
    ].join('\n');
    const analysis = await callOpenAI(customSystemPrompt, userMessage, openAIKey);
    return NextResponse.json({ ...analysis, ...intercomData });
  } catch (error) {
    console.error('Analysis Error:', error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
