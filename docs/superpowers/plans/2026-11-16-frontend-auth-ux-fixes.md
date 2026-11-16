# Frontend Auth UX Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the frontend auth UX — (1) `/login` always opens on Sign In with URL-driven tabs that survive client navigation; (2) one auth-aware header (Login vs Keys + Sign out) that updates without a reload; (3) migrate the keys page so a JWT-only session (no localStorage `user`/gateway key) works: it authenticates from `/v1/user/me`, loads provider keys, supports "Get New", and shares the header's sign-out.

**Architecture:** The login tab is **derived from the URL** (`useSearchParams`) — no `useState`, no setState-in-effect; tab buttons `router.replace` the URL. The header `<AuthNav/>` and the keys page both consume one `useSession()` hook that fetches `GET /v1/user/me`, refetches on pathname change, and branches on `err.status === 401`. The keys page keeps `useSyncExternalStore` only for the **gateway-key display**, not for auth.

**Tech Stack:** Next.js 16.4.6 (App Router, Turbopack), React 19, TypeScript, Tailwind. No frontend test runner — gate is `npx tsc --noEmit` + `npm run lint` + `npm run build` + browser E2E.

**Spec:** This file. **Depends on the JWT plan** (`docs/superpowers/plans/2026-11-16-jwt-authentication-migration.md`): `/v1/user/me` (JWT T5), the session cookie (JWT T4), `/v1/auth/logout` (JWT T6), and `api.ts` credentials + status errors + `/me` exemption (JWT T7). JWT T7 already makes `api.ts` cookie-aware; this plan consumes it.

## Global Constraints

- **No frontend test runner.** Gate: `cd frontend && npx tsc --noEmit` + `npm run lint` + `npm run build`, plus browser steps at `:3000` (API `:8081`).
- **Lint-clean:** `react-hooks/set-state-in-effect` is **error** in the installed eslint-config-next. Never call `setState` synchronously in an effect body. Set state only inside async `.then/.catch/.finally`, or derive from the URL / `useSyncExternalStore`.
- **No `.env` edits.** API base URL already reads `process.env.NEXT_PUBLIC_API_URL`.
- **Reuse the existing store pattern.** `keys/page.tsx` reads localStorage via `useSyncExternalStore` + a `gateway-storage-change` event — keep that for the gateway-key display only.
- **Do not rotate the gateway key on login.** Manual "Get New" is retained.

## Review Focus

- **Client nav from `/login?tab=register` to `/login`:** tab is derived from the URL, so bare `/login` always shows Sign In. (Task 1)
- **Header updates after login/logout without reload:** `useSession` refetches `/me` on pathname change. (Task 2)
- **`/me` 401 must not reload-loop:** `api.ts` (JWT T7) exempts `/user/me` from the 401 redirect; `useSession` clears `user` on `status === 401`. (Task 2)
- **JWT-only session on `/keys`:** provider keys load whenever the session exists; "Get New" uses the session username; page-level sign-out removed in favour of the header's. (Task 3)
- **Lint:** login tab has no state; `useSession` sets state only in async callbacks. (Tasks 1, 2)

---

## Pre-Execution Verification (do this BEFORE any task)

> **Do not re-implement what already works.** The committed fix (commit `3b60303`) already added the amber "Get New" banner and `suppressHydrationWarning`. This plan covers what is still missing.

**Step 0.1 — Baseline (read-only):** `git status --short --branch`, `git log --oneline -8`. Do not `reset`/`clean` a dirty tree; ask the human first.

**Step 0.2 — Gates green:** `cd frontend && npx tsc --noEmit && npm run lint` → both exit 0. If red, STOP.

**Step 0.3 — Per-task probes** (`rg`):

| Task | Already done if… | Probe |
|------|------------------|-------|
| 1 — URL login tab | `useSearchParams` + `router.replace`; no `typeof window` / no `useState` for `tab` | `rg -n "useSearchParams\|router.replace\|typeof window\|useState.*tab" frontend/src/app/login/page.tsx` |
| 2 — auth header + hook | `auth-nav.tsx` + `use-session.ts` exist; header uses `/user/me` | `ls frontend/src/components/auth-nav.tsx frontend/src/hooks/use-session.ts; rg -n "user/me\|AuthNav" frontend/src/app/layout.tsx` |
| 3 — keys page migrated | keys page uses `useSession` (not `localStorage.user`) and no page-level sign-out | `rg -n "useSession\|localStorage.getItem\('user'\)\|Sign out" frontend/src/app/keys/page.tsx` |

Mark `[x] SKIP — already implemented (verified <date>)` when a probe passes in the right place.

**Step 0.4 — Record the baseline.**

---

## File Structure

### New Files
- `frontend/src/hooks/use-session.ts` — `useSession()` (single owner).
- `frontend/src/components/auth-nav.tsx` — header.

### Modified Files
- `frontend/src/app/login/page.tsx` — URL-driven tab + `<Suspense>`.
- `frontend/src/app/layout.tsx` — render `<AuthNav/>`.
- `frontend/src/app/keys/page.tsx` — migrate auth to `useSession`; gateway key via store; unify sign-out.

