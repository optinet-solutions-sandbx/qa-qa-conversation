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

// ── Account Manager group mapping ────────────────────────────────────────────
// Maps each normalized Intercom group to its AM display name.
// VIP and NON-VIP groups for the same base can resolve to different AMs.
export const GROUP_TO_AM: Record<string, string> = {
  'vip_ada':           'Nik',
  'non-vip_ada':       'Nik',
  'vip_christian':     'Christian',
  'non-vip_christian': 'Niklas',
  'vip_salvatore':     'Salvatore',
  'non-vip_salvatore': 'Stefano',
  'vip_esam':          'Esam',
  'non-vip_esam':      'Yassine',
  'vip_koko':          'Koko',
  'non-vip_koko':      'Geri/Nik',
  'softswiss':         'SoftSwiss',
};

export const AM_NAMES = ['Nik', 'Christian', 'Niklas', 'Salvatore', 'Stefano', 'Esam', 'Yassine', 'Koko', 'Geri/Nik', 'SoftSwiss'] as const;
export type AmName = typeof AM_NAMES[number];

// Strips "group: " prefix, emoji / non-ASCII chars (e.g. 🎲), whitespace, and lowercases.
// Handles Intercom tag formats: "group: VIP_Ada", "group: vip_ada🎲", "group: softswiss dach", etc.
export function normalizeGroupName(g: string): string {
  return g
    .replace(/^group:\s*/i, '')
    .replace(/[^\x00-\x7F]/g, '')
    .trim()
    .toLowerCase();
}

export function getAmGroupsForFilter(am: string): string[] {
  return Object.entries(GROUP_TO_AM)
    .filter(([, displayName]) => displayName === am)
    .map(([group]) => group);
}

export function getSegment(conv: Conversation): 'VIP' | 'NON-VIP' | 'SoftSwiss' | null {
  // SoftSwiss group membership takes priority over any custom attribute
  const companyNames = (conv.player_companies ?? []).map((c) => c.name);
  const allGroups = [
    ...(conv.player_tags ?? []),
    ...(conv.player_segments ?? []),
    ...(conv.tags ?? []),
    ...companyNames,
  ];
  if (allGroups.some((g) => { const n = normalizeGroupName(g); return n === 'softswiss' || n.startsWith('softswiss '); })) return 'SoftSwiss';
  // Then check custom attributes and explicit segment values
  const seg = getCustomAttr(conv.player_custom_attributes, 'Segment', 'segment', 'vip_segment', 'VIP Segment', 'Player Segment');
  if (seg) {
    const s = seg.toUpperCase().replace(/[\s-]/g, '');
    if (s === 'VIP') return 'VIP';
    if (s === 'NONVIP') return 'NON-VIP';
  }
  const segs = conv.player_segments ?? [];
  if (segs.some((s) => /^vip$/i.test(s.trim()))) return 'VIP';
  if (segs.some((s) => /non.?vip/i.test(s))) return 'NON-VIP';
  if (allGroups.some((g) => /^vip_/.test(normalizeGroupName(g)))) return 'VIP';
  if (allGroups.some((g) => /^non-vip_/.test(normalizeGroupName(g)))) return 'NON-VIP';
  return null;
}

export function getVipLevel(conv: Conversation): string | null {
  return getCustomAttr(
    conv.player_custom_attributes,
    'VIP Level', 'vip_level', 'VIPLevel', 'Player Level', 'player_level', 'Level',
  );
}

export function getAccountManager(conv: Conversation): string | null {
  // Prefer the stored column (populated at collection time for all sources)
  // Derive from group membership first — works for both new and legacy rows
  const companyNames = (conv.player_companies ?? []).map((c) => c.name);
  const allGroups = [
    ...(conv.player_tags ?? []),
    ...(conv.player_segments ?? []),
    ...(conv.tags ?? []),
    ...companyNames,
  ];
  const normalizedGroups = allGroups.map(normalizeGroupName);
  if (normalizedGroups.some((n) => n === 'softswiss' || n.startsWith('softswiss '))) return GROUP_TO_AM['softswiss'];
  for (const [group, am] of Object.entries(GROUP_TO_AM)) {
    if (group === 'softswiss') continue;
    if (normalizedGroups.includes(group)) return am;
  }
  // Fall back to stored value (custom attribute or pre-migration cached name)
  const fromAttrs = getCustomAttr(
    conv.player_custom_attributes,
    'Account Manager', 'account_manager', 'AccountManager', 'AM', 'Account Mgr',
  );
  if (fromAttrs) return fromAttrs;
  return conv.account_manager ?? null;
}

export function getBacklinkFull(conv: Conversation): string | null {
  return getCustomAttr(
    conv.player_custom_attributes,
    'backlinkfull', 'backlink_full', 'backlinkFull', 'BacklinkFull', 'backlink',
  );
}

// ── AI summary helpers ───────────────────────────────────────────────────────

function stripSummaryFences(text: string): string {
  return text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
}

export function parseSummaryForTable(raw: string | null): { category: string | null; issue: string | null; summary: string | null } {
  if (!raw) return { category: null, issue: null, summary: null };
  try {
    const json = JSON.parse(stripSummaryFences(raw));
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { category: null, issue: null, summary: null };

    // Category: prefer results[0].category, fall back to top-level keys
    const results: { category?: string; item?: string }[] = Array.isArray(json.results) ? json.results : [];
    const first = results[0];
    const rawCat =
      first?.category ??
      (typeof json.category === 'string' ? json.category : null) ??
      (typeof json.issue_category === 'string' ? json.issue_category : null) ??
      null;
    const category = rawCat ? rawCat.replace(/^category\s+(\d+)[:\s]+/i, '$1. ').trim() : null;

    // Issue: prefer results[0].item, fall back to top-level issue keys
    const issue =
      first?.item ??
      (typeof json.issue === 'string' ? json.issue : null) ??
      (typeof json.item === 'string' ? json.item : null) ??
      (typeof json.issue_item === 'string' ? json.issue_item : null) ??
      null;

    // Summary: json.summary is the canonical key; also try common alternatives
    const summary =
      (typeof json.summary === 'string' ? json.summary.trim() || null : null) ??
      (typeof json.analysis_summary === 'string' ? json.analysis_summary.trim() || null : null) ??
      (typeof json.overall_summary === 'string' ? json.overall_summary.trim() || null : null) ??
      null;

    return { category, issue, summary };
  } catch { return { category: null, issue: null, summary: null }; }
}
