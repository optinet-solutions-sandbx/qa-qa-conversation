import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { toolSchemas, executeTool, type ToolCallResult } from '@/lib/ai-tools';
import { dbInsertAiQuery } from '@/lib/db';

export const maxDuration = 60;

const MODEL = 'gpt-4o-mini';
const MAX_TOOL_ITERATIONS = 4;

function systemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You are an analytics assistant for a customer-support QA platform. The data is about customer-support conversations that have been analyzed for issues, sentiment, resolution status, and agent performance.

Today's date is ${today}.

RULES — read carefully:

1. **Only answer questions about this support-data domain**: issue categories, customer concerns, sentiment, resolution, agent performance, alerts, brands, conversation counts, query types, etc.

2. If the question is **off-topic** (general knowledge, coding, personal questions, weather, etc.) or **cannot be answered from the tools**, respond with exactly:
   "This question isn't about our support conversation data. Please ask about customer concerns, agent performance, issue categories, resolution rates, or similar analytics."

3. **Always use the tools** to ground your answers in real data. Never fabricate numbers. If the user doesn't specify a date range, assume "last 30 days" (from today back 30 days).

4. When the user asks a vague question ("top concerns", "best agent"), pick a sensible tool and reasonable defaults (e.g. limit=10).

5. **Be concise and human**. Present tool results as clean prose or short bullet lists. Users are non-technical. No JSON, no tables with raw code blocks — just readable answers.

6. Convert agent scores and ratings to clear numbers (e.g. "avg rating 4.2/5 across 28 conversations").

7. Refer to entities by their human names (player names, agent names, issue categories) — don't show internal IDs unless specifically asked.`;
}

// ── POST: ask a question ──────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const openAIKey = process.env.OPENAI_API_KEY;
  if (!openAIKey) return NextResponse.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 });

  let body: { question: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const question = (body.question ?? '').trim();
  if (!question) return NextResponse.json({ error: 'question is required' }, { status: 400 });
  if (question.length > 500) return NextResponse.json({ error: 'Question too long (max 500 chars)' }, { status: 400 });

  // Message history for the tool-calling loop
  const messages: unknown[] = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: question },
  ];

  const toolsUsed: ToolCallResult[] = [];
  let finalAnswer = '';

  try {
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAIKey}` },
        body: JSON.stringify({
          model: MODEL,
          messages,
          tools: toolSchemas,
          tool_choice: iter === MAX_TOOL_ITERATIONS - 1 ? 'none' : 'auto',
          temperature: 0.2,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message ?? 'OpenAI error');

      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error('Empty OpenAI response');
      messages.push(msg);

      const toolCalls = msg.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }> | undefined;

      if (!toolCalls || toolCalls.length === 0) {
        finalAnswer = (msg.content ?? '').trim();
        break;
      }

      // Execute each tool call and feed the results back
      for (const tc of toolCalls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); }
        catch { args = {}; }

        const result = await executeTool(tc.function.name, args);
        toolsUsed.push(result);

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result.error ? { error: result.error } : result.result),
        });
      }
    }

    if (!finalAnswer) finalAnswer = 'I was unable to form an answer from the available data.';

    const isIrrelevant = /isn't about our support conversation data/i.test(finalAnswer);

    // Save to DB
    let saved;
    try {
      saved = await dbInsertAiQuery({
        question,
        answer: finalAnswer,
        tools_used: toolsUsed,
        is_irrelevant: isIrrelevant,
      });
    } catch (e) {
      console.error('[ask-ai] save failed:', (e as Error).message);
    }

    return NextResponse.json({
      id: saved?.id ?? null,
      question,
      answer: finalAnswer,
      tools_used: toolsUsed,
      is_irrelevant: isIrrelevant,
      created_at: saved?.created_at ?? new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
