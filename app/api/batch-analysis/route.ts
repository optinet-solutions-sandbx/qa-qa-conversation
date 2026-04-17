import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  countUnanalyzedConversations,
  getUnanalyzedConversationsPage,
  dbInsertBatchJob,
  dbUpdateBatchJob,
  dbGetBatchJobs,
  dbGetBatchJobById,
  dbBatchUpdateAnalysisFields,
  dbBatchInsertAnalysisRuns,
  getConversationMetadataBatch,
  type MinimalConversation,
} from '@/lib/db';
import type { BatchJob, BatchJobStatus, AnalysisRun } from '@/lib/types';
import { generateId } from '@/lib/utils';

// Allow up to 5 minutes — fetching 26k+ rows in pages + uploading to OpenAI
// takes well over the default 10s Vercel limit.
export const maxDuration = 300;

// ── Rate-limit / size guards ───────────────────────────────────────────────
// OpenAI Batch API limits: 50k requests per file, 100 MB per file.
// Each conversation at ~5-8 KB of JSONL → 10k requests ≈ 50-80 MB, safely
// under both limits and well within the enqueued-token budget for Tier-1 keys.
const MAX_REQUESTS_PER_CHUNK = 10_000;
const MAX_FILE_BYTES = 90 * 1024 * 1024; // 90 MB hard cap

// ── Helpers ────────────────────────────────────────────────────────────────

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
      model: 'gpt-5.1-mini',
      messages: [
        { role: 'system', content: promptContent },
        { role: 'user', content: buildUserMessage(conv) },
      ],
      temperature: 0.3,
      max_tokens: 2048,
    },
  });
}

/**
 * Split JSONL lines into chunks, respecting both the per-chunk request cap
 * and the 90 MB file-size cap. Each chunk becomes one OpenAI batch job.
 */
