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

  const filters: ConversationFilters = {};
  if (sp.get('resolution_status'))        filters.resolution_status        = sp.get('resolution_status')!;
  if (sp.get('dissatisfaction_severity')) filters.dissatisfaction_severity = sp.get('dissatisfaction_severity')!;
  if (sp.get('issue_category'))           filters.issue_category           = sp.get('issue_category')!;
  if (sp.get('language'))                 filters.language                 = sp.get('language')!;
  if (sp.get('brand'))                    filters.brand                    = sp.get('brand')!;
  if (sp.get('agent_name'))               filters.agent_name               = sp.get('agent_name')!;
  if (sp.get('dateFrom'))                 filters.dateFrom                 = sp.get('dateFrom')!;
  if (sp.get('dateTo'))                   filters.dateTo                   = sp.get('dateTo')!;
  if (sp.get('analyzed') !== null && sp.get('analyzed') !== '')
    filters.analyzed = sp.get('analyzed') === 'true';
  if (sp.get('alert_worthy') === 'true')  filters.alert_worthy             = true;

  try {
    const result = needsJsonFilter(filters)
      ? await loadConversationsWithJsonFilter(page, perPage, filters)
      : await loadConversations(page, perPage, filters);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
