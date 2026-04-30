// Asana integration — pushes a ticket into the configured Asana project when
// the AI flags a conversation with dissatisfaction severity Level 3. Called
// from lib/analyze-sync.ts after a successful analysis. Failures are logged
// and swallowed so a flaky Asana API never breaks the analysis pipeline.
//
// Routing: each ticket lands in the project section (board column) whose name
// matches the conversation's account_manager. Matching is case-insensitive
// exact first, then first-word (so "Ada VIP" still matches a column named
// "Ada"). If no column matches, a new column named after the AM is auto-
// created and the ticket lands there. If creation itself fails (rate limit,
// perms), ASANA_SECTION_GID is used as a last-resort fallback; otherwise the
// ticket goes to the project default. The agent's name is still recorded in
// the task notes but does not get its own column.
//
// Required env:
//   ASANA_ACCESS_TOKEN           Service-account Personal Access Token
//   ASANA_PROJECT_GID            Destination project GID (e.g. 1214387668872283)
// Optional env:
//   ASANA_SECTION_GID            Fallback section GID for tickets whose agent
//                                doesn't match any board column
//   ASANA_AM_FIELD_GID           Asana custom field (enum) GID used to tag the
//                                account manager on each ticket. Set this once
//                                the field is created in Asana — without it,
//                                tickets are still created but without the AM
//                                tag (board view falls back to agent column only).
//
// Project custom fields discovered by name (no env var needed):
//   "Case Status"  — set to "Pending Action" on every new ticket. Other
//                    options ("Resolved", "No Action Needed") are managed
//                    manually inside Asana. Missing options are NOT auto-
//                    created so this stays a fixed three-state field.
//   "Severity"     — set to "Severity 1/2/3" based on the AI severity level.
//                    Missing options are NOT auto-created.
//   "Category"     — set to the first result.category from the AI summary.
//                    Missing options ARE auto-created since AI labels drift.
//   "Issue"        — set to the first result.item from the AI summary. Same
//                    auto-create behaviour as Category.
// If a field doesn't exist on the project it is silently skipped — the
// ticket is still created, just without that tag.
//   ASANA_AM_USER_MAP            JSON map of AM display name → Asana user GID,
//                                e.g. {"Ada":"1199...","Christian":"1199..."}.
//                                Used as an explicit override — wins over
//                                workspace auto-discovery. Useful for joint
//                                AMs ("Geri/Nik") and display-name mismatches.
//                                Unmapped AMs fall through to the workspace
//                                user lookup below.
//   ASANA_WORKSPACE_GID          Optional. The workspace whose user list is
//                                searched to auto-resolve an AM by name when
//                                ASANA_AM_USER_MAP doesn't cover them. If
//                                unset we derive it from the configured
//                                project's workspace.gid.
//   ASANA_DISABLE_AM_ASSIGNEE    Set to "true" to skip setting the AM as the
//                                Asana assignee (so they don't get notified).
//                                Tickets are still created, routed to the AM
//                                column, and tagged with the AM field — only
//                                the assignee is omitted. Unset/anything else
//                                = normal behaviour.
//   NEXT_PUBLIC_APP_URL          Base URL used for the QA-tool back-link
//   NEXT_PUBLIC_INTERCOM_APP_ID  Used for the Intercom inbox back-link
//
// Required Supabase migration (run once in the dashboard):
//
//   ALTER TABLE conversations ADD COLUMN IF NOT EXISTS asana_task_gid TEXT;
//   ALTER TABLE conversations ADD COLUMN IF NOT EXISTS asana_completed_at TIMESTAMPTZ;
//   ALTER TABLE conversations ADD COLUMN IF NOT EXISTS asana_task_deleted_at TIMESTAMPTZ;
//   CREATE INDEX IF NOT EXISTS conversations_asana_task_gid_idx
//     ON conversations (asana_task_gid)
//     WHERE asana_task_gid IS NOT NULL;
//
// Stale-GID handling: when the sync sees a ticket gid that Asana no longer
// returns (deleted/archived/moved), we set asana_task_deleted_at so the
// reporting page stops counting it. We keep asana_task_gid populated so the
// dedup check in maybeCreateAsanaTicketForConversation still skips it — i.e.
// re-analysis of that conversation will NOT silently re-create the ticket
// the user deleted on purpose.

import { cleanPlayerName, getVipLevel, getBacklinkFull, parseSummaryForTable } from '@/lib/utils';

const ASANA_API = 'https://app.asana.com/api/1.0';

// In-memory cache of the project's section list — lowercased section name → gid.
// Refreshed every SECTIONS_TTL_MS so newly-added AM columns get picked up
// without a redeploy. Stale on cold start (serverless), which is fine.
const SECTIONS_TTL_MS = 10 * 60 * 1000;
let sectionsCache: { fetchedAt: number; map: Map<string, string> } | null = null;

