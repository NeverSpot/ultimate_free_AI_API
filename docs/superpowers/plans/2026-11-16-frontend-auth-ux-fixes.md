# Frontend Auth UX Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three frontend auth-UX defects — (1) login auto-returns a usable gateway key, (2) `/login` always opens on Sign In, and (3) the header shows one auth-aware toggle button instead of two static links.

**Architecture:** The backend login route regenerates and returns a `gateway_api_key` (the stored key is a SHA-256 hash and cannot be re-displayed, so login rotates it). The frontend stores that key on login, reads auth state from `localStorage.user`, drives a single header `<AuthNav/>` client component, and derives the login tab from the URL reactively via `useSearchParams` (wrapped in `<Suspense>`).

**Tech Stack:** Next.js 16.4.6 (App Router, Turbopack), React 19, TypeScript, Fastify, Node `crypto`, Vitest (backend only)

**Spec:** Companion to `docs/superpowers/plans/2026-11-16-jwt-authentication-migration.md`. This plan is independently shippable on the current localStorage-user auth model and remains compatible with JWT once that plan lands.

## Global Constraints

- No test runner exists in `frontend/` — the automated gate for frontend tasks is `npm run build` (exit 0) + `npm run lint` (exit 0) run from `frontend/`. Behaviour is verified manually in the browser at `http://localhost:3000`.
- The backend change (Task 1) uses the existing Vitest harness at repo root — `npm test -- <file>`.
- `users.gateway_api_key_hash` stores `sha256Hex(plaintext)`; the plaintext is unrecoverable. Regenerating on login is the only way to hand the client a working key without a schema change.
- British/Indian English in user-facing copy; preserve existing Tailwind class conventions (slate palette).
- Do not touch `.env` values. Do not commit secrets.

## Review Focus

- **Client-side nav from `/login?tab=register` to `/login`:** must land on Sign In, not retain the previous Create Account tab. (Task 2)
- **Logged-in user visits `/login`:** must not be able to create a duplicate account by accident; header must show Keys/Sign out, not Login. (Task 3)
- **Login on a second device/browser:** user has no stored key; after login the Keys page must show the key immediately without a manual "Get New". (Tasks 1 + 4)
- **Old gateway key invalidation:** rotating the key on login invalidates any key the user pasted into their own apps; this is a known, documented tradeoff. (Task 1)
- **`useSearchParams` without Suspense:** Next 16 throws a build error / CSR bailout if unguarded — the page must wrap the consumer in `<Suspense>`. (Task 2)

---

## Pre-Execution Verification (do this BEFORE any task)

> **Do not re-implement what already works.** A separate change has already fixed the *login-redirect symptom* (a logged-in user with no stored key now stays on `/keys` behind an amber "Get New" banner) and silenced the hydration error (`suppressHydrationWarning` on `<html>`). That is **not** the same as the four tasks below — verify each one first.

**Step 0.1 — Baseline (read-only):**

```bash
git status --short --branch
git log --oneline -8
```

Do not `reset` or `clean` a dirty tree. Ask the human which uncommitted changes are intentional before touching anything.

**Step 0.2 — Backend must be green before you start:**

```bash
npm run verify
```

Expected: `fail 0`, exit 0. If it is already red, STOP — you would be fixing a broken baseline, not adding a feature. Report the failures first.

**Step 0.3 — Per-task "already done?" probes.** Run each probe and READ the output; a match in the right place = skip that task.

| Task | Already done if… | Probe |
|------|------------------|-------|
| 1 — login returns gateway key | the `/v1/auth/login` success reply includes `gateway_api_key` (register + regenerate already have one — ignore those) | `grep -n -A2 "v1/auth/login" src/http/routes/auth.ts` |
| 2 — `/login` defaults to Sign In, no hydration | login page reads the tab from `useSearchParams` and has no `typeof window` initializer | `grep -n "useSearchParams\|typeof window\|useState" frontend/src/app/login/page.tsx` |
| 3 — auth-aware header toggle | `frontend/src/components/auth-nav.tsx` exists AND layout renders `<AuthNav` | `ls frontend/src/components/auth-nav.tsx; grep -n AuthNav frontend/src/app/layout.tsx` |
| 4 — persist key on login | the **sign-in** submit handler writes `gateway_api_key` to localStorage (the register handler already does via `setRegisteredKey` — do not count that) | `grep -n -B6 "setRegisteredKey" frontend/src/app/login/page.tsx` |

