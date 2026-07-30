// Per-player escalation opt-outs.
//
// lib/escalationRules.ts decides escalation from the *conversation* (issue x
// severity x resolution x segment). This list overrides that from the *player*
// side: some accounts produce a steady stream of matrix-valid but
// operationally uninteresting tickets — e.g. a VIP whose every verification
// question lands on Pattern F, which escalates VIP even at severity 0 — and
// the AM has asked for them to stop reaching the board. Excluded players are
// still collected and analysed as usual; only the Asana push is suppressed.
//
// Matching uses identifiers we already carry on every conversation:
//   • player email        — exact, case-insensitive.
//   • BACKEND player link — normalised to "<host>/players/<id>", so the same
//                           numeric id under a different brand doesn't collide
//                           and a link can be pasted in verbatim from Asana.
//                           Use the player's CURRENT backoffice domain (the
//                           Nova Dreams host rewrite in lib/utils.ts has
//                           already been applied by the time we compare).
//
// More players can be excluded without a deploy via ESCALATION_EXCLUDED_PLAYERS:
// a comma- or newline-separated list of emails and/or BACKEND URLs, merged with
// the entries below.

const EXCLUDED_PLAYERS: readonly string[] = [
  // Mitchell Bowden — lucky7even / Rooster Partners, L7. Requested by Jose
  // 2026-07-30: this player should never be escalated to Asana.
  'aceturtlelord@gmail.com',
  'https://lucky7even.casino-backend.com/backend/players/292915',
];

export interface EscalationPlayerRef {
  playerEmail: string | null;
  backlinkFull: string | null;
}

// "https://host/backend/players/292915?tab=x" -> "host/players/292915".
// Accepts scheme-less entries so "lucky7even.casino-backend.com/players/292915"
// works too. Returns null for anything without a numeric player id.
function normalizeBackendLink(raw: string): string | null {
  const m = raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .match(/^([^/\s]+)\/.*?players\/(\d+)/i);
  if (!m) return null;
  return `${m[1].toLowerCase()}/players/${m[2]}`;
}

function normalizeEmail(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  return t.includes('@') ? t : null;
}

// Parsed form of EXCLUDED_PLAYERS + the env var, rebuilt only when the env
// value changes (module state survives across warm serverless invocations).
let cache: { envRaw: string; emails: Set<string>; links: Set<string> } | null = null;

function getExclusions(): { emails: Set<string>; links: Set<string> } {
  const envRaw = process.env.ESCALATION_EXCLUDED_PLAYERS ?? '';
  if (cache && cache.envRaw === envRaw) return cache;

  const emails = new Set<string>();
  const links = new Set<string>();
  const entries = [...EXCLUDED_PLAYERS, ...envRaw.split(/[,\n]/)];
  for (const entry of entries) {
    const raw = entry.trim();
    if (!raw) continue;
    const email = normalizeEmail(raw);
    if (email) {
      emails.add(email);
      continue;
    }
    const link = normalizeBackendLink(raw);
    if (link) {
      links.add(link);
      continue;
    }
    console.warn(`[escalation] ignoring unrecognised excluded-player entry: ${raw}`);
  }

  cache = { envRaw, emails, links };
  return cache;
}

// Returns the identifier that matched (for logging), or null when the player
// is not excluded and the normal escalation matrix should decide.
export function matchEscalationExclusion(ref: EscalationPlayerRef): string | null {
  const { emails, links } = getExclusions();

  const email = ref.playerEmail ? normalizeEmail(ref.playerEmail) : null;
  if (email && emails.has(email)) return email;

  const link = ref.backlinkFull ? normalizeBackendLink(ref.backlinkFull) : null;
  if (link && links.has(link)) return link;

  return null;
}
