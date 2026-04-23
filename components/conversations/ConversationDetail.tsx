'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { Conversation, ConversationNote, PromptVersion, AnalysisResult, AnalysisRun } from '@/lib/types';
import { useStore } from '@/lib/store';
import { useToast } from '@/components/layout/ToastProvider';
import { useConfirm } from '@/components/layout/ConfirmProvider';
import { generateId, fmtTime, fmtSeconds } from '@/lib/utils';
import { dbDeleteConversation, dbInsertNote, dbUpdateNote, dbDeleteNote, dbUpdateConversation, dbInsertAnalysisRun, dbInsertPrompt } from '@/lib/db-client';
import AnalysisResultView from '@/components/conversations/AnalysisResultView';

// ── Icons ────────────────────────────────────────────────────────────────────

function IconArrowLeft() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
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
function IconPlay() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
    </svg>
  );
}
function IconChevronDown() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
    </svg>
  );
}
function IconExpand() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
    </svg>
  );
}
function IconCompress() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
    </svg>
  );
}

// ── CollapsiblePanel ─────────────────────────────────────────────────────────

interface PanelProps {
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  onFullscreen: () => void;
  badge?: React.ReactNode;
  headerAction?: React.ReactNode;
  children: React.ReactNode;
}

function CollapsiblePanel({
  title, onFullscreen, badge, headerAction, children,
}: PanelProps) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col overflow-hidden h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-slate-100 flex-shrink-0">
        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 flex-1 truncate">
          {title}
        </span>
        {badge}
        {headerAction}
        <button
          onClick={onFullscreen}
          className="p-1 text-slate-300 hover:text-slate-600 transition-colors rounded shrink-0"
          title="Expand to full screen"
        >
          <IconExpand />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-auto p-4 min-h-[180px] lg:min-h-0">
        {children}
      </div>
    </div>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function Badge({ label }: { label: string }) {
  return (
    <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600">
      {label}
    </span>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-2 border-b border-slate-50 last:border-0 min-w-0">
      <span className="text-[11px] text-slate-400 w-24 shrink-0 pt-0.5 leading-snug">{label}</span>
      <span className="text-[11px] text-slate-700 flex-1 min-w-0 break-words leading-snug">
        {value ?? <span className="text-slate-300">—</span>}
      </span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 mt-4 first:mt-0">
      {children}
    </h4>
  );
}

// ── ResizeHandle ──────────────────────────────────────────────────────────────

function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      className="hidden lg:flex w-3 shrink-0 cursor-col-resize items-stretch justify-center group select-none"
      onMouseDown={onMouseDown}
    >
      <div className="w-0.5 bg-slate-200 group-hover:bg-blue-400 transition-colors rounded-full" />
    </div>
  );
}

// ── FullscreenOverlay ─────────────────────────────────────────────────────────

