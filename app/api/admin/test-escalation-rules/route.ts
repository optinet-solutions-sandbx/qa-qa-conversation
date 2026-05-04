import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase';
import { dbGetAsanaConversationContext } from '@/lib/db';
import { parseAnalysisSummary, normalizeSeverity } from '@/lib/analyticsFilters';
import { getSegment } from '@/lib/utils';
import {
  evaluateEscalation,
  severityToNumber,
  extractCategoryNumbers,
} from '@/lib/escalationRules';

// Read-only dry-run for the escalation rule gate. Mirrors the logic in
// maybeCreateAsanaTicketForConversation (lib/asana.ts) but never writes to
// Asana or the DB — just reports what the gate would decide for an existing
// conversation. Useful for verifying the (segment, severity, category) matrix
// against real production data without risking a stray ticket.
//
// Usage:
//   GET /api/admin/test-escalation-rules?id=<conv_id>
//   GET /api/admin/test-escalation-rules?intercom_id=<id>
//   GET /api/admin/test-escalation-rules?agent=<name>   (most recent analyzed)
//
// Auth (optional): if CRON_SECRET is set, pass either:
//   - Authorization: Bearer <secret>
//   - ?secret=<secret>

interface ConversationRow {
  id: string;
  summary: string | null;
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization') ?? '';
    const querySecret = new URL(req.url).searchParams.get('secret') ?? '';
    if (auth !== `Bearer ${secret}` && querySecret !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  const intercomId = searchParams.get('intercom_id');
  const agent = searchParams.get('agent');

  if (!id && !intercomId && !agent) {
    return NextResponse.json(
      { error: 'Pass one of: id, intercom_id, agent' },
      { status: 400 },
    );
  }

  let row: ConversationRow | null = null;

  if (id) {
    const { data } = await supabase
      .from('conversations')
      .select('id, summary')
      .eq('id', id)
      .single();
    row = data as ConversationRow | null;
  } else if (intercomId) {
    const { data } = await supabase
      .from('conversations')
      .select('id, summary')
      .eq('intercom_id', intercomId)
      .single();
    row = data as ConversationRow | null;
  } else if (agent) {
    const { data } = await supabase
      .from('conversations')
      .select('id, summary')
      .eq('agent_name', agent)
      .not('summary', 'is', null)
      .order('intercom_created_at', { ascending: false })
      .limit(1)
      .single();
    row = data as ConversationRow | null;
  }

  if (!row) {
    return NextResponse.json({ error: 'No matching conversation found' }, { status: 404 });
  }
  if (!row.summary) {
    return NextResponse.json(
      { error: 'Conversation has no analysis summary; nothing for the gate to evaluate' },
      { status: 400 },
    );
  }

  const ctx = await dbGetAsanaConversationContext(row.id);
  if (!ctx) {
    return NextResponse.json({ error: 'Could not load conversation context' }, { status: 500 });
  }

  const parsed = parseAnalysisSummary(row.summary);
  const normalizedSev = normalizeSeverity(parsed.dissatisfaction_severity);
  const severityNum = severityToNumber(parsed.dissatisfaction_severity);

  const issueCategories: string[] = [];
  const issueItems: string[] = [];
  const seenCat = new Set<string>();
  const seenItem = new Set<string>();
  for (const r of parsed.results ?? []) {
    const c = String(r.category ?? '').trim();
    if (c && !seenCat.has(c)) { seenCat.add(c); issueCategories.push(c); }
    const it = String(r.item ?? '').trim();
    if (it && !seenItem.has(it)) { seenItem.add(it); issueItems.push(it); }
  }

  const segment = getSegment(ctx);
  const categoryNumbers = extractCategoryNumbers(issueCategories);
  const decision = evaluateEscalation(segment, severityNum, categoryNumbers);

  return NextResponse.json({
    conversation_id: row.id,
    intercom_id: ctx.intercom_id,
    agent_name: ctx.agent_name,
    account_manager: ctx.account_manager,
    inputs: {
      segment,
      severity_normalized: normalizedSev,
      severity_number: severityNum,
      raw_categories: issueCategories,
      raw_issues: issueItems,
      matched_category_numbers: categoryNumbers,
    },
    decision,
    already_escalated: !!ctx.asana_task_gid,
    note: 'Dry-run only. No Asana ticket created, no DB row updated.',
  });
}