// In-flight section creation promises keyed by lowercased AM name.
// Prevents two concurrent severity-3 analyses for the same new AM from
// racing and creating two duplicate columns within the same invocation.
const sectionCreatesInFlight = new Map<string, Promise<string | null>>();

// Same TTL/in-flight pattern for the Account Manager custom-field enum options.
// Map: lowercased AM name → enum_option gid for the configured AM custom field.
const AM_OPTIONS_TTL_MS = 10 * 60 * 1000;
let amOptionsCache: { fetchedAt: number; map: Map<string, string> } | null = null;
const amOptionCreatesInFlight = new Map<string, Promise<string | null>>();

// Project-level custom-field discovery. Lets us look up "Case Status",
// "Severity", "Category", "Issue" by their human name in the Asana project
// instead of demanding a separate ASANA_*_FIELD_GID env var per field. Field
// names are matched case-insensitively. Cached with the same TTL as sections.
const FIELDS_TTL_MS = 10 * 60 * 1000;
let projectFieldsCache: { fetchedAt: number; map: Map<string, string> } | null = null;

// Per-field enum option caches (separate from the AM cache so each field has
// its own option namespace). Keyed by field gid → lowercased option name → option gid.
const ENUM_OPTIONS_TTL_MS = 10 * 60 * 1000;
const enumOptionsCache = new Map<string, { fetchedAt: number; map: Map<string, string> }>();
// In-flight option creates keyed by `${fieldGid}::${nameLower}` so two parallel
// invocations don't race to create the same option twice.
const enumOptionCreatesInFlight = new Map<string, Promise<string | null>>();

// Workspace-level user discovery for assignee routing. Lets us look up an AM
// by name in the Asana workspace instead of requiring every AM be present in
// ASANA_AM_USER_MAP. The env-var map still wins when set — useful for edge
// cases (display name ≠ Asana user name, joint AMs like "Geri/Nik").
const WORKSPACE_TTL_MS = 60 * 60 * 1000;
let workspaceGidCache: { fetchedAt: number; gid: string | null } | null = null;
const WORKSPACE_USERS_TTL_MS = 30 * 60 * 1000;
let workspaceUsersCache: { fetchedAt: number; map: Map<string, string> } | null = null;

export function isAsanaConfigured(): boolean {
  return !!(process.env.ASANA_ACCESS_TOKEN && process.env.ASANA_PROJECT_GID);
}

function isAmFieldConfigured(): boolean {
  return !!process.env.ASANA_AM_FIELD_GID;
}

// Parsed once per process — bad JSON is logged once and treated as empty
// so a malformed env var degrades gracefully (tickets still get created,
// just without an assignee).
let amUserMapCache: Map<string, string> | null = null;
let amUserMapWarned = false;

function getAmUserMap(): Map<string, string> {
  if (amUserMapCache) return amUserMapCache;
  const raw = process.env.ASANA_AM_USER_MAP;
  if (!raw) {
    amUserMapCache = new Map();
    return amUserMapCache;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    const map = new Map<string, string>();
    for (const [name, gid] of Object.entries(parsed)) {
      if (typeof name === 'string' && typeof gid === 'string' && name.trim() && gid.trim()) {
        map.set(name.trim().toLowerCase(), gid.trim());
      }
    }
    amUserMapCache = map;
    return map;
  } catch (e) {
    if (!amUserMapWarned) {
      console.error('[asana] ASANA_AM_USER_MAP is not valid JSON; AM assignee disabled:', (e as Error).message);
      amUserMapWarned = true;
    }
    amUserMapCache = new Map();
    return amUserMapCache;
  }
}

function resolveAmAssignee(amName: string | null): string | null {
  if (!amName) return null;
  const map = getAmUserMap();
  if (map.size === 0) return null;
  return map.get(amName.trim().toLowerCase()) ?? null;
}

