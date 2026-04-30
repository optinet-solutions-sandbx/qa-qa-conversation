'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/lib/store';
import { useToast } from '@/components/layout/ToastProvider';
import { useConfirm } from '@/components/layout/ConfirmProvider';
import { dbDeleteConversation } from '@/lib/db-client';
import { getSegment, getVipLevel, getAccountManager, parseSummaryForTable } from '@/lib/utils';
import type { Conversation } from '@/lib/types';
import type { ConversationFilters } from '@/lib/db';
import BulkAnalysisModal from './BulkAnalysisModal';
import ConversationDetail from './ConversationDetail';

const PER_PAGE = 50;

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toISOString().slice(0, 10);
  } catch { return iso; }
}

// ── Language detection ───────────────────────────────────────────────────────
// Uses the AI-analysed language field when available; falls back to a
// character + stop-word heuristic on the conversation's text fields.

const STOP_WORDS: Record<string, RegExp> = {
  Norwegian: /\b(og|jeg|det|ikke|du|har|kan|vil|deg|hva|men|også|med|for|er|på|til|av|fra|hei|takk|vennligst|venter)\b/,
  Danish:    /\b(og|jeg|det|ikke|du|har|kan|vil|dig|hvad|men|også|med|for|er|på|til|af|fra|hej|tak|venligst)\b/,
  Swedish:   /\b(och|jag|det|inte|du|har|kan|vill|dig|vad|men|också|med|för|är|på|till|av|från|hej|tack|vänligen)\b/,
  Finnish:   /\b(ja|ei|on|se|en|ole|että|kun|tai|jos|niin|hän|olla|minä|sinä|tämä|voit|kiitos)\b/,
  German:    /\b(und|ich|das|nicht|du|hat|kann|will|dich|was|aber|auch|mit|für|ist|auf|zu|von|aus|hallo|danke|bitte|warten|möchtest|wissen)\b/,
  French:    /\b(et|je|le|la|les|du|de|un|une|est|en|pour|avec|que|qui|dans|sur|pas|plus|aussi|bonjour|merci|attendre)\b/,
  Spanish:   /\b(y|yo|el|la|los|las|de|un|una|es|en|que|se|para|con|por|también|pero|hola|gracias|esperar)\b/,
  Portuguese:/\b(e|eu|o|a|os|as|de|um|uma|é|em|que|se|para|com|por|não|também|mas|olá|obrigado|aguardar)\b/,
  Italian:   /\b(e|io|il|la|le|lo|di|un|una|è|in|che|per|con|non|si|sono|ma|come|ciao|grazie|attendere)\b/,
  Dutch:     /\b(en|ik|de|het|een|van|in|is|dat|te|die|niet|zijn|op|aan|met|ook|bij|maar|hallo|bedankt|wachten)\b/,
  English:   /\b(the|and|is|in|it|of|to|a|that|for|on|are|with|this|was|be|have|from|or|by|what|your|you|we|can|will|not|do|how|hello|thank|please|wait)\b/,
};

function detectLanguage(text: string): string | null {
  if (!text || text.trim().length < 4) return null;
  const t = text.toLowerCase();

  // Character-based shortcuts for unambiguous scripts
  if (/[øØ]/.test(t) && /[æÆ]/.test(t) && !/[äÄ]/.test(t) && !/[üÜ]/.test(t)) {
    // ø + æ → Norwegian or Danish; stop words disambiguate
    if (STOP_WORDS.Norwegian.test(t)) return 'Norwegian';
    if (STOP_WORDS.Danish.test(t))    return 'Danish';
    return 'Norwegian';
  }
  if (/ß/.test(t))                                           return 'German';
  if (/[åÅ]/.test(t) && /[äÄöÖ]/.test(t) && !/[øØ]/.test(t)) return 'Swedish';
  if (/[üÜ]/.test(t) && (/[öÖ]/.test(t) || /[äÄ]/.test(t))) return 'German';

  // Stop-word scoring — pick the language with the most matches
  let best: string | null = null;
  let bestScore = 0;
  for (const [lang, re] of Object.entries(STOP_WORDS)) {
    const matches = (t.match(new RegExp(re.source, 'g')) ?? []).length;
    if (matches > bestScore) { bestScore = matches; best = lang; }
  }
  return bestScore >= 2 ? best : null;
}


function getLanguage(conv: Conversation): string | null {
  if (conv.language) return conv.language;
  const text = [conv.title, conv.ai_subject, conv.ai_issue_summary, conv.query_type]
    .filter(Boolean).join(' ');
  return detectLanguage(text);
}

// ── Icons ────────────────────────────────────────────────────────────────────

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

function IconCheck() {
  return (
    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
    </svg>
  );
}

