'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/lib/store';
import { useToast } from '@/components/layout/ToastProvider';
import { dbDeleteConversation } from '@/lib/db-client';
import ConversationCard from './ConversationCard';

function IconChat() {
  return (
    <svg className="w-12 h-12 text-slate-300" fill="none" stroke="currentColor" strokeWidth={1.25} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
    </svg>
  );
}

export default function ConversationList() {
  const { conversations, deleteConversation } = useStore();
  const { toast } = useToast();
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const handleSelect = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleDeleteSelected = () => {
    if (!window.confirm(`Delete ${selected.size} conversation(s)?`)) return;
    selected.forEach((id) => {
      deleteConversation(id);
      dbDeleteConversation(id);
    });
    setSelected(new Set());
    toast(`${selected.size} conversation(s) deleted`, 'success');
  };

  if (conversations.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-32 text-center px-4">
        <IconChat />
        <h2 className="text-base font-semibold text-slate-600 mt-4 mb-1">No conversations yet</h2>
        <p className="text-slate-400 text-sm max-w-xs">
          Click &ldquo;Add Conversation&rdquo; above to pull in your first support chat.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
          <span className="text-sm text-blue-700 font-medium">{selected.size} selected</span>
          <button
            onClick={handleDeleteSelected}
            className="text-sm text-red-600 hover:text-red-800 font-medium transition-colors"
          >
            Delete
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="text-sm text-slate-500 hover:text-slate-700 ml-auto transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      {/* Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {conversations.map((conv) => (
          <ConversationCard
            key={conv.id}
            conversation={conv}
            selected={selected.has(conv.id)}
            onSelect={handleSelect}
            onClick={() => router.push(`/conversations/${conv.id}`)}
          />
        ))}
      </div>
    </div>
  );
}
