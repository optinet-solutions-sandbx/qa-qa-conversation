import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  getUnanalyzedConversationsPage,
  dbGetActivePrompt,
  dbUpdateAnalysisFields,
  dbInsertAnalysisRun,
} from '@/lib/db';
import { generateId } from '@/lib/utils';
import { ANALYSIS_MIN_DATE_ISO } from '@/lib/analyticsFilters';
import type { AnalysisRun } from '@/lib/types';

// Fallback to synchronous /v1/chat/completions when OpenAI's Batch API is
// stalled. Each request is real-time (~15-45s on gpt-5-mini reasoning) so we
// process a small handful per call and rely on the caller to keep curling
// until the backlog clears. ~2× the cost of Batch but no async wait.
//
// POST /api/admin/sync-analyze?limit=N
//   - Authenticates with CRON_SECRET (same as the cron endpoints)
//   - Pulls N (default 5, max 10) oldest unanalyzed April-27+ conversations
//   - Runs them through gpt-5-mini synchronously, in parallel
//   - Writes summaries + analysis_runs to the DB inline
export const maxDuration = 300;

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

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

interface SyncResult {
  conversation_id: string;
  intercom_id: string | null;
  status: 'analyzed' | 'failed';
  error?: string;
  durationMs?: number;
}

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization') ?? '';
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 });

  const limitParam = parseInt(req.nextUrl.searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10);
  const limit = Math.min(Math.max(1, isNaN(limitParam) ? DEFAULT_LIMIT : limitParam), MAX_LIMIT);

  const prompt = await dbGetActivePrompt();
  if (!prompt) {
    return NextResponse.json({ error: 'No active prompt found' }, { status: 500 });
  }

  const conversations = await getUnanalyzedConversationsPage(0, limit, {
    fromDate: ANALYSIS_MIN_DATE_ISO,
  });

  if (conversations.length === 0) {
    return NextResponse.json({ message: 'No unanalyzed April-27+ conversations remain.', analyzed: 0, failed: 0 });
  }

  // Run all in parallel — gpt-5-mini RPM on tier 1 easily handles 10 concurrent
  // requests, and parallelism is what makes this approach fast vs Batch's queue.
  const settled = await Promise.allSettled(
    conversations.map(async (conv): Promise<SyncResult> => {
      const startedAt = Date.now();
      try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: 'gpt-5-mini',
            messages: [
              { role: 'system', content: prompt.content },
              { role: 'user', content: buildUserMessage(conv) },
            ],
            // Same as the Batch path. gpt-5-mini reasoning needs headroom or
            // it returns empty content with finish_reason=length.
            max_completion_tokens: 4096,
          }),
        });

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
    }),
  );

  const results: SyncResult[] = settled.map((s) =>
    s.status === 'fulfilled'
      ? s.value
      : {
          conversation_id: 'unknown',
          intercom_id: null,
          status: 'failed' as const,
          error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        },
  );

  const analyzed = results.filter((r) => r.status === 'analyzed').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  return NextResponse.json({
    requested: conversations.length,
    analyzed,
    failed,
    results,
  });
}
