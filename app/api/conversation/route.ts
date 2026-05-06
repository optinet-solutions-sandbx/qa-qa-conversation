import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { fetchIntercomData, rateLimitResetMsg } from '@/lib/intercom';

async function callOpenAI(
  systemPrompt: string,
  userMessage: string,
  openAIKey: string
): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAIKey}` },
    body: JSON.stringify({
      model: 'gpt-5.4-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_completion_tokens: 4096,
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'OpenAI API error');
  const content = data.choices[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned an empty response.');
  return content as string;
}

// ── GET: fetch conversation data (no AI) ──────────────────────────────────

export async function GET(req: NextRequest) {
  const apiKey = process.env.INTERCOM_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'Server misconfiguration: INTERCOM_API_KEY not found.' }, { status: 500 });
  }
  const id = req.nextUrl.searchParams.get('id');
  if (!id?.trim()) {
    return NextResponse.json({ error: 'id query param is required.' }, { status: 400 });
  }
  try {
    const data = await fetchIntercomData(id.trim(), apiKey);
    return NextResponse.json(data);
  } catch (error) {
    console.error('Fetch Error:', error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

// ── POST: fetch + AI analysis ─────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const openAIKey = process.env.OPENAI_API_KEY;
  const apiKey = process.env.INTERCOM_API_KEY;
  if (!openAIKey) return NextResponse.json({ error: 'OPENAI_API_KEY not found' }, { status: 500 });
  if (!apiKey) return NextResponse.json({ error: 'INTERCOM_API_KEY not found' }, { status: 500 });

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const { customSystemPrompt, intercomId } = body as { customSystemPrompt?: string; intercomId?: string };
  if (!customSystemPrompt?.trim()) return NextResponse.json({ error: 'No prompt configured.' }, { status: 400 });
  if (!intercomId?.trim()) return NextResponse.json({ error: 'intercomId is required.' }, { status: 400 });

  try {
    const intercomData = await fetchIntercomData(intercomId.trim(), apiKey);
    const userMessage = [
      `Conversation ID: ${intercomData.intercom_id}`,
      `Player: ${intercomData.player_name ?? 'Unknown'} (${intercomData.player_email ?? 'no email'})`,
      `Agent: ${intercomData.agent_name ?? 'Unknown'}`,
      `Brand: ${intercomData.brand ?? 'Unknown'}`,
      '',
      'Transcript:',
      intercomData.transcript,
    ].join('\n');
    const analysis = await callOpenAI(customSystemPrompt, userMessage, openAIKey);
    return NextResponse.json({ analysisText: analysis, ...intercomData });
  } catch (error) {
    console.error('Analysis Error:', error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
