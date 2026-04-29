import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  countUnanalyzedConversations,
  getUnanalyzedConversationsPage,
  dbGetActivePrompt,
  dbGetBatchJobs,
  dbUpdateBatchJob,
  dbInsertBatchJob,
  dbUpdateAnalysisFields,
  dbInsertAnalysisRun,
} from '@/lib/db';
import type { BatchJob, BatchJobStatus, AnalysisRun } from '@/lib/types';
import { generateId } from '@/lib/utils';
import { ANALYSIS_MIN_DATE_ISO } from '@/lib/analyticsFilters';

// Allow up to 5 minutes on Vercel Pro
export const maxDuration = 300;

// ── Constants ──────────────────────────────────────────────────────────────
// Chunk size of 500 was originally tuned for gpt-4o-mini Tier 1 (2M enqueued-
// token cap). When switching models or tiers, re-check OpenAI's per-org
// enqueued-token limit and adjust: if a batch fails with
// token_limit_exceeded, drop this further.
const MAX_REQUESTS_PER_CHUNK = 500;
const MAX_FILE_BYTES = 90 * 1024 * 1024;
// Submit up to 3 batches per cron run so a 600–1500 chat day can be sent to
// OpenAI in a single hourly run instead of trickling out one batch/hour. With
// 500 chats/batch and ~3k input tokens/chat, 3 batches ≈ 4.5M enqueued tokens
// — well under gpt-5-mini's tier cap. If a batch fails with
// token_limit_exceeded the per-chunk try/catch logs and continues, so previous
// chunks already submitted are not lost.
const MAX_CHUNKS_PER_RUN = 3;

// ── Helpers ────────────────────────────────────────────────────────────────

