#!/usr/bin/env node
/**
 * sex — start the WHOLE project at once.
 *
 *   npm run sex
 *
 * Brings up, in order:
 *   1. Postgres + Redis (docker compose, profile-independent)
 *   2. Backend gateway API on http://localhost:8080  (PORT from .env)
 *   3. Frontend Next.js on http://localhost:3000
 *
 * Ctrl+C stops everything (children first, then containers if --keep-db is absent).
 *
 * Flags:
 *   --no-docker   skip docker compose (assumes Postgres/Redis already running)
 *   --keep-db     leave containers up on exit
 *   --no-migrate  skip `npm run db:migrate`
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

const args = new Set(process.argv.slice(2));
const useDocker = !args.has('--no-docker');
const keepDb = args.has('--keep-db');
const runMigrations = !args.has('--no-migrate');

const isWindows = process.platform === 'win32';
const children = [];
let shuttingDown = false;

/** Read PORT from .env, defaulting to 8080. */
function readPort() {
  try {
    const env = require('fs').readFileSync('.env', 'utf8');
    const m = env.match(/^PORT=(\d+)/m);
    return m ? Number(m[1]) : 8080;
  } catch {
    return 8080;
  }
}

const BACKEND_PORT = readPort();

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      shell: isWindows, // resolve .cmd shims (npm.cmd) on Windows
      ...opts,
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

/** Spawn a long-lived child and track it for shutdown. */
function spawnTracked(label, cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    stdio: 'inherit',
    shell: isWindows,
    env: { ...process.env, ...env },
  });
  children.push({ label, child });
  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.log(`\n[sex] ${label} exited with code ${code}`);
    }
  });
  return child;
}

async function waitFor(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} did not become ready at ${url} within ${timeoutMs / 1000}s`);
}

async function main() {
  console.log('[sex] starting the whole stack');

  if (useDocker) {
    console.log('[sex] 1/3  docker compose up (postgres + redis)');
    const code = await run('docker', ['compose', 'up', '-d', '--wait']);
    if (code !== 0) {
      console.error('[sex] docker compose failed. Is Docker Desktop running?');
      process.exit(code);
    }
  } else {
    console.log('[sex] 1/3  skipped docker (--no-docker)');
  }

  if (runMigrations) {
    console.log('[sex] 2/3  applying database migrations');
    const code = await run('npm', ['run', 'db:migrate']);
    if (code !== 0) {
      console.error('[sex] migrations failed — continuing anyway, but the API may error');
    }
  } else {
    console.log('[sex] 2/3  skipped migrations (--no-migrate)');
  }

  console.log('[sex] 3/3  starting backend + frontend');

  // Backend: `npm run dev` reads PORT from .env
  spawnTracked('backend', 'npm', ['run', 'dev']);

  // Frontend: its own package.json, on port 3000
  spawnTracked('frontend', 'npm', ['run', 'dev'], {
    // Next reads NEXT_PUBLIC_* at build/dev time from frontend/.env.local,
    // which already points at the backend.
  });

  console.log('[sex] waiting for services to become ready...');
  await Promise.all([
    waitFor('http://localhost:3000', 90_000, 'frontend'),
    waitFor(`http://localhost:${BACKEND_PORT}/healthz`, 90_000, 'backend'),
  ]);

  console.log('\n[sex] ─────────────────────────────────────────────');
  console.log('[sex]  frontend   http://localhost:3000');
  console.log(`[sex]  backend    http://localhost:${BACKEND_PORT}`);
  console.log(`[sex]  health     http://localhost:${BACKEND_PORT}/healthz`);
  console.log('[sex]  Ctrl+C to stop everything');
  console.log('[sex] ─────────────────────────────────────────────\n');
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[sex] shutting down...');

  for (const { label, child } of children) {
    try {
      child.kill(isWindows ? undefined : 'SIGTERM');
    } catch {
      // already gone
    }
    console.log(`[sex]   stopped ${label}`);
  }

  if (useDocker && !keepDb) {
    console.log('[sex]   stopping containers');
    const killer = spawn('docker', ['compose', 'down'], { stdio: 'inherit', shell: isWindows });
    killer.on('exit', () => process.exit(code));
    return;
  }

  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main().catch((err) => {
  console.error('[sex] fatal:', err?.message ?? err);
  shutdown(1);
});