// Derives the workspace GID from the configured project so we don't need a
// separate ASANA_WORKSPACE_GID env var. Cached for an hour — workspaces
// don't move. Optional env override is honoured for self-hosted edge cases.
async function getWorkspaceGid(): Promise<string | null> {
  if (workspaceGidCache && Date.now() - workspaceGidCache.fetchedAt < WORKSPACE_TTL_MS) {
    return workspaceGidCache.gid;
  }
  const fromEnv = process.env.ASANA_WORKSPACE_GID;
  if (fromEnv) {
    workspaceGidCache = { fetchedAt: Date.now(), gid: fromEnv };
    return fromEnv;
  }
  if (!isAsanaConfigured()) return null;
  const token = process.env.ASANA_ACCESS_TOKEN!;
  const projectGid = process.env.ASANA_PROJECT_GID!;
  try {
    const res = await fetch(`${ASANA_API}/projects/${projectGid}?opt_fields=workspace.gid`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[asana] get project workspace failed (${res.status}): ${body.slice(0, 300)}`);
      return workspaceGidCache?.gid ?? null;
    }
    const json = await res.json();
    const gid: string | null = json?.data?.workspace?.gid ?? null;
    workspaceGidCache = { fetchedAt: Date.now(), gid };
    return gid;
  } catch (e) {
    console.error('[asana] get project workspace exception:', (e as Error).message);
    return workspaceGidCache?.gid ?? null;
  }
}

// Lists every user in the workspace and returns a lowercased-name → user gid
// map. Pages through Asana's offset cursor (100/page). Used by the assignee
// resolver below so an AM can be matched without ASANA_AM_USER_MAP.
async function getWorkspaceUsersByName(): Promise<Map<string, string>> {
  if (workspaceUsersCache && Date.now() - workspaceUsersCache.fetchedAt < WORKSPACE_USERS_TTL_MS) {
    return workspaceUsersCache.map;
  }
  const workspaceGid = await getWorkspaceGid();
  if (!workspaceGid) return workspaceUsersCache?.map ?? new Map();
  const token = process.env.ASANA_ACCESS_TOKEN!;

  const map = new Map<string, string>();
  let offset: string | null = null;
  // Hard-cap pagination so a misbehaving cursor can't loop forever.
  for (let page = 0; page < 50; page++) {
    const params = new URLSearchParams({
      workspace: workspaceGid,
      limit: '100',
      opt_fields: 'gid,name',
    });
    if (offset) params.set('offset', offset);
    try {
      const res = await fetch(`${ASANA_API}/users?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[asana] list workspace users failed (${res.status}): ${body.slice(0, 300)}`);
        return workspaceUsersCache?.map ?? new Map();
      }
      const json = await res.json();
      for (const u of (json?.data ?? []) as Array<{ gid?: string; name?: string }>) {
        if (u?.gid && typeof u?.name === 'string') {
          map.set(u.name.trim().toLowerCase(), u.gid);
        }
      }
      offset = json?.next_page?.offset ?? null;
      if (!offset) break;
    } catch (e) {
      console.error('[asana] list workspace users exception:', (e as Error).message);
      return workspaceUsersCache?.map ?? new Map();
    }
  }
  workspaceUsersCache = { fetchedAt: Date.now(), map };
  return map;
}

// Resolves the Asana user GID to assign a ticket to, given an AM display
// name. Resolution order:
//   1. ASANA_AM_USER_MAP env override (explicit, highest priority).
//   2. Exact name match in the workspace user list.
//   3. First-token match: AM "Christian" matches user "Christian Surname";
//      AM "Geri/Nik" tries "Geri", then "Nik". This catches the common case
//      where the AM display name is just a first name but the Asana user
//      record has the full name.
// Returns null when nothing matches — the ticket is created unassigned
// rather than being rejected.
async function resolveAssigneeForAm(amName: string | null): Promise<string | null> {
  if (!amName) return null;

  const fromEnv = resolveAmAssignee(amName);
  if (fromEnv) return fromEnv;

  const users = await getWorkspaceUsersByName();
  if (users.size === 0) return null;

  const normalized = amName.trim().toLowerCase();
  const exact = users.get(normalized);
  if (exact) return exact;

  // AM display name might be a first name only or a joint AM like "Geri/Nik".
  // Split on whitespace + slash and try each token against user first names.
  const tokens = normalized.split(/[\s/]+/).filter(Boolean);
  for (const token of tokens) {
    for (const [userName, userGid] of users) {
      if (userName === token) return userGid;
      if (userName.split(/\s+/)[0] === token) return userGid;
    }
  }
  return null;
}

async function getProjectSections(): Promise<Map<string, string>> {
  if (sectionsCache && Date.now() - sectionsCache.fetchedAt < SECTIONS_TTL_MS) {
    return sectionsCache.map;
  }
  if (!isAsanaConfigured()) return new Map();

  const token = process.env.ASANA_ACCESS_TOKEN!;
  const projectGid = process.env.ASANA_PROJECT_GID!;

  try {
    const res = await fetch(`${ASANA_API}/projects/${projectGid}/sections`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[asana] list sections failed (${res.status}): ${body.slice(0, 300)}`);
      // Reuse stale cache rather than returning empty — better than mis-routing.
      return sectionsCache?.map ?? new Map();
    }
    const json = await res.json();
    const map = new Map<string, string>();
    for (const s of (json?.data ?? []) as Array<{ gid?: string; name?: string }>) {
      if (s?.gid && typeof s?.name === 'string') {
        map.set(s.name.trim().toLowerCase(), s.gid);
      }
    }
    sectionsCache = { fetchedAt: Date.now(), map };
    return map;
  } catch (e) {
    console.error('[asana] list sections exception:', (e as Error).message);
    return sectionsCache?.map ?? new Map();
  }
}

