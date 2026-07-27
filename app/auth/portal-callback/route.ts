// Cross-dashboard SSO landing point.
//
// The central portal (a separate app) signs a short-lived JWT asserting the
// user's email and sends them here. We verify that assertion against the
// portal's JWKS, find-or-create the matching `app_users` row, and then mint a
// NORMAL session for this app — the same HMAC-signed `qa_auth` cookie that
// POST /api/auth/login issues. Nothing downstream can tell an SSO session from
// a password one.
//
// NOTE ON STACK: this app does NOT use Supabase Auth. Supabase is the database
// only (see lib/supabase.ts); identity lives in the `app_users` table and the
// session is the qa_auth cookie (see lib/auth.ts + middleware.ts). The
// @supabase/ssr cookie recipe the portal ships with does not apply here — it
// would set cookies our middleware never reads, and the user would bounce
// straight back to /login.
//
// This path is in the middleware's public-path bypass; it has to be reachable
// while logged out.

import { NextResponse, type NextRequest } from 'next/server';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { randomBytes } from 'node:crypto';
import { AUTH_COOKIE, SESSION_TTL_MS, signToken } from '@/lib/auth';
import { dbCreateUser, dbFindUserByEmail, dbUsernameExists, dbApproveUser } from '@/lib/usersDb';
import { hashPassword } from '@/lib/password';
import { defaultSnapshotForTeam, isTeam, roleForTeam } from '@/lib/users';
import type { AppUser } from '@/lib/users';

export const runtime = 'nodejs';

// Team assigned to a brand-new SSO user. The portal asserts an email and
// nothing else, so it cannot tell us which team someone is on — an admin
// retunes it afterwards in /admin/users. Management is refused on purpose:
// role is derived from team (roleForTeam), so defaulting there would hand every
// SSO arrival Prompt-Library admin rights.
const FALLBACK_TEAM = 'NON-VIP';

function ssoDefaultTeam(): string {
  const configured = process.env.SSO_DEFAULT_TEAM?.trim();
  if (configured && isTeam(configured) && configured !== 'Management') return configured;
  if (configured) {
    console.error(`[sso] ignoring SSO_DEFAULT_TEAM="${configured}" (unknown team, or Management)`);
  }
  return FALLBACK_TEAM;
}

// createRemoteJWKSet caches the fetched keys internally, so build it once per
// lambda rather than per request.
let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksCacheUrl = '';
function getJwks(url: string) {
  if (!jwksCache || jwksCacheUrl !== url) {
    jwksCache = createRemoteJWKSet(new URL(url));
    jwksCacheUrl = url;
  }
  return jwksCache;
}

function fail(req: NextRequest, code: string) {
  return NextResponse.redirect(new URL(`/login?error=${code}`, req.url));
}

// Derive a login username from the email local part. app_users has a unique
// index on lower(username), so probe for a free one — an SSO user whose
// preferred name is taken becomes `jose-2`, etc.
async function pickUsername(email: string): Promise<string | null> {
  const local = email.split('@')[0] ?? '';
  const cleaned = local.toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const base = cleaned.length >= 2 ? cleaned.slice(0, 40) : `user-${randomBytes(3).toString('hex')}`;

  for (let n = 1; n <= 20; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!(await dbUsernameExists(candidate))) return candidate;
  }
  // 20 collisions is pathological; fall back to something that cannot collide.
  const random = `${base}-${randomBytes(4).toString('hex')}`;
  return (await dbUsernameExists(random)) ? null : random;
}