function chunkLines(lines: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;

  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // +1 for '\n'
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

async function uploadJsonlToOpenAI(
  lines: string[],
  fileName: string,
  apiKey: string
): Promise<string> {
  const content = lines.join('\n');
  const blob = new Blob([content], { type: 'application/jsonl' });
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

// Map OpenAI batch statuses to our BatchJobStatus type
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

// ── POST: submit a new batch (or resume remaining unanalyzed) ──────────────
//
// Body: { promptId: string; promptContent: string }
//
// Strategy:
//  1. Query conversations WHERE summary IS NULL — skips already-analyzed rows
//     automatically, so re-submitting after a partial failure is safe.
//  2. Fetch Supabase pages of 1k rows (Supabase's default max_rows cap) and
//     accumulate them into a buffer. Flush the buffer to one OpenAI batch job
//     every MAX_REQUESTS_PER_CHUNK (10k) rows — so 23k conversations → 3 jobs,
//     not 23.
//  3. Each OpenAI batch file is ≤10k requests and ≤90 MB.

export async function POST(req: NextRequest) {
  try {
  return await _POST(req);
  } catch (e) {
    console.error('[batch-analysis POST] unhandled error:', e);
    return NextResponse.json({ error: (e as Error).message ?? 'Internal server error' }, { status: 500 });
  }
}

async function _POST(req: NextRequest) {
  const openAIKey = process.env.OPENAI_API_KEY;
  if (!openAIKey) return NextResponse.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 });

  let body: { promptId?: string; promptContent?: string; testLimit?: number };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const { promptId, promptContent, testLimit } = body;
  if (!promptContent?.trim()) return NextResponse.json({ error: 'promptContent is required' }, { status: 400 });

  // Step 1 — fast count query (no data transfer) to fail early if nothing to do
  let totalAvailable: number;
  try {
    totalAvailable = await countUnanalyzedConversations();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  if (totalAvailable === 0) {
    return NextResponse.json({ message: 'No unanalyzed conversations found.', jobs: [] });
  }

  // Cap to testLimit when provided
  const effectiveTotal = (testLimit && testLimit > 0)
    ? Math.min(testLimit, totalAvailable)
    : totalAvailable;

  // Step 2 — fetch Supabase pages (capped at 1k rows each by Supabase's default
  // max_rows limit) and accumulate them into a buffer. Only submit one OpenAI
  // batch job per MAX_REQUESTS_PER_CHUNK rows so we create ~3 batches for 23k
  // conversations instead of 23 separate 1k batches.
  const SUPABASE_PAGE_SIZE = 1_000;
  const now = new Date().toISOString();
  const createdJobs: BatchJob[] = [];
  let from = 0;
  let chunkIndex = 0;
  let buffer: MinimalConversation[] = [];

  const flushBuffer = async () => {
    if (buffer.length === 0) return;
    const lines = buffer.map((c) => buildJsonlLine(c, promptContent));
    buffer = [];
    const subChunks = chunkLines(lines);
    for (const subChunk of subChunks) {
      const jobId = generateId();
      try {
        const fileName = `batch_chunk_${chunkIndex}_${Date.now()}.jsonl`;
        const fileId = await uploadJsonlToOpenAI(subChunk, fileName, openAIKey);
        const batchId = await createOpenAIBatch(fileId, openAIKey);
        const job: BatchJob = {
          id: jobId,
          openai_batch_id: batchId,
          openai_file_id: fileId,
          output_file_id: null,
          status: 'validating',
          prompt_id: promptId ?? null,
          prompt_content: promptContent,
          chunk_index: chunkIndex,
          total_chunks: 0,
          total_conversations: subChunk.length,
          completed_conversations: 0,
          failed_conversations: 0,
          imported_count: 0,
          error_message: null,
          created_at: now,
          submitted_at: now,
          completed_at: null,
        };
        await dbInsertBatchJob(job);
        createdJobs.push(job);
      } catch (e) {
        const failedJob: BatchJob = {
          id: jobId,
          openai_batch_id: null,
          openai_file_id: null,
          output_file_id: null,
          status: 'failed',
          prompt_id: promptId ?? null,
          prompt_content: promptContent,
          chunk_index: chunkIndex,
          total_chunks: 0,
          total_conversations: subChunk.length,
          completed_conversations: 0,
          failed_conversations: subChunk.length,
          imported_count: 0,
          error_message: (e as Error).message,
          created_at: now,
          submitted_at: null,
          completed_at: null,
        };
        try { await dbInsertBatchJob(failedJob); } catch (dbErr) {
          console.error('[batch-analysis] failed to save failed job record:', dbErr);
        }
        createdJobs.push(failedJob);
      }
      chunkIndex++;
    }
  };

  while (from < effectiveTotal) {
    const pageLimit = Math.min(SUPABASE_PAGE_SIZE, effectiveTotal - from);

    let page: MinimalConversation[];
    try {
      page = await getUnanalyzedConversationsPage(from, pageLimit);
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }

    if (page.length === 0) break;

    buffer.push(...page);
    from += page.length;

    // Flush once buffer reaches the OpenAI chunk size, or on the last page
    const isLastPage = page.length < pageLimit || from >= effectiveTotal;
    if (buffer.length >= MAX_REQUESTS_PER_CHUNK || isLastPage) {
      try {
        await flushBuffer();
      } catch (e) {
        return NextResponse.json({ error: (e as Error).message }, { status: 500 });
      }
    }

    if (page.length < pageLimit) break;
  }

  // Step 3 — back-fill total_chunks now that we know the real count
  const totalChunks = createdJobs.length;
  await Promise.all(
    createdJobs.map((job) => dbUpdateBatchJob(job.id, { total_chunks: totalChunks }))
  );

  return NextResponse.json({
    jobs: createdJobs.map((j) => ({ ...j, total_chunks: totalChunks })),
    totalConversations: effectiveTotal,
    totalChunks,
  });
}

// ── GET: check status of all batch jobs (polls OpenAI for in-progress ones) ─

export async function GET() {
  const openAIKey = process.env.OPENAI_API_KEY;
  if (!openAIKey) return NextResponse.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 });

  let jobs: BatchJob[];
  try {
    jobs = await dbGetBatchJobs();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  // Only poll OpenAI for jobs that aren't in a terminal state
  const activeStatuses: BatchJobStatus[] = ['validating', 'in_progress', 'finalizing'];
  const updates = jobs
    .filter((j) => j.openai_batch_id && activeStatuses.includes(j.status))
    .map(async (job) => {
      try {
        const res = await fetch(`https://api.openai.com/v1/batches/${job.openai_batch_id}`, {
          headers: { Authorization: `Bearer ${openAIKey}` },
        });
        if (!res.ok) return job;
        const b = await res.json();

        const newStatus = mapOpenAIStatus(b.status);
        const counts = b.request_counts ?? {};
        const patch: Partial<BatchJob> = {
          status: newStatus,
          completed_conversations: counts.completed ?? job.completed_conversations,
          failed_conversations: counts.failed ?? job.failed_conversations,
        };

        if (newStatus === 'completed') {
          patch.output_file_id = b.output_file_id ?? null;
          patch.completed_at = new Date().toISOString();
        }
        if (newStatus === 'failed' || newStatus === 'expired') {
          patch.error_message = b.errors?.data?.[0]?.message ?? newStatus;
        }

        // Persist only if something changed
        const changed =
          newStatus !== job.status ||
          patch.output_file_id !== undefined ||
          patch.completed_conversations !== job.completed_conversations;

        if (changed) await dbUpdateBatchJob(job.id, patch);

        return { ...job, ...patch };
      } catch {
        return job;
      }
    });

  const refreshed = await Promise.all(updates);

  // Merge refreshed jobs back with terminal jobs
  const refreshedMap = new Map(refreshed.map((j) => [j.id, j]));
  const merged = jobs.map((j) => refreshedMap.get(j.id) ?? j);

  return NextResponse.json({ jobs: merged });
}

