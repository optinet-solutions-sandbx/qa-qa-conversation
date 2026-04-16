import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { generateId } from '@/lib/utils';
import type { AnalysisRun } from '@/lib/types';

// Allow up to 5 minutes — may process thousands of rows
export const maxDuration = 300;

// POST /api/backfill-analysis-runs
//
// One-time backfill: creates an analysis_run record for every conversation
// that has a summary but no existing analysis_run entry.
// Safe to call multiple times — skips conversation_ids already present.
//
// Strategy: fetch only lightweight metadata (no summary text) to avoid
// statement timeouts caused by fetching thousands of large text fields.
// summary is left null in the backfilled rows — the actual text remains
// in conversations.summary and is unaffected.

export async function POST() {
  try {
    let inserted = 0;
    let skipped = 0;
    let page = 0;
    const pageSize = 200; // small pages to stay within Supabase statement timeout

    while (true) {
      // Fetch lightweight metadata only — no summary/original_text columns
      const { data: convs, error } = await supabase
        .from('conversations')
        .select('id, title, player_name, analyzed_at, last_prompt_id, last_prompt_content')
        .not('summary', 'is', null)
        .not('analyzed_at', 'is', null)
        .order('id')
        .range(page * pageSize, (page + 1) * pageSize - 1);

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (!convs || convs.length === 0) break;

      // Check which of these conversation IDs already have an analysis_run
      const convIds = convs.map((c: { id: string }) => c.id);
      const { data: existing, error: existingError } = await supabase
        .from('analysis_runs')
        .select('conversation_id')
        .in('conversation_id', convIds);

      if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });

      const existingSet = new Set((existing ?? []).map((r: { conversation_id: string }) => r.conversation_id));

      const toInsert: AnalysisRun[] = convs
        .filter((c: { id: string }) => !existingSet.has(c.id))
        .map((c: {
          id: string;
          title: string | null;
          player_name: string | null;
          analyzed_at: string;
          last_prompt_id: string | null;
          last_prompt_content: string | null;
        }) => ({
          id: generateId(),
          conversation_id: c.id,
          conversation_title: c.title ?? null,
          player_name: c.player_name ?? null,
          analyzed_at: c.analyzed_at,
          prompt_id: c.last_prompt_id ?? null,
          prompt_title: null,
          prompt_content: c.last_prompt_content ?? '',
          summary: null, // not fetched to avoid timeout; text is in conversations.summary
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
        }));

      skipped += convs.length - toInsert.length;

      if (toInsert.length > 0) {
        const { error: insertError } = await supabase.from('analysis_runs').insert(toInsert);
        if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });
        inserted += toInsert.length;
      }

      if (convs.length < pageSize) break;
      page++;
    }

    return NextResponse.json({ inserted, skipped });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
