'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useToast } from '@/components/layout/ToastProvider';
import { useConfirm } from '@/components/layout/ConfirmProvider';
import type { AiQuery } from '@/lib/types';

// ── Types ─────────────────────────────────────────────────────────────────

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  error?: string;
}

interface AskResult {
  id: string | null;
  question: string;
  answer: string;
  tools_used: ToolCall[];
  is_irrelevant: boolean;
  created_at: string;
}

// ── Icons ─────────────────────────────────────────────────────────────────

function IconSparkle() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
    </svg>
  );
}
function IconSearch() {
  return (
    <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
    </svg>
  );
}
function IconArrowUp() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
    </svg>
  );
}
function IconTrash() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
    </svg>
  );
}
function IconChevronDown() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
    </svg>
  );
}
function IconChevronRight() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
    </svg>
  );
}

// ── Suggestions ───────────────────────────────────────────────────────────

const SUGGESTIONS = [
  'What are the top customer concerns in the last 30 days?',
  'Who is the best-performing agent last month?',
  'How many conversations were unresolved last week?',
  'What is the sentiment breakdown for the last 7 days?',
  'Show me recent alert-worthy conversations.',
  'Which query type is most common this month?',
];

// ── Answer renderer ───────────────────────────────────────────────────────

function AnswerBlock({ result }: { result: AskResult }) {
  const [showSources, setShowSources] = useState(false);

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
      {/* Question */}
      <div className="flex items-start gap-3">
        <div className="w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center text-slate-600 text-xs font-bold shrink-0 mt-0.5">Q</div>
        <p className="text-sm text-slate-700 font-medium flex-1">{result.question}</p>
      </div>

      {/* Answer */}
      <div className="flex items-start gap-3">
        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-indigo-500 flex items-center justify-center text-white shrink-0 mt-0.5">
          <IconSparkle />
        </div>
        <div className="text-sm text-slate-700 leading-relaxed flex-1 whitespace-pre-wrap">
          {result.answer}
        </div>
      </div>

      {/* Tool calls collapsible */}
      {result.tools_used.length > 0 && (
        <div className="pt-2 border-t border-slate-100">
          <button
            onClick={() => setShowSources(!showSources)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-700"
          >
            {showSources ? <IconChevronDown /> : <IconChevronRight />}
            {result.tools_used.length} data source{result.tools_used.length !== 1 ? 's' : ''} used
          </button>

          {showSources && (
            <div className="mt-3 space-y-2">
              {result.tools_used.map((t, i) => (
                <div key={i} className="bg-slate-50 rounded-lg px-3 py-2 text-xs">
                  <div className="font-mono font-semibold text-slate-700">{t.tool}</div>
                  <div className="text-slate-500 mt-0.5">
                    {Object.entries(t.args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}
                  </div>
                  {t.error ? (
                    <div className="text-red-500 mt-1">Error: {t.error}</div>
                  ) : (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-slate-400 hover:text-slate-600">View data</summary>
                      <pre className="mt-1 text-[11px] text-slate-600 whitespace-pre-wrap break-words bg-white rounded p-2 border border-slate-200 max-h-48 overflow-auto">
                        {JSON.stringify(t.result, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

type Tab = 'ask' | 'history';

export default function AskAIPage() {
  const { toast } = useToast();
  const confirm = useConfirm();

  const [tab, setTab] = useState<Tab>('ask');
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [current, setCurrent] = useState<AskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // History state
  const [history, setHistory] = useState<AiQuery[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // ── Ask ─────────────────────────────────────────────────────────────────

  const ask = async (q: string) => {
    if (!q.trim()) return;
    setAsking(true);
    setError(null);
    setCurrent(null);
    try {
      const res = await fetch('/api/ask-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to get answer');
      setCurrent(data as AskResult);
      setQuestion('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAsking(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    ask(question);
  };

  const useSuggestion = (s: string) => {
    setQuestion(s);
    inputRef.current?.focus();
  };

  // ── History ─────────────────────────────────────────────────────────────

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch('/api/ai-queries?page=0&perPage=50');
      if (!res.ok) return;
      const data = await res.json();
      setHistory(data.queries as AiQuery[]);
      setHistoryTotal(data.total);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'history') loadHistory();
  }, [tab, loadHistory]);

  const deleteQuery = async (id: string) => {
    if (!await confirm('Delete this Q&A?', { danger: true, confirmLabel: 'Delete' })) return;
    const res = await fetch(`/api/ai-queries?id=${id}`, { method: 'DELETE' });
    if (res.ok) {
      setHistory((prev) => prev.filter((q) => q.id !== id));
      setHistoryTotal((t) => t - 1);
      toast('Deleted', 'success');
    } else {
      toast('Delete failed', 'error');
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">

      {/* Header with tabs */}
      <div className="bg-white border-b border-slate-200 flex-shrink-0 px-6 py-3 flex items-center gap-4">
        <h1 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
          <span className="text-indigo-500"><IconSparkle /></span>
          Ask AI
        </h1>
        <div className="flex items-center gap-1 ml-auto">
          <button
            onClick={() => setTab('ask')}
            className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${
              tab === 'ask' ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100'
            }`}
          >
            Ask
          </button>
          <button
            onClick={() => setTab('history')}
            className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${
              tab === 'history' ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100'
            }`}
          >
            History {historyTotal > 0 && `(${historyTotal})`}
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {tab === 'ask' ? (
          <div className="max-w-3xl mx-auto px-4 py-8 sm:py-16">

            {/* Hero */}
            {!current && !asking && (
              <div className="text-center mb-8">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-500 text-white flex items-center justify-center mx-auto mb-4">
                  <IconSparkle />
                </div>
                <h2 className="text-lg font-semibold text-slate-800 mb-1">Ask about your support data</h2>
                <p className="text-xs text-slate-400">Customer concerns, agent performance, resolution trends — grounded in your database.</p>
              </div>
            )}

            {/* Search box */}
            <form onSubmit={handleSubmit} className="mb-6">
              <div className="relative">
                <span className="absolute left-4 top-4 pointer-events-none"><IconSearch /></span>
                <textarea
                  ref={inputRef}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      ask(question);
                    }
                  }}
                  placeholder="Ask a question about customer support conversations..."
                  rows={1}
                  maxLength={500}
                  disabled={asking}
                  className="w-full pl-12 pr-14 py-3.5 border border-slate-200 rounded-2xl text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 shadow-sm hover:shadow-md transition-shadow resize-none"
                  style={{ minHeight: 56 }}
                />
                <button
                  type="submit"
                  disabled={asking || !question.trim()}
                  className="absolute right-3 top-3 w-9 h-9 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white flex items-center justify-center transition-colors"
                  aria-label="Ask"
                >
                  {asking
                    ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    : <IconArrowUp />}
                </button>
              </div>
            </form>

            {/* Suggestions */}
            {!current && !asking && (
              <div className="flex flex-wrap gap-2 justify-center">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => useSuggestion(s)}
                    className="text-xs text-slate-600 bg-white hover:bg-slate-50 border border-slate-200 px-3 py-1.5 rounded-full transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

            {/* Loading */}
            {asking && (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex items-center gap-3">
                <span className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-sm text-slate-500">Thinking…</span>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
                {error}
              </div>
            )}

            {/* Answer */}
            {current && <AnswerBlock result={current} />}
          </div>
        ) : (
          // ── History ──────────────────────────────────────────────────────
          <div className="max-w-3xl mx-auto px-4 py-6 space-y-2">
            {historyLoading && (
              <div className="flex items-center justify-center py-16">
                <span className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              </div>
            )}

            {!historyLoading && history.length === 0 && (
              <div className="text-center py-20">
                <p className="text-sm text-slate-500">No past questions yet.</p>
                <p className="text-xs text-slate-400 mt-1">Ask something to get started.</p>
              </div>
            )}

            {!historyLoading && history.map((q) => {
              const expanded = expandedId === q.id;
              return (
                <div key={q.id} className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="flex items-start gap-3 px-4 py-3">
                    <button
                      onClick={() => setExpandedId(expanded ? null : q.id)}
                      className="flex-1 text-left"
                    >
                      <p className="text-xs text-slate-400 mb-0.5">
                        {new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(q.created_at))}
                        {q.is_irrelevant && <span className="ml-2 text-amber-600">· Off-topic</span>}
                      </p>
                      <p className="text-sm font-medium text-slate-800 line-clamp-2">{q.question}</p>
                    </button>
                    <button
                      onClick={() => deleteQuery(q.id)}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0"
                      title="Delete"
                    >
                      <IconTrash />
                    </button>
                  </div>
                  {expanded && (
                    <div className="px-4 pb-4 pt-1 text-sm text-slate-600 whitespace-pre-wrap border-t border-slate-100">
                      {q.answer}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
