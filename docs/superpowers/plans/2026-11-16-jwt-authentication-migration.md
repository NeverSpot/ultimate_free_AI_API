# JWT Authentication Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate from gateway-key-only authentication to JWT-based authentication with httpOnly cookies, while maintaining backward compatibility with existing gateway API keys.

**Architecture:** Add JWT token generation on login/register, store JWT in httpOnly cookie on frontend, verify JWT in middleware alongside existing gateway key auth. Frontend reads user from JWT cookie instead of localStorage. Existing gateway keys remain valid for API access.

**Tech Stack:** Node.js, Fastify, TypeScript, jsonwebtoken, Next.js 14, React, PostgreSQL

**Spec:** This plan implements JWT authentication migration based on analysis of current auth flow.

## Global Constraints

- Maintain backward compatibility with existing `gateway_api_key` for API requests
- JWT tokens expire after 7 days
- JWT secret must be stored in environment variable `JWT_SECRET`
- httpOnly cookies must be `Secure` in production, `SameSite=Strict`
- All existing tests must continue to pass
- No breaking changes to existing API endpoints

## Review Focus

- **JWT expiry:** Token expires after 7 days, user must re-login
- **Invalid JWT:** Malformed or tampered JWT returns 401
- **Missing JWT:** No cookie present when JWT auth required
- **Gateway key fallback:** Existing gateway keys still work for API access
- **CSRF protection:** SameSite=Strict cookie prevents CSRF attacks

---

## Pre-Execution Verification (do this BEFORE any task)

> **Do not re-implement what already works.** JWT auth is not implemented yet, but a prior change may already have landed a piece (e.g. a `token` field on login, or a `/v1/user/me` route). Verify each task first.

**Step 0.1 — Baseline (read-only):**

```bash
git status --short --branch
git log --oneline -8
```

Do not `reset` or `clean` a dirty tree. Ask the human which uncommitted changes are intentional before touching anything.

**Step 0.2 — Tests must be green before you start:**

```bash
npm run verify
```

Expected: `fail 0`, exit 0. If already red, STOP — report the failures first.

**Step 0.3 — Per-task "already done?" probes.** Run each probe and read the output; a match = skip that task.

| Task | Already done if… | Probe |
|------|------------------|-------|
| 1 — JWT config | `Config` has `jwtSecret` and `loadConfig` reads `JWT_SECRET` | `grep -n "jwtSecret\|JWT_SECRET" src/config/env.ts` |
| 2 — jwt utils | `src/lib/jwt.ts` exports `signJwt` / `verifyJwt` | `ls src/lib/jwt.ts; grep -n "export function" src/lib/jwt.ts` |
| 3 — jwt middleware | `src/http/middleware/jwt-auth.ts` exists | `ls src/http/middleware/jwt-auth.ts` |
| 4 — auth returns token | login/register replies include `token` via `signJwt` | `grep -n "signJwt\|token" src/http/routes/auth.ts` |
| 5 — frontend sends JWT | api client references `token` / `credentials` | `grep -n "token\|credentials" frontend/src/lib/api.ts` |
| 6 — Set-Cookie | auth routes set a `jwt` cookie | `grep -n "Set-Cookie" src/http/routes/auth.ts` |
| 7 — middleware wired | `jwtAuth` referenced in server + index | `grep -n "jwtAuth" src/http/server.ts src/index.ts` |
| 8 — /v1/user/me | route file exists and is registered | `ls src/http/routes/user.ts; grep -rn "v1/user/me" src/` |
| 9 — logout | `/v1/auth/logout` clears the cookie | `grep -n "v1/auth/logout" src/http/routes/auth.ts` |
| 10 — final | covered by `npm run verify` | `npm run verify` |

Mark any task whose probe passes as `[x] SKIP — already implemented (verified <date>)`; leave its files untouched.

**Step 0.4 — Record the baseline** before executing: current commit, `npm run verify` counts, and the tasks you are skipping.

---

## File Structure

### New Files
- `src/lib/jwt.ts` — JWT sign/verify functions
- `src/http/middleware/jwt-auth.ts` — JWT verification middleware
- `test/unit/jwt.test.ts` — JWT unit tests

