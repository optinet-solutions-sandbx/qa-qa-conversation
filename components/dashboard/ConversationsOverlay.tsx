'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { Conversation } from '@/lib/types';
import { getSegment, getVipLevel, getAccountManager, getBacklinkFull, parseSummaryForTable } from '@/lib/utils';

const INTERCOM_APP_ID = process.env.NEXT_PUBLIC_INTERCOM_APP_ID ?? '';

interface Props {
  filters: Record<string, string>;
  title: string;
  onClose: () => void;
}

const PER_PAGE = 50;

export default function ConversationsOverlay({ filters, title, onClose }: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [total, setTotal]                 = useState(0);
  const [page, setPage]                   = useState(0);
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState<string | null>(null);
  const overlayRef                        = useRef<HTMLDivElement>(null);

  const totalPages = Math.ceil(total / PER_PAGE);

  const fetchPage = useCallback(async (p: number) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(p), perPage: String(PER_PAGE) });
      Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
      const res = await fetch(`/api/conversations?${params}`);
      if (!res.ok) throw new Error('Failed to load conversations');
      const data = await res.json();
      setConversations(data.conversations ?? data.items ?? []);
      setTotal(data.total ?? 0);
      setPage(p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { fetchPage(0); }, [fetchPage]);

  // Close on ESC
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Close on backdrop click
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  function fmtDate(iso: string | null) {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={handleBackdropClick}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-[95vw] max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 flex-shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-slate-800">{title}</h2>
            {!loading && (
              <p className="text-xs text-slate-400 mt-0.5">
                {total.toLocaleString()} conversation{total !== 1 ? 's' : ''}
                {totalPages > 1 && ` · page ${page + 1} of ${totalPages}`}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto">
          {loading && (
            <div className="flex items-center justify-center py-20 gap-2 text-slate-400 text-sm">
              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              Loading…
            </div>
          )}
          {error && !loading && (
            <div className="p-6 text-sm text-red-600">{error}</div>
          )}
          {!loading && !error && conversations.length === 0 && (
            <div className="flex items-center justify-center py-20 text-sm text-slate-400">No conversations found.</div>
          )}
          {!loading && !error && conversations.length > 0 && (
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 bg-slate-50 z-10">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap">Date</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap">Category</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap">Issue</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap">Summary</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap">Segment</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap">VIP Level</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap">Player Name</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap">Chat Agent</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap">Account Manager</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap">Brand</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap">Language</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap">Links</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {conversations.map((conv) => (
                  <tr key={conv.id} className="hover:bg-blue-50/40 transition-colors">
                    {(() => {
                      const aiFields = parseSummaryForTable(conv.summary);
                      return (
                        <>
                          <td className="px-4 py-3 whitespace-nowrap text-xs text-slate-500">
                            {fmtDate(conv.intercom_created_at)}
                          </td>
                          <td className="px-4 py-3 max-w-[160px]">
                            <span className="text-xs text-slate-600 truncate block" title={aiFields.category ?? ''}>
                              {aiFields.category ?? '—'}
                            </span>
                          </td>
                          <td className="px-4 py-3 max-w-[200px]">
                            <span className="text-xs text-slate-500 truncate block" title={aiFields.issue ?? conv.ai_issue_summary ?? ''}>
                              {aiFields.issue || conv.ai_issue_summary || '—'}
                            </span>
                          </td>
                          <td className="px-4 py-3 max-w-[260px]">
                            <span className="text-xs text-slate-500 truncate block" title={aiFields.summary ?? ''}>
                              {aiFields.summary ?? '—'}
                            </span>
                          </td>
                        </>
                      );
                    })()}
                    <td className="px-4 py-3 whitespace-nowrap">
                      {(() => {
                        const seg = getSegment(conv);
                        if (!seg) return <span className="text-xs text-slate-300">—</span>;
                        if (seg === 'VIP') return <span className="text-[11px] font-bold px-2 py-0.5 rounded text-yellow-600">VIP</span>;
                        if (seg === 'SoftSwiss') return <span className="text-[11px] font-bold px-2 py-0.5 rounded text-slate-400">SoftSwiss</span>;
                        return <span className="text-[11px] font-bold px-2 py-0.5 rounded text-blue-600">NON-VIP</span>;
                      })()}
                    </td>
                    <td className="px-4 py-3 max-w-[140px]">
                      <span className="text-xs text-slate-600 truncate block" title={getVipLevel(conv) ?? undefined}>
                        {getVipLevel(conv) ?? <span className="text-slate-300">—</span>}
                      </span>
                    </td>
                    <td className="px-4 py-3 max-w-[160px]">
                      <span className="text-xs text-slate-600 truncate block" title={conv.player_name ?? undefined}>
                        {conv.player_name ?? <span className="text-slate-300">—</span>}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-slate-600">
                      {conv.agent_name ?? '—'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-slate-600">
                      {getAccountManager(conv) ?? <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-slate-600">
                      {conv.brand ?? '—'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-slate-600">
                      {conv.language ?? '—'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        {conv.intercom_id && INTERCOM_APP_ID ? (
                          <a
                            href={`https://app.intercom.com/a/apps/${INTERCOM_APP_ID}/conversations/${conv.intercom_id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] font-semibold text-sky-600 hover:text-sky-800 hover:underline"
                          >
                            Chat
                          </a>
                        ) : (
                          <span className="text-[11px] text-slate-300">Chat</span>
                        )}
                        <span className="text-slate-200 select-none">·</span>
                        {getBacklinkFull(conv) ? (
                          <a
                            href={getBacklinkFull(conv)!}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] font-semibold text-sky-600 hover:text-sky-800 hover:underline"
                          >
                            Account
                          </a>
                        ) : (
                          <span className="text-[11px] text-slate-300">Account</span>
                        )}
                        <span className="text-slate-200 select-none">·</span>
                        <a
                          href={`/conversations/${conv.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 hover:underline"
                        >
                          Analysis
                        </a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer pagination */}
        {!loading && totalPages > 1 && (
          <div className="flex items-center justify-between px-6 py-3 border-t border-slate-100 flex-shrink-0">
            <p className="text-xs text-slate-400">
              Showing {page * PER_PAGE + 1}–{Math.min((page + 1) * PER_PAGE, total)} of {total.toLocaleString()}
            </p>
            <div className="flex items-center gap-1">
              <button
                disabled={page === 0}
                onClick={() => fetchPage(page - 1)}
                className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Previous
              </button>
              <button
                disabled={page >= totalPages - 1}
                onClick={() => fetchPage(page + 1)}
                className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