// Resolves an AM name to a section gid using exact-match then first-word.
// Returns null when no column matches — the caller decides the fallback.
async function resolveSectionForAccountManager(amName: string | null): Promise<string | null> {
  if (!amName) return null;
  const sections = await getProjectSections();
  if (sections.size === 0) return null;

  const normalized = amName.trim().toLowerCase();
  const exact = sections.get(normalized);
  if (exact) return exact;

  const firstWord = normalized.split(/\s+/)[0];
  if (firstWord && firstWord !== normalized) {
    const fw = sections.get(firstWord);
    if (fw) return fw;
  }
  return null;
}

// Resolves an AM's section gid; creates the section if it doesn't exist.
// Refreshes the cache once on miss to catch sections created by another
// invocation, then deduplicates concurrent creates within this invocation
// via sectionCreatesInFlight so we don't make two columns named "Ada".
async function ensureSectionForAccountManager(amName: string | null): Promise<string | null> {
  if (!amName) return null;
  const trimmed = amName.trim();
  if (!trimmed) return null;

  const existing = await resolveSectionForAccountManager(trimmed);
  if (existing) return existing;

  const key = trimmed.toLowerCase();
  const inFlight = sectionCreatesInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = (async () => {
    // Force a cache refresh in case a parallel cron tick or another serverless
    // instance just created this section for the same AM.
    sectionsCache = null;
    const afterRefresh = await resolveSectionForAccountManager(trimmed);
    if (afterRefresh) return afterRefresh;
    return createSectionForAccountManager(trimmed);
  })().finally(() => {
    sectionCreatesInFlight.delete(key);
  });

  sectionCreatesInFlight.set(key, promise);
  return promise;
}

// ── Account Manager custom-field plumbing ─────────────────────────────────
// The AM custom field must be created once in Asana as an enum (dropdown)
// type, and its GID set in ASANA_AM_FIELD_GID. We then read its enum_options
// to find the matching option for an AM name; if no option exists we create
// one — same auto-create + cache pattern as the section logic above.
//
// If ASANA_AM_FIELD_GID is unset, all AM-tagging is silently skipped so this
// integration keeps working with just the per-agent column routing.

async function getAmFieldOptions(): Promise<Map<string, string>> {
  if (!isAmFieldConfigured() || !isAsanaConfigured()) return new Map();
  if (amOptionsCache && Date.now() - amOptionsCache.fetchedAt < AM_OPTIONS_TTL_MS) {
    return amOptionsCache.map;
  }
  const token = process.env.ASANA_ACCESS_TOKEN!;
  const fieldGid = process.env.ASANA_AM_FIELD_GID!;

  try {
    const res = await fetch(
      `${ASANA_API}/custom_fields/${fieldGid}?opt_fields=enum_options.gid,enum_options.name,resource_subtype`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[asana] get AM field failed (${res.status}): ${body.slice(0, 300)}`);
      return amOptionsCache?.map ?? new Map();
    }
    const json = await res.json();
    const subtype: string | undefined = json?.data?.resource_subtype;
    if (subtype && subtype !== 'enum') {
      console.error(`[asana] ASANA_AM_FIELD_GID is not an enum field (subtype=${subtype}); AM tagging disabled`);
      // Cache an empty result so we don't hammer the API on repeated misconfigs.
      amOptionsCache = { fetchedAt: Date.now(), map: new Map() };
      return amOptionsCache.map;
    }
    const map = new Map<string, string>();
    for (const o of (json?.data?.enum_options ?? []) as Array<{ gid?: string; name?: string }>) {
      if (o?.gid && typeof o?.name === 'string') {
        map.set(o.name.trim().toLowerCase(), o.gid);
      }
    }
    amOptionsCache = { fetchedAt: Date.now(), map };
    return map;
  } catch (e) {
    console.error('[asana] get AM field exception:', (e as Error).message);
    return amOptionsCache?.map ?? new Map();
  }
}

async function ensureAmEnumOption(amName: string | null): Promise<string | null> {
  if (!amName || !isAmFieldConfigured()) return null;
  const trimmed = amName.trim();
  if (!trimmed) return null;
  const key = trimmed.toLowerCase();

  const options = await getAmFieldOptions();
  const existing = options.get(key);
  if (existing) return existing;

  const inFlight = amOptionCreatesInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = (async () => {
    // Force a refresh in case another invocation just created the option.
    amOptionsCache = null;
    const refreshed = await getAmFieldOptions();
    const found = refreshed.get(key);
    if (found) return found;
    return createAmEnumOption(trimmed);
  })().finally(() => {
    amOptionCreatesInFlight.delete(key);
  });
  amOptionCreatesInFlight.set(key, promise);
  return promise;
}

async function createAmEnumOption(name: string): Promise<string | null> {
  if (!isAmFieldConfigured() || !isAsanaConfigured()) return null;
  const token = process.env.ASANA_ACCESS_TOKEN!;
  const fieldGid = process.env.ASANA_AM_FIELD_GID!;

  try {
    const res = await fetch(`${ASANA_API}/custom_fields/${fieldGid}/enum_options`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ data: { name } }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[asana] create AM option "${name}" failed (${res.status}): ${body.slice(0, 300)}`);
      return null;
    }
    const json = await res.json();
    const gid: string | undefined = json?.data?.gid;
    if (!gid) return null;
    if (amOptionsCache) {
      amOptionsCache.map.set(name.toLowerCase(), gid);
    } else {
      amOptionsCache = { fetchedAt: Date.now(), map: new Map([[name.toLowerCase(), gid]]) };
    }
    console.log(`[asana] auto-created AM enum option "${name}" (gid=${gid})`);
    return gid;
  } catch (e) {
    console.error('[asana] create AM option exception:', (e as Error).message);
    return null;
  }
}

