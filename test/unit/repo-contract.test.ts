import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

test('contract: typescript strict mode stays on', () => {
  const tsconfig = JSON.parse(read('tsconfig.json')) as {
    compilerOptions: Record<string, unknown>;
  };
  assert.equal(tsconfig.compilerOptions.strict, true);
  assert.equal(tsconfig.compilerOptions.noUncheckedIndexedAccess, true);
});

test('contract: .env is never committable', () => {
  const ignore = read('.gitignore');
  assert.match(ignore, /^\.env$/m);
  assert.match(ignore, /^\.env\.\*$/m);
  assert.match(ignore, /^!\.env\.example$/m);
});

test('contract: PROJECT.md keeps the four gate tests', () => {
  const plan = read('PROJECT.md');
  for (const name of ['Provider test', 'Policy test', 'Failure test', 'Capacity test']) {
    assert.ok(plan.includes(name), `PROJECT.md must keep the "${name}" gate`);
  }
});

test('contract: runtime Node is inside the pinned engines range', () => {
  const pkg = JSON.parse(read('package.json')) as { engines?: { node?: string } };
  const major = Number(process.versions.node.split('.')[0]);
  assert.ok(major >= 24 && major < 25, `runtime Node ${major} is outside the pinned range`);
  assert.ok(String(pkg.engines?.node ?? '').includes('24'), 'engines must pin Node 24');
});

test('contract: @types/node tracks the runtime major', () => {
  const pkg = JSON.parse(read('package.json')) as { devDependencies?: Record<string, string> };
  const typesRange = String(pkg.devDependencies?.['@types/node'] ?? '');
  const major = Number(process.versions.node.split('.')[0]);
  assert.ok(
    typesRange.includes(String(major)),
    `@types/node (${typesRange}) must match runtime Node ${major}`,
  );
});
