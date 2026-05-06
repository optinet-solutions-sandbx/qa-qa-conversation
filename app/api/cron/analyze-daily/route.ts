import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  getUnanalyzedConversationsPage,
  dbGetActivePrompt,
  dbGetBatchJobs,
  dbUpdateBatchJob,
  dbUpdateAnalysisFields,
  dbInsertAnalysisRun,
} from '@/lib/db';
import type { BatchJob, BatchJobStatus, AnalysisRun } from '@/lib/types';
import { generateId } from '@/lib/utils';
import { ANALYSIS_MIN_DATE_ISO } from '@/lib/analyticsFilters';
import { analyzeBatchSequential } from '@/lib/analyze-sync';
import { maybeCreateAsanaTicketForConversation } from '@/lib/asana';

// Allow up to 5 minutes on Vercel Pro
export const maxDuration = 300;

// ── Sync-analysis sizing ───────────────────────────────────────────────────
// Each cron tick analyzes up to MAX_PER_TICK April-27+ conversations through
// analyzeBatchSequential, which paces calls 8s apart. gpt-4o tier-1 has a
// 30k TPM cap and each call is ~10k tokens; strict pacing would be 20s, but
// 8s keeps the tick under Vercel's 300s ceiling and the per-call 429 retry
// in analyzeConversationSync absorbs occasional cap breaches.
//
// Per-tick budget: 16 calls × ~7s API + 15 × 8s sleep ≈ 232s, inside the
// 300s Vercel function timeout. Earlier 15s spacing pushed the budget to
// ~305-385s and the function was 504-timing-out every tick (logs 2026-05-06).
// Cron schedule is */15 (96 ticks/day, see vercel.json), so capacity ≈
// 16 × 96 = 1536 chats/day — well above the 600–1000 daily volume target.
const MAX_PER_TICK = 16;

// ── Helpers ────────────────────────────────────────────────────────────────

function mapOpenAIStatus(s: string): BatchJobStatus {
  const map: Record<string, BatchJobStatus> = {
    validating: 'validating',
    in_progress: 'in_progress',
    finalizing: 'finalizing',
    completed: 'completed',
    expired: 'expired',
    cancelling: 'cancelling',
    cancelled: 'cancelled',
    failed: 'failed',
  };
  return map[s] ?? 'in_progress';
}

// ── GET /api/cron/analyze-daily ────────────────────────────────────────────
//
// Step A — Drain any leftover OpenAI Batch jobs from the previous Batch-API-
//          based architecture: poll their status, import any that completed.
//          Once the backlog of Batch jobs is gone this is a no-op.
//
// Step B — Synchronously analyze up to MAX_PER_TICK unanalyzed April-27+
//          conversations via /v1/chat/completions (parallel waves of
//          PARALLEL_CHUNK). Replaces the prior Batch-API submission path,
//          which was unreliable on this org (74% historical failure rate,
//          batches stalling at 0/N for hours).
//
// Schedule: hourly at :30 UTC, paired with collect-daily at :00 UTC.