If a probe shows a task is already implemented, mark it `[x] SKIP — already implemented (verified <date>)` and leave its files untouched. Only implement tasks whose probe shows they are missing.

**Step 0.4 — Record the baseline** before executing: current commit, `npm run verify` counts, and the list of tasks you are skipping. This is how we avoid fixing what is already fixed.

---

## File Structure

### New Files
- `frontend/src/components/auth-nav.tsx` — client component: single auth-aware header button + sign-out.
- `frontend/src/hooks/use-auth.ts` — client hook: reads `{ user }` from localStorage, exposes `user`, `isLoggedIn`, `signOut`.

### Modified Files
- `src/http/routes/auth.ts` — login route regenerates + returns `gateway_api_key`.
- `test/unit/auth-routes.test.ts` — assert login returns `gateway_api_key`.
- `frontend/src/app/layout.tsx` — replace the two static nav links with `<AuthNav/>`.
- `frontend/src/app/login/page.tsx` — fix hydration + default tab via `useSearchParams` in `<Suspense>`; store key on login.
- `frontend/src/app/keys/page.tsx` — no structural change required; consumes the stored key (verify only).

---

### Task 1: Backend — login returns an auto-generated gateway key

**Files:**
- Modify: `src/http/routes/auth.ts:58-66` (login handler)
- Modify: `test/unit/auth-routes.test.ts`

**Interfaces:**
- Consumes: `deps.userStore.verifyPassword(username, password)`, `deps.userStore.setGatewayApiKeyHash(userId): Promise<string>` (both already exist in `src/models/user.ts`).
- Produces: `POST /v1/auth/login` response body `{ userId: string; username: string; gateway_api_key: string }`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/auth-routes.test.ts` (inside the existing `describe` that builds the app with a real/mock `userStore`):

```typescript
it('returns a gateway_api_key on successful login', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { username: 'testuser', password: 'password123' },
  });

  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body).toHaveProperty('userId');
  expect(body).toHaveProperty('username');
  expect(typeof body.gateway_api_key).toBe('string');
  expect(body.gateway_api_key.startsWith('gk_')).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/unit/auth-routes.test.ts`
Expected: FAIL — `body.gateway_api_key` is `undefined`.

- [ ] **Step 3: Implement the login change**

In `src/http/routes/auth.ts`, inside the `/v1/auth/login` handler, after the null check, generate a fresh key via the existing model method and include it in the reply:

```typescript
const user = await deps.userStore.verifyPassword(username, password);
if (user === null) {
  throw new ApiError('auth', 'invalid username or password');
}
const gatewayApiKey = await deps.userStore.setGatewayApiKeyHash(user.id);
return reply.send({ userId: user.id, username: user.username, gateway_api_key: gatewayApiKey });
```

Note in the commit body: login now rotates the gateway key; the previous key is invalidated.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/unit/auth-routes.test.ts`
Expected: PASS (all auth-route tests, including the new one).

- [ ] **Step 5: Run the full backend suite for regressions**

Run: `npm run verify`
Expected: exit 0, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/http/routes/auth.ts test/unit/auth-routes.test.ts
git commit -m "feat(auth): return auto-generated gateway key on login"
```

---

### Task 2: Frontend — `/login` always opens on Sign In (and fix hydration)

**Files:**
- Modify: `frontend/src/app/login/page.tsx:1-30` (imports + `tab` state + component wrapper)

**Interfaces:**
- Consumes: Next.js `useSearchParams` from `next/navigation`.
- Produces: `/login` renders Sign In first; `/login?tab=register` renders Create Account; navigating between them updates the visible tab. Server HTML and first client render both show Sign In (no hydration mismatch).

- [ ] **Step 1: Replace the `typeof window` state initializer**

Delete the current initializer:

```typescript
const [tab, setTab] = useState<'signin' | 'register'>(() => {
  if (typeof window === 'undefined') return 'signin';
  const params = new URLSearchParams(window.location.search);
  return params.get('tab') === 'register' ? 'register' : 'signin';
});
```

Replace with URL-derived state that re-syncs on navigation:

```typescript
const searchParams = useSearchParams();
const urlTab: 'signin' | 'register' =
  searchParams.get('tab') === 'register' ? 'register' : 'signin';
