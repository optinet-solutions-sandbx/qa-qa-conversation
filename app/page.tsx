'use client';

import ConversationList from '@/components/conversations/ConversationList';

export default function ConversationsPage() {
  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <ConversationList />
    </div>
  );
}