### Modified Files
- `src/http/routes/auth.ts` — Add JWT generation on login/register
- `src/http/server.ts` — Wire JWT middleware
- `src/index.ts` — Add JWT secret to config
- `src/config/env.ts` — Add JWT_SECRET env var
- `frontend/src/lib/api.ts` — Read JWT from cookie for auth
- `frontend/src/app/login/page.tsx` — No changes needed (cookies auto-handled)
- `frontend/src/app/keys/page.tsx` — Read user from JWT cookie

---

### Task 1: Add JWT Configuration

**Files:**
- Modify: `src/config/env.ts`
- Modify: `.env` (add JWT_SECRET)

**Interfaces:**
- Consumes: `process.env.JWT_SECRET`
- Produces: `config.jwtSecret: string`

- [ ] **Step 1: Add JWT_SECRET to environment config**

```typescript
// src/config/env.ts
export interface Config {
  // ... existing fields
  jwtSecret: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  // ... existing validation
  
  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error('JWT_SECRET is required');
  }
  
  return {
    // ... existing fields
    jwtSecret,
  };
}
```

- [ ] **Step 2: Add JWT_SECRET to .env file**

```bash
# .env
JWT_SECRET=***
```

- [ ] **Step 3: Run tests to verify config loads**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/config/env.ts .env
git commit -m "feat(config): add JWT_SECRET configuration"
```

---

### Task 2: Create JWT Utility Functions

**Files:**
- Create: `src/lib/jwt.ts`
- Create: `test/unit/jwt.test.ts`

**Interfaces:**
- Consumes: `config.jwtSecret`
- Produces: 
  - `signJwt(payload: JwtPayload, secret: string): string`
  - `verifyJwt(token: string, secret: string): JwtPayload | null`

- [ ] **Step 1: Write failing test for JWT sign/verify**

```typescript
// test/unit/jwt.test.ts
import { describe, it, expect } from 'vitest';
import { signJwt, verifyJwt } from '../../src/lib/jwt';

