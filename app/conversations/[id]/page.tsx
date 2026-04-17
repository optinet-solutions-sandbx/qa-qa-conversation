'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Conversation } from '@/lib/types';
import ConversationDetail from '@/components/conversations/ConversationDetail';

export default function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [loading, setLoading]           = useState(true);
  const [notFound, setNotFound]         = useState(false);

  useEffect(() => {
    fetch(`/api/conversations/${id}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((data) => setConversation(data.conversation))
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (notFound || !conversation) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center p-6">
        <h2 className="text-base font-semibold text-slate-700 mb-2">Conversation not found</h2>
        <p className="text-sm text-slate-400 mb-4">It may have been deleted.</p>
        <button
          onClick={() => router.push('/')}
          className="text-sm text-blue-600 hover:text-blue-800 font-medium transition-colors"
        >
          ← Back to conversations
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <ConversationDetail conversation={conversation} />
    </div>
  );
}
