'use client';

import type { Conversation } from '@/lib/types';
import { fmtTime } from '@/lib/utils';

interface Props {
  conversation: Conversation;
  selected: boolean;
  onSelect: (id: string, checked: boolean) => void;
  onClick: () => void;
}

export default function ConversationCard({ conversation: c, selected, onSelect, onClick }: Props) {
  return (
    <div
      className={[
        'group bg-white rounded-xl border cursor-pointer transition-all duration-150',
        selected
          ? 'border-blue-400 ring-2 ring-blue-100 shadow-sm'
          : 'border-slate-200 hover:border-slate-300 hover:shadow-md shadow-sm',
      ].join(' ')}
      onClick={onClick}
    >
      <div className="p-4">
        {/* Top row: checkbox + title + bot badge */}
        <div className="flex items-start gap-3">
          <div
            className="pt-0.5"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={selected}
              onChange={(e) => onSelect(c.id, e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
            />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-slate-900 text-sm leading-snug truncate flex-1">
                {c.title}
              </h3>
              {c.is_bot_handled && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-500 font-medium uppercase tracking-wide shrink-0">
                  Bot
                </span>
              )}
            </div>

            {/* Meta row */}
            <div className="flex flex-wrap items-center gap-x-2 mt-1.5 text-xs text-slate-400">
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
          <div className="flex flex-wrap gap-1 mt-3 ml-7">
            {c.tags.slice(0, 4).map((t) => (
              <span key={t} className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">
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
        <div className="flex items-center justify-between mt-3 ml-7">
          <span className="text-[11px] text-slate-400">
            {c.intercom_created_at ? fmtTime(c.intercom_created_at) : fmtTime(c.analyzed_at)}
          </span>
          {c.conversation_rating_score != null && (
            <span className="text-[11px] text-slate-400">
              {c.conversation_rating_score}/5
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