// ── Project custom-field discovery (for Case Status / Severity / Category /
// Issue) ──────────────────────────────────────────────────────────────────
// Lists the custom fields attached to ASANA_PROJECT_GID and returns a
// lowercased-name → field gid map. Cached for FIELDS_TTL_MS so we don't hit
// the API on every create.
async function getProjectFieldsByName(): Promise<Map<string, string>> {
  if (projectFieldsCache && Date.now() - projectFieldsCache.fetchedAt < FIELDS_TTL_MS) {
    return projectFieldsCache.map;
  }
  if (!isAsanaConfigured()) return new Map();
  const token = process.env.ASANA_ACCESS_TOKEN!;
  const projectGid = process.env.ASANA_PROJECT_GID!;

  try {
    const res = await fetch(
      `${ASANA_API}/projects/${projectGid}/custom_field_settings?opt_fields=custom_field.gid,custom_field.name,custom_field.resource_subtype`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[asana] list custom fields failed (${res.status}): ${body.slice(0, 300)}`);
      return projectFieldsCache?.map ?? new Map();
    }
    const json = await res.json();
    const map = new Map<string, string>();
    for (const s of (json?.data ?? []) as Array<{
      custom_field?: { gid?: string; name?: string };
    }>) {
      const cf = s?.custom_field;
      if (cf?.gid && typeof cf?.name === 'string') {
        map.set(cf.name.trim().toLowerCase(), cf.gid);
      }
    }
    projectFieldsCache = { fetchedAt: Date.now(), map };
    return map;
  } catch (e) {
    console.error('[asana] list custom fields exception:', (e as Error).message);
    return projectFieldsCache?.map ?? new Map();
  }
}

async function getEnumOptionsForField(fieldGid: string): Promise<Map<string, string>> {
  const cached = enumOptionsCache.get(fieldGid);
  if (cached && Date.now() - cached.fetchedAt < ENUM_OPTIONS_TTL_MS) {
    return cached.map;
  }
  if (!isAsanaConfigured()) return new Map();
  const token = process.env.ASANA_ACCESS_TOKEN!;
  try {
    const res = await fetch(
      `${ASANA_API}/custom_fields/${fieldGid}?opt_fields=enum_options.gid,enum_options.name,resource_subtype`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[asana] get enum options for ${fieldGid} failed (${res.status}): ${body.slice(0, 300)}`);
      return cached?.map ?? new Map();
    }
    const json = await res.json();
    const subtype: string | undefined = json?.data?.resource_subtype;
    if (subtype && subtype !== 'enum') {
      // Cache empty so we don't keep hitting the API for non-enum fields.
      enumOptionsCache.set(fieldGid, { fetchedAt: Date.now(), map: new Map() });
      return new Map();
    }
    const map = new Map<string, string>();
    for (const o of (json?.data?.enum_options ?? []) as Array<{ gid?: string; name?: string }>) {
      if (o?.gid && typeof o?.name === 'string') {
        map.set(o.name.trim().toLowerCase(), o.gid);
      }
    }
    enumOptionsCache.set(fieldGid, { fetchedAt: Date.now(), map });
    return map;
  } catch (e) {
    console.error('[asana] get enum options exception:', (e as Error).message);
    return cached?.map ?? new Map();
  }
}

