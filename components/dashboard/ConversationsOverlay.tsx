'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { Conversation } from '@/lib/types';
import { getSegment, getVipLevel, getAccountManager, getBacklinkFull, parseSummaryForTable, cleanPlayerName } from '@/lib/utils';

const INTERCOM_APP_ID = process.env.NEXT_PUBLIC_INTERCOM_APP_ID ?? '';

interface Props {
  // Each filter accepts a single value or multiple (multi-select). Multi-values
  // are forwarded to /api/conversations as repeated query params, which the
  // route reads via getAll() and the DB layer treats as an OR-set.
  filters: Record<string, string | string[]>;
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
  const [downloading, setDownloading]     = useState(false);
  const overlayRef                        = useRef<HTMLDivElement>(null);

  const totalPages = Math.ceil(total / PER_PAGE);

  const fetchPage = useCallback(async (p: number) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(p), perPage: String(PER_PAGE) });
      Object.entries(filters).forEach(([k, v]) => {
        if (Array.isArray(v)) v.forEach((s) => { if (s) params.append(k, s); });
        else if (v)           params.set(k, v);
      });
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

  // Multi-value filters arrive as string[] when several values are selected;
  // use the first as the preferred display for the issue/category column.
  function pickFirst(v: string | string[] | undefined): string | null {
    if (!v) return null;
    return Array.isArray(v) ? (v[0] ?? null) : v;
  }

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function filenameDateSuffix(): string {
    const from = pickFirst(filters.dateFrom);
    const to   = pickFirst(filters.dateTo);
    if (from && to && from !== to) return `${from}_to_${to}`;
    return from ?? to ?? todayISO();
  }

  // RFC4180-ish escape: wrap in quotes when the value contains a comma, quote,
  // or newline; double any embedded quotes.
  function csvCell(v: unknown): string {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  async function handleDownload() {
    if (downloading || total === 0) return;
    setDownloading(true);
    try {
      const params = new URLSearchParams({ page: '0', perPage: '10000' });
      Object.entries(filters).forEach(([k, v]) => {
        if (Array.isArray(v)) v.forEach((s) => { if (s) params.append(k, s); });
        else if (v)           params.set(k, v);
      });
      const res = await fetch(`/api/conversations?${params}`);
      if (!res.ok) throw new Error('Failed to load conversations');
      const data = await res.json();
      const rows: Conversation[] = data.conversations ?? data.items ?? [];

      const headers = [
        'Date', 'Category', 'Issue', 'Summary', 'Segment', 'VIP Level',
        'Player Name', 'Chat Agent', 'Account Manager', 'Brand', 'Language',
        'Country', 'Chat URL', 'Account URL', 'Analysis URL',
      ];
      const lines = [headers.join(',')];
      for (const conv of rows) {
        const ai = parseSummaryForTable(conv.summary, {
          issue:    pickFirst(filters.issue_item),
          category: pickFirst(filters.issue_category),
        });
        const chatUrl = conv.intercom_id && INTERCOM_APP_ID
          ? `https://app.intercom.com/a/apps/${INTERCOM_APP_ID}/conversations/${conv.intercom_id}`
          : '';
        const analysisUrl = typeof window !== 'undefined'
          ? `${window.location.origin}/conversations/${conv.id}`
          : `/conversations/${conv.id}`;
        lines.push([
          fmtDate(conv.intercom_created_at),
          ai.category ?? '',
          ai.issue || conv.ai_issue_summary || '',
          ai.summary ?? '',
          getSegment(conv) ?? '',
          getVipLevel(conv) ?? '',
          cleanPlayerName(conv.player_name) ?? '',
          conv.agent_name ?? '',
          getAccountManager(conv) ?? '',
          conv.brand ?? '',
          conv.language ?? '',
          conv.player_country ?? '',
          chatUrl,
          getBacklinkFull(conv) ?? '',
          analysisUrl,
        ].map(csvCell).join(','));
      }

      // UTF-8 BOM so Excel reads accented names (e.g. "NOORA LEPPÄ") correctly.
      const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `conversations_${filenameDateSuffix()}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDownloading(false);
    }
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
          <div className="flex items-center gap-1">
            <button
              onClick={handleDownload}
              disabled={loading || downloading || total === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label="Download CSV"
              title="Download CSV"
            >
              {downloading ? (
                <div className="w-3.5 h-3.5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
                </svg>
              )}
              <span>{downloading ? 'Preparing…' : 'Download'}</span>
            </button>
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
                  <th className="text-left px-4 py-3 text-[13px] font-semibold text-slate-700 uppercase tracking-wide whitespace-nowrap">Date</th>
                  <th className="text-left px-4 py-3 text-[13px] font-semibold text-slate-700 uppercase tracking-wide whitespace-nowrap">Category</th>
                  <th className="text-left px-4 py-3 text-[13px] font-semibold text-slate-700 uppercase tracking-wide whitespace-nowrap">Issue</th>
                  <th className="text-left px-4 py-3 text-[13px] font-semibold text-slate-700 uppercase tracking-wide whitespace-nowrap">Summary</th>
                  <th className="text-left px-4 py-3 text-[13px] font-semibold text-slate-700 uppercase tracking-wide whitespace-nowrap">Segment</th>
                  <th className="text-left px-4 py-3 text-[13px] font-semibold text-slate-700 uppercase tracking-wide whitespace-nowrap">VIP Level</th>
                  <th className="text-left px-4 py-3 text-[13px] font-semibold text-slate-700 uppercase tracking-wide whitespace-nowrap">Player Name</th>
                  <th className="text-left px-4 py-3 text-[13px] font-semibold text-slate-700 uppercase tracking-wide whitespace-nowrap">Chat Agent</th>
                  <th className="text-left px-4 py-3 text-[13px] font-semibold text-slate-700 uppercase tracking-wide whitespace-nowrap">Account Manager</th>
                  <th className="text-left px-4 py-3 text-[13px] font-semibold text-slate-700 uppercase tracking-wide whitespace-nowrap">Brand</th>
                  <th className="text-left px-4 py-3 text-[13px] font-semibold text-slate-700 uppercase tracking-wide whitespace-nowrap">Language</th>
                  <th className="text-left px-4 py-3 text-[13px] font-semibold text-slate-700 uppercase tracking-wide whitespace-nowrap">Country</th>
                  <th className="text-left px-4 py-3 text-[13px] font-semibold text-slate-700 uppercase tracking-wide whitespace-nowrap">Links</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {conversations.map((conv) => (
                  <tr key={conv.id} className="hover:bg-blue-50/40 transition-colors">
                    {(() => {
                      const aiFields = parseSummaryForTable(conv.summary, {
                        issue:    pickFirst(filters.issue_item),
                        category: pickFirst(filters.issue_category),
                      });
                      return (
                        <>
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-slate-700">
                            {fmtDate(conv.intercom_created_at)}
                          </td>
                          <td className="px-4 py-3 max-w-[160px]">
                            <span className="text-sm text-slate-800 truncate block" title={aiFields.category ?? ''}>
                              {aiFields.category ?? '—'}
                            </span>
                          </td>
                          <td className="px-4 py-3 max-w-[200px]">
                            <span className="text-sm text-slate-700 truncate block" title={aiFields.issue ?? conv.ai_issue_summary ?? ''}>
                              {aiFields.issue || conv.ai_issue_summary || '—'}
                            </span>
                          </td>
                          <td className="px-4 py-3 max-w-[260px]">
                            <span className="text-sm text-slate-700 truncate block" title={aiFields.summary ?? ''}>
                              {aiFields.summary ?? '—'}
                            </span>
                          </td>
                        </>
                      );
                    })()}
                    <td className="px-4 py-3 whitespace-nowrap">
                      {(() => {
                        const seg = getSegment(conv);
                        if (!seg) return <span className="text-xs text-slate-400">—</span>;
                        if (seg === 'VIP') return <span className="text-xs font-bold px-2 py-0.5 rounded text-yellow-600">VIP</span>;
                        if (seg === 'SoftSwiss') return <span className="text-xs font-bold px-2 py-0.5 rounded text-slate-600">SoftSwiss</span>;
                        return <span className="text-xs font-bold px-2 py-0.5 rounded text-blue-600">NON-VIP</span>;
                      })()}
                    </td>
                    <td className="px-4 py-3 max-w-[140px]">
                      <span className="text-sm text-slate-800 truncate block" title={getVipLevel(conv) ?? undefined}>
                        {getVipLevel(conv) ?? <span className="text-slate-400">—</span>}
                      </span>
                    </td>
                    <td className="px-4 py-3 max-w-[160px]">
                      {(() => {
                        const name = cleanPlayerName(conv.player_name);
                        return (
                          <span className="text-sm text-slate-800 truncate block" title={name ?? undefined}>
                            {name ?? <span className="text-slate-400">—</span>}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-slate-800">
                      {conv.agent_name ?? '—'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-slate-800">
                      {getAccountManager(conv) ?? <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-slate-800">
                      {conv.brand ?? '—'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-slate-800">
                      {conv.language ?? '—'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-slate-800">
                      {conv.player_country ?? '—'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        {conv.intercom_id && INTERCOM_APP_ID ? (
                          <a
                            href={`https://app.intercom.com/a/apps/${INTERCOM_APP_ID}/conversations/${conv.intercom_id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs font-semibold text-sky-600 hover:text-sky-800 hover:underline"
                          >
                            Chat
                          </a>
                        ) : (
                          <span className="text-xs text-slate-400">Chat</span>
                        )}
                        <span className="text-slate-200 select-none">·</span>
                        {getBacklinkFull(conv) ? (
                          <a
                            href={getBacklinkFull(conv)!}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs font-semibold text-red-600 hover:text-red-800 hover:underline"
                          >
                            Account
                          </a>
                        ) : (
                          <span className="text-xs text-slate-400">Account</span>
                        )}
                        <span className="text-slate-200 select-none">·</span>
                        <a
                          href={`/conversations/${conv.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 hover:underline"
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