// ── PATCH: import results from a completed batch job ──────────────────────
//
// Resume-safe: tracks `imported_count` in the DB, updated every 100 rows.
// If the import crashes at row 27,000 out of 30,000:
//   • Re-call PATCH — it skips the first 27,000 lines and continues from there.
//   • If for any reason you want a clean re-import, reset imported_count to 0
//     in the DB first — each write is an upsert, so re-importing is harmless.
//
// Body: { batchJobId: string }

export async function PATCH(req: NextRequest) {
  const openAIKey = process.env.OPENAI_API_KEY;
  if (!openAIKey) return NextResponse.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 });

  let body: { batchJobId?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const { batchJobId } = body;
  if (!batchJobId) return NextResponse.json({ error: 'batchJobId is required' }, { status: 400 });

  let job: BatchJob | null;
  try { job = await dbGetBatchJobById(batchJobId); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }); }
  if (!job) return NextResponse.json({ error: 'Batch job not found' }, { status: 404 });
  if (job.status !== 'completed') {
    return NextResponse.json({ error: `Batch is not completed yet (status: ${job.status})` }, { status: 400 });
  }
  if (!job.output_file_id) {
    return NextResponse.json({ error: 'output_file_id not available — try refreshing status first' }, { status: 400 });
  }

  // Download the output JSONL from OpenAI
  const outputRes = await fetch(`https://api.openai.com/v1/files/${job.output_file_id}/content`, {
    headers: { Authorization: `Bearer ${openAIKey}` },
  });
  if (!outputRes.ok) {
    return NextResponse.json({ error: `Failed to download output file: ${outputRes.status}` }, { status: 500 });
  }

  const rawText = await outputRes.text();
  const lines = rawText.split('\n').filter((l) => l.trim().length > 0);

  // Resume cursor — skip lines we already imported in a previous run
  const startAt = job.imported_count ?? 0;
  const promptId = job.prompt_id;
  const promptContent = job.prompt_content ?? '';
  const now = new Date().toISOString();

  // Pre-fetch conversation metadata (title + player_name) only for lines that
  // still need importing (from startAt onwards) to avoid Supabase URL-length
  // limits and wasted work when resuming a partially-completed import.
  const pendingConvIds = lines.slice(startAt)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .map((r: { custom_id?: string }) => {
      const id = r.custom_id ?? '';
      return id.startsWith('conv-') ? id.slice(5) : null;
    })
    .filter((id): id is string => id !== null);
  const convMeta = await getConversationMetadataBatch(pendingConvIds);

  let imported = startAt; // running total including previous partial imports
  let failed = 0;

  // Accumulators for batch writes — flushed every 100 rows.
  // This reduces DB round trips from 2 per row to ~2 per 100 rows.
  const BATCH_SIZE = 100;
  type ConvUpdate = { id: string; summary: string; last_prompt_id: string | null; last_prompt_content: string | null; analyzed_at: string };
  let convBatch: ConvUpdate[] = [];
  let runBatch: AnalysisRun[] = [];

  const flushBatch = async () => {
    if (convBatch.length === 0) return;
    await Promise.all([
      dbBatchUpdateAnalysisFields(convBatch),
      dbBatchInsertAnalysisRuns(runBatch),
    ]);
    convBatch = [];
    runBatch = [];
  };

  for (let i = startAt; i < lines.length; i++) {
    const line = lines[i];
    try {
      const result = JSON.parse(line);

      // OpenAI marks individual request errors in result.error
      if (result.error || result.response?.status_code !== 200) {
        failed++;
        continue;
      }

      // custom_id format: "conv-{uuid}"
      const customId: string = result.custom_id ?? '';
      const convId = customId.startsWith('conv-') ? customId.slice(5) : null;
      if (!convId) { failed++; continue; }

      const analysisText: string | null =
        result.response?.body?.choices?.[0]?.message?.content ?? null;
      if (!analysisText) { failed++; continue; }

      convBatch.push({
        id: convId,
        summary: analysisText,
        last_prompt_id: promptId ?? null,
        last_prompt_content: promptContent,
        analyzed_at: now,
      });

      const meta = convMeta.get(convId);
      runBatch.push({
        id: generateId(),
        conversation_id: convId,
        conversation_title: meta?.title ?? null,
        player_name: meta?.player_name ?? null,
        analyzed_at: now,
        prompt_id: promptId ?? null,
        prompt_title: null,
        prompt_content: promptContent,
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
      });

      imported++;
    } catch {
      failed++;
    }

    // Flush every BATCH_SIZE rows: persist cursor + write to DB
    if (convBatch.length >= BATCH_SIZE) {
      await flushBatch();
      await dbUpdateBatchJob(job.id, { imported_count: imported });
    }
  }

  // Flush any remaining rows
  await flushBatch();

  // Final update
  await dbUpdateBatchJob(job.id, {
    imported_count: imported,
    completed_conversations: imported,
    failed_conversations: failed,
  });

  return NextResponse.json({
    imported: imported - startAt, // newly imported in this run
    failed,
    total: lines.length,
    resumed_from: startAt,
  });
}

