'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '@/lib/store';
import type { BatchJob } from '@/lib/types';
import { fmtTime } from '@/lib/utils';

// ── Icons ──────────────────────────────────────────────────────────────────

function IconBatch() {
  return (
    <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" />
    </svg>
  );
}

function IconChevronDown() {
  return (
    <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
    </svg>
  );
}

function IconRefresh({ spinning }: { spinning?: boolean }) {
  return (
    <svg
      className={['w-4 h-4', spinning ? 'animate-spin' : ''].join(' ')}
      fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
    </svg>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

const ACTIVE_STATUSES = new Set(['validating', 'in_progress', 'finalizing']);
const POLL_INTERVAL_MS = 30_000;
const JOBS_PER_PAGE = 10;
type FilterTab = 'all' | 'action' | 'done';

function getPageNumbers(current: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | '…')[] = [1];
  if (current > 3) pages.push('…');
  for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) pages.push(i);
  if (current < total - 2) pages.push('…');
  pages.push(total);
  return pages;
}

function isActionable(j: BatchJob) {
  return (
    ACTIVE_STATUSES.has(j.status) ||
    j.status === 'pending' ||
    (j.status === 'completed' && j.imported_count < j.total_conversations)
  );
}

function isDone(j: BatchJob) {
  return (
    (j.status === 'completed' && j.imported_count >= j.total_conversations) ||
    j.status === 'cancelled' ||
    j.status === 'cancelling' ||
    j.status === 'failed' ||
    j.status === 'expired'
  );
}

function statusLabel(status: BatchJob['status']): string {
  const labels: Record<BatchJob['status'], string> = {
    pending: 'Pending',
    validating: 'Validating',
    in_progress: 'In Progress',
    finalizing: 'Finalizing',
    completed: 'Completed',
    expired: 'Expired',
    cancelling: 'Cancelling',
    cancelled: 'Cancelled',
    failed: 'Failed',
  };
  return labels[status] ?? status;
}

function statusColor(status: BatchJob['status']): string {
  if (status === 'completed') return 'text-green-400 bg-green-400/10';
  if (status === 'failed' || status === 'expired') return 'text-red-400 bg-red-400/10';
  if (status === 'cancelled' || status === 'cancelling') return 'text-slate-400 bg-slate-400/10';
  return 'text-blue-400 bg-blue-400/10';
}

