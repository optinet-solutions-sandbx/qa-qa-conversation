'use client';

import { useState } from 'react';
import type { PromptVersion } from '@/lib/types';
import { useStore } from '@/lib/store';
import { useToast } from '@/components/layout/ToastProvider';
import { generateId, fmtTime } from '@/lib/utils';
import { dbInsertPrompt, dbUpdatePrompt, dbDeletePrompt, dbActivatePrompt } from '@/lib/db-client';

function IconPlus() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
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

function IconDocument() {
  return (
    <svg className="w-8 h-8 text-slate-300" fill="none" stroke="currentColor" strokeWidth={1.25} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>
  );
}

export default function PromptLibrary() {
  const { prompts, addPrompt, updatePrompt, deletePrompt, activatePrompt } = useStore();
  const { toast } = useToast();

  const [selectedId, setSelectedId] = useState<string | null>(() => {
    // Pre-select the active prompt if any
    return null;
  });
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [isDirty, setIsDirty] = useState(false);

  const selected = prompts.find((p) => p.id === selectedId) ?? null;

  const handleSelect = (p: PromptVersion) => {
    if (isDirty && !window.confirm('Discard unsaved changes?')) return;
    setSelectedId(p.id);
    setEditTitle(p.title);
    setEditContent(p.content);
    setIsDirty(false);
  };

  const handleAddNew = () => {
    if (isDirty && !window.confirm('Discard unsaved changes?')) return;
    const now = new Date().toISOString();
    const p: PromptVersion = {
      id: generateId(),
      title: 'New Prompt',
      content: '',
      is_active: false,
      created_at: now,
      updated_at: now,
    };
    addPrompt(p);
    dbInsertPrompt(p);
    setSelectedId(p.id);
    setEditTitle(p.title);
    setEditContent('');
    setIsDirty(false);
    toast('New prompt created', 'success');
  };

  const handleSave = () => {
    if (!selected) return;
    const updated: PromptVersion = {
      ...selected,
      title: editTitle.trim() || 'Untitled',
      content: editContent,
      updated_at: new Date().toISOString(),
    };
    updatePrompt(updated);
    dbUpdatePrompt(updated);
    setIsDirty(false);
    toast('Prompt saved', 'success');
  };

  const handleDiscard = () => {
    if (!selected) return;
    setEditTitle(selected.title);
    setEditContent(selected.content);
    setIsDirty(false);
  };

  const handleSetActive = () => {
    if (!selected) return;
    activatePrompt(selected.id);
    dbActivatePrompt(selected.id);
    // Also persist the title/content if dirty
    if (isDirty) {
      const updated: PromptVersion = {
        ...selected,
        title: editTitle.trim() || 'Untitled',
        content: editContent,
        is_active: true,
        updated_at: new Date().toISOString(),
      };
      updatePrompt(updated);
      dbUpdatePrompt(updated);
      setIsDirty(false);
    }
    toast('Prompt set as active', 'success');
  };

  const handleDelete = () => {
    if (!selected) return;
    if (!window.confirm(`Delete "${selected.title}"? This cannot be undone.`)) return;
    deletePrompt(selected.id);
    dbDeletePrompt(selected.id);
    setSelectedId(null);
    setIsDirty(false);
    toast('Prompt deleted', 'success');
  };

  const isActive = selected?.is_active ?? false;

  return (
    <div className="flex flex-col lg:flex-row gap-4 flex-1 min-h-0 h-full">

      {/* ── Main editor ── */}
      <div className="flex-1 min-w-0 flex flex-col bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {selected ? (
          <>
            {/* Editor header */}
            <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-200 flex-shrink-0">
              <input
                type="text"
                value={editTitle}
                onChange={(e) => { setEditTitle(e.target.value); setIsDirty(true); }}
                placeholder="Prompt title…"
                className="flex-1 text-sm font-semibold text-slate-900 bg-transparent border-0 focus:outline-none focus:ring-0 placeholder:text-slate-300 min-w-0"
              />
              {isActive && (
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full bg-green-100 text-green-700 shrink-0">
                  Default
                </span>
              )}
            </div>

            {/* Textarea */}
            <div className="flex-1 p-5 min-h-0">
              <textarea
                value={editContent}
                onChange={(e) => { setEditContent(e.target.value); setIsDirty(true); }}
                placeholder="Write your system prompt here…"
                className="w-full h-full border border-slate-200 rounded-xl px-4 py-3 text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 leading-relaxed text-slate-700"
              />
            </div>

            {/* Actions footer */}
            <div className="flex items-center gap-2 px-5 py-4 border-t border-slate-200 flex-shrink-0 flex-wrap">
              <button
                onClick={handleSave}
                disabled={!isDirty}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
              >
                Save
              </button>
              {isDirty && (
                <button
                  onClick={handleDiscard}
                  className="border border-slate-200 hover:bg-slate-50 text-slate-600 text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                >
                  Discard
                </button>
              )}
              {!isActive && (
                <button
                  onClick={handleSetActive}
                  className="border border-green-200 hover:bg-green-50 text-green-700 text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                >
                  Set as Default
                </button>
              )}
              <button
                onClick={handleDelete}
                className="ml-auto flex items-center gap-1.5 text-red-500 hover:text-red-700 hover:bg-red-50 text-sm font-medium px-3 py-2 rounded-lg transition-colors"
              >
                <IconTrash />
                <span className="hidden sm:inline">Delete</span>
              </button>
            </div>
          </>
        ) : (
          /* Empty state */
          <div className="flex-1 flex flex-col items-center justify-center py-20 text-center px-6">
            <IconDocument />
            <h3 className="text-sm font-semibold text-slate-600 mt-4 mb-1">No prompt selected</h3>
            <p className="text-xs text-slate-400 max-w-xs">
              Select a prompt from the list or create a new one.
            </p>
            <button
              onClick={handleAddNew}
              className="mt-4 inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              <IconPlus />
              New Prompt
            </button>
          </div>
        )}
      </div>

      {/* ── Prompt list sidebar ── */}
      <div className="w-full lg:w-64 xl:w-72 shrink-0 flex flex-col bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {/* Sidebar header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 flex-shrink-0">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
            Prompts ({prompts.length})
          </span>
          <button
            onClick={handleAddNew}
            title="Add new prompt"
            className="flex items-center gap-1 text-blue-600 hover:text-blue-800 hover:bg-blue-50 text-xs font-medium px-2 py-1 rounded-lg transition-colors"
          >
            <IconPlus />
            <span>Add New</span>
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
          {prompts.length === 0 && (
            <div className="px-4 py-8 text-center">
              <p className="text-xs text-slate-400">No prompts yet.</p>
            </div>
          )}
          {prompts.map((p) => (
            <button
              key={p.id}
              onClick={() => handleSelect(p)}
              className={[
                'w-full text-left px-4 py-3 transition-colors',
                selectedId === p.id
                  ? 'bg-blue-50'
                  : 'hover:bg-slate-50',
              ].join(' ')}
            >
              <div className="flex items-start justify-between gap-2">
                <span className={[
                  'text-sm font-medium leading-snug truncate',
                  selectedId === p.id ? 'text-blue-700' : 'text-slate-800',
                ].join(' ')}>
                  {p.title}
                </span>
                {p.is_active && (
                  <span className="shrink-0 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 mt-0.5">
                    Default
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-400 mt-0.5">
                {fmtTime(p.updated_at)}
              </p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