function yesterdayUtc(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function buildUserMessage(conv: {
  intercom_id: string | null;
  player_name: string | null;
  player_email: string | null;
  agent_name: string | null;
  brand: string | null;
  original_text: string | null;
}): string {
  return [
    `Conversation ID: ${conv.intercom_id ?? 'N/A'}`,
    `Player: ${conv.player_name ?? 'Unknown'} (${conv.player_email ?? 'no email'})`,
    `Agent: ${conv.agent_name ?? 'Unknown'}`,
    `Brand: ${conv.brand ?? 'Unknown'}`,
    '',
    'Transcript:',
    conv.original_text ?? '',
  ].join('\n');
}

function buildJsonlLine(conv: {
  id: string;
  intercom_id: string | null;
  player_name: string | null;
  player_email: string | null;
  agent_name: string | null;
  brand: string | null;
  original_text: string | null;
}, promptContent: string): string {
  return JSON.stringify({
    custom_id: `conv-${conv.id}`,
    method: 'POST',
    url: '/v1/chat/completions',
    body: {
      model: 'gpt-5-mini',
      messages: [
        { role: 'system', content: promptContent },
        { role: 'user', content: buildUserMessage(conv) },
      ],
      // gpt-5 family rejects 'max_tokens' (use 'max_completion_tokens') and
      // most reasoning models only allow the default temperature, so we omit
      // temperature rather than risk a 500-row batch failing on validation.
      max_completion_tokens: 2048,
    },
  });
}

function chunkLines(lines: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (
      current.length >= MAX_REQUESTS_PER_CHUNK ||
      (current.length > 0 && currentBytes + lineBytes > MAX_FILE_BYTES)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(line);
    currentBytes += lineBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function uploadJsonlToOpenAI(lines: string[], fileName: string, apiKey: string): Promise<string> {
  const blob = new Blob([lines.join('\n')], { type: 'application/jsonl' });
  const form = new FormData();
  form.append('purpose', 'batch');
  form.append('file', blob, fileName);
  const res = await fetch('https://api.openai.com/v1/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI file upload failed: ${data.error?.message ?? res.status}`);
  return data.id as string;
}

async function createOpenAIBatch(fileId: string, apiKey: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/batches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      input_file_id: fileId,
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI batch create failed: ${data.error?.message ?? res.status}`);
  return data.id as string;
}

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
// Step A — Poll OpenAI for active batch jobs, then auto-import any that are
//           complete so results appear in the DB without manual intervention.
//
// Step B — Find ALL conversations with no summary and submit them as a new
//           OpenAI batch job using the active prompt. Skips submission when
//           active batch jobs are still in-flight (they already cover the
//           unanalyzed set), so conversations are never submitted twice.
//
// Schedule this cron 1 hour after collect-daily (e.g. 3 AM CEST).

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
  let newBatchJobs = 0;
  let newBatchConversations = 0;

  // ── STEP A: Poll active jobs + auto-import completed ones ─────────────────
  const activeStatuses: BatchJobStatus[] = ['validating', 'in_progress', 'finalizing'];
  let hasActiveJobs = false;

  try {
    const jobs = await dbGetBatchJobs();

    // 1. Poll OpenAI to refresh statuses for active jobs
    for (const job of jobs.filter((j) => j.openai_batch_id && activeStatuses.includes(j.status))) {
      try {
        const res = await fetch(`https://api.openai.com/v1/batches/${job.openai_batch_id}`, {
          headers: { Authorization: `Bearer ${openAIKey}` },
        });
        if (!res.ok) continue;
        const b = await res.json();
        const newStatus = mapOpenAIStatus(b.status);
        const patch: Partial<BatchJob> = { status: newStatus };
        if (newStatus === 'completed') {
          patch.output_file_id = b.output_file_id ?? null;
          patch.completed_at = new Date().toISOString();
          patch.completed_conversations = b.request_counts?.completed ?? job.completed_conversations;
          patch.failed_conversations = b.request_counts?.failed ?? job.failed_conversations;
        }
        if (newStatus !== job.status || patch.output_file_id) {
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

    // Check if any jobs are still active after polling (Step B should wait)
    hasActiveJobs = jobs.some((j) => activeStatuses.includes(j.status));
  } catch (e) {
    console.error('[cron] analyze-daily step A error:', e);
  }

  // ── STEP B: Submit batch for ALL unanalyzed conversations ─────────────────
  //
  // Skip when active batch jobs exist — they already cover the unanalyzed set
  // and we don't want to submit the same conversations twice. On the next daily
  // run, Step A will import those results and Step B will pick up any new ones.
  try {
    if (hasActiveJobs) {
      console.log('[cron] analyze-daily step B skipped: active batch jobs still in-flight');
    } else {
      // Floor to ANALYSIS_MIN_DATE_ISO so the cron only analyzes conversations
      // from the dashboard cutoff onward — pre-cutoff rows stay in the DB but
      // are intentionally skipped (no OpenAI spend on data the dashboard won't
      // show anyway).
      const dateFilter = { fromDate: ANALYSIS_MIN_DATE_ISO };
      const totalUnanalyzed = await countUnanalyzedConversations(dateFilter);

      if (totalUnanalyzed === 0) {
        console.log('[cron] analyze-daily step B: no unanalyzed conversations');
      } else {
        const prompt = await dbGetActivePrompt();
        if (!prompt) {
          console.warn('[cron] analyze-daily step B: no active prompt found');
        } else {
          // Only load enough rows for the 1 chunk we'll actually submit this
          // run. Loading all 25k+ unanalyzed into memory just to slice 500 of
          // them was OOM'ing the function (each row carries up to 60KB of
          // original_text, ~500MB total at scale → 500s).
          const targetRows = MAX_REQUESTS_PER_CHUNK * MAX_CHUNKS_PER_RUN;
          const page = await getUnanalyzedConversationsPage(0, targetRows, dateFilter);
          const lines = page.map((c) => buildJsonlLine(c, prompt.content));
          const chunks = chunkLines(lines);
          const totalChunks = Math.ceil(totalUnanalyzed / MAX_REQUESTS_PER_CHUNK);
          const now = new Date().toISOString();

          for (let i = 0; i < chunks.length && newBatchJobs < MAX_CHUNKS_PER_RUN; i++) {
            const chunk = chunks[i];
            const jobId = generateId();
            try {
              const fileName = `daily_${yesterdayUtc()}_chunk_${i}_${Date.now()}.jsonl`;
              const fileId = await uploadJsonlToOpenAI(chunk, fileName, openAIKey);
              const batchId = await createOpenAIBatch(fileId, openAIKey);

              await dbInsertBatchJob({
                id: jobId,
                openai_batch_id: batchId,
                openai_file_id: fileId,
                output_file_id: null,
                status: 'validating',
                prompt_id: prompt.id,
                prompt_content: prompt.content,
                chunk_index: i,
                total_chunks: totalChunks,
                total_conversations: chunk.length,
                completed_conversations: 0,
                failed_conversations: 0,
                imported_count: 0,
                error_message: null,
                created_at: now,
                submitted_at: now,
                completed_at: null,
              });

              newBatchJobs++;
              newBatchConversations += chunk.length;
            } catch (e) {
              console.error(`[cron] analyze-daily chunk ${i} failed:`, e);
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('[cron] analyze-daily step B error:', e);
  }

  console.log(
    `[cron] analyze-daily: auto_imported=${autoImportedConversations} new_batch=${newBatchConversations}`,
  );

  return NextResponse.json({
    auto_imported: { jobs: autoImportedJobs, conversations: autoImportedConversations },
    new_batch: { jobs: newBatchJobs, conversations: newBatchConversations },
  });
}
