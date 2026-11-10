# Block 2 — Fastify HTTP layer: implementation plan

Brief for the implementing agent. The contract lives in `docs/api.md` — read it first and
do not redesign it. This file states only *how* to build it.

## Scope decision

Block 2 **pulls the Block 1 type contract forward**. The route cannot compile without
`CanonicalRequest` / `CanonicalResponse` / `ProviderAdapter`, so define them here exactly as
specified below. Block 1's remaining scope becomes the *behavioural* mock (RPM ceiling,
configurable latency, error injection) and its dedicated tests — not the types.

## Files

| Path | Purpose |
|---|---|
| `src/core/types.ts` | canonical request/response/usage/chunk types |
| `src/core/errors.ts` | `ErrorKind`, `ProviderError` |
| `src/core/ids.ts` | `newRequestId()` — `chatcmpl-` + ULID-shaped id from `crypto.randomUUID` |
| `src/providers/types.ts` | `ProviderId`, `Credential`, `ModelInfo`, `ProviderAdapter` |
| `src/providers/mock.ts` | minimal deterministic mock adapter (`chat` + `listModels`) |
| `src/config/env.ts` | `loadConfig(raw): Config`, validates and throws with a problem list |
| `src/http/schemas.ts` | TypeBox: `ChatRequest`, `ChatResponse`, `HealthResponse`, `ErrorEnvelope` |
| `src/http/errors.ts` | `ApiError`, `toEnvelope()`, `statusFor()`, `typeFor()`, `codeFor()` |
| `src/http/routes/chat-completions.ts` | `POST /v1/chat/completions` |
| `src/http/routes/healthz.ts` | `GET /healthz` |
| `src/http/server.ts` | `buildServer(deps)` -> `FastifyInstance` |
| `src/index.ts` | bootstrap: `loadConfig(process.env)` -> `buildServer` -> `listen` |
| `test/unit/http.test.ts` | `app.inject()` tests, all 12 cases below |
| `package.json` | dependency additions only |

## Dependencies

```
npm i fastify@^5 @sinclair/typebox@^0.34 @fastify/type-provider-typebox@^5
```

`@fastify/type-provider-typebox` is official Fastify, not a third-party shim: it wires
TypeBox into `request.body` and the response generic so no `as` casts are needed. pino
comes with Fastify (`logger: true`).

## Signatures

```ts
// src/config/env.ts
export interface Config {
  port: number; adminToken: string; maxBodyBytes: number;
  attemptTimeoutMs: number; requestDeadlineMs: number; logLevel: string; nodeEnv: string;
}
export function loadConfig(raw: NodeJS.ProcessEnv): Config;   // throws, lists every problem

// src/providers/types.ts
export type ProviderId = string;                               // OPAQUE string, never a union
export interface Credential { id: string; provider: ProviderId; secret: string; label?: string }
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly supportsStreaming: boolean;
  chat(req: CanonicalRequest, cred: Credential, signal?: AbortSignal): Promise<CanonicalResponse>;
  listModels(cred: Credential): Promise<ModelInfo[]>;
}

// src/http/server.ts
export interface ServerDeps {
  config: Config;
  provider: ProviderAdapter;     // Block 3 swaps the real adapter in; routes never change
  credential: Credential;        // Phase A: one fixed credential
  now?: () => number;
  logger?: boolean;
}
export function buildServer(deps: ServerDeps): FastifyInstance;
```

`buildServer` must not read `process.env` and must not call `listen()` — tests build a server
with injected deps and use `app.inject()`.

## Typed route pattern

```ts
import { Type, type Static } from '@sinclair/typebox';

app.withTypeProvider<TypeBoxTypeProvider>().post('/v1/chat/completions', {
  schema: { body: ChatRequest, response: { 200: ChatResponse } },
}, async (req, reply) => { /* req.body is Static<typeof ChatRequest> */ });
```

The `response` schema is the serialisation whitelist — `fast-json-stringify` drops any field
not declared there. That is how provider payloads cannot leak.

## Boundary: accept-and-ignore vs 501 vs 400

TypeBox objects are permissive by default (undeclared keys pass ajv). Keep that, and add an
explicit pre-handler check for the meaning-changing set:

| Trigger | Response |
|---|---|
| `stream === true` | `501 unsupported` |
| `n !== undefined && n > 1` | `501 unsupported` |
| `logprobs`, `top_logprobs`, `tools`, `tool_choice`, `functions`, `function_call`, `modalities`, `audio` present | `501 unsupported` |
| `messages` missing / wrong type, bad `temperature` | `400 invalid_request` (Fastify validation, remapped) |
| `seed`, `presence_penalty`, `frequency_penalty`, `logit_bias`, `store`, `metadata`, `service_tier`, `user` | accepted, ignored, debug-logged |

Implement the 501 check as one function `assertSupported(body)` in
`src/http/routes/chat-completions.ts`, not scattered `if`s.

## Env

| Key | Default |
|---|---|
| `PORT` | 8080 |
| `ADMIN_TOKEN` | **required**, no default — absent is a startup error |
| `MAX_BODY_BYTES` | 2097152 |
| `ATTEMPT_TIMEOUT_MS` | 10000 |
| `REQUEST_DEADLINE_MS` | 30000 |
| `LOG_LEVEL` | info |
| `NODE_ENV` | development |

## Tests — `test/unit/http.test.ts`

Each named after the invariant it protects:

1. `http: 200 returns an OpenAI-shaped body and exact keys`
2. `http: 401 when the bearer token is missing`
3. `http: 401 when the bearer token is wrong`
4. `http: 400 when messages is missing`
5. `http: 400 when temperature is the wrong type`
6. `http: 501 when stream is true`
7. `http: 501 when n is greater than 1`
8. `http: boundary accepts and ignores seed and presence_penalty`
9. `http: response carries the full x-gateway-* header set`
10. `http: every non-2xx returns the OpenAI error envelope`
11. `http: healthz returns 200 ok when dependencies are reachable`
12. `http: unknown route returns 404 in the OpenAI error envelope`

## Risks

1. **Response schema silently strips fields.** If `usage` is absent from the JSON, the
   `ChatResponse` schema is wrong — not the handler. Caught by test 1's exact-key assertion.
2. **Error handler not remapping Fastify's own validation errors.** Test 10 fails with
   `{statusCode, error, message}` instead of our envelope. Fix in `setErrorHandler` +
   `setNotFoundHandler`, not per route.
3. **`buildServer` reading `process.env`.** Tests then pass only by accident. Caught by the
   401 tests, which inject a token that exists only in the test config.

## Acceptance

```bash
npm run verify
npm run test -- --test-name-pattern "http"
```

Both must exit 0. Do not commit.
