import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { loadConversations, loadConversationsWithJsonFilter, needsJsonFilter, getConversationById } from '@/lib/db';
import type { ConversationFilters } from '@/lib/db';

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const id = sp.get('id');
  if (id) {
    try {
      const conversation = await getConversationById(id);
      if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return NextResponse.json(conversation);
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  const page    = parseInt(sp.get('page')    ?? '0',  10);
  const perPage = parseInt(sp.get('perPage') ?? '24', 10);

  // Multi-value filters use repeated query params (e.g. ?brand=A&brand=B).
  // A single-value caller sends one value; both shapes resolve to a string[]
  // via getAll(), and the downstream filters treat single-element arrays the
  // same as a string.
  const multi = (key: string): string[] => sp.getAll(key).filter((v) => v !== '');
  const filters: ConversationFilters = {};
  const setMulti = <K extends keyof ConversationFilters>(key: K, vals: string[]) => {
    if (vals.length === 0) return;
    // Keep single-value calls behaving identically to before by collapsing
    // to a plain string when only one value was provided.
    (filters as Record<string, unknown>)[key] = vals.length === 1 ? vals[0] : vals;
  };
  setMulti('resolution_status',        multi('resolution_status'));
  setMulti('dissatisfaction_severity', multi('dissatisfaction_severity'));
  setMulti('issue_category',           multi('issue_category'));
  setMulti('issue_item',               multi('issue_item'));
  setMulti('language',                 multi('language'));
  setMulti('brand',                    multi('brand'));
  setMulti('agent_name',               multi('agent_name'));
  setMulti('account_manager',          multi('account_manager'));
  setMulti('vip_level',                multi('vip_level'));
  if (sp.get('dateFrom'))                 filters.dateFrom                 = sp.get('dateFrom')!;
  if (sp.get('dateTo'))                   filters.dateTo                   = sp.get('dateTo')!;
  if (sp.get('analyzed') !== null && sp.get('analyzed') !== '')
    filters.analyzed = sp.get('analyzed') === 'true';
  if (sp.get('alert_worthy') === 'true')  filters.alert_worthy             = true;
  if (sp.get('asana_ticketed') === 'true') filters.asana_ticketed          = true;
  const status = sp.get('asana_status');
  if (status === 'open' || status === 'closed') filters.asana_status        = status;

  try {
    const result = needsJsonFilter(filters)
      ? await loadConversationsWithJsonFilter(page, perPage, filters)
      : await loadConversations(page, perPage, filters);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
