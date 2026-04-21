'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import ConversationList from '@/components/conversations/ConversationList';
import type { ConversationFilters } from '@/lib/db';

function ConversationListWithFilters() {
  const sp = useSearchParams();

  const filters: ConversationFilters = {};
  if (sp.get('resolution_status'))        filters.resolution_status        = sp.get('resolution_status')!;
  if (sp.get('dissatisfaction_severity')) filters.dissatisfaction_severity = sp.get('dissatisfaction_severity')!;
  if (sp.get('issue_category'))           filters.issue_category           = sp.get('issue_category')!;
  if (sp.get('language'))                 filters.language                 = sp.get('language')!;
  if (sp.get('brand'))                    filters.brand                    = sp.get('brand')!;
  if (sp.get('agent_name'))               filters.agent_name               = sp.get('agent_name')!;
  if (sp.get('dateFrom'))                 filters.dateFrom                 = sp.get('dateFrom')!;
  if (sp.get('dateTo'))                   filters.dateTo                   = sp.get('dateTo')!;
  if (sp.get('analyzed') !== null)        filters.analyzed                 = sp.get('analyzed') === 'true';
  if (sp.get('alert_worthy') !== null)    filters.alert_worthy             = sp.get('alert_worthy') === 'true';

  const hasFilters = Object.keys(filters).length > 0;

  return <ConversationList filters={hasFilters ? filters : undefined} />;
}

export default function ConversationsPage() {
  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <Suspense fallback={<div className="flex-1 flex items-center justify-center"><div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" /></div>}>
        <ConversationListWithFilters />
      </Suspense>
    </div>
  );
}