---

### Task 1: `/login` — URL-driven tab, Sign In on bare `/login`

**Files:** modify `frontend/src/app/login/page.tsx`.

- [ ] **Step 1: Replace the `typeof window` initializer with URL-derived state**

Delete the `useState` initializer for `tab`; replace with:

```typescript
const searchParams = useSearchParams();
const router = useRouter();
const tab: 'signin' | 'register' =
  searchParams.get('tab') === 'register' ? 'register' : 'signin';
const setTab = (next: 'signin' | 'register') =>
  router.replace(next === 'register' ? '/login?tab=register' : '/login');
```

Keep the existing `setTab('signin'|'register')` call sites in the tab buttons — they now update the URL. Import `useSearchParams`, `useRouter` from `next/navigation`.

- [ ] **Step 2: Wrap in `<Suspense>` with a skeleton**

Rename the component to `LoginPageInner`; export:

```typescript
import { Suspense } from 'react';

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center px-4 py-20"><div className="h-9 w-72 animate-pulse rounded-xl bg-slate-800/60" /></div>}>
      <LoginPageInner />
    </Suspense>
  );
}
```

- [ ] **Step 3: Verify** — `cd frontend && npx tsc --noEmit && npm run lint && npm run build` → all exit 0.
- [ ] **Step 4: Manual** — `/login` → Sign In; `/login?tab=register` → Create Account; header "Login" → `/login` shows Sign In; no hydration error.

After a successful sign-in, clear any stale `gateway_api_key`/`gateway_key` left by a previous user's session (so `/keys` never shows someone else's key while `/me` names a different user). Do **not** rotate the server key — just drop the stale localStorage copy before writing the new session.
- [ ] **Step 5: Commit** — `git add frontend/src/app/login/page.tsx && git commit -m "fix(frontend): URL-driven login tab, default sign-in"`.

---

### Task 2: Auth-aware header + `useSession` hook

**Files:** create `frontend/src/hooks/use-session.ts`, `frontend/src/components/auth-nav.tsx`; modify `frontend/src/app/layout.tsx`.

**Interfaces:** `useSession(): { user: {id,username,email}|null, loading, error }`; `<AuthNav/>` renders Login / Keys+Sign out.

- [ ] **Step 1: `frontend/src/hooks/use-session.ts`** (no synchronous setState; status-based 401)

```typescript
'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { api } from '@/lib/api';

export interface SessionUser { id: string; username: string; email: string }

export function useSession() {
  const pathname = usePathname();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // No synchronous setState here — only inside async callbacks (react-hooks/set-state-in-effect).
    api
      .get<SessionUser>('/user/me')
      .then((u) => { if (alive) { setUser(u); setError(null); } })
      .catch((e: unknown) => {
        if (!alive) return;
        const status = (e as { status?: number })?.status;
        if (status === 401) { setUser(null); setError(null); }
        else setError(e instanceof Error ? e.message : 'Could not reach the server');
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [pathname]);

  return { user, loading, error };
}
```

- [ ] **Step 2: `frontend/src/components/auth-nav.tsx`** (sign-out awaits logout; redirects only on success)

```typescript
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useSession } from '../hooks/use-session';

export function AuthNav() {
  const { user, loading } = useSession();
  const router = useRouter();

  if (loading) return <nav className="flex items-center gap-4 text-sm text-slate-300" />;

  if (!user) {
    return (
      <nav className="flex items-center gap-4 text-sm text-slate-300">
        <Link href="/login" className="hover:text-slate-100">Login</Link>
      </nav>
    );
  }

  return (
    <nav className="flex items-center gap-4 text-sm text-slate-300">
      <Link href="/keys" className="hover:text-slate-100">Keys</Link>
      <button
        type="button"
        onClick={async () => {
          try {
            await api.post('/auth/logout'); // must succeed before we clear/redirect
          } catch {
            return; // keep the session; surface via a toast/error if desired
          }
          try {
            localStorage.removeItem('gateway_api_key');
            localStorage.removeItem('gateway_key');
            localStorage.removeItem('user');
          } catch { /* ignore */ }
          router.push('/login');
          router.refresh();
        }}
        className="hover:text-slate-100"
      >
        Sign out
      </button>
    </nav>
  );
}
```

- [ ] **Step 3: `layout.tsx`** — import `AuthNav`; replace the two static `<nav>` `<Link>`s with `<AuthNav />`.
- [ ] **Step 4: Verify** — `cd frontend && npx tsc --noEmit && npm run lint && npm run build` → all exit 0.
- [ ] **Step 5: Manual** — logged out → header Login; login → header Keys + Sign out; Sign out → cookie cleared, header Login.
- [ ] **Step 6: Commit** — `git add frontend/src/hooks/use-session.ts frontend/src/components/auth-nav.tsx frontend/src/app/layout.tsx && git commit -m "feat(frontend): auth-aware header on /user/me"`.

---

### Task 3: Migrate the keys page to `useSession`

**Files:** modify `frontend/src/app/keys/page.tsx`.