// Resolves an enum option for a project field discovered by name. When
// `autoCreate` is true and the option doesn't exist, a new one is created
// (used for Category/Issue where AI-produced labels can drift). For fixed
// option sets like Case Status and Severity pass `autoCreate=false` so a
// missing option silently skips the field rather than polluting the project.
async function resolveProjectEnum(
  fieldName: string,
  optionName: string | null,
  autoCreate: boolean,
): Promise<{ fieldGid: string; optionGid: string } | null> {
  if (!optionName) return null;
  const trimmedOption = optionName.trim();
  if (!trimmedOption) return null;

  const fields = await getProjectFieldsByName();
  const fieldGid = fields.get(fieldName.trim().toLowerCase());
  if (!fieldGid) return null;

  const optKey = trimmedOption.toLowerCase();
  const options = await getEnumOptionsForField(fieldGid);
  const existing = options.get(optKey);
  if (existing) return { fieldGid, optionGid: existing };

  if (!autoCreate) return null;

  const inFlightKey = `${fieldGid}::${optKey}`;
  const inFlight = enumOptionCreatesInFlight.get(inFlightKey);
  if (inFlight) {
    const optionGid = await inFlight;
    return optionGid ? { fieldGid, optionGid } : null;
  }

  const promise = (async () => {
    // Refresh cache once on miss in case another invocation just created it.
    enumOptionsCache.delete(fieldGid);
    const refreshed = await getEnumOptionsForField(fieldGid);
    const found = refreshed.get(optKey);
    if (found) return found;
    return createEnumOptionForField(fieldGid, trimmedOption);
  })().finally(() => {
    enumOptionCreatesInFlight.delete(inFlightKey);
  });
  enumOptionCreatesInFlight.set(inFlightKey, promise);

  const optionGid = await promise;
  return optionGid ? { fieldGid, optionGid } : null;
}

async function createEnumOptionForField(fieldGid: string, name: string): Promise<string | null> {
  if (!isAsanaConfigured()) return null;
  const token = process.env.ASANA_ACCESS_TOKEN!;
  try {
    const res = await fetch(`${ASANA_API}/custom_fields/${fieldGid}/enum_options`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ data: { name } }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[asana] create enum option "${name}" on ${fieldGid} failed (${res.status}): ${body.slice(0, 300)}`);
      return null;
    }
    const json = await res.json();
    const gid: string | undefined = json?.data?.gid;
    if (!gid) return null;
    const cached = enumOptionsCache.get(fieldGid);
    if (cached) {
      cached.map.set(name.toLowerCase(), gid);
    } else {
      enumOptionsCache.set(fieldGid, {
        fetchedAt: Date.now(),
        map: new Map([[name.toLowerCase(), gid]]),
      });
    }
    console.log(`[asana] auto-created enum option "${name}" on field ${fieldGid} (gid=${gid})`);
    return gid;
  } catch (e) {
    console.error('[asana] create enum option exception:', (e as Error).message);
    return null;
  }
}

async function createSectionForAccountManager(name: string): Promise<string | null> {
  if (!isAsanaConfigured()) return null;
  const token = process.env.ASANA_ACCESS_TOKEN!;
  const projectGid = process.env.ASANA_PROJECT_GID!;

  try {
    const res = await fetch(`${ASANA_API}/projects/${projectGid}/sections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ data: { name } }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[asana] create section "${name}" failed (${res.status}): ${body.slice(0, 300)}`);
      return null;
    }
    const json = await res.json();
    const gid: string | undefined = json?.data?.gid;
    if (!gid) return null;

    // Backfill the cache so the next ticket for this agent hits without a network round trip.
    if (sectionsCache) {
      sectionsCache.map.set(name.toLowerCase(), gid);
    } else {
      sectionsCache = { fetchedAt: Date.now(), map: new Map([[name.toLowerCase(), gid]]) };
    }
    console.log(`[asana] auto-created section "${name}" (gid=${gid})`);
    return gid;
  } catch (e) {
    console.error('[asana] create section exception:', (e as Error).message);
    return null;
  }
}

export interface AsanaTaskInput {
  conversationId: string;
  intercomId: string | null;
  playerName: string | null;
  playerEmail: string | null;
  agentName: string | null;
  agentEmail: string | null;
  // Account manager who owns follow-up for this player. Used to set the AM
  // custom field on the Asana ticket so the same task can be filtered by
  // either agent (column) or AM (field) inside one project.
  accountManager: string | null;
  brand: string | null;
  vipLevel: string | null;       // e.g. "L7"
  language: string | null;
  country: string | null;
  backlinkFull: string | null;   // BACKEND account link from custom attributes
  severity: string;              // e.g. "Level 3"
  resolutionStatus: string | null;
  issueCategories: string[];     // collected from results[].category
  issueItems: string[];          // collected from results[].item
  summaryText: string;           // raw AI JSON / rendered summary
}

function buildTaskName(input: AsanaTaskInput): string {
  // Strip the casino slug Intercom appends to contact names (e.g. "Jan _spinjo")
  // so the task title matches the dashboard's player column.
  const who = cleanPlayerName(input.playerName) ?? 'Unknown player';
  const cat = input.issueCategories[0] ? ` — ${input.issueCategories[0]}` : '';
  // Asana caps task names at 1024 chars but anything past ~250 wraps badly in
  // list views — trim defensively.
  return `${who}${cat}`.slice(0, 250);
}

function buildTaskNotes(input: AsanaTaskInput): string {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
  const intercomAppId = process.env.NEXT_PUBLIC_INTERCOM_APP_ID ?? '';
  const SPACER = '———-';

  const customerName = cleanPlayerName(input.playerName) ?? 'Unknown';

  const lines: string[] = [];
  // Identity block
  lines.push(`Customer Name: ${customerName}`);
  lines.push(`VIP Level: ${input.vipLevel ?? 'Unknown'}`);
  lines.push(`Language: ${input.language ?? 'Unknown'}`);
  lines.push(`Country: ${input.country ?? 'Unknown'}`);
  lines.push(`Brand: ${input.brand ?? 'Unknown'}`);
  lines.push(`Agent: ${input.agentName ?? 'Unknown'}`);
  lines.push(SPACER);

  // Links block
  const intercomLink = input.intercomId && intercomAppId
    ? `https://app.intercom.com/a/apps/${intercomAppId}/conversations/${input.intercomId}`
    : null;
  lines.push(`Link to Chat: ${intercomLink ?? '—'}`);
  lines.push(`Link to BACKEND Account: ${input.backlinkFull ?? '—'}`);
  const toolLink = appUrl ? `${appUrl}/conversations/${input.conversationId}` : null;
  lines.push(`Link to Conversation in the Tool: ${toolLink ?? '—'}`);
  lines.push(SPACER);

  lines.push('AI Chat Summary');
  lines.push('');
  const narrative = parseSummaryForTable(input.summaryText).summary;
  lines.push(narrative ?? '—');
  return lines.join('\n');
}

