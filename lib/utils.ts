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

// ── VIP Level group mapping ──────────────────────────────────────────────────
// Intercom level groups follow the pattern "L<N>: <description>", e.g.
//   "group: L0: RND Players"
//   "group: L1: €1–2K LT, 0 (30d)"
//   "group: L7: €2K–4.9K (30d)"
//   "group: L10: 30K LT (≥€500 in 45d)"
// After normalizeGroupName these become "l0: rnd players", "l1: 12k lt, 0 (30d)",
// "l7: 2k4.9k (30d)", "l10: 30k lt (500 in 45d)" respectively.  Detecting the
// "l<N>:" prefix is what catches every level uniformly without us having to
// keep an exact-suffix map in sync with Intercom wording changes.
const LEVEL_PREFIX_RE = /^l(\d+)\s*:/;

export function levelFromGroup(normalized: string): number | null {
  const m = normalized.match(LEVEL_PREFIX_RE);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 0 && n <= 10 ? n : null;
}

export const VIP_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10'] as const;
export type VipLevel = typeof VIP_LEVELS[number];

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

// Structural shape used by both getSegment and getVipLevelNum so callers can
// pass slim row objects (dashboard analytics, drill-down filter) without
// having to construct a full Conversation.
export type PlayerAttrsInput = Pick<Conversation, 'player_tags' | 'player_segments' | 'tags' | 'player_custom_attributes'> & {
  player_companies?: { name: string }[] | null;
};

export const SEGMENTS = ['VIP', 'NON-VIP', 'SoftSwiss'] as const;
export type Segment = typeof SEGMENTS[number];

export function getSegment(conv: PlayerAttrsInput): Segment | null {
  const companyNames = (conv.player_companies ?? []).map((c) => c.name);
  const allGroups = [
    ...(conv.player_tags ?? []),
    ...(conv.player_segments ?? []),
    ...(conv.tags ?? []),
    ...companyNames,
  ];
  const normalizedGroups = allGroups.map(normalizeGroupName);
  // An explicit VIP_<am> / NON-VIP_<am> AM assignment beats SoftSwiss platform
  // group membership: a player on a SoftSwiss-platform brand can still be
  // personally managed by an AM (e.g. RocketSpin player tagged vip_koko).
  if (normalizedGroups.some((g) => /^vip_/.test(g))) return 'VIP';
  if (normalizedGroups.some((g) => /^non-vip_/.test(g))) return 'NON-VIP';
  if (normalizedGroups.some((n) => n === 'softswiss' || n.startsWith('softswiss '))) return 'SoftSwiss';
  const seg = getCustomAttr(conv.player_custom_attributes, 'Segment', 'segment', 'vip_segment', 'VIP Segment', 'Player Segment');
  if (seg) {
    const s = seg.toUpperCase().replace(/[\s-]/g, '');
    if (s === 'VIP') return 'VIP';
    if (s === 'NONVIP') return 'NON-VIP';
  }
  const segs = conv.player_segments ?? [];
  if (segs.some((s) => /^vip$/i.test(s.trim()))) return 'VIP';
  if (segs.some((s) => /non.?vip/i.test(s))) return 'NON-VIP';
  return null;
}

export function parseSegmentFilter(raw: string | null | undefined): Segment | null {
  if (!raw) return null;
  const s = String(raw).trim().toUpperCase().replace(/[\s-]/g, '');
  if (s === 'VIP') return 'VIP';
  if (s === 'NONVIP') return 'NON-VIP';
  if (s === 'SOFTSWISS') return 'SoftSwiss';
  return null;
}

// Inputs needed to derive a player's VIP level — structural so callers can pass
// slim row objects (dashboard analytics, drill-down filter) without having to
// construct a full Conversation.  player_companies only needs `.name` here, so
// this accepts both full PlayerCompany[] and the slim `{ name: string }[]`
// shape selected from the dashboard query.
type VipLevelInput = Pick<Conversation, 'player_tags' | 'player_segments' | 'tags' | 'player_custom_attributes'> & {
  player_companies?: { name: string }[] | null;
};

