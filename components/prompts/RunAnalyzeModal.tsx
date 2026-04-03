'use client';

import { useState } from 'react';
import { useStore } from '@/lib/store';
import { useToast } from '@/components/layout/ToastProvider';
import type { AnalysisResult } from '@/lib/types';
import AnalysisResultView from '@/components/conversations/AnalysisResultView';

interface Props {
  promptContent: string;
  onClose: () => void;
}

export default function RunAnalyzeModal({ promptContent, onClose }: Props) {
  const { conversations } = useStore();
  const { toast } = useToast();

  const [selectedConvId, setSelectedConvId] = useState<string>('');
  const [customPrompt, setCustomPrompt] = useState(promptContent);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);

  const selectedConv = conversations.find((c) => c.id === selectedConvId);

  const handleRun = async () => {
    if (!selectedConv?.original_text) {
      toast('Selected conversation has no stored transcript', 'error');
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch('/api/conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customSystemPrompt: customPrompt,
          text: selectedConv.original_text,
          conversation_id: selectedConv.id,
        }),
      });
      if (!res.ok) throw new Error('Analysis failed');
      const data: AnalysisResult = await res.json();
      setResult(data);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-900">Test Prompt</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl">
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Conversation selector */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Select Conversation
            </label>
            <select
              value={selectedConvId}
              onChange={(e) => setSelectedConvId(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">-- Choose a conversation --</option>
              {conversations.filter((c) => c.original_text).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
            {conversations.filter((c) => c.original_text).length === 0 && (
              <p className="text-xs text-slate-400 mt-1">
                No conversations with stored transcripts found.
              </p>
            )}
          </div>

          {/* Prompt editor */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Prompt (editable for this test)
            </label>
            <textarea
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              rows={10}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono resize-y focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Result */}
          {result && (
            <div>
              <h3 className="text-sm font-semibold text-slate-700 mb-2">Test Result</h3>
              <p className="text-xs text-amber-600 mb-2">
                Note: This result is NOT saved to the dashboard.
              </p>
              <AnalysisResultView result={result} />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 p-5 border-t border-slate-200">
          <button
            onClick={onClose}
            className="border border-slate-200 hover:bg-slate-50 text-slate-700 text-sm font-medium px-4 py-2 rounded-lg"
          >
            Close
          </button>
          <button
            onClick={handleRun}
            disabled={!selectedConvId || loading}
            className="bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg flex items-center gap-2"
          >
            {loading && (
              <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            )}
            {loading ? 'Running…' : 'Run Analysis'}
          </button>
        </div>
      </div>
    </div>
  );
}