// Fetches { gid → { completed, completed_at } } for every task in the
// configured project. Pagination uses Asana's offset cursor; each page is up
// to 100 tasks. Used by /api/admin/sync-asana-statuses to refresh open/closed
// counts on the reporting page in one project-level sweep instead of N
// per-task GETs.
export async function fetchProjectTaskStatuses(): Promise<
  Map<string, { completed: boolean; completed_at: string | null }>
> {
  const map = new Map<string, { completed: boolean; completed_at: string | null }>();
  if (!isAsanaConfigured()) return map;
  const token = process.env.ASANA_ACCESS_TOKEN!;
  const projectGid = process.env.ASANA_PROJECT_GID!;

  let offset: string | null = null;
  // Hard cap to keep a misbehaving paginator from looping forever.
  for (let page = 0; page < 100; page++) {
    const params = new URLSearchParams({
      limit: '100',
      opt_fields: 'completed,completed_at',
    });
    if (offset) params.set('offset', offset);
    const url = `${ASANA_API}/projects/${projectGid}/tasks?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`[asana] list project tasks failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    for (const t of (json?.data ?? []) as Array<{
      gid?: string;
      completed?: boolean;
      completed_at?: string | null;
    }>) {
      if (t?.gid) {
        map.set(t.gid, {
          completed: !!t.completed,
          completed_at: t.completed_at ?? null,
        });
      }
    }
    offset = json?.next_page?.offset ?? null;
    if (!offset) break;
  }
  return map;
}

// Public Asana-push trigger callable from any analysis path. Re-fetches the
// conversation context, runs the same severity-3 / dedup check that lives in
// lib/analyze-sync.ts, and writes asana_task_gid back on success. All errors
// are logged and swallowed so a flaky Asana API never fails analysis.
//
// Call this after the analysis summary has been committed to the DB.
// Safe to fire-and-forget — return value is the new task gid (or null).
export async function maybeCreateAsanaTicketForConversation(
  conversationId: string,
  summaryText: string,
): Promise<string | null> {
  if (!isAsanaConfigured()) return null;
  try {
    // Lazy import to avoid a circular dependency: lib/db imports from this
    // module via downstream callers (mapper helpers), and the analytics
    // helpers live alongside DB code. Keeping the dynamic import here means
    // the cycle resolves at call time, not at module load.
    const [{ dbGetAsanaConversationContext, dbUpdateAsanaTaskGid }, { parseAnalysisSummary, normalizeSeverity }] =
      await Promise.all([
        import('@/lib/db'),
        import('@/lib/analyticsFilters'),
      ]);

    const parsed = parseAnalysisSummary(summaryText);
    if (normalizeSeverity(parsed.dissatisfaction_severity) !== 'Level 3') return null;

    const ctx = await dbGetAsanaConversationContext(conversationId);
    if (!ctx || ctx.asana_task_gid) return null;

    const issueCategories: string[] = [];
    const issueItems: string[] = [];
    const seenCat = new Set<string>();
    const seenItem = new Set<string>();
    for (const r of parsed.results ?? []) {
      const c = String(r.category ?? '').trim();
      if (c && !seenCat.has(c)) { seenCat.add(c); issueCategories.push(c); }
      const it = String(r.item ?? '').trim();
      if (it && !seenItem.has(it)) { seenItem.add(it); issueItems.push(it); }
    }

    const gid = await createAsanaTaskForConversation({
      conversationId,
      intercomId: ctx.intercom_id,
      playerName: ctx.player_name,
      playerEmail: ctx.player_email,
      agentName: ctx.agent_name,
      agentEmail: ctx.agent_email,
      accountManager: ctx.account_manager,
      brand: ctx.brand,
      vipLevel: getVipLevel(ctx),
      language: ctx.language,
      country: ctx.player_country,
      backlinkFull: getBacklinkFull(ctx),
      severity: 'Level 3',
      resolutionStatus: parsed.resolution_status,
      issueCategories,
      issueItems,
      summaryText,
    });
    if (gid) await dbUpdateAsanaTaskGid(conversationId, gid);
    return gid;
  } catch (e) {
    console.error('[asana] trigger error:', (e as Error).message);
    return null;
  }
}