export async function GET(req: NextRequest) {
  // Fail closed on config. jose treats an undefined `issuer`/`audience` as "no
  // constraint" and SKIPS that check, which would let a token minted for a
  // DIFFERENT dashboard log someone in here — so a missing env var must stop
  // the flow, never soften it.
  const jwksUrl = process.env.PORTAL_JWKS_URL;
  const issuer = process.env.PORTAL_ISSUER;
  const audience = process.env.SSO_AUDIENCE;
  const secret = process.env.AUTH_SECRET;
  if (!jwksUrl || !issuer || !audience || !secret) {
    console.error('[sso] missing PORTAL_JWKS_URL / PORTAL_ISSUER / SSO_AUDIENCE / AUTH_SECRET');
    return fail(req, 'sso_config');
  }

  const token = req.nextUrl.searchParams.get('token');
  if (!token) return NextResponse.redirect(new URL('/login', req.url));

  // ── 1) Verify the portal's assertion (signature + issuer + audience + expiry) ──
  let email: string;
  try {
    const { payload } = await jwtVerify(token, getJwks(jwksUrl), { issuer, audience });
    // typeof, not String(...): String(undefined) === "undefined" is truthy and
    // would silently defeat this guard.
    if (typeof payload.email !== 'string' || payload.email.trim().length === 0) {
      throw new Error('no email claim');
    }
    email = payload.email.trim();
  } catch (e) {
    console.error('[sso] token verification failed:', e instanceof Error ? e.message : String(e));
    return fail(req, 'sso');
  }

  // ── 2) Find or JIT-provision the app_users row ──
  let user: AppUser | null;
  try {
    user = await dbFindUserByEmail(email);
  } catch (e) {
    console.error('[sso] lookup failed:', e instanceof Error ? e.message : String(e));
    return fail(req, 'provision');
  }

  if (!user) {
    const team = ssoDefaultTeam();
    const username = await pickUsername(email);
    if (!username) {
      console.error(`[sso] could not derive a free username for ${email}`);
      return fail(req, 'provision');
    }
    try {
      // No password is ever issued for an SSO account: the hash is over random
      // bytes nobody holds, so /api/auth/login can never authenticate this row.
      // An admin can still set a real password later via the reset action.
      user = await dbCreateUser({
        username,
        email,
        passwordHash: hashPassword(randomBytes(32).toString('hex')),
        team,
        role: roleForTeam(team),
        status: 'approved', // see step 2b below — portal assignment IS the approval
        snapshot: defaultSnapshotForTeam(team),
        approvedBy: 'portal-sso',
      });
    } catch (e) {
      console.error('[sso] provisioning failed:', e instanceof Error ? e.message : String(e));
      return fail(req, 'provision');
    }
  }

  // ── 2b) Access gate: this app gates on app_users.status, so a verified token
  // must not dead-end at "awaiting admin approval". A user only ever gets a
  // token for this dashboard because a portal admin explicitly assigned it, so
  // a pending row is auto-approved here.
  //
  // 'rejected' and 'disabled' are NOT resurrected: those are deliberate local
  // revocations by an admin of THIS app, and the portal has no way to know
  // about them. Re-enabling silently would turn SSO into a way around a
  // revocation. Such a user is sent back with error=access and the local admin
  // (or the portal admin, by unassigning the card) resolves it.
  if (user.status === 'pending') {
    const team = isTeam(user.team) ? user.team : ssoDefaultTeam();
    try {
      await dbApproveUser(user.id, team, roleForTeam(team), defaultSnapshotForTeam(team), 'portal-sso');
      user = { ...user, status: 'approved', team, role: roleForTeam(team) };
    } catch (e) {
      console.error('[sso] auto-approve failed:', e instanceof Error ? e.message : String(e));
      return fail(req, 'access');
    }
  } else if (user.status !== 'approved') {
    console.error(`[sso] refusing ${user.status} account for ${email}`);
    return fail(req, 'access');
  }

  // ── 3) Mint this app's own session cookie (identical to the login route's) ──
  const expiryMs = Date.now() + SESSION_TTL_MS;
  const sessionToken = await signToken(secret, {
    username: user.username,
    role: user.role,
    expiryMs,
  });

  // Redirect to / — this also drops the ?token= from the address bar.
  const res = NextResponse.redirect(new URL('/', req.url));
  res.cookies.set({
    name: AUTH_COOKIE,
    value: sessionToken,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return res;
}