function IconAlert() {
  return (
    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
      <path fillRule="evenodd" d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003zM12 8.25a.75.75 0 01.75.75v3.75a.75.75 0 01-1.5 0V9a.75.75 0 01.75-.75zm0 8.25a.75.75 0 100-1.5.75.75 0 000 1.5z" clipRule="evenodd" />
    </svg>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function FilterTag({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
      {label}
    </span>
  );
}

function SegmentBadge({ segment }: { segment: 'VIP' | 'NON-VIP' | 'SoftSwiss' }) {
  if (segment === 'VIP') {
    return <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold tracking-wide text-yellow-600">VIP</span>;
  }
  if (segment === 'SoftSwiss') {
    return <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold tracking-wide text-slate-400">SoftSwiss</span>;
  }
  return <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold tracking-wide text-blue-600">NON-VIP</span>;
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

// ── Main component ───────────────────────────────────────────────────────────

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

  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewConv, setPreviewConv] = useState<import('@/lib/types').Conversation | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const openPreview = useCallback(async (id: string) => {
    setPreviewId(id);
    setPreviewConv(null);
    setPreviewLoading(true);
    try {
      const res = await fetch(`/api/conversations/${id}`);
      if (res.ok) {
        const data = await res.json();
        setPreviewConv(data.conversation);
      }
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  const closePreview = useCallback(() => {
    setPreviewId(null);
    setPreviewConv(null);
  }, []);

  const fetchPage = useCallback(async (p: number) => {
    setLoading(true);
    setSelected(new Set());
    try {
      const params = new URLSearchParams({ page: String(p), perPage: String(PER_PAGE) });
      // Multi-value filter fields may come through as either a single string
      // (URL-driven page nav) or a string[] (programmatic multi-select).
      const appendMulti = (key: string, v: string | string[] | undefined) => {
        if (v == null) return;
        if (Array.isArray(v)) v.forEach((s) => { if (s) params.append(key, s); });
        else if (v)           params.set(key, v);
      };
      appendMulti('resolution_status',        filters?.resolution_status);
      appendMulti('dissatisfaction_severity', filters?.dissatisfaction_severity);
      appendMulti('issue_category',           filters?.issue_category);
      appendMulti('language',                 filters?.language);
      appendMulti('brand',                    filters?.brand);
      appendMulti('agent_name',               filters?.agent_name);
      appendMulti('account_manager',          filters?.account_manager);
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

  const prevStoreCount = useRef(storeConvCount);
  useEffect(() => {
    if (storeConvCount > prevStoreCount.current) fetchPage(0);
    prevStoreCount.current = storeConvCount;
  }, [storeConvCount, fetchPage]);

  const enterSelectMode = () => setSelectMode(true);
  const cancelSelectMode = () => { setSelectMode(false); setSelected(new Set()); };
  const clearSelection = () => setSelected(new Set());

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleDeleteSelected = async () => {
    if (selected.size === 0) return;
    if (!await confirm(`Delete ${selected.size} conversation(s)?`, { danger: true, confirmLabel: 'Delete' })) return;
    const count = selected.size;
    const ids = Array.from(selected);
    ids.forEach((id) => { deleteConversation(id); dbDeleteConversation(id); });
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

      {/* Slide-over drawer */}
      {previewId && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/30 z-40"
            onClick={closePreview}
          />
          {/* Panel */}
          <div className="fixed inset-y-0 right-0 z-50 flex flex-col w-[90vw] max-w-7xl bg-white shadow-2xl">
            {previewLoading || !previewConv ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : (
              <ConversationDetail conversation={previewConv} onClose={closePreview} />
            )}
          </div>
        </>
      )}

      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-slate-100 bg-white flex-shrink-0">
        {selectMode ? (
          <>
            <span className="text-sm font-medium text-slate-700">
              {selected.size > 0 ? `${selected.size} selected` : 'Click rows to select'}
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
          {filters.account_manager          && <FilterTag label={`Account Manager: ${filters.account_manager}`} />}
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

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <>
            <table className="w-full text-sm border-collapse min-w-[900px]">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  {selectMode && (
                    <th className="w-10 px-3 py-2.5 text-left">
                      <input
                        type="checkbox"
                        checked={selected.size === conversations.length && conversations.length > 0}
                        onChange={(e) =>
                          e.target.checked
                            ? setSelected(new Set(conversations.map((c) => c.id)))
                            : clearSelection()
                        }
                        className="rounded border-slate-300 text-blue-600"
                      />
                    </th>
                  )}
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">Date</th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Category</th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Issue</th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Summary</th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">Segment</th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">VIP Level</th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">Chat Agent</th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">Account Manager</th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Brand</th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">Language</th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Actions</th>
                  {!selectMode && <th className="w-8" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {conversations.map((conv) => {
                  const segment = getSegment(conv);
                  const vipLevel = getVipLevel(conv);
                  const accountManager = getAccountManager(conv);
                  const aiFields = parseSummaryForTable(conv.summary);
                  const isSelected = selected.has(conv.id);

                  return (
                    <tr
                      key={conv.id}
                      onClick={(e) => {
                        if (selectMode) { toggleSelect(conv.id); return; }
                        if (e.ctrlKey || e.metaKey) {
                          window.open(`/conversations/${conv.id}`, '_blank');
                          return;
                        }
                        openPreview(conv.id);
                      }}
                      onMouseDown={(e) => {
                        if (e.button === 1) {
                          e.preventDefault();
                          window.open(`/conversations/${conv.id}`, '_blank');
                        }
                      }}
                      className={[
                        'group cursor-pointer transition-colors',
                        isSelected
                          ? 'bg-blue-50'
                          : 'hover:bg-slate-50',
                        conv.is_alert_worthy ? 'border-l-2 border-l-red-400' : '',
                      ].join(' ')}
                    >
                      {selectMode && (
                        <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                          <div
                            onClick={() => toggleSelect(conv.id)}
                            className={[
                              'w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all cursor-pointer',
                              isSelected ? 'bg-blue-500 border-blue-500 text-white' : 'border-slate-300 bg-white',
                            ].join(' ')}
                          >
                            {isSelected && <IconCheck />}
                          </div>
                        </td>
                      )}

                      {/* Date */}
                      <td className="px-3 py-2.5 whitespace-nowrap text-slate-500 text-xs">
                        {fmtDate(conv.intercom_created_at)}
                      </td>

                      {/* Category */}
                      <td className="px-3 py-2.5 max-w-[180px]">
                        <span className="block truncate text-slate-700" title={aiFields.category ?? undefined}>
                          {aiFields.category ?? <span className="text-slate-300">—</span>}
                        </span>
                      </td>

                      {/* Issue */}
                      <td className="px-3 py-2.5 max-w-[200px]">
                        <div className="flex items-center gap-1.5">
                          {conv.is_alert_worthy && (
                            <span className="text-red-500 shrink-0" title={conv.alert_reason ?? 'Alert'}>
                              <IconAlert />
                            </span>
                          )}
                          <span className="block truncate text-slate-800 font-medium" title={aiFields.issue ?? conv.ai_issue_summary ?? undefined}>
                            {aiFields.issue || conv.ai_issue_summary || <span className="text-slate-300 font-normal">—</span>}
                          </span>
                        </div>
                      </td>

                      {/* Summary */}
                      <td className="px-3 py-2.5 max-w-[260px]">
                        <span className="block truncate text-slate-600 text-xs" title={aiFields.summary ?? undefined}>
                          {aiFields.summary ?? <span className="text-slate-300">—</span>}
                        </span>
                      </td>

                      {/* Segment */}
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {segment ? <SegmentBadge segment={segment} /> : <span className="text-slate-300 text-xs">—</span>}
                      </td>

                      {/* VIP Level */}
                      <td className="px-3 py-2.5 max-w-[160px]">
                        <span className="block truncate text-slate-600 text-xs" title={vipLevel ?? undefined}>
                          {vipLevel ?? <span className="text-slate-300">—</span>}
                        </span>
                      </td>

                      {/* Chat Agent */}
                      <td className="px-3 py-2.5 whitespace-nowrap text-slate-600 text-xs">
                        {conv.agent_name ?? <span className="text-slate-300">—</span>}
                      </td>

                      {/* Account Manager */}
                      <td className="px-3 py-2.5 whitespace-nowrap text-slate-600 text-xs">
                        {accountManager ?? <span className="text-slate-300">—</span>}
                      </td>

                      {/* Brand */}
                      <td className="px-3 py-2.5 max-w-[120px]">
                        <span className="block truncate text-slate-600 text-xs" title={conv.brand ?? undefined}>
                          {conv.brand ?? <span className="text-slate-300">—</span>}
                        </span>
                      </td>

                      {/* Language */}
                      <td className="px-3 py-2.5 whitespace-nowrap text-slate-600 text-xs">
                        {getLanguage(conv) ?? <span className="text-slate-300">—</span>}
                      </td>

                      {/* Actions */}
                      <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-2">
                          <a
                            href={`/conversations/${conv.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] font-medium text-blue-600 hover:text-blue-800 hover:underline whitespace-nowrap"
                          >
                            Chat
                          </a>
                          <span className="text-slate-200">·</span>
                          <span
                            className="text-[11px] font-medium text-slate-400 hover:text-slate-600 whitespace-nowrap cursor-pointer"
                          >
                            Account
                          </span>
                        </div>
                      </td>

                      {/* Delete action */}
                      {!selectMode && (
                        <td className="px-2 py-2.5">
                          <button
                            onClick={(e) => handleDeleteOne(conv.id, e)}
                            className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-slate-400 hover:text-red-500 hover:bg-red-50"
                            title="Delete"
                          >
                            <IconTrash />
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-t border-slate-100 bg-white">
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
