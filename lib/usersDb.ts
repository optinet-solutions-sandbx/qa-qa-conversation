// Supabase-backed access to the app_users roster. Server-only (nodejs runtime)
// — imports the service-role Supabase client. The edge middleware must NOT
// import this; it verifies the signed cookie via lib/auth.ts and never touches
// the DB.
//
// Schema: see sql/app_users.sql. Roles are derived from team via
// roleForTeam() at write time and stored, so reads don't recompute.

import { supabase } from './supabase';
import type { AppUser, Role, UserStatus } from './users';

const TABLE = 'app_users';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapUser(r: Record<string, any>): AppUser {
  return {
    id: r.id,
    username: r.username,
    role: r.role,
    email: r.email,
    team: r.team,
    status: r.status,
    snapshot: !!r.snapshot,
    createdAt: r.created_at,
    approvedAt: r.approved_at ?? null,
    approvedBy: r.approved_by ?? null,
  };
}

// What the login route needs: identity + role + status + the hash to verify
// against. Kept separate from AppUser so the password hash never leaks into
// the admin list payload.
export interface AuthUser {
  id: string;
  username: string;
  role: Role;
  status: UserStatus;
  passwordHash: string;
}

// Case-insensitive username lookup for the login path. Returns null if the
// username doesn't exist.
export async function dbFindAuthUser(username: string): Promise<AuthUser | null> {
  const key = username.trim().toLowerCase();
  if (!key) return null;
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, username, role, status, password_hash')
    .ilike('username', key)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[usersDb] findAuthUser:', error.message);
    return null;
  }
  if (!data) return null;
  return {
    id: data.id,
    username: data.username,
    role: data.role,
    status: data.status,
    passwordHash: data.password_hash,
  };
}

// Email lookup for the portal SSO callback — the portal asserts an email, not a
// username. Unlike username there is no unique index on email, so if two rows
// share one we take the oldest (the original account) to stay deterministic
// across logins rather than flip-flopping between duplicates.
export async function dbFindUserByEmail(email: string): Promise<AppUser | null> {
  const key = email.trim().toLowerCase();
  if (!key) return null;
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, username, email, team, role, status, snapshot, created_at, approved_at, approved_by')
    .ilike('email', key)
    .order('created_at', { ascending: true });
  if (error) {
    console.error('[usersDb] findUserByEmail:', error.message);
    return null;
  }
  // ILIKE treats `_` (legal in an email local part) as a single-char wildcard,
  // so the query can only ever return a SUPERSET of the real matches — re-filter
  // on exact equality here rather than trusting the first row back.
  const exact = (data ?? []).find((r) => (r.email ?? '').toLowerCase() === key);
  return exact ? mapUser(exact) : null;
}

// True if a username is already taken (case-insensitive). Used by registration
// + seed to avoid duplicate rows that the unique index would otherwise reject.
export async function dbUsernameExists(username: string): Promise<boolean> {
  const key = username.trim().toLowerCase();
  const { data, error } = await supabase
    .from(TABLE)
    .select('id')
    .ilike('username', key)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[usersDb] usernameExists:', error.message);
    // Fail safe: treat as taken so we don't create a duplicate on a transient error.
    return true;
  }
  return !!data;
}

// Lowercased set of every taken username, fetched in a single query. For
// bulk paths (the seed import) that would otherwise do one round trip per
// candidate.
export async function dbExistingUsernamesLower(): Promise<Set<string>> {
  const { data, error } = await supabase.from(TABLE).select('username');
  if (error) {
    console.error('[usersDb] existingUsernames:', error.message);
    // Fail safe: pretend everything exists so a bulk import skips rather than
    // risks duplicates on a transient error.
    throw new Error(`[usersDb] existingUsernames: ${error.message}`);
  }
  return new Set((data ?? []).map((r) => r.username.toLowerCase()));
}

export interface NewUser {
  username: string;
  email: string;
  passwordHash: string;
  team: string;
  role: Role;
  status: UserStatus;
  snapshot: boolean;
  approvedBy?: string | null;
}

// Inserts a user row. Throws on DB error (callers surface a 4xx/5xx). The
// approvedAt timestamp is set when the row is created already-approved (seed).
export async function dbCreateUser(u: NewUser): Promise<AppUser> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      username: u.username,
      email: u.email,
      password_hash: u.passwordHash,
      team: u.team,
      role: u.role,
      status: u.status,
      snapshot: u.snapshot,
      approved_at: u.status === 'approved' ? now : null,
      approved_by: u.status === 'approved' ? (u.approvedBy ?? null) : null,
    })
    .select('*')
    .single();
  if (error) throw new Error(`[usersDb] createUser: ${error.message}`);
  return mapUser(data);
}

// Full roster for the admin management page, newest first.
export async function dbListUsers(): Promise<AppUser[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, username, email, team, role, status, snapshot, created_at, approved_at, approved_by')
    .order('created_at', { ascending: false });
  if (error) {
    console.error('[usersDb] listUsers:', error.message);
    return [];
  }
  return (data ?? []).map(mapUser);
}

// Shared row patcher for the single-user admin mutations below — stamps
// updated_at and throws a labelled error so each caller stays a one-liner.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function patchUser(id: string, patch: Record<string, any>, label: string): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`[usersDb] ${label}: ${error.message}`);
}

// Approve a pending user, assigning the team (which also fixes the derived
// role). Records who approved and when.
export function dbApproveUser(
  id: string,
  team: string,
  role: Role,
  snapshot: boolean,
  approvedBy: string,
): Promise<void> {
  return patchUser(
    id,
    { status: 'approved', team, role, snapshot, approved_at: new Date().toISOString(), approved_by: approvedBy },
    'approveUser',
  );
}

export function dbSetUserStatus(id: string, status: UserStatus): Promise<void> {
  return patchUser(id, { status }, 'setUserStatus');
}

// Change an approved user's team — re-derives and stores the role too.
export function dbUpdateUserTeam(id: string, team: string, role: Role): Promise<void> {
  return patchUser(id, { team, role }, 'updateUserTeam');
}

export function dbSetUserSnapshot(id: string, snapshot: boolean): Promise<void> {
  return patchUser(id, { snapshot }, 'setUserSnapshot');
}

// Admin-initiated password reset: store a freshly hashed password.
export function dbSetUserPassword(id: string, passwordHash: string): Promise<void> {
  return patchUser(id, { password_hash: passwordHash }, 'setUserPassword');
}

export async function dbDeleteUser(id: string): Promise<void> {
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) throw new Error(`[usersDb] deleteUser: ${error.message}`);
}

// Emails of approved users flagged to receive the Daily Snapshot email.
// Replaces the old synchronous getSnapshotRecipients() that read the hardcoded
// roster — now async because it queries the DB.
export async function getSnapshotRecipients(): Promise<string[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('email')
    .eq('status', 'approved')
    .eq('snapshot', true);
  if (error) {
    console.error('[usersDb] getSnapshotRecipients:', error.message);
    return [];
  }
  return (data ?? []).map((r) => r.email).filter(Boolean);
}