export async function GET(req: NextRequest) {
  // ── Auth ─────────────────────────────────────────────────────────────────
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization') ?? '';
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const openAIKey = process.env.OPENAI_API_KEY;
  if (!openAIKey) {
    return NextResponse.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 });
  }

  let autoImportedJobs = 0;
  let autoImportedConversations = 0;

  // ── STEP A: Drain leftover Batch jobs ─────────────────────────────────────
  // Keeps the old async-Batch path's bookkeeping correct for any in-flight or
  // completed-not-yet-imported jobs that exist from before the sync switchover.
  // Once those are all imported/cancelled this entire block becomes a no-op.
  const activeStatuses: BatchJobStatus[] = ['validating', 'in_progress', 'finalizing'];

  try {
    const jobs = await dbGetBatchJobs();

    // 1. Poll OpenAI to refresh statuses for any active jobs
    for (const job of jobs.filter((j) => j.openai_batch_id && activeStatuses.includes(j.status))) {
      try {
        const res = await fetch(`https://api.openai.com/v1/batches/${job.openai_batch_id}`, {
          headers: { Authorization: `Bearer ${openAIKey}` },
        });
        if (!res.ok) continue;
        const b = await res.json();
        const newStatus = mapOpenAIStatus(b.status);
        const patch: Partial<BatchJob> = { status: newStatus };

        // Mirror live progress counts into the DB on every poll so the
        // /batch-analysis UI shows real progress instead of 0% → 100% jump.
        const oaCompleted = b.request_counts?.completed ?? null;
        const oaFailed = b.request_counts?.failed ?? null;
        if (oaCompleted != null && oaCompleted !== job.completed_conversations) {
          patch.completed_conversations = oaCompleted;
        }
        if (oaFailed != null && oaFailed !== job.failed_conversations) {
          patch.failed_conversations = oaFailed;
        }
        if (newStatus === 'completed') {
          patch.output_file_id = b.output_file_id ?? null;
          patch.completed_at = new Date().toISOString();
        }
        if (
          newStatus !== job.status ||
          patch.output_file_id ||
          patch.completed_conversations != null ||
          patch.failed_conversations != null
        ) {
          await dbUpdateBatchJob(job.id, patch);
          Object.assign(job, patch);
        }
      } catch { continue; }
    }

    // 2. Auto-import completed jobs that haven't been fully imported yet
    const toImport = jobs.filter(
      (j) =>
        j.status === 'completed' &&
        j.output_file_id &&
        (j.imported_count ?? 0) < (j.completed_conversations ?? j.total_conversations),
    );

    for (const job of toImport) {
      try {
        const outputRes = await fetch(`https://api.openai.com/v1/files/${job.output_file_id}/content`, {
          headers: { Authorization: `Bearer ${openAIKey}` },
        });
        if (!outputRes.ok) continue;

        const lines = (await outputRes.text()).split('\n').filter((l) => l.trim().length > 0);
        const startAt = job.imported_count ?? 0;
        const now = new Date().toISOString();
        let imported = startAt;

        for (let i = startAt; i < lines.length; i++) {
          try {
            const result = JSON.parse(lines[i]);
            if (result.error || result.response?.status_code !== 200) continue;
            const convId = result.custom_id?.startsWith('conv-') ? result.custom_id.slice(5) : null;
            if (!convId) continue;
            const analysisText: string | null =
              result.response?.body?.choices?.[0]?.message?.content ?? null;
            if (!analysisText) continue;
            await dbUpdateAnalysisFields(convId, {
              summary: analysisText,
              last_prompt_id: job.prompt_id,
              last_prompt_content: job.prompt_content ?? '',
              analyzed_at: now,
            });

            const run: AnalysisRun = {
              id: generateId(),
              conversation_id: convId,
              conversation_title: null,
              player_name: null,
              analyzed_at: now,
              prompt_id: job.prompt_id ?? null,
              prompt_title: null,
              prompt_content: job.prompt_content ?? '',
              summary: analysisText,
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
            await dbInsertAnalysisRun(run);

            // Severity-3 → push an Asana action-item ticket. Helper internally
            // dedups via asana_task_gid and swallows all errors so a flaky
            // Asana API can never break the import loop.
            await maybeCreateAsanaTicketForConversation(convId, analysisText);

            imported++;
          } catch { continue; }

          if ((i + 1) % 100 === 0) {
            await dbUpdateBatchJob(job.id, { imported_count: imported });
          }
        }

        await dbUpdateBatchJob(job.id, { imported_count: imported });
        autoImportedJobs++;
        autoImportedConversations += imported - startAt;
      } catch { continue; }
    }
  } catch (e) {
    console.error('[cron] analyze-daily step A error:', e);
  }

  // ── STEP B: Synchronously analyze unanalyzed April-27+ conversations ──────
  // Replaces the prior Batch-API submission path. Each tick processes up to
  // MAX_PER_TICK conversations in parallel waves, writing summaries inline.
  // Failed conversations stay summary-IS-NULL and are picked up next tick.

  let syncAnalyzed = 0;
  let syncFailed = 0;

  try {
    const prompt = await dbGetActivePrompt();
    if (!prompt) {
      console.warn('[cron] analyze-daily step B: no active prompt found');
    } else {
      const dateFilter = { fromDate: ANALYSIS_MIN_DATE_ISO };
      const conversations = await getUnanalyzedConversationsPage(0, MAX_PER_TICK, dateFilter);

      if (conversations.length === 0) {
        console.log('[cron] analyze-daily step B: no unanalyzed conversations');
      } else {
        const results = await analyzeBatchSequential(conversations, prompt, openAIKey);
        for (const r of results) {
          if (r.status === 'analyzed') syncAnalyzed++;
          else syncFailed++;
        }
      }
    }
  } catch (e) {
    console.error('[cron] analyze-daily step B error:', e);
  }

  console.log(
    `[cron] analyze-daily: auto_imported=${autoImportedConversations} sync_analyzed=${syncAnalyzed} sync_failed=${syncFailed}`,
  );

  return NextResponse.json({
    auto_imported: { jobs: autoImportedJobs, conversations: autoImportedConversations },
    sync: { analyzed: syncAnalyzed, failed: syncFailed },
  });
}
