'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AnalysisRun, Conversation } from '@/lib/types';
import ConversationDetail from '@/components/conversations/ConversationDetail';

export default function AnalysisRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  const [run, setRun] = useState<AnalysisRun | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [runLoading, setRunLoading] = useState(true);
  const [convLoading, setConvLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [convNotFound, setConvNotFound] = useState(false);

  // Fetch the analysis run
  useEffect(() => {
    fetch(`/api/analysis-runs?id=${encodeURIComponent(id)}`)
      .then(async (res) => {
        if (!res.ok) { setNotFound(true); return; }
        setRun(await res.json());
      })
      .catch(() => setNotFound(true))
      .finally(() => setRunLoading(false));
  }, [id]);

  // Fetch the conversation once we have the run's conversation_id
  useEffect(() => {
    if (!run?.conversation_id) return;
    setConvLoading(true);
    fetch(`/api/conversations?id=${encodeURIComponent(run.conversation_id)}`)
      .then(async (res) => {
        if (!res.ok) { setConvNotFound(true); return; }
        setConversation(await res.json());
      })
      .catch(() => setConvNotFound(true))
      .finally(() => setConvLoading(false));
  }, [run?.conversation_id]);

  if (runLoading || convLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (notFound || !run) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center p-6">
        <h2 className="text-base font-semibold text-slate-700 mb-2">Analysis run not found</h2>
        <p className="text-sm text-slate-400 mb-4">It may have been deleted.</p>
        <button
          onClick={() => router.push('/analysis-history')}
          className="text-sm text-blue-600 hover:text-blue-800 font-medium transition-colors"
        >
          ← Back to Analysis History
        </button>
      </div>
    );
  }

  if (convNotFound || !conversation) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center p-6">
        <h2 className="text-base font-semibold text-slate-700 mb-2">Conversation not found</h2>
        <p className="text-sm text-slate-400 mb-4">The original conversation may have been deleted.</p>
        <button
          onClick={() => router.push('/analysis-history')}
          className="text-sm text-blue-600 hover:text-blue-800 font-medium transition-colors"
        >
          ← Back to Analysis History
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Run metadata banner */}
      <div className="flex items-center gap-3 px-6 py-2 bg-amber-50 border-b border-amber-100 flex-shrink-0 text-xs text-amber-700">
        <span className="font-semibold">Viewing analysis run</span>
        <span className="text-amber-400">·</span>
        <span>{new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(run.analyzed_at))}</span>
        {run.prompt_title && (
          <>
            <span className="text-amber-400">·</span>
            <span>Prompt: <span className="font-medium">{run.prompt_title}</span></span>
          </>
        )}
        <button
          onClick={() => router.push('/analysis-history')}
          className="ml-auto text-amber-600 hover:text-amber-800 font-medium transition-colors"
        >
          ← Back to history
        </button>
      </div>

      <ConversationDetail
        conversation={conversation}
        analysisRun={run}
        readOnly
      />
    </div>
  );
}
