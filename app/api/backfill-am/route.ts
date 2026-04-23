import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { AM_GROUP_MAP, normalizeGroupName } from '@/lib/utils';

// Allow up to 5 minutes for large datasets
export const maxDuration = 300;

function deriveAm(playerTags: string[], playerSegments: string[], tags: string[], companyNames: string[]): string | null {
  const allGroups = [...playerTags, ...playerSegments, ...tags, ...companyNames];
  const normalizedGroups = allGroups.map(normalizeGroupName);
  for (const [am, groups] of Object.entries(AM_GROUP_MAP)) {
    if (am === 'SoftSwiss') {
      if (normalizedGroups.some((n) => n === 'softswiss' || n.startsWith('softswiss '))) return am;
    } else if (groups.some((g) => normalizedGroups.includes(g))) {
      return am;
    }
  }
  return null;
}

export async function POST() {
  let updated = 0;
  let skipped = 0;
  let page = 0;
  const pageSize = 500;

  while (true) {
    const { data, error } = await supabase
      .from('conversations')
      .select('id, player_tags, player_segments, tags, player_companies')
      .is('account_manager', null)
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;

    for (const row of data) {
      const companyNames = (row.player_companies ?? []).map((c: { name?: string }) => c.name ?? '');
      const am = deriveAm(
        row.player_tags ?? [],
        row.player_segments ?? [],
        row.tags ?? [],
        companyNames,
      );

      if (am) {
        const { error: updateError } = await supabase
          .from('conversations')
          .update({ account_manager: am })
          .eq('id', row.id);
        if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });
        updated++;
      } else {
        skipped++;
      }
    }

    if (data.length < pageSize) break;
    page++;
  }

  return NextResponse.json({ updated, skipped });
}
