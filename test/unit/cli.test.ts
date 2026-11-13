import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';

test('cli: health command runs', () => {
  let output = '';
  try {
    output = execFileSync('node', ['scripts/gw-cli.mjs', 'health'], { encoding: 'utf8' });
  } catch (err) {
    const error = err as { stdout?: string | Buffer };
    output = (error.stdout ?? '').toString();
  }
  assert.ok(['healthy', 'unreachable'].includes(output.trim()));
});
