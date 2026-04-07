'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/lib/store';
import { useToast } from '@/components/layout/ToastProvider';
import { useConfirm } from '@/components/layout/ConfirmProvider';
import { dbDeleteConversation } from '@/lib/db-client';
import ConversationCard from './ConversationCard';
import BulkAnalysisModal from './BulkAnalysisModal';

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

export default function ConversationList() {
  const { conversations, deleteConversation } = useStore();
  const { toast } = useToast();
  const confirm = useConfirm();
  const router = useRouter();

  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBulkAnalysis, setShowBulkAnalysis] = useState(false);

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
    selected.forEach((id) => {
      deleteConversation(id);
      dbDeleteConversation(id);
    });
    cancelSelectMode();
    toast(`${count} conversation(s) deleted`, 'success');
  };

  const handleDeleteOne = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!await confirm('Delete this conversation?', { danger: true, confirmLabel: 'Delete' })) return;
    deleteConversation(id);
    dbDeleteConversation(id);
    toast('Conversation deleted', 'success');
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

  const selectedConversations = conversations.filter((c) => selected.has(c.id));

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
            <span className="text-xs text-slate-400">{conversations.length} conversation{conversations.length !== 1 ? 's' : ''}</span>
            <button
              onClick={enterSelectMode}
              className="text-sm font-medium text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors"
            >
              Select
            </button>
          </>
        )}
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
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
      </div>
    </div>
  );
}
