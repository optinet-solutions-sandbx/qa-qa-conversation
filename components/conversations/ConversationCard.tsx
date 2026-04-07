'use client';

import type { Conversation } from '@/lib/types';
import { fmtTime } from '@/lib/utils';

interface Props {
  conversation: Conversation;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onClick: () => void;
  onDelete?: (e: React.MouseEvent) => void;
}

function IconCheck() {
  return (
    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
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

// Left border accent color based on severity / alert
function accentClass(c: Conversation): string {
  if (c.is_alert_worthy) return 'border-l-[3px] border-l-red-400';
  switch (c.dissatisfaction_severity) {
    case 'Critical': return 'border-l-[3px] border-l-red-400';
    case 'High':     return 'border-l-[3px] border-l-orange-400';
    case 'Medium':   return 'border-l-[3px] border-l-amber-400';
    case 'Low':      return 'border-l-[3px] border-l-emerald-400';
  }
  if (c.resolution_status === 'Resolved') return 'border-l-[3px] border-l-emerald-400';
  return 'border-l-[3px] border-l-transparent';
}

function ResolutionBadge({ status }: { status: Conversation['resolution_status'] }) {
  if (!status) return null;
  const styles: Record<string, string> = {
    'Resolved':           'bg-emerald-50 text-emerald-700',
    'Partially Resolved': 'bg-amber-50 text-amber-700',
    'Unresolved':         'bg-red-50 text-red-600',
  };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-semibold ${styles[status] ?? 'bg-slate-100 text-slate-500'}`}>
      {status}
    </span>
  );
}

function RatingScore({ score }: { score: number }) {
  const color = score >= 4 ? 'text-emerald-600' : score === 3 ? 'text-amber-500' : 'text-red-500';
  return (
    <span className={`text-[11px] font-semibold ${color}`}>
      {score}/5
    </span>
  );
}

export default function ConversationCard({ conversation: c, selectMode, selected, onToggleSelect, onClick, onDelete }: Props) {
  const handleClick = () => {
    if (selectMode) onToggleSelect();
    else onClick();
  };

  const isAnalyzed = !!(c.dissatisfaction_severity || c.resolution_status || c.is_alert_worthy);

  return (
    <div
      className={[
        'relative group bg-white rounded-xl border cursor-pointer transition-all duration-150',
        accentClass(c),
        selected
          ? 'border-blue-400 ring-2 ring-blue-100 shadow-sm'
          : selectMode
            ? 'border-slate-200 hover:border-blue-300 shadow-sm'
            : 'border-slate-200 hover:border-slate-300 hover:shadow-md shadow-sm',
      ].join(' ')}
      onClick={handleClick}
    >
      {/* Delete button — visible on hover, hidden in select mode */}
      {!selectMode && onDelete && (
        <button
          onClick={onDelete}
          className="absolute top-2.5 right-2.5 w-6 h-6 rounded-md flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-slate-400 hover:text-red-500 hover:bg-red-50"
          title="Delete conversation"
        >
          <IconTrash />
        </button>
      )}

      {/* Selection indicator */}
      {selectMode && (
        <div className={[
          'absolute top-3 right-3 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all',
          selected
            ? 'bg-blue-500 border-blue-500 text-white'
            : 'border-slate-300 bg-white',
        ].join(' ')}>
          {selected && <IconCheck />}
        </div>
      )}

      <div className="p-4">
        {/* Title row */}
        <div className={['flex items-start gap-2', selectMode ? 'pr-7' : ''].join(' ')}>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-slate-900 text-sm leading-snug truncate flex-1">
                {c.title}
              </h3>
              <div className="flex items-center gap-1.5 shrink-0">
                {c.is_alert_worthy && (
                  <span className="text-red-500" title="Alert">
                    <IconAlert />
                  </span>
                )}
                {c.is_bot_handled && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-indigo-50 text-indigo-500 font-semibold uppercase tracking-wide">
                    Bot
                  </span>
                )}
              </div>
            </div>

            {/* Meta row */}
            <div className="flex flex-wrap items-center gap-x-2 mt-1 text-xs text-slate-400">
              {c.brand && <span className="font-medium text-slate-500">{c.brand}</span>}
              {c.query_type && (
                <>
                  {c.brand && <span className="text-slate-300">·</span>}
                  <span>{c.query_type}</span>
                </>
              )}
              {c.agent_name && (
                <>
                  {(c.brand || c.query_type) && <span className="text-slate-300">·</span>}
                  <span>{c.agent_name}</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Tags */}
        {c.tags?.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-3">
            {c.tags.slice(0, 4).map((t) => (
              <span key={t} className="text-[11px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-500">
                {t}
              </span>
            ))}
            {c.tags.length > 4 && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-400">
                +{c.tags.length - 4}
              </span>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between mt-3 gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-400">
              {c.intercom_created_at ? fmtTime(c.intercom_created_at) : fmtTime(c.analyzed_at)}
            </span>
            {isAnalyzed && <ResolutionBadge status={c.resolution_status} />}
          </div>
          {c.conversation_rating_score != null && (
            <RatingScore score={c.conversation_rating_score} />
          )}
        </div>
      </div>
    </div>
  );
}
