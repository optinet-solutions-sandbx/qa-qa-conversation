'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/lib/store';
import { useToast } from '@/components/layout/ToastProvider';
import { useConfirm } from '@/components/layout/ConfirmProvider';
import { dbDeleteConversation } from '@/lib/db-client';
import type { Conversation } from '@/lib/types';
import type { ConversationFilters } from '@/lib/db';
import ConversationCard from './ConversationCard';
import BulkAnalysisModal from './BulkAnalysisModal';

const PER_PAGE = 24;

function IconChat() {
  return (
    <svg className="w-12 h-12 text-slate-300" fill="none" stroke="currentColor" strokeWidth={1.25} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
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

function IconChevronLeft() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
    </svg>
  );
}

function IconChevronRight() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
    </svg>
  );
}

function FilterTag({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
      {label}
    </span>
  );
}

function getPageNumbers(current: number, totalPages: number): (number | '...')[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i);
  const pages: (number | '...')[] = [];
  const add = (n: number | '...') => {
    if (pages[pages.length - 1] !== n) pages.push(n);
  };
  add(0);
  if (current > 2) add('...');
  for (let i = Math.max(1, current - 1); i <= Math.min(totalPages - 2, current + 1); i++) add(i);
  if (current < totalPages - 3) add('...');
  add(totalPages - 1);
  return pages;
}