function FullscreenOverlay({
  title, onClose, children,
}: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-white flex flex-col">
      <div className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-200 flex-shrink-0">
        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 flex-1">{title}</span>
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 text-slate-500 hover:text-slate-800 text-sm font-medium px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors"
        >
          <IconCompress />
          <span>Collapse</span>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-5">{children}</div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

type PanelId = 'player' | 'conversation' | 'transcript' | 'notes' | 'prompt' | 'analysis';

interface Props {
  conversation: Conversation;
  /** When viewing a historical run, pre-populate prompt + analysis from this run */
  analysisRun?: AnalysisRun;
  /** Hide Run QA / Delete actions when viewing a read-only historical run */
  readOnly?: boolean;
  /** When provided, back arrow calls this instead of router.back() (e.g. close a drawer) */
  onClose?: () => void;
}

export default function ConversationDetail({ conversation, analysisRun, readOnly = false, onClose }: Props) {
  const router = useRouter();
  const { deleteConversation, updateConversation, addNote, updateNote, deleteNote, addPrompt, currentUser, prompts } = useStore();
  const { toast } = useToast();
  const confirm = useConfirm();

  const conv = conversation;

  // ── Panel visibility ───────────────────────────────────────────────────────
  const PANEL_ORDER: PanelId[] = ['transcript', 'prompt', 'analysis', 'player', 'conversation', 'notes'];

  const [shownPanels, setShownPanels] = useState<Set<PanelId>>(
    new Set(['transcript', 'prompt', 'analysis'])
  );
  const [fullscreen, setFullscreen] = useState<PanelId | null>(null);

  const togglePanel = (id: PanelId) => {
    setShownPanels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const expandPanel = (id: PanelId) => setFullscreen(id);

  // ── Panel widths (resize) ─────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null);
  const [panelWidths, setPanelWidths] = useState<Record<string, number>>({});

  // Reset to equal widths whenever the shown set changes
  useEffect(() => {
    const visible = PANEL_ORDER.filter((id) => shownPanels.has(id));
    if (visible.length === 0) return;
    const equal = 100 / visible.length;
    setPanelWidths(Object.fromEntries(visible.map((id) => [id, equal])));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownPanels]);

  const startResize = (leftId: PanelId, rightId: PanelId) => (e: React.MouseEvent) => {
    e.preventDefault();
    let lastX = e.clientX;

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - lastX;
      lastX = ev.clientX;
      const totalW = containerRef.current?.offsetWidth ?? 800;
      const dPct = (dx / totalW) * 100;
      setPanelWidths((prev) => ({
        ...prev,
        [leftId]: Math.max(8, (prev[leftId] ?? 0) + dPct),
        [rightId]: Math.max(8, (prev[rightId] ?? 0) - dPct),
      }));
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // ── Notes state ────────────────────────────────────────────────────────────
  const [notes, setNotes] = useState<ConversationNote[]>(conversation.notes);
  const [noteText, setNoteText] = useState('');
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteText, setEditingNoteText] = useState('');

  // ── Prompt state ──────────────────────────────────────────────────────────
  const [selectedPrompt, setSelectedPrompt] = useState<PromptVersion | null>(null);
  const [promptContent, setPromptContent] = useState('');
  const [promptDirty, setPromptDirty] = useState(false);
  const [showPromptPicker, setShowPromptPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // ── Analysis state ─────────────────────────────────────────────────────────
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);

  // Init: use analysisRun if provided (history view), else restore last saved, else default prompt
  useEffect(() => {
    if (analysisRun) {
      // History view — pre-populate from the specific run
      const runPrompt = prompts.find((p) => p.id === analysisRun.prompt_id) ?? null;
      setSelectedPrompt(runPrompt);
      setPromptContent(analysisRun.prompt_content);
      if (analysisRun.summary) setAnalysisResult({ analysisText: analysisRun.summary });
      return;
    }

    // Live conversation view — restore last saved prompt
    if (conv.last_prompt_content) {
      const saved = prompts.find((p) => p.id === conv.last_prompt_id) ?? null;
      setSelectedPrompt(saved);
      setPromptContent(conv.last_prompt_content);
    } else {
      const def = prompts.find((p) => p.is_active) ?? null;
      if (def) { setSelectedPrompt(def); setPromptContent(def.content); }
    }

    // Restore last saved analysis
    if (conv.summary) {
      setAnalysisResult({ analysisText: conv.summary });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.id, analysisRun?.id]);

  // Close prompt picker on outside click
  useEffect(() => {
    if (!showPromptPicker) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPromptPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPromptPicker]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleDelete = async () => {
    if (!await confirm('Delete this conversation?', { danger: true, confirmLabel: 'Delete' })) return;
    deleteConversation(conv.id);
    dbDeleteConversation(conv.id);
    toast('Conversation deleted', 'success');
    router.push('/');
  };

  const handleRunQA = async () => {
    if (!promptContent.trim()) {
      toast('Select or write a prompt first', 'error');
      return;
    }
    if (!conv.intercom_id) {
      toast('No Intercom ID for this conversation', 'error');
      return;
    }

    // Auto-save edited prompt as a new version before running
    let effectivePrompt = selectedPrompt;
    if (promptDirty && promptContent !== selectedPrompt?.content) {
      const now = new Date().toISOString();
      const baseTitle = (selectedPrompt?.title ?? 'Prompt').replace(/\s*\(edited\)$/, '').trim();
      const newVersion: PromptVersion = {
        id: generateId(),
        title: `${baseTitle} (edited)`,
        content: promptContent,
        is_active: false,
        created_at: now,
        updated_at: now,
      };
      addPrompt(newVersion);
      dbInsertPrompt(newVersion);
      setSelectedPrompt(newVersion);
      setPromptDirty(false);
      effectivePrompt = newVersion;
      toast(`Saved as "${newVersion.title}"`, 'info');
    }

    setIsAnalyzing(true);
    setAnalysisResult(null);
    try {
      const res = await fetch('/api/conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customSystemPrompt: promptContent,
          intercomId: conv.intercom_id,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? 'Analysis failed');
      }
      const data: AnalysisResult & Record<string, unknown> = await res.json();
      setAnalysisResult({ analysisText: data.analysisText });
      setShownPanels(new Set(['transcript', 'prompt', 'analysis']));

      const now = new Date().toISOString();

      // Persist analysis + prompt used back to the conversation
      const updated = {
        ...conv,
        summary: data.analysisText,
        last_prompt_id: effectivePrompt?.id ?? null,
        last_prompt_content: promptContent,
        analyzed_at: now,
      };
      updateConversation(updated);
      dbUpdateConversation(updated);

      // Insert analysis run log
      const run: AnalysisRun = {
        id: generateId(),
        conversation_id: conv.id,
        conversation_title: conv.title,
        player_name: conv.player_name,
        analyzed_at: now,
        prompt_id: effectivePrompt?.id ?? null,
        prompt_title: effectivePrompt?.title ?? null,
        prompt_content: promptContent,
        summary: data.analysisText,
        language: null,
        dissatisfaction_severity: null,
        issue_category: null,
        resolution_status: null,
        key_quotes: null,
        agent_performance_score: null,
        agent_performance_notes: null,
        recommended_action: null,
        is_alert_worthy: false,
        alert_reason: null,
      };
      dbInsertAnalysisRun(run);

      toast('QA analysis complete', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handlePickPrompt = (p: PromptVersion) => {
    setSelectedPrompt(p);
    setPromptContent(p.content);
    setPromptDirty(false);
    setShowPromptPicker(false);
    if (!shownPanels.has('prompt')) {
      setShownPanels((prev) => { const n = new Set(prev); n.add('prompt'); return n; });
    }
  };

  // Notes
  const handleAddNote = () => {
    if (!noteText.trim()) return;
    const note: ConversationNote = {
      id: generateId(),
      author: currentUser || 'Admin',
      text: noteText.trim(),
      ts: new Date().toISOString(),
      system: false,
    };
    setNotes((prev) => [...prev, note]);
    addNote(conv.id, note);
    dbInsertNote(conv.id, note);
    setNoteText('');
  };

  const handleSaveNote = (note: ConversationNote) => {
    const updated = { ...note, text: editingNoteText };
    setNotes((prev) => prev.map((n) => (n.id === note.id ? updated : n)));
    updateNote(conv.id, updated);
    dbUpdateNote(updated);
    setEditingNoteId(null);
  };

  const handleDeleteNote = (noteId: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
    deleteNote(conv.id, noteId);
    dbDeleteNote(noteId);
  };

  // ── Panel content ─────────────────────────────────────────────────────────

  const playerContent = (
    <div>
      <SectionTitle>Identity</SectionTitle>
      <InfoRow label="Name" value={conv.player_name} />
      <InfoRow label="Email" value={conv.player_email} />
      <InfoRow label="Intercom ID" value={conv.player_id} />
      <InfoRow label="External ID" value={conv.player_external_id} />
      <InfoRow label="Phone" value={conv.player_phone} />

      <SectionTitle>Location &amp; Device</SectionTitle>
      <InfoRow label="Country" value={conv.player_country} />
      <InfoRow label="City" value={conv.player_city} />
      <InfoRow label="Browser" value={conv.player_browser} />
      <InfoRow label="OS" value={conv.player_os} />

      <SectionTitle>Activity</SectionTitle>
      <InfoRow label="Signed Up" value={conv.player_signed_up_at ? fmtTime(conv.player_signed_up_at) : null} />
      <InfoRow label="Last Seen" value={conv.player_last_seen_at ? fmtTime(conv.player_last_seen_at) : null} />
      <InfoRow label="Last Replied" value={conv.player_last_replied_at ? fmtTime(conv.player_last_replied_at) : null} />
      <InfoRow label="Last Contacted" value={conv.player_last_contacted_at ? fmtTime(conv.player_last_contacted_at) : null} />

      {(conv.player_tags?.length > 0 || conv.player_segments?.length > 0) && (
        <>
          <SectionTitle>Tags &amp; Segments</SectionTitle>
          {conv.player_tags?.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {conv.player_tags.map((t) => <Badge key={t} label={t} />)}
            </div>
          )}
          {conv.player_segments?.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {conv.player_segments.map((s) => <Badge key={s} label={s} />)}
            </div>
          )}
        </>
      )}

      {conv.player_companies?.length > 0 && (
        <>
          <SectionTitle>Companies</SectionTitle>
          {conv.player_companies.map((c) => (
            <div key={c.id} className="mb-3">
              <InfoRow label="Name" value={c.name} />
              <InfoRow label="Sessions" value={c.session_count} />
              <InfoRow label="Monthly Spend" value={c.monthly_spend != null ? `$${c.monthly_spend}` : null} />
            </div>
          ))}
        </>
      )}

      {conv.player_custom_attributes && Object.keys(conv.player_custom_attributes).length > 0 && (
        <>
          <SectionTitle>Custom Attributes</SectionTitle>
          {Object.entries(conv.player_custom_attributes).map(([k, v]) => (
            <InfoRow key={k} label={k} value={v != null ? String(v) : null} />
          ))}
        </>
      )}

      {conv.player_event_summaries?.length > 0 && (
        <>
          <SectionTitle>Events</SectionTitle>
          {conv.player_event_summaries.map((e) => (
            <div key={e.name} className="mb-3">
              <InfoRow label="Event" value={e.name} />
              <InfoRow label="Count" value={e.count} />
              <InfoRow label="First" value={e.first ? fmtTime(e.first) : null} />
              <InfoRow label="Last" value={e.last ? fmtTime(e.last) : null} />
            </div>
          ))}
        </>
      )}
    </div>
  );

  const conversationContent = (
    <div>
      <SectionTitle>Details</SectionTitle>
      <InfoRow label="Intercom ID" value={conv.intercom_id} />
      <InfoRow label="Created" value={conv.intercom_created_at ? fmtTime(conv.intercom_created_at) : null} />
      <InfoRow label="Brand" value={conv.brand} />
      <InfoRow label="Query Type" value={conv.query_type} />
      <InfoRow label="AI Subject" value={conv.ai_subject} />
      <InfoRow label="AI Issue" value={conv.ai_issue_summary} />
      <InfoRow label="Agent" value={conv.agent_name ? `${conv.agent_name}${conv.agent_email ? ` (${conv.agent_email})` : ''}` : null} />
      <InfoRow label="Bot Handled" value={conv.is_bot_handled ? 'Yes' : 'No'} />
      {conv.tags?.length > 0 && (
        <InfoRow label="Tags" value={
          <div className="flex flex-wrap gap-1">{conv.tags.map((t) => <Badge key={t} label={t} />)}</div>
        } />
      )}

      <SectionTitle>Ratings &amp; Stats</SectionTitle>
      <InfoRow label="CX Score" value={conv.cx_score_rating} />
      <InfoRow label="CX Notes" value={conv.cx_score_explanation} />
      <InfoRow label="Rating" value={conv.conversation_rating_score != null ? `${conv.conversation_rating_score}/5${conv.conversation_rating_remark ? ` — ${conv.conversation_rating_remark}` : ''}` : null} />
      <InfoRow label="To Assignment" value={fmtSeconds(conv.time_to_assignment)} />
      <InfoRow label="First Reply" value={fmtSeconds(conv.time_to_admin_reply)} />
      <InfoRow label="First Close" value={fmtSeconds(conv.time_to_first_close)} />
      <InfoRow label="Median Reply" value={fmtSeconds(conv.median_time_to_reply)} />
      <InfoRow label="Reopens" value={conv.count_reopens} />
    </div>
  );

  const transcriptContent = (
    <div className="min-w-0">
      {conv.original_text ? (
        <pre className="text-xs text-slate-700 whitespace-pre-wrap font-sans leading-relaxed break-words min-w-0 w-full">
          {conv.original_text}
        </pre>
      ) : (
        <p className="text-slate-400 text-sm">No transcript stored.</p>
      )}
    </div>
  );

  const notesContent = (
    <div className="flex flex-col gap-3">
      {notes.length === 0 && <p className="text-slate-400 text-sm">No notes yet.</p>}
      {notes.map((note) => (
        <div
          key={note.id}
          className={`rounded-xl p-3 ${note.system ? 'bg-slate-50 border border-slate-200' : 'bg-blue-50 border border-blue-100'}`}
        >
          <div className="flex items-center justify-between mb-1.5">
            <span className="font-medium text-xs text-slate-600">{note.author}</span>
            <span className="text-xs text-slate-400">{fmtTime(note.ts)}</span>
          </div>
          {editingNoteId === note.id ? (
            <div className="space-y-2">
              <textarea
                value={editingNoteText}
                onChange={(e) => setEditingNoteText(e.target.value)}
                rows={3}
                className="w-full border border-slate-200 rounded-lg px-2.5 py-2 text-xs resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <div className="flex gap-2">
                <button onClick={() => handleSaveNote(note)} className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg font-medium">Save</button>
                <button onClick={() => setEditingNoteId(null)} className="text-xs text-slate-500 px-3 py-1.5 rounded-lg hover:bg-slate-100">Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <p className="text-slate-700 text-xs leading-relaxed">{note.text}</p>
              {!note.system && (
                <div className="flex gap-3 mt-2">
                  <button onClick={() => { setEditingNoteId(note.id); setEditingNoteText(note.text); }} className="text-xs text-slate-400 hover:text-slate-600">Edit</button>
                  <button onClick={() => handleDeleteNote(note.id)} className="text-xs text-red-400 hover:text-red-600">Delete</button>
                </div>
              )}
            </>
          )}
        </div>
      ))}
      <div className="pt-2 border-t border-slate-100">
        <textarea
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          placeholder="Add a note…"
          rows={3}
          className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={handleAddNote}
          disabled={!noteText.trim()}
          className="mt-2 w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium px-4 py-2 rounded-xl transition-colors"
        >
          Add Note
        </button>
      </div>
    </div>
  );

  const promptContent_ = (
    <div className="flex flex-col gap-3 h-full">
      {!selectedPrompt ? (
        <div className="text-center py-6">
          <p className="text-sm text-slate-500 mb-1">No prompt selected.</p>
          <p className="text-xs text-slate-400">
            Use &ldquo;Select Prompt&rdquo; above or{' '}
            <a href="/prompts" className="text-blue-600 hover:underline">create one in Prompt Library</a>.
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-600">{selectedPrompt.title}</span>
            {promptDirty && (
              <span className="text-[10px] text-amber-600 font-medium">Unsaved edits</span>
            )}
          </div>
          <textarea
            value={promptContent}
            onChange={(e) => { setPromptContent(e.target.value); setPromptDirty(true); }}
            className="w-full flex-1 min-h-0 border border-slate-200 rounded-xl px-3 py-2.5 text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 leading-relaxed h-full"
            placeholder="Write or paste your system prompt…"
          />
        </>
      )}
    </div>
  );

  const analysisContent = (
    <div>
      {analysisResult ? (
        <AnalysisResultView result={analysisResult} />
      ) : isAnalyzing ? (
        <div className="flex flex-col items-center justify-center py-10 gap-3">
          <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-slate-500">Analyzing transcript…</p>
        </div>
      ) : (
        <div className="text-center py-8">
          <p className="text-sm text-slate-500 mb-1">No analysis yet.</p>
          <p className="text-xs text-slate-400">Select a prompt and click Run QA to analyze this conversation.</p>
        </div>
      )}
    </div>
  );

  // Map panel id → content + title for fullscreen
  const PANELS: Record<PanelId, { title: string; content: React.ReactNode }> = {
    player: { title: 'Player', content: playerContent },
    conversation: { title: 'Conversation', content: conversationContent },
    transcript: { title: 'Transcript', content: transcriptContent },
    notes: { title: 'Notes', content: notesContent },
    prompt: { title: 'Prompt', content: promptContent_ },
    analysis: { title: 'Analysis', content: analysisContent },
  };

  // ── Prompt picker header action ───────────────────────────────────────────
  const promptPickerAction = (
    <div className="relative" ref={pickerRef}>
      <button
        onClick={() => setShowPromptPicker((v) => !v)}
        className="text-[11px] font-medium text-blue-600 hover:text-blue-800 px-2 py-1 rounded-lg hover:bg-blue-50 transition-colors flex items-center gap-1"
      >
        {selectedPrompt ? selectedPrompt.title : 'Select Prompt'}
        <IconChevronDown />
      </button>
      {showPromptPicker && (
        <div className="absolute right-0 top-full mt-1 w-56 bg-white border border-slate-200 rounded-xl shadow-lg z-20 overflow-hidden">
          {prompts.length === 0 ? (
            <div className="px-4 py-3 text-xs text-slate-400">No prompts. <a href="/prompts" className="text-blue-600 hover:underline">Create one →</a></div>
          ) : (
            <div className="max-h-48 overflow-y-auto divide-y divide-slate-100">
              {prompts.map((p) => (
                <button
                  key={p.id}
                  onClick={() => handlePickPrompt(p)}
                  className={`w-full text-left px-4 py-2.5 text-xs transition-colors hover:bg-slate-50 ${selectedPrompt?.id === p.id ? 'text-blue-700 font-medium bg-blue-50' : 'text-slate-700'}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="truncate">{p.title}</span>
                    {p.is_active && (
                      <span className="text-[9px] font-bold uppercase bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full ml-1 shrink-0">Default</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  // Analysis badge
  const analysisBadge = analysisResult ? (
    <span className="text-[9px] font-bold uppercase bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full">Done</span>
  ) : null;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Fullscreen overlay */}
      {fullscreen && (
        <FullscreenOverlay title={PANELS[fullscreen].title} onClose={() => setFullscreen(null)}>
          {PANELS[fullscreen].content}
        </FullscreenOverlay>
      )}

      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        {/* Page header */}
        <div className="bg-white border-b border-slate-200 flex-shrink-0">
          {/* Row 1: back · title · actions */}
          <div className="flex items-center gap-2 px-4 sm:px-6 py-3 min-w-0">
            <button
              onClick={() => onClose ? onClose() : router.back()}
              className="flex items-center gap-1 text-slate-400 hover:text-slate-700 transition-colors shrink-0"
            >
              <IconArrowLeft />
            </button>
            <div className="w-px h-4 bg-slate-200 shrink-0" />
            <h1 className="flex-1 min-w-0 font-semibold text-slate-900 text-sm truncate">{conv.title}</h1>

            {!readOnly && (
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={handleRunQA}
                  disabled={isAnalyzing || !conv.intercom_id}
                  className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                  title={!conv.intercom_id ? 'No Intercom ID for this conversation' : 'Run QA analysis'}
                >
                  {isAnalyzing
                    ? <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    : <IconPlay />}
                  <span>{isAnalyzing ? 'Analyzing…' : 'Run QA'}</span>
                </button>
                <button
                  onClick={handleDelete}
                  className="flex items-center gap-1 text-red-400 hover:text-red-600 transition-colors p-1.5 rounded-lg hover:bg-red-50"
                  title="Delete conversation"
                >
                  <IconTrash />
                </button>
              </div>
            )}
          </div>

          {/* Row 2: panel toggles — horizontally scrollable, no wrap */}
          <div className="flex items-center gap-1.5 px-4 sm:px-6 pb-2.5 overflow-x-auto">
            {(['transcript', 'prompt', 'analysis', 'player', 'conversation', 'notes'] as PanelId[]).map((id) => {
              const labels: Record<PanelId, string> = { transcript: 'Transcript', prompt: 'Prompt', analysis: 'Analysis', player: 'Player', conversation: 'Conversation', notes: 'Notes' };
              const on = shownPanels.has(id);
              return (
                <button
                  key={id}
                  onClick={() => togglePanel(id)}
                  className={[
                    'text-[11px] font-medium px-2.5 py-1 rounded-full transition-colors whitespace-nowrap shrink-0',
                    on ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200',
                  ].join(' ')}
                >
                  {labels[id]}
                </button>
              );
            })}
          </div>
        </div>

        {/* Panel layout — stacked on mobile, resizable flex row on desktop */}
        <div className="flex-1 min-h-0 overflow-y-auto lg:overflow-hidden p-3 sm:p-4">
          <div
            ref={containerRef}
            className="flex flex-col lg:flex-row gap-3 lg:gap-0 h-full"
          >
            {PANEL_ORDER.filter((id) => shownPanels.has(id)).map((id, i, visible) => {
              const panelProps: Record<PanelId, { title: string; badge?: React.ReactNode; headerAction?: React.ReactNode }> = {
                transcript:   { title: 'Transcript' },
                prompt:       { title: 'Prompt', headerAction: promptPickerAction },
                analysis:     { title: 'Analysis', badge: analysisBadge },
                player:       { title: 'Player' },
                conversation: { title: 'Conversation' },
                notes:        { title: 'Notes', badge: notes.length > 0 ? <span className="text-[10px] bg-slate-100 text-slate-500 rounded-full px-1.5 py-0.5 font-medium">{notes.length}</span> : undefined },
              };
              const { title, badge, headerAction } = panelProps[id];
              const widthPct = panelWidths[id] ?? 100 / visible.length;

              return (
                <React.Fragment key={id}>
                  {i > 0 && (
                    <ResizeHandle onMouseDown={startResize(visible[i - 1], id)} />
                  )}
                  <div
                    className="min-w-0 flex-shrink-0 lg:flex-shrink lg:flex-grow-0 min-h-[200px] lg:min-h-0 w-full lg:w-auto"
                    style={{ flexBasis: `${widthPct}%` }}
                  >
                    <CollapsiblePanel
                      title={title}
                      isOpen
                      onToggle={() => {}}
                      onFullscreen={() => expandPanel(id)}
                      badge={badge}
                      headerAction={headerAction}
                    >
                      {PANELS[id].content}
                    </CollapsiblePanel>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

