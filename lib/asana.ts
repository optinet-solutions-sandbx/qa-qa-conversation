// Asana integration — pushes a ticket into the configured Asana project when
// the AI flags a conversation with dissatisfaction severity Level 3. Called
// from lib/analyze-sync.ts after a successful analysis. Failures are logged
// and swallowed so a flaky Asana API never breaks the analysis pipeline.
//
// Routing: each ticket lands in the project section (board column) whose name
// matches the conversation's agent_name. Matching is case-insensitive exact
// first, then first-word (so "Becka VIP" still matches a column named "Becka").
// If no column matches, a new column named after the agent is auto-created
// and the ticket lands there. If creation itself fails (rate limit, perms),
// ASANA_SECTION_GID is used as a last-resort fallback; otherwise the ticket
// goes to the project default.
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
//   ASANA_AM_USER_MAP            JSON map of AM display name → Asana user GID,
//                                e.g. {"Ada":"1199...","Christian":"1199..."}.
//                                When the ticket's AM matches a key, the task
//                                is assigned to that user so they get a real
//                                Asana notification. Names are matched case-
//                                insensitively. Unmapped AMs leave assignee
//                                unset (no ping; ticket still routes by column
//                                + custom field).
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

const ASANA_API = 'https://app.asana.com/api/1.0';

// In-memory cache of the project's section list — lowercased section name → gid.
// Refreshed every SECTIONS_TTL_MS so newly-added agent columns get picked up
// without a redeploy. Stale on cold start (serverless), which is fine.
const SECTIONS_TTL_MS = 10 * 60 * 1000;
let sectionsCache: { fetchedAt: number; map: Map<string, string> } | null = null;

// In-flight section creation promises keyed by lowercased agent name.
// Prevents two concurrent severity-3 analyses for the same new agent from
// racing and creating two duplicate columns within the same invocation.
const sectionCreatesInFlight = new Map<string, Promise<string | null>>();

// Same TTL/in-flight pattern for the Account Manager custom-field enum options.
// Map: lowercased AM name → enum_option gid for the configured AM custom field.
const AM_OPTIONS_TTL_MS = 10 * 60 * 1000;
let amOptionsCache: { fetchedAt: number; map: Map<string, string> } | null = null;
const amOptionCreatesInFlight = new Map<string, Promise<string | null>>();

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

// Resolves an agent name to a section gid using exact-match then first-word.
// Returns null when no column matches — the caller decides the fallback.
async function resolveSectionForAgent(agentName: string | null): Promise<string | null> {
  if (!agentName) return null;
  const sections = await getProjectSections();
  if (sections.size === 0) return null;

  const normalized = agentName.trim().toLowerCase();
  const exact = sections.get(normalized);
  if (exact) return exact;

  const firstWord = normalized.split(/\s+/)[0];
  if (firstWord && firstWord !== normalized) {
    const fw = sections.get(firstWord);
    if (fw) return fw;
  }
  return null;
}

// Resolves an agent's section gid; creates the section if it doesn't exist.
// Refreshes the cache once on miss to catch sections created by another
// invocation, then deduplicates concurrent creates within this invocation
// via sectionCreatesInFlight so we don't make two columns named "Allen".
async function ensureSectionForAgent(agentName: string | null): Promise<string | null> {
  if (!agentName) return null;
  const trimmed = agentName.trim();
  if (!trimmed) return null;

  const existing = await resolveSectionForAgent(trimmed);
  if (existing) return existing;

  const key = trimmed.toLowerCase();
  const inFlight = sectionCreatesInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = (async () => {
    // Force a cache refresh in case a parallel cron tick or another serverless
    // instance just created this section for the same agent.
    sectionsCache = null;
    const afterRefresh = await resolveSectionForAgent(trimmed);
    if (afterRefresh) return afterRefresh;
    return createSectionForAgent(trimmed);
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

async function createSectionForAgent(name: string): Promise<string | null> {
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
  severity: string;             // e.g. "Level 3"
  resolutionStatus: string | null;
  issueCategories: string[];    // collected from results[]
  summaryText: string;          // raw AI JSON / rendered summary
}

function buildTaskName(input: AsanaTaskInput): string {
  const who = input.playerName ?? 'Unknown player';
  const brand = input.brand ? ` · ${input.brand}` : '';
  const cat = input.issueCategories[0] ? ` — ${input.issueCategories[0]}` : '';
  const sevDigit = input.severity.match(/\d/)?.[0] ?? '?';
  // Asana caps task names at 1024 chars but anything past ~250 wraps badly in
  // list views — trim defensively.
  return `[Sev ${sevDigit}] ${who}${brand}${cat}`.slice(0, 250);
}

function buildTaskNotes(input: AsanaTaskInput): string {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
  const intercomAppId = process.env.NEXT_PUBLIC_INTERCOM_APP_ID ?? '';

  const lines: string[] = [];
  lines.push(`Severity: ${input.severity}`);
  if (input.resolutionStatus) lines.push(`Resolution: ${input.resolutionStatus}`);
  if (input.issueCategories.length > 0) {
    lines.push(`Categories: ${input.issueCategories.join(', ')}`);
  }
  lines.push('');
  lines.push(
    `Agent: ${input.agentName ?? 'Unknown'}${input.agentEmail ? ` <${input.agentEmail}>` : ''}`,
  );
  lines.push(
    `Player: ${input.playerName ?? 'Unknown'}${input.playerEmail ? ` <${input.playerEmail}>` : ''}`,
  );
  if (input.brand) lines.push(`Brand: ${input.brand}`);
  if (input.accountManager) lines.push(`Account Manager: ${input.accountManager}`);
  lines.push('');
  if (appUrl) {
    lines.push(`QA Tool: ${appUrl}/conversations/${input.conversationId}`);
  }
  if (input.intercomId && intercomAppId) {
    lines.push(
      `Intercom: https://app.intercom.com/a/apps/${intercomAppId}/conversations/${input.intercomId}`,
    );
  }
  lines.push('');
  lines.push('--- AI Analysis ---');
  lines.push(input.summaryText);
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
    const seen = new Set<string>();
    for (const r of parsed.results ?? []) {
      const c = String(r.category ?? '').trim();
      if (c && !seen.has(c)) { seen.add(c); issueCategories.push(c); }
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
      severity: 'Level 3',
      resolutionStatus: parsed.resolution_status,
      issueCategories,
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

  // Per-ticket routing: find or auto-create the column matching the agent.
  // ASANA_SECTION_GID is only used as a last-resort fallback when ensure
  // fails (rate limit / perms / no agent name).
  const ensuredSection = await ensureSectionForAgent(input.agentName);
  const sectionGid = ensuredSection ?? process.env.ASANA_SECTION_GID ?? null;
  if (!ensuredSection && input.agentName) {
    console.warn(`[asana] could not ensure section for agent: ${input.agentName}`);
  }

  // AM custom-field option (separate axis from the agent column). Resolved
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

  // Assignee: looked up via ASANA_AM_USER_MAP. When an AM has a mapped Asana
  // user GID, set it as assignee so they get a real "task assigned to you"
  // notification. Unmapped AMs leave assignee unset — ticket is still created.
  const assigneeGid = resolveAmAssignee(input.accountManager);

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
