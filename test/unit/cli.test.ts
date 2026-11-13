// import { test, expect } from 'node:test';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';

const expect = <T>(actual: readonly T[] | T[]) => ({
  toContain: (item: T) => {
    assert.ok(
      actual.includes(item),
      `expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`,
    );
  },
});

test('cli health command runs', () => {
  const out = execFileSync('node', ['scripts/gw-cli.mjs', 'health'], { encoding: 'utf8' });
  expect(['healthy', 'unreachable']).toContain(out.trim());
});