const [tab, setTab] = useState<'signin' | 'register'>(urlTab);

useEffect(() => {
  setTab(urlTab);
}, [urlTab]);
```

Import `useSearchParams` from `next/navigation` and `useEffect` from `react`. The manual tab buttons keep calling `setTab(...)` — they change local state only, so the effect (keyed on `urlTab`) does not fight them.

- [ ] **Step 2: Wrap the `<Suspense>`-sensitive content**

Rename the current default-export page component to an inner component (e.g. `LoginPageInner`) and export a wrapper that provides the boundary `useSearchParams` requires in Next 16:

```typescript
import { Suspense } from 'react';

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}
```

- [ ] **Step 3: Verify build and lint**

Run: `cd frontend && npm run build`
Expected: exit 0, no `useSearchParams`/`Suspense` error.

Run: `cd frontend && npm run lint`
Expected: exit 0, no new errors.

- [ ] **Step 4: Manual verification**

With backend on `:8081` and frontend on `:3000`:
1. Open `http://localhost:3000/login` → Sign In tab is active.
2. Open `http://localhost:3000/login?tab=register` → Create Account tab is active.
3. From Create Account, click the header "Login" link (goes to `/login`) → Sign In is shown (not the stale register tab).
4. No hydration error in the browser console.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/login/page.tsx
git commit -m "fix(frontend): default /login to sign-in and fix hydration mismatch"
```

---

### Task 3: Frontend — single auth-aware header button

**Files:**
- Create: `frontend/src/hooks/use-auth.ts`
- Create: `frontend/src/components/auth-nav.tsx`
- Modify: `frontend/src/app/layout.tsx:40-47` (replace the two `<Link>`s)

**Interfaces:**
- Consumes: `localStorage.getItem('user')` (JSON `{ userId | id, username }`) — the same key every auth path writes.
- Produces:
  - `useAuth(): { user: { username: string } | null; isLoggedIn: boolean; signOut: () => void }`
  - `<AuthNav />` — renders `Login` (logged out) or `Keys` + `Sign out` (logged in) in the same nav slot.

- [ ] **Step 1: Create the `useAuth` hook**

```typescript
// frontend/src/hooks/use-auth.ts
'use client';

import { useCallback, useEffect, useState } from 'react';

export interface AuthUser {
  username: string;
}

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem('user');
      setUser(raw ? (JSON.parse(raw) as AuthUser) : null);
    } catch {
      setUser(null);
    }
    setHydrated(true);
  }, []);

  const signOut = useCallback(() => {
    localStorage.removeItem('user');
    localStorage.removeItem('gateway_api_key');
    localStorage.removeItem('gateway_key');
    setUser(null);
  }, []);

  return { user, isLoggedIn: user !== null, hydrated, signOut };
}
```

- [ ] **Step 2: Create the `AuthNav` component**

```typescript
// frontend/src/components/auth-nav.tsx
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '../hooks/use-auth';

export function AuthNav() {
  const { isLoggedIn, hydrated, signOut } = useAuth();
  const router = useRouter();

  // Avoid a hydration flash: render nothing auth-specific until mounted.
  if (!hydrated) {
    return <nav className="flex items-center gap-4 text-sm text-slate-300" />;
  }

  if (!isLoggedIn) {
    return (
      <nav className="flex items-center gap-4 text-sm text-slate-300">
        <Link href="/login" className="hover:text-slate-100">
          Login
        </Link>
      </nav>
    );
  }

  return (
    <nav className="flex items-center gap-4 text-sm text-slate-300">
      <Link href="/keys" className="hover:text-slate-100">
        Keys
      </Link>
      <button
        type="button"
        onClick={() => {
          signOut();
          router.push('/login');
        }}
        className="hover:text-slate-100"
      >
        Sign out
      </button>
    </nav>
  );
}
```

- [ ] **Step 3: Replace the static nav in the layout**

In `frontend/src/app/layout.tsx`, import `AuthNav` and replace the existing `<nav>…Login…Keys…</nav>` block (lines 40-47) with:

```typescript
<AuthNav />
```

- [ ] **Step 4: Verify build and lint**

Run: `cd frontend && npm run build`
Expected: exit 0.

Run: `cd frontend && npm run lint`
Expected: exit 0.

- [ ] **Step 5: Manual verification**

1. Logged out, open `/` → header shows **Login** only.
2. Log in → header shows **Keys** + **Sign out** (no Login link).
3. Click **Sign out** → returns to `/login`, header shows **Login** again.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/hooks/use-auth.ts frontend/src/components/auth-nav.tsx frontend/src/app/layout.tsx
git commit -m "feat(frontend): auth-aware header toggle (Login vs Keys/Sign out)"
```

