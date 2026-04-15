import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  getUnanalyzedConversationsByDate,
  dbGetActivePrompt,
  dbGetBatchJobs,
  dbUpdateBatchJob,
  dbInsertBatchJob,
  dbUpdateAnalysisFields,
} from '@/lib/db';
import type { BatchJob, BatchJobStatus } from '@/lib/types';
import { generateId } from '@/lib/utils';

// Allow up to 5 minutes on Vercel Pro
export const maxDuration = 300;

// ── Constants ──────────────────────────────────────────────────────────────
const MAX_REQUESTS_PER_CHUNK = 10_000;
const MAX_FILE_BYTES = 90 * 1024 * 1024;

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
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: promptContent },
        { role: 'user', content: buildUserMessage(conv) },
      ],
      temperature: 0.3,
      max_tokens: 2048,
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
// Step B — Find yesterday's (or ?date=) conversations with no summary and
//           submit them as a new OpenAI batch job using the active prompt.
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

  const dateParam = req.nextUrl.searchParams.get('date');
  const date = dateParam ?? yesterdayUtc();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'Invalid date format. Use YYYY-MM-DD.' }, { status: 400 });
  }

  let autoImportedJobs = 0;
  let autoImportedConversations = 0;
  let newBatchJobs = 0;
  let newBatchConversations = 0;

  // ── STEP A: Poll active jobs + auto-import completed ones ─────────────────
  try {
    const jobs = await dbGetBatchJobs();
    const activeStatuses: BatchJobStatus[] = ['validating', 'in_progress', 'finalizing'];

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
        (j.imported_count ?? 0) < j.total_conversations,
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

  // ── STEP B: Submit new batch for unanalyzed conversations on target date ───
  try {
    const conversations = await getUnanalyzedConversationsByDate(date);

    if (conversations.length === 0) {
      return NextResponse.json({
        date,
        auto_imported: { jobs: autoImportedJobs, conversations: autoImportedConversations },
        new_batch: { jobs: 0, conversations: 0, message: 'No unanalyzed conversations for this date.' },
      });
    }

    const prompt = await dbGetActivePrompt();
    if (!prompt) {
      return NextResponse.json({
        date,
        auto_imported: { jobs: autoImportedJobs, conversations: autoImportedConversations },
        new_batch: { jobs: 0, conversations: 0, message: 'No active prompt found. Set one in the Prompt Library.' },
      });
    }

    const lines = conversations.map((c) => buildJsonlLine(c, prompt.content));
    const chunks = chunkLines(lines);
    const totalChunks = chunks.length;
    const now = new Date().toISOString();

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const jobId = generateId();
      try {
        const fileName = `daily_${date}_chunk_${i}_${Date.now()}.jsonl`;
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
  } catch (e) {
    console.error('[cron] analyze-daily step B error:', e);
  }

  console.log(
    `[cron] analyze-daily ${date}: auto_imported=${autoImportedConversations} new_batch=${newBatchConversations}`,
  );

  return NextResponse.json({
    date,
    auto_imported: { jobs: autoImportedJobs, conversations: autoImportedConversations },
    new_batch: { jobs: newBatchJobs, conversations: newBatchConversations },
  });
}
