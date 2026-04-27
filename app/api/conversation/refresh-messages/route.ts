import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { fetchIntercomData } from '@/lib/intercom';
import { supabase } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  const apiKey = process.env.INTERCOM_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'INTERCOM_API_KEY not configured' }, { status: 500 });

  let body: { intercomId?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const intercomId = body.intercomId;
  if (!intercomId) return NextResponse.json({ error: 'intercomId required' }, { status: 400 });

  try {
    const data = await fetchIntercomData(intercomId, apiKey);
    // Update raw_messages AND original_text together so the QA-bound transcript
    // never drifts from the per-message labels rendered in the UI.
    const { error } = await supabase
      .from('conversations')
      .update({ raw_messages: data.raw_messages, original_text: data.transcript })
      .eq('intercom_id', intercomId);
    if (error) throw new Error(error.message);
    return NextResponse.json({ raw_messages: data.raw_messages });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