---

### Task 4: Frontend — persist the auto-generated key on login

**Files:**
- Modify: `frontend/src/app/login/page.tsx` (the `onSignInSubmit` handler)

**Interfaces:**
- Consumes: `POST /v1/auth/login` returning `{ userId, username, gateway_api_key }` (Task 1).
- Produces: after login, `localStorage.user`, `localStorage.gateway_api_key` are set, so `/keys` shows the key immediately.

- [ ] **Step 1: Update the sign-in submit handler to store the key**

In the sign-in submit handler, after a successful `api.post<LoginResponse>('/auth/login', …)`, persist both the user and the returned key:

```typescript
const data = await api.post<LoginResponse>('/auth/login', {
  username: signInUsername.trim(),
  password: signInPassword,
});

localStorage.setItem('user', JSON.stringify({ userId: data.userId, username: data.username }));
if (data.gateway_api_key) {
  localStorage.setItem('gateway_api_key', data.gateway_api_key);
}

router.push('/keys');
```

Add `gateway_api_key?: string` to the `LoginResponse` interface in `frontend/src/lib/api.ts` if it is not already present.

- [ ] **Step 2: Verify build and lint**

Run: `cd frontend && npm run build`
Expected: exit 0.

Run: `cd frontend && npm run lint`
Expected: exit 0.

- [ ] **Step 3: Manual end-to-end verification**

1. Register a new user → lands on `/keys`, key visible.
2. Sign out, then sign in with the same credentials.
3. `/keys` shows the provider-key table (empty is fine) and the **gateway key is auto-populated** — no "Get New" prompt, no password re-entry.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/login/page.tsx frontend/src/lib/api.ts
git commit -m "feat(frontend): persist auto-generated gateway key on login"
```

---

## Self-Review

**1. Spec coverage:**
- "Only logged-in user sees Keys / only logged-out sees Login, same place" → Task 3 (`AuthNav` in the same nav slot). ✓
- "First gateway key generated automatically" → Task 1 (backend) + Task 4 (frontend stores it). ✓
- "Opening `/login` shows Sign In first, switch manually" → Task 2 (`useSearchParams`-derived tab + Suspense). ✓

**2. Step scan:** Each step is one action with a checkable result (write test / run test / implement / verify / commit, or build+lint+manual). No "handle edge cases" placeholders. The frontend has no unit harness, so behaviour steps use explicit browser actions with expected results rather than fabricated test commands.

**3. Type consistency:** `useAuth()` returns `{ user, isLoggedIn, hydrated, signOut }` — `AuthNav` consumes exactly those. Login response type gains optional `gateway_api_key`, consumed in Task 4. `setGatewayApiKeyHash(userId): Promise<string>` matches the existing model signature.

**4. Review Focus coverage:**
- Stale register tab on nav → Task 2 Step 4 (manual check 3). ✓
- Logged-in user on `/login` / duplicate account → Task 3 (header hides Login when logged in). ✓
- Second-device login shows key immediately → Tasks 1 + 4 Step 3. ✓
- Key rotation invalidation → Task 1 (documented tradeoff in commit + here). ✓
- `useSearchParams` needs Suspense → Task 2 Step 2. ✓

**5. Proportion:** Plan is comparable in length to the work; code blocks are signatures and small components the implementer cannot guess (hook, nav, state-sync), not full transcripts of unchanged files.

## Open Questions

1. **Key rotation on every login** is a deliberate tradeoff of Task 1 (the stored key is hashed and unrecoverable). If rotating on each login is unacceptable (users paste the key into their own apps), the alternative is a "remember this device" flag or storing the key reversibly encrypted — both out of scope here. Confirm the rotation behaviour is acceptable before executing Task 1.
2. Task 4 assumes the login page's existing variable names (`signInUsername`, `signInPassword`, `LoginResponse`). The implementer should reconcile with the actual file; names above match the current handler shape.