// Returns the player's VIP level as an integer 0-10, or null if no level group
// matches.  When the player belongs to multiple level groups, the highest wins
// (e.g. a player tagged both L4 and L6 is treated as L6).  Custom-attribute
// fallback covers legacy rows where an explicit "VIP Level" attribute is set.
export function getVipLevelNum(conv: VipLevelInput): number | null {
  const companyNames = (conv.player_companies ?? []).map((c) => c.name);
  const allGroups = [
    ...(conv.player_tags ?? []),
    ...(conv.player_segments ?? []),
    ...(conv.tags ?? []),
    ...companyNames,
  ];
  let best: number | null = null;
  for (const g of allGroups) {
    const lvl = levelFromGroup(normalizeGroupName(g));
    if (lvl == null) continue;
    if (best == null || lvl > best) best = lvl;
  }
  if (best != null) return best;
  // Fallback: explicit custom attribute like "L7" or "Level 7" or "7"
  const raw = getCustomAttr(
    conv.player_custom_attributes,
    'VIP Level', 'vip_level', 'VIPLevel', 'Player Level', 'player_level', 'Level',
  );
  if (!raw) return null;
  const m = raw.match(/(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 0 && n <= 10 ? n : null;
}

export function getVipLevel(conv: VipLevelInput): string | null {
  const n = getVipLevelNum(conv);
  return n == null ? null : `L${n}`;
}

// Parses a filter value like "L7" or "7" or "Level 7" to its numeric form.
// Returns null for values that aren't 0-10.
export function parseVipLevelFilter(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = String(raw).match(/(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 0 && n <= 10 ? n : null;
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
  // An explicit VIP_<am> / NON-VIP_<am> AM assignment beats SoftSwiss platform
  // group membership: a player on a SoftSwiss-platform brand can still be
  // personally managed by an AM (e.g. RocketSpin player tagged vip_koko).
  for (const [group, am] of Object.entries(GROUP_TO_AM)) {
    if (group === 'softswiss') continue;
    if (normalizedGroups.includes(group)) return am;
  }
  if (normalizedGroups.some((n) => n === 'softswiss' || n.startsWith('softswiss '))) return GROUP_TO_AM['softswiss'];
  // Fall back to stored value (custom attribute or pre-migration cached name)
  const fromAttrs = getCustomAttr(
    conv.player_custom_attributes,
    'Account Manager', 'account_manager', 'AccountManager', 'AM', 'Account Mgr',
  );
  if (fromAttrs) return fromAttrs;
  return conv.account_manager ?? null;
}

// Intercom auto-appends a casino slug to contact names (e.g. "Jan Steffens _spinjo",
// "Matthias Lipp rooster"). Strip that artefact so only first + last name remain.
const CASINO_SLUG_RE = /^(rocketspin|roosterbet|rooster|playmojo|lucky7even|lucky7|luckyvibe|lucky-vibe|spinjo|spinsup|fortuneplay|fortune-play|rollero)$/i;

export function cleanPlayerName(name: string | null): string | null {
  if (!name) return null;
  let s = name.trim();
  s = s.replace(/\s+_[A-Za-z0-9-]+$/, '').trim();
  const parts = s.split(/\s+/);
  if (parts.length > 1 && CASINO_SLUG_RE.test(parts[parts.length - 1])) {
    parts.pop();
    s = parts.join(' ');
  }
  return s.trim() || null;
}

export function getBacklinkFull(conv: Pick<Conversation, 'player_custom_attributes'>): string | null {
  return getCustomAttr(
    conv.player_custom_attributes,
    'backlinkfull', 'backlink_full', 'backlinkFull', 'BacklinkFull', 'backlink',
  );
}

// ── AI summary helpers ───────────────────────────────────────────────────────

function stripSummaryFences(text: string): string {
  return text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
}

// Optional `prefer` lets callers (e.g. the dashboard drill-down overlay)
// surface the result entry that matches the active issue/category filter
// instead of always showing results[0]. Without this, a conversation whose
// secondary issue matched the filter would render its primary issue label
// in the table, leaving users staring at rows that look unrelated to the
// filter they applied.
export function parseSummaryForTable(
  raw: string | null,
  prefer?: { issue?: string | null; category?: string | null },
): { category: string | null; issue: string | null; summary: string | null } {
  if (!raw) return { category: null, issue: null, summary: null };
  try {
    const json = JSON.parse(stripSummaryFences(raw));
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { category: null, issue: null, summary: null };

    const results: { category?: string; item?: string }[] = Array.isArray(json.results) ? json.results : [];

    const norm = (s: string | null | undefined) =>
      s == null ? '' : String(s).replace(/^\d+\.\s*/, '').trim().toLowerCase().replace(/s$/, '');
    const normCat = (s: string | null | undefined) =>
      s == null ? '' : String(s).replace(/^category\s+(\d+)[:\s]+/i, '$1. ').trim().toLowerCase();

    const wantIssue = prefer?.issue ? norm(prefer.issue) : '';
    const wantCat   = prefer?.category ? normCat(prefer.category) : '';
    const matched = (wantIssue || wantCat)
      ? results.find((r) =>
          (!wantIssue || norm(r.item) === wantIssue) &&
          (!wantCat   || normCat(r.category) === wantCat),
        )
      : undefined;
    const picked = matched ?? results[0];

    const rawCat =
      picked?.category ??
      (typeof json.category === 'string' ? json.category : null) ??
      (typeof json.issue_category === 'string' ? json.issue_category : null) ??
      null;
    const category = rawCat ? rawCat.replace(/^category\s+(\d+)[:\s]+/i, '$1. ').trim() : null;

    // Strip leading "N. " so variants like "1. Account Closure Requests"
    // and "Account Closure Requests" render identically in the UI.
    const rawIssue =
      picked?.item ??
      (typeof json.issue === 'string' ? json.issue : null) ??
      (typeof json.item === 'string' ? json.item : null) ??
      (typeof json.issue_item === 'string' ? json.issue_item : null) ??
      null;
    const issue = rawIssue ? rawIssue.replace(/^\d+\.\s*/, '').trim() || null : null;

    // Summary: json.summary is the canonical key; also try common alternatives
    const summary =
      (typeof json.summary === 'string' ? json.summary.trim() || null : null) ??
      (typeof json.analysis_summary === 'string' ? json.analysis_summary.trim() || null : null) ??
      (typeof json.overall_summary === 'string' ? json.overall_summary.trim() || null : null) ??
      null;

    return { category, issue, summary };
  } catch { return { category: null, issue: null, summary: null }; }
}

// Pulls the AI's `key_quotes` array out of the raw summary JSON. Returns an
// empty list when the field is missing or not a string array — callers can
// just skip rendering rather than special-casing each shape.
export function parseKeyQuotesFromSummary(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const json = JSON.parse(stripSummaryFences(raw));
    if (!json || typeof json !== 'object' || Array.isArray(json)) return [];
    const arr = (json as Record<string, unknown>).key_quotes;
    if (!Array.isArray(arr)) return [];
    const out: string[] = [];
    for (const q of arr) {
      if (typeof q !== 'string') continue;
      const t = q.trim();
      if (t) out.push(t);
    }
    return out;
  } catch { return []; }
}