**Goal:** a JWT-only session (no localStorage `user`, no `gateway_api_key`) must: stay on `/keys`, load provider keys, allow "Get New" (using the session username), and use the header's sign-out (remove the page-level one).

- [ ] **Step 1: Replace localStorage `user` with `useSession`**

Add `import { useSession } from '@/hooks/use-session';`. Replace the localStorage-derived `user` (currently from `readSessionSnapshot`) with `const { user, loading: sessionLoading } = useSession();`. Keep `useSyncExternalStore` **only** for `gatewayKey` (the key display), not for auth.

- [ ] **Step 2: Fix the redirect gate**

Replace the current `useEffect` gate (`if (!gatewayKey) { if (!user) router.push('/login'); return; }`) with: redirect to `/login` only when the session has resolved and there is no user:

```typescript
useEffect(() => {
  if (sessionLoading || sessionError) return;   // still checking /me, or /me errored
  if (!user) { router.push('/login'); return; }
}, [sessionLoading, sessionError, user, router]);
```
Render `sessionError` instead of redirecting on a 5xx.

- [ ] **Step 3: Load provider keys whenever the session exists**

Change the provider-key fetch to depend on `user` (session), not on `gatewayKey`. `GET /v1/user/keys` is JWT-authorized (JWT T5/T7), so a JWT-only session loads keys.

- [ ] **Step 4: "Get New" uses the session username**

Replace `user?.username` from localStorage with the session username. `user` is `SessionUser | null`, so destructure safely:

```typescript
const username = user?.username;   // user may be null here — guard already in place
```

Remove the "Username not found" path when a session user exists.

- [ ] **Step 5: Remove the page-level sign-out; unify with the header**

Delete the page's own "Sign out" button/handler (lines that only call `localStorage.clear()`). Sign-out is the header's `AuthNav` (which calls `/auth/logout`). If a page-level control is still wanted, make it call the same `/auth/logout` flow, not `localStorage.clear()`.

- [ ] **Step 6: Enable provider-key actions for any session**

Change the disabled conditions on provider-key actions (currently gated on `!gatewayKey`) to gate on `!user` (session) instead — a JWT-only session can add/delete provider keys. Also change `loadingKeys && gatewayKey` to `loadingKeys` alone so the loading state is not hidden for JWT-only sessions. Do **not** add a synchronous `setLoadingKeys(true)` at the top of the fetch effect — that's the same `react-hooks/set-state-in-effect` error; keep the existing `.finally` pattern.

- [ ] **Step 7: Verify** — `cd frontend && npx tsc --noEmit && npm run lint && npm run build` → all exit 0.
- [ ] **Step 8: Manual (JWT-only session)** — log in, clear `localStorage` (`user`/`gateway_key`), refresh `/keys` → page stays, provider keys load, "Get New" works (no "Username not found"), header shows Keys + Sign out.
- [ ] **Step 9: Commit** — `git add frontend/src/app/keys/page.tsx && git commit -m "feat(frontend): migrate keys page to /user/me session (JWT-only support)"`.

---

### Task 4: Full verification + browser E2E

**Files:** all of the above.

- [ ] **Step 1: Gates** — `cd frontend && npx tsc --noEmit && npm run lint && npm run build` → all exit 0. Backend `npm run verify` → `fail 0`.
- [ ] **Step 2: Browser E2E** (`:3000`, API `:8081`):
  1. Logged out → header Login; `/login` Sign In.
  2. Register → cookie, `/keys`, header Keys + Sign out.
  3. Refresh → still logged in (cookie), provider keys load.
  4. Clear `localStorage` → still logged in (JWT); "Get New" works.
  5. Sign out → cookie cleared, header Login, `/login` reachable.
  6. `/login?tab=register` → Create Account; header Login → `/login` shows Sign In.
- [ ] **Step 3: Commit** (only if fixups remain) — stage **explicit paths** after `git status --short` (never `git add -A`).

---

## Self-Review

**1. Spec coverage:** login-defaults-to-signin + URL tabs (T1), single header toggle (T2), keys-page JWT migration (T3), consolidated sign-out (T2/T3), status-based 401 (T2), no sync setState (T1/T2), single hook owner (T2; JWT plan no longer creates it). ✓

**2. Step scan:** one action per step; frontend uses build/lint/tsc + browser steps (no unit runner). ✓

**3. Type consistency:** `useSession()` shape consumed by `AuthNav` (T2) and keys page (T3); `api` errors carry `status` (from JWT T7). ✓

**4. Review Focus:** stale-tab (T1), header-updates (T2), `/me` no-loop (JWT T7 + T2), JWT-only keys page (T3), lint (T1/T2). ✓

**5. Proportion:** proportional; code blocks are the hook/component/page-diffs the implementer cannot guess. ✓

## Open Questions

1. **Landing order:** JWT plan first (needs `/user/me`, cookie, logout, `api.ts` status errors), then this plan.
2. **Sign-out failure UX:** on `/auth/logout` failure the header keeps the session (no redirect) — a toast/error surface is a follow-up.