describe('JWT', () => {
  const secret = 'test-secret-key';
  const payload = { userId: 'user-123', username: 'testuser' };

  it('signs and verifies a JWT token', () => {
    const token = signJwt(payload, secret);
    expect(token).toBeDefined();
    expect(typeof token).toBe('string');
    
    const decoded = verifyJwt(token, secret);
    expect(decoded).toEqual(payload);
  });

  it('returns null for invalid token', () => {
    const decoded = verifyJwt('invalid.token.here', secret);
    expect(decoded).toBeNull();
  });

  it('returns null for token signed with different secret', () => {
    const token = signJwt(payload, 'wrong-secret');
    const decoded = verifyJwt(token, secret);
    expect(decoded).toBeNull();
  });

  it('returns null for expired token', () => {
    const expiredPayload = { userId: 'user-123', username: 'testuser', exp: Math.floor(Date.now() / 1000) - 3600 };
    const token = signJwt(expiredPayload, secret);
    const decoded = verifyJwt(token, secret);
    expect(decoded).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/unit/jwt.test.ts`
Expected: FAIL with "Cannot find module '../../src/lib/jwt'"

- [ ] **Step 3: Implement JWT utility functions**

```typescript
// src/lib/jwt.ts
import jwt from 'jsonwebtoken';

export interface JwtPayload {
  userId: string;
  username: string;
  exp?: number;
  iat?: number;
}

export function signJwt(payload: JwtPayload, secret: string): string {
  return jwt.sign(payload, secret, { expiresIn: '7d' });
}

export function verifyJwt(token: string, secret: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, secret) as JwtPayload;
    return decoded;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Install jsonwebtoken dependency**

Run: `npm install jsonwebtoken && npm install -D @types/jsonwebtoken`
Expected: Package installed successfully

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/unit/jwt.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/lib/jwt.ts test/unit/jwt.test.ts package.json package-lock.json
git commit -m "feat(auth): add JWT sign/verify utilities"
```

---

### Task 3: Create JWT Authentication Middleware

**Files:**
- Create: `src/http/middleware/jwt-auth.ts`
- Create: `test/unit/jwt-middleware.test.ts`

**Interfaces:**
- Consumes: `verifyJwt(token, secret)`, `FastifyRequest`
- Produces: `createJwtAuth({ jwtSecret, findUserById })` returning `{ authenticate(req): Promise<JwtPayload | null> }`

- [ ] **Step 1: Write failing test for JWT middleware**

```typescript
// test/unit/jwt-middleware.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createJwtAuth } from '../../src/http/middleware/jwt-auth';
import { signJwt } from '../../src/lib/jwt';

describe('JWT Auth Middleware', () => {
  const secret = 'test-secret';
  const mockFindUser = vi.fn().mockResolvedValue({ id: 'user-123', username: 'testuser' });

  it('authenticates valid JWT from cookie', async () => {
    const token = signJwt({ userId: 'user-123', username: 'testuser' }, secret);
    const req = {
      headers: { cookie: `jwt=${token}` },
    } as any;

    const auth = createJwtAuth({ jwtSecret: secret, findUserById: mockFindUser });
    const result = await auth.authenticate(req);

    expect(result).toEqual({ userId: 'user-123', username: 'testuser' });
    expect(mockFindUser).toHaveBeenCalledWith('user-123');
  });

  it('returns null for missing cookie', async () => {
    const req = { headers: {} } as any;
    const auth = createJwtAuth({ jwtSecret: secret, findUserById: mockFindUser });
    const result = await auth.authenticate(req);
    expect(result).toBeNull();
  });

  it('returns null for invalid JWT', async () => {
    const req = {
      headers: { cookie: 'jwt=invalid.token.here' },
    } as any;

    const auth = createJwtAuth({ jwtSecret: secret, findUserById: mockFindUser });
    const result = await auth.authenticate(req);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/unit/jwt-middleware.test.ts`
Expected: FAIL with "Cannot find module '../../src/http/middleware/jwt-auth'"

- [ ] **Step 3: Implement JWT middleware**

```typescript
// src/http/middleware/jwt-auth.ts
import type { FastifyRequest } from 'fastify';
import { verifyJwt, type JwtPayload } from '../../lib/jwt';

export interface JwtAuthResult {
  userId: string;
  username: string;
}

export function createJwtAuth({
  jwtSecret,
  findUserById,
}: {
  jwtSecret: string;
  findUserById: (userId: string) => Promise<{ id: string; username: string } | null>;
}) {
  async function authenticate(req: FastifyRequest): Promise<JwtAuthResult | null> {
    const cookies = req.headers.cookie;
    if (!cookies) return null;

    const jwtCookie = cookies
      .split(';')
      .map(c => c.trim())
      .find(c => c.startsWith('jwt='));

    if (!jwtCookie) return null;

    const token = jwtCookie.substring(4);
    const payload = verifyJwt(token, jwtSecret);
    
    if (!payload || !payload.userId) return null;

    const user = await findUserById(payload.userId);
    if (!user) return null;

    return { userId: user.id, username: user.username };
  }

  return { authenticate };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/unit/jwt-middleware.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/http/middleware/jwt-auth.ts test/unit/jwt-middleware.test.ts
git commit -m "feat(auth): add JWT authentication middleware"
```

---

### Task 4: Update Auth Routes to Generate JWT

**Files:**
- Modify: `src/http/routes/auth.ts`
- Modify: `test/unit/auth-routes.test.ts`

**Interfaces:**
- Consumes: `signJwt(payload, secret)`, `userStore`
- Produces: Login/register responses now include `token` field

- [ ] **Step 1: Update auth routes test to expect JWT token**

```typescript
// test/unit/auth-routes.test.ts - Add to existing tests
it('returns JWT token on successful login', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { username: 'testuser', password: 'password123' },
  });

  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body).toHaveProperty('token');
  expect(typeof body.token).toBe('string');
});

it('returns JWT token on successful registration', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { username: 'newuser', email: 'new@test.com', password: 'password123' },
  });

  expect(response.statusCode).toBe(201);
  const body = response.json();
  expect(body).toHaveProperty('token');
  expect(typeof body.token).toBe('string');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/unit/auth-routes.test.ts`
Expected: FAIL with "Cannot read property 'token' of undefined"

- [ ] **Step 3: Update auth.ts to generate JWT on login**

```typescript
// src/http/routes/auth.ts
import { signJwt } from '../../lib/jwt';

export function registerAuthRoutes(app: FastifyInstance, deps: { 
  userStore: UserModel;
  jwtSecret: string;
}): void {
  // ... existing code

  app.post('/v1/auth/login', async (request, reply) => {
    const { username, password } = requireObjectBody(request.body) as unknown as LoginRequestType;
    requireNonEmpty({ username, password });
    const user = await deps.userStore.verifyPassword(username, password);
    if (user === null) {
      throw new ApiError('auth', 'invalid username or password');
    }
    
    const token = signJwt({ userId: user.id, username: user.username }, deps.jwtSecret);
    
    return reply.send({ 
      userId: user.id, 
      username: user.username,
      token 
    });
  });

  app.post('/v1/auth/register', async (request, reply) => {
    // ... existing validation
    
    const result = await deps.userStore.createUser({ username, email, password });
    
    const token = signJwt({ 
      userId: result.user.id, 
      username: result.user.username 
    }, deps.jwtSecret);
    
    return reply.status(201).send({
      user: { id: result.user.id, username: result.user.username, email: result.user.email },
      gateway_api_key: result.gatewayApiKeyPlaintext,
      token 
    });
  });
}
```

- [ ] **Step 4: Update server.ts to pass jwtSecret to auth routes**

```typescript
// src/http/server.ts
if (deps.userStore) {
  registerAuthRoutes(app, { 
    userStore: deps.userStore,
    jwtSecret: deps.config.jwtSecret 
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- test/unit/auth-routes.test.ts`
Expected: PASS (all auth tests including new JWT tests)

- [ ] **Step 6: Commit**

```bash
git add src/http/routes/auth.ts src/http/server.ts test/unit/auth-routes.test.ts
git commit -m "feat(auth): generate JWT tokens on login/register"
```

---

### Task 5: Update Frontend API Client to Send JWT

**Files:**
- Modify: `frontend/src/lib/api.ts`

**Interfaces:**
- Consumes: JWT token from login/register response
- Produces: API client that sends JWT as httpOnly cookie

- [ ] **Step 1: Update API client to store JWT and send with requests**

```typescript
// frontend/src/lib/api.ts
// Add JWT token storage after successful login/register

async function handleLoginResponse<T>(response: Response): Promise<T> {
  if (response.ok) {
    const data = await response.json();
    
    // Store JWT token if present
    if (data.token) {
      // Cookie is set by backend via Set-Cookie header
      // Frontend doesn't need to manually store it
    }
    
    // Store user info in localStorage for UI state
    if (data.userId || data.user) {
      const user = data.user || { userId: data.userId, username: data.username };
      localStorage.setItem('user', JSON.stringify(user));
    }
    
    return data;
  }
  
  // ... existing error handling
  return handleResponse<T>(response);
}
```

- [ ] **Step 2: Update login/register calls in login page**

```typescript
// frontend/src/app/login/page.tsx
// Update onSignInSubmit to use updated api.post

async function onSignInSubmit(e: FormEvent<HTMLFormElement>) {
  e.preventDefault();
  setError('');
  setLoading(true);

  try {
    const data = await api.post<LoginResponse>('/auth/login', {
      username: signInUsername.trim(),
      password: signInPassword,
    });

    // JWT token is automatically stored in httpOnly cookie by backend
    // User info stored in localStorage for UI state
    const user = { userId: data.userId, username: data.username };
    localStorage.setItem('user', JSON.stringify(user));

    router.push('/keys');
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Sign in failed');
  } finally {
    setLoading(false);
  }
}
```

- [ ] **Step 3: Test frontend login flow**

Run: `cd frontend && npm run dev`
Expected: Login successful, redirected to /keys page

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/app/login/page.tsx
git commit -m "feat(frontend): update API client for JWT authentication"
```

---

### Task 6: Update Backend to Set JWT Cookie

**Files:**
- Modify: `src/http/routes/auth.ts`

**Interfaces:**
- Consumes: JWT token
- Produces: HTTP response with Set-Cookie header

- [ ] **Step 1: Update login/register to set httpOnly cookie**

```typescript
// src/http/routes/auth.ts
app.post('/v1/auth/login', async (request, reply) => {
  // ... existing code
  
  const token = signJwt({ userId: user.id, username: user.username }, deps.jwtSecret);
  
  // Set httpOnly cookie
  reply.header('Set-Cookie', `jwt=${token}; HttpOnly; Path=/; Max-Age=604800; SameSite=Strict${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  
  return reply.send({ 
    userId: user.id, 
    username: user.username,
    token // Keep for backward compatibility
  });
});
```

- [ ] **Step 2: Update register similarly**

```typescript
// src/http/routes/auth.ts
app.post('/v1/auth/register', async (request, reply) => {
  // ... existing code
  
  const token = signJwt({ 
    userId: result.user.id, 
    username: result.user.username 
  }, deps.jwtSecret);
  
  // Set httpOnly cookie
  reply.header('Set-Cookie', `jwt=${token}; HttpOnly; Path=/; Max-Age=604800; SameSite=Strict${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  
  return reply.status(201).send({
    user: { id: result.user.id, username: result.user.username, email: result.user.email },
    gateway_api_key: result.gatewayApiKeyPlaintext,
    token // Keep for backward compatibility
  });
});
```

- [ ] **Step 3: Test cookie is set correctly**

Run: `curl -v -X POST http://localhost:8080/v1/auth/login -H "Content-Type: application/json" -d '{"username":"test","password":"test"}'`
Expected: Response includes `Set-Cookie: jwt=...; HttpOnly; Path=/; Max-Age=604800; SameSite=Strict`

- [ ] **Step 4: Commit**

```bash
git add src/http/routes/auth.ts
git commit -m "feat(auth): set httpOnly JWT cookie on login/register"
```

---

### Task 7: Wire JWT Middleware into Server

**Files:**
- Modify: `src/http/server.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `createJwtAuth`, `config.jwtSecret`
- Produces: JWT auth middleware wired into Fastify

- [ ] **Step 1: Update index.ts to wire JWT auth**

```typescript
// src/index.ts
import { createJwtAuth } from './http/middleware/jwt-auth';

// In main() function:
const jwtAuth = createJwtAuth({
  jwtSecret: config.jwtSecret,
  findUserById: (userId) => userStore.findById(userId),
});

const app = buildServer({
  // ... existing deps
  jwtAuth,
});
```

- [ ] **Step 2: Add findById method to userStore**

```typescript
// src/models/user.ts
async function findById(userId: string): Promise<{ id: string; username: string } | null> {
  const result = await db.query<{ id: string; username: string }>(
    `select id, username from users where id = $1`,
    [userId]
  );
  return result.rows[0] ?? null;
}

// Add to return object
return {
  createUser,
  findByUsername,
  findByEmail,
  findByGatewayApiKeyHash,
  verifyPassword,
  setGatewayApiKeyHash,
  findById, // Add this
};
```

- [ ] **Step 3: Update server.ts to add JWT auth hook**

```typescript
// src/http/server.ts
export interface ServerDeps {
  // ... existing fields
  jwtAuth?: ReturnType<typeof createJwtAuth>;
}

// In buildServer():
const jwtAuth = deps.jwtAuth;
if (jwtAuth) {
  app.addHook('onRequest', async (request, _reply) => {
    const url = request.url;
    if (url === '/healthz' || url.startsWith('/v1/auth/')) return;
    
    // Try JWT auth first
    const jwtResult = await jwtAuth.authenticate(request);
    if (jwtResult) {
      request.user = { id: jwtResult.userId, username: jwtResult.username };
      return;
    }
    
    // Fall back to gateway key auth
    if (gatewayKeyAuth) {
      await gatewayKeyAuth.authenticate(request);
    }
  });
}
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/http/server.ts src/models/user.ts
git commit -m "feat(auth): wire JWT middleware into server"
```

---

### Task 8: Update Keys Page to Use JWT

**Files:**
- Modify: `frontend/src/app/keys/page.tsx`

**Interfaces:**
- Consumes: JWT cookie (automatically sent by browser)
- Produces: Keys page reads user from JWT, not localStorage

- [ ] **Step 1: Update keys page to handle JWT-based auth**

```typescript
// frontend/src/app/keys/page.tsx
// Update the useEffect that reads user data

useEffect(() => {
  try {
    const raw = localStorage.getItem('user');
    setUser(raw ? JSON.parse(raw) : null);
  } catch {
    setUser(null);
  }
  
  // Gateway key is still needed for provider key management
  // But JWT handles user authentication
  setGatewayKey(localStorage.getItem('gateway_api_key') || localStorage.getItem('gateway_key'));
  setHydrated(true);
}, []);

// Update redirect logic - JWT handles auth, no need to check gatewayKey for user auth
useEffect(() => {
  if (!hydrated) return;

  // If no user in localStorage, check if JWT cookie exists
  // (This is a fallback - normally JWT cookie handles this)
  if (!user) {
    // Try to fetch user info from /v1/user/me endpoint
    // For now, redirect to login if no user state
    router.push('/login');
    return;
  }

  // Load provider keys if gateway key exists
  if (gatewayKey) {
    void loadProviderKeys();
  } else {
    setLoadingKeys(false);
  }
}, [hydrated, gatewayKey, user, router, loadProviderKeys]);
```

- [ ] **Step 2: Add /v1/user/me endpoint to get current user from JWT**

```typescript
// src/http/routes/user.ts (create new file)
import type { FastifyInstance } from 'fastify';
import type { UserModel } from '../../models/user';

export function registerUserRoutes(app: FastifyInstance, deps: {
  userStore: UserModel;
}): void {
  app.get('/v1/user/me', async (request, reply) => {
    if (!request.user) {
      throw new ApiError('auth', 'authentication required');
    }
    
    const user = await deps.userStore.findById(request.user.id);
    if (!user) {
      throw new ApiError('auth', 'user not found');
    }
    
    return reply.send({
      id: user.id,
      username: user.username,
      email: user.email,
    });
  });
}
```

- [ ] **Step 3: Wire user routes in server.ts**

```typescript
// src/http/server.ts
import { registerUserRoutes } from './routes/user';

// In buildServer():
if (deps.userStore) {
  registerUserRoutes(app, { userStore: deps.userStore });
}
```

- [ ] **Step 4: Test the full flow**

Run: `npm run dev` (backend) and `cd frontend && npm run dev` (frontend)
Expected: 
1. Register user → JWT cookie set
2. Navigate to /keys → User info loaded from JWT
3. Provider keys load correctly

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/keys/page.tsx src/http/routes/user.ts src/http/server.ts
git commit -m "feat(frontend): update keys page for JWT authentication"
```

---

### Task 9: Add Logout Endpoint to Clear JWT

**Files:**
- Modify: `src/http/routes/auth.ts`
- Modify: `frontend/src/app/keys/page.tsx`

**Interfaces:**
- Consumes: JWT cookie
- Produces: Logout endpoint that clears JWT cookie

- [ ] **Step 1: Add logout endpoint**

```typescript
// src/http/routes/auth.ts
app.post('/v1/auth/logout', async (request, reply) => {
  // Clear the JWT cookie
  reply.header('Set-Cookie', 'jwt=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict');
  return reply.send({ ok: true });
});
```

- [ ] **Step 2: Update frontend logout to call logout endpoint**

```typescript
// frontend/src/app/keys/page.tsx
// Update the Sign out button onClick

onClick={async () => {
  try {
    await api.post('/auth/logout');
  } catch {
    // Ignore errors
  }
  localStorage.clear();
  router.push('/login');
}}
```

- [ ] **Step 3: Test logout flow**

Run: Login → Click Sign out → Verify JWT cookie is cleared
Expected: Cookie removed, redirected to login page

- [ ] **Step 4: Commit**

```bash
git add src/http/routes/auth.ts frontend/src/app/keys/page.tsx
git commit -m "feat(auth): add logout endpoint to clear JWT cookie"
```

---

### Task 10: End-to-End Testing and Cleanup

**Files:**
- All modified files
- Remove debug code
- Update documentation

**Interfaces:**
- Consumes: All previous implementations
- Produces: Fully functional JWT authentication system

- [ ] **Step 1: Run full test suite**

Run: `npm run verify`
Expected: All tests pass, no TypeScript errors

- [ ] **Step 2: Manual testing checklist**

1. Register new user → JWT cookie set, redirected to /keys
2. Login with existing user → JWT cookie set, redirected to /keys
3. Access /keys with valid JWT → User info displayed, provider keys load
4. Access /keys without JWT → Redirected to /login
5. Click Sign out → JWT cookie cleared, redirected to /login
6. API calls with JWT → Authenticated successfully
7. API calls with gateway key → Still work (backward compatibility)

- [ ] **Step 3: Update environment documentation**

```markdown
# .env.example

# Required for JWT authentication
JWT_SECRET=***
```

- [ ] **Step 4: Final commit**

```bash
git add .env.example
git commit -m "docs: document JWT_SECRET environment variable"
```

---

## Summary

This plan migrates the authentication system from gateway-key-only to JWT-based authentication with the following benefits:

1. **Security:** JWT stored in httpOnly cookies (XSS protection)
2. **Persistence:** User stays logged in across browser sessions (7-day expiry)
3. **Backward Compatibility:** Existing gateway keys continue to work for API access
4. **CSRF Protection:** SameSite=Strict cookie prevents CSRF attacks
5. **Scalability:** JWT is stateless, no server-side session storage needed

**Total Tasks:** 10
**Estimated Time:** 2-3 hours
**Risk Level:** Medium (touching auth flow requires careful testing)