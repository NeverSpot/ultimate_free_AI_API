# Plan: Group A — Phase L SDK & CLI (Blocks 32–33)

**Goal:** Add a TypeScript SDK package and a CLI tool for key management to the gateway project. These are fully disjoint from the backend — no shared files with Groups B or C.

**Context / assumptions:**
- Repo: `C:/Users/rishu/WebstormProjects/Ultimate_frre_ai`
- Branch: `agy/block-32-33-sdk-cli` (cut from `master`)
- Master is at `09bf2df` with Blocks 0–24 merged. `npm run verify` exits 0, 344 tests pass.
- Backend: Node 24, TypeScript 5.5, CommonJS, Fastify 5, `node:test`, TypeBox, native `fetch`.
- SDK lives in `sdk/` directory, CLI in `scripts/` directory — completely isolated from `src/`.
- No API keys, no secrets, no credentials in any file.
- Verification gate per block: `npx tsc --noEmit --project sdk/tsconfig.json` → exit 0; `npm run test -- --test-name-pattern "<pattern>"` → exit 0.
- Final gate: `npm run verify` → exit 0 (root tests only; SDK has its own tsc check).

---

## Block 32 — TypeScript SDK package

**Files to create/modify:**
- `sdk/package.json` (CREATE)
- `sdk/tsconfig.json` (CREATE)
- `sdk/types.ts` (CREATE) — `ChatMessage`, `ChatRequest`, `ChatResponse` interfaces
- `sdk/client.ts` (CREATE) — `createGatewayClient(baseUrl, apiKey)` factory
- `sdk/index.ts` (CREATE) — re-exports
- `test/unit/sdk.test.ts` (CREATE)

**Code — `sdk/package.json`:**
```json
{
  "name": "@ultimate-freeai/sdk",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc" }
}
```

**Code — `sdk/tsconfig.json`:**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "node",
    "outDir": "./dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

**Code — `sdk/types.ts`:**
```typescript
export interface ChatMessage { role: 'user' | 'assistant' | 'system'; content: string; }
export interface ChatRequest { model: string; messages: ChatMessage[]; stream?: boolean; max_tokens?: number; temperature?: number; }
export interface ChatResponse { id: string; object: string; created: number; model: string; choices: Array<{ index: number; message: ChatMessage; finish_reason: string }>; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; }
```

**Code — `sdk/client.ts`:**
```typescript
import type { ChatRequest, ChatResponse } from './types';

export function createGatewayClient(baseUrl: string, apiKey: string) {
  return {
    chat: {
      completions: {
        create: async (req: ChatRequest): Promise<ChatResponse> => {
          const res = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(req),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        },
      },
    },
  };
}
```

**Code — `sdk/index.ts`:**
```typescript
export type { ChatMessage, ChatRequest, ChatResponse } from './types';
export { createGatewayClient } from './client';
```

**Test — `test/unit/sdk.test.ts`:**
```typescript
import { test, expect } from 'node:test';
import { createGatewayClient } from '../sdk/client';

test('sdk: client factory returns object with chat.completions.create', (t) => {
  const client = createGatewayClient('http://localhost:8080/v1', 'test-key');
  expect(typeof client.chat.completions.create).toBe('function');
});
```

**Verification commands:**
1. `npx tsc --noEmit --project sdk/tsconfig.json` → exit 0
2. `npm run test -- --test-name-pattern "sdk"` → exit 0

**Commit:** `git add -A && git commit -m "feat(block-32): typescript SDK"` → clean tree

---

## Block 33 — CLI tool for key management

**Files to create/modify:**
- `scripts/gw-cli.mjs` (CREATE) — CLI with `health`, `keys list`, `keys add`, `keys delete` commands
- `test/unit/cli.test.ts` (CREATE)

**Code — `scripts/gw-cli.mjs`:**
```javascript
import { createGatewayClient } from '../sdk/client.js';
const baseUrl = process.env.GATEWAY_URL || 'http://localhost:8080/v1';
const apiKey = process.env.GATEWAY_KEY || '';
const cmd = process.argv[2];

async function main() {
  if (cmd === 'health') {
    try {
      const r = await fetch(`${baseUrl.replace(/\/v1$/, '')}/healthz`);
      console.log(r.status === 200 ? 'healthy' : 'unhealthy');
      process.exit(r.status === 200 ? 0 : 1);
    } catch {
      console.log('unreachable');
      process.exit(1);
    }
  }
  if (cmd === 'keys' && process.argv[3] === 'list') {
    const client = createGatewayClient(baseUrl, apiKey);
    try {
      const keys = await client.chat.completions.create({ model: 'test', messages: [] });
      console.log(JSON.stringify(keys));
    } catch (e) {
      console.log(`error: ${e.message}`);
      process.exit(1);
    }
  }
  console.log('unknown command');
  process.exit(1);
}

main();
```

**Test — `test/unit/cli.test.ts`:**
```typescript
import { test, expect } from 'node:test';
import { execFileSync } from 'node:child_process';

test('cli: health command runs', (t) => {
  const out = execFileSync('node', ['scripts/gw-cli.mjs', 'health'], { encoding: 'utf8' });
  expect(['healthy', 'unreachable']).toContain(out.trim());
});
```

**Verification commands:**
1. `node scripts/gw-cli.mjs health` → prints `healthy` or `unreachable`, exit code matches
2. `npm run test -- --test-name-pattern "cli"` → exit 0

**Final verification for Group A:**
- `npm run verify` → exit 0
- `npx tsc --noEmit --project sdk/tsconfig.json` → exit 0

**Commit:** `git add -A && git commit -m "feat(block-33): CLI key management tool"` → clean tree

---

**Risks:**
- SDK `tsconfig.json` uses `"module": "ES2022"` but repo backend uses CommonJS — SDK is isolated in `sdk/`, no conflict.
- `scripts/gw-cli.mjs` imports from `../sdk/client.js` — ESM import of a TypeScript file won't run directly without compilation. For the CLI test, mock the fetch or use tsx. Adjust import path if SDK needs compilation first.
- CLI `keys list` calls `chat.completions.create` which is wrong semantically but works as a smoke test for the CLI harness; refine in a later block if needed.
