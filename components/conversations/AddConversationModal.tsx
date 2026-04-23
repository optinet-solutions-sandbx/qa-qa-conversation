'use client';

import { useState } from 'react';
import { useStore } from '@/lib/store';
import { useToast } from '@/components/layout/ToastProvider';
import { useConfirm } from '@/components/layout/ConfirmProvider';
import { generateId, fmtTime, fmtSeconds } from '@/lib/utils';
import { dbInsertConversation, dbUpdateConversation } from '@/lib/db-client';
import type { ConversationFetchResult, Conversation } from '@/lib/types';

interface Props { onClose: () => void }

function Badge({ label }: { label: string }) {
  return (
    <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600">
      {label}
    </span>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2 py-1.5 border-b border-slate-100 last:border-0">
      <span className="text-xs text-slate-400 w-36 shrink-0 pt-0.5">{label}</span>
      <span className="text-xs text-slate-700 flex-1 break-all">{value ?? '—'}</span>
    </div>
  );
}

export default function AddConversationModal({ onClose }: Props) {
  const { conversations, addConversation, updateConversation } = useStore();
  const { toast } = useToast();
  const confirm = useConfirm();

  const [intercomId, setIntercomId] = useState('');
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<ConversationFetchResult | null>(null);

  const handleFetch = async () => {
    if (!intercomId.trim()) return;
    setLoading(true);
    setPreview(null);
    try {
      const res = await fetch(`/api/conversation?id=${encodeURIComponent(intercomId.trim())}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to fetch conversation');
      }
      setPreview(await res.json() as ConversationFetchResult);
    } catch (e) {
      toast((e as Error).message || 'Failed to fetch conversation', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!preview) return;
    const r = preview;

    // Check for existing conversation with the same Intercom ID
    const existing = conversations.find((c) => c.intercom_id === r.intercom_id);
    if (existing) {
      const confirmed = await confirm(
        `A conversation with Intercom ID "${r.intercom_id}" already exists.\n\nOverwriting will refresh all data from Intercom but keep existing notes and analysis history.\n\nContinue?`,
        { title: 'Duplicate Conversation', confirmLabel: 'Overwrite' }
      );
      if (!confirmed) return;
    }

    const conv: Conversation = {
      id: existing?.id ?? generateId(),
      title: r.player_name ? `${r.player_name}${r.ai_subject ? ` — ${r.ai_subject}` : ''}` : `Conv ${r.intercom_id}`,
      analyzed_at: existing?.analyzed_at ?? new Date().toISOString(),

      intercom_id: r.intercom_id,
      intercom_created_at: r.intercom_created_at,

      player_name: r.player_name,
      player_email: r.player_email,
      player_id: r.player_id,
      player_external_id: r.player_external_id,
      player_phone: r.player_phone,
      player_tags: r.player_tags,

      player_signed_up_at: r.player_signed_up_at,
      player_last_seen_at: r.player_last_seen_at,
      player_last_replied_at: r.player_last_replied_at,
      player_last_contacted_at: r.player_last_contacted_at,

      player_country: r.player_country,
      player_city: r.player_city,
      player_browser: r.player_browser,
      player_os: r.player_os,

      player_custom_attributes: r.player_custom_attributes,
      player_companies: r.player_companies,
      player_segments: r.player_segments,
      player_event_summaries: r.player_event_summaries,

      agent_name: r.agent_name,
      agent_email: r.agent_email,
      is_bot_handled: r.is_bot_handled,

      brand: r.brand,
      tags: r.tags,
      query_type: r.query_type,
      ai_subject: r.ai_subject,
      ai_issue_summary: r.ai_issue_summary,
      cx_score_rating: r.cx_score_rating,
      cx_score_explanation: r.cx_score_explanation,
      conversation_rating_score: r.conversation_rating_score,
      conversation_rating_remark: r.conversation_rating_remark,

      time_to_assignment: r.time_to_assignment,
      time_to_admin_reply: r.time_to_admin_reply,
      time_to_first_close: r.time_to_first_close,
      median_time_to_reply: r.median_time_to_reply,
      count_reopens: r.count_reopens,
      account_manager: r.account_manager,

      sentiment: existing?.sentiment ?? null,
      summary: existing?.summary ?? null,
      dissatisfaction_severity: existing?.dissatisfaction_severity ?? null,
      issue_category: existing?.issue_category ?? null,
      resolution_status: existing?.resolution_status ?? null,
      language: existing?.language ?? null,
      agent_performance_score: existing?.agent_performance_score ?? null,
      agent_performance_notes: existing?.agent_performance_notes ?? null,
      key_quotes: existing?.key_quotes ?? null,
      recommended_action: existing?.recommended_action ?? null,
      is_alert_worthy: existing?.is_alert_worthy ?? false,
      alert_reason: existing?.alert_reason ?? null,

      original_text: r.transcript,
      raw_messages: existing?.raw_messages ?? null,
      last_prompt_id: existing?.last_prompt_id ?? null,
      last_prompt_content: existing?.last_prompt_content ?? null,
      notes: existing?.notes ?? [],
    };

    if (existing) {
      updateConversation(conv);
      dbUpdateConversation(conv);
      toast('Conversation updated', 'success');
    } else {
      addConversation(conv);
      dbInsertConversation(conv);
      toast('Conversation saved', 'success');
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl max-h-[92vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 flex-shrink-0">
          <h2 className="text-lg font-semibold text-slate-900">Add Conversation</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">✕</button>
        </div>

        {/* ID input */}
        <div className="px-6 py-4 border-b border-slate-200 flex-shrink-0 flex gap-3 items-end">
          <div className="flex-1">
            <label className="block text-xs font-medium text-slate-600 mb-1">Intercom Conversation ID</label>
            <input
              type="text"
              value={intercomId}
              onChange={(e) => setIntercomId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !preview && handleFetch()}
              placeholder="e.g. 215469027939712"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
          </div>
          <button
            onClick={handleFetch}
            disabled={!intercomId.trim() || loading}
            className="bg-blue-500 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors flex items-center gap-2 whitespace-nowrap"
          >
            {loading && <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            {loading ? 'Fetching…' : 'Fetch Conversation'}
          </button>
        </div>

        {/* Preview */}
        {preview && (
          <div className="flex-1 overflow-hidden grid grid-cols-3 divide-x divide-slate-200 min-h-0">

            {/* Col 1: Player */}
            <div className="overflow-y-auto p-5 space-y-5">
              <section>
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Player</h3>
                <InfoRow label="Name" value={preview.player_name} />
                <InfoRow label="Email" value={preview.player_email} />
                <InfoRow label="Intercom ID" value={preview.player_id} />
                <InfoRow label="External ID" value={preview.player_external_id} />
                <InfoRow label="Phone" value={preview.player_phone} />
                <InfoRow label="Country" value={preview.player_country} />
                <InfoRow label="City" value={preview.player_city} />
                <InfoRow label="Browser" value={preview.player_browser} />
                <InfoRow label="OS" value={preview.player_os} />
                <InfoRow label="Signed Up" value={preview.player_signed_up_at ? fmtTime(preview.player_signed_up_at) : null} />
                <InfoRow label="Last Seen" value={preview.player_last_seen_at ? fmtTime(preview.player_last_seen_at) : null} />
                <InfoRow label="Last Replied" value={preview.player_last_replied_at ? fmtTime(preview.player_last_replied_at) : null} />
                <InfoRow label="Last Contacted" value={preview.player_last_contacted_at ? fmtTime(preview.player_last_contacted_at) : null} />
                <InfoRow
                  label="Tags"
                  value={preview.player_tags.length > 0 ? (
                    <div className="flex flex-wrap gap-1">{preview.player_tags.map((t) => <Badge key={t} label={t} />)}</div>
                  ) : null}
                />
                <InfoRow
                  label="Segments"
                  value={preview.player_segments.length > 0 ? (
                    <div className="flex flex-wrap gap-1">{preview.player_segments.map((s) => <Badge key={s} label={s} />)}</div>
                  ) : null}
                />
              </section>

              {preview.player_companies.length > 0 && (
                <section>
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Companies</h3>
                  {preview.player_companies.map((c) => (
                    <div key={c.id} className="mb-2">
                      <InfoRow label="Name" value={c.name} />
                      <InfoRow label="Sessions" value={c.session_count ?? '—'} />
                      <InfoRow label="Monthly Spend" value={c.monthly_spend != null ? `$${c.monthly_spend}` : '—'} />
                    </div>
                  ))}
                </section>
              )}

              {preview.player_custom_attributes && Object.keys(preview.player_custom_attributes).length > 0 && (
                <section>
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Custom Attributes</h3>
                  {Object.entries(preview.player_custom_attributes).map(([k, v]) => (
                    <InfoRow key={k} label={k} value={v != null ? String(v) : null} />
                  ))}
                </section>
              )}

              {preview.player_event_summaries.length > 0 && (
                <section>
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Events</h3>
                  {preview.player_event_summaries.map((e) => (
                    <div key={e.name} className="mb-2">
                      <InfoRow label="Event" value={e.name} />
                      <InfoRow label="Count" value={e.count} />
                      <InfoRow label="First" value={e.first ? fmtTime(e.first) : null} />
                      <InfoRow label="Last" value={e.last ? fmtTime(e.last) : null} />
                    </div>
                  ))}
                </section>
              )}
            </div>

            {/* Col 2: Conversation */}
            <div className="overflow-y-auto p-5 space-y-5">
              <section>
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Conversation</h3>
                <InfoRow label="Intercom ID" value={preview.intercom_id} />
                <InfoRow label="Created" value={preview.intercom_created_at ? fmtTime(preview.intercom_created_at) : null} />
                <InfoRow label="Brand" value={preview.brand} />
                <InfoRow label="Query Type" value={preview.query_type} />
                <InfoRow label="AI Subject" value={preview.ai_subject} />
                <InfoRow label="AI Issue Summary" value={preview.ai_issue_summary} />
                <InfoRow label="Agent" value={preview.agent_name ? `${preview.agent_name}${preview.agent_email ? ` (${preview.agent_email})` : ''}` : null} />
                <InfoRow label="Bot Handled" value={preview.is_bot_handled ? 'Yes' : 'No'} />
                <InfoRow
                  label="Tags"
                  value={preview.tags.length > 0 ? (
                    <div className="flex flex-wrap gap-1">{preview.tags.map((t) => <Badge key={t} label={t} />)}</div>
                  ) : null}
                />
              </section>

              <section>
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Ratings & Stats</h3>
                <InfoRow label="CX Score" value={preview.cx_score_rating} />
                <InfoRow label="CX Explanation" value={preview.cx_score_explanation} />
                <InfoRow label="Conv. Rating" value={preview.conversation_rating_score != null ? `${preview.conversation_rating_score}/5${preview.conversation_rating_remark ? ` — ${preview.conversation_rating_remark}` : ''}` : null} />
                <InfoRow label="Time to Assignment" value={fmtSeconds(preview.time_to_assignment)} />
                <InfoRow label="Time to First Reply" value={fmtSeconds(preview.time_to_admin_reply)} />
                <InfoRow label="Time to First Close" value={fmtSeconds(preview.time_to_first_close)} />
                <InfoRow label="Median Reply Time" value={fmtSeconds(preview.median_time_to_reply)} />
                <InfoRow label="Reopens" value={preview.count_reopens} />
              </section>
            </div>

            {/* Col 3: Transcript */}
            <div className="overflow-y-auto p-5">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Transcript</h3>
              <pre className="text-xs text-slate-700 whitespace-pre-wrap font-sans leading-relaxed">
                {preview.transcript}
              </pre>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-200 flex-shrink-0">
          <button onClick={onClose} className="border border-slate-200 hover:bg-slate-50 text-slate-700 text-sm font-medium px-4 py-2 rounded-lg transition-colors">
            Cancel
          </button>
          {preview && (
            <button onClick={handleSave} className="bg-green-500 hover:bg-green-600 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
              Save Conversation
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
