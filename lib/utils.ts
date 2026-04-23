export function fmtTime(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const day = d.getDate();
    const month = d.toLocaleString('en-GB', { month: 'short' });
    const hours = String(d.getHours()).padStart(2, '0');
    const mins = String(d.getMinutes()).padStart(2, '0');
    return `${day} ${month}, ${hours}:${mins}`;
  } catch {
    return iso;
  }
}

export function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function fmtSeconds(s: number | null | undefined): string {
  if (s == null) return '—';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function truncate(text: string, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

// ── Player attribute helpers (used in list + dashboard overlay) ──────────────

import type { Conversation } from '@/lib/types';

function getCustomAttr(attrs: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!attrs) return null;
  for (const key of keys) {
    const lk = key.toLowerCase();
    for (const [k, v] of Object.entries(attrs)) {
      if (k.toLowerCase() === lk && v != null && v !== '') return String(v);
    }
  }
  return null;
}

export function getSegment(conv: Conversation): 'VIP' | 'NONVIP' | null {
  const seg = getCustomAttr(conv.player_custom_attributes, 'Segment', 'segment', 'vip_segment', 'VIP Segment', 'Player Segment');
  if (seg) {
    const s = seg.toUpperCase().replace(/[\s-]/g, '');
    if (s === 'VIP') return 'VIP';
    if (s === 'NONVIP') return 'NONVIP';
  }
  const segs = conv.player_segments ?? [];
  if (segs.some((s) => /^vip$/i.test(s.trim()))) return 'VIP';
  if (segs.some((s) => /non.?vip/i.test(s))) return 'NONVIP';
  return null;
}

export function getVipLevel(conv: Conversation): string | null {
  return getCustomAttr(
    conv.player_custom_attributes,
    'VIP Level', 'vip_level', 'VIPLevel', 'Player Level', 'player_level', 'Level',
  );
}

export function getAccountManager(conv: Conversation): string | null {
  return getCustomAttr(
    conv.player_custom_attributes,
    'Account Manager', 'account_manager', 'AccountManager', 'AM', 'Account Mgr',
  );
}

export function getBacklinkFull(conv: Conversation): string | null {
  return getCustomAttr(
    conv.player_custom_attributes,
    'backlinkfull', 'backlink_full', 'backlinkFull', 'BacklinkFull', 'backlink',
  );
}
