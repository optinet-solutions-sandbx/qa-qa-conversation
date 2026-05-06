// Shared synchronous-analysis helper used by /api/admin/sync-analyze (manual
// catch-up) and the /api/cron/analyze-daily Step B (autonomous daily flow).
// Both paths must produce identical DB writes so the dashboard sees uniform
// analysis output regardless of how a conversation got analyzed.
//
// We use the synchronous /v1/chat/completions endpoint (not Batch API) for
// reliability — Batch has shown 70%+ failure rates on this org and stalls
// without warning. Sync is ~2× cost but completes in real time and self-heals
// since failed conversations stay summary-IS-NULL and re-enter the queue on
// the next cron tick.

import {
  dbUpdateAnalysisFields,
  dbInsertAnalysisRun,
  type MinimalConversation,
} from '@/lib/db';
import { generateId } from '@/lib/utils';
import type { AnalysisRun } from '@/lib/types';
import { maybeCreateAsanaTicketForConversation } from '@/lib/asana';

export interface SyncAnalysisResult {
  conversation_id: string;
  intercom_id: string | null;
  status: 'analyzed' | 'failed';
  error?: string;
  durationMs?: number;
}

function buildUserMessage(conv: MinimalConversation): string {
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Parse OpenAI's "Please try again in 21.186s" hint from a 429 body. Returns
// the suggested wait in ms, capped at 30s, with a 500ms safety buffer. Falls
// back to 20s if the hint isn't present.
function parseRetryAfterMs(body: string): number {
  const match = body.match(/try again in ([\d.]+)\s*s/i);
  const seconds = match ? parseFloat(match[1]) : 20;
  return Math.min(seconds * 1000 + 500, 30_000);
}

export async function analyzeConversationSync(
  conv: MinimalConversation,
  prompt: { id: string; content: string },
  apiKey: string,
): Promise<SyncAnalysisResult> {
  const startedAt = Date.now();
  try {
    const requestBody = JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: prompt.content },
        { role: 'user', content: buildUserMessage(conv) },
      ],
      // Match the manual "Run QA" button (app/api/conversation/route.ts) so
      // automated cron output is identical to on-demand analysis. gpt-5-mini
      // produced divergent verdicts (e.g. "Unresolved" / "Slow response times"
      // where gpt-4o gives "Resolved" / "Delayed Follow-Ups").
      temperature: 0.3,
    });

    // Retry once on 429 — gpt-4o tier-1 has a tight 30k TPM cap and bursts
    // can transiently exceed it even with sequential pacing. The retry-after
    // hint OpenAI returns ("try again in 21.186s") tells us exactly how long
    // to wait; we honor it within a 30s ceiling.
    let res: Response;
    let attempt = 0;
    while (true) {
      res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: requestBody,
      });
      if (res.status !== 429 || attempt >= 1) break;
      const retryBody = await res.text();
      const waitMs = parseRetryAfterMs(retryBody);
      console.warn(`[analyze-sync] 429 on ${conv.id}, retrying in ${waitMs}ms`);
      await sleep(waitMs);
      attempt++;
    }

    if (!res.ok) {
      const errorBody = await res.text();
      return {
        conversation_id: conv.id,
        intercom_id: conv.intercom_id,
        status: 'failed',
        error: `OpenAI ${res.status}: ${errorBody.slice(0, 300)}`,
        durationMs: Date.now() - startedAt,
      };
    }

    const data = await res.json();
    const analysisText: string | null = data.choices?.[0]?.message?.content ?? null;

    if (!analysisText) {
      return {
        conversation_id: conv.id,
        intercom_id: conv.intercom_id,
        status: 'failed',
        error: `Empty content (finish_reason=${data.choices?.[0]?.finish_reason ?? 'unknown'})`,
        durationMs: Date.now() - startedAt,
      };
    }

    const now = new Date().toISOString();
    await dbUpdateAnalysisFields(conv.id, {
      summary: analysisText,
      last_prompt_id: prompt.id,
      last_prompt_content: prompt.content,
      analyzed_at: now,
    });

    const run: AnalysisRun = {
      id: generateId(),
      conversation_id: conv.id,
      conversation_title: null,
      player_name: null,
      analyzed_at: now,
      prompt_id: prompt.id ?? null,
      prompt_title: null,
      prompt_content: prompt.content ?? '',
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

    // Severity-3 → push an action-item ticket into Asana. The helper is
    // wrapped to swallow any Asana-side failure (auth, rate limit, network)
    // so analysis itself never breaks.
    await maybeCreateAsanaTicketForConversation(conv.id, analysisText);

    return {
      conversation_id: conv.id,
      intercom_id: conv.intercom_id,
      status: 'analyzed',
      durationMs: Date.now() - startedAt,
    };
  } catch (e) {
    return {
      conversation_id: conv.id,
      intercom_id: conv.intercom_id,
      status: 'failed',
      error: (e as Error).message,
      durationMs: Date.now() - startedAt,
    };
  }
}

// Run a batch of conversations through analyzeConversationSync sequentially,
// pausing between calls to ride gpt-4o's 30k TPM cap. Each call uses ~10k
// tokens (fat system prompt + transcript + up to 4k completion); strict
// pacing would be 20s, but 8s keeps a single cron tick (16 chats × ~7s API
// + 15 × 8s sleep ≈ 232s) inside Vercel's 300s function ceiling. The 30k
// TPM cap is enforced softly by analyzeConversationSync's 429 retry, which
// honors OpenAI's retry-after hint.
//
// Used by the cron, the admin sync-analyze catch-up, and the admin reanalyze
// endpoint so all three share the same pacing logic. Always returns one
// SyncAnalysisResult per input conversation (analyzeConversationSync wraps
// its own errors, so this never rejects).
export async function analyzeBatchSequential(
  conversations: MinimalConversation[],
  prompt: { id: string; content: string },
  apiKey: string,
  opts?: { delayMs?: number },
): Promise<SyncAnalysisResult[]> {
  const delayMs = opts?.delayMs ?? 8_000;
  const results: SyncAnalysisResult[] = [];
  for (let i = 0; i < conversations.length; i++) {
    if (i > 0) await sleep(delayMs);
    results.push(await analyzeConversationSync(conversations[i], prompt, apiKey));
  }
  return results;
}
