'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Orbitron } from 'next/font/google';
import { TEAMS } from '@/lib/users';

// Self-hosted at build time by next/font — no runtime network call.
const orbitron = Orbitron({ subsets: ['latin'], weight: ['500', '700'] });

function SunIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="4" />
      <path strokeLinecap="round" d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  );
}

// Why the portal SSO callback bounced someone back here, keyed by the ?error=
// code it redirects with (see app/auth/portal-callback/route.ts). Without this
// a failed SSO hand-off would render as a blank login form with no explanation.
const SSO_ERRORS: Record<string, string> = {
  sso: 'Single sign-on failed — that portal link is invalid or has expired. Try again from the portal.',
  sso_config: 'Single sign-on is not configured on this dashboard. Contact an admin.',
  provision: 'Could not set up your account. Contact an admin.',
  access: 'Your account is not active on this dashboard. Contact an admin.',
};

function LoginForm() {
  const router = useRouter();
  const sp = useSearchParams();
  const nextPath = sp.get('next') || '/';

  // Theme is local to /login and ephemeral on purpose — the rest of the app has
  // its own theme system (qa_theme localStorage), and conflating the two would
  // surprise authenticated users.
  const [isDark, setIsDark] = useState(false);

  // 'login' is the default; 'register' is the self-service sign-up form. New
  // accounts land in a 'pending' state an admin must approve, so registering
  // shows a confirmation rather than logging the user straight in.
  const [mode, setMode] = useState<'login' | 'register'>('login');

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [team, setTeam] = useState('');
  const [error, setError] = useState<string | null>(() => SSO_ERRORS[sp.get('error') ?? ''] ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function switchMode(next: 'login' | 'register') {
    setMode(next);
    setError(null);
    setNotice(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);

    if (mode === 'register') {
      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, email, password, team }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data?.error || 'Could not create account.');
          setSubmitting(false);
          return;
        }
        // Success: drop back to the login form with a pending-approval notice.
        setMode('login');
        setPassword('');
        setNotice('Account created. An admin must approve it before you can sign in.');
        setSubmitting(false);
      } catch {
        setError('Network error.');
        setSubmitting(false);
      }
      return;
    }

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        // 403 carries a specific reason (pending/rejected/disabled); 401 is a
        // plain credential failure.
        if (res.status === 403) {
          const data = await res.json().catch(() => ({}));
          setError(data?.error || 'Your account is not active.');
        } else {
          setError(res.status === 401 ? 'Wrong username or password.' : 'Login failed.');
        }
        setSubmitting(false);
        return;
      }
      router.replace(nextPath.startsWith('/') ? nextPath : '/');
    } catch {
      setError('Network error.');
      setSubmitting(false);
    }
  }

  const isRegister = mode === 'register';
  const canSubmit = isRegister
    ? !!username && !!password && !!email && !!team
    : !!username && !!password;

  return (
    <div className={isDark ? 'dark' : ''}>
      <div className="min-h-screen w-full flex items-center justify-center px-4 relative overflow-hidden bg-slate-50 dark:bg-[#0a0b1e] transition-colors">
        {/* Ambient radial glow */}
        <div
          className="pointer-events-none absolute inset-0 dark:hidden"
          style={{
            background:
              'radial-gradient(ellipse 60% 50% at 50% 50%, rgba(96, 165, 250, 0.18), rgba(232, 121, 249, 0.12) 50%, transparent 75%)',
          }}
        />
        <div
          className="pointer-events-none absolute inset-0 hidden dark:block"
          style={{
            background:
              'radial-gradient(ellipse 60% 50% at 50% 50%, rgba(99, 102, 241, 0.18), transparent 70%)',
          }}
        />
        {/* Subtle grid texture */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.05] dark:opacity-[0.04]"
          style={{
            backgroundImage:
              'linear-gradient(currentColor 1px, transparent 1px), linear-gradient(90deg, currentColor 1px, transparent 1px)',
            backgroundSize: '48px 48px',
            color: 'rgb(15 23 42)',
          }}
        />

        {/* Theme toggle — top right */}
        <button
          type="button"
          onClick={() => setIsDark((v) => !v)}
          aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          className="absolute top-4 right-4 z-10 inline-flex items-center justify-center w-9 h-9 rounded-full border border-slate-300/70 bg-white/80 text-slate-600 hover:text-slate-900 hover:bg-white shadow-sm transition dark:border-white/15 dark:bg-white/[0.06] dark:text-slate-300 dark:hover:text-white dark:hover:bg-white/10"
        >
          {isDark ? <SunIcon /> : <MoonIcon />}
        </button>

        <div className="relative w-full max-w-4xl">
          {/* Outer neon glow */}
          <div className="absolute -inset-[2px] rounded-3xl blur-xl bg-gradient-to-r from-cyan-300/40 via-sky-300/30 to-fuchsia-300/40 dark:from-cyan-400/40 dark:via-blue-500/30 dark:to-fuchsia-500/40" />
          <div className="absolute -inset-[1px] rounded-2xl bg-gradient-to-r from-cyan-400/50 via-sky-400/30 to-fuchsia-400/50 dark:from-cyan-400/60 dark:via-blue-500/40 dark:to-fuchsia-500/60" />

          <div className="relative grid md:grid-cols-2 rounded-2xl overflow-hidden backdrop-blur-xl bg-white/85 dark:bg-slate-950/70 transition-colors">
            {/* Left: form */}
            <form onSubmit={onSubmit} className="p-8 md:p-10 flex flex-col justify-center">
              <h1
                className={`${orbitron.className} text-2xl md:text-3xl tracking-wider mb-8 text-slate-900 dark:text-white`}
              >
                {isRegister ? 'Create Account' : 'Welcome Back'}
              </h1>

              <div className="space-y-3">
                <input
                  id="user"
                  type="text"
                  placeholder="Username"
                  autoComplete="username"
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full rounded-lg px-4 py-3 text-sm transition focus:outline-none focus:ring-2
                    bg-white border border-slate-200 text-slate-900 placeholder:text-slate-400
                    focus:border-sky-400 focus:ring-sky-400/20
                    dark:bg-white/[0.06] dark:border-white/10 dark:text-white dark:placeholder:text-slate-400
                    dark:focus:border-cyan-400/60 dark:focus:bg-white/[0.09] dark:focus:ring-cyan-400/20"
                />
                {isRegister && (
                  <input
                    id="email"
                    type="email"
                    placeholder="Email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-lg px-4 py-3 text-sm transition focus:outline-none focus:ring-2
                      bg-white border border-slate-200 text-slate-900 placeholder:text-slate-400
                      focus:border-sky-400 focus:ring-sky-400/20
                      dark:bg-white/[0.06] dark:border-white/10 dark:text-white dark:placeholder:text-slate-400
                      dark:focus:border-cyan-400/60 dark:focus:bg-white/[0.09] dark:focus:ring-cyan-400/20"
                  />
                )}
                <input
                  id="pw"
                  type="password"
                  placeholder="Password"
                  autoComplete={isRegister ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg px-4 py-3 text-sm transition focus:outline-none focus:ring-2
                    bg-white border border-slate-200 text-slate-900 placeholder:text-slate-400
                    focus:border-sky-400 focus:ring-sky-400/20
                    dark:bg-white/[0.06] dark:border-white/10 dark:text-white dark:placeholder:text-slate-400
                    dark:focus:border-cyan-400/60 dark:focus:bg-white/[0.09] dark:focus:ring-cyan-400/20"
                />
                {isRegister && (
                  <select
                    id="team"
                    value={team}
                    onChange={(e) => setTeam(e.target.value)}
                    className="w-full rounded-lg px-4 py-3 text-sm transition focus:outline-none focus:ring-2
                      bg-white border border-slate-200 text-slate-900
                      focus:border-sky-400 focus:ring-sky-400/20
                      dark:bg-white/[0.06] dark:border-white/10 dark:text-white
                      dark:focus:border-cyan-400/60 dark:focus:bg-white/[0.09] dark:focus:ring-cyan-400/20"
                  >
                    <option value="" disabled>
                      Select your team…
                    </option>
                    {TEAMS.map((t) => (
                      <option key={t} value={t} className="text-slate-900">
                        {t}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {error && (
                <p className="mt-3 text-sm text-rose-600 dark:text-rose-300">{error}</p>
              )}
              {notice && (
                <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-300">{notice}</p>
              )}

              <button
                type="submit"
                disabled={submitting || !canSubmit}
                className={`${orbitron.className} mt-5 w-full py-3 rounded-lg font-bold tracking-widest text-slate-900 bg-gradient-to-r from-cyan-400 via-sky-400 to-fuchsia-400 hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-sky-400/20 dark:shadow-fuchsia-500/20 transition`}
              >
                {submitting
                  ? isRegister
                    ? 'CREATING…'
                    : 'SIGNING IN…'
                  : isRegister
                    ? 'CREATE ACCOUNT'
                    : 'LOGIN'}
              </button>

              <p className="mt-5 text-sm text-center text-slate-500 dark:text-slate-400">
                {isRegister ? (
                  <>
                    Already have an account?{' '}
                    <button
                      type="button"
                      onClick={() => switchMode('login')}
                      className="font-semibold text-sky-600 hover:text-sky-500 dark:text-cyan-300 dark:hover:text-cyan-200"
                    >
                      Sign in
                    </button>
                  </>
                ) : (
                  <>
                    Need an account?{' '}
                    <button
                      type="button"
                      onClick={() => switchMode('register')}
                      className="font-semibold text-sky-600 hover:text-sky-500 dark:text-cyan-300 dark:hover:text-cyan-200"
                    >
                      Create one
                    </button>
                  </>
                )}
              </p>
            </form>

            {/* Right: brand panel */}
            <div className="hidden md:flex flex-col justify-center p-10 border-l relative
              bg-gradient-to-br from-sky-50 via-white to-fuchsia-50 border-slate-200/60
              dark:bg-gradient-to-br dark:from-slate-800/40 dark:via-slate-900/40 dark:to-slate-950/60 dark:border-white/5">
              <h2
                className={`${orbitron.className} text-3xl lg:text-4xl leading-[1.1] tracking-wide text-slate-900 dark:text-white`}
              >
                AI Chat
                <br />
                QA Tool
              </h2>
              <p className="mt-4 text-sm leading-relaxed max-w-xs text-slate-600 dark:text-slate-300/90">
                Sign in to access conversation analysis, dashboards, and the
                escalation pipeline.
              </p>
              <div className="mt-6 inline-flex items-center gap-2 text-xs uppercase tracking-[0.2em] rounded-full px-4 py-1.5 w-fit
                border border-sky-400/50 text-sky-600
                dark:border-cyan-400/40 dark:text-cyan-300/80">
                <span className="w-1.5 h-1.5 rounded-full bg-sky-500 shadow-[0_0_8px_2px_rgba(56,189,248,0.6)] dark:bg-cyan-400 dark:shadow-[0_0_8px_2px_rgba(34,211,238,0.7)]" />
                Internal Access
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