export default function ConversationList({ filters }: { filters?: ConversationFilters }) {
  const { deleteConversation } = useStore();
  const storeConvCount = useStore((s) => s.conversations.length);
  const { toast } = useToast();
  const confirm = useConfirm();
  const router = useRouter();

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);

  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBulkAnalysis, setShowBulkAnalysis] = useState(false);

  const fetchPage = useCallback(async (p: number) => {
    setLoading(true);
    setSelected(new Set());
    try {
      const params = new URLSearchParams({ page: String(p), perPage: String(PER_PAGE) });
      if (filters?.resolution_status)        params.set('resolution_status',        filters.resolution_status);
      if (filters?.dissatisfaction_severity) params.set('dissatisfaction_severity', filters.dissatisfaction_severity);
      if (filters?.issue_category)           params.set('issue_category',           filters.issue_category);
      if (filters?.language)                 params.set('language',                 filters.language);
      if (filters?.brand)                    params.set('brand',                    filters.brand);
      if (filters?.agent_name)               params.set('agent_name',               filters.agent_name);
      if (filters?.dateFrom)                 params.set('dateFrom',                 filters.dateFrom);
      if (filters?.dateTo)                   params.set('dateTo',                   filters.dateTo);
      if (filters?.analyzed !== undefined)   params.set('analyzed',                 String(filters.analyzed));
      if (filters?.alert_worthy)             params.set('alert_worthy',             'true');
      const res = await fetch(`/api/conversations?${params}`);
      if (!res.ok) throw new Error('Failed to load conversations');
      const data = await res.json();
      setConversations(data.conversations);
      setTotal(data.total);
      setPage(p);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { fetchPage(0); }, [fetchPage]);

  // Refetch page 0 when a new conversation is added to the store
  const prevStoreCount = useRef(storeConvCount);
  useEffect(() => {
    if (storeConvCount > prevStoreCount.current) {
      fetchPage(0);
    }
    prevStoreCount.current = storeConvCount;
  }, [storeConvCount, fetchPage]);

  const enterSelectMode = () => setSelectMode(true);

  const cancelSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  const clearSelection = () => setSelected(new Set());

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDeleteSelected = async () => {
    if (selected.size === 0) return;
    if (!await confirm(`Delete ${selected.size} conversation(s)?`, { danger: true, confirmLabel: 'Delete' })) return;
    const count = selected.size;
    const ids = Array.from(selected);
    ids.forEach((id) => {
      deleteConversation(id);
      dbDeleteConversation(id);
    });
    cancelSelectMode();
    toast(`${count} conversation(s) deleted`, 'success');
    const newTotal = total - count;
    const newTotalPages = Math.max(1, Math.ceil(newTotal / PER_PAGE));
    fetchPage(page >= newTotalPages ? Math.max(0, newTotalPages - 1) : page);
  };

  const handleDeleteOne = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!await confirm('Delete this conversation?', { danger: true, confirmLabel: 'Delete' })) return;
    deleteConversation(id);
    dbDeleteConversation(id);
    toast('Conversation deleted', 'success');
    const newTotal = total - 1;
    const newTotalPages = Math.max(1, Math.ceil(newTotal / PER_PAGE));
    fetchPage(page >= newTotalPages ? Math.max(0, newTotalPages - 1) : page);
  };

  const totalPages = Math.ceil(total / PER_PAGE);
  const selectedConversations = conversations.filter((c) => selected.has(c.id));

  if (!loading && conversations.length === 0 && total === 0) {
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
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {showBulkAnalysis && (
        <BulkAnalysisModal
          conversations={selectedConversations}
          onClose={() => setShowBulkAnalysis(false)}
          onComplete={() => { setShowBulkAnalysis(false); cancelSelectMode(); }}
        />
      )}

      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-slate-100 bg-white flex-shrink-0">
        {selectMode ? (
          <>
            <span className="text-sm font-medium text-slate-700">
              {selected.size > 0 ? `${selected.size} selected` : 'Tap cards to select'}
            </span>
            <div className="flex items-center gap-2">
              {selected.size > 0 && (
                <>
                  <button
                    onClick={() => setShowBulkAnalysis(true)}
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-lg transition-colors"
                  >
                    Run Analysis
                  </button>
                  <button
                    onClick={handleDeleteSelected}
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-white bg-red-500 hover:bg-red-600 px-3 py-1.5 rounded-lg transition-colors"
                  >
                    <IconTrash />
                    Delete
                  </button>
                  <button
                    onClick={clearSelection}
                    className="text-sm font-medium text-slate-500 hover:text-slate-700 px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors"
                  >
                    Clear
                  </button>
                </>
              )}
              {selected.size < conversations.length && (
                <button
                  onClick={() => setSelected(new Set(conversations.map((c) => c.id)))}
                  className="text-sm font-medium text-slate-500 hover:text-slate-700 px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors"
                >
                  Select All
                </button>
              )}
              <button
                onClick={cancelSelectMode}
                className="text-sm font-medium text-slate-500 hover:text-slate-700 px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors"
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <span className="text-xs text-slate-400">
              {loading ? 'Loading…' : `${total} conversation${total !== 1 ? 's' : ''}`}
            </span>
            <button
              onClick={enterSelectMode}
              className="text-sm font-medium text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors"
            >
              Select
            </button>
          </>
        )}
      </div>

      {/* Active filter banner */}
      {filters && Object.keys(filters).length > 0 && (
        <div className="flex items-center gap-2 px-4 sm:px-6 py-2 bg-blue-50 border-b border-blue-100 flex-shrink-0 flex-wrap">
          <span className="text-xs font-medium text-blue-700">Filtered by:</span>
          {filters.resolution_status        && <FilterTag label={`Resolution: ${filters.resolution_status}`} />}
          {filters.dissatisfaction_severity && <FilterTag label={`Severity: ${filters.dissatisfaction_severity}`} />}
          {filters.issue_category           && <FilterTag label={`Category: ${filters.issue_category}`} />}
          {filters.language                 && <FilterTag label={`Language: ${filters.language}`} />}
          {filters.brand                    && <FilterTag label={`Brand: ${filters.brand}`} />}
          {filters.agent_name               && <FilterTag label={`Agent: ${filters.agent_name}`} />}
          {(filters.dateFrom || filters.dateTo) && (
            <FilterTag label={`Date: ${filters.dateFrom ?? ''}${filters.dateFrom && filters.dateTo ? ' – ' : ''}${filters.dateTo ?? ''}`} />
          )}
          {filters.analyzed === true  && <FilterTag label="Analyzed" />}
          {filters.analyzed === false && <FilterTag label="Unanalyzed" />}
          {filters.alert_worthy       && <FilterTag label="Alert-worthy" />}
          <button
            onClick={() => router.push('/')}
            className="ml-auto text-xs text-blue-500 hover:text-blue-700 underline"
          >
            Clear filter
          </button>
        </div>
      )}

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {conversations.map((conv) => (
                <ConversationCard
                  key={conv.id}
                  conversation={conv}
                  selectMode={selectMode}
                  selected={selected.has(conv.id)}
                  onToggleSelect={() => toggleSelect(conv.id)}
                  onClick={() => !selectMode && router.push(`/conversations/${conv.id}`)}
                  onDelete={(e) => handleDeleteOne(conv.id, e)}
                />
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-6">
                <p className="text-xs text-slate-400">
                  Page {page + 1} of {totalPages} — {total} conversations
                </p>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => fetchPage(page - 1)}
                    disabled={page === 0}
                    className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <IconChevronLeft />
                  </button>
                  {getPageNumbers(page, totalPages).map((p, i) =>
                    p === '...' ? (
                      <span key={`ellipsis-${i}`} className="w-8 h-8 flex items-center justify-center text-xs text-slate-400">
                        …
                      </span>
                    ) : (
                      <button
                        key={`page-${p}`}
                        onClick={() => fetchPage(p as number)}
                        className={`w-8 h-8 rounded-lg text-xs font-medium transition-colors ${
                          p === page
                            ? 'bg-slate-800 text-white'
                            : 'border border-slate-200 text-slate-500 hover:bg-slate-50'
                        }`}
                      >
                        {p + 1}
                      </button>
                    )
                  )}
                  <button
                    onClick={() => fetchPage(page + 1)}
                    disabled={page >= totalPages - 1}
                    className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <IconChevronRight />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