// ── DELETE: cancel an active batch job ────────────────────────────────────
//
// Body: { batchJobId: string }
// Calls OpenAI's cancel endpoint, then updates our DB record to 'cancelling'.

export async function DELETE(req: NextRequest) {
  const openAIKey = process.env.OPENAI_API_KEY;
  if (!openAIKey) return NextResponse.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 });

  let body: { batchJobId?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const { batchJobId } = body;
  if (!batchJobId) return NextResponse.json({ error: 'batchJobId is required' }, { status: 400 });

  let job: BatchJob | null;
  try { job = await dbGetBatchJobById(batchJobId); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }); }
  if (!job) return NextResponse.json({ error: 'Batch job not found' }, { status: 404 });

  const cancellableStatuses: BatchJobStatus[] = ['validating', 'in_progress', 'finalizing'];
  if (!cancellableStatuses.includes(job.status)) {
    return NextResponse.json({ error: `Job cannot be cancelled (status: ${job.status})` }, { status: 400 });
  }

  if (!job.openai_batch_id) {
    return NextResponse.json({ error: 'No OpenAI batch ID on record' }, { status: 400 });
  }

  const res = await fetch(`https://api.openai.com/v1/batches/${job.openai_batch_id}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${openAIKey}` },
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(
      { error: `OpenAI cancel failed: ${data?.error?.message ?? res.status}` },
      { status: 500 },
    );
  }

  await dbUpdateBatchJob(batchJobId, { status: 'cancelling' });

  return NextResponse.json({ success: true });
}