function pct(done: number, total: number) {
  if (!total) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function BatchAnalysisPage() {
  const { prompts } = useStore();

  const [jobs, setJobs] = useState<BatchJob[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [selectedPromptId, setSelectedPromptId] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [testLimit, setTestLimit] = useState<string>('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<{ totalConversations: number; totalChunks: number; isTest: boolean } | null>(null);

  const [importingJobId, setImportingJobId] = useState<string | null>(null);
  const [importResults, setImportResults] = useState<Record<string, { imported: number; failed: number; resumed_from: number }>>({});
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [tabInitialised, setTabInitialised] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Data fetching ──────────────────────────────────────────────────────

  const fetchJobs = useCallback(async (silent = false) => {
    if (!silent) setLoadingJobs(true);
    else setRefreshing(true);
    try {
      const res = await fetch('/api/batch-analysis');
      if (res.ok) {
        const data = await res.json();
        setJobs(data.jobs ?? []);
      }
    } finally {
      setLoadingJobs(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  // Auto-poll every 30s while any job is active
  useEffect(() => {
    const hasActive = jobs.some((j) => ACTIVE_STATUSES.has(j.status));
    if (hasActive && !pollTimerRef.current) {
      pollTimerRef.current = setInterval(() => fetchJobs(true), POLL_INTERVAL_MS);
    }
    if (!hasActive && pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [jobs, fetchJobs]);

  // Set default prompt once prompts load
  useEffect(() => {
    if (!selectedPromptId && prompts.length > 0) {
      setSelectedPromptId(prompts.find((p) => p.is_active)?.id ?? prompts[0].id);
    }
  }, [prompts, selectedPromptId]);

  // ── Submit batch ───────────────────────────────────────────────────────

  const handleSubmit = async () => {
    const prompt = prompts.find((p) => p.id === selectedPromptId);
    if (!prompt) return;

    setSubmitting(true);
    setSubmitError(null);
    setSubmitResult(null);

    try {
      const res = await fetch('/api/batch-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          promptId: prompt.id,
          promptContent: prompt.content,
          ...(testLimit ? { testLimit: parseInt(testLimit, 10) } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Submission failed');

      if (data.message) {
        // "No unanalyzed conversations" case
        setSubmitError(data.message);
      } else {
        setSubmitResult({ totalConversations: data.totalConversations, totalChunks: data.totalChunks, isTest: !!testLimit });
        await fetchJobs(true);
      }
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Import results ─────────────────────────────────────────────────────

  const handleImport = async (job: BatchJob) => {
    setImportingJobId(job.id);
    try {
      const res = await fetch('/api/batch-analysis', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchJobId: job.id }),
      });
      if (!res.ok) {
        const text = await res.text();
        let message = 'Import failed';
        try { message = (JSON.parse(text) as { error?: string }).error ?? message; } catch { /* plain-text error */ }
        throw new Error(message);
      }
      const data = await res.json();
      setImportResults((prev) => ({ ...prev, [job.id]: data }));
      await fetchJobs(true);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setImportingJobId(null);
    }
  };

  // ── Cancel job ─────────────────────────────────────────────────────────

  const handleCancel = async (job: BatchJob) => {
    if (!confirm(`Cancel this batch job (${job.total_conversations.toLocaleString()} conversations)?`)) return;
    setCancellingJobId(job.id);
    try {
      const res = await fetch('/api/batch-analysis', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchJobId: job.id }),
      });
      if (!res.ok) {
        const text = await res.text();
        let message = 'Cancel failed';
        try { message = (JSON.parse(text) as { error?: string }).error ?? message; } catch { /* plain-text error */ }
        throw new Error(message);
      }
      const data = await res.json();
      await fetchJobs(true);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setCancellingJobId(null);
    }
  };

  // Auto-default tab once jobs first load
  useEffect(() => {
    if (!tabInitialised && jobs.length > 0) {
      setActiveTab(jobs.some(isActionable) ? 'action' : 'all');
      setTabInitialised(true);
    }
  }, [jobs, tabInitialised]);

  // ── Render ─────────────────────────────────────────────────────────────

  const hasActiveJobs = jobs.some((j) => ACTIVE_STATUSES.has(j.status));
  // Only show the banner for completed jobs that haven't been fully imported yet
  const hasPendingImportJobs = jobs.some((j) => j.status === 'completed' && j.imported_count < j.total_conversations);
  const actionCount = jobs.filter(isActionable).length;
  const doneCount = jobs.filter(isDone).length;

  const filteredJobs = jobs.filter((j) => {
    if (activeTab === 'action') return isActionable(j);
    if (activeTab === 'done') return isDone(j);
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filteredJobs.length / JOBS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);
  const pagedJobs = filteredJobs.slice((safePage - 1) * JOBS_PER_PAGE, safePage * JOBS_PER_PAGE);

  return (
    <div className="flex flex-col gap-6 p-6 max-w-4xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-blue-600/15 text-blue-400 flex items-center justify-center">
            <IconBatch />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-black">Batch Analysis</h1>
            <p className="text-xs text-black mt-0.5">
              Submit up to 50,000 conversations to OpenAI overnight at 50% lower cost
            </p>
          </div>
        </div>
        <button
          onClick={() => fetchJobs(true)}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-black hover:text-black rounded-lg hover:bg-white/[0.05] transition-colors"
        >
          <IconRefresh spinning={refreshing} />
          Refresh
        </button>
      </div>

      {/* Submit card */}
      <div className="bg-[#161b22] border border-white/[0.08] rounded-2xl p-5 space-y-4">
        <h2 className="text-sm font-semibold text-white">Submit New Batch</h2>

        <p className="text-xs text-white/50 leading-relaxed">
          Fetches all conversations where the AI summary is missing, builds a JSONL file,
          and submits it to the OpenAI Batch API. Large datasets are automatically split
          into chunks of ≤10,000 requests to stay within rate limits.
          Results are ready within 24 hours.
        </p>

        {/* Rate-limit note */}
        <div className="rounded-xl bg-amber-500/8 border border-amber-500/20 px-4 py-3 text-xs text-amber-300/80 space-y-1">
          <p className="font-medium text-amber-300">Rate-limit & resume info</p>
          <ul className="list-disc list-inside space-y-0.5 text-amber-200/60">
            <li>Chunks are ≤10,000 requests and ≤90 MB — safe for all OpenAI API tiers</li>
            <li>Re-submitting is safe: already-analyzed conversations are skipped automatically</li>
            <li>If an import fails mid-way, click Import again — it resumes from where it stopped</li>
          </ul>
        </div>

        {/* Prompt picker */}
        {prompts.length === 0 ? (
          <p className="text-sm text-white/40">
            No prompts found. <a href="/prompts" className="text-blue-400 hover:underline">Create one →</a>
          </p>
        ) : (
          <div>
            <label className="block text-xs text-white/50 mb-1.5 font-medium">Prompt to use</label>
            <div className="relative">
              <select
                value={selectedPromptId}
                onChange={(e) => setSelectedPromptId(e.target.value)}
                className="w-full bg-[#0d1117] border border-white/[0.08] text-white text-sm rounded-xl px-3 py-2.5 appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500 pr-8"
              >
                {prompts.map((p) => (
                  <option key={p.id} value={p.id} className="bg-[#0d1117]">
                    {p.title}{p.is_active ? ' (Default)' : ''}
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
                <IconChevronDown />
              </div>
            </div>
          </div>
        )}

        {/* Test limit — leave blank to run the full dataset */}
        <div>
          <label className="block text-xs text-white/50 mb-1.5 font-medium">
            Test limit <span className="text-white/25 font-normal">(optional — leave blank for full run)</span>
          </label>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="e.g. 5"
            value={testLimit}
            onChange={(e) => setTestLimit(e.target.value.replace(/\D/g, ''))}
            className="w-32 bg-[#0d1117] border border-white/[0.08] text-white/80 text-sm rounded-xl px-3 py-2 focus:outline-none focus:border-blue-500/60 focus:ring-1 focus:ring-blue-500/40 hover:border-white/20 transition-colors placeholder-white/20"
          />
          <p className="text-xs text-white/25 mt-1">
            Submits only the first N unanalyzed conversations. Use this to verify the flow before running the full dataset.
          </p>
        </div>

        {submitError && (
          <p className="text-xs text-red-400 bg-red-400/10 rounded-lg px-3 py-2">{submitError}</p>
        )}

        {submitResult && (
          <p className="text-xs text-green-400 bg-green-400/10 rounded-lg px-3 py-2">
            Submitted {submitResult.totalConversations.toLocaleString()} conversations in{' '}
            {submitResult.totalChunks} batch job{submitResult.totalChunks !== 1 ? 's' : ''}.{' '}
            {submitResult.isTest
              ? 'Test batch — results are typically ready within a few minutes.'
              : 'Results are typically ready within a few hours (max 24h).'}
          </p>
        )}

        <button
          onClick={handleSubmit}
          disabled={submitting || !selectedPromptId || prompts.length === 0}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded-xl transition-colors"
        >
          {submitting
            ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Submitting…</>
            : 'Submit Batch'}
        </button>
      </div>

      {/* Jobs list */}
      {loadingJobs ? (
        <div className="flex items-center justify-center py-16 text-white/30 text-sm">
          Loading jobs…
        </div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-16 text-white/30 text-sm">
          No batch jobs yet. Submit one above.
        </div>
      ) : (
        <div className="space-y-3">
          {/* Header row */}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-black">Batch Jobs</h2>
            {hasActiveJobs && (
              <span className="text-xs text-white/30">Auto-refreshing every 30s</span>
            )}
          </div>

          {/* Completed-jobs action banner */}
          {hasPendingImportJobs && (
            <div className="rounded-xl bg-blue-500 px-4 py-3 text-sm font-medium text-white shadow-lg shadow-blue-500/20">
              Completed jobs are ready to import. Click "Import Results" to write analysis to conversations.
            </div>
          )}

          {/* Filter tabs */}
          <div className="flex items-center gap-1 bg-[#161b22] border border-white/[0.08] rounded-xl p-1 w-fit">
            {([ ['all', 'All', jobs.length], ['action', 'Needs Action', actionCount], ['done', 'Done', doneCount] ] as [FilterTab, string, number][]).map(([tab, label, count]) => (
              <button
                key={tab}
                onClick={() => { setActiveTab(tab); setCurrentPage(1); }}
                className={[
                  'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors',
                  activeTab === tab
                    ? 'bg-white/10 text-white'
                    : 'text-white/40 hover:text-white/70',
                ].join(' ')}
              >
                {label}
                <span className={['text-xs rounded-full px-1.5 py-0.5 leading-none', activeTab === tab ? 'bg-white/15 text-white/80' : 'bg-white/5 text-white/30'].join(' ')}>
                  {count}
                </span>
              </button>
            ))}
          </div>

          {filteredJobs.length === 0 && (
            <div className="text-center py-8 text-white/25 text-sm">No jobs in this category.</div>
          )}

          {pagedJobs.map((job) => {
            const done = job.completed_conversations;
            const total = job.total_conversations;
            const progress = pct(done, total);
            const isImporting = importingJobId === job.id;
            const importResult = importResults[job.id];
            const alreadyImported = job.imported_count > 0 && job.imported_count >= total;

            // ── Compact row for terminal / done jobs ──────────────────────
            if (isDone(job)) {
              return (
                <div
                  key={job.id}
                  className="bg-[#161b22] border border-white/[0.08] rounded-xl px-4 py-2.5 flex items-center gap-3 flex-wrap"
                >
                  <span className={['text-xs font-medium px-2 py-0.5 rounded-full shrink-0', statusColor(job.status)].join(' ')}>
                    {statusLabel(job.status)}
                  </span>
                  <span className="text-xs text-white/40">{total.toLocaleString()} conversations</span>
                  {job.completed_at
                    ? <span className="text-xs text-white/25">Completed {fmtTime(job.completed_at)}</span>
                    : job.submitted_at
                    ? <span className="text-xs text-white/25">Submitted {fmtTime(job.submitted_at)}</span>
                    : null}
                  {job.error_message && (
                    <span className="text-xs text-red-400/70 truncate">{job.error_message}</span>
                  )}
                  {job.openai_batch_id && (
                    <span className="ml-auto font-mono text-xs text-white/20 truncate max-w-[200px]" title={job.openai_batch_id}>
                      {job.openai_batch_id}
                    </span>
                  )}
                </div>
              );
            }

            // ── Full card for actionable jobs ─────────────────────────────
            return (
              <div
                key={job.id}
                className="bg-[#161b22] border border-white/[0.08] rounded-2xl p-4 space-y-3"
              >
                {/* Top row */}
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={['text-xs font-medium px-2 py-0.5 rounded-full', statusColor(job.status)].join(' ')}>
                        {statusLabel(job.status)}
                      </span>
                      <span className="text-xs text-white/30">
                        Chunk {job.chunk_index + 1} / {job.total_chunks}
                      </span>
                      {job.submitted_at && (
                        <span className="text-xs text-white/25">
                          Submitted {fmtTime(job.submitted_at)}
                        </span>
                      )}
                    </div>
                    {job.openai_batch_id && (
                      <p className="text-xs text-white/25 mt-1 font-mono truncate">{job.openai_batch_id}</p>
                    )}
                  </div>

                  {/* Import button */}
                  {job.status === 'completed' && !alreadyImported && (
                    <button
                      onClick={() => handleImport(job)}
                      disabled={isImporting}
                      className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded-lg transition-colors"
                    >
                      {isImporting
                        ? <><div className="w-3 h-3 border border-white/30 border-t-white rounded-full animate-spin" />Importing…</>
                        : 'Import Results'}
                    </button>
                  )}


                  {/* Cancel button — only for active jobs */}
                  {ACTIVE_STATUSES.has(job.status) && (
                    <button
                      onClick={() => handleCancel(job)}
                      disabled={cancellingJobId === job.id}
                      className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-400 border border-red-400/30 hover:bg-red-400/10 disabled:opacity-50 rounded-lg transition-colors"
                    >
                      {cancellingJobId === job.id
                        ? <><div className="w-3 h-3 border border-red-400/30 border-t-red-400 rounded-full animate-spin" />Cancelling…</>
                        : 'Cancel'}
                    </button>
                  )}
                </div>

                {/* Progress bar */}
                {(ACTIVE_STATUSES.has(job.status) || job.status === 'completed') && (
                  <div>
                    <div className="flex justify-between text-xs text-white/30 mb-1">
                      <span>{done.toLocaleString()} / {total.toLocaleString()} processed</span>
                      <span>{progress}%</span>
                    </div>
                    <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                      <div
                        className={['h-full rounded-full transition-all duration-500', job.status === 'completed' ? 'bg-green-500' : 'bg-blue-500'].join(' ')}
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Import progress bar */}
                {job.status === 'completed' && job.imported_count > 0 && (
                  <div>
                    <div className="flex justify-between text-xs text-white/30 mb-1">
                      <span>{job.imported_count.toLocaleString()} / {total.toLocaleString()} imported</span>
                      <span>{pct(job.imported_count, total)}%</span>
                    </div>
                    <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-purple-500 rounded-full transition-all duration-500"
                        style={{ width: `${pct(job.imported_count, total)}%` }}
                      />
                    </div>
                    {!alreadyImported && (
                      <p className="text-xs text-amber-400/60 mt-1.5">Resume from {job.imported_count.toLocaleString()}</p>
                    )}
                  </div>
                )}

                {/* Import result summary */}
                {importResult && (
                  <p className="text-xs text-green-400 bg-green-400/10 rounded-lg px-3 py-2">
                    Imported {importResult.imported.toLocaleString()} analyses.
                    {importResult.failed > 0 && ` ${importResult.failed} failed.`}
                    {importResult.resumed_from > 0 && ` (Resumed from row ${importResult.resumed_from.toLocaleString()})`}
                  </p>
                )}

                {/* Error */}
                {job.error_message && (
                  <p className="text-xs text-red-400 bg-red-400/10 rounded-lg px-3 py-2">
                    {job.error_message}
                  </p>
                )}

                {/* Stats footer */}
                <div className="flex items-center gap-4 text-xs text-white/25 pt-1 border-t border-white/[0.04]">
                  <span>{total.toLocaleString()} conversations</span>
                  {job.failed_conversations > 0 && (
                    <span className="text-red-400/60">{job.failed_conversations.toLocaleString()} failed</span>
                  )}
                  {job.completed_at && (
                    <span>Completed {fmtTime(job.completed_at)}</span>
                  )}
                </div>
              </div>
            );
          })}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-white/25">
                {((safePage - 1) * JOBS_PER_PAGE) + 1}–{Math.min(safePage * JOBS_PER_PAGE, filteredJobs.length)} of {filteredJobs.length} jobs
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={safePage === 1}
                  className="px-2.5 py-1.5 text-xs text-white/40 hover:text-white disabled:opacity-20 disabled:cursor-not-allowed rounded-lg hover:bg-white/[0.05] transition-colors"
                >
                  ← Prev
                </button>
                {getPageNumbers(safePage, totalPages).map((p, i) =>
                  p === '…'
                    ? <span key={`ellipsis-${i}`} className="px-1.5 text-xs text-white/20">…</span>
                    : <button
                        key={p}
                        onClick={() => setCurrentPage(p)}
                        className={[
                          'w-7 h-7 text-xs rounded-lg transition-colors',
                          safePage === p
                            ? 'bg-white/10 text-white font-medium'
                            : 'text-white/40 hover:text-white hover:bg-white/[0.05]',
                        ].join(' ')}
                      >
                        {p}
                      </button>
                )}
                <button
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safePage === totalPages}
                  className="px-2.5 py-1.5 text-xs text-white/40 hover:text-white disabled:opacity-20 disabled:cursor-not-allowed rounded-lg hover:bg-white/[0.05] transition-colors"
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
