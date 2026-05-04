import { supabase } from '@/lib/supabase';
import { getAccountManager } from '@/lib/utils';
import type { Conversation } from '@/lib/types';

// Builds and posts the "Pending Action Cases Snapshot" the cron sends to
// Telegram. "Pending" matches the dashboard's escalationStats card: an Asana
// ticket exists, isn't deleted in Asana, and isn't completed yet.
//
// Age uses intercom_created_at rather than analyzed_at on purpose: analyzed_at
// gets re-stamped whenever a row is re-analyzed (e.g. the gpt-4o re-analysis
// sweeps), which would otherwise reset open tickets to "<24h" the moment a
// re-analysis completes. intercom_created_at is stable, and slightly
// overstates ticket age (since the ticket is created at analysis time, not at
// conversation creation), which is the safer bias for an AM-facing SLA view.

const DAY_MS = 24 * 60 * 60 * 1000;

export type AmCounts = { under24: number; over24: number };

export type Snapshot = {
  total: number;
  byAm: Map<string, AmCounts>;
  message: string;
};

export async function buildPendingSnapshot(now: Date = new Date()): Promise<Snapshot> {
  const PAGE_SIZE = 1000;
  const rows: Array<Record<string, unknown>> = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('conversations')
      .select(
        'id, account_manager, intercom_created_at, player_tags, player_segments, tags, player_companies, player_custom_attributes',
      )
      .not('asana_task_gid', 'is', null)
      .is('asana_task_deleted_at', null)
      .is('asana_completed_at', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`[telegram-snapshot] ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  const nowMs = now.getTime();
  const byAm = new Map<string, AmCounts>();
  for (const r of rows) {
    const am = getAccountManager(r as unknown as Conversation) ?? 'Unassigned';
    const created = r.intercom_created_at as string | null;
    const ageMs = created ? nowMs - new Date(created).getTime() : Infinity;
    const bucket = byAm.get(am) ?? { under24: 0, over24: 0 };
    if (ageMs < DAY_MS) bucket.under24 += 1;
    else                bucket.over24  += 1;
    byAm.set(am, bucket);
  }

  return { total: rows.length, byAm, message: formatSnapshot(byAm, rows.length, now) };
}

function formatSnapshot(byAm: Map<string, AmCounts>, total: number, now: Date): string {
  const hh = now.getUTCHours().toString().padStart(2, '0');
  const mm = now.getUTCMinutes().toString().padStart(2, '0');
  const TOP = '▔'.repeat(20);
  const BOT = '▁'.repeat(20);

  const lines: string[] = [];
  lines.push(`📊 Pending Action Cases Snapshot | 🕒 ${hh}:${mm}`);
  lines.push(TOP);
  lines.push(`Total Pending: ${total}`);
  lines.push(BOT);
  lines.push('');

  const sorted = [...byAm.entries()].sort((a, b) => {
    const ta = a[1].under24 + a[1].over24;
    const tb = b[1].under24 + b[1].over24;
    if (ta !== tb) return tb - ta;
    return a[0].localeCompare(b[0]);
  });

  if (sorted.length === 0) {
    lines.push('No pending cases — nothing on the board right now.');
  } else {
    for (const [am, c] of sorted) {
      const subTotal = c.under24 + c.over24;
      const totalStr = String(subTotal);
      // Visual padding: dashes fill the gap so the count sits at a roughly
      // consistent column. Telegram renders in a proportional font so this
      // won't be pixel-aligned, but it keeps the rows tidy.
      const dashes = '—'.repeat(Math.max(3, 18 - am.length - totalStr.length));
      lines.push(`👤 ${am} ${dashes} ${subTotal}`);
      lines.push(`   🟢 ${c.under24} pending <24h  |  🔴 ${c.over24} pending >24h`);
      lines.push('');
    }
  }

  lines.push(BOT);
  return lines.join('\n');
}

export async function sendTelegramMessage(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram sendMessage ${res.status}: ${body}`);
  }
}