export async function createAsanaTaskForConversation(
  input: AsanaTaskInput,
): Promise<string | null> {
  if (!isAsanaConfigured()) return null;

  const token = process.env.ASANA_ACCESS_TOKEN!;
  const projectGid = process.env.ASANA_PROJECT_GID!;

  // Per-ticket routing: find or auto-create the column matching the AM.
  // ASANA_SECTION_GID is only used as a last-resort fallback when ensure
  // fails (rate limit / perms / no AM name).
  const ensuredSection = await ensureSectionForAccountManager(input.accountManager);
  const sectionGid = ensuredSection ?? process.env.ASANA_SECTION_GID ?? null;
  if (!ensuredSection && input.accountManager) {
    console.warn(`[asana] could not ensure section for account manager: ${input.accountManager}`);
  }

  // AM custom-field option (kept as a redundant filter axis alongside the AM
  // column so the same field can be used in other Asana views). Resolved
  // against the configured ASANA_AM_FIELD_GID; auto-creates a new option if
  // an unseen AM appears (e.g. a freshly added VIP_<name> group). Best-effort
  // — a null result just means the field is unconfigured or transiently
  // unavailable; the ticket is still created.
  const amOptionGid = await ensureAmEnumOption(input.accountManager);
  const amFieldGid = process.env.ASANA_AM_FIELD_GID;
  const customFields: Record<string, string> = {};
  if (amFieldGid && amOptionGid) {
    customFields[amFieldGid] = amOptionGid;
  }

  // Project-level enum fields discovered by name from the Asana project.
  // Run in parallel — each lookup is cached so steady-state cost is one tiny
  // map read per field. Case Status defaults to "Pending Action" on every new
  // escalation; Severity is derived from the AI's level digit; Category /
  // Issue come from the first result and auto-create options if the AI
  // produces an unseen label (matches the AM auto-create behaviour).
  const sevDigit = input.severity.match(/\d/)?.[0] ?? null;
  const [caseStatusEnum, severityEnum, categoryEnum, issueEnum] = await Promise.all([
    resolveProjectEnum('Case Status', 'Pending Action', false),
    sevDigit ? resolveProjectEnum('Severity', `Severity ${sevDigit}`, false) : Promise.resolve(null),
    resolveProjectEnum('Category', input.issueCategories[0] ?? null, true),
    resolveProjectEnum('Issue', input.issueItems[0] ?? null, true),
  ]);
  for (const e of [caseStatusEnum, severityEnum, categoryEnum, issueEnum]) {
    if (e) customFields[e.fieldGid] = e.optionGid;
  }

  // Assignee: ASANA_AM_USER_MAP wins when set (explicit override for joint
  // AMs like "Geri/Nik" or display-name mismatches), otherwise we look the
  // AM up by name in the workspace user list. Unresolvable AMs leave the
  // ticket unassigned and log a warning — creation still succeeds.
  // ASANA_DISABLE_AM_ASSIGNEE=true skips assignee entirely so AMs don't get
  // notified while escalation criteria are still being finalised.
  const amAssigneeDisabled = process.env.ASANA_DISABLE_AM_ASSIGNEE === 'true';
  const assigneeGid = amAssigneeDisabled
    ? null
    : await resolveAssigneeForAm(input.accountManager);
  if (!amAssigneeDisabled && !assigneeGid && input.accountManager) {
    console.warn(`[asana] could not resolve assignee for account manager: ${input.accountManager}`);
  }

  const payload = {
    data: {
      name: buildTaskName(input),
      notes: buildTaskNotes(input),
      projects: [projectGid],
      ...(sectionGid
        ? { memberships: [{ project: projectGid, section: sectionGid }] }
        : {}),
      ...(Object.keys(customFields).length > 0 ? { custom_fields: customFields } : {}),
      ...(assigneeGid ? { assignee: assigneeGid } : {}),
    },
  };

  try {
    const res = await fetch(`${ASANA_API}/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[asana] create task failed (${res.status}): ${body.slice(0, 300)}`);
      return null;
    }

    const json = await res.json();
    const gid: string | undefined = json?.data?.gid;
    return gid ?? null;
  } catch (e) {
    console.error('[asana] create task exception:', (e as Error).message);
    return null;
  }